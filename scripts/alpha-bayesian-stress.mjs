#!/usr/bin/env node
/**
 * Trade Genius — v10.9 ALPHA BAYESIAN + STRESS
 *
 * 2 missions parallèles :
 *
 * A) BAYESIAN OPTIMIZATION (TPE simplified)
 *    - Round 1 : 30 configs autour des ANCRES connues (WINNER-1, MODERATE...)
 *    - Round 2-5 : 20 configs autour des TOP 5 de chaque round (exploitation)
 *    - + 10 random pure (exploration)
 *    - Total : ~150 configs intelligemment échantillonnées
 *
 * B) STRESS TEST BRUTAL des TOP 5 finaux
 *    Conditions adverses :
 *    - Slippage 1.0% (vs 0.15% nominal) → simule small-cap
 *    - Gap d'ouverture ±1% gaussien
 *    - Borrow 8%/an (vs 6%)
 *    - Bootstrap 10 subsets de 35 actifs (vs 54 complets)
 *    - Monte-Carlo : shuffle ordre trades 200×
 *
 * Verdict final : WINNER-1 vraiment robuste ou overfit ?
 *
 * Estimation : ~30-45 min total.
 */
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { computeAllIndicators } from './indicators.mjs';

const CACHE_PATH = path.join(process.cwd(), 'data', 'sandbox', '_cache_massive.json');

function flog(msg) { process.stdout.write(msg + '\n'); }

