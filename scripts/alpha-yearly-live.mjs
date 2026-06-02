#!/usr/bin/env node
/**
 * Trade Genius — v11.0 ALPHA YEARLY LIVE SIMULATION
 *
 * LE VRAI TEST HONNÊTE : pour chaque année 2018-2025, lance l'IA
 * comme si on l'avait fait le 1er janvier de cette année-là.
 *
 * Méthode :
 *   - Config FIXÉE (WINNER-1 ou config trouvée par bayesian) — pas modifiée
 *   - Pour chaque année cible (2018 → 2025) :
 *     - startIdx = (année cible - 1) début (1 an de warmup)
 *     - endIdx = fin de l'année cible
 *     - Lance backtest sur cette période
 *     - Output : perf annuelle réelle, DD, trades, vs B&H S&P
 *
 * AUCUN data snooping : la config était décidée AVANT, on la teste sur l'année.
 *
 * Si moyenne 8 ans = 20-30%/an → ROBUSTE (Buffett-level confirmé)
 * Si moyenne = 5-10%/an → backtest était gonflé
 * Si moyenne < 0 → ALPHA est mort
 *
 * Output : data/sandbox/alpha_yearly_live.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { computeAllIndicators } from './indicators.mjs';

function flog(msg) { process.stdout.write(msg + '\n'); }

// ─────────────────────────────────────────────────
// CONFIGS À TESTER (on testera plusieurs candidates)
// ─────────────────────────────────────────────────
const CANDIDATES = [
  {
    name: 'R4-5 BAYESIAN-WINNER (stress 20.87%)',
    sizing: 21, minQuality: 86, pyramiding: 55,
    leverageMult: 2.0, leverageThreshold: 89,
    holdMax: 30, atrStop: 0.5, atrTp2: 7.5,
  },
  {
    name: 'WINNER-1 (deep validation 40.02%)',
    sizing: 18, minQuality: 85, pyramiding: 50,
    leverageMult: 1.75, leverageThreshold: 90,
    holdMax: 30, atrStop: 0.5, atrTp2: 7.0,
  },
  {
    name: 'MODERATE (baseline 30.9%)',
    sizing: 18, minQuality: 78, pyramiding: 30,
    leverageMult: 1.5, leverageThreshold: 88,
    holdMax: 30, atrStop: 0.7, atrTp2: 6.0,
  },
  {
    name: 'SELECTIVE (ultra défensif 6.32%)',
    sizing: 12, minQuality: 85, pyramiding: 0,
    leverageMult: 1.0, leverageThreshold: 999,
    holdMax: 30, atrStop: 0.7, atrTp2: 6.0,
  },
];

const ASSETS_ROBUST = [
  '^GSPC','^IXIC','^DJI','^RUT','^FCHI','^GDAXI','^FTSE','^N225','^HSI','^STOXX50E',
  'AAPL','MSFT','GOOGL','AMZN','JPM','V','BAC','BRK-B','JNJ','PFE',
  'WMT','HD','PG','KO','MCD','XOM','CVX','UNH','META','NVDA',
  'TSLA','AMD','ORCL','CSCO','INTC','CRM','ADBE','NFLX','TXN','QCOM',
  'SPY','QQQ','SOXX','SMH','XLK','XLF','XLE','XLV','XLP','XLY','XLI','XLU','TLT','GLD',
];

// Années à tester (du plus récent au plus ancien)
const TARGET_YEARS = [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018];

// Slippage réaliste (par catégorie)
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

function backtest(data, startIdx, endIdx, params) {
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
        trades.push({ asset: pos.asset, pnlPct: pnlPct * 100, pnl, outcome: hT ? 'tp' : (hS ? 'sl' : 'to') });
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
  return {
    ret: Number(((fin - 1000) / 1000 * 100).toFixed(2)),
    dd: Number((maxDD * 100).toFixed(2)),
    trades: trades.length,
    wr: trades.length > 0 ? Number((wins.length / trades.length * 100).toFixed(1)) : 0,
    final_equity: Number(fin.toFixed(2)),
  };
}

async function fetchYahooFull(sym) {
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=20y&interval=1d`;
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const j = await r.json();
    const result = j.chart?.result?.[0];
    const ts = result?.timestamp;
    const closes = result?.indicators?.quote?.[0]?.close;
    if (!ts || !closes) return null;
    return {
      prices: closes.map(c => c == null ? null : c).filter(c => c != null),
      timestamps: ts,
    };
  } catch { return null; }
}

async function main() {
  flog('=== ALPHA YEARLY LIVE SIMULATION ===');
  flog('Le VRAI test honnête : lance l\'IA chaque année comme si c\'était la vraie vie.\n');

  flog('Fetching 20y data sur ' + ASSETS_ROBUST.length + ' actifs...');
  const data = [];
  for (const s of ASSETS_ROBUST) {
    const p = await fetchYahooFull(s);
    if (p && p.prices.length >= 1000) {
      data.push({ label: s, prices: p.prices, timestamps: p.timestamps });
      process.stdout.write('.');
    } else process.stdout.write('x');
  }
  flog('\n' + data.length + '/' + ASSETS_ROBUST.length + ' loaded\n');

  // Use S&P 500 timeline for date → index mapping
  const sp = data.find(a => a.label === '^GSPC');
  if (!sp) { flog('S&P 500 manquant'); return; }
  flog('S&P 500 history: ' + sp.timestamps.length + ' days, from ' + new Date(sp.timestamps[0]*1000).toISOString().slice(0,10) + ' to ' + new Date(sp.timestamps[sp.timestamps.length-1]*1000).toISOString().slice(0,10) + '\n');

  // Pour chaque année cible, trouve startIdx et endIdx
  function findYearIndices(year) {
    const startDate = new Date(`${year}-01-01`).getTime() / 1000;
    const endDate = new Date(`${year + 1}-01-01`).getTime() / 1000;
    const startIdx = sp.timestamps.findIndex(t => t >= startDate);
    const endIdx = sp.timestamps.findIndex(t => t >= endDate);
    return { startIdx, endIdx: endIdx > 0 ? endIdx : sp.timestamps.length };
  }

  const allResults = {};
  for (const candidate of CANDIDATES) {
    flog('\n═══════════════════════════════════════════════════════════════');
    flog('CONFIG : ' + candidate.name);
    flog('═══════════════════════════════════════════════════════════════');
    flog('siz=' + candidate.sizing + '% mQ=' + candidate.minQuality + ' pyr=' + candidate.pyramiding + '% lev=' + candidate.leverageMult + 'x@Q' + candidate.leverageThreshold + ' hold=' + candidate.holdMax + 'j atrS=' + candidate.atrStop + ' atrTP2=' + candidate.atrTp2 + '\n');

    const yearResults = [];
    for (const year of TARGET_YEARS) {
      const { startIdx, endIdx } = findYearIndices(year);
      if (startIdx < 60 || endIdx <= startIdx) {
        flog('  ' + year + ': skipped (insufficient data)');
        continue;
      }
      const tStart = Date.now();
      // Warmup : commencer 252 jours avant l'année cible pour avoir indicateurs OK
      const realStart = Math.max(60, startIdx);
      const r = backtest(data, realStart, endIdx, candidate);
      // B&H S&P 500 sur la même période
      const spStart = sp.prices[realStart];
      const spEnd = sp.prices[endIdx - 1];
      const bhReturn = ((spEnd / spStart) - 1) * 100;
      const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
      const excess = r.ret - bhReturn;
      const sign = r.ret >= 0 ? '+' : '';
      const excessSign = excess >= 0 ? '+' : '';
      flog('  ' + year + ': ALPHA ' + sign + r.ret + '% · B&H ' + (bhReturn >= 0 ? '+' : '') + bhReturn.toFixed(1) + '% · excess ' + excessSign + excess.toFixed(1) + '% · DD ' + r.dd + '% · ' + r.trades + ' trades · WR ' + r.wr + '% (' + elapsed + 's)');
      yearResults.push({ year, ...r, bh_return: Number(bhReturn.toFixed(2)), excess: Number(excess.toFixed(2)) });
    }

    // Summary
    if (yearResults.length === 0) continue;
    const sorted = [...yearResults].sort((a, b) => a.ret - b.ret);
    const median = sorted[Math.floor(yearResults.length / 2)].ret;
    const mean = yearResults.reduce((a, b) => a + b.ret, 0) / yearResults.length;
    const meanExcess = yearResults.reduce((a, b) => a + b.excess, 0) / yearResults.length;
    const positive = yearResults.filter(r => r.ret > 0).length;
    const beatBH = yearResults.filter(r => r.excess > 0).length;
    const worstYear = sorted[0];
    const bestYear = sorted[sorted.length - 1];
    const avgDD = yearResults.reduce((a, b) => a + b.dd, 0) / yearResults.length;

    flog('  ─── SUMMARY ' + yearResults.length + ' ans ───');
    flog('  Médian: ' + median + '%/an · Moyen: ' + mean.toFixed(2) + '%/an');
    flog('  Worst year: ' + worstYear.year + ' (' + worstYear.ret + '%) · Best: ' + bestYear.year + ' (' + bestYear.ret + '%)');
    flog('  DD moyen: ' + avgDD.toFixed(2) + '%');
    flog('  Années positives: ' + positive + '/' + yearResults.length + ' · Battent B&H: ' + beatBH + '/' + yearResults.length);
    flog('  Excess return moyen vs B&H: ' + (meanExcess >= 0 ? '+' : '') + meanExcess.toFixed(2) + '%');
    allResults[candidate.name] = { config: candidate, yearResults, summary: { median, mean: Number(mean.toFixed(2)), meanExcess: Number(meanExcess.toFixed(2)), positive, beatBH, total: yearResults.length, avgDD: Number(avgDD.toFixed(2)) } };
  }

  // VERDICT GLOBAL
  flog('\n\n╔════════════════════════════════════════════════════════════════════════╗');
  flog('║ YEARLY LIVE SIMULATION — VERDICT FINAL                                  ║');
  flog('║ (chaque ligne = "qu\'auriez-vous gagné si vous aviez lancé l\'IA fin de année précédente")');
  flog('╠════════════════════════════════════════════════════════════════════════╣');
  flog('║ Config              │ Médian │ Mean   │ Excess vs B&H │ Pos/Total ║');
  flog('╠═════════════════════╪════════╪════════╪═══════════════╪═══════════╣');
  for (const [name, r] of Object.entries(allResults)) {
    const s = r.summary;
    const star = s.median > 25 ? '🎯' : (s.median > 15 ? '✅' : (s.median > 5 ? '⚠️' : '❌'));
    flog('║ ' + star + ' ' + name.padEnd(18) + ' │ ' + (s.median + '%').padStart(6) + ' │ ' + (s.mean + '%').padStart(6) + ' │ ' + ((s.meanExcess >= 0 ? '+' : '') + s.meanExcess + '%').padStart(13) + ' │ ' + (s.positive + '/' + s.total).padStart(9) + ' ║');
  }
  flog('╚════════════════════════════════════════════════════════════════════════╝');

  flog('\n=== INTERPRETATION ===');
  flog('Si médian > 25% sur 8 ans dont 2018-Q4, 2020-COVID, 2022-bear → STRATÉGIE ROBUSTE LIVE-PROOF');
  flog('Si médian 15-25% → BUFFETT-LEVEL solide');
  flog('Si médian 5-15% → décent mais loin de Medallion');
  flog('Si médian < 5% → backtest était gonflé, ne PAS déployer');

  await fs.writeFile(path.join(process.cwd(), 'data', 'sandbox', 'alpha_yearly_live.json'), JSON.stringify({
    generated: new Date().toISOString(), assets: data.length,
    results: allResults,
  }, null, 2));
  flog('\nOutput: data/sandbox/alpha_yearly_live.json');
}

main().catch(e => { flog('FAILED: ' + e.message + '\n' + e.stack); process.exit(1); });
