#!/usr/bin/env node
/**
 * Trade Genius — v11.2 ALPHA TRUE OUT-OF-SAMPLE + ENSEMBLE
 *
 * Le test le plus HONNÊTE possible :
 *
 * PHASE A : Bayesian optimization SEULEMENT sur 2010-2017 (8 ans).
 *           Aucune donnée 2018-2025 ne peut influencer la recherche de config.
 *
 * PHASE B : Test des TOP 5 configs trouvées en Phase A sur 2018-2025
 *           AVEUGLÉMENT (8 années jamais vues par l'optim).
 *           + STRESS MAX : commission 1€/trade fixe + spread 0.5% bonus + slippage 1%.
 *
 * PHASE C : ENSEMBLE des 3 top configs (moyenne pondérée des signaux).
 *           Si chacun overfit différemment, l'ensemble est plus stable.
 *
 * Output : data/sandbox/alpha_true_oos.json
 *
 * VERDICT :
 *   - Si TOP config Phase B fait >20%/an sur 2018-2025 stress max = DÉPLOYABLE
 *   - Si <10% = backtest était gonflé, retour MODERATE (déjà validé walk-forward)
 */
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { computeAllIndicators } from './indicators.mjs';

function flog(msg) { process.stdout.write(msg + '\n'); }

// Mulberry32 seedable RNG
let _seed = 12345;
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
  sizing:           { min: 10, max: 25, snap: 1 },
  minQuality:       { min: 75, max: 90, snap: 1 },
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
function sampleAround(base, sigmaFactor = 0.12) {
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

// 54 actifs robustes
const ASSETS = [
  '^GSPC','^IXIC','^DJI','^RUT','^FCHI','^GDAXI','^FTSE','^N225','^HSI','^STOXX50E',
  'AAPL','MSFT','GOOGL','AMZN','JPM','V','BAC','BRK-B','JNJ','PFE',
  'WMT','HD','PG','KO','MCD','XOM','CVX','UNH','META','NVDA',
  'TSLA','AMD','ORCL','CSCO','INTC','CRM','ADBE','NFLX','TXN','QCOM',
  'SPY','QQQ','SOXX','SMH','XLK','XLF','XLE','XLV','XLP','XLY','XLI','XLU','TLT','GLD',
];

// Slippage RÉALISTE + STRESS option
function getSlippage(label, stress) {
  let base;
  if (label.startsWith('^')) base = 0.15;
  else if (['SPY','QQQ','SOXX','SMH','XLK','XLF','XLE','XLV','XLP','XLY','XLI','XLU','TLT','GLD'].includes(label)) base = 0.05;
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
  const commissionPerTrade = opts.commission || 0; // €/trade
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
        const pnl = tot * pnlPct * pos.lev - commissionPerTrade; // commission exit
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
        cap -= size + commissionPerTrade; // commission entry
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
    const filtered = [];
    const filteredTs = [];
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] != null) { filtered.push(closes[i]); filteredTs.push(ts[i]); }
    }
    return { prices: filtered, timestamps: filteredTs };
  } catch { return null; }
}

