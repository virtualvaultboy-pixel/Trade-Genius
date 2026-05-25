#!/usr/bin/env node
/**
 * Trade Genius — v7.17 Walk-forward IS/OOS (anti-overfit critique)
 *
 * Les configs v7.16 ont été optimisées sur les MÊMES 6 folds qu'on a utilisés
 * pour valider. C'est de l'overfit potentiel. Ce script split l'historique :
 *   - 4 premiers folds = IS (in-sample, "entraînement" via grid-search)
 *   - 2 derniers folds = OOS (out-of-sample, jamais vus)
 *
 * Pour chaque IA × 6 variantes :
 *   - perf IS (médian sur 4 folds)
 *   - perf OOS (médian sur 2 folds OOS)
 *   - dégradation = (OOS - IS) / IS
 *
 * Verdict :
 *   - OOS > IS × 0.7 → robuste
 *   - OOS entre IS × 0.4 et 0.7 → fragile (à surveiller)
 *   - OOS < IS × 0.4 → overfit clair, ajuster
 *
 * Sortie : data/sandbox/walkforward_isos.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchYahooHistorical, computeAllIndicators, sma } from './indicators.mjs';

const CAPITAL_INITIAL = 1000;
const MAX_POSITIONS = 3;
const WARMUP = 220;
const HISTORY_RANGE = '5y';
const N_FOLDS = 6;
const FOLD_DAYS = 150;
const SLIPPAGE_PCT = 0.002;
const SIZING_CAP_PCT = 5;
const N_IS_FOLDS = 4;  // premiers folds = in-sample
const N_OOS_FOLDS = N_FOLDS - N_IS_FOLDS;  // 2 derniers = out-of-sample

const STOCK_INDEX_UNIVERSE = [
  { symbol: '^GSPC',  label: 'S&P 500',     kind: 'index' },
  { symbol: '^IXIC',  label: 'Nasdaq',      kind: 'index' },
  { symbol: '^DJI',   label: 'Dow Jones',   kind: 'index' },
  { symbol: '^FCHI',  label: 'CAC 40',      kind: 'index' },
  { symbol: '^GDAXI', label: 'DAX',         kind: 'index' },
  { symbol: '^FTSE',  label: 'FTSE 100',    kind: 'index' },
  { symbol: 'AAPL',  label: 'Apple',       kind: 'action' },
  { symbol: 'MSFT',  label: 'Microsoft',   kind: 'action' },
  { symbol: 'GOOGL', label: 'Alphabet',    kind: 'action' },
  { symbol: 'AMZN',  label: 'Amazon',      kind: 'action' },
  { symbol: 'META',  label: 'Meta',        kind: 'action' },
  { symbol: 'NVDA',  label: 'Nvidia',      kind: 'action' },
  { symbol: 'TSLA',  label: 'Tesla',       kind: 'action' },
  { symbol: 'NFLX',  label: 'Netflix',     kind: 'action' },
  { symbol: 'JPM',   label: 'JPMorgan',    kind: 'action' },
  { symbol: 'V',     label: 'Visa',        kind: 'action' },
  { symbol: 'WMT',   label: 'Walmart',     kind: 'action' },
  { symbol: 'JNJ',   label: 'J&J',         kind: 'action' },
  { symbol: 'PG',    label: 'P&G',         kind: 'action' },
  { symbol: 'KO',    label: 'Coca-Cola',   kind: 'action' },
  { symbol: 'DIS',   label: 'Disney',      kind: 'action' },
  { symbol: 'BAC',   label: 'BoA',         kind: 'action' },
  { symbol: 'MA',    label: 'Mastercard',  kind: 'action' },
  { symbol: 'XOM',   label: 'Exxon',       kind: 'action' },
  { symbol: 'CVX',   label: 'Chevron',     kind: 'action' },
  { symbol: 'NKE',   label: 'Nike',        kind: 'action' },
];
const CRYPTO_UNIVERSE = [
  { symbol: 'BTC-USD',  label: 'BTC',     kind: 'crypto' },
  { symbol: 'ETH-USD',  label: 'ETH',     kind: 'crypto' },
  { symbol: 'BNB-USD',  label: 'BNB',     kind: 'crypto' },
  { symbol: 'XRP-USD',  label: 'XRP',     kind: 'crypto' },
  { symbol: 'ADA-USD',  label: 'ADA',     kind: 'crypto' },
  { symbol: 'DOGE-USD', label: 'DOGE',    kind: 'crypto' },
  { symbol: 'DOT-USD',  label: 'DOT',     kind: 'crypto' },
  { symbol: 'LINK-USD', label: 'LINK',    kind: 'crypto' },
  { symbol: 'TRX-USD',  label: 'TRX',     kind: 'crypto' },
  { symbol: 'LTC-USD',  label: 'LTC',     kind: 'crypto' },
  { symbol: 'UNI-USD',  label: 'UNI',     kind: 'crypto' },
  { symbol: 'XLM-USD',  label: 'XLM',     kind: 'crypto' },
  { symbol: 'BCH-USD',  label: 'BCH',     kind: 'crypto' },
];

// Variantes : 6 par IA (identiques à optimize-ias.mjs) — la 1ère = BASELINE v7.15, les autres = candidats v7.16
const IA_VARIANTS = {
  BASTION: {
    universe: STOCK_INDEX_UNIVERSE,
    deployedV716: 'TIGHT-STOP',  // config déployée en v7.16
    variants: [
      { name: 'BASELINE-v7.15', atrStop: 1.0, atrTp2: 7.0, timeoutDays: 60 },
      { name: 'TIGHT-STOP',     atrStop: 0.7, atrTp2: 7.0, timeoutDays: 60 },
      { name: 'TIGHT-FAST',     atrStop: 0.7, atrTp2: 5.0, timeoutDays: 40 },
      { name: 'SCALP-LIKE',     atrStop: 0.6, atrTp2: 4.5, timeoutDays: 30 },
      { name: 'SCALP-WIDE',     atrStop: 0.6, atrTp2: 6.0, timeoutDays: 45 },
      { name: 'BALANCED',       atrStop: 0.8, atrTp2: 6.0, timeoutDays: 45 },
    ],
  },
  PHENIX: {
    universe: STOCK_INDEX_UNIVERSE,
    deployedV716: 'TIGHT-STOP',
    variants: [
      { name: 'BASELINE-v7.15', atrStop: 1.0, atrTp2: 5.0, timeoutDays: 30 },
      { name: 'TIGHT-STOP',     atrStop: 0.7, atrTp2: 5.0, timeoutDays: 30 },
      { name: 'TIGHT-FAST',     atrStop: 0.7, atrTp2: 4.0, timeoutDays: 21 },
      { name: 'SCALP-LIKE',     atrStop: 0.6, atrTp2: 4.5, timeoutDays: 20 },
      { name: 'VOLT-CLONE',     atrStop: 0.6, atrTp2: 4.5, timeoutDays: 15 },
      { name: 'BALANCED',       atrStop: 0.8, atrTp2: 5.0, timeoutDays: 25 },
    ],
  },
  RAFALE: {
    universe: STOCK_INDEX_UNIVERSE,
    deployedV716: 'SCALP-ULTRA',
    variants: [
      { name: 'BASELINE-v7.15', atrStop: 1.0, atrTp2: 4.0, timeoutDays: 14 },
      { name: 'TIGHT-STOP',     atrStop: 0.7, atrTp2: 4.0, timeoutDays: 14 },
      { name: 'SCALP-LIKE',     atrStop: 0.6, atrTp2: 4.5, timeoutDays: 15 },
      { name: 'SCALP-ULTRA',    atrStop: 0.5, atrTp2: 3.5, timeoutDays: 12 },
      { name: 'WIDE-TP',        atrStop: 0.6, atrTp2: 5.0, timeoutDays: 18 },
      { name: 'BALANCED',       atrStop: 0.8, atrTp2: 4.0, timeoutDays: 14 },
    ],
  },
  NEXUS: {
    universe: CRYPTO_UNIVERSE,
    deployedV716: 'CRYPTO-FAST',
    variants: [
      { name: 'BASELINE-v7.15', atrStop: 1.0, atrTp2: 5.0, timeoutDays: 30 },
      { name: 'TIGHT-STOP',     atrStop: 0.7, atrTp2: 5.0, timeoutDays: 30 },
      { name: 'SCALP-LIKE',     atrStop: 0.6, atrTp2: 4.5, timeoutDays: 20 },
      { name: 'CRYPTO-FAST',    atrStop: 0.6, atrTp2: 4.0, timeoutDays: 15 },
      { name: 'CRYPTO-WIDE',    atrStop: 0.7, atrTp2: 6.0, timeoutDays: 25 },
      { name: 'BALANCED',       atrStop: 0.8, atrTp2: 5.0, timeoutDays: 25 },
    ],
  },
};

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
function _patternA(ind, prices) {
  const rsi = ind.rsi?.value, boll = ind.boll?.value, macdH = ind.macd?.value;
  if (rsi == null || rsi >= 25) return null;
  if (boll == null || boll >= 0.25) return null;
  if (macdH == null || macdH >= 0) return null;
  const regime = detectRegime(prices);
  if (regime === 'bear') return null;
  if (ind.mfi?.value > 70) return null;
  return { regime, kind: 'A' };
}
function _patternC(ind, prices) {
  const rsi = ind.rsi?.value, boll = ind.boll?.value, ichi = ind.ichimoku;
  if (rsi == null || rsi <= 35) return null;
  if (boll == null || boll >= 0.25) return null;
  if (!ichi || ichi.position !== 'above-cloud' || ichi.signal !== 'bull') return null;
  if (ind.obv?.trend === 'down') return null;
  const regime = detectRegime(prices);
  if (regime === 'bear') return null;
  return { regime, kind: 'C' };
}
function _patternB(ind, prices) {
  const rsi = ind.rsi?.value, adx = ind.adx?.value || 0, boll = ind.boll?.value, macdH = ind.macd?.value;
  if (rsi == null || rsi <= 35) return null;
  if (adx < 25) return null;
  if (boll == null || boll < 0.25 || boll > 0.75) return null;
  if (macdH == null || macdH >= 0) return null;
  const regime = detectRegime(prices);
  if (regime === 'bear') return null;
  if (ind.obv?.trend === 'down') return null;
  return { regime, kind: 'B' };
}
function detectSetup(prices, volumes, variant) {
  if (!prices || prices.length < 60) return null;
  const ind = computeAllIndicators(prices, volumes);
  if (!ind) return null;
  const pat = _patternA(ind, prices) || _patternC(ind, prices) || _patternB(ind, prices);
  if (!pat) return null;
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
  if (rr2 < 1.5) return null;
  let q = (pat.kind === 'C' && pat.regime === 'bull') ? 75 : pat.kind === 'A' ? 70 : 60;
  if (pat.regime === 'bull') q += 10;
  else if (pat.regime === 'sideways') q += 5;
  const adx = ind.adx?.value || 0;
  if (adx >= 35) q += 10; else if (adx >= 25) q += 5;
  if (rr2 >= 4) q += 10; else if (rr2 >= 3) q += 5;
  if (ind.obv?.trend === 'up') q += 5;
  q = Math.min(100, q);
  let sizing_pct = q >= 85 ? SIZING_CAP_PCT : q >= 75 ? Math.min(SIZING_CAP_PCT, 4) : Math.min(SIZING_CAP_PCT, 2);
  return { quality: q, sizing_pct, entry, stop, tp1, tp2, rr1: (tp1 - entry) / risk, rr2, regime: pat.regime, pattern: pat.kind };
}
function runFold(data, startIdx, endIdx, variant) {
  let cash = CAPITAL_INITIAL;
  let positions = [];
  const equityHist = [];
  const closed = [];
  for (let d = startIdx; d < endIdx; d++) {
    const today = d, tomorrow = d + 1;
    positions = positions.filter(pos => {
      const asset = data[pos.asset];
      if (!asset) return false;
      const cur = asset.prices[tomorrow];
      if (cur == null) return true;
      const ageDays = d - pos.opened_at;
      if (pos.high_since_entry == null || cur > pos.high_since_entry) pos.high_since_entry = cur;
      if (pos.touched_tp1) {
        const initialRisk = pos.entry - pos.initial_stop;
        const chandStop = pos.high_since_entry - initialRisk;
        if (chandStop > pos.stop) pos.stop = chandStop;
      }
      const exitWithSlip = (px) => px * (1 - SLIPPAGE_PCT);
      if (cur <= pos.stop) {
        let pnl;
        if (pos.trailing_active && pos.stop > pos.entry) {
          const exitPx = exitWithSlip(pos.stop);
          const gainSecondHalf = ((exitPx - pos.entry) / pos.entry) * pos.size_eur * 0.5;
          pnl = pos.size_eur * pos.rr1 * 0.5 * pos.risk_pct + gainSecondHalf;
        } else if (pos.touched_tp1) {
          pnl = pos.trailing_active
            ? pos.size_eur * pos.rr1 * 0.5 * pos.risk_pct
            : pos.size_eur * (pos.rr1 * 0.5 - 0.5) * pos.risk_pct;
        } else {
          pnl = -pos.size_eur * pos.risk_pct;
        }
        cash += pos.size_eur + pnl;
        closed.push({ ...pos, pnl_eur: pnl, closed_at: d });
        return false;
      }
      if (cur >= pos.tp2) {
        const exitPx = exitWithSlip(pos.tp2);
        const realizedR = (exitPx - pos.entry) / (pos.entry - pos.initial_stop);
        const pnl = pos.size_eur * realizedR * pos.risk_pct;
        cash += pos.size_eur + pnl;
        closed.push({ ...pos, pnl_eur: pnl, closed_at: d });
        return false;
      }
      if (!pos.touched_tp1 && cur >= pos.tp1) {
        pos.touched_tp1 = true;
        pos.stop = pos.entry;
        pos.trailing_active = true;
      }
      if (ageDays >= variant.timeoutDays) {
        const exitPx = exitWithSlip(cur);
        const pnlPct = (exitPx - pos.entry) / pos.entry;
        const pnl = pos.size_eur * pnlPct;
        cash += pos.size_eur + pnl;
        closed.push({ ...pos, pnl_eur: pnl, closed_at: d });
        return false;
      }
      pos.current_price = cur;
      return true;
    });
    if (positions.length < MAX_POSITIONS && cash > 1) {
      const opened = new Set(positions.map(p => p.asset));
      const candidates = [];
      for (const [label, asset] of Object.entries(data)) {
        if (opened.has(label)) continue;
        const slice = asset.prices.slice(0, today + 1);
        if (slice.length < WARMUP) continue;
        const sliceVol = asset.volumes.slice(0, today + 1);
        const setup = detectSetup(slice, sliceVol, variant);
        if (!setup) continue;
        if (setup.quality < 65) continue;
        candidates.push({ label, setup });
      }
      candidates.sort((a, b) => b.setup.quality - a.setup.quality);
      const slots = MAX_POSITIONS - positions.length;
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
        const entryWithSlip = c.setup.entry * (1 + SLIPPAGE_PCT);
        const risk_pct = (entryWithSlip - c.setup.stop) / entryWithSlip;
        positions.push({
          asset: c.label, quality: c.setup.quality,
          sizing_pct: c.setup.sizing_pct, regime: c.setup.regime,
          entry: entryWithSlip, stop: c.setup.stop, tp1: c.setup.tp1, tp2: c.setup.tp2,
          initial_stop: c.setup.stop, high_since_entry: entryWithSlip,
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
  const finalEq = equityHist[equityHist.length - 1]?.equity || CAPITAL_INITIAL;
  const foldDays = endIdx - startIdx;
  const ret = ((finalEq - CAPITAL_INITIAL) / CAPITAL_INITIAL) * 100;
  const annualized = (Math.pow(1 + ret / 100, 252 / foldDays) - 1) * 100;
  let maxEq = CAPITAL_INITIAL, maxDd = 0;
  equityHist.forEach(p => {
    if (p.equity > maxEq) maxEq = p.equity;
    const dd = (p.equity - maxEq) / maxEq;
    if (dd < maxDd) maxDd = dd;
  });
  return {
    annualized_pct: Number(annualized.toFixed(2)),
    max_dd_pct: Number((maxDd * 100).toFixed(2)),
    trades_closed: closed.length,
  };
}

function runVariantIsOos(data, minLen, variant) {
  const effectiveTotal = Math.min(N_FOLDS * FOLD_DAYS, minLen - WARMUP - 10);
  const effectiveFolds = Math.floor(effectiveTotal / FOLD_DAYS);
  const startGlobal = minLen - effectiveFolds * FOLD_DAYS;
  const isResults = [];
  const oosResults = [];
  for (let i = 0; i < effectiveFolds; i++) {
    const r = runFold(data, startGlobal + i * FOLD_DAYS, startGlobal + (i + 1) * FOLD_DAYS, variant);
    if (i < N_IS_FOLDS) isResults.push(r);
    else oosResults.push(r);
  }
  const median = (arr) => {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const isAnn = isResults.map(r => r.annualized_pct);
  const oosAnn = oosResults.map(r => r.annualized_pct);
  const isDd = isResults.map(r => r.max_dd_pct);
  const oosDd = oosResults.map(r => r.max_dd_pct);
  return {
    is: {
      median: Number(median(isAnn).toFixed(2)),
      mean: Number((isAnn.reduce((s, x) => s + x, 0) / isAnn.length).toFixed(2)),
      worst_dd: Number(Math.min(...isDd, 0).toFixed(2)),
      positive_folds: isAnn.filter(a => a > 0).length,
      n_folds: isAnn.length,
    },
    oos: {
      median: Number(median(oosAnn).toFixed(2)),
      mean: oosAnn.length ? Number((oosAnn.reduce((s, x) => s + x, 0) / oosAnn.length).toFixed(2)) : 0,
      worst_dd: oosDd.length ? Number(Math.min(...oosDd).toFixed(2)) : 0,
      positive_folds: oosAnn.filter(a => a > 0).length,
      n_folds: oosAnn.length,
    },
  };
}

async function runIA(iaName, config) {
  console.log(`\n━━━ ${iaName} — IS/OOS analysis (${config.universe.length} actifs · IS=${N_IS_FOLDS} folds · OOS=${N_OOS_FOLDS} folds) ━━━`);
  const data = {};
  for (const a of config.universe) {
    try {
      const d = await fetchYahooHistorical(a.symbol, HISTORY_RANGE);
      if (!d || !Array.isArray(d.prices) || d.prices.length < WARMUP + 50) continue;
      data[a.label] = { ...a, prices: d.prices, volumes: d.volumes || [] };
    } catch {}
    await new Promise(r => setTimeout(r, 80));
  }
  console.log(`  ${Object.keys(data).length}/${config.universe.length} actifs chargés`);
  const lengths = Object.values(data).map(d => d.prices.length);
  const minLen = Math.min(...lengths);

  const results = [];
  for (const v of config.variants) {
    const r = runVariantIsOos(data, minLen, v);
    const isM = r.is.median;
    const oosM = r.oos.median;
    const degradation = isM !== 0 ? (oosM - isM) / Math.abs(isM) : 0;
    const tag = (oosM > isM * 0.7) ? '✓' : (oosM > isM * 0.4) ? '~' : '✗';
    const deployTag = (v.name === config.deployedV716) ? ' [🚀 DÉPLOYÉE]' : '';
    console.log(`  ${tag} ${v.name.padEnd(16)} IS=${(isM >= 0 ? '+' : '') + isM.toFixed(2)}% · OOS=${(oosM >= 0 ? '+' : '') + oosM.toFixed(2)}% · dégr=${(degradation * 100).toFixed(0)}%${deployTag}`);
    results.push({ variant: v.name, params: { atrStop: v.atrStop, atrTp2: v.atrTp2, timeoutDays: v.timeoutDays }, is: r.is, oos: r.oos, degradation: Number(degradation.toFixed(3)) });
  }

  // Trouve la meilleure OOS (anti-overfit) parmi celles avec OOS positif et DD acceptable
  const eligible = results.filter(r => r.oos.median > 0 && r.oos.worst_dd >= -10 && r.oos.positive_folds === r.oos.n_folds);
  const bestOos = eligible.length > 0
    ? eligible.reduce((b, r) => (r.oos.median > b.oos.median ? r : b), eligible[0])
    : results[0];
  const deployedConfig = results.find(r => r.variant === config.deployedV716);
  const overfit = deployedConfig.is.median > 0 && (deployedConfig.oos.median / deployedConfig.is.median) < 0.5;

  console.log(`\n  🎯 Meilleure OOS  : ${bestOos.variant} → OOS=${(bestOos.oos.median >= 0 ? '+' : '') + bestOos.oos.median}%/an`);
  console.log(`  📦 Déployée v7.16 : ${deployedConfig.variant} → IS=${deployedConfig.is.median}%/an · OOS=${deployedConfig.oos.median}%/an`);
  if (overfit) {
    console.log(`  ⚠️  OVERFIT DÉTECTÉ : la config v7.16 perd ${((1 - deployedConfig.oos.median / deployedConfig.is.median) * 100).toFixed(0)}% en OOS — ajustement recommandé vers ${bestOos.variant}`);
  } else {
    console.log(`  ✅ Pas d'overfit majeur : la config v7.16 tient en OOS`);
  }

  return { ia_name: iaName, deployedV716: deployedConfig, bestOos, overfit, all_variants: results };
}

async function main() {
  console.log(`=== WALK-FORWARD IS/OOS v7.17 · split 4 folds IS / 2 folds OOS · slippage 0.4% ===\n`);
  const allResults = [];
  for (const [iaName, config] of Object.entries(IA_VARIANTS)) {
    const r = await runIA(iaName, config);
    allResults.push(r);
  }

  console.log(`\n╔════════════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║ SYNTHÈSE IS/OOS · validation anti-overfit des configs v7.16                       ║`);
  console.log(`╠══════════╦══════════════╦═════════╦═════════╦═════════╦══════════════╦══════════╣`);
  console.log(`║ IA       ║ Déployée v7.16║ IS méd. ║OOS méd. ║Dégradat.║ Meilleure OOS║ Overfit? ║`);
  console.log(`╟──────────╫──────────────╫─────────╫─────────╫─────────╫──────────────╫──────────╢`);
  for (const r of allResults) {
    const isM = (r.deployedV716.is.median >= 0 ? '+' : '') + r.deployedV716.is.median + '%';
    const oosM = (r.deployedV716.oos.median >= 0 ? '+' : '') + r.deployedV716.oos.median + '%';
    const degr = (r.deployedV716.degradation * 100).toFixed(0) + '%';
    const status = r.overfit ? '🚨 OUI' : '✅ NON';
    console.log(`║ ${r.ia_name.padEnd(8)} ║ ${r.deployedV716.variant.padEnd(12)} ║ ${isM.padStart(7)} ║ ${oosM.padStart(7)} ║ ${degr.padStart(7)} ║ ${r.bestOos.variant.padEnd(12)} ║ ${status.padStart(8)} ║`);
  }
  console.log(`╚══════════╩══════════════╩═════════╩═════════╩═════════╩══════════════╩══════════╝`);

  // Recommandations
  const overfitCount = allResults.filter(r => r.overfit).length;
  if (overfitCount === 0) {
    console.log(`\n✅ VERDICT GLOBAL : Aucun overfit détecté. Les configs v7.16 sont robustes en OOS.\n`);
  } else {
    console.log(`\n⚠️  VERDICT GLOBAL : ${overfitCount}/${allResults.length} IA présentent un overfit. Configs à reconsidérer :\n`);
    for (const r of allResults.filter(r => r.overfit)) {
      console.log(`  - ${r.ia_name} : actuelle ${r.deployedV716.variant} (OOS ${r.deployedV716.oos.median}%) → recommandée ${r.bestOos.variant} (OOS ${r.bestOos.oos.median}%)`);
    }
    console.log('');
  }

  await fs.mkdir(path.join(process.cwd(), 'data', 'sandbox'), { recursive: true });
  await fs.writeFile(
    path.join(process.cwd(), 'data', 'sandbox', 'walkforward_isos.json'),
    JSON.stringify({
      generated: new Date().toISOString(),
      version: 'v7.17',
      protocol: { n_is_folds: N_IS_FOLDS, n_oos_folds: N_OOS_FOLDS, fold_days: FOLD_DAYS, slippage_pct: SLIPPAGE_PCT },
      results: allResults,
    }, null, 2) + '\n'
  );
  console.log(`✓ Résultats sauvegardés dans data/sandbox/walkforward_isos.json\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
