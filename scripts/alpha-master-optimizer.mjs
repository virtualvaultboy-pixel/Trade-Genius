#!/usr/bin/env node
/**
 * Trade Genius — v10.7 ALPHA MASTER OPTIMIZER
 *
 * Reprend TOUS les enseignements précédents pour pousser ALPHA au max.
 *
 * Innovations vs grid précédent (qui s'est bloqué) :
 *   - Checkpoint JSON tous les 5 configs (résistant aux crashes)
 *   - Logs flushés immédiatement (stdout sync)
 *   - Timeout 90s par fold (skip si bloqué)
 *   - Random sampling 100 configs (au lieu d'exhaustif 320)
 *   - Recovery : skip les configs déjà testées
 *   - Univers 70+ actifs (cache massive existant)
 *
 * Baseline à battre : ALPHA MODERATE = 30.9%/an médian.
 *
 * Cible : 35-45%/an médian si tous les folds restent positifs.
 */
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { computeAllIndicators } from './indicators.mjs';

const CHECKPOINT = path.join(process.cwd(), 'data', 'sandbox', 'alpha_master_optimizer.json');
const CACHE_MASSIVE = path.join(process.cwd(), 'data', 'sandbox', '_cache_massive.json');

// Force flush stdout
function flog(msg) {
  process.stdout.write(msg + '\n');
}

