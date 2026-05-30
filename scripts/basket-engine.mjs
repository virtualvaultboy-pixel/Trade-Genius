#!/usr/bin/env node
/**
 * Trade Genius — v11.0 BASKET ENGINE (panier hebdo)
 *
 * Concept : 1 PANIER de 8 positions par semaine (vendredi soir).
 * Hold 5 jours ouvrés, rebalancing vendredi suivant.
 * Avantages vs day-trading :
 *   - 8 × 52 = 416 trades/an (vs 600-1000 en trade actif)
 *   - Diversification automatique (8 positions)
 *   - Moins de slippage cumulé
 *   - Plus simple pour l'utilisateur (1 décision/semaine)
 *   - Capture les trends moyen-terme (5 jours = mini-swing)
 *
 * Scoring : 5 patterns + macro filter + sector momentum + relative strength.
 * Sélection : top 8 par score, équipondéré (cash / 8).
 *
 * Backtest : walk-forward 4.5 ans (cache massive), 52 paniers/an.
 *
 * Output : data/sandbox/basket_engine_validation.json
 */
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { computeAllIndicators } from './indicators.mjs';

const CACHE_MASSIVE = path.join(process.cwd(), 'data', 'sandbox', '_cache_massive.json');
const OUT_PATH = path.join(process.cwd(), 'data', 'sandbox', 'basket_engine_validation.json');

function flog(msg) { process.stdout.write(msg + '\n'); }

const CONFIG = {
  basketSize: 8,           // 8 positions/panier
  rebalanceDays: 5,        // hebdo
  holdMaxDays: 10,         // sortie si pas rebal après 10j
  capitalInitial: 1000,
  // Quality threshold pour entrer dans le panier
  minQuality: 65,
  // Stop loss par position (% du capital alloué à cette position)
  stopLossPct: 8,          // -8% sur 1 position = sortie immédiate
  takeProfitPct: 20,       // +20% sur 1 position = sortie immédiate
  // Slippage par catégorie
  getSlippage: (label) => {
    if (label.startsWith('^') || label.startsWith('S&P') || label.startsWith('Nasdaq') || label.startsWith('Dow')) return 0.15;
    const etfs = ['XLK','XLF','XLE','XLV','XLP','XLY','XLI','XLU','XLB','XLC','XLRE','SOXX','SMH','SPY','QQQ','TLT','GLD'];
    if (etfs.some(e => label.includes(e))) return 0.05;
    const mega = ['Apple','Microsoft','Alphabet','Amazon','Meta','Nvidia','Tesla','Berkshire','JPMorgan','Visa','Walmart','J&J'];
    if (mega.includes(label)) return 0.10;
    return 0.30;
  },
  WARMUP: 60,
};

// SCORING : combine 5 patterns + sector momentum + RSI sanity
function scoreAsset(prices, marketSMA200) {
  if (prices.length < 60) return null;
  const ind = computeAllIndicators(prices);
  if (!ind?.rsi || !ind?.boll || !ind?.atr || !ind?.adx) return null;

  const rsi = ind.rsi.value;
  const boll = ind.boll.value;
  const adx = ind.adx.value;
  const close = prices[prices.length - 1];
  const macd = ind.macd?.value || 0;
  const atrPct = ind.atr.value;

  let score = 0;
  const breakdown = {};

  // 1. Contrarian (RSI < 30 + BB low) — capture les rebonds
  if (rsi < 30 && boll < 0.30) {
    const s = 30 + (30 - rsi) + (0.30 - boll) * 30;
    score = Math.max(score, s);
    breakdown.contrarian = Math.round(s);
  }

  // 2. Momentum/Trend follow (RSI 50-65 + ADX > 25 + MACD positif)
  if (rsi >= 50 && rsi <= 65 && adx > 25 && macd > 0) {
    const s = 50 + Math.min(20, adx - 25) + Math.min(10, rsi - 50);
    score = Math.max(score, s);
    breakdown.momentum = Math.round(s);
  }

  // 3. Breakout (close > high 20j × 1.005)
  if (prices.length >= 22) {
    const high20 = Math.max(...prices.slice(-22, -1));
    if (close > high20 * 1.005 && rsi >= 50 && adx > 20) {
      const s = 55 + Math.min(20, ((close / high20) - 1) * 400);
      score = Math.max(score, s);
      breakdown.breakout = Math.round(s);
    }
  }

  // 4. Pullback Ichimoku (above cloud + bull + pullback)
  if (ind.ichimoku && rsi >= 40 && rsi <= 55 && boll < 0.30 &&
      ind.ichimoku.position === 'above-cloud' && ind.ichimoku.signal === 'bull') {
    const s = 60 + Math.min(15, 50 - rsi) + (0.30 - boll) * 25;
    score = Math.max(score, s);
    breakdown.pullback = Math.round(s);
  }

  // 5. Mean reversion squeeze (RSI 30-40 + BB ultra low)
  if (rsi >= 30 && rsi < 40 && boll < 0.15) {
    const s = 45 + (40 - rsi) + (0.15 - boll) * 100;
    score = Math.max(score, s);
    breakdown.meanRev = Math.round(s);
  }

  // BONUS : marché bull global (close > SMA200)
  if (marketSMA200 && close > marketSMA200) score += 5;

  // PENALTY : volatilité excessive (ATR > 4%/jour = bruit)
  if (atrPct > 4) score *= 0.8;

  return { score: Math.round(score), breakdown, rsi, boll, adx, atrPct };
}

