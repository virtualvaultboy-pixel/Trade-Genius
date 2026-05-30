#!/usr/bin/env node
/**
 * Trade Genius — v10.5 ALPHA MODERATE
 *
 * Sweet spot entre SELECTIVE (6.32% médian, ultra défensif) et ALPHA (mirage).
 * Relaxe les filtres MODÉRÉMENT et augmente la concentration sur best trades.
 *
 * Différences vs SELECTIVE :
 *   - sizing 18% (vs 12%) — concentration
 *   - minQuality 78 (vs 85) — accepter quelques bons trades
 *   - pyramiding 30% — utiliser quand TP1 touché
 *   - leverage 1.5x sur Q>=88 — bonus modéré
 *   - maxPos 4 (vs 3)
 *   - regime moins strict : skip si sma50 < sma200 ET close < sma200
 *
 * Slippage réaliste maintenu (large 0.1%, ETF 0.05%, indice 0.15%).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { computeAllIndicators } from './indicators.mjs';

const C = {
  atrStop: 0.7, atrTp2: 6.0, holdMax: 30,
  baseSizing: 18, maxPos: 4, pyramiding: 30,
  minQuality: 78,
  leverageThreshold: 88,
  leverageMult: 1.5,
  trailingATRMult: 0.5,
  BORROW_YR: 0.06,
  WARMUP: 60,
};

function getSlippage(label) {
  if (label.startsWith('^')) return 0.15;
  const etfs = ['SPY','QQQ','SOXX','SMH','XLK','XLF','XLE','XLV','XLP','XLY','XLI','XLU','XLB','XLC','XLRE','TLT','GLD'];
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
  const entry = close, stop = entry - C.atrStop * atrAbs;
  const tp1 = entry + (C.atrTp2 / 2) * atrAbs, tp2 = entry + C.atrTp2 * atrAbs;
  if (stop >= entry || tp2 <= entry) return null;
  if ((tp2 - entry) / (entry - stop) < 1.8) return null;
  return { entry, stop, tp1, tp2, atrAbs, quality: Math.round(q), pattern: p };
}

// 3 patterns ULTRA STRICTS (même que SELECTIVE)
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

// Regime MOINS STRICT : skip uniquement si vrai bear (SMA50<SMA200 ET close<SMA200)
function isTradingOK(sp500Prices, t) {
  if (!sp500Prices || t < 200) return true;
  const last200 = sp500Prices.slice(t - 200, t);
  const last50 = sp500Prices.slice(t - 50, t);
  const sma200 = last200.reduce((a, b) => a + b, 0) / 200;
  const sma50 = last50.reduce((a, b) => a + b, 0) / 50;
  const close = sp500Prices[t - 1];
  // Vrai bear : les 2 conditions doivent être satisfaites
  if (sma50 < sma200 && close < sma200) return false;
  return true;
}

function backtest(data, startIdx, endIdx) {
  let cap = 1000, peak = cap, maxDD = 0;
  const trades = [], open = [];
  const sp = data.find(a => a.label === '^GSPC');
  let daysInCash = 0;

  for (let t = startIdx; t < endIdx; t++) {
    // Borrow cost
    for (const p of open) if (p.lev > 1) cap -= p.size * (p.lev - 1) * (C.BORROW_YR / 252);
    // Update positions
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i], a = data.find(x => x.label === pos.asset);
      if (!a || t >= a.prices.length) { open.splice(i, 1); continue; }
      const priceToday = a.prices[t];
      pos.days++;
      if (priceToday > pos.hse) pos.hse = priceToday;
      if (!pos.tp1H && priceToday >= pos.tp1) { pos.tp1H = true; pos.stop = pos.entry; }
      if (pos.tp1H) { const ns = pos.hse - C.trailingATRMult * pos.atrAbs; if (ns > pos.stop) pos.stop = ns; }
      if (C.pyramiding > 0 && pos.tp1H && !pos.added && priceToday >= pos.tp1) {
        const add = Math.min(pos.size * C.pyramiding/100, cap*0.95);
        if (add > 0) { pos.added = true; pos.addedSize = add; cap -= add; }
      }
      const hS = priceToday <= pos.stop, hT = priceToday >= pos.tp2, to = pos.days >= C.holdMax;
      if (hS || hT || to) {
        let ex = hT ? pos.tp2 : (hS ? pos.stop : priceToday);
        ex *= (1 - pos.slippage / 100);
        const pnlPct = (ex - pos.entry) / pos.entry;
        const tot = pos.size + (pos.addedSize || 0);
        const pnl = tot * pnlPct * pos.lev;
        cap += tot + pnl;
        trades.push({ asset: pos.asset, pnlPct: pnlPct*100, pnl, pattern: pos.pattern, quality: pos.quality, lev: pos.lev });
        open.splice(i, 1);
      }
    }
    const tradingOK = sp ? isTradingOK(sp.prices, t) : true;
    if (!tradingOK) daysInCash++;
    if (tradingOK && open.length < C.maxPos) {
      const cands = [];
      for (const a of data) {
        if (t >= a.prices.length || open.some(p => p.asset === a.label)) continue;
        for (const s of detect(a.prices.slice(0, t+1))) if (s.quality >= C.minQuality) cands.push({ a, s });
      }
      cands.sort((x,y) => y.s.quality - x.s.quality);
      for (let i = 0; i < Math.min(C.maxPos - open.length, cands.length); i++) {
        const c = cands[i], size = cap * C.baseSizing/100;
        if (size < 1 || cap < size*1.1) continue;
        const slippage = getSlippage(c.a.label);
        const lev = (c.s.quality >= C.leverageThreshold) ? C.leverageMult : 1;
        cap -= size;
        open.push({
          asset: c.a.label,
          entry: c.s.entry*(1+slippage/100), stop: c.s.stop, tp1: c.s.tp1, tp2: c.s.tp2,
          atrAbs: c.s.atrAbs, hse: c.s.entry, days: 0, size, addedSize: 0, lev,
          tp1H: false, added: false, pattern: c.s.pattern, quality: c.s.quality, slippage,
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
  const wins = trades.filter(t => t.pnlPct > 0);
  const ret = (fin - 1000) / 1000 * 100;
  const yrs = (endIdx - startIdx) / 252;
  return {
    ret_yr: yrs > 0 ? Number((ret/yrs).toFixed(2)) : 0,
    dd: Number((maxDD*100).toFixed(2)),
    wr: trades.length > 0 ? Number((wins.length/trades.length*100).toFixed(1)) : 0,
    trades: trades.length,
    pct_cash: Number((daysInCash / (endIdx - startIdx) * 100).toFixed(1)),
    lev_trades: trades.filter(t => t.lev > 1).length,
    pf: (() => { const w = wins.reduce((a,t)=>a+t.pnl,0), l = Math.abs(trades.filter(t=>t.pnlPct<=0).reduce((a,t)=>a+t.pnl,0)); return Number((l > 0 ? w/l : 99).toFixed(2)); })(),
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
  console.log('=== ALPHA MODERATE v10.5 ===');
  console.log('Sweet spot : sizing 18% · minQ 78 · pyramiding 30% · leverage 1.5x@Q88');
  console.log('Slippage RÉALISTE par catégorie\n');
  console.log('Fetching 15y data sur ' + ASSETS.length + ' actifs...');
  const data = [];
  for (const s of ASSETS) {
    const p = await fetchYahoo15y(s);
    if (p && p.length >= 1000) { data.push({ label: s, prices: p }); process.stdout.write('.'); }
    else process.stdout.write('x');
  }
  console.log('\n' + data.length + '/' + ASSETS.length + ' loaded\n');
  const minLen = Math.min(...data.map(a => a.prices.length));
  console.log('Min days:', minLen, '(' + (minLen/252).toFixed(1) + ' ans)\n');

  const FOLD = 252;
  const folds = [];
  for (let i = 0; i < 14; i++) {
    const s = i * FOLD, e = Math.min(s + FOLD + C.WARMUP, minLen);
    if (e - s < 100) break;
    folds.push({ name: 'F' + (i+1), s: Math.max(C.WARMUP, s), e });
  }

  console.log('=== WALK-FORWARD ' + folds.length + ' folds ===');
  const results = folds.map(f => ({ ...f, ...backtest(data, f.s, f.e) }));
  results.forEach(f => console.log('  ' + f.name + ': ' + f.ret_yr + '%/an · DD ' + f.dd + '% · WR ' + f.wr + '% · PF ' + f.pf + ' · cash ' + f.pct_cash + '% (' + f.trades + ' tr, ' + f.lev_trades + ' lev)'));

  const sorted = [...results].sort((a, b) => a.ret_yr - b.ret_yr);
  const median = sorted[Math.floor(results.length/2)].ret_yr;
  const ddAvg = results.reduce((a,b)=>a+b.dd,0) / results.length;
  const positive = results.filter(r => r.ret_yr > 0).length;
  const totalTrades = results.reduce((a,b)=>a+b.trades,0);

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║ ALPHA MODERATE — VERDICT                                       ║');
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log('║ Médian       : ' + median + '%/an');
  console.log('║ Worst fold   : ' + sorted[0].ret_yr + '%/an');
  console.log('║ Best fold    : ' + sorted[sorted.length-1].ret_yr + '%/an');
  console.log('║ DD moyen     : ' + ddAvg.toFixed(2) + '%');
  console.log('║ Folds positifs : ' + positive + '/' + results.length);
  console.log('║ Trades/an    : ' + (totalTrades / results.length).toFixed(0));
  console.log('║ Calmar       : ' + (median / Math.abs(ddAvg)).toFixed(2));
  if (median > 18) console.log('║ 🎯 EXCELLENT');
  else if (median > 12) console.log('║ ✅ BON');
  else if (median > 5) console.log('║ ⚠️ MOYEN');
  else console.log('║ ❌ INSUFFISANT');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  await fs.writeFile(path.join(process.cwd(), 'data', 'sandbox', 'alpha_moderate.json'), JSON.stringify({
    generated: new Date().toISOString(), config: C, assets: data.length,
    median, dd_avg: ddAvg, positive, total_folds: results.length,
    avg_trades_yr: totalTrades / results.length, folds: results,
  }, null, 2));
  console.log('\nOutput: data/sandbox/alpha_moderate.json');
}

main().catch(e => { console.error('failed:', e); process.exit(1); });
