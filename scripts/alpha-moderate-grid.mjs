#!/usr/bin/env node
/**
 * Trade Genius — v10.6 ALPHA MODERATE GRID-SEARCH
 *
 * MODERATE de base = 30.9%/an médian. On cherche à pousser plus haut
 * sans casser la robustesse (DD <5%, 12/12 folds positifs).
 *
 * Grid sur 4 dimensions :
 *   - sizing : 14/16/18/20/22%
 *   - minQuality : 72/75/78/82
 *   - pyramiding : 20/30/40/50%
 *   - leverageThreshold : 85/88/92/95
 *
 * 5 × 4 × 4 × 4 = 320 combinaisons × 14 folds × ~5s = ~7h.
 * Limite à 80 combinaisons les plus prometteuses (Latin Hypercube sampling).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { computeAllIndicators } from './indicators.mjs';

const FIXED = {
  atrStop: 0.7, atrTp2: 6.0, holdMax: 30,
  maxPos: 4,
  leverageMult: 1.5,
  trailingATRMult: 0.5,
  BORROW_YR: 0.06,
  WARMUP: 60,
};

function getSlippage(label) {
  if (label.startsWith('^')) return 0.15;
  const etfs = ['SPY','QQQ','SOXX','SMH','XLK','XLF','XLE','XLV','XLP','XLY','XLI','XLU','TLT','GLD'];
  if (etfs.includes(label)) return 0.05;
  const mega = ['AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','BRK-B','JPM','V','BAC','WMT','HD','PG','KO','JNJ','UNH','XOM','MCD'];
  if (mega.includes(label)) return 0.10;
  return 0.30;
}

const ASSETS = [
  '^GSPC','^IXIC','^DJI','^RUT','^FCHI','^GDAXI','^FTSE','^N225','^HSI','^STOXX50E',
  'AAPL','MSFT','GOOGL','AMZN','JPM','V','BAC','BRK-B','JNJ','PFE',
  'WMT','HD','PG','KO','MCD','XOM','CVX','UNH','META','NVDA',
  'TSLA','AMD','ORCL','CSCO','INTC','CRM','ADBE','NFLX','TXN','QCOM',
  'SPY','QQQ','SOXX','SMH','XLK','XLF','XLE','XLV','XLP','XLY','XLI','XLU','TLT','GLD',
];

function _build(close, atrAbs, q, p) {
  const entry = close, stop = entry - FIXED.atrStop * atrAbs;
  const tp1 = entry + (FIXED.atrTp2 / 2) * atrAbs, tp2 = entry + FIXED.atrTp2 * atrAbs;
  if (stop >= entry || tp2 <= entry) return null;
  if ((tp2 - entry) / (entry - stop) < 1.8) return null;
  return { entry, stop, tp1, tp2, atrAbs, quality: Math.round(q), pattern: p };
}

function detect(prices) {
  if (prices.length < 60) return [];
  const ind = computeAllIndicators(prices);
  if (!ind?.rsi || !ind?.boll || !ind?.atr) return [];
  const rsi = ind.rsi.value, boll = ind.boll.value;
  const close = prices[prices.length - 1];
  const atrAbs = ind.atr.value * close / 100;
  const out = [];
  if (rsi < 22 && boll < 0.20 && ind.adx && ind.adx.value > 20) {
    const q = 75 + (22 - rsi) * 1.5 + (0.20 - boll) * 50;
    const s = _build(close, atrAbs, q, 'A'); if (s) out.push(s);
  }
  if (ind.adx && ind.macd && rsi >= 38 && rsi <= 55 && ind.adx.value >= 30 &&
      ind.macd.value < -0.3 && boll >= 0.30 && boll <= 0.70) {
    const q = 78 + Math.min(15, ind.adx.value - 30) + Math.min(8, 50 - rsi);
    const s = _build(close, atrAbs, q, 'B'); if (s) out.push(s);
  }
  if (ind.ichimoku && rsi >= 40 && rsi <= 50 && boll < 0.25 &&
      ind.ichimoku.position === 'above-cloud' && ind.ichimoku.signal === 'bull' &&
      ind.adx && ind.adx.value > 22) {
    const q = 80 + Math.min(12, 50 - rsi) + (0.25 - boll) * 50;
    const s = _build(close, atrAbs, q, 'C'); if (s) out.push(s);
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

function backtest(data, startIdx, endIdx, params) {
  let cap = 1000, peak = cap, maxDD = 0;
  const trades = [], open = [];
  const sp = data.find(a => a.label === '^GSPC');

  for (let t = startIdx; t < endIdx; t++) {
    for (const p of open) if (p.lev > 1) cap -= p.size * (p.lev - 1) * (FIXED.BORROW_YR / 252);
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i], a = data.find(x => x.label === pos.asset);
      if (!a || t >= a.prices.length) { open.splice(i, 1); continue; }
      const priceToday = a.prices[t];
      pos.days++;
      if (priceToday > pos.hse) pos.hse = priceToday;
      if (!pos.tp1H && priceToday >= pos.tp1) { pos.tp1H = true; pos.stop = pos.entry; }
      if (pos.tp1H) { const ns = pos.hse - FIXED.trailingATRMult * pos.atrAbs; if (ns > pos.stop) pos.stop = ns; }
      if (params.pyramiding > 0 && pos.tp1H && !pos.added && priceToday >= pos.tp1) {
        const add = Math.min(pos.size * params.pyramiding/100, cap*0.95);
        if (add > 0) { pos.added = true; pos.addedSize = add; cap -= add; }
      }
      const hS = priceToday <= pos.stop, hT = priceToday >= pos.tp2, to = pos.days >= FIXED.holdMax;
      if (hS || hT || to) {
        let ex = hT ? pos.tp2 : (hS ? pos.stop : priceToday);
        ex *= (1 - pos.slippage / 100);
        const pnlPct = (ex - pos.entry) / pos.entry;
        const tot = pos.size + (pos.addedSize || 0);
        const pnl = tot * pnlPct * pos.lev;
        cap += tot + pnl;
        trades.push({ pnlPct: pnlPct*100, pnl, lev: pos.lev });
        open.splice(i, 1);
      }
    }
    const tradingOK = sp ? isTradingOK(sp.prices, t) : true;
    if (tradingOK && open.length < FIXED.maxPos) {
      const cands = [];
      for (const a of data) {
        if (t >= a.prices.length || open.some(p => p.asset === a.label)) continue;
        for (const s of detect(a.prices.slice(0, t+1))) if (s.quality >= params.minQuality) cands.push({ a, s });
      }
      cands.sort((x,y) => y.s.quality - x.s.quality);
      for (let i = 0; i < Math.min(FIXED.maxPos - open.length, cands.length); i++) {
        const c = cands[i], size = cap * params.sizing/100;
        if (size < 1 || cap < size*1.1) continue;
        const slippage = getSlippage(c.a.label);
        const lev = (c.s.quality >= params.leverageThreshold) ? FIXED.leverageMult : 1;
        cap -= size;
        open.push({
          asset: c.a.label,
          entry: c.s.entry*(1+slippage/100), stop: c.s.stop, tp1: c.s.tp1, tp2: c.s.tp2,
          atrAbs: c.s.atrAbs, hse: c.s.entry, days: 0, size, addedSize: 0, lev,
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
    const pr = a?.prices[endIdx-1] || p.entry;
    const tot = p.size + (p.addedSize || 0);
    return acc + tot * (1 + ((pr - p.entry) / p.entry) * p.lev);
  }, 0);
  const ret = (fin - 1000) / 1000 * 100;
  const yrs = (endIdx - startIdx) / 252;
  return {
    ret_yr: yrs > 0 ? ret/yrs : 0,
    dd: maxDD * 100,
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
  console.log('=== ALPHA MODERATE GRID-SEARCH ===');
  console.log('Fetching 15y...');
  const data = [];
  for (const s of ASSETS) {
    const p = await fetchYahoo15y(s);
    if (p && p.length >= 1000) { data.push({ label: s, prices: p }); process.stdout.write('.'); }
    else process.stdout.write('x');
  }
  console.log('\n' + data.length + '/' + ASSETS.length + ' loaded\n');
  const minLen = Math.min(...data.map(a => a.prices.length));
  const FOLD = 252;
  const folds = [];
  for (let i = 0; i < 14; i++) {
    const s = i * FOLD, e = Math.min(s + FOLD + FIXED.WARMUP, minLen);
    if (e - s < 100) break;
    folds.push({ s: Math.max(FIXED.WARMUP, s), e });
  }
  console.log('Folds:', folds.length, '\n');

  const SIZING = [14, 16, 18, 20, 22];
  const MIN_Q = [72, 75, 78, 82];
  const PYRAMID = [20, 30, 40, 50];
  const LEV_TH = [85, 88, 92, 95];
  const total = SIZING.length * MIN_Q.length * PYRAMID.length * LEV_TH.length;
  console.log('Grid:', total, 'combinations × ' + folds.length + ' folds = ' + (total * folds.length) + ' backtests\n');

  const results = [];
  let count = 0;
  const t0 = Date.now();
  for (const sizing of SIZING) {
    for (const minQuality of MIN_Q) {
      for (const pyramiding of PYRAMID) {
        for (const leverageThreshold of LEV_TH) {
          count++;
          const params = { sizing, minQuality, pyramiding, leverageThreshold };
          const foldResults = folds.map(f => backtest(data, f.s, f.e, params));
          const rets = foldResults.map(r => r.ret_yr).sort((a, b) => a - b);
          const median = rets[Math.floor(rets.length / 2)];
          const worst = rets[0];
          const avgDD = foldResults.reduce((a, b) => a + b.dd, 0) / foldResults.length;
          const positive = foldResults.filter(r => r.ret_yr > 0).length;
          const totalTrades = foldResults.reduce((a, b) => a + b.trades, 0);
          results.push({
            params, median: Number(median.toFixed(2)),
            worst: Number(worst.toFixed(2)),
            avgDD: Number(avgDD.toFixed(2)),
            positive, totalFolds: foldResults.length,
            totalTrades, calmar: avgDD < 0 ? Number((median / Math.abs(avgDD)).toFixed(2)) : 0,
          });
          if (count % 20 === 0) {
            const elapsed = (Date.now() - t0) / 1000;
            const eta = (elapsed / count) * (total - count);
            console.log('  ' + count + '/' + total + ' done (ETA ' + Math.round(eta) + 's)');
          }
        }
      }
    }
  }

  // Filtre : on ne garde que configs robustes (worst > 5%, DD > -10%, 14/14 positifs)
  const robust = results.filter(r => r.worst > 5 && r.avgDD > -10 && r.positive === r.totalFolds);
  const sorted = robust.sort((a, b) => b.median - a.median);

  console.log('\n=== TOP 15 CONFIGS ROBUSTES (worst>5%, DD>-10%, 14/14 positifs) ===');
  console.log('Total robustes: ' + robust.length + '/' + results.length);
  sorted.slice(0, 15).forEach((r, i) => {
    console.log((i+1) + '. siz=' + r.params.sizing + '% mQ=' + r.params.minQuality + ' pyr=' + r.params.pyramiding + '% lev@' + r.params.leverageThreshold +
      ' → médian ' + r.median + '% · worst ' + r.worst + '% · DD ' + r.avgDD + '% · Calmar ' + r.calmar + ' (' + r.totalTrades + ' tr)');
  });

  await fs.writeFile(path.join(process.cwd(), 'data', 'sandbox', 'alpha_moderate_grid.json'), JSON.stringify({
    generated: new Date().toISOString(), total_combos: total, robust_combos: robust.length,
    top_20: sorted.slice(0, 20), all_results: results,
  }, null, 2));
  console.log('\nOutput: data/sandbox/alpha_moderate_grid.json');
}

main().catch(e => { console.error('failed:', e); process.exit(1); });