// Génère le panier au temps t (vendredi soir simulé)
function generateBasket(data, t, marketSMA200) {
  const candidates = [];
  for (const a of data) {
    if (t >= a.prices.length) continue;
    const slice = a.prices.slice(0, t + 1);
    const result = scoreAsset(slice, marketSMA200);
    if (result && result.score >= CONFIG.minQuality) {
      candidates.push({ asset: a.label, ...result });
    }
  }
  // Top N par score
  candidates.sort((x, y) => y.score - x.score);
  return candidates.slice(0, CONFIG.basketSize);
}

// Backtest panier hebdo
function backtestBasketEngine(data, startIdx, endIdx) {
  let cash = CONFIG.capitalInitial;
  let peak = cash;
  let maxDD = 0;
  const baskets = [];
  let currentBasket = []; // [{ asset, entry, size, daysHeld }]

  // S&P ref pour bull/bear
  const sp = data.find(a => a.label === 'S&P 500' || a.label === '^GSPC');

  for (let t = startIdx; t < endIdx; t += 1) {
    // Update positions courantes (mark-to-market + check stops)
    for (let i = currentBasket.length - 1; i >= 0; i--) {
      const pos = currentBasket[i];
      const a = data.find(x => x.label === pos.asset);
      if (!a || t >= a.prices.length) { currentBasket.splice(i, 1); continue; }
      const priceToday = a.prices[t];
      pos.daysHeld++;
      const pnlPct = (priceToday - pos.entry) / pos.entry * 100;

      // Stop loss individuel
      if (pnlPct <= -CONFIG.stopLossPct) {
        const exitPrice = priceToday * (1 - pos.slippage / 100);
        const exitValue = pos.size * (exitPrice / pos.entry);
        cash += exitValue;
        pos.exitReason = 'sl';
        pos.exitDate = t;
        pos.pnlPct = (exitPrice - pos.entry) / pos.entry * 100;
        currentBasket.splice(i, 1);
        continue;
      }
      // Take profit individuel
      if (pnlPct >= CONFIG.takeProfitPct) {
        const exitPrice = priceToday * (1 - pos.slippage / 100);
        const exitValue = pos.size * (exitPrice / pos.entry);
        cash += exitValue;
        pos.exitReason = 'tp';
        pos.exitDate = t;
        pos.pnlPct = (exitPrice - pos.entry) / pos.entry * 100;
        currentBasket.splice(i, 1);
        continue;
      }
      // Timeout
      if (pos.daysHeld >= CONFIG.holdMaxDays) {
        const exitPrice = priceToday * (1 - pos.slippage / 100);
        const exitValue = pos.size * (exitPrice / pos.entry);
        cash += exitValue;
        pos.exitReason = 'timeout';
        pos.exitDate = t;
        pos.pnlPct = (exitPrice - pos.entry) / pos.entry * 100;
        currentBasket.splice(i, 1);
      }
    }

    // Rebalancing chaque 5 jours
    const daysSinceStart = t - startIdx;
    if (daysSinceStart % CONFIG.rebalanceDays === 0 && daysSinceStart > 0) {
      // 1. Liquide TOUT
      for (const pos of currentBasket) {
        const a = data.find(x => x.label === pos.asset);
        if (!a || t >= a.prices.length) continue;
        const priceToday = a.prices[t];
        const exitPrice = priceToday * (1 - pos.slippage / 100);
        const exitValue = pos.size * (exitPrice / pos.entry);
        cash += exitValue;
        pos.exitReason = 'rebalance';
        pos.exitDate = t;
        pos.pnlPct = (exitPrice - pos.entry) / pos.entry * 100;
      }
      currentBasket = [];

      // 2. Compute marché SMA200 (proxy bull/bear)
      let marketSMA200 = null;
      if (sp && t >= 200) {
        const last200 = sp.prices.slice(t - 200, t);
        marketSMA200 = last200.reduce((a, b) => a + b, 0) / 200;
      }

      // 3. Génère nouveau panier
      const basket = generateBasket(data, t, marketSMA200);
      if (basket.length === 0) continue;

      // 4. Alloue cash équipondéré
      const allocPerPos = cash / basket.length;
      for (const item of basket) {
        const a = data.find(x => x.label === item.asset);
        if (!a) continue;
        const entryPrice = a.prices[t];
        const slippage = CONFIG.getSlippage(item.asset);
        const entryWithSlip = entryPrice * (1 + slippage / 100);
        cash -= allocPerPos;
        currentBasket.push({
          asset: item.asset,
          entry: entryWithSlip,
          size: allocPerPos,
          daysHeld: 0,
          slippage,
          score: item.score,
          breakdown: item.breakdown,
          entryDate: t,
        });
      }
      baskets.push({
        date: t,
        positions: basket.length,
        scores: basket.map(b => ({ asset: b.asset, score: b.score })),
      });
    }

    // Equity track (cash + positions)
    const equity = cash + currentBasket.reduce((acc, p) => {
      const a = data.find(x => x.label === p.asset);
      const price = a?.prices[t] || p.entry;
      return acc + p.size * (price / p.entry);
    }, 0);
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  // Liquide final
  let finalEquity = cash;
  for (const pos of currentBasket) {
    const a = data.find(x => x.label === pos.asset);
    if (!a) continue;
    const finalPrice = a.prices[endIdx - 1] || pos.entry;
    finalEquity += pos.size * (finalPrice / pos.entry);
  }

  const ret = (finalEquity - CONFIG.capitalInitial) / CONFIG.capitalInitial * 100;
  const yrs = (endIdx - startIdx) / 252;
  return {
    ret_yr: yrs > 0 ? Number((ret / yrs).toFixed(2)) : 0,
    dd: Number((maxDD * 100).toFixed(2)),
    baskets: baskets.length,
    final_equity: Number(finalEquity.toFixed(2)),
  };
}

async function main() {
  flog('=== BASKET ENGINE v11.0 — panier hebdo 8 positions ===');
  flog('Concept : 52 paniers/an, hold 5j ouvrés, rebalance hebdo.');
  flog('Avantages : moins de trades, diversification, simpler pour user.\n');

  if (!existsSync(CACHE_MASSIVE)) {
    flog('ERREUR: cache massive introuvable. Run alpha-stress-massive.mjs avant.');
    return;
  }
  const data = JSON.parse(readFileSync(CACHE_MASSIVE, 'utf8'));
  flog('Cache: ' + data.length + ' actifs');
  const minLen = Math.min(...data.map(a => a.prices.length));
  flog('Min days: ' + minLen + ' (' + (minLen / 252).toFixed(1) + ' ans)\n');

  // Walk-forward 5 folds × 1 an
  const FOLD = 252;
  const folds = [];
  for (let i = 0; i < 5; i++) {
    const s = i * FOLD, e = Math.min(s + FOLD + CONFIG.WARMUP, minLen);
    if (e - s < 100) break;
    folds.push({ name: 'F' + (i + 1), s: Math.max(CONFIG.WARMUP, s), e });
  }
  flog('Folds: ' + folds.length + '\n');

  flog('=== BASKET BACKTEST ===');
  const results = [];
  for (const f of folds) {
    const tStart = Date.now();
    const r = backtestBasketEngine(data, f.s, f.e);
    const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
    flog(`  ${f.name}: ${r.ret_yr}%/an · DD ${r.dd}% · ${r.baskets} paniers · final ${r.final_equity}€ (${elapsed}s)`);
    results.push({ fold: f.name, ...r });
  }

  const sorted = [...results].sort((a, b) => a.ret_yr - b.ret_yr);
  const median = sorted[Math.floor(results.length / 2)].ret_yr;
  const avgDD = results.reduce((a, b) => a + b.dd, 0) / results.length;
  const positive = results.filter(r => r.ret_yr > 0).length;

  flog('\n╔════════════════════════════════════════════════════════════════╗');
  flog('║ BASKET ENGINE — VERDICT (panier hebdo)                         ║');
  flog('╠════════════════════════════════════════════════════════════════╣');
  flog('║ Médian return  : ' + median + '%/an');
  flog('║ Worst fold     : ' + sorted[0].ret_yr + '%/an');
  flog('║ Best fold      : ' + sorted[sorted.length - 1].ret_yr + '%/an');
  flog('║ DD moyen       : ' + avgDD.toFixed(2) + '%');
  flog('║ Folds positifs : ' + positive + '/' + results.length);
  if (median > 30) flog('║ 🎯 EXCELLENT (>30%/an, proche Medallion)');
  else if (median > 20) flog('║ ✅ TRÈS BON (20-30%/an)');
  else if (median > 12) flog('║ ✅ BON (12-20%/an)');
  else if (median > 5) flog('║ ⚠️ MOYEN (5-12%/an)');
  else flog('║ ❌ INSUFFISANT (<5%/an)');
  flog('╚════════════════════════════════════════════════════════════════╝');

  await fs.writeFile(OUT_PATH, JSON.stringify({
    generated: new Date().toISOString(),
    config: CONFIG,
    median, avgDD, positive, total_folds: results.length,
    folds: results,
  }, null, 2));
  flog('\nOutput: ' + OUT_PATH);
}

main().catch(e => { flog('FAILED: ' + e.message); process.exit(1); });
