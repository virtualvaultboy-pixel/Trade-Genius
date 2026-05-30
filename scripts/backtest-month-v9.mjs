#!/usr/bin/env node
/**
 * Trade Genius — v9.1 BACKTEST 30 JOURS sur les 5 IA
 *
 * Simule rétrospectivement ce qu'auraient fait les 5 IA (BASTION/PHÉNIX/RAFALE/NEXUS/VOLT)
 * sur les 30 derniers jours de marché, avec capital 1000€ chacune.
 *
 * Limites importantes (à dire honnêtement) :
 *  - Les filtres v9.0 news/insider/M&A/earnings beat sont INDISPONIBLES historiquement
 *    (API ne donnent que la donnée courante). Donc backtest = pure technique + seasonality.
 *  - Slippage 0.4%/trade modélisé (broker réaliste)
 *  - Pas de timeline réelle des news → résultat = "ce qu'aurait fait le moteur AVANT v9.0"
 *  - Le bénéfice réel v9.0 ne se mesurera qu'en forward (J+1 à J+30 réels)
 *
 * Méthode :
 *   1. Fetch 90j d'historique sur 30 actifs majeurs (indices, tech US, cryptos)
 *   2. Pour chaque jour T des 30 derniers :
 *      a. Compute indicators sur prices[0..T] (causal)
 *      b. Détecte patterns ABC pour les 5 IA avec leurs configs
 *      c. Apply seasonality bias (-5% à +5%)
 *      d. Ouvre positions si quality > 60 (75 pour VOLT)
 *      e. Update positions ouvertes (TP/SL/timeout)
 *   3. Track equity day-by-day
 *
 * Output : data/sandbox/backtest_month_v9.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  fetchYahooHistorical, fetchCoinGeckoHistorical,
  computeAllIndicators, atrPct, sma,
} from './indicators.mjs';
import { getSeasonalityBias, applySeasonalityFilter } from './news-intel.mjs';

const CAPITAL_INITIAL = 1000;
const MIN_QUALITY = 60;
const MIN_QUALITY_VOLT = 75;
const SLIPPAGE_PCT = 0.4; // 0.4% par trade (entry + exit = 0.8% round trip)
const BACKTEST_DAYS = 30;
const HISTORY_DAYS = 90; // 90j d'historique pour avoir 60j warmup + 30j backtest

// Univers représentatif : 30 actifs (10 indices + 10 actions US + 10 cryptos)
const ASSETS = [
  // Indices
  { kind: 'index', symbol: '^GSPC', label: 'S&P 500' },
  { kind: 'index', symbol: '^IXIC', label: 'Nasdaq' },
  { kind: 'index', symbol: '^DJI',  label: 'Dow Jones' },
  { kind: 'index', symbol: '^RUT',  label: 'Russell 2000' },
  { kind: 'index', symbol: '^FCHI', label: 'CAC 40' },
  { kind: 'index', symbol: '^GDAXI',label: 'DAX' },
  { kind: 'index', symbol: '^FTSE', label: 'FTSE 100' },
  { kind: 'index', symbol: '^N225', label: 'Nikkei 225' },
  { kind: 'index', symbol: '^HSI',  label: 'Hang Seng' },
  { kind: 'index', symbol: '^STOXX50E', label: 'Euro Stoxx 50' },
  // Actions US
  { kind: 'action', symbol: 'AAPL',  label: 'Apple' },
  { kind: 'action', symbol: 'MSFT',  label: 'Microsoft' },
  { kind: 'action', symbol: 'GOOGL', label: 'Alphabet' },
  { kind: 'action', symbol: 'AMZN',  label: 'Amazon' },
  { kind: 'action', symbol: 'META',  label: 'Meta' },
  { kind: 'action', symbol: 'NVDA',  label: 'Nvidia' },
  { kind: 'action', symbol: 'TSLA',  label: 'Tesla' },
  { kind: 'action', symbol: 'JPM',   label: 'JPMorgan' },
  { kind: 'action', symbol: 'V',     label: 'Visa' },
  { kind: 'action', symbol: 'AMD',   label: 'AMD' },
  // Cryptos
  { kind: 'crypto', id: 'bitcoin', label: 'BTC' },
  { kind: 'crypto', id: 'ethereum', label: 'ETH' },
  { kind: 'crypto', id: 'solana', label: 'SOL' },
  { kind: 'crypto', id: 'binancecoin', label: 'BNB' },
  { kind: 'crypto', id: 'cardano', label: 'ADA' },
  { kind: 'crypto', id: 'avalanche-2', label: 'AVAX' },
  { kind: 'crypto', id: 'polkadot', label: 'DOT' },
  { kind: 'crypto', id: 'chainlink', label: 'LINK' },
  { kind: 'crypto', id: 'litecoin', label: 'LTC' },
  { kind: 'crypto', id: 'cosmos', label: 'ATOM' },
];

// Configs IA (alignées sur build-ai-study.mjs)
const IAS = [
  { id: 'bastion', name: 'BASTION', atrStop: 0.7, atrTp2: 7.0, holdMax: 60, kinds: ['index', 'action'] },
  { id: 'phenix',  name: 'PHÉNIX',  atrStop: 0.7, atrTp2: 5.0, holdMax: 30, kinds: ['index', 'action'] },
  { id: 'rafale',  name: 'RAFALE',  atrStop: 0.5, atrTp2: 3.5, holdMax: 12, kinds: ['index', 'action'] },
  { id: 'nexus',   name: 'NEXUS',   atrStop: 0.8, atrTp2: 5.0, holdMax: 15, kinds: ['crypto'] },
  { id: 'volt',    name: 'VOLT',    atrStop: 0.6, atrTp2: 4.5, holdMax: 15, kinds: ['crypto', 'action'], minQuality: MIN_QUALITY_VOLT, maxPos: 3 },
];

const MAX_POSITIONS = 5;
const SIZING_PCT = 5; // 5% du capital par trade

// ───────────────────────────────────────────────────
// Détecteurs ABC alignés sur build-ai-study.mjs
// ───────────────────────────────────────────────────
function _buildSetup(close, atrAbs, config, qScore) {
  const entry = close;
  const stop = entry - config.atrStop * atrAbs;
  const tp2 = entry + config.atrTp2 * atrAbs;
  if (stop >= entry || tp2 <= entry) return null;
  const rr = (tp2 - entry) / (entry - stop);
  if (rr < 1.8) return null;
  return { entry, stop, tp2, atrAbs, quality: Math.max(0, Math.min(100, qScore)) };
}

function detectPatternA(prices, config) {
  if (prices.length < 60) return null;
  const ind = computeAllIndicators(prices);
  if (!ind?.rsi || !ind?.boll || !ind?.atr) return null;
  const rsi = ind.rsi.value;
  const boll = ind.boll.value;
  const close = prices[prices.length - 1];
  // Pattern A : survente RSI<28 + BB<30%
  if (rsi == null || rsi > 28 || boll == null || boll > 0.30) return null;
  const atrAbs = ind.atr.value * close / 100;
  const q = 60 + (28 - rsi) + (0.3 - boll) * 30;
  return _buildSetup(close, atrAbs, config, Math.round(q)) && { ...{pattern: 'A'}, ..._buildSetup(close, atrAbs, config, Math.round(q)) };
}

function detectPatternB(prices, config) {
  // Pattern B : trend-follow correction (RSI>35 + ADX>=25 + MACD<0)
  if (prices.length < 60) return null;
  const ind = computeAllIndicators(prices);
  if (!ind?.rsi || !ind?.adx || !ind?.atr || !ind?.macd) return null;
  const rsi = ind.rsi.value, adx = ind.adx.value, macd = ind.macd.value, boll = ind.boll?.value;
  const close = prices[prices.length - 1];
  if (rsi == null || rsi < 35 || rsi > 60) return null;
  if (adx == null || adx < 25) return null;
  if (macd == null || macd >= 0) return null;
  if (boll == null || boll < 0.25 || boll > 0.75) return null;
  const atrAbs = ind.atr.value * close / 100;
  const q = 62 + Math.min(15, adx - 25) + Math.min(10, 50 - rsi);
  const built = _buildSetup(close, atrAbs, config, Math.round(q));
  return built ? { ...built, pattern: 'B' } : null;
}

function detectPatternC(prices, config) {
  // Pattern C : pullback dans tendance (RSI>35 + BB<25% + Ichimoku bull)
  if (prices.length < 60) return null;
  const ind = computeAllIndicators(prices);
  if (!ind?.rsi || !ind?.boll || !ind?.atr || !ind?.ichimoku) return null;
  const rsi = ind.rsi.value, boll = ind.boll.value, ichi = ind.ichimoku;
  const close = prices[prices.length - 1];
  if (rsi == null || rsi < 35 || rsi > 60) return null;
  if (boll == null || boll > 0.30) return null;
  if (!ichi || ichi.position !== 'above-cloud' || ichi.signal !== 'bull') return null;
  const atrAbs = ind.atr.value * close / 100;
  const q = 65 + Math.min(15, 50 - rsi) + (0.3 - boll) * 25;
  const built = _buildSetup(close, atrAbs, config, Math.round(q));
  return built ? { ...built, pattern: 'C' } : null;
}

function detectBestSetup(prices, config) {
  const candidates = [
    detectPatternA(prices, config),
    detectPatternB(prices, config),
    detectPatternC(prices, config),
  ].filter(Boolean);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.quality - a.quality)[0];
}

// ───────────────────────────────────────────────────
// Backtest une IA sur un actif sur 30 jours
// ───────────────────────────────────────────────────
function backtestIaOnAsset(prices, ia, startDay, seasonality) {
  const trades = [];
  let openPos = null;
  const n = prices.length;
  const minStart = Math.max(60, n - BACKTEST_DAYS); // warmup 60 jours min

  for (let t = minStart; t < n; t++) {
    const priceToday = prices[t];

    // 1. Update position ouverte
    if (openPos) {
      openPos.daysHeld++;
      const hitStop = priceToday <= openPos.stop;
      const hitTp = priceToday >= openPos.tp2;
      const timeout = openPos.daysHeld >= ia.holdMax;
      if (hitStop || hitTp || timeout) {
        let exitPrice = priceToday;
        if (hitStop) exitPrice = openPos.stop;
        else if (hitTp) exitPrice = openPos.tp2;
        // Slippage exit
        exitPrice *= (1 - SLIPPAGE_PCT / 100);
        const pnl = (exitPrice - openPos.entry) / openPos.entry;
        trades.push({
          entry: openPos.entry, exit: exitPrice, pnl, daysHeld: openPos.daysHeld,
          outcome: hitTp ? 'tp' : (hitStop ? 'sl' : 'timeout'),
          quality: openPos.quality,
        });
        openPos = null;
      }
    }

    // 2. Cherche nouveau setup si rien d'ouvert (best of A/B/C)
    if (!openPos) {
      const setup = detectBestSetup(prices.slice(0, t + 1), ia);
      if (setup) {
        // Apply seasonality
        const sFilter = applySeasonalityFilter({ direction: 'long' }, seasonality);
        let q = setup.quality;
        if (sFilter.qualityMult !== 1) q = Math.max(0, Math.min(100, Math.round(q * sFilter.qualityMult)));
        const threshold = ia.minQuality || MIN_QUALITY;
        if (q >= threshold) {
          // Slippage entry
          const entryWithSlip = setup.entry * (1 + SLIPPAGE_PCT / 100);
          openPos = {
            entry: entryWithSlip,
            stop: setup.stop,
            tp2: setup.tp2,
            daysHeld: 0,
            quality: q,
          };
        }
      }
    }
  }
  return trades;
}

// ───────────────────────────────────────────────────
// Main : fetch données, simule, aggrège
// ───────────────────────────────────────────────────
async function main() {
  console.log('=== BACKTEST 30 JOURS v9.1 — 5 IA × 30 actifs ===\n');
  console.log('⚠️ Limite : filtres v9.0 news/insider/M&A historiques indisponibles.');
  console.log('   Ce backtest = pure technique + seasonality.');
  console.log('   Le vrai bénéfice v9.0 se mesurera en forward.\n');

  // Fetch historique
  console.log('Fetching ' + ASSETS.length + ' assets (' + HISTORY_DAYS + 'j)...');
  const dataMap = new Map();
  for (const a of ASSETS) {
    try {
      let data;
      if (a.kind === 'crypto') {
        data = await fetchCoinGeckoHistorical(a.id, HISTORY_DAYS);
      } else {
        data = await fetchYahooHistorical(a.symbol, '6mo');
      }
      if (data && data.prices && data.prices.length >= 60) {
        dataMap.set(a.label, { ...a, prices: data.prices });
        process.stdout.write('.');
      } else {
        process.stdout.write('x');
      }
    } catch (e) {
      process.stdout.write('!');
    }
  }
  console.log('\n' + dataMap.size + '/' + ASSETS.length + ' assets loaded.\n');

  // Seasonality du mois écoulé (approximation : on prend le mois courant)
  const seasonality = getSeasonalityBias();
  console.log('Seasonality applied: ' + seasonality.label + ' (bias ' + seasonality.bias + ')\n');

  // Backtest chaque IA
  const results = {};
  for (const ia of IAS) {
    const allTrades = [];
    let openTrades = [];
    const eligibleAssets = [...dataMap.values()].filter(a => ia.kinds.includes(a.kind));

    for (const asset of eligibleAssets) {
      const trades = backtestIaOnAsset(asset.prices, ia, 0, seasonality);
      trades.forEach(t => t.asset = asset.label);
      allTrades.push(...trades);
    }

    // Stats
    const wins = allTrades.filter(t => t.pnl > 0);
    const losses = allTrades.filter(t => t.pnl <= 0);
    const totalPct = allTrades.reduce((acc, t) => acc + t.pnl, 0) * 100;
    const winRate = allTrades.length > 0 ? (wins.length / allTrades.length) * 100 : 0;
    const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length * 100 : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length * 100 : 0;
    const pf = Math.abs(avgLoss) > 0 ? (avgWin * wins.length) / Math.abs(avgLoss * losses.length) : 0;
    // Capital simulé : sizing 5%/trade, additif (pas composé pour simplifier)
    const sizing = SIZING_PCT / 100;
    const totalReturn = allTrades.reduce((acc, t) => acc + (t.pnl * sizing), 0) * 100;
    const finalCapital = CAPITAL_INITIAL * (1 + totalReturn / 100);

    results[ia.name] = {
      trades_count: allTrades.length,
      wins: wins.length,
      losses: losses.length,
      win_rate_pct: Number(winRate.toFixed(1)),
      avg_win_pct: Number(avgWin.toFixed(2)),
      avg_loss_pct: Number(avgLoss.toFixed(2)),
      profit_factor: Number(pf.toFixed(2)),
      total_pnl_per_trade_pct: Number(totalPct.toFixed(2)),
      total_return_pct_with_sizing: Number(totalReturn.toFixed(2)),
      final_capital_eur: Number(finalCapital.toFixed(2)),
      best_trade: allTrades.length > 0 ? allTrades.reduce((a, b) => a.pnl > b.pnl ? a : b) : null,
      worst_trade: allTrades.length > 0 ? allTrades.reduce((a, b) => a.pnl < b.pnl ? a : b) : null,
    };
  }

  // Print results
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║ BACKTEST 30 JOURS · 5 IA · 1000€/chacune · sizing 5%/trade · slip 0.4% ║');
  console.log('╠══════════╦═════════╦═════════╦═══════╦═══════╦═══════════╦══════════╣');
  console.log('║ IA       ║ Trades  ║ Win %   ║ PF    ║ Avg+  ║ Avg-      ║ Capital  ║');
  console.log('╠══════════╬═════════╬═════════╬═══════╬═══════╬═══════════╬══════════╣');
  for (const [name, s] of Object.entries(results)) {
    const ret = s.total_return_pct_with_sizing;
    const retStr = (ret >= 0 ? '+' : '') + ret.toFixed(1) + '%';
    const capStr = s.final_capital_eur.toFixed(0) + '€';
    console.log('║ ' + name.padEnd(8) + ' ║ ' + String(s.trades_count).padStart(7) + ' ║ ' + (s.win_rate_pct.toFixed(0) + '%').padStart(7) + ' ║ ' + s.profit_factor.toFixed(2).padStart(5) + ' ║ ' + (s.avg_win_pct.toFixed(1) + '%').padStart(5) + ' ║ ' + (s.avg_loss_pct.toFixed(1) + '%').padStart(9) + ' ║ ' + (capStr + ' ' + retStr).padStart(8) + ' ║');
  }
  console.log('╚══════════╩═════════╩═════════╩═══════╩═══════╩═══════════╩══════════╝');

  // Output JSON
  const outPath = path.join(process.cwd(), 'data', 'sandbox', 'backtest_month_v9.json');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify({
    generated: new Date().toISOString(),
    config: {
      backtest_days: BACKTEST_DAYS,
      capital_initial: CAPITAL_INITIAL,
      sizing_pct: SIZING_PCT,
      slippage_pct: SLIPPAGE_PCT,
      min_quality: MIN_QUALITY,
      assets_count: dataMap.size,
      pattern_tested: 'Pattern A (contrarian survente)',
      filters_applied: ['seasonality'],
      filters_excluded: ['news', 'macro_event', 'cross_asset', 'insider', 'M&A', 'fear_greed', 'earnings_beat', 'tech_events'],
      note: 'Filtres v9.0 news/insider/M&A indisponibles historiquement. Backtest = pure technique + seasonality.',
    },
    seasonality_applied: seasonality,
    results,
  }, null, 2));
  console.log('\nOutput: ' + outPath);
}

main().catch(e => {
  console.error('backtest-month-v9 failed:', e);
  process.exit(1);
});