// Mulberry32 seedable RNG
let _seed = 7777;
function setSeed(s) { _seed = s; }
function rand() {
  _seed |= 0; _seed = _seed + 0x6D2B79F5 | 0;
  let t = Math.imul(_seed ^ _seed >>> 15, 1 | _seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}
function gaussian(mu, sigma) {
  const u1 = Math.max(0.001, rand()), u2 = rand();
  return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
function clamp(x, min, max) { return Math.max(min, Math.min(max, x)); }
function pickN(arr, n) {
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(rand() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

// Dimensions continues pour Bayesian
const RANGES = {
  sizing:           { min: 10, max: 28, snap: 1 },
  minQuality:       { min: 70, max: 90, snap: 1 },
  pyramiding:       { min: 0, max: 60, snap: 5 },
  leverageMult:     { min: 1.0, max: 2.0, snap: 0.25 },
  leverageThreshold:{ min: 80, max: 95, snap: 1 },
  holdMax:          { min: 15, max: 45, snap: 5 },
  atrStop:          { min: 0.4, max: 0.9, snap: 0.1 },
  atrTp2:           { min: 4.5, max: 8.0, snap: 0.5 },
};

function snap(value, snap) {
  return Math.round(value / snap) * snap;
}

function randomConfig() {
  const c = {};
  for (const [key, r] of Object.entries(RANGES)) {
    c[key] = snap(r.min + rand() * (r.max - r.min), r.snap);
    c[key] = clamp(c[key], r.min, r.max);
  }
  return c;
}

// Sample autour d'un point (TPE-like)
function sampleAround(baseConfig, sigmaFactor = 0.15) {
  const c = {};
  for (const [key, r] of Object.entries(RANGES)) {
    const sigma = (r.max - r.min) * sigmaFactor;
    c[key] = snap(gaussian(baseConfig[key], sigma), r.snap);
    c[key] = clamp(c[key], r.min, r.max);
  }
  return c;
}

function configKey(c) {
  return Object.values(c).map(v => typeof v === 'number' ? v.toFixed(2) : v).join('-');
}

// Configs ANCRES validées
const ANCHORS = [
  { name: 'WINNER-1', sizing: 18, minQuality: 85, pyramiding: 50, leverageMult: 1.75, leverageThreshold: 90, holdMax: 30, atrStop: 0.5, atrTp2: 7.0 },
  { name: 'RUNNER-2', sizing: 18, minQuality: 85, pyramiding: 40, leverageMult: 1.75, leverageThreshold: 88, holdMax: 35, atrStop: 0.6, atrTp2: 7.0 },
  { name: 'RUNNER-3', sizing: 14, minQuality: 85, pyramiding: 50, leverageMult: 2.0, leverageThreshold: 88, holdMax: 20, atrStop: 0.5, atrTp2: 7.0 },
  { name: 'MODERATE', sizing: 18, minQuality: 78, pyramiding: 30, leverageMult: 1.5, leverageThreshold: 88, holdMax: 30, atrStop: 0.7, atrTp2: 6.0 },
];

// Score Bayesian = médian × (1 + bonus robustesse) / (1 + |DD|)
function bayesianScore(r) {
  const positiveRatio = r.positive / r.total_folds;
  const robustBonus = positiveRatio >= 1 ? 0.5 : positiveRatio - 1;
  const ddPenalty = Math.abs(r.avgDD);
  return r.median * (1 + robustBonus) / (1 + ddPenalty / 100);
}

// Slippage selon mode (nominal ou stress)
function getSlippage(label, stress) {
  if (stress) return 1.0; // STRESS uniforme
  if (label.startsWith('^') || label.startsWith('S&P') || label.startsWith('Nasdaq') || label.startsWith('Dow')) return 0.15;
  const etfs = ['XLK','XLF','XLE','XLV','XLP','XLY','XLI','XLU','XLB','XLC','XLRE','SOXX','SMH','SPY','QQQ','TLT','GLD'];
  if (etfs.some(e => label.includes(e))) return 0.05;
  const mega = ['Apple','Microsoft','Alphabet','Amazon','Meta','Nvidia','Tesla','Berkshire','JPMorgan','Visa','Walmart','J&J','Coca-Cola','McDonald','Exxon'];
  if (mega.includes(label)) return 0.10;
  return 0.30;
}

function gapNoise(seed, vol) {
  const u1 = ((seed*9301+49297) % 233280) / 233280;
  const u2 = (((seed+1)*9301+49297) % 233280) / 233280;
  return Math.sqrt(-2*Math.log(Math.max(0.001,u1))) * Math.cos(2*Math.PI*u2) * vol;
}

function _build(close, atrAbs, q, p, atrStop, atrTp2) {
  const entry = close, stop = entry - atrStop * atrAbs;
  const tp1 = entry + (atrTp2 / 2) * atrAbs, tp2 = entry + atrTp2 * atrAbs;
  if (stop >= entry || tp2 <= entry) return null;
  if ((tp2 - entry) / (entry - stop) < 1.8) return null;
  return { entry, stop, tp1, tp2, atrAbs, quality: Math.round(q), pattern: p };
}

function detect(prices, atrStop, atrTp2) {
  if (prices.length < 60) return [];
  const ind = computeAllIndicators(prices);
  if (!ind?.rsi || !ind?.boll || !ind?.atr) return [];
  const rsi = ind.rsi.value, boll = ind.boll.value;
  const close = prices[prices.length - 1];
  const atrAbs = ind.atr.value * close / 100;
  const out = [];
  if (rsi < 22 && boll < 0.20 && ind.adx && ind.adx.value > 20) {
    const q = 75 + (22 - rsi) * 1.5 + (0.20 - boll) * 50;
    const s = _build(close, atrAbs, q, 'A', atrStop, atrTp2); if (s) out.push(s);
  }
  if (ind.adx && ind.macd && rsi >= 38 && rsi <= 55 && ind.adx.value >= 30 &&
      ind.macd.value < -0.3 && boll >= 0.30 && boll <= 0.70) {
    const q = 78 + Math.min(15, ind.adx.value - 30) + Math.min(8, 50 - rsi);
    const s = _build(close, atrAbs, q, 'B', atrStop, atrTp2); if (s) out.push(s);
  }
  if (ind.ichimoku && rsi >= 40 && rsi <= 50 && boll < 0.25 &&
      ind.ichimoku.position === 'above-cloud' && ind.ichimoku.signal === 'bull' &&
      ind.adx && ind.adx.value > 22) {
    const q = 80 + Math.min(12, 50 - rsi) + (0.25 - boll) * 50;
    const s = _build(close, atrAbs, q, 'C', atrStop, atrTp2); if (s) out.push(s);
  }
  return out;
}

function isTradingOK(sp500Prices, t) {
  if (!sp500Prices || t < 200) return true;
  const last200 = sp500Prices.slice(t - 200, t);
  const last50 = sp500Prices.slice(t - 50, t);
  const sma200 = last200.reduce((a, b) => a + b, 0) / 200;
  const sma50 = last50.reduce((a, b) => a + b, 0) / 50;
  const close = sp500Prices[t - 1];
  if (sma50 < sma200 && close < sma200) return false;
  return true;
}

function backtestFold(data, startIdx, endIdx, params, opts = {}) {
  const stress = !!opts.stress;
  const gapVol = opts.gapVol || 0;
  const borrowYr = opts.borrowYr || 0.06;
  const TIMEOUT = 60000;
  const tStart = Date.now();
  let cap = 1000, peak = cap, maxDD = 0;
  const trades = [], open = [];
  const sp = data.find(a => a.label === 'S&P 500' || a.label === '^GSPC');
  const trailingATRMult = 0.5;
  const MAX_POS = 4;

  for (let t = startIdx; t < endIdx; t++) {
    if (Date.now() - tStart > TIMEOUT) return null;
    for (const p of open) if (p.lev > 1) cap -= p.size * (p.lev - 1) * (borrowYr / 252);
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i], a = data.find(x => x.label === pos.asset);
      if (!a || t >= a.prices.length) { open.splice(i, 1); continue; }
      const priceToday = a.prices[t] * (1 + (gapVol > 0 ? gapNoise(t*1000+i, gapVol) : 0));
      pos.days++;
      if (priceToday > pos.hse) pos.hse = priceToday;
      if (!pos.tp1H && priceToday >= pos.tp1) { pos.tp1H = true; pos.stop = pos.entry; }
      if (pos.tp1H) { const ns = pos.hse - trailingATRMult * pos.atrAbs; if (ns > pos.stop) pos.stop = ns; }
      if (params.pyramiding > 0 && pos.tp1H && !pos.added && priceToday >= pos.tp1) {
        const add = Math.min(pos.size * params.pyramiding / 100, cap * 0.95);
        if (add > 0) { pos.added = true; pos.addedSize = add; cap -= add; }
      }
      const hS = priceToday <= pos.stop, hT = priceToday >= pos.tp2, to = pos.days >= params.holdMax;
      if (hS || hT || to) {
        let ex = hT ? pos.tp2 : (hS ? pos.stop : priceToday);
        ex *= (1 - pos.slippage / 100);
        const pnlPct = (ex - pos.entry) / pos.entry;
        const tot = pos.size + (pos.addedSize || 0);
        const pnl = tot * pnlPct * pos.lev;
        cap += tot + pnl;
        trades.push({ pnlPct: pnlPct * 100, pnl, lev: pos.lev });
        open.splice(i, 1);
      }
    }
    const tradingOK = sp ? isTradingOK(sp.prices, t) : true;
    if (tradingOK && open.length < MAX_POS) {
      const cands = [];
      for (const a of data) {
        if (t >= a.prices.length || open.some(p => p.asset === a.label)) continue;
        for (const s of detect(a.prices.slice(0, t + 1), params.atrStop, params.atrTp2)) {
          if (s.quality >= params.minQuality) cands.push({ a, s });
        }
      }
      cands.sort((x, y) => y.s.quality - x.s.quality);
      for (let i = 0; i < Math.min(MAX_POS - open.length, cands.length); i++) {
        const c = cands[i], size = cap * params.sizing / 100;
        if (size < 1 || cap < size * 1.1) continue;
        const slippage = getSlippage(c.a.label, stress);
        const lev = (c.s.quality >= params.leverageThreshold) ? params.leverageMult : 1;
        cap -= size;
        open.push({
          asset: c.a.label, entry: c.s.entry * (1 + slippage / 100),
          stop: c.s.stop, tp1: c.s.tp1, tp2: c.s.tp2, atrAbs: c.s.atrAbs,
          hse: c.s.entry, days: 0, size, addedSize: 0, lev,
          tp1H: false, added: false, slippage,
        });
      }
    }
    const eq = cap + open.reduce((acc, p) => {
      const a = data.find(x => x.label === p.asset);
      const pr = a?.prices[t] || p.entry;
      const tot = p.size + (p.addedSize || 0);
      return acc + tot * (1 + ((pr - p.entry) / p.entry) * p.lev);
    }, 0);
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  const fin = cap + open.reduce((acc, p) => {
    const a = data.find(x => x.label === p.asset);
    const pr = a?.prices[endIdx - 1] || p.entry;
    const tot = p.size + (p.addedSize || 0);
    return acc + tot * (1 + ((pr - p.entry) / p.entry) * p.lev);
  }, 0);
  const ret = (fin - 1000) / 1000 * 100;
  const yrs = (endIdx - startIdx) / 252;
  return {
    ret_yr: yrs > 0 ? ret / yrs : 0,
    dd: maxDD * 100,
    trades: trades.length,
    pnls: trades.map(t => t.pnl),
  };
}

function evalConfig(data, folds, config, opts = {}) {
  const foldResults = [];
  for (const f of folds) {
    const r = backtestFold(data, f.s, f.e, config, opts);
    if (!r) return null;
    foldResults.push(r);
  }
  const rets = foldResults.map(r => r.ret_yr).sort((a, b) => a - b);
  const median = rets[Math.floor(rets.length / 2)];
  const worst = rets[0];
  const best = rets[rets.length - 1];
  const avgDD = foldResults.reduce((a, b) => a + b.dd, 0) / foldResults.length;
  const positive = foldResults.filter(r => r.ret_yr > 0).length;
  const totalTrades = foldResults.reduce((a, b) => a + b.trades, 0);
  return {
    median: Number(median.toFixed(2)),
    worst: Number(worst.toFixed(2)),
    best: Number(best.toFixed(2)),
    avgDD: Number(avgDD.toFixed(2)),
    positive, total_folds: foldResults.length, totalTrades,
    calmar: avgDD < 0 ? Number((median / Math.abs(avgDD)).toFixed(2)) : 0,
  };
}

// Bootstrap : prend N actifs aléatoires parmi le dataset
function bootstrapAssets(data, n, seed) {
  setSeed(seed);
  return pickN(data, n);
}

// Monte-Carlo trades shuffle
function monteCarloTrades(allPnls, runs = 200) {
  if (allPnls.length < 20) return null;
  const returns = [];
  for (let r = 0; r < runs; r++) {
    setSeed(r * 1000 + 7);
    const arr = [...allPnls];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    let eq = 1000, peak = 1000, dd = 0;
    for (const pnl of arr) {
      eq += pnl;
      if (eq > peak) peak = eq;
      if ((eq - peak) / peak < dd) dd = (eq - peak) / peak;
    }
    const totalRet = (eq - 1000) / 1000 * 100;
    returns.push({ ret: totalRet, dd: dd * 100 });
  }
  returns.sort((a, b) => a.ret - b.ret);
  return {
    p5: returns[Math.floor(runs * 0.05)].ret,
    p50: returns[Math.floor(runs * 0.50)].ret,
    p95: returns[Math.floor(runs * 0.95)].ret,
    worst_dd: Math.min(...returns.map(r => r.dd)),
  };
}

async function main() {
  flog('=== ALPHA BAYESIAN + STRESS v10.9 ===\n');
  if (!existsSync(CACHE_PATH)) { flog('ERREUR cache massive manquant'); return; }
  const data = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  flog('Cache: ' + data.length + ' actifs');
  const minLen = Math.min(...data.map(a => a.prices.length));
  flog('Min days: ' + minLen + ' (' + (minLen/252).toFixed(1) + ' ans)\n');

  const FOLD = 252, WARMUP = 60;
  const folds = [];
  for (let i = 0; i < 5; i++) {
    const s = i * FOLD, e = Math.min(s + FOLD + WARMUP, minLen);
    if (e - s < 100) break;
    folds.push({ s: Math.max(WARMUP, s), e });
  }
  flog('Folds: ' + folds.length + '\n');

  // ─────────────────────────────────────────────────
  // PHASE A : BAYESIAN OPTIMIZATION (5 rounds)
  // ─────────────────────────────────────────────────
  flog('═══════════════════════════════════════════════════════════════');
  flog('PHASE A : BAYESIAN OPTIMIZATION (5 rounds × 30 configs)');
  flog('═══════════════════════════════════════════════════════════════\n');

  setSeed(42);
  const tested = {};
  const allResults = [];

  // Round 0 : ancres
  flog('Round 0 : ANCRES validées');
  for (const anchor of ANCHORS) {
    const k = configKey(anchor);
    if (tested[k]) continue;
    tested[k] = true;
    const r = evalConfig(data, folds, anchor);
    if (r) {
      const score = bayesianScore(r);
      allResults.push({ name: anchor.name, config: anchor, ...r, score });
      flog(`  ${anchor.name}: med ${r.median}% · worst ${r.worst}% · DD ${r.avgDD}% · score ${score.toFixed(1)}`);
    }
  }

  // Round 1-5
  for (let round = 1; round <= 5; round++) {
    flog(`\nRound ${round} : 30 configs (20 around top-5 + 10 random)`);
    const sorted = [...allResults].sort((a, b) => b.score - a.score);
    const top5 = sorted.slice(0, 5);
    const newQueue = [];
    // 20 around top 5 (4 each)
    for (const top of top5) {
      for (let i = 0; i < 4; i++) {
        const c = sampleAround(top.config, 0.10);
        const k = configKey(c);
        if (!tested[k] && !newQueue.some(q => configKey(q) === k)) newQueue.push(c);
      }
    }
    // 10 random pure
    while (newQueue.length < 30) {
      const c = randomConfig();
      const k = configKey(c);
      if (!tested[k] && !newQueue.some(q => configKey(q) === k)) newQueue.push(c);
    }
    const tRound = Date.now();
    let bestThisRound = { median: -Infinity };
    for (let i = 0; i < newQueue.length; i++) {
      const c = newQueue[i];
      const k = configKey(c);
      tested[k] = true;
      const r = evalConfig(data, folds, c);
      if (!r) continue;
      const score = bayesianScore(r);
      const entry = { name: `R${round}-${i}`, config: c, ...r, score };
      allResults.push(entry);
      if (r.median > bestThisRound.median) bestThisRound = entry;
    }
    const elapsed = Math.round((Date.now() - tRound) / 1000);
    flog(`  Best round ${round}: med ${bestThisRound.median}% · worst ${bestThisRound.worst}% · DD ${bestThisRound.avgDD}% (${elapsed}s)`);
    // Save checkpoint
    await fs.writeFile(path.join(process.cwd(), 'data', 'sandbox', 'alpha_bayesian.json'), JSON.stringify({
      round, total_tested: allResults.length,
      top_10: [...allResults].sort((a, b) => b.score - a.score).slice(0, 10),
    }, null, 2));
  }

  // ─────────────────────────────────────────────────
  // PHASE B : STRESS TEST TOP 5
  // ─────────────────────────────────────────────────
  flog('\n\n═══════════════════════════════════════════════════════════════');
  flog('PHASE B : STRESS BRUTAL TOP 5 (slippage 1%, gap 1%, borrow 8%)');
  flog('═══════════════════════════════════════════════════════════════\n');

  const sortedBaysian = [...allResults].sort((a, b) => b.score - a.score);
  const top5 = sortedBaysian.slice(0, 5);

  const stressResults = [];
  for (const t of top5) {
    flog(`Testing ${t.name} (nominal med ${t.median}%):`);
    // Stress 1 : slippage 1%
    const s1 = evalConfig(data, folds, t.config, { stress: true });
    flog(`  Slippage 1%        : med ${s1?.median}% · DD ${s1?.avgDD}% · ${s1?.positive}/${s1?.total_folds}`);
    // Stress 2 : gap ±1%
    const s2 = evalConfig(data, folds, t.config, { gapVol: 0.01 });
    flog(`  Gap ±1%            : med ${s2?.median}% · DD ${s2?.avgDD}% · ${s2?.positive}/${s2?.total_folds}`);
    // Stress 3 : borrow 8%
    const s3 = evalConfig(data, folds, t.config, { borrowYr: 0.08 });
    flog(`  Borrow 8%          : med ${s3?.median}% · DD ${s3?.avgDD}% · ${s3?.positive}/${s3?.total_folds}`);
    // Stress 4 : all combined
    const s4 = evalConfig(data, folds, t.config, { stress: true, gapVol: 0.01, borrowYr: 0.08 });
    flog(`  ALL stress combined: med ${s4?.median}% · DD ${s4?.avgDD}% · ${s4?.positive}/${s4?.total_folds}`);
    // Stress 5 : bootstrap 5 subsets × 35 actifs
    flog(`  Bootstrap 5 subsets:`);
    const bootMedians = [];
    for (let b = 0; b < 5; b++) {
      const subset = bootstrapAssets(data, 35, b * 1000 + 1);
      const sb = evalConfig(subset, folds, t.config);
      if (sb) { bootMedians.push(sb.median); flog(`    Boot ${b+1}: med ${sb.median}% · ${sb.positive}/${sb.total_folds}`); }
    }
    const bootMean = bootMedians.length ? bootMedians.reduce((a,b)=>a+b,0) / bootMedians.length : 0;
    flog(`    Mean bootstrap: ${bootMean.toFixed(1)}%`);
    stressResults.push({
      ...t, stress_slip: s1, stress_gap: s2, stress_borrow: s3, stress_all: s4,
      bootstrap_medians: bootMedians, bootstrap_mean: Number(bootMean.toFixed(2)),
    });
    flog('');
  }

  // ─────────────────────────────────────────────────
  // VERDICT FINAL
  // ─────────────────────────────────────────────────
  flog('\n╔════════════════════════════════════════════════════════════════════════════╗');
  flog('║ VERDICT FINAL — TOP 5 sous toutes conditions adverses                       ║');
  flog('╠════════════════════════════════════════════════════════════════════════════╣');
  flog('║ Config       │ Nominal │ Slip1% │ Gap1% │ Bor8% │ ALL    │ Bootstrap        ║');
  flog('╠══════════════╪═════════╪════════╪═══════╪═══════╪════════╪══════════════════╣');
  for (const r of stressResults) {
    flog(`║ ${r.name.padEnd(12)} │ ${(r.median + '%').padStart(7)} │ ${((r.stress_slip?.median || 0) + '%').padStart(6)} │ ${((r.stress_gap?.median || 0) + '%').padStart(5)} │ ${((r.stress_borrow?.median || 0) + '%').padStart(5)} │ ${((r.stress_all?.median || 0) + '%').padStart(6)} │ ${(r.bootstrap_mean + '%').padStart(16)} ║`);
  }
  flog('╚════════════════════════════════════════════════════════════════════════════╝');

  // Recommandation
  flog('\n=== RECOMMANDATION ===');
  const robust = stressResults.filter(r => {
    return r.stress_all?.median >= 15 && r.bootstrap_mean >= 15;
  });
  if (robust.length > 0) {
    const top = robust.sort((a, b) => b.stress_all.median - a.stress_all.median)[0];
    flog(`✅ DÉPLOYABLE : ${top.name}`);
    flog(`   Nominal: ${top.median}% · Sous tous stress: ${top.stress_all.median}% · Bootstrap: ${top.bootstrap_mean}%`);
    flog(`   Config: ${JSON.stringify(top.config)}`);
  } else {
    flog(`⚠️ AUCUN config robuste sous tous les stress.`);
    flog(`   Le meilleur médian sous ALL stress: ${stressResults.sort((a,b)=>(b.stress_all?.median||-Infinity)-(a.stress_all?.median||-Infinity))[0]?.stress_all?.median}%`);
  }

  await fs.writeFile(path.join(process.cwd(), 'data', 'sandbox', 'alpha_bayesian_stress.json'), JSON.stringify({
    generated: new Date().toISOString(),
    bayesian_top_10: sortedBaysian.slice(0, 10),
    stress_results: stressResults,
  }, null, 2));
  flog('\nOutput: data/sandbox/alpha_bayesian_stress.json');
}

main().catch(e => { flog('FAILED: ' + e.message + '\n' + e.stack); process.exit(1); });
