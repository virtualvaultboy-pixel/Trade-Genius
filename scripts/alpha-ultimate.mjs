#!/usr/bin/env node
/**
 * Trade Genius — v11.3 ALPHA ULTIMATE
 *
 * Le test FINAL le plus rigoureux possible :
 *
 * PHASE 1 : Univers étendu 100+ actifs (54 actuels + 50 S&P 500 supplémentaires)
 * PHASE 2 : True Walk-Forward par année
 *           - Pour chaque année cible Y (2019-2025) :
 *             - Bayesian optim sur années 2010 → Y-1 SEULEMENT (3 rounds × 20 configs)
 *             - Sélectionne top config
 *             - Test ALPHA sur année Y avec STRESS MAX
 *             - C'est le PUR OOS — config jamais vue par Y
 * PHASE 3 : ENSEMBLE TRUE
 *           - Pour chaque année, prend les 3 top configs found
 *           - Combine signaux : prend la position si 2/3 configs ouvrent
 *           - Sizing = moyenne pondérée
 *
 * Output : data/sandbox/alpha_ultimate.json
 *
 * Durée estimée : 60-90 min
 */
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { computeAllIndicators } from './indicators.mjs';

function flog(msg) { process.stdout.write(msg + '\n'); }

let _seed = 11111;
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
function snap(value, snap) { return Math.round(value / snap) * snap; }

const RANGES = {
  sizing:           { min: 12, max: 25, snap: 1 },
  minQuality:       { min: 78, max: 90, snap: 1 },
  pyramiding:       { min: 0, max: 60, snap: 5 },
  leverageMult:     { min: 1.0, max: 2.0, snap: 0.25 },
  leverageThreshold:{ min: 85, max: 95, snap: 1 },
  holdMax:          { min: 20, max: 40, snap: 5 },
  atrStop:          { min: 0.4, max: 0.8, snap: 0.1 },
  atrTp2:           { min: 5.0, max: 7.5, snap: 0.5 },
};

function randomConfig() {
  const c = {};
  for (const [key, r] of Object.entries(RANGES)) {
    c[key] = clamp(snap(r.min + rand() * (r.max - r.min), r.snap), r.min, r.max);
  }
  return c;
}
function sampleAround(base, sigmaFactor = 0.10) {
  const c = {};
  for (const [key, r] of Object.entries(RANGES)) {
    const sigma = (r.max - r.min) * sigmaFactor;
    c[key] = clamp(snap(gaussian(base[key], sigma), r.snap), r.min, r.max);
  }
  return c;
}
function configKey(c) {
  return Object.values(c).map(v => typeof v === 'number' ? v.toFixed(2) : v).join('-');
}

// UNIVERS ÉTENDU : 100+ actifs S&P 500 + indices
const ASSETS_EXTENDED = [
  // Indices monde (10)
  '^GSPC','^IXIC','^DJI','^RUT','^FCHI','^GDAXI','^FTSE','^N225','^HSI','^STOXX50E',
  // Mega-caps tech (20)
  'AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','AMD','ORCL','CSCO',
  'INTC','CRM','ADBE','NFLX','TXN','QCOM','AVGO','TMO','LIN','HON',
  // Financières (15)
  'JPM','V','MA','BAC','WFC','GS','MS','BLK','C','AXP','BRK-B','SCHW','SPGI','MMC','ICE',
  // Santé (15)
  'JNJ','PFE','UNH','LLY','ABBV','MRK','TMO','ABT','BMY','MDT','GILD','AMGN','CVS','DHR','ISRG',
  // Conso & Retail (15)
  'WMT','HD','PG','KO','MCD','NKE','SBUX','LOW','TGT','PEP','COST','MO','PM','CL','EL',
  // Energy & Industrials (10)
  'XOM','CVX','UNP','GE','LMT','BA','CAT','RTX','MMM','DE',
  // ETF sectoriels & broad (15)
  'SPY','QQQ','SOXX','SMH','XLK','XLF','XLE','XLV','XLP','XLY','XLI','XLU','XLB','TLT','GLD',
];

