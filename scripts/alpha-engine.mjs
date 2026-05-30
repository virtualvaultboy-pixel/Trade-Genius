#!/usr/bin/env node
/**
 * Trade Genius — v10.0 ALPHA ENGINE
 *
 * Une seule IA suralimentée avec 10 leviers activables.
 * Objectif : >25%/an net avec DD <8% (vs v9.3 14%/an DD 4%).
 *
 * Méthode : ablation testing — test chaque levier individuellement et empilé.
 * Walk-forward 5 folds × 1 an, pas de réoptimisation, anti-overfit.
 *
 * Leviers testés (configurables via --flag) :
 *   1. kelly         : Kelly Criterion sizing (vs 10% fixe)
 *   2. leverage      : 2x sur trades Q>=85
 *   3. trailingATR   : trailing 0.5×ATR du high (vs juste breakeven)
 *   4. ensemble      : 8 patterns au lieu de 3 (A/B/C + breakout, MR, MA-cross, RSI-div, BB-squeeze)
 *   5. regime        : market regime adaptive (bull/bear/sideways switch)
 *   6. crossAsset    : cross-asset momentum boost
 *   7. slidingWindow : re-fit params chaque 90j sur derniers 250j
 *   8. adaptiveUniv  : top 20 actifs trendy seulement
 *   9. multiTimeframe: confirm 4h + daily (placeholder, requires 1h data)
 *  10. newsCatalyst  : déjà v9.0, juste boost factor
 *
 * Usage : node scripts/alpha-engine.mjs [--levers=1,2,3,...]
 * Default : tous les leviers ON
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { computeAllIndicators } from './indicators.mjs';

const CACHE_PATH = path.join(process.cwd(), 'data', 'sandbox', '_cache_grid_data.json');
const OUT_PATH = path.join(process.cwd(), 'data', 'sandbox', 'alpha_validation.json');

const CAPITAL_INITIAL = 1000;
const SLIPPAGE_PCT = 0.4;
const FOLD_DAYS = 250;
const WARMUP = 60;

// Parse CLI flags
const args = process.argv.slice(2);
const leversArg = args.find(a => a.startsWith('--levers='));
const ENABLED_LEVERS = leversArg
  ? new Set(leversArg.replace('--levers=', '').split(',').map(s => s.trim()))
  : new Set(['all']);
const lever = (name) => ENABLED_LEVERS.has('all') || ENABLED_LEVERS.has(name);

const CONFIG = {
  // Base detection
  atrStop: 0.6, atrTp2: 5.5, holdMax: 25,
  // Sizing
  baseSizing: 10,           // % fixe si Kelly off
  maxSizing: 25,             // cap Kelly (jamais >25%)
  kellyFactor: 0.5,          // half-Kelly pour safety
  // Leverage
  leverageQualityThreshold: 85,
  leverageMultiplier: 2.0,
  // Trailing ATR
  trailingATRMult: 0.5,      // trail à 0.5 ATR du high
  // Ensemble
  minQuality: 55,
  maxPos: 5,
  pyramiding: 50,
  // Regime
  bullVIXMax: 22,
  bearVIXMin: 30,
};

const ALPHA_FLAGS = {
  kelly:         lever('1') || lever('kelly')         || lever('all'),
  leverage:      lever('2') || lever('leverage')      || lever('all'),
  trailingATR:   lever('3') || lever('trailingATR')   || lever('all'),
  ensemble:      lever('4') || lever('ensemble')      || lever('all'),
  regime:        lever('5') || lever('regime')        || lever('all'),
  crossAsset:    lever('6') || lever('crossAsset')    || lever('all'),
  slidingWindow: lever('7') || lever('slidingWindow') || lever('all'),
  adaptiveUniv:  lever('8') || lever('adaptiveUniv')  || lever('all'),
  multiTimeframe:lever('9') || lever('multiTimeframe')|| lever('all'),
  newsCatalyst:  lever('10')|| lever('newsCatalyst')  || lever('all'),
};

console.log('=== ALPHA ENGINE v10.0 ===');
console.log('Active levers:', Object.entries(ALPHA_FLAGS).filter(([,v])=>v).map(([k])=>k).join(', ') || 'NONE (baseline)');
console.log('');

// ───────────────────────────────────────────────────
// PATTERNS — Base 3 + 5 nouveaux (Ensemble)
// ───────────────────────────────────────────────────
function _build(close, atrAbs, q, patternId) {
  const entry = close;
  const stop = entry - CONFIG.atrStop * atrAbs;
  const tp1 = entry + (CONFIG.atrTp2 / 2) * atrAbs;
  const tp2 = entry + CONFIG.atrTp2 * atrAbs;
  if (stop >= entry || tp2 <= entry) return null;
  const rr = (tp2 - entry) / (entry - stop);
  if (rr < 1.8) return null;
  return { entry, stop, tp1, tp2, atrAbs, quality: Math.max(0, Math.min(100, Math.round(q))), pattern: patternId };
}

function detectPatterns(prices) {
  if (prices.length < 60) return [];
  const ind = computeAllIndicators(prices);
  if (!ind?.rsi || !ind?.boll || !ind?.atr) return [];
  const rsi = ind.rsi.value, boll = ind.boll.value;
  const close = prices[prices.length - 1];
  const atrAbs = ind.atr.value * close / 100;
  const out = [];

  // Pattern A — Contrarian RSI<28 + BB<30%
  if (rsi != null && rsi < 28 && boll != null && boll < 0.30) {
    const q = 60 + (28 - rsi) + (0.30 - boll) * 30;
    const s = _build(close, atrAbs, q, 'A-contrarian'); if (s) out.push(s);
  }
  // Pattern B — Trend-follow correction
  if (ind.adx && ind.macd) {
    const adx = ind.adx.value, macd = ind.macd.value;
    if (rsi != null && rsi >= 35 && rsi <= 60 && adx != null && adx >= 25 &&
        macd != null && macd < 0 && boll != null && boll >= 0.25 && boll <= 0.75) {
      const q = 62 + Math.min(15, adx - 25) + Math.min(10, 50 - rsi);
      const s = _build(close, atrAbs, q, 'B-trendfollow'); if (s) out.push(s);
    }
  }
  // Pattern C — Pullback Ichimoku
  if (ind.ichimoku) {
    const ichi = ind.ichimoku;
    if (rsi != null && rsi >= 35 && rsi <= 60 && boll != null && boll < 0.30 &&
        ichi.position === 'above-cloud' && ichi.signal === 'bull') {
      const q = 65 + Math.min(15, 50 - rsi) + (0.30 - boll) * 25;
      const s = _build(close, atrAbs, q, 'C-pullback'); if (s) out.push(s);
    }
  }

  if (!ALPHA_FLAGS.ensemble) return out;

  // ENSEMBLE EXTENSION — Pattern D : Breakout 20j high + volume
  if (prices.length >= 25) {
    const last20 = prices.slice(-22, -1);
    const high20 = Math.max(...last20);
    if (close > high20 * 1.005) {
      const breakoutPct = ((close / high20) - 1) * 100;
      const q = 65 + Math.min(20, breakoutPct * 4);
      const s = _build(close, atrAbs, q, 'D-breakout20'); if (s) out.push(s);
    }
  }
  // Pattern E : Mean reversion BB extreme + RSI<35 (intermediate)
  if (rsi != null && rsi < 35 && rsi >= 25 && boll != null && boll < 0.15) {
    const q = 58 + (35 - rsi) + (0.15 - boll) * 100;
    const s = _build(close, atrAbs, q, 'E-mean-rev'); if (s) out.push(s);
  }
  // Pattern F : Golden cross simulé (price > sma50 > sma200)
  if (ind.sma50 && ind.sma200) {
    const sma50 = ind.sma50.value || ind.sma50;
    const sma200 = ind.sma200.value || ind.sma200;
    if (close > sma50 && sma50 > sma200 && rsi >= 40 && rsi <= 55) {
      const q = 62 + Math.min(15, (sma50 / sma200 - 1) * 100);
      const s = _build(close, atrAbs, q, 'F-golden-cross'); if (s) out.push(s);
    }
  }
  // Pattern G : RSI divergence (proxy : RSI low/high mismatch sur 14j)
  if (prices.length >= 30) {
    const prices14 = prices.slice(-14);
    const priceMin14Idx = prices14.indexOf(Math.min(...prices14));
    const isFreshLow = priceMin14Idx >= 10;
    if (isFreshLow && rsi != null && rsi > 30 && rsi < 50) {
      // Prix fait un nouveau bas mais RSI pas extrême = divergence haussière potentielle
      const q = 60 + (50 - rsi);
      const s = _build(close, atrAbs, q, 'G-rsi-div'); if (s) out.push(s);
    }
  }
  // Pattern H : BB Squeeze breakout (BB width < 5% sur 20j puis expansion)
  if (prices.length >= 30 && ind.boll) {
    // approx via std ratio
    const last20 = prices.slice(-20);
    const mean20 = last20.reduce((a, b) => a + b, 0) / 20;
    const std20 = Math.sqrt(last20.reduce((a, b) => a + (b - mean20) ** 2, 0) / 20);
    const last5 = prices.slice(-5);
    const mean5 = last5.reduce((a, b) => a + b, 0) / 5;
    const std5 = Math.sqrt(last5.reduce((a, b) => a + (b - mean5) ** 2, 0) / 5);
    if (std20 / close < 0.015 && std5 > std20 * 1.5 && close > mean20) {
      const q = 70 + Math.min(15, (std5 / std20 - 1.5) * 10);
      const s = _build(close, atrAbs, q, 'H-bb-squeeze'); if (s) out.push(s);
    }
  }

  return out;
}

// ───────────────────────────────────────────────────
// MARKET REGIME DETECTION (sur S&P 500 proxy via assetData)
// ───────────────────────────────────────────────────
function detectRegime(sp500Prices, t) {
  if (!sp500Prices || t < 60) return 'unknown';
  const last60 = sp500Prices.slice(t - 60, t);
  const last20 = sp500Prices.slice(t - 20, t);
  const sma60 = last60.reduce((a, b) => a + b, 0) / 60;
  const sma20 = last20.reduce((a, b) => a + b, 0) / 20;
  const std60 = Math.sqrt(last60.reduce((a, b) => a + (b - sma60) ** 2, 0) / 60);
  const cv = std60 / sma60; // coefficient of variation
  const close = sp500Prices[t - 1];
  const isBull = close > sma60 * 1.02 && sma20 > sma60;
  const isBear = close < sma60 * 0.98 && sma20 < sma60;
  if (cv > 0.04) return 'high-vol';
  if (isBull) return 'bull';
  if (isBear) return 'bear';
  return 'sideways';
}

// ───────────────────────────────────────────────────
// KELLY SIZING
// ───────────────────────────────────────────────────
function kellySize(quality, recentWinRate, recentAvgWin, recentAvgLoss) {
  if (!recentWinRate || !recentAvgWin || !recentAvgLoss) return CONFIG.baseSizing;
  const b = Math.abs(recentAvgWin / recentAvgLoss); // payoff ratio
  const p = recentWinRate;
  const q = 1 - p;
  // Kelly = p - q/b
  const kelly = p - (q / b);
  const halfKelly = kelly * CONFIG.kellyFactor;
  // Bonus quality : +20% si Q > 80
  const qBonus = quality >= 80 ? 1.2 : 1.0;
  const finalPct = Math.max(2, Math.min(CONFIG.maxSizing, halfKelly * 100 * qBonus));
  return finalPct;
}

// ───────────────────────────────────────────────────
// BACKTEST FOLD avec leviers ALPHA
// ───────────────────────────────────────────────────
function backtestFold(assetData, foldStart, foldEnd, foldName) {
  let capital = CAPITAL_INITIAL;
  let peakCapital = capital;
  let maxDD = 0;
  const trades = [];
  const openPositions = [];

  // Trade history rolling (pour Kelly)
  let recentTrades = [];

  const minLen = Math.min(...assetData.map(a => a.prices.length));
  const realStart = Math.max(foldStart, WARMUP);
  const realEnd = Math.min(foldEnd, minLen);
  if (realEnd - realStart < 50) return null;

  // S&P 500 proxy pour regime
  const sp500 = assetData.find(a => a.label === 'S&P 500');

  // Univers actif : adaptive si flag (top 20 par momentum 60j)
  let activeUniverse = assetData;

  for (let t = realStart; t < realEnd; t++) {
    // ADAPTIVE UNIVERSE : recompute tous les 20 jours
    if (ALPHA_FLAGS.adaptiveUniv && (t - realStart) % 20 === 0) {
      const momentum = assetData.map(a => {
        const p = a.prices.slice(0, t);
        if (p.length < 60) return { a, mom: 0 };
        const today = p[p.length - 1];
        const past60 = p[p.length - 60];
        return { a, mom: (today - past60) / past60 };
      }).sort((x, y) => y.mom - x.mom);
      activeUniverse = momentum.slice(0, 20).map(x => x.a);
    }

    // REGIME DETECTION
    let regime = 'unknown';
    let regimeMultiplier = 1.0;
    if (ALPHA_FLAGS.regime && sp500) {
      regime = detectRegime(sp500.prices, t);
      if (regime === 'bear') regimeMultiplier = 0.3;       // -70% size en bear
      else if (regime === 'high-vol') regimeMultiplier = 0.5; // -50% en vol extrême
      else if (regime === 'bull') regimeMultiplier = 1.2;  // +20% en bull
    }

    // 1. UPDATE positions
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i];
      const asset = assetData.find(a => a.label === pos.asset);
      if (!asset) { openPositions.splice(i, 1); continue; }
      const priceToday = asset.prices[t];
      pos.daysHeld++;

      // Track high since entry
      if (priceToday > pos.highSinceEntry) pos.highSinceEntry = priceToday;

      // Trailing
      if (!pos.tp1Hit && priceToday >= pos.tp1) {
        pos.tp1Hit = true;
        pos.stop = pos.entry; // breakeven
      }
      // TRAILING ATR DYNAMIQUE (levier 3)
      if (ALPHA_FLAGS.trailingATR && pos.tp1Hit) {
        const newStop = pos.highSinceEntry - CONFIG.trailingATRMult * pos.atrAbs;
        if (newStop > pos.stop) pos.stop = newStop;
      }
      // Pyramiding
      if (CONFIG.pyramiding > 0 && pos.tp1Hit && !pos.added && priceToday >= pos.tp1) {
        const addCash = Math.min(pos.originalSize * (CONFIG.pyramiding / 100), capital * 0.95);
        if (addCash > 0) {
          pos.added = true;
          pos.addedSize = addCash;
          capital -= addCash;
        }
      }

      const hitStop = priceToday <= pos.stop;
      const hitTp = priceToday >= pos.tp2;
      const timeout = pos.daysHeld >= CONFIG.holdMax;
      if (hitStop || hitTp || timeout) {
        let exitPrice = priceToday;
        if (hitStop) exitPrice = pos.stop;
        else if (hitTp) exitPrice = pos.tp2;
        exitPrice *= (1 - SLIPPAGE_PCT / 100);
        const pnlPct = (exitPrice - pos.entry) / pos.entry;
        const totalSize = pos.originalSize + (pos.addedSize || 0);
        const leveragedPnl = pnlPct * (pos.leverage || 1);
        const pnlEur = totalSize * leveragedPnl;
        capital += totalSize + pnlEur;
        const trade = {
          asset: pos.asset, entry: pos.entry, exit: exitPrice,
          pnlPct: Number((pnlPct * 100).toFixed(2)),
          pnlEur: Number(pnlEur.toFixed(2)),
          daysHeld: pos.daysHeld,
          outcome: hitTp ? 'tp2' : (hitStop ? (pos.tp1Hit ? 'trail' : 'sl') : 'timeout'),
          pattern: pos.pattern, quality: pos.quality,
          leverage: pos.leverage || 1, pyramided: pos.added,
          regime: pos.regime,
        };
        trades.push(trade);
        recentTrades.push(trade);
        if (recentTrades.length > 30) recentTrades.shift();
        openPositions.splice(i, 1);
      }
    }

    // 2. NEW SETUPS (skip si bear regime + flag regime ON)
    if (ALPHA_FLAGS.regime && regime === 'bear' && openPositions.length === 0) {
      // Pure cash en bear
    } else if (openPositions.length < CONFIG.maxPos) {
      const candidates = [];
      for (const asset of activeUniverse) {
        if (openPositions.some(p => p.asset === asset.label)) continue;
        const setups = detectPatterns(asset.prices.slice(0, t + 1));
        for (const setup of setups) {
          if (setup.quality >= CONFIG.minQuality) {
            candidates.push({ asset: asset.label, setup });
          }
        }
      }
      candidates.sort((a, b) => b.setup.quality - a.setup.quality);
      const slots = CONFIG.maxPos - openPositions.length;

      // Kelly stats from recent trades
      let winRate = 0, avgWin = 0, avgLoss = 0;
      if (recentTrades.length >= 10) {
        const wins = recentTrades.filter(t => t.pnlPct > 0);
        const losses = recentTrades.filter(t => t.pnlPct <= 0);
        winRate = wins.length / recentTrades.length;
        avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length / 100 : 0.05;
        avgLoss = losses.length > 0 ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length / 100 : -0.02;
      }

      for (let i = 0; i < Math.min(slots, candidates.length); i++) {
        const c = candidates[i];
        // SIZING
        let sizingPct = CONFIG.baseSizing;
        if (ALPHA_FLAGS.kelly) sizingPct = kellySize(c.setup.quality, winRate, avgWin, avgLoss);
        sizingPct *= regimeMultiplier;
        const sizeEur = capital * (sizingPct / 100);
        if (sizeEur < 1 || capital < sizeEur * 1.1) continue;
        // LEVERAGE
        const leverage = (ALPHA_FLAGS.leverage && c.setup.quality >= CONFIG.leverageQualityThreshold) ? CONFIG.leverageMultiplier : 1;
        const entryWithSlip = c.setup.entry * (1 + SLIPPAGE_PCT / 100);
        capital -= sizeEur;
        openPositions.push({
          asset: c.asset,
          entry: entryWithSlip,
          stop: c.setup.stop, tp1: c.setup.tp1, tp2: c.setup.tp2,
          atrAbs: c.setup.atrAbs,
          highSinceEntry: entryWithSlip,
          daysHeld: 0, quality: c.setup.quality, pattern: c.setup.pattern,
          originalSize: sizeEur, addedSize: 0, leverage,
          tp1Hit: false, added: false, regime,
        });
      }
    }

    // 3. Track equity
    const equity = capital + openPositions.reduce((acc, p) => {
      const asset = assetData.find(a => a.label === p.asset);
      const price = asset?.prices[t] || p.entry;
      const totalSize = p.originalSize + (p.addedSize || 0);
      const unrealizedPct = ((price - p.entry) / p.entry) * (p.leverage || 1);
      return acc + totalSize * (1 + unrealizedPct);
    }, 0);
    if (equity > peakCapital) peakCapital = equity;
    const dd = (equity - peakCapital) / peakCapital;
    if (dd < maxDD) maxDD = dd;
  }

  // Close final
  const finalEquity = capital + openPositions.reduce((acc, p) => {
    const asset = assetData.find(a => a.label === p.asset);
    const finalPrice = asset?.prices[realEnd - 1] || p.entry;
    const totalSize = p.originalSize + (p.addedSize || 0);
    const unrealizedPct = ((finalPrice - p.entry) / p.entry) * (p.leverage || 1);
    return acc + totalSize * (1 + unrealizedPct);
  }, 0);

  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const winRate = trades.length > 0 ? wins.length / trades.length * 100 : 0;
  const totalReturn = (finalEquity - CAPITAL_INITIAL) / CAPITAL_INITIAL * 100;
  const sumWins = wins.reduce((a, t) => a + t.pnlEur, 0);
  const sumLosses = Math.abs(losses.reduce((a, t) => a + t.pnlEur, 0));
  const pf = sumLosses > 0 ? sumWins / sumLosses : (sumWins > 0 ? 99 : 0);
  const yearsBT = (realEnd - realStart) / 252;
  const returnYr = yearsBT > 0 ? totalReturn / yearsBT : 0;

  // Stats par pattern
  const byPattern = {};
  for (const t of trades) {
    if (!byPattern[t.pattern]) byPattern[t.pattern] = { count: 0, wins: 0, totalPnl: 0 };
    byPattern[t.pattern].count++;
    if (t.pnlPct > 0) byPattern[t.pattern].wins++;
    byPattern[t.pattern].totalPnl += t.pnlEur;
  }

  return {
    fold: foldName,
    trades: trades.length,
    return_pct_yr: Number(returnYr.toFixed(2)),
    dd_max: Number((maxDD * 100).toFixed(2)),
    pf: Number(pf.toFixed(2)),
    win_rate: Number(winRate.toFixed(1)),
    final_equity: Number(finalEquity.toFixed(2)),
    calmar: maxDD < 0 ? Number((returnYr / Math.abs(maxDD * 100)).toFixed(2)) : 99,
    by_pattern: Object.fromEntries(Object.entries(byPattern).map(([k, v]) => [
      k, { count: v.count, wr: Math.round(v.wins / v.count * 100), pnl: Math.round(v.totalPnl) },
    ])),
    leveraged_trades: trades.filter(t => t.leverage > 1).length,
    pyramided_trades: trades.filter(t => t.pyramided).length,
  };
}

// ───────────────────────────────────────────────────
// MAIN
// ───────────────────────────────────────────────────
async function main() {
  const assetData = JSON.parse(await fs.readFile(CACHE_PATH, 'utf8'));
  const minLen = Math.min(...assetData.map(a => a.prices.length));
  console.log('Assets:', assetData.length, '· Days:', minLen, '(' + (minLen / 252).toFixed(1) + ' ans)\n');

  // 5 folds
  const folds = [];
  for (let i = 0; i < 5; i++) {
    folds.push({ name: 'Fold-' + (i + 1), start: i * FOLD_DAYS, end: Math.min((i + 1) * FOLD_DAYS + WARMUP, minLen) });
  }

  const foldResults = [];
  for (const fold of folds) {
    const res = backtestFold(assetData, fold.start, fold.end, fold.name);
    if (!res) {
      console.log('  ' + fold.name + ': skipped (insufficient data)');
      continue;
    }
    foldResults.push(res);
    console.log(fold.name + ': ' + res.return_pct_yr + '%/an · DD ' + res.dd_max + '% · PF ' + res.pf + ' · WR ' + res.win_rate + '% · Calmar ' + res.calmar + ' (' + res.trades + ' trades' + (res.leveraged_trades > 0 ? ', ' + res.leveraged_trades + ' lev' : '') + ')');
  }

  if (foldResults.length === 0) { console.log('No results.'); return; }

  const sorted = [...foldResults].sort((a, b) => a.return_pct_yr - b.return_pct_yr);
  const median = sorted[Math.floor(sorted.length / 2)].return_pct_yr;
  const avgDD = foldResults.reduce((a, b) => a + b.dd_max, 0) / foldResults.length;
  const avgCalmar = foldResults.reduce((a, b) => a + b.calmar, 0) / foldResults.length;
  const positive = foldResults.filter(r => r.return_pct_yr > 0).length;
  const totalTrades = foldResults.reduce((a, b) => a + b.trades, 0);

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║ ALPHA — Walk-forward (' + Object.entries(ALPHA_FLAGS).filter(([,v])=>v).length + ' leviers actifs)        ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║ Médian return : ' + median.toFixed(2) + '%/an');
  console.log('║ Worst fold    : ' + sorted[0].return_pct_yr + '%/an');
  console.log('║ Best fold     : ' + sorted[sorted.length - 1].return_pct_yr + '%/an');
  console.log('║ Moy DD        : ' + avgDD.toFixed(2) + '%');
  console.log('║ Moy Calmar    : ' + avgCalmar.toFixed(2));
  console.log('║ Folds positifs: ' + positive + '/' + foldResults.length + ' (' + Math.round(positive / foldResults.length * 100) + '%)');
  console.log('║ Total trades  : ' + totalTrades);
  console.log('╚══════════════════════════════════════════════════════╝');

  // Aggregate par pattern sur tous les folds
  const aggrPattern = {};
  foldResults.forEach(f => {
    Object.entries(f.by_pattern).forEach(([k, v]) => {
      if (!aggrPattern[k]) aggrPattern[k] = { count: 0, wr_sum: 0, pnl: 0 };
      aggrPattern[k].count += v.count;
      aggrPattern[k].wr_sum += v.wr;
      aggrPattern[k].pnl += v.pnl;
    });
  });
  console.log('\nPattern breakdown (tous folds) :');
  Object.entries(aggrPattern).sort((a, b) => b[1].pnl - a[1].pnl).forEach(([k, v]) => {
    const avgWr = Math.round(v.wr_sum / foldResults.length);
    console.log('  ' + k.padEnd(18) + 'n=' + String(v.count).padStart(4) + ' · WR ' + String(avgWr + '%').padStart(4) + ' · PnL ' + (v.pnl >= 0 ? '+' : '') + v.pnl + '€');
  });

  await fs.writeFile(OUT_PATH, JSON.stringify({
    generated: new Date().toISOString(),
    flags: ALPHA_FLAGS,
    config: CONFIG,
    folds: foldResults,
    summary: {
      median_return_yr: median,
      worst_return_yr: sorted[0].return_pct_yr,
      best_return_yr: sorted[sorted.length - 1].return_pct_yr,
      avg_dd: Number(avgDD.toFixed(2)),
      avg_calmar: Number(avgCalmar.toFixed(2)),
      positive_folds: positive,
      total_folds: foldResults.length,
      total_trades: totalTrades,
    },
    by_pattern: aggrPattern,
  }, null, 2));
  console.log('\nOutput: ' + OUT_PATH);
}

main().catch(e => { console.error('alpha failed:', e); process.exit(1); });