// Seed-deterministic Random (Mulberry32)
let _seed = 42;
function rand() {
  _seed |= 0; _seed = _seed + 0x6D2B79F5 | 0;
  let t = Math.imul(_seed ^ _seed >>> 15, 1 | _seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }

// Dimensions du grid (random sampling)
const DIMS = {
  sizing:           [14, 16, 18, 20, 22, 25],
  minQuality:       [72, 75, 78, 80, 82, 85],
  pyramiding:       [0, 20, 30, 40, 50],
  leverageMult:     [1.0, 1.25, 1.5, 1.75, 2.0],
  leverageThreshold:[85, 88, 90, 92, 95],
  holdMax:          [20, 25, 30, 35],
  atrStop:          [0.5, 0.6, 0.7, 0.8],
  atrTp2:           [5.0, 5.5, 6.0, 6.5, 7.0],
};

function randomConfig() {
  return {
    sizing: pick(DIMS.sizing),
    minQuality: pick(DIMS.minQuality),
    pyramiding: pick(DIMS.pyramiding),
    leverageMult: pick(DIMS.leverageMult),
    leverageThreshold: pick(DIMS.leverageThreshold),
    holdMax: pick(DIMS.holdMax),
    atrStop: pick(DIMS.atrStop),
    atrTp2: pick(DIMS.atrTp2),
  };
}

function configKey(c) {
  return [c.sizing, c.minQuality, c.pyramiding, c.leverageMult, c.leverageThreshold, c.holdMax, c.atrStop, c.atrTp2].join('-');
}

// Configs candidates ANCRES : on commence par tester les configs DÉJÀ validées
const ANCHOR_CONFIGS = [
  // MODERATE baseline (30.9%/an validé)
  { sizing: 18, minQuality: 78, pyramiding: 30, leverageMult: 1.5, leverageThreshold: 88, holdMax: 30, atrStop: 0.7, atrTp2: 6.0, name: 'MODERATE-baseline' },
  // SELECTIVE baseline (6.32%/an validé, ultra robuste)
  { sizing: 12, minQuality: 85, pyramiding: 0, leverageMult: 1.0, leverageThreshold: 999, holdMax: 30, atrStop: 0.7, atrTp2: 6.0, name: 'SELECTIVE-baseline' },
  // Variantes MODERATE+ (relax modéré)
  { sizing: 20, minQuality: 75, pyramiding: 40, leverageMult: 1.5, leverageThreshold: 88, holdMax: 30, atrStop: 0.7, atrTp2: 6.0, name: 'MODERATE+size' },
  { sizing: 18, minQuality: 78, pyramiding: 50, leverageMult: 1.7, leverageThreshold: 88, holdMax: 30, atrStop: 0.7, atrTp2: 6.0, name: 'MODERATE+pyr+lev' },
  { sizing: 22, minQuality: 80, pyramiding: 30, leverageMult: 1.5, leverageThreshold: 90, holdMax: 30, atrStop: 0.7, atrTp2: 6.0, name: 'MODERATE+concentration' },
  // Variantes patterns plus sélectifs
  { sizing: 18, minQuality: 82, pyramiding: 30, leverageMult: 1.5, leverageThreshold: 88, holdMax: 35, atrStop: 0.6, atrTp2: 7.0, name: 'WIDE-TP-tight-stop' },
  // Variantes WIDE
  { sizing: 18, minQuality: 78, pyramiding: 30, leverageMult: 1.5, leverageThreshold: 88, holdMax: 35, atrStop: 0.8, atrTp2: 7.0, name: 'WIDE-everything' },
  // Variantes leverage agressif (mais minQ haute)
  { sizing: 16, minQuality: 82, pyramiding: 30, leverageMult: 2.0, leverageThreshold: 88, holdMax: 30, atrStop: 0.7, atrTp2: 6.0, name: 'AGGRESSIVE-lev' },
];

function getSlippage(label) {
  if (label.startsWith('^')) return 0.15;
  const etfs = ['SPY ETF','QQQ ETF','SOXX','SMH','XLK','XLF','XLE','XLV','XLP','XLY','XLI','XLU','TLT','GLD'];
  if (etfs.some(e => label.includes(e.replace(' ETF', '')))) return 0.05;
  const mega = ['Apple','Microsoft','Alphabet','Amazon','Meta','Nvidia','Tesla','Berkshire','JPMorgan','Visa','Walmart','J&J','Coca-Cola','McDonald','Exxon'];
  if (mega.includes(label)) return 0.10;
  if (label.includes('loser')) return 1.5;
  return 0.30;
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

function backtestFold(data, startIdx, endIdx, params, spLabel) {
  const TIMEOUT_MS = 60000; // 60s par fold
  const t0 = Date.now();
  let cap = 1000, peak = cap, maxDD = 0;
  const trades = [], open = [];
  const sp = data.find(a => a.label === spLabel);
  const trailingATRMult = 0.5;
  const BORROW_YR = 0.06;

  for (let t = startIdx; t < endIdx; t++) {
    if (Date.now() - t0 > TIMEOUT_MS) return null; // timeout
    for (const p of open) if (p.lev > 1) cap -= p.size * (p.lev - 1) * (BORROW_YR / 252);
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i], a = data.find(x => x.label === pos.asset);
      if (!a || t >= a.prices.length) { open.splice(i, 1); continue; }
      const priceToday = a.prices[t];
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
    if (tradingOK && open.length < 4) {
      const cands = [];
      for (const a of data) {
        if (t >= a.prices.length || open.some(p => p.asset === a.label)) continue;
        for (const s of detect(a.prices.slice(0, t + 1), params.atrStop, params.atrTp2)) {
          if (s.quality >= params.minQuality) cands.push({ a, s });
        }
      }
      cands.sort((x, y) => y.s.quality - x.s.quality);
      for (let i = 0; i < Math.min(4 - open.length, cands.length); i++) {
        const c = cands[i], size = cap * params.sizing / 100;
        if (size < 1 || cap < size * 1.1) continue;
        const slippage = getSlippage(c.a.label);
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
  };
}

async function main() {
  flog('=== ALPHA MASTER OPTIMIZER v10.7 ===');
  flog('Reprend tous les enseignements précédents.');
  flog('Random sampling 100 configs autour des ANCRES validées.\n');

  if (!existsSync(CACHE_MASSIVE)) {
    flog('ERREUR: cache massive introuvable. Run alpha-stress-massive.mjs avant.');
    return;
  }
  const data = JSON.parse(readFileSync(CACHE_MASSIVE, 'utf8'));
  flog('Cache: ' + data.length + ' actifs chargés');
  const minLen = Math.min(...data.map(a => a.prices.length));
  flog('Min days: ' + minLen + ' (' + (minLen / 252).toFixed(1) + ' ans)\n');

  const FOLD = 252;
  const WARMUP = 60;
  const folds = [];
  for (let i = 0; i < 14; i++) {
    const s = i * FOLD, e = Math.min(s + FOLD + WARMUP, minLen);
    if (e - s < 100) break;
    folds.push({ s: Math.max(WARMUP, s), e });
  }
  flog('Folds: ' + folds.length);

  // Identify S&P 500 label (depends on cache format)
  const spLabel = data.some(a => a.label === 'S&P 500') ? 'S&P 500' : '^GSPC';
  flog('S&P label: ' + spLabel + '\n');

  // Load checkpoint
  let testedConfigs = {};
  let allResults = [];
  if (existsSync(CHECKPOINT)) {
    try {
      const cp = JSON.parse(readFileSync(CHECKPOINT, 'utf8'));
      if (cp.results) {
        allResults = cp.results;
        for (const r of allResults) testedConfigs[r.key] = true;
        flog('Checkpoint loaded: ' + allResults.length + ' configs déjà testées\n');
      }
    } catch (e) { flog('Checkpoint corrompu, on reprend de zéro'); }
  }

  // Build queue: anchors first, then random
  const queue = [];
  for (const anchor of ANCHOR_CONFIGS) {
    const k = configKey(anchor);
    if (!testedConfigs[k]) queue.push({ ...anchor, key: k });
  }
  // Add 100 random configs
  while (queue.length < 100) {
    const c = randomConfig();
    const k = configKey(c);
    if (!testedConfigs[k] && !queue.some(q => q.key === k)) {
      queue.push({ ...c, name: 'random-' + queue.length, key: k });
    }
  }
  flog('Queue: ' + queue.length + ' configs à tester (+ ' + allResults.length + ' déjà fait)\n');

  // Test each config
  let count = 0;
  const tStart = Date.now();
  for (const config of queue) {
    count++;
    const tConfig = Date.now();
    const foldResults = [];
    let skipped = false;
    for (let f = 0; f < folds.length; f++) {
      const r = backtestFold(data, folds[f].s, folds[f].e, config, spLabel);
      if (!r) { skipped = true; break; }
      foldResults.push(r);
    }
    if (skipped) {
      flog(`  ${count}/${queue.length} ${config.name || 'random'}: SKIPPED (timeout)`);
      continue;
    }
    const rets = foldResults.map(r => r.ret_yr).sort((a, b) => a - b);
    const median = rets[Math.floor(rets.length / 2)];
    const worst = rets[0];
    const best = rets[rets.length - 1];
    const avgDD = foldResults.reduce((a, b) => a + b.dd, 0) / foldResults.length;
    const positive = foldResults.filter(r => r.ret_yr > 0).length;
    const totalTrades = foldResults.reduce((a, b) => a + b.trades, 0);
    const calmar = avgDD < 0 ? median / Math.abs(avgDD) : 0;
    const elapsed = ((Date.now() - tConfig) / 1000).toFixed(1);
    const totalElapsed = Math.round((Date.now() - tStart) / 1000);
    flog(`  ${count}/${queue.length} ${config.name || 'cfg'}: med ${median.toFixed(1)}% · worst ${worst.toFixed(1)}% · DD ${avgDD.toFixed(1)}% · ${positive}/${folds.length} pos · Calmar ${calmar.toFixed(2)} · ${totalTrades} tr · ${elapsed}s (total ${totalElapsed}s)`);
    allResults.push({
      key: config.key, name: config.name, config,
      median: Number(median.toFixed(2)),
      worst: Number(worst.toFixed(2)),
      best: Number(best.toFixed(2)),
      avgDD: Number(avgDD.toFixed(2)),
      positive, total_folds: folds.length,
      totalTrades, calmar: Number(calmar.toFixed(2)),
      time_s: Number(elapsed),
    });
    // CHECKPOINT tous les 5 results
    if (count % 5 === 0 || count === queue.length) {
      const robust = allResults.filter(r => r.worst > 5 && r.avgDD > -10 && r.positive === r.total_folds);
      const sorted = robust.sort((a, b) => b.median - a.median);
      await fs.writeFile(CHECKPOINT, JSON.stringify({
        generated: new Date().toISOString(),
        progress: count + '/' + queue.length,
        elapsed_seconds: totalElapsed,
        total_results: allResults.length,
        robust_count: robust.length,
        top_10: sorted.slice(0, 10),
        results: allResults,
      }, null, 2));
      flog(`  ✓ checkpoint saved (${allResults.length} configs total)`);
    }
  }

  // Final report
  const robust = allResults.filter(r => r.worst > 5 && r.avgDD > -10 && r.positive === r.total_folds);
  const sorted = robust.sort((a, b) => b.median - a.median);

  flog('\n=== TOP 10 CONFIGS ROBUSTES (worst>5%, DD>-10%, all positifs) ===');
  flog('Total robustes: ' + robust.length + '/' + allResults.length);
  sorted.slice(0, 10).forEach((r, i) => {
    flog(`${i + 1}. ${r.name || 'cfg'}: med ${r.median}% · worst ${r.worst}% · DD ${r.avgDD}% · Calmar ${r.calmar}`);
    flog(`    siz=${r.config.sizing}% mQ=${r.config.minQuality} pyr=${r.config.pyramiding}% levMult=${r.config.leverageMult}x@Q${r.config.leverageThreshold} hold=${r.config.holdMax}j atrS=${r.config.atrStop} atrTP2=${r.config.atrTp2}`);
  });
}

main().catch(e => { flog('FAILED: ' + e.message); process.exit(1); });
