#!/usr/bin/env node
/**
 * Trade Genius — v7.12 Backtest VOLT dédié
 *
 * Simule l'IA VOLT (Pattern D Volatility Breakout) sur 600 jours d'historique
 * pour valider le profil de risque AVANT de pousser fort côté UI/Premium.
 *
 * Univers : 42 actifs VOLT_UNIVERSE (cryptos mid-cap + actions high-beta US).
 * Cible mesurée : +15 à +25%/an, win rate 35-45%, max DD assumé -15%.
 *
 * Output : data/sandbox/backtest_volt.json
 *
 * Reproduit EXACTEMENT la logique _detectVoltBreakout() de build-ai-study.mjs :
 *   ATR ≥ 2.5%, breakout 20j +0.5%, close > SMA20 > SMA50,
 *   RSI 55-75, ADX ≥ 22, MACD > 0, OBV non-baissier, régime non-bear.
 *   Stop 1.5×ATR, TP1 3×ATR (R/R 1:2), TP2 6×ATR (R/R 1:4), timeout 14j.
 *   Sizing 3% (Q≥75) / 5% (Q≥85) / 8% (Q≥90).
 *   Max 3 positions simultanées.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchYahooHistorical, computeAllIndicators, atrPct, sma } from './indicators.mjs';

const CAPITAL_INITIAL = 1000;       // 1000€ (cohérent avec sandbox dev)
const MAX_POSITIONS = 3;            // VOLT : sélectivité forcée
const BACKTEST_DAYS = 600;          // ~2.4 ans
const WARMUP = 220;
const HISTORY_RANGE = '5y';

// v7.12 R&D round 6 — Ultra fine-tuning autour de A-SCALP (+13.61%/an, PF 2.23, DD -4.8%)
// Cible : ≥+15%/an sans casser le DD
const VARIANTS = [
  // CHAMPION ACTUEL (référence)
  { name: 'A-SCALP',         mode: 'patternA', minQ: 65, timeoutDays: 15, trailingAfterTp1: true,  atrStop: 0.6, atrTp2: 3.5 },
  // 1) Stop encore + serré (0.5)
  { name: 'A-SCALP-ULTRA',   mode: 'patternA', minQ: 65, timeoutDays: 15, trailingAfterTp1: true,  atrStop: 0.5, atrTp2: 3.5 },
  // 2) TP plus court (3.0) — encaisse plus vite
  { name: 'A-SCALP-FAST',    mode: 'patternA', minQ: 65, timeoutDays: 12, trailingAfterTp1: true,  atrStop: 0.6, atrTp2: 3.0 },
  // 3) MinQ 70 (plus sélectif sur scalp)
  { name: 'A-SCALP-Q70',     mode: 'patternA', minQ: 70, timeoutDays: 15, trailingAfterTp1: true,  atrStop: 0.6, atrTp2: 3.5 },
  // 4) TP plus long (4.5) pour scalp (essayer asymétrie)
  { name: 'A-SCALP-WIDE',    mode: 'patternA', minQ: 65, timeoutDays: 15, trailingAfterTp1: true,  atrStop: 0.6, atrTp2: 4.5 },
  // 5) Sans trailing après TP1 (sortie au TP2 strict)
  { name: 'A-SCALP-NOTRAIL', mode: 'patternA', minQ: 65, timeoutDays: 15, trailingAfterTp1: false, atrStop: 0.6, atrTp2: 3.5 },
];

// 42 actifs VOLT_UNIVERSE — synchro avec build-ai-study.mjs
const VOLT_ASSETS = [
  // Crypto mid-cap (Yahoo Finance — historique riche)
  { symbol: 'SOL-USD',  label: 'Solana',     kind: 'crypto' },
  { symbol: 'AVAX-USD', label: 'Avalanche',  kind: 'crypto' },
  { symbol: 'NEAR-USD', label: 'Near',       kind: 'crypto' },
  { symbol: 'RNDR-USD', label: 'Render',     kind: 'crypto' },
  { symbol: 'INJ-USD',  label: 'Injective',  kind: 'crypto' },
  { symbol: 'SUI-USD',  label: 'Sui',        kind: 'crypto' }, // récent
  { symbol: 'APT-USD',  label: 'Aptos',      kind: 'crypto' },
  { symbol: 'TIA-USD',  label: 'Celestia',   kind: 'crypto' }, // récent
  { symbol: 'SEI-USD',  label: 'Sei',        kind: 'crypto' }, // récent
  { symbol: 'LDO-USD',  label: 'Lido DAO',   kind: 'crypto' },
  { symbol: 'ARB-USD',  label: 'Arbitrum',   kind: 'crypto' }, // récent
  { symbol: 'OP-USD',   label: 'Optimism',   kind: 'crypto' }, // récent
  { symbol: 'FET-USD',  label: 'Fetch.ai',   kind: 'crypto' },
  { symbol: 'AGIX-USD', label: 'SingularityNET', kind: 'crypto' },
  { symbol: 'MATIC-USD', label: 'Polygon',   kind: 'crypto' },
  { symbol: 'ATOM-USD', label: 'Cosmos',     kind: 'crypto' },
  { symbol: 'FIL-USD',  label: 'Filecoin',   kind: 'crypto' },
  { symbol: 'ICP-USD',  label: 'Internet Computer', kind: 'crypto' },
  // Actions high-beta US
  { symbol: 'TSLA', label: 'Tesla',          kind: 'action' },
  { symbol: 'PLTR', label: 'Palantir',       kind: 'action' },
  { symbol: 'COIN', label: 'Coinbase',       kind: 'action' },
  { symbol: 'MSTR', label: 'MicroStrategy',  kind: 'action' },
  { symbol: 'AFRM', label: 'Affirm',         kind: 'action' },
  { symbol: 'SOFI', label: 'SoFi',           kind: 'action' },
  { symbol: 'RIVN', label: 'Rivian',         kind: 'action' },
  { symbol: 'CVNA', label: 'Carvana',        kind: 'action' },
  { symbol: 'ARM',  label: 'Arm',            kind: 'action' }, // récent
  { symbol: 'SMCI', label: 'Super Micro',    kind: 'action' },
  { symbol: 'ASTS', label: 'AST SpaceMobile', kind: 'action' },
  { symbol: 'IONQ', label: 'IonQ',           kind: 'action' },
  { symbol: 'RKLB', label: 'Rocket Lab',     kind: 'action' },
  { symbol: 'ACHR', label: 'Archer Aviation', kind: 'action' }, // récent
  { symbol: 'LCID', label: 'Lucid',          kind: 'action' },
  { symbol: 'PLUG', label: 'Plug Power',     kind: 'action' },
  { symbol: 'JOBY', label: 'Joby Aviation',  kind: 'action' },
  { symbol: 'RBLX', label: 'Roblox',         kind: 'action' },
  { symbol: 'SNAP', label: 'Snap',           kind: 'action' },
  { symbol: 'U',    label: 'Unity',          kind: 'action' },
  { symbol: 'DKNG', label: 'DraftKings',     kind: 'action' },
  { symbol: 'ROKU', label: 'Roku',           kind: 'action' },
  { symbol: 'BYND', label: 'Beyond Meat',    kind: 'action' },
];

// ── Régime de marché (cohérent avec build-ai-study.mjs detectMarketRegime) ──
function detectRegime(prices) {
  if (!prices || prices.length < 200) return 'unknown';
  const sma200Now = sma(prices.slice(-200), 200);
  const sma200Ago = sma(prices.slice(-220, -20), 200);
  if (sma200Now == null || sma200Ago == null || sma200Ago === 0) return 'unknown';
  const slope = (sma200Now - sma200Ago) / sma200Ago;
  if (slope > 0.03) return 'bull';
  if (slope < -0.03) return 'bear';
  return 'sideways';
}

// ── Pattern D Volatility Breakout LEGACY (sera remplacé si pullback gagne) ─
function _detectBreakout(prices, volumes, variant) {
  if (!prices || prices.length < 50) return null;
  const ind = computeAllIndicators(prices, volumes);
  if (!ind) return null;
  const atrPctV = ind.atr?.value;
  if (atrPctV == null || atrPctV < variant.atrMin) return null;
  const close = prices[prices.length - 1];
  const high20 = Math.max(...prices.slice(-21, -1));
  if (close < high20 * (1 + variant.breakoutPct)) return null;
  const sma20 = sma(prices.slice(-20), 20);
  const sma50 = sma(prices.slice(-50), 50);
  if (!sma20 || !sma50 || !(close > sma20 && sma20 > sma50)) return null;
  const rsi = ind.rsi?.value;
  if (rsi == null || rsi < variant.rsiMin || rsi > variant.rsiMax) return null;
  const adx = ind.adx?.value || 0;
  if (adx < 22) return null;
  const macdH = ind.macd?.value;
  if (macdH == null || macdH <= 0) return null;
  const obvTrend = ind.obv?.trend;
  if (obvTrend === 'down') return null;
  const regime = detectRegime(prices);
  if (regime === 'bear') return null;

  const atrAbs = (atrPctV / 100) * close;
  const entry = close;
  const stop = entry - 1.5 * atrAbs;
  const tp1 = entry + 3 * atrAbs;
  const tp2 = entry + 6 * atrAbs;
  if (stop >= entry || tp1 <= entry || tp2 <= tp1) return null;
  const risk = entry - stop;
  const rr2 = (tp2 - entry) / risk;
  if (rr2 < 3) return null;
  return _finalize({ ind, close, atrAbs, rr2, regime, entry, stop, tp1, tp2, obvTrend });
}

// ── Pattern D' Pullback Momentum (NOUVEAU — sain dans tendance prouvée) ──
// Logique : actif volatil qui a fait +X% sur 60j, puis pullback 10-25%,
// RSI passé en correction (35-55), revient au-dessus SMA20 → buy le rebond.
// Stop sous le récent pullback low, TP1 = retour au récent high, TP2 = extension.
function _detectPullback(prices, volumes, variant) {
  if (!prices || prices.length < 90) return null;
  const ind = computeAllIndicators(prices, volumes);
  if (!ind) return null;
  const atrPctV = ind.atr?.value;
  if (atrPctV == null || atrPctV < variant.atrMin) return null;
  const close = prices[prices.length - 1];
  const sma20 = sma(prices.slice(-20), 20);
  const sma50 = sma(prices.slice(-50), 50);
  if (!sma20 || !sma50) return null;
  // Structure haussière préservée
  if (sma20 <= sma50) return null;
  // Close vient de repasser au-dessus de SMA20 (ou est proche)
  if (close < sma20 * 0.99) return null;
  // Momentum 60j prouvé : prix d'il y a 60j vs récent high
  const price60Ago = prices[prices.length - 61];
  if (!price60Ago) return null;
  const recentHigh = Math.max(...prices.slice(-30));
  const momentum60 = (recentHigh - price60Ago) / price60Ago;
  if (momentum60 < variant.momentumPct) return null;
  // Pullback sain depuis récent high : close 10-25% sous le high
  const pullbackPct = (recentHigh - close) / recentHigh;
  if (pullbackPct < variant.pullbackMin || pullbackPct > variant.pullbackMax) return null;
  // RSI en correction (pas survente extrême, pas overbought)
  const rsi = ind.rsi?.value;
  if (rsi == null || rsi < variant.rsiMin || rsi > variant.rsiMax) return null;
  // MACD histogram croissant (reversal en cours) — accepte H<0 si en remontée
  const macdH = ind.macd?.value;
  if (macdH == null) return null;
  // OBV non baissier (volume confirme le pullback comme sain, pas distribution)
  const obvTrend = ind.obv?.trend;
  if (obvTrend === 'down') return null;
  // Régime non bear
  const regime = detectRegime(prices);
  if (regime === 'bear') return null;

  // Stop technique : sous le récent pullback low (5 derniers jours)
  const recentLow = Math.min(...prices.slice(-5));
  const atrAbs = (atrPctV / 100) * close;
  const entry = close;
  const stopTechnical = recentLow * 0.99;        // 1% sous le low
  const stopAtrFloor = entry - 1.2 * atrAbs;     // floor ATR
  const stop = Math.max(stopTechnical, stopAtrFloor);  // le plus haut des 2
  if (stop >= entry) return null;
  // TP1 = retour au récent high, TP2 = high + (high - pullbackLow) × 0.7 (extension)
  const tp1 = recentHigh;
  const tp2 = recentHigh + (recentHigh - recentLow) * 0.7;
  if (tp1 <= entry || tp2 <= tp1) return null;
  const risk = entry - stop;
  const rr2 = (tp2 - entry) / risk;
  // R/R minimum 1:2 (un peu moins exigeant que breakout car WR meilleur)
  if (rr2 < 2.0) return null;

  return _finalize({ ind, close, atrAbs, rr2, regime, entry, stop, tp1, tp2, obvTrend, pullbackPct, momentum60 });
}

// ── Helper : finalise un setup avec quality + sizing ──────────
function _finalize({ ind, close, atrAbs, rr2, regime, entry, stop, tp1, tp2, obvTrend, pullbackPct, momentum60 }) {
  const adx = ind.adx?.value || 0;
  const risk = entry - stop;
  // Quality score VOLT (base 78)
  let q = 78;
  if (regime === 'bull') q += 10;
  else if (regime === 'sideways') q += 5;
  if (adx >= 35) q += 10; else if (adx >= 25) q += 5;
  if (rr2 >= 4) q += 10; else if (rr2 >= 3) q += 5;
  if (obvTrend === 'up') q += 5;
  if (momentum60 != null && momentum60 >= 0.30) q += 5;
  q = Math.min(100, q);

  // Sizing override VOLT
  let sizing_pct;
  if (q >= 85) sizing_pct = 8;
  else if (q >= 75) sizing_pct = 5;
  else sizing_pct = 3;

  return {
    quality: q,
    sizing_pct,
    entry, stop, tp1, tp2,
    rr1: (tp1 - entry) / risk,
    rr2,
    regime,
  };
}

// ── HYBRID-CONFIRM : Pullback détecté + close casse le high récent ─────
// On attend une vraie confirmation reversal (close > high N derniers jours)
// avant d'entrer. Réduit les faux pullbacks qui continuent de baisser.
function _detectHybrid(prices, volumes, variant) {
  if (!prices || prices.length < 90) return null;
  const ind = computeAllIndicators(prices, volumes);
  if (!ind) return null;
  const atrPctV = ind.atr?.value;
  if (atrPctV == null || atrPctV < variant.atrMin) return null;
  const close = prices[prices.length - 1];
  const sma20 = sma(prices.slice(-20), 20);
  const sma50 = sma(prices.slice(-50), 50);
  if (!sma20 || !sma50 || sma20 <= sma50) return null;
  // Tendance LT : prix > SMA20
  if (close < sma20) return null;
  // Momentum 60j prouvé
  const price60Ago = prices[prices.length - 61];
  if (!price60Ago) return null;
  const recentHigh = Math.max(...prices.slice(-30));
  const momentum60 = (recentHigh - price60Ago) / price60Ago;
  if (momentum60 < variant.momentumPct) return null;
  // Pullback détecté entre récent high et low récent
  const pullbackPct = (recentHigh - Math.min(...prices.slice(-10))) / recentHigh;
  if (pullbackPct < variant.pullbackMin || pullbackPct > variant.pullbackMax) return null;
  // CONFIRMATION : close > max des N derniers jours (cassure du high de la phase pullback)
  const confirmHigh = Math.max(...prices.slice(-variant.confirmHighDays - 1, -1));
  if (close <= confirmHigh) return null;
  // RSI raisonnable (entre 45 et 70 : reversal en cours)
  const rsi = ind.rsi?.value;
  if (rsi == null || rsi < 45 || rsi > 70) return null;
  const obvTrend = ind.obv?.trend;
  if (obvTrend === 'down') return null;
  const regime = detectRegime(prices);
  if (regime === 'bear') return null;

  const recentLow = Math.min(...prices.slice(-10));
  const atrAbs = (atrPctV / 100) * close;
  const entry = close;
  const stop = Math.max(recentLow * 0.99, entry - 1.5 * atrAbs);
  if (stop >= entry) return null;
  const tp1 = recentHigh;
  const tp2 = recentHigh + (recentHigh - recentLow) * 0.8;
  if (tp1 <= entry || tp2 <= tp1) return null;
  const risk = entry - stop;
  const rr2 = (tp2 - entry) / risk;
  if (rr2 < 2.0) return null;
  return _finalize({ ind, close, atrAbs, rr2, regime, entry, stop, tp1, tp2, obvTrend, pullbackPct, momentum60 });
}

// ── BB-SQUEEZE : compression Bollinger + breakout (TTM Squeeze adapté) ──
// Détecte les phases où la volatilité a été comprimée (Bollinger width très basse)
// puis cherche la cassure (breakout du high de la phase squeeze).
function _detectSqueeze(prices, volumes, variant) {
  if (!prices || prices.length < 60) return null;
  const ind = computeAllIndicators(prices, volumes);
  if (!ind) return null;
  const atrPctV = ind.atr?.value;
  if (atrPctV == null || atrPctV < variant.atrMin) return null;
  const close = prices[prices.length - 1];
  const sma20 = sma(prices.slice(-20), 20);
  const sma50 = sma(prices.slice(-50), 50);
  if (!sma20 || !sma50 || sma20 <= sma50) return null;
  // Bollinger width : (upper - lower) / middle — on veut une compression historique
  // Approximation : std des 20 derniers prix / sma20
  const last20 = prices.slice(-20);
  const mean = last20.reduce((s, p) => s + p, 0) / 20;
  const variance = last20.reduce((s, p) => s + (p - mean) ** 2, 0) / 20;
  const std = Math.sqrt(variance);
  const bbWidth = (std * 4) / mean;  // approx 2 std up + 2 std down
  if (bbWidth > variant.squeezeWidthMax) return null;
  // Cassure du high 10j confirmant la sortie de squeeze
  const high10 = Math.max(...prices.slice(-11, -1));
  if (close < high10 * (1 + variant.breakoutPct)) return null;
  // Structure haussière minimum
  if (close < sma20) return null;
  const rsi = ind.rsi?.value;
  if (rsi == null || rsi < 50 || rsi > 75) return null;
  const obvTrend = ind.obv?.trend;
  if (obvTrend === 'down') return null;
  const regime = detectRegime(prices);
  if (regime === 'bear') return null;

  const atrAbs = (atrPctV / 100) * close;
  const entry = close;
  // Stop sous la zone de squeeze (low 20j)
  const low20 = Math.min(...prices.slice(-20));
  const stop = Math.max(low20 * 0.99, entry - 1.5 * atrAbs);
  if (stop >= entry) return null;
  const tp1 = entry + 3 * atrAbs;
  const tp2 = entry + 6 * atrAbs;
  const risk = entry - stop;
  const rr2 = (tp2 - entry) / risk;
  if (rr2 < 2.5) return null;
  return _finalize({ ind, close, atrAbs, rr2, regime, entry, stop, tp1, tp2, obvTrend });
}

// ── RS-MOMENTUM : force relative vs benchmark (Nasdaq) ─────────
// L'actif doit surperformer Nasdaq sur 60j ET avoir structure haussière.
// Capture les leaders du marché.
function _detectRsMomentum(prices, volumes, variant, benchmarkPrices) {
  if (!prices || prices.length < 90 || !benchmarkPrices || benchmarkPrices.length < 90) return null;
  const ind = computeAllIndicators(prices, volumes);
  if (!ind) return null;
  const atrPctV = ind.atr?.value;
  if (atrPctV == null || atrPctV < variant.atrMin) return null;
  const close = prices[prices.length - 1];
  const sma20 = sma(prices.slice(-20), 20);
  const sma50 = sma(prices.slice(-50), 50);
  if (!sma20 || !sma50 || sma20 <= sma50) return null;
  if (close < sma20) return null;
  // Force relative : (asset perf 60j) - (benchmark perf 60j)
  const assetReturn60 = (close - prices[prices.length - 61]) / prices[prices.length - 61];
  const benchReturn60 = (benchmarkPrices[benchmarkPrices.length - 1] - benchmarkPrices[benchmarkPrices.length - 61]) / benchmarkPrices[benchmarkPrices.length - 61];
  const rsValue = assetReturn60 - benchReturn60;
  if (rsValue < variant.rsMinPct) return null;
  // RSI momentum mais pas overbought
  const rsi = ind.rsi?.value;
  if (rsi == null || rsi < variant.rsiMin || rsi > variant.rsiMax) return null;
  const adx = ind.adx?.value || 0;
  if (adx < 20) return null;
  const obvTrend = ind.obv?.trend;
  if (obvTrend === 'down') return null;
  const regime = detectRegime(prices);
  if (regime === 'bear') return null;

  const atrAbs = (atrPctV / 100) * close;
  const entry = close;
  const stop = entry - 1.5 * atrAbs;
  const tp1 = entry + 3 * atrAbs;
  const tp2 = entry + 6 * atrAbs;
  const risk = entry - stop;
  const rr2 = (tp2 - entry) / risk;
  if (rr2 < 2.5) return null;
  return _finalize({ ind, close, atrAbs, rr2, regime, entry, stop, tp1, tp2, obvTrend, momentum60: assetReturn60 });
}

// ── STACKING-C : Pattern C éprouvé (Pullback Ichimoku) sur univers VOLT ─
// PF 5.65 mesuré sur 491k combos. Réutilise une logique validée.
function _detectPatternC(prices, volumes, variant) {
  if (!prices || prices.length < 60) return null;
  const ind = computeAllIndicators(prices, volumes);
  if (!ind) return null;
  const rsi = ind.rsi?.value;
  const boll = ind.boll?.value;
  const ichi = ind.ichimoku;
  if (rsi == null || rsi <= 35) return null;
  if (boll == null || boll >= 0.25) return null;
  if (!ichi || ichi.position !== 'above-cloud' || ichi.signal !== 'bull') return null;
  const obvTrend = ind.obv?.trend;
  if (obvTrend === 'down') return null;
  const regime = detectRegime(prices);
  if (regime === 'bear') return null;
  const atrPctV = ind.atr?.value;
  if (atrPctV == null) return null;
  const close = prices[prices.length - 1];
  const atrAbs = (atrPctV / 100) * close;
  const entry = close;
  const stop = entry - variant.atrStop * atrAbs;
  const tp1 = entry + (variant.atrTp2 * 0.5) * atrAbs;
  const tp2 = entry + variant.atrTp2 * atrAbs;
  if (stop >= entry || tp1 <= entry || tp2 <= tp1) return null;
  const risk = entry - stop;
  const rr2 = (tp2 - entry) / risk;
  if (rr2 < 2.0) return null;
  return _finalize({ ind, close, atrAbs, rr2, regime, entry, stop, tp1, tp2, obvTrend });
}

// ── STACKING-A : Pattern A éprouvé (RSI<25 contrarian) sur univers VOLT ─
function _detectPatternA(prices, volumes, variant) {
  if (!prices || prices.length < 60) return null;
  const ind = computeAllIndicators(prices, volumes);
  if (!ind) return null;
  const rsi = ind.rsi?.value;
  const boll = ind.boll?.value;
  const macdH = ind.macd?.value;
  if (rsi == null || rsi >= 25) return null;
  if (boll == null || boll >= 0.25) return null;
  if (macdH == null || macdH >= 0) return null;
  const regime = detectRegime(prices);
  if (regime === 'bear') return null;
  if (ind.mfi?.value > 70) return null;
  const atrPctV = ind.atr?.value;
  if (atrPctV == null) return null;
  const close = prices[prices.length - 1];
  const atrAbs = (atrPctV / 100) * close;
  const entry = close;
  const stop = entry - variant.atrStop * atrAbs;
  const tp1 = entry + (variant.atrTp2 * 0.5) * atrAbs;
  const tp2 = entry + variant.atrTp2 * atrAbs;
  if (stop >= entry || tp1 <= entry || tp2 <= tp1) return null;
  const risk = entry - stop;
  const rr2 = (tp2 - entry) / risk;
  if (rr2 < 2.0) return null;
  const obvTrend = ind.obv?.trend;
  return _finalize({ ind, close, atrAbs, rr2, regime, entry, stop, tp1, tp2, obvTrend });
}

// ── Router : dispatch selon mode ──
function detectVoltSetup(prices, volumes, variant, benchmarkPrices) {
  switch (variant.mode) {
    case 'pullback': return _detectPullback(prices, volumes, variant);
    case 'breakout': return _detectBreakout(prices, volumes, variant);
    case 'hybrid':   return _detectHybrid(prices, volumes, variant);
    case 'squeeze':  return _detectSqueeze(prices, volumes, variant);
    case 'rs':       return _detectRsMomentum(prices, volumes, variant, benchmarkPrices);
    case 'patternC': return _detectPatternC(prices, volumes, variant);
    case 'patternA': return _detectPatternA(prices, volumes, variant);
    default: return null;
  }
}

// ── Run backtest ──────────────────────────────────────────────
function runBacktest(data, minLen, variant, benchmarkPrices) {
  let cash = CAPITAL_INITIAL;
  let positions = [];
  const equityHist = [];
  const closed = [];
  const startIdx = minLen - BACKTEST_DAYS;

  for (let d = startIdx; d < minLen - 1; d++) {
    const today = d;
    const tomorrow = d + 1;

    // Update positions
    positions = positions.filter(pos => {
      const asset = data[pos.asset];
      if (!asset) return false;
      const cur = asset.prices[tomorrow];
      if (cur == null) return true;
      const ageDays = d - pos.opened_at;

      // Trailing chandelier après TP1 (désactivable selon variante)
      if (pos.high_since_entry == null || cur > pos.high_since_entry) pos.high_since_entry = cur;
      if (pos.touched_tp1 && variant.trailingAfterTp1) {
        const initialRisk = pos.entry - pos.initial_stop;
        const chandStop = pos.high_since_entry - initialRisk;
        if (chandStop > pos.stop) pos.stop = chandStop;
      }

      // Stop touché
      if (cur <= pos.stop) {
        let pnl;
        if (pos.trailing_active && pos.stop > pos.entry) {
          const gainSecondHalf = ((pos.stop - pos.entry) / pos.entry) * pos.size_eur * 0.5;
          pnl = pos.size_eur * pos.rr1 * 0.5 * pos.risk_pct + gainSecondHalf;
        } else if (pos.touched_tp1) {
          pnl = pos.trailing_active
            ? pos.size_eur * pos.rr1 * 0.5 * pos.risk_pct
            : pos.size_eur * (pos.rr1 * 0.5 - 0.5) * pos.risk_pct;
        } else {
          pnl = -pos.size_eur * pos.risk_pct;
        }
        cash += pos.size_eur + pnl;
        closed.push({ ...pos, pnl_eur: pnl, status: pos.trailing_active ? (pos.stop > pos.entry ? 'trail_profit' : 'breakeven') : (pos.touched_tp1 ? 'partial' : 'loss'), closed_at: d });
        return false;
      }
      // TP2 touché → win complet
      if (cur >= pos.tp2) {
        const pnl = pos.size_eur * pos.rr2 * pos.risk_pct;
        cash += pos.size_eur + pnl;
        closed.push({ ...pos, pnl_eur: pnl, status: 'win', closed_at: d });
        return false;
      }
      // TP1 touché → stop monte à entry (sécurise gains)
      if (!pos.touched_tp1 && cur >= pos.tp1) {
        pos.touched_tp1 = true;
        pos.stop = pos.entry;
        pos.trailing_active = true;
      }
      // Timeout (paramétré par variante)
      if (ageDays >= variant.timeoutDays) {
        const pnlPct = (cur - pos.entry) / pos.entry;
        const pnl = pos.size_eur * pnlPct;
        cash += pos.size_eur + pnl;
        closed.push({ ...pos, pnl_eur: pnl, status: 'timeout', closed_at: d });
        return false;
      }
      pos.current_price = cur;
      return true;
    });

    // Open new positions (max 3 simultanées)
    if (positions.length < MAX_POSITIONS && cash > 1) {
      const opened = new Set(positions.map(p => p.asset));
      const candidates = [];

      for (const [label, asset] of Object.entries(data)) {
        if (opened.has(label)) continue;
        const slice = asset.prices.slice(0, today + 1);
        if (slice.length < WARMUP) continue;
        const sliceVol = asset.volumes.slice(0, today + 1);
        const benchSlice = benchmarkPrices ? benchmarkPrices.slice(0, today + 1) : null;
        const setup = detectVoltSetup(slice, sliceVol, variant, benchSlice);
        if (!setup) continue;
        if (setup.quality < variant.minQ) continue;
        candidates.push({ label, setup });
      }
      candidates.sort((a, b) => b.setup.quality - a.setup.quality);
      const slots = MAX_POSITIONS - positions.length;
      // Kelly-light streak (cohérent avec autres backtests)
      const recent5 = closed.slice(-5);
      let streakMult = 1;
      if (recent5.length >= 3) {
        const last3 = recent5.slice(-3);
        if (last3.every(t => (t.pnl_eur || 0) > 0)) streakMult = 1.2;
        else if (last3.every(t => (t.pnl_eur || 0) <= 0)) streakMult = 0.7;
      }
      for (const c of candidates.slice(0, slots)) {
        const size_eur = cash * (c.setup.sizing_pct * streakMult / 100);
        if (size_eur < 1) continue;
        cash -= size_eur;
        const risk_pct = (c.setup.entry - c.setup.stop) / c.setup.entry;
        positions.push({
          asset: c.label, pattern: c.setup.pattern, quality: c.setup.quality,
          sizing_pct: c.setup.sizing_pct, regime: c.setup.regime,
          entry: c.setup.entry, stop: c.setup.stop, tp1: c.setup.tp1, tp2: c.setup.tp2,
          initial_stop: c.setup.stop, high_since_entry: c.setup.entry,
          rr1: c.setup.rr1, rr2: c.setup.rr2,
          size_eur, risk_pct,
          touched_tp1: false, trailing_active: false,
          opened_at: d,
        });
      }
    }

    let eq = cash;
    for (const p of positions) {
      const cur = data[p.asset].prices[today] || p.entry;
      eq += p.size_eur * (cur / p.entry);
    }
    equityHist.push({ day: d, equity: eq });
  }

  const finalEq = equityHist[equityHist.length - 1].equity;
  const ret = ((finalEq - CAPITAL_INITIAL) / CAPITAL_INITIAL) * 100;
  const wins = closed.filter(t => t.pnl_eur > 0);
  const losses = closed.filter(t => t.pnl_eur <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl_eur, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl_eur, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (wins.length > 0 ? 999 : 0);
  const wr = closed.length > 0 ? wins.length / closed.length : 0;
  let maxEq = CAPITAL_INITIAL, maxDd = 0;
  equityHist.forEach(p => {
    if (p.equity > maxEq) maxEq = p.equity;
    const dd = (p.equity - maxEq) / maxEq;
    if (dd < maxDd) maxDd = dd;
  });
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl_eur, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl_eur, 0) / losses.length : 0;
  // Décomposition statuts
  const byStatus = {};
  closed.forEach(t => { byStatus[t.status] = (byStatus[t.status] || 0) + 1; });
  // Décomposition par classe
  const byKind = { crypto: 0, action: 0 };
  closed.forEach(t => {
    const kind = VOLT_ASSETS.find(a => a.label === t.asset)?.kind;
    if (kind) byKind[kind]++;
  });

  return {
    equity_final: Number(finalEq.toFixed(2)),
    return_pct: Number(ret.toFixed(2)),
    annualized_pct: Number(((Math.pow(1 + ret / 100, 252 / BACKTEST_DAYS) - 1) * 100).toFixed(2)),
    profit_factor: Number(pf.toFixed(2)),
    max_dd_pct: Number((maxDd * 100).toFixed(2)),
    win_rate_pct: Number((wr * 100).toFixed(1)),
    trades_closed: closed.length,
    trades_per_year: Number((closed.length * (252 / BACKTEST_DAYS)).toFixed(1)),
    avg_win_eur: Number(avgWin.toFixed(3)),
    avg_loss_eur: Number(avgLoss.toFixed(3)),
    avg_pnl_per_trade: closed.length > 0 ? Number((closed.reduce((s, t) => s + t.pnl_eur, 0) / closed.length).toFixed(3)) : 0,
    by_status: byStatus,
    by_kind: byKind,
  };
}

async function main() {
  console.log(`=== Backtest VOLT v7.12 · ${BACKTEST_DAYS}j · ${VOLT_ASSETS.length} actifs · ${CAPITAL_INITIAL}€ initial ===\n`);
  console.log(`Fetching ${VOLT_ASSETS.length} actifs (Yahoo ${HISTORY_RANGE})...`);
  const data = {};
  for (const a of VOLT_ASSETS) {
    try {
      const d = await fetchYahooHistorical(a.symbol, HISTORY_RANGE);
      if (!d || !Array.isArray(d.prices) || d.prices.length < WARMUP + 50) {
        console.warn(`  SKIP ${a.label} (${a.symbol}): historique insuffisant (${d?.prices?.length || 0} candles)`);
        continue;
      }
      data[a.label] = { ...a, prices: d.prices, volumes: d.volumes || [] };
      console.log(`  ${a.label.padEnd(20)}: ${d.prices.length} candles`);
    } catch (e) {
      console.warn(`  SKIP ${a.label}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 120));
  }
  const assetsLoaded = Object.keys(data).length;
  if (assetsLoaded < 5) {
    console.error('Pas assez d\'actifs chargés (' + assetsLoaded + '). Abandon.');
    process.exit(1);
  }

  // Charge Nasdaq comme benchmark RS-MOMENTUM
  console.log('\nFetching ^IXIC (Nasdaq) benchmark...');
  let benchmarkPrices = null;
  try {
    const d = await fetchYahooHistorical('^IXIC', HISTORY_RANGE);
    benchmarkPrices = d.prices;
    console.log(`  Nasdaq: ${benchmarkPrices.length} candles`);
  } catch (e) {
    console.warn(`  Nasdaq fetch failed: ${e.message} (RS-MOMENTUM sera skip)`);
  }

  const lengths = Object.values(data).map(d => d.prices.length);
  const minLen = Math.min(...lengths);
  // Cap le backtest si historique min < 600+220 (warmup)
  const effectiveDays = Math.min(BACKTEST_DAYS, minLen - WARMUP - 10);
  if (effectiveDays < 100) {
    console.warn(`Historique min trop court (${minLen}j). Backtest réduit à ${effectiveDays}j.`);
  }
  console.log(`\nMin length: ${minLen}j (warmup ${WARMUP}j), backtest sur ${BACKTEST_DAYS}j ≈ ${(BACKTEST_DAYS / 252).toFixed(2)} ans\n`);
  console.log(`Running ${VARIANTS.length} variantes...\n`);

  // Lance les 4 variantes en parallèle (CPU-only, pas d'I/O dans runBacktest)
  const variantResults = VARIANTS.map(v => {
    console.log(`  → ${v.name} (mode=${v.mode}, minQ=${v.minQ}, timeout=${v.timeoutDays}j)`);
    const r = runBacktest(data, minLen, v, benchmarkPrices);
    return { variant: v.name, params: v, ...r };
  });

  // Détermine la meilleure variante (score = annualized × (1 - |maxDd|/100))
  const scored = variantResults.map(r => ({
    ...r,
    score: r.annualized_pct * (1 + r.max_dd_pct / 100),  // pénalise les DD
  }));
  const best = scored.reduce((b, r) => (r.score > b.score ? r : b), scored[0]);

  // Verdict global
  let verdict;
  if (best.annualized_pct >= 15 && best.max_dd_pct >= -20) {
    verdict = '✅ CIBLE ATTEINTE : ' + best.variant + ' valide la promesse VOLT (' + best.annualized_pct + '%/an, DD ' + best.max_dd_pct + '%)';
  } else if (best.annualized_pct >= 8) {
    verdict = '⚠️ EN DESSOUS DE LA CIBLE : meilleure variante = ' + best.variant + ' (' + best.annualized_pct + '%/an). À itérer (élargir univers OU pattern différent).';
  } else if (best.annualized_pct >= 0) {
    verdict = '❌ SOUS-PERFORMANT : meilleure variante = ' + best.variant + ' (' + best.annualized_pct + '%/an). Pattern D ne tient pas sur cet univers — repenser le détecteur.';
  } else {
    verdict = '🚨 PERTE : toutes les variantes perdent. Pattern D + univers VOLT incompatibles, refonte nécessaire.';
  }

  await fs.mkdir(path.join(process.cwd(), 'data', 'sandbox'), { recursive: true });
  const out = {
    generated: new Date().toISOString(),
    version: 'v7.12',
    backtest_days: BACKTEST_DAYS,
    capital_initial: CAPITAL_INITIAL,
    max_positions: MAX_POSITIONS,
    universe_size: VOLT_ASSETS.length,
    assets_loaded: assetsLoaded,
    assets_skipped: VOLT_ASSETS.length - assetsLoaded,
    best_variant: best.variant,
    verdict,
    variants: variantResults,
  };
  await fs.writeFile(
    path.join(process.cwd(), 'data', 'sandbox', 'backtest_volt.json'),
    JSON.stringify(out, null, 2) + '\n'
  );

  // Affichage tableau comparatif
  console.log('\n╔═════════════════════════════════════════════════════════════════════════════════╗');
  console.log(`║ VOLT GRID-SEARCH · ${BACKTEST_DAYS}j · ${assetsLoaded}/${VOLT_ASSETS.length} actifs · ${CAPITAL_INITIAL}€                          ║`);
  console.log('╠═════════════════╦═════════╦═════════╦══════╦═════════╦═══════╦═══════╦═════════╣');
  console.log('║ Variante        ║ Final   ║ Annual. ║ PF   ║ Max DD  ║ WR    ║ Trades║ Win/Loss║');
  console.log('╟─────────────────╫─────────╫─────────╫──────╫─────────╫───────╫───────╫─────────╢');
  for (const r of variantResults) {
    const tag = r.variant === best.variant ? '★' : ' ';
    const ann = (r.annualized_pct >= 0 ? '+' : '') + r.annualized_pct + '%';
    const ret = (r.return_pct >= 0 ? '+' : '') + r.return_pct + '%';
    console.log(`║ ${tag}${r.variant.padEnd(14)} ║ ${r.equity_final.toFixed(0).padStart(5)}€  ║ ${ann.padStart(7)} ║ ${r.profit_factor.toFixed(2).padStart(4)} ║ ${(r.max_dd_pct.toFixed(1) + '%').padStart(7)} ║ ${(r.win_rate_pct.toFixed(0) + '%').padStart(5)} ║ ${r.trades_closed.toString().padStart(5)} ║ ${(r.avg_win_eur.toFixed(1) + '/' + r.avg_loss_eur.toFixed(1)).padStart(7)} ║`);
  }
  console.log('╚═════════════════╩═════════╩═════════╩══════╩═════════╩═══════╩═══════╩═════════╝');
  console.log(`\n${verdict}\n`);
  console.log(`Meilleure config : ${JSON.stringify(best.params, null, 0)}`);
  console.log('\nStatuts trades (meilleure variante) : ' + Object.entries(best.by_status).map(([k, v]) => `${k}=${v}`).join(' · '));
  console.log(`Classes : crypto=${best.by_kind.crypto} action=${best.by_kind.action}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
