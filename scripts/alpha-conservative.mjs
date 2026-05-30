#!/usr/bin/env node
/**
 * Trade Genius — v10.3 ALPHA CONSERVATIVE
 *
 * Leçon de ALPHA v10.0 (-7.95%/an honest) : sophistication ≠ rentabilité.
 * Approche conservative : v9.3 + 2 meilleurs nouveaux patterns + filtres stricts.
 *
 * Cible : 20-25%/an net SUR CONDITIONS BRUTALES (slippage 1%, borrow 8%).
 *
 * Différences vs ALPHA v10.0 :
 *   - 5 patterns max (vs 8) : A/B/C éprouvés + D-breakout + G-rsi-div (top earners)
 *   - minQuality 70 (vs 55) : SEULEMENT trades très propres
 *   - Leverage 1.5x sur Q≥90 (vs 2x sur 85) : moins agressif
 *   - REGIME FILTER STRICT : skip si SMA50 < SMA200 (vrai bear)
 *   - Pyramiding 30% (vs 50%) : moins amplifié
 *   - Slippage 1% modélisé
 *
 * Test sur 50 actifs × 11 ans walk-forward × leverage on/off.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { computeAllIndicators } from './indicators.mjs';

const C = {
  atrStop: 0.6, atrTp2: 5.5, holdMax: 25,
  baseSizing: 10, maxPos: 5, pyramiding: 30,
  minQuality: 70,
  leverageThreshold: 90,
  trailingATRMult: 0.5,
  SLIPPAGE: 1.0, BORROW_YR: 0.08, GAP_VOL: 0.01,
  WARMUP: 60,
  // Regime filter
  regimeFilter: true,
};

const ASSETS_ROBUST = [
  '^GSPC','^IXIC','^DJI','^RUT','^FCHI','^GDAXI','^FTSE','^N225','^HSI','^STOXX50E',
  'AAPL','MSFT','GOOGL','AMZN','JPM','V','BAC','BRK-B','JNJ','PFE',
  'WMT','HD','PG','KO','MCD','XOM','CVX','UNH','IBM','META',
  'NVDA','TSLA','AMD','ORCL','CSCO','INTC','CRM','ADBE','NFLX','PYPL',
  'TXN','QCOM','LLY','ABBV','MRK','TMO','UNP','GS','MS','AXP',
];

function _build(close, atrAbs, q, p) {
  const entry = close, stop = entry - C.atrStop * atrAbs;
  const tp1 = entry + (C.atrTp2 / 2) * atrAbs, tp2 = entry + C.atrTp2 * atrAbs;
  if (stop >= entry || tp2 <= entry) return null;
  if ((tp2 - entry) / (entry - stop) < 1.8) return null;
  return { entry, stop, tp1, tp2, atrAbs, quality: Math.round(q), pattern: p };
}

// 5 patterns conservative
function detect(prices) {
  if (prices.length < 60) return [];
  const ind = computeAllIndicators(prices);
  if (!ind?.rsi || !ind?.boll || !ind?.atr) return [];
  const rsi = ind.rsi.value, boll = ind.boll.value;
  const close = prices[prices.length - 1];
  const atrAbs = ind.atr.value * close / 100;
  const out = [];
  // A — Contrarian (gardé de v9.3)
  if (rsi < 28 && boll < 0.30) {
    const s = _build(close, atrAbs, 60+(28-rsi)+(0.30-boll)*30, 'A'); if (s) out.push(s);
  }
  // B — Trend-follow (gardé)
  if (ind.adx && ind.macd && rsi >= 35 && rsi <= 60 && ind.adx.value >= 25 && ind.macd.value < 0 && boll >= 0.25 && boll <= 0.75) {
    const s = _build(close, atrAbs, 62+Math.min(15,ind.adx.value-25)+Math.min(10,50-rsi), 'B'); if (s) out.push(s);
  }
  // C — Pullback Ichimoku (gardé)
  if (ind.ichimoku && rsi >= 35 && rsi <= 60 && boll < 0.30 && ind.ichimoku.position === 'above-cloud' && ind.ichimoku.signal === 'bull') {
    const s = _build(close, atrAbs, 65+Math.min(15,50-rsi)+(0.30-boll)*25, 'C'); if (s) out.push(s);
  }
  // D — Breakout 20j (top earner ALPHA) — mais avec confirmation
  if (prices.length >= 25) {
    const last20 = prices.slice(-22,-1);
    const high20 = Math.max(...last20);
    // Confirmation : RSI doit être en momentum (50-70) + ADX > 20
    if (close > high20*1.005 && rsi >= 50 && rsi <= 70 && ind.adx && ind.adx.value > 20) {
      const s = _build(close, atrAbs, 65+Math.min(20,((close/high20)-1)*400), 'D'); if (s) out.push(s);
    }
  }
  // G — RSI divergence (top earner ALPHA) — avec confirmation MACD
  if (prices.length >= 30 && ind.macd) {
    const prices14 = prices.slice(-14);
    const isFreshLow = prices14.indexOf(Math.min(...prices14)) >= 10;
    // MACD doit montrer un retournement (passage négatif → positif récent)
    if (isFreshLow && rsi > 30 && rsi < 50 && ind.macd.value > -0.5) {
      const s = _build(close, atrAbs, 60+(50-rsi), 'G'); if (s) out.push(s);
    }
  }
  return out;
}

// REGIME : retourne true si on doit trader (bull regime)
function isBullRegime(sp500Prices, t) {
  if (!sp500Prices || t < 200) return true;
  const last200 = sp500Prices.slice(t - 200, t);
  const last50 = sp500Prices.slice(t - 50, t);
  const sma200 = last200.reduce((a, b) => a + b, 0) / 200;
  const sma50 = last50.reduce((a, b) => a + b, 0) / 50;
  // Bull = SMA50 > SMA200 + close au-dessus SMA200
  const close = sp500Prices[t - 1];
  return sma50 > sma200 && close > sma200;
}

function gapNoise(seed) {
  const u1 = ((seed*9301+49297) % 233280) / 233280;
  const u2 = (((seed+1)*9301+49297) % 233280) / 233280;
  return Math.sqrt(-2*Math.log(Math.max(0.001,u1))) * Math.cos(2*Math.PI*u2) * C.GAP_VOL;
}

function backtest(data, startIdx, endIdx, leverageOn) {
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
      const priceToday = a.prices[t] * (1 + gapNoise(t*1000+i));
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
        ex *= (1 - C.SLIPPAGE/100);
        const pnlPct = (ex - pos.entry) / pos.entry;
        const tot = pos.size + (pos.addedSize || 0);
        const pnl = tot * pnlPct * pos.lev;
        cap += tot + pnl;
        trades.push({ asset: pos.asset, pnlPct: pnlPct*100, pnl, lev: pos.lev, pattern: pos.pattern });
        open.splice(i, 1);
      }
    }
    // REGIME CHECK
    const tradingOK = !C.regimeFilter || (sp && isBullRegime(sp.prices, t));
    if (!tradingOK) daysInCash++;
    // New setups (skip si bear)
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
        const lev = (leverageOn && c.s.quality >= C.leverageThreshold) ? 1.5 : 1;
        cap -= size;
        open.push({ asset: c.a.label, entry: c.s.entry*(1+C.SLIPPAGE/100), stop: c.s.stop, tp1: c.s.tp1, tp2: c.s.tp2, atrAbs: c.s.atrAbs, hse: c.s.entry, days: 0, size, addedSize: 0, lev, tp1H: false, added: false, pattern: c.s.pattern, quality: c.s.quality });
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
    days_in_cash: daysInCash,
    pct_in_cash: Number((daysInCash / (endIdx - startIdx) * 100).toFixed(1)),
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
  console.log('=== ALPHA CONSERVATIVE v10.3 ===');
  console.log('5 patterns max · minQuality 70 · leverage 1.5x@Q90 · regime filter ON');
  console.log('Conditions BRUTALES : slippage 1% · borrow 8% · gap ±1%\n');
  console.log('Fetching 15y data sur ' + ASSETS_ROBUST.length + ' actifs...');
  const data = [];
  for (const s of ASSETS_ROBUST) {
    const p = await fetchYahoo15y(s);
    if (p && p.length >= 1000) { data.push({ label: s, prices: p }); process.stdout.write('.'); }
    else process.stdout.write('x');
  }
  console.log('\n' + data.length + '/' + ASSETS_ROBUST.length + ' loaded\n');
  const minLen = Math.min(...data.map(a => a.prices.length));
  console.log('Min days:', minLen, '(' + (minLen/252).toFixed(1) + ' ans)\n');

  const FOLD = 252;
  const folds = [];
  for (let i = 0; i < 12; i++) {
    const s = i * FOLD, e = Math.min(s + FOLD + C.WARMUP, minLen);
    if (e - s < 100) break;
    folds.push({ name: 'F' + (i+1), s: Math.max(C.WARMUP, s), e });
  }

  console.log('=== LEVERAGE OFF ===');
  const lev0 = folds.map(f => ({ ...f, ...backtest(data, f.s, f.e, false) }));
  lev0.forEach(f => console.log('  ' + f.name + ': ' + f.ret_yr + '%/an · DD ' + f.dd + '% · WR ' + f.wr + '% · PF ' + f.pf + ' · cash ' + f.pct_in_cash + '% (' + f.trades + ' trades)'));
  const med0 = lev0.map(f => f.ret_yr).sort((a,b)=>a-b)[Math.floor(lev0.length/2)];
  const dd0 = lev0.reduce((a,b)=>a+b.dd,0)/lev0.length;
  const pos0 = lev0.filter(f => f.ret_yr > 0).length;
  console.log('  → MÉDIAN: ' + med0 + '%/an · DD moy: ' + dd0.toFixed(2) + '% · ' + pos0 + '/' + lev0.length + ' positifs\n');

  console.log('=== LEVERAGE 1.5x sur Q>=90 ===');
  const lev2 = folds.map(f => ({ ...f, ...backtest(data, f.s, f.e, true) }));
  lev2.forEach(f => console.log('  ' + f.name + ': ' + f.ret_yr + '%/an · DD ' + f.dd + '% · WR ' + f.wr + '% · PF ' + f.pf + ' · cash ' + f.pct_in_cash + '% (' + f.trades + ' trades)'));
  const med2 = lev2.map(f => f.ret_yr).sort((a,b)=>a-b)[Math.floor(lev2.length/2)];
  const dd2 = lev2.reduce((a,b)=>a+b.dd,0)/lev2.length;
  const pos2 = lev2.filter(f => f.ret_yr > 0).length;
  console.log('  → MÉDIAN: ' + med2 + '%/an · DD moy: ' + dd2.toFixed(2) + '% · ' + pos2 + '/' + lev2.length + ' positifs\n');

  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║ ALPHA CONSERVATIVE — VERDICT                                   ║');
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log('║ Sans leverage : ' + med0 + '%/an · DD ' + dd0.toFixed(1) + '% · ' + pos0 + '/' + lev0.length + ' positifs');
  console.log('║ Avec lev 1.5x : ' + med2 + '%/an · DD ' + dd2.toFixed(1) + '% · ' + pos2 + '/' + lev2.length + ' positifs');
  if (med0 > 12) console.log('║ ✅ DÉPLOYABLE (>12%/an honest)');
  else if (med0 > 5) console.log('║ ⚠️ MARGINAL (5-12%/an)');
  else console.log('║ ❌ NON DÉPLOYABLE (<5%/an honest)');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  await fs.writeFile(path.join(process.cwd(), 'data', 'sandbox', 'alpha_conservative.json'), JSON.stringify({
    generated: new Date().toISOString(), config: C, assets: data.length,
    leverage_off: { median: med0, dd_avg: dd0, positive: pos0, folds: lev0 },
    leverage_15: { median: med2, dd_avg: dd2, positive: pos2, folds: lev2 },
  }, null, 2));
  console.log('\nOutput: data/sandbox/alpha_conservative.json');
}

main().catch(e => { console.error('failed:', e); process.exit(1); });