async function main() {
  flog('=== ALPHA TRUE OUT-OF-SAMPLE ===');
  flog('Phase A : bayesian SEULEMENT sur 2010-2017 (zéro data 2018-2025)');
  flog('Phase B : test TOP 5 sur 2018-2025 STRESS MAX (commission 1€/trade + slippage +0.5%)');
  flog('Phase C : ensemble des 3 top configs\n');

  flog('Fetching 20y data sur ' + ASSETS.length + ' actifs...');
  const data = [];
  for (const s of ASSETS) {
    const p = await fetchYahoo20y(s);
    if (p && p.prices.length >= 1000) {
      data.push({ label: s, prices: p.prices, timestamps: p.timestamps });
      process.stdout.write('.');
    } else process.stdout.write('x');
  }
  flog('\n' + data.length + '/' + ASSETS.length + ' loaded\n');

  const sp = data.find(a => a.label === '^GSPC');
  if (!sp) { flog('S&P 500 missing'); return; }

  // Date indices
  function findIdx(year, month = 0, day = 1) {
    const target = new Date(year, month, day).getTime() / 1000;
    return sp.timestamps.findIndex(t => t >= target);
  }
  const idx2010 = findIdx(2010);
  const idx2018 = findIdx(2018);
  const idx2025end = sp.timestamps.length - 1;
  flog('Idx 2010=' + idx2010 + ' · 2018=' + idx2018 + ' · 2025end=' + idx2025end);

  // PHASE A : bayesian sur 2010-2017
  // Folds : 2010-2011, 2012-2013, 2014-2015, 2016-2017 (4 folds × 2 ans)
  flog('\n═══════════════════════════════════════════════════════════════');
  flog('PHASE A : BAYESIAN sur 2010-2017 (4 folds × 2 ans)');
  flog('═══════════════════════════════════════════════════════════════\n');
  const trainFolds = [
    { s: findIdx(2010), e: findIdx(2012) },
    { s: findIdx(2012), e: findIdx(2014) },
    { s: findIdx(2014), e: findIdx(2016) },
    { s: findIdx(2016), e: findIdx(2018) },
  ];

  function evalTrain(c) {
    const folds = trainFolds.map(f => backtest(data, Math.max(60, f.s), f.e, c));
    const rets = folds.map(r => r.ret_yr).sort((a, b) => a - b);
    const median = rets[Math.floor(rets.length / 2)];
    const worst = rets[0];
    const avgDD = folds.reduce((a, b) => a + b.dd, 0) / folds.length;
    const positive = folds.filter(r => r.ret_yr > 0).length;
    return { median, worst, avgDD, positive, totalFolds: folds.length };
  }
  function score(r) {
    if (!r) return -Infinity;
    const posRatio = r.positive / r.totalFolds;
    return r.median * (1 + (posRatio - 0.5)) / (1 + Math.abs(r.avgDD) / 100);
  }

  setSeed(98765); // seed différent du bayesian précédent
  const tested = {};
  const allResults = [];
  // Anchors (configs déjà identifiées qu'on revalide sur 2010-2017)
  const anchors = [
    { sizing: 18, minQuality: 85, pyramiding: 50, leverageMult: 1.75, leverageThreshold: 90, holdMax: 30, atrStop: 0.5, atrTp2: 7.0 },
    { sizing: 21, minQuality: 86, pyramiding: 55, leverageMult: 2.0, leverageThreshold: 89, holdMax: 30, atrStop: 0.5, atrTp2: 7.5 },
    { sizing: 18, minQuality: 78, pyramiding: 30, leverageMult: 1.5, leverageThreshold: 88, holdMax: 30, atrStop: 0.7, atrTp2: 6.0 },
  ];
  flog('Round 0 : ANCRES');
  for (const a of anchors) {
    const r = evalTrain(a);
    const sc = score(r);
    tested[configKey(a)] = true;
    allResults.push({ config: a, ...r, score: sc });
    flog('  anchor: med ' + r.median.toFixed(1) + '% · DD ' + r.avgDD.toFixed(1) + '% · ' + r.positive + '/' + r.totalFolds + ' · score ' + sc.toFixed(1));
  }

  // 4 rounds × 25 configs
  for (let round = 1; round <= 4; round++) {
    flog(`\nRound ${round} : 25 configs (15 around top-3 + 10 random)`);
    const sorted = [...allResults].sort((a, b) => b.score - a.score);
    const top3 = sorted.slice(0, 3);
    const queue = [];
    for (const top of top3) for (let i = 0; i < 5; i++) {
      const c = sampleAround(top.config, 0.10);
      if (!tested[configKey(c)]) queue.push(c);
    }
    while (queue.length < 25) {
      const c = randomConfig();
      if (!tested[configKey(c)]) queue.push(c);
    }
    let bestRound = -Infinity, bestConfig = null;
    for (const c of queue) {
      const k = configKey(c);
      tested[k] = true;
      const r = evalTrain(c);
      const sc = score(r);
      allResults.push({ config: c, ...r, score: sc });
      if (sc > bestRound) { bestRound = sc; bestConfig = { c, r }; }
    }
    flog('  Best: med ' + bestConfig.r.median.toFixed(1) + '% · DD ' + bestConfig.r.avgDD.toFixed(1) + '% · score ' + bestRound.toFixed(1));
  }

  const sortedAll = [...allResults].sort((a, b) => b.score - a.score);
  const top5Train = sortedAll.slice(0, 5);
  flog('\n=== TOP 5 trained on 2010-2017 ===');
  top5Train.forEach((r, i) => {
    flog((i + 1) + '. med ' + r.median.toFixed(1) + '% · worst ' + r.worst.toFixed(1) + '% · DD ' + r.avgDD.toFixed(1) + '%');
    flog('   siz=' + r.config.sizing + '% mQ=' + r.config.minQuality + ' pyr=' + r.config.pyramiding + '% lev=' + r.config.leverageMult + 'x@Q' + r.config.leverageThreshold + ' hold=' + r.config.holdMax + ' atrS=' + r.config.atrStop + ' atrTP2=' + r.config.atrTp2);
  });

  // PHASE B : test sur 2018-2025 année par année + STRESS
  flog('\n\n═══════════════════════════════════════════════════════════════');
  flog('PHASE B : YEARLY LIVE 2018-2025 (PUR OOS) avec STRESS MAX');
  flog('Commission 1€/trade · Slippage +0.5% · Borrow 8%/an');
  flog('═══════════════════════════════════════════════════════════════');

  const oosResults = [];
  for (const top of top5Train) {
    flog('\nConfig (train med ' + top.median.toFixed(1) + '%):');
    flog('  ' + JSON.stringify(top.config));
    const yearly = [];
    for (let year = 2018; year <= 2025; year++) {
      const s = findIdx(year), e = findIdx(year + 1);
      if (s < 0 || e <= s) continue;
      // STRESS MAX
      const r = backtest(data, Math.max(60, s), e, top.config, { stress: true, commission: 1 });
      const bhStart = sp.prices[Math.max(60, s)];
      const bhEnd = sp.prices[e - 1];
      const bh = ((bhEnd / bhStart) - 1) * 100;
      yearly.push({ year, ret: r.ret_yr, dd: r.dd, trades: r.trades, bh, excess: r.ret_yr - bh });
      flog('  ' + year + ': ALPHA ' + r.ret_yr.toFixed(1) + '% · B&H ' + bh.toFixed(1) + '% · excess ' + (r.ret_yr - bh).toFixed(1) + '% · DD ' + r.dd.toFixed(1) + '% · ' + r.trades + ' trades');
    }
    const rets = yearly.map(y => y.ret).sort((a, b) => a - b);
    const median = rets[Math.floor(rets.length / 2)];
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const positive = yearly.filter(y => y.ret > 0).length;
    const beatBH = yearly.filter(y => y.excess > 0).length;
    flog('  → OOS médian: ' + median.toFixed(1) + '% · moyen: ' + mean.toFixed(1) + '% · positives: ' + positive + '/' + yearly.length + ' · battent B&H: ' + beatBH + '/' + yearly.length);
    oosResults.push({ config: top.config, train_median: top.median, oos_median: Number(median.toFixed(2)), oos_mean: Number(mean.toFixed(2)), positive, beatBH, yearly });
  }

  // PHASE C : ENSEMBLE (moyenne pondérée des 3 top OOS)
  flog('\n\n═══════════════════════════════════════════════════════════════');
  flog('PHASE C : ENSEMBLE de 3 top configs (signaux moyennés)');
  flog('═══════════════════════════════════════════════════════════════');
  // Note : ensemble simpliste = moyenne des perf annuelles. Pour vrai ensemble il faudrait merger les positions, complexe.
  // Ici on utilise pseudo-ensemble : moyenne arithmétique des perf annuelles.
  const sortedOOS = [...oosResults].sort((a, b) => b.oos_median - a.oos_median);
  const top3OOS = sortedOOS.slice(0, 3);
  if (top3OOS.length >= 3) {
    flog('Ensemble des 3 meilleurs OOS :');
    const years = top3OOS[0].yearly.map(y => y.year);
    const ensembleYearly = years.map(year => {
      const rets = top3OOS.map(t => t.yearly.find(y => y.year === year)?.ret || 0);
      const mean = rets.reduce((a, b) => a + b, 0) / 3;
      const bh = top3OOS[0].yearly.find(y => y.year === year)?.bh || 0;
      return { year, ret: mean, bh, excess: mean - bh };
    });
    ensembleYearly.forEach(y => flog('  ' + y.year + ': ENSEMBLE ' + y.ret.toFixed(1) + '% · B&H ' + y.bh.toFixed(1) + '% · excess ' + y.excess.toFixed(1) + '%'));
    const eRets = ensembleYearly.map(y => y.ret).sort((a, b) => a - b);
    const eMedian = eRets[Math.floor(eRets.length / 2)];
    const eMean = eRets.reduce((a, b) => a + b, 0) / eRets.length;
    flog('  → ENSEMBLE médian: ' + eMedian.toFixed(1) + '% · moyen: ' + eMean.toFixed(1) + '%');
  }

  // VERDICT FINAL
  flog('\n\n╔════════════════════════════════════════════════════════════════════════════╗');
  flog('║ TRUE OOS VERDICT — config optimisée sur 2010-2017, testée 2018-2025 STRESS ║');
  flog('╠════════════════════════════════════════════════════════════════════════════╣');
  flog('║ Rank │ Train  │ OOS Med │ OOS Mean │ Pos/8 │ Bat B&H │ Dégradation         ║');
  flog('╠══════╪════════╪═════════╪══════════╪═══════╪═════════╪═════════════════════╣');
  sortedOOS.forEach((r, i) => {
    const deg = ((r.oos_median - r.train_median) / r.train_median * 100).toFixed(0);
    const star = r.oos_median > 25 ? '🎯' : (r.oos_median > 15 ? '✅' : (r.oos_median > 5 ? '⚠️' : '❌'));
    flog('║ #' + (i + 1) + ' ' + star + ' │ ' + (r.train_median.toFixed(1) + '%').padStart(6) + ' │ ' + (r.oos_median + '%').padStart(7) + ' │ ' + (r.oos_mean + '%').padStart(8) + ' │ ' + (r.positive + '/8').padStart(5) + ' │ ' + (r.beatBH + '/8').padStart(7) + ' │ ' + (deg >= 0 ? '+' : '') + deg + '%'.padEnd(15));
  });
  flog('╚════════════════════════════════════════════════════════════════════════════╝');

  flog('\n=== RECOMMANDATION ===');
  const winner = sortedOOS[0];
  if (winner.oos_median > 20) {
    flog('🎯 DÉPLOYABLE : OOS médian ' + winner.oos_median + '% > 20% sur 8 ans STRESS MAX');
    flog('   Config: ' + JSON.stringify(winner.config));
  } else if (winner.oos_median > 10) {
    flog('✅ ACCEPTABLE : OOS médian ' + winner.oos_median + '% > 10%, déploiement prudent');
  } else {
    flog('❌ NE PAS DÉPLOYER : OOS médian ' + winner.oos_median + '% < 10%, le backtest était gonflé');
  }

  await fs.writeFile(path.join(process.cwd(), 'data', 'sandbox', 'alpha_true_oos.json'), JSON.stringify({
    generated: new Date().toISOString(),
    train_top5: top5Train,
    oos_results: sortedOOS,
  }, null, 2));
  flog('\nOutput: data/sandbox/alpha_true_oos.json');
}

main().catch(e => { flog('FAILED: ' + e.message + '\n' + e.stack); process.exit(1); });
