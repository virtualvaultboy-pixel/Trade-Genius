#!/usr/bin/env node
/**
 * Trade Genius — v10.8 ALPHA TOP-3 DEEP VALIDATION
 *
 * Valide les 3 meilleures configs trouvées par master optimizer
 * sur 14 ans complets (vs 4.5 ans cache massive).
 *
 * TOP 3 du master :
 *   1. random-55 : siz=18% mQ=85 pyr=50% lev=1.75x@Q90 hold=30j atrS=0.5 atrTP2=7
 *      → 5 folds : 69.7%/an médian, DD -9.72%
 *   2. random-73 : siz=18% mQ=85 pyr=40% lev=1.75x@Q88 hold=35j atrS=0.6 atrTP2=7
 *      → 60.49%/an médian, DD -9.96%
 *   3. random-7 : siz=14% mQ=85 pyr=50% lev=2x@Q88 hold=20j atrS=0.5 atrTP2=7
 *      → 57.71%/an médian, DD -9.27%
 *
 * On les teste sur 14 folds × 1 an (14 ans, incluant bears).
 *
 * Output : data/sandbox/alpha_top3_deep.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { computeAllIndicators } from './indicators.mjs';

function flog(msg) { process.stdout.write(msg + '\n'); }

const TOP_CONFIGS = [
  { name: 'WINNER-1 (median 69.7%)', sizing: 18, minQuality: 85, pyramiding: 50, leverageMult: 1.75, leverageThreshold: 90, holdMax: 30, atrStop: 0.5, atrTp2: 7.0 },
  { name: 'RUNNER-2 (median 60.5%)', sizing: 18, minQuality: 85, pyramiding: 40, leverageMult: 1.75, leverageThreshold: 88, holdMax: 35, atrStop: 0.6, atrTp2: 7.0 },
  { name: 'RUNNER-3 (median 57.7%)', sizing: 14, minQuality: 85, pyramiding: 50, leverageMult: 2.0, leverageThreshold: 88, holdMax: 20, atrStop: 0.5, atrTp2: 7.0 },
  // Baseline pour comparaison
  { name: 'MODERATE-baseline (30.9%)', sizing: 18, minQuality: 78, pyramiding: 30, leverageMult: 1.5, leverageThreshold: 88, holdMax: 30, atrStop: 0.7, atrTp2: 6.0 },
];

// 50 actifs ROBUSTES (15y dispo)
const ASSETS_ROBUST = [
  '^GSPC','^IXIC','^DJI','^RUT','^FCHI','^GDAXI','^FTSE','^N225','^HSI','^STOXX50E',
  'AAPL','MSFT','GOOGL','AMZN','JPM','V','BAC','BRK-B','JNJ','PFE',
  'WMT','HD','PG','KO','MCD','XOM','CVX','UNH','META','NVDA',
  'TSLA','AMD','ORCL','CSCO','INTC','CRM','ADBE','NFLX','TXN','QCOM',
  'SPY','QQQ','SOXX','SMH','XLK','XLF','XLE','XLV','XLP','XLY','XLI','XLU','TLT','GLD',
];

function getSlippage(label) {
  if (label.startsWith('^')) return 0.15;
  const etfs = ['SPY','QQQ','SOXX','SMH','XLK','XLF','XLE','XLV','XLP','XLY','XLI','XLU','TLT','GLD'];
  if (etfs.includes(label)) return 0.05;
  const mega = ['AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','BRK-B','JPM','V','BAC','WMT','HD','PG','KO','JNJ','UNH','XOM','MCD'];
  if (mega.includes(label)) return 0.10;
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

function backtestFold(data, startIdx, endIdx, params) {
  let cap = 1000, peak = cap, maxDD = 0;
  const trades = [], open = [];
  const sp = data.find(a => a.label === '^GSPC');
  const trailingATRMult = 0.5;
  const BORROW_YR = 0.06;
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
  const wins = trades.filter(t => t.pnlPct > 0);
  const ret = (fin - 1000) / 1000 * 100;
  const yrs = (endIdx - startIdx) / 252;
  return {
    ret_yr: yrs > 0 ? Number((ret / yrs).toFixed(2)) : 0,
    dd: Number((maxDD * 100).toFixed(2)),
    wr: trades.length > 0 ? Number((wins.length / trades.length * 100).toFixed(1)) : 0,
    trades: trades.length,
  };
}

async function fetchYahoo15y(sym) {
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=15y&interval=1d`;
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const j = await r.json();
    const closes = j.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (!closes) return null;
    return closes.filter(c => c != null);
  } catch { return null; }
}

async function main() {
  flog('=== ALPHA TOP-3 DEEP VALIDATION ===');
  flog('Test sur 14 ans complets (vs 5 folds × 4.5 ans du master)');
  flog('Validation Medallion-grade : doit tenir >35%/an médian.\n');

  flog('Fetching 15y data sur ' + ASSETS_ROBUST.length + ' actifs...');
  const data = [];
  for (const s of ASSETS_ROBUST) {
    const p = await fetchYahoo15y(s);
    if (p && p.length >= 1000) { data.push({ label: s, prices: p }); process.stdout.write('.'); }
    else process.stdout.write('x');
  }
  flog('\n' + data.length + '/' + ASSETS_ROBUST.length + ' loaded\n');
  const minLen = Math.min(...data.map(a => a.prices.length));
  flog('Min days: ' + minLen + ' (' + (minLen / 252).toFixed(1) + ' ans)\n');

  const FOLD = 252;
  const WARMUP = 60;
  const folds = [];
  for (let i = 0; i < 14; i++) {
    const s = i * FOLD, e = Math.min(s + FOLD + WARMUP, minLen);
    if (e - s < 100) break;
    folds.push({ name: 'F' + (i + 1), s: Math.max(WARMUP, s), e });
  }
  flog('Folds: ' + folds.length + '\n');

  const allResults = [];
  for (const config of TOP_CONFIGS) {
    flog('=== ' + config.name + ' ===');
    flog('siz=' + config.sizing + '% mQ=' + config.minQuality + ' pyr=' + config.pyramiding + '% lev=' + config.leverageMult + 'x@Q' + config.leverageThreshold + ' hold=' + config.holdMax + 'j atrS=' + config.atrStop + ' atrTP2=' + config.atrTp2);
    const foldResults = [];
    const t0 = Date.now();
    for (const f of folds) {
      const r = backtestFold(data, f.s, f.e, config);
      foldResults.push({ ...f, ...r });
      flog('  ' + f.name + ': ' + r.ret_yr + '%/an · DD ' + r.dd + '% · WR ' + r.wr + '% (' + r.trades + ' tr)');
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const rets = foldResults.map(r => r.ret_yr).sort((a, b) => a - b);
    const median = rets[Math.floor(rets.length / 2)];
    const worst = rets[0];
    const best = rets[rets.length - 1];
    const avgDD = foldResults.reduce((a, b) => a + b.dd, 0) / foldResults.length;
    const positive = foldResults.filter(r => r.ret_yr > 0).length;
    const totalTrades = foldResults.reduce((a, b) => a + b.trades, 0);
    const calmar = avgDD < 0 ? Number((median / Math.abs(avgDD)).toFixed(2)) : 0;
    flog('  ─── SUMMARY ───');
    flog('  Médian: ' + median + '%/an · Worst: ' + worst + '%/an · Best: ' + best + '%/an');
    flog('  DD moy: ' + avgDD.toFixed(2) + '% · Calmar: ' + calmar);
    flog('  Folds positifs: ' + positive + '/' + foldResults.length + ' · Trades: ' + totalTrades + ' · time: ' + elapsed + 's\n');
    allResults.push({
      config, median, worst, best, avgDD, positive, total_folds: foldResults.length,
      totalTrades, calmar, folds: foldResults,
    });
  }

  // Top
  const sorted = [...allResults].sort((a, b) => b.median - a.median);
  flog('╔══════════════════════════════════════════════════════════════════════════╗');
  flog('║ DEEP VALIDATION 14 ANS — VERDICT FINAL                                   ║');
  flog('╠══════════════════════════════════════════════════════════════════════════╣');
  sorted.forEach((r, i) => {
    const star = r.median > 35 ? '🎯' : (r.median > 25 ? '✅' : (r.median > 15 ? '⚠️' : '❌'));
    flog(`║ ${star} ${r.config.name.padEnd(28)} med ${(r.median+'%').padStart(7)}/an · DD ${(r.avgDD.toFixed(2)+'%').padStart(7)} · ${r.positive}/${r.total_folds}`);
  });
  flog('╚══════════════════════════════════════════════════════════════════════════╝');

  await fs.writeFile(path.join(process.cwd(), 'data', 'sandbox', 'alpha_top3_deep.json'), JSON.stringify({
    generated: new Date().toISOString(), assets: data.length, folds: folds.length,
    results: allResults,
  }, null, 2));
  flog('\nOutput: data/sandbox/alpha_top3_deep.json');
}

main().catch(e => { flog('FAILED: ' + e.message); process.exit(1); });