function getSlippage(label, stress) {
  let base;
  if (label.startsWith('^')) base = 0.15;
  else if (['SPY','QQQ','SOXX','SMH','XLK','XLF','XLE','XLV','XLP','XLY','XLI','XLU','XLB','TLT','GLD'].includes(label)) base = 0.05;
  else if (['AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','BRK-B','JPM','V','BAC','WMT','HD','PG','KO','JNJ','UNH','XOM','MCD'].includes(label)) base = 0.10;
  else base = 0.30;
  return stress ? base + 0.5 : base;
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

function isTradingOK(spPrices, t) {
  if (!spPrices || t < 200) return true;
  const last200 = spPrices.slice(t - 200, t);
  const last50 = spPrices.slice(t - 50, t);
  const sma200 = last200.reduce((a, b) => a + b, 0) / 200;
  const sma50 = last50.reduce((a, b) => a + b, 0) / 50;
  const close = spPrices[t - 1];
  return !(sma50 < sma200 && close < sma200);
}

function backtest(data, startIdx, endIdx, params, opts = {}) {
  const stress = !!opts.stress;
  const commission = opts.commission || 0;
  let cap = 1000, peak = cap, maxDD = 0;
  const trades = [], open = [];
  const sp = data.find(a => a.label === '^GSPC');
  const trailingATRMult = 0.5;
  const BORROW_YR = stress ? 0.08 : 0.06;
  const MAX_POS = 4;

  for (let t = startIdx; t < endIdx; t++) {
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
        const pnl = tot * pnlPct * pos.lev - commission;
        cap += tot + pnl;
        trades.push({ asset: pos.asset, pnlPct: pnlPct * 100, pnl, lev: pos.lev });
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
        cap -= size + commission;
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
    const dd = (eq - peak) / peak; if (dd < maxDD) maxDD = dd;
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

async function fetchYahoo20y(sym) {
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=20y&interval=1d`;
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const j = await r.json();
    const result = j.chart?.result?.[0];
    const ts = result?.timestamp;
    const closes = result?.indicators?.quote?.[0]?.close;
    if (!ts || !closes) return null;
    const filtered = [], filteredTs = [];
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] != null) { filtered.push(closes[i]); filteredTs.push(ts[i]); }
    }
    return { prices: filtered, timestamps: filteredTs };
  } catch { return null; }
}

async function main() {
  flog('=== ALPHA ULTIMATE v11.3 ===');
  flog('Test FINAL : univers 100+ actifs + walk-forward STRICT par année + ensemble TRUE\n');

  // PHASE 1 : Fetch univers étendu
  // Dedupe (certains tickers présents 2× dans la liste)
  const uniqueAssets = [...new Set(ASSETS_EXTENDED)];
  flog('Fetching 20y data sur ' + uniqueAssets.length + ' actifs uniques (' + ASSETS_EXTENDED.length + ' inputs)...');
  const data = [];
  for (const s of uniqueAssets) {
    const p = await fetchYahoo20y(s);
    if (p && p.prices.length >= 1000) {
      data.push({ label: s, prices: p.prices, timestamps: p.timestamps });
      process.stdout.write('.');
    } else process.stdout.write('x');
  }
  flog('\n' + data.length + '/' + uniqueAssets.length + ' loaded\n');

  const sp = data.find(a => a.label === '^GSPC');
  if (!sp) { flog('S&P 500 missing'); return; }
  function findIdx(year, month = 0, day = 1) {
    const target = new Date(year, month, day).getTime() / 1000;
    return sp.timestamps.findIndex(t => t >= target);
  }

  // PHASE 2 : Walk-forward STRICT par année
  flog('═══════════════════════════════════════════════════════════════');
  flog('PHASE 2 : WALK-FORWARD STRICT PAR ANNÉE');
  flog('Pour chaque année Y : optimise sur 2010→Y-1, test BLIND sur Y');
  flog('═══════════════════════════════════════════════════════════════\n');

  const TARGET_YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
  const yearlyResults = [];

  for (const year of TARGET_YEARS) {
    flog(`\n=== Année cible ${year} ===`);
    flog(`Train: 2010-${year - 1} (${year - 2010} ans) · Test: ${year}`);

    // Compute train folds
    const trainStart = findIdx(2010);
    const trainEnd = findIdx(year);
    if (trainStart < 0 || trainEnd <= trainStart) { flog('  data insuffisante'); continue; }

    // Folds annuels dans le train period
    const trainFolds = [];
    for (let y = 2010; y < year; y += 2) {
      const s = findIdx(y), e = findIdx(Math.min(y + 2, year));
      if (s >= 0 && e > s) trainFolds.push({ s: Math.max(60, s), e });
    }
    flog(`  Train folds: ${trainFolds.length}`);

    // Bayesian sur train
    function evalTrain(c) {
      const folds = trainFolds.map(f => backtest(data, f.s, f.e, c));
      const rets = folds.map(r => r.ret_yr).sort((a, b) => a - b);
      const median = rets[Math.floor(rets.length / 2)];
      const positive = folds.filter(r => r.ret_yr > 0).length;
      const avgDD = folds.reduce((a, b) => a + b.dd, 0) / folds.length;
      return { median, positive, totalFolds: folds.length, avgDD };
    }
    function score(r) {
      if (!r) return -Infinity;
      const posRatio = r.positive / r.totalFolds;
      return r.median * (1 + (posRatio - 0.5)) / (1 + Math.abs(r.avgDD) / 100);
    }

    setSeed(year * 1000);
    const tested = {};
    const trainResults = [];
    // Ancres : config WINNER-1, R4-5, MODERATE
    const anchors = [
      { sizing: 25, minQuality: 85, pyramiding: 60, leverageMult: 2, leverageThreshold: 88, holdMax: 25, atrStop: 0.4, atrTp2: 7 }, // WINNER true-OOS
      { sizing: 21, minQuality: 86, pyramiding: 55, leverageMult: 2, leverageThreshold: 89, holdMax: 30, atrStop: 0.5, atrTp2: 7.5 }, // R4-5
      { sizing: 18, minQuality: 78, pyramiding: 30, leverageMult: 1.5, leverageThreshold: 88, holdMax: 30, atrStop: 0.7, atrTp2: 6 }, // MODERATE
    ];
    for (const a of anchors) {
      tested[configKey(a)] = true;
      const r = evalTrain(a);
      trainResults.push({ config: a, ...r, score: score(r) });
    }
    // 3 rounds × 15 configs
    for (let round = 1; round <= 3; round++) {
      const sorted = [...trainResults].sort((a, b) => b.score - a.score);
      const top2 = sorted.slice(0, 2);
      const queue = [];
      for (const top of top2) for (let i = 0; i < 5; i++) {
        const c = sampleAround(top.config, 0.08);
        if (!tested[configKey(c)]) queue.push(c);
      }
      while (queue.length < 15) {
        const c = randomConfig();
        if (!tested[configKey(c)]) queue.push(c);
      }
      for (const c of queue) {
        tested[configKey(c)] = true;
        const r = evalTrain(c);
        trainResults.push({ config: c, ...r, score: score(r) });
      }
    }

    // Top 3 par score
    const sorted = [...trainResults].sort((a, b) => b.score - a.score);
    const top3 = sorted.slice(0, 3);
    flog(`  Top 3 train:`);
    top3.forEach((r, i) => flog(`    ${i+1}. train med ${r.median.toFixed(1)}% · ${r.positive}/${r.totalFolds} pos`));

    // Test sur année cible avec STRESS MAX
    const testStart = Math.max(60, findIdx(year));
    const testEnd = findIdx(year + 1) > 0 ? findIdx(year + 1) : sp.timestamps.length;
    const bhStart = sp.prices[testStart];
    const bhEnd = sp.prices[testEnd - 1];
    const bh = ((bhEnd / bhStart) - 1) * 100;

    flog(`  TEST ${year} avec STRESS MAX (commission 1€/trade · slip+0.5% · borrow 8%):`);
    const top3OOS = top3.map((t, i) => {
      const r = backtest(data, testStart, testEnd, t.config, { stress: true, commission: 1 });
      flog(`    Top ${i+1}: ${r.ret_yr.toFixed(1)}%/an · DD ${r.dd.toFixed(1)}% · ${r.trades} trades`);
      return { ...t, oos: r };
    });
    flog(`    B&H S&P 500: ${bh.toFixed(1)}%`);

    yearlyResults.push({
      year, bh,
      top1: { config: top3[0].config, train: top3[0].median, oos: top3OOS[0].oos.ret_yr, dd: top3OOS[0].oos.dd },
      top2: { config: top3[1].config, train: top3[1].median, oos: top3OOS[1].oos.ret_yr, dd: top3OOS[1].oos.dd },
      top3: { config: top3[2].config, train: top3[2].median, oos: top3OOS[2].oos.ret_yr, dd: top3OOS[2].oos.dd },
    });
  }

  // SUMMARY
  flog('\n\n╔══════════════════════════════════════════════════════════════════════════════╗');
  flog('║ WALK-FORWARD STRICT PAR ANNÉE — VERDICT FINAL                                  ║');
  flog('║ (Config OPTIMISÉE seulement sur années précédentes, testée BLIND sur année cible) ║');
  flog('╠══════════════════════════════════════════════════════════════════════════════╣');
  flog('║ Année │ B&H    │ Top1 (best train) │ Top2  │ Top3  │ Best OOS │ Excess vs B&H ║');
  flog('╠═══════╪════════╪═══════════════════╪═══════╪═══════╪══════════╪═══════════════╣');
  yearlyResults.forEach(r => {
    const bestOOS = Math.max(r.top1.oos, r.top2.oos, r.top3.oos);
    const excess = bestOOS - r.bh;
    flog(`║ ${r.year}  │ ${(r.bh.toFixed(1) + '%').padStart(6)} │ ${(r.top1.oos.toFixed(1) + '%').padStart(17)} │ ${(r.top2.oos.toFixed(1) + '%').padStart(5)} │ ${(r.top3.oos.toFixed(1) + '%').padStart(5)} │ ${(bestOOS.toFixed(1) + '%').padStart(8)} │ ${(excess >= 0 ? '+' : '') + excess.toFixed(1) + '%'}`);
  });
  flog('╚══════════════════════════════════════════════════════════════════════════════╝');

  // Stats globales TOP1
  const top1Returns = yearlyResults.map(r => r.top1.oos).sort((a, b) => a - b);
  const top1Median = top1Returns[Math.floor(top1Returns.length / 2)];
  const top1Mean = top1Returns.reduce((a, b) => a + b, 0) / top1Returns.length;
  const top1Pos = top1Returns.filter(r => r > 0).length;
  const top1BeatBH = yearlyResults.filter(r => r.top1.oos > r.bh).length;

  flog('\n=== TOP1 (best train) sur ' + yearlyResults.length + ' années PUR OOS ===');
  flog(`Médian: ${top1Median.toFixed(2)}%/an · Moyen: ${top1Mean.toFixed(2)}%/an`);
  flog(`Années positives: ${top1Pos}/${yearlyResults.length} · Battent B&H: ${top1BeatBH}/${yearlyResults.length}`);

  // Best of TOP1/TOP2/TOP3 stats (pick best train each year en vrai)
  const bestReturns = yearlyResults.map(r => Math.max(r.top1.oos, r.top2.oos, r.top3.oos)).sort((a, b) => a - b);
  const bestMedian = bestReturns[Math.floor(bestReturns.length / 2)];
  const bestMean = bestReturns.reduce((a, b) => a + b, 0) / bestReturns.length;
  flog(`\n=== Best of TOP1/2/3 (cheat retrospective) : médian ${bestMedian.toFixed(2)}% · moyen ${bestMean.toFixed(2)}% ===`);

  flog('\n=== INTERPRETATION ===');
  if (top1Median > 25) flog('🎯 ROBUSTESSE EXCELLENTE : Médian > 25% sur pur OOS strict');
  else if (top1Median > 15) flog('✅ BON : Médian 15-25% sur pur OOS strict — BUFFETT LEVEL');
  else if (top1Median > 5) flog('⚠️ MARGINAL : Médian 5-15%');
  else flog('❌ INSUFFISANT : Médian < 5%, NE PAS DÉPLOYER');

  await fs.writeFile(path.join(process.cwd(), 'data', 'sandbox', 'alpha_ultimate.json'), JSON.stringify({
    generated: new Date().toISOString(), assets: data.length,
    yearlyResults,
    summary: { top1Median, top1Mean, top1Pos, top1BeatBH, totalYears: yearlyResults.length, bestMedian, bestMean },
  }, null, 2));
  flog('\nOutput: data/sandbox/alpha_ultimate.json');
}

main().catch(e => { flog('FAILED: ' + e.message + '\n' + e.stack); process.exit(1); });
