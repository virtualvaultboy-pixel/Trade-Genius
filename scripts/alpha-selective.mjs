#!/usr/bin/env node
/**
 * Trade Genius — v10.4 ALPHA SELECTIVE
 *
 * Leçon des 2 derniers tests : à 200-400 trades/an × slippage 1%, le système
 * NE PEUT PAS tenir. Solution : ULTRA SÉLECTIVITÉ.
 *
 * Cible : 50-100 trades/an MAX (5-10× moins) avec très haute conviction.
 *
 * Différences vs ALPHA CONSERVATIVE :
 *   - minQuality 85 (vs 70) — ne prend QUE les diamants
 *   - 3 patterns A/B/C seulement (vs 5) — pas D ni G qui spamment
 *   - maxPos 3 (vs 5) — concentration
 *   - PAS de pyramiding — n'amplifie pas le bruit
 *   - PAS de leverage — pas de risque additionnel
 *   - Slippage réaliste par catégorie (large-cap 0.1%, ETF 0.05%, indice 0.15%)
 *   - Regime filter STRICT (SMA50 < SMA200 = cash)
 *   - Borrow OFF (pas de leverage)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { computeAllIndicators } from './indicators.mjs';

const C = {
  atrStop: 0.7, atrTp2: 6.0, holdMax: 30,
  baseSizing: 12, maxPos: 3, pyramiding: 0,
  minQuality: 85,
  leverageThreshold: 999, // OFF
  trailingATRMult: 0.5,
  WARMUP: 60,
};

// Slippage par catégorie d'actif (réaliste pour capital >5000€)
function getSlippage(label) {
  if (label.startsWith('^')) return 0.15; // indice
  // ETF
  const etfs = ['SPY','QQQ','SOXX','SMH','XLK','XLF','XLE','XLV','XLP','XLY','XLI','XLU','XLB','XLC','XLRE','TLT','GLD'];
  if (etfs.includes(label)) return 0.05;
  // Large-cap US ultra liquide
  const mega = ['AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','BRK-B','JPM','V','BAC','WMT','HD','PG','KO','JNJ','UNH','XOM','MCD'];
  if (mega.includes(label)) return 0.10;
  return 0.30; // autres actions
}

const ASSETS_LIQUIDS = [
  // Indices liquides
  '^GSPC','^IXIC','^DJI','^RUT','^FCHI','^GDAXI','^FTSE','^N225','^HSI','^STOXX50E',
  // Mega-caps US (très liquide)
  'AAPL','MSFT','GOOGL','AMZN','JPM','V','BAC','BRK-B','JNJ','PFE',
  'WMT','HD','PG','KO','MCD','XOM','CVX','UNH','META','NVDA',
  'TSLA','AMD','ORCL','CSCO','INTC','CRM','ADBE','NFLX','TXN','QCOM',
  // ETF
  'SPY','QQQ','SOXX','SMH','XLK','XLF','XLE','XLV','XLP','XLY','XLI','XLU',
  'TLT','GLD',
];

function _build(close, atrAbs, q, p) {
  const entry = close, stop = entry - C.atrStop * atrAbs;
  const tp1 = entry + (C.atrTp2 / 2) * atrAbs, tp2 = entry + C.atrTp2 * atrAbs;
  if (stop >= entry || tp2 <= entry) return null;
  if ((tp2 - entry) / (entry - stop) < 1.8) return null;
  return { entry, stop, tp1, tp2, atrAbs, quality: Math.round(q), pattern: p };
}

// SEULEMENT 3 patterns éprouvés
function detect(prices) {
  if (prices.length < 60) return [];
  const ind = computeAllIndicators(prices);
  if (!ind?.rsi || !ind?.boll || !ind?.atr) return [];
  const rsi = ind.rsi.value, boll = ind.boll.value;
  const close = prices[prices.length - 1];
  const atrAbs = ind.atr.value * close / 100;
  const out = [];
  // A — Contrarian ULTRA STRICT (RSI<22 au lieu de 28, BB<20%)
  if (rsi < 22 && boll < 0.20 && ind.adx && ind.adx.value > 20) {
    const q = 75 + (22 - rsi) * 1.5 + (0.20 - boll) * 50;
    const s = _build(close, atrAbs, q, 'A'); if (s) out.push(s);
  }
  // B — Trend-follow ULTRA STRICT (ADX>30 obligatoire, MACD strong negative)
  if (ind.adx && ind.macd && rsi >= 38 && rsi <= 55 && ind.adx.value >= 30 &&
      ind.macd.value < -0.3 && boll >= 0.30 && boll <= 0.70) {
    const q = 78 + Math.min(15, ind.adx.value - 30) + Math.min(8, 50 - rsi);
    const s = _build(close, atrAbs, q, 'B'); if (s) out.push(s);
  }
  // C — Pullback Ichimoku ULTRA STRICT (RSI 40-50, BB <25%)
  if (ind.ichimoku && rsi >= 40 && rsi <= 50 && boll < 0.25 &&
      ind.ichimoku.position === 'above-cloud' && ind.ichimoku.signal === 'bull' &&
      ind.adx && ind.adx.value > 22) {
    const q = 80 + Math.min(12, 50 - rsi) + (0.25 - boll) * 50;
    const s = _build(close, atrAbs, q, 'C'); if (s) out.push(s);
  }
  return out;
}

function isBullRegime(sp500Prices, t) {
  if (!sp500Prices || t < 200) return true;
  const last200 = sp500Prices.slice(t - 200, t);
  const last50 = sp500Prices.slice(t - 50, t);
  const sma200 = last200.reduce((a, b) => a + b, 0) / 200;
  const sma50 = last50.reduce((a, b) => a + b, 0) / 50;
  const close = sp500Prices[t - 1];
  return sma50 > sma200 && close > sma200;
}

function backtest(data, startIdx, endIdx) {
  let cap = 1000, peak = cap, maxDD = 0;
  const trades = [], open = [];
  const sp = data.find(a => a.label === '^GSPC');
  let daysInCash = 0;

  for (let t = startIdx; t < endIdx; t++) {
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i], a = data.find(x => x.label === pos.asset);
      if (!a || t >= a.prices.length) { open.splice(i, 1); continue; }
      const priceToday = a.prices[t];
      pos.days++;
      if (priceToday > pos.hse) pos.hse = priceToday;
      if (!pos.tp1H && priceToday >= pos.tp1) { pos.tp1H = true; pos.stop = pos.entry; }
      if (pos.tp1H) { const ns = pos.hse - C.trailingATRMult * pos.atrAbs; if (ns > pos.stop) pos.stop = ns; }
      const hS = priceToday <= pos.stop, hT = priceToday >= pos.tp2, to = pos.days >= C.holdMax;
      if (hS || hT || to) {
        let ex = hT ? pos.tp2 : (hS ? pos.stop : priceToday);
        ex *= (1 - pos.slippage / 100);
        const pnlPct = (ex - pos.entry) / pos.entry;
        const pnl = pos.size * pnlPct;
        cap += pos.size + pnl;
        trades.push({ asset: pos.asset, pnlPct: pnlPct*100, pnl, pattern: pos.pattern, quality: pos.quality });
        open.splice(i, 1);
      }
    }
    const tradingOK = sp ? isBullRegime(sp.prices, t) : true;
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
        cap -= size;
        open.push({
          asset: c.a.label,
          entry: c.s.entry*(1+slippage/100), stop: c.s.stop, tp1: c.s.tp1, tp2: c.s.tp2,
          atrAbs: c.s.atrAbs, hse: c.s.entry, days: 0, size,
          tp1H: false, pattern: c.s.pattern, quality: c.s.quality, slippage,
        });
      }
    }
    const eq = cap + open.reduce((acc, p) => {
      const a = data.find(x => x.label === p.asset);
      const pr = a?.prices[t] || p.entry;
      return acc + p.size * (1 + (pr - p.entry) / p.entry);
    }, 0);
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak; if (dd < maxDD) maxDD = dd;
  }
  const fin = cap + open.reduce((acc, p) => {
    const a = data.find(x => x.label === p.asset);
    const pr = a?.prices[endIdx-1] || p.entry;
    return acc + p.size * (1 + (pr - p.entry) / p.entry);
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
  console.log('=== ALPHA SELECTIVE v10.4 ===');
  console.log('Slippage RÉALISTE (large-cap 0.1%, ETF 0.05%, indice 0.15%)');
  console.log('minQuality 85 · maxPos 3 · 3 patterns ULTRA STRICTS · regime filter\n');
  console.log('Fetching 15y data sur ' + ASSETS_LIQUIDS.length + ' actifs liquides...');
  const data = [];
  for (const s of ASSETS_LIQUIDS) {
    const p = await fetchYahoo15y(s);
    if (p && p.length >= 1000) { data.push({ label: s, prices: p }); process.stdout.write('.'); }
    else process.stdout.write('x');
  }
  console.log('\n' + data.length + '/' + ASSETS_LIQUIDS.length + ' loaded\n');
  const minLen = Math.min(...data.map(a => a.prices.length));
  console.log('Min days:', minLen, '(' + (minLen/252).toFixed(1) + ' ans)\n');

  const FOLD = 252;
  const folds = [];
  for (let i = 0; i < 12; i++) {
    const s = i * FOLD, e = Math.min(s + FOLD + C.WARMUP, minLen);
    if (e - s < 100) break;
    folds.push({ name: 'F' + (i+1), s: Math.max(C.WARMUP, s), e });
  }

  console.log('=== WALK-FORWARD ===');
  const results = folds.map(f => ({ ...f, ...backtest(data, f.s, f.e) }));
  results.forEach(f => console.log('  ' + f.name + ': ' + f.ret_yr + '%/an · DD ' + f.dd + '% · WR ' + f.wr + '% · PF ' + f.pf + ' · cash ' + f.pct_cash + '% (' + f.trades + ' trades)'));

  const sorted = [...results].sort((a, b) => a.ret_yr - b.ret_yr);
  const median = sorted[Math.floor(results.length/2)].ret_yr;
  const ddAvg = results.reduce((a,b)=>a+b.dd,0) / results.length;
  const positive = results.filter(r => r.ret_yr > 0).length;
  const totalTrades = results.reduce((a,b)=>a+b.trades,0);
  const avgTrades = totalTrades / results.length;

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║ ALPHA SELECTIVE — VERDICT                                      ║');
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log('║ Médian            : ' + median + '%/an');
  console.log('║ Worst fold        : ' + sorted[0].ret_yr + '%/an');
  console.log('║ Best fold         : ' + sorted[sorted.length-1].ret_yr + '%/an');
  console.log('║ DD moyen          : ' + ddAvg.toFixed(2) + '%');
  console.log('║ Folds positifs    : ' + positive + '/' + results.length);
  console.log('║ Trades/an moyen   : ' + avgTrades.toFixed(0) + ' (cible <100)');
  if (median > 18) console.log('║ ✅ EXCELLENT (>18%/an honest avec slippage réaliste)');
  else if (median > 12) console.log('║ ✅ BON (12-18%/an)');
  else if (median > 5) console.log('║ ⚠️ MARGINAL (5-12%/an)');
  else console.log('║ ❌ INSUFFISANT (<5%/an)');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  await fs.writeFile(path.join(process.cwd(), 'data', 'sandbox', 'alpha_selective.json'), JSON.stringify({
    generated: new Date().toISOString(), config: C, assets: data.length,
    median, dd_avg: ddAvg, positive, total_folds: results.length, avg_trades: avgTrades,
    folds: results,
  }, null, 2));
  console.log('\nOutput: data/sandbox/alpha_selective.json');
}

main().catch(e => { console.error('failed:', e); process.exit(1); });
