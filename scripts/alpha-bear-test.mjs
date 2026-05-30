#!/usr/bin/env node
/**
 * Trade Genius — v10.1 ALPHA BEAR TEST
 *
 * Test ALPHA sur les 4 plus gros crashes des 20 dernières années :
 *   1. 2008-2009 Lehman crash (S&P -56% peak-to-trough)
 *   2. 2018 Q4 sell-off (S&P -19% en 3 mois, Fed hawkish)
 *   3. 2020 COVID crash (S&P -34% en 1 mois)
 *   4. 2022 Fed bear (S&P -25% sur 9 mois)
 *
 * Si ALPHA reste positive ou flat (≥-5%/an) sur ces 4 périodes = vrai game changer.
 * Si elle s'effondre (-30%+) = stratégie cassée par bear markets, à revoir.
 *
 * Univers : 30 actifs robustes (large-cap US + ETF + indices avec 20 ans d'historique).
 * Output : data/sandbox/alpha_bear_test.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchYahooHistorical, computeAllIndicators } from './indicators.mjs';

const CAPITAL_INITIAL = 1000;
const BORROW_COST_YR = 0.06;
const WARMUP = 60;

const CONFIG = {
  atrStop: 0.6, atrTp2: 5.5, holdMax: 25,
  baseSizing: 10, maxPos: 5, pyramiding: 50,
  minQuality: 55,
  leverageQualityThreshold: 85,
  leverageMultiplier: 2.0,
  trailingATRMult: 0.5,
};

// 4 PÉRIODES BEAR + leurs recovery
const BEAR_PERIODS = [
  { name: 'Lehman 2008',       start: '2008-01-01', end: '2009-12-31', desc: 'S&P -56% peak (oct 2007 → mars 2009)' },
  { name: 'Q4 2018 sell-off',  start: '2018-09-01', end: '2019-06-30', desc: 'S&P -19% Fed hawkish + trade war' },
  { name: 'COVID 2020',        start: '2020-01-01', end: '2020-12-31', desc: 'S&P -34% en 1 mois puis V-shape' },
  { name: 'Fed Bear 2022',     start: '2022-01-01', end: '2022-12-31', desc: 'S&P -25% inflation + Fed +75bps' },
];

// 30 actifs robustes avec 20 ans d'historique
const ASSETS_LONG = [
  // Indices
  { kind: 'index', symbol: '^GSPC', label: 'S&P 500' },
  { kind: 'index', symbol: '^IXIC', label: 'Nasdaq' },
  { kind: 'index', symbol: '^DJI',  label: 'Dow Jones' },
  { kind: 'index', symbol: '^RUT',  label: 'Russell 2000' },
  { kind: 'index', symbol: '^FCHI', label: 'CAC 40' },
  { kind: 'index', symbol: '^GDAXI',label: 'DAX' },
  { kind: 'index', symbol: '^FTSE', label: 'FTSE 100' },
  { kind: 'index', symbol: '^N225', label: 'Nikkei 225' },
  { kind: 'index', symbol: '^HSI',  label: 'Hang Seng' },
  { kind: 'index', symbol: '^STOXX50E', label: 'Euro Stoxx 50' },
  // Large-cap US (qui existaient en 2005-2008)
  ...['AAPL','MSFT','GOOGL','AMZN','JPM','V','BAC','WFC','BRK-B','JNJ',
      'PFE','WMT','HD','PG','KO','MCD','XOM','CVX','UNH','IBM'].map(s => ({ kind: 'action', symbol: s, label: s })),
];

// ───────────────────────────────────────────────────
// Détecteurs (identique alpha-engine, 6 patterns dispo)
// ───────────────────────────────────────────────────
function _build(close, atrAbs, q, patternId) {
  const entry = close;
  const stop = entry - CONFIG.atrStop * atrAbs;
  const tp1 = entry + (CONFIG.atrTp2 / 2) * atrAbs;
  const tp2 = entry + CONFIG.atrTp2 * atrAbs;
  if (stop >= entry || tp2 <= entry) return null;
  const rr = (tp2 - entry) / (entry - stop);
  if (rr < 1.8) return null;
  return { entry, stop, tp1, tp2, atrAbs, quality: Math.max(0, Math.min(100, Math.round(q))), pattern: patternId };
}

function detectPatterns(prices) {
  if (prices.length < 60) return [];
  const ind = computeAllIndicators(prices);
  if (!ind?.rsi || !ind?.boll || !ind?.atr) return [];
  const rsi = ind.rsi.value, boll = ind.boll.value;
  const close = prices[prices.length - 1];
  const atrAbs = ind.atr.value * close / 100;
  const out = [];
  if (rsi != null && rsi < 28 && boll != null && boll < 0.30) {
    const s = _build(close, atrAbs, 60 + (28 - rsi) + (0.30 - boll) * 30, 'A'); if (s) out.push(s);
  }
  if (ind.adx && ind.macd) {
    const adx = ind.adx.value, macd = ind.macd.value;
    if (rsi != null && rsi >= 35 && rsi <= 60 && adx != null && adx >= 25 &&
        macd != null && macd < 0 && boll != null && boll >= 0.25 && boll <= 0.75) {
      const s = _build(close, atrAbs, 62 + Math.min(15, adx - 25) + Math.min(10, 50 - rsi), 'B'); if (s) out.push(s);
    }
  }
  if (ind.ichimoku) {
    const ichi = ind.ichimoku;
    if (rsi != null && rsi >= 35 && rsi <= 60 && boll != null && boll < 0.30 &&
        ichi.position === 'above-cloud' && ichi.signal === 'bull') {
      const s = _build(close, atrAbs, 65 + Math.min(15, 50 - rsi) + (0.30 - boll) * 25, 'C'); if (s) out.push(s);
    }
  }
  if (prices.length >= 25) {
    const last20 = prices.slice(-22, -1);
    const high20 = Math.max(...last20);
    if (close > high20 * 1.005) {
      const s = _build(close, atrAbs, 65 + Math.min(20, ((close / high20) - 1) * 400), 'D'); if (s) out.push(s);
    }
  }
  if (rsi != null && rsi < 35 && rsi >= 25 && boll != null && boll < 0.15) {
    const s = _build(close, atrAbs, 58 + (35 - rsi) + (0.15 - boll) * 100, 'E'); if (s) out.push(s);
  }
  if (prices.length >= 30) {
    const prices14 = prices.slice(-14);
    const isFreshLow = prices14.indexOf(Math.min(...prices14)) >= 10;
    if (isFreshLow && rsi != null && rsi > 30 && rsi < 50) {
      const s = _build(close, atrAbs, 60 + (50 - rsi), 'G'); if (s) out.push(s);
    }
  }
  return out;
}

// ───────────────────────────────────────────────────
// Backtest période bear ciblée
// ───────────────────────────────────────────────────
function backtestPeriod(assetData, startIdx, endIdx, periodName) {
  let capital = CAPITAL_INITIAL;
  let peakCapital = capital;
  let maxDD = 0;
  const trades = [];
  const openPositions = [];
  let borrowAccrued = 0;

  if (endIdx - startIdx < 50) return null;

  for (let t = startIdx; t < endIdx; t++) {
    // Cost of borrow
    for (const p of openPositions) {
      if (p.leverage > 1) {
        const borrowed = p.originalSize * (p.leverage - 1);
        const daily = borrowed * (BORROW_COST_YR / 252);
        borrowAccrued += daily;
        capital -= daily;
      }
    }
    // Update positions
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i];
      const asset = assetData.find(a => a.label === pos.asset);
      if (!asset || t >= asset.prices.length) { openPositions.splice(i, 1); continue; }
      const priceToday = asset.prices[t];
      pos.daysHeld++;
      if (priceToday > pos.highSinceEntry) pos.highSinceEntry = priceToday;
      if (!pos.tp1Hit && priceToday >= pos.tp1) { pos.tp1Hit = true; pos.stop = pos.entry; }
      if (pos.tp1Hit) {
        const newStop = pos.highSinceEntry - CONFIG.trailingATRMult * pos.atrAbs;
        if (newStop > pos.stop) pos.stop = newStop;
      }
      if (CONFIG.pyramiding > 0 && pos.tp1Hit && !pos.added && priceToday >= pos.tp1) {
        const addCash = Math.min(pos.originalSize * (CONFIG.pyramiding / 100), capital * 0.95);
        if (addCash > 0) { pos.added = true; pos.addedSize = addCash; capital -= addCash; }
      }
      const hitStop = priceToday <= pos.stop;
      const hitTp = priceToday >= pos.tp2;
      const timeout = pos.daysHeld >= CONFIG.holdMax;
      if (hitStop || hitTp || timeout) {
        let exitPrice = hitTp ? pos.tp2 : (hitStop ? pos.stop : priceToday);
        exitPrice *= (1 - 0.5 / 100);
        const pnlPct = (exitPrice - pos.entry) / pos.entry;
        const totalSize = pos.originalSize + (pos.addedSize || 0);
        const leveragedPnl = pnlPct * pos.leverage;
        const pnlEur = totalSize * leveragedPnl;
        capital += totalSize + pnlEur;
        trades.push({
          asset: pos.asset, pnlPct: Number((pnlPct * 100).toFixed(2)),
          pnlEur: Number(pnlEur.toFixed(2)), daysHeld: pos.daysHeld,
          outcome: hitTp ? 'tp2' : (hitStop ? (pos.tp1Hit ? 'trail' : 'sl') : 'timeout'),
          pattern: pos.pattern, quality: pos.quality, leverage: pos.leverage,
        });
        openPositions.splice(i, 1);
      }
    }
    // New setups
    if (openPositions.length < CONFIG.maxPos) {
      const candidates = [];
      for (const asset of assetData) {
        if (t >= asset.prices.length) continue;
        if (openPositions.some(p => p.asset === asset.label)) continue;
        const setups = detectPatterns(asset.prices.slice(0, t + 1));
        for (const setup of setups) {
          if (setup.quality >= CONFIG.minQuality) candidates.push({ asset, setup });
        }
      }
      candidates.sort((a, b) => b.setup.quality - a.setup.quality);
      const slots = CONFIG.maxPos - openPositions.length;
      for (let i = 0; i < Math.min(slots, candidates.length); i++) {
        const c = candidates[i];
        const sizeEur = capital * (CONFIG.baseSizing / 100);
        if (sizeEur < 1 || capital < sizeEur * 1.1) continue;
        const leverage = c.setup.quality >= CONFIG.leverageQualityThreshold ? CONFIG.leverageMultiplier : 1;
        const entryWithSlip = c.setup.entry * 1.005;
        capital -= sizeEur;
        openPositions.push({
          asset: c.asset.label, entry: entryWithSlip,
          stop: c.setup.stop, tp1: c.setup.tp1, tp2: c.setup.tp2,
          atrAbs: c.setup.atrAbs, highSinceEntry: entryWithSlip,
          daysHeld: 0, quality: c.setup.quality, pattern: c.setup.pattern,
          originalSize: sizeEur, addedSize: 0, leverage,
          tp1Hit: false, added: false,
        });
      }
    }
    // Equity track
    const equity = capital + openPositions.reduce((acc, p) => {
      const asset = assetData.find(a => a.label === p.asset);
      const price = asset?.prices[t] || p.entry;
      const totalSize = p.originalSize + (p.addedSize || 0);
      const unrealizedPct = ((price - p.entry) / p.entry) * p.leverage;
      return acc + totalSize * (1 + unrealizedPct);
    }, 0);
    if (equity > peakCapital) peakCapital = equity;
    const dd = (equity - peakCapital) / peakCapital;
    if (dd < maxDD) maxDD = dd;
  }

  const finalEquity = capital + openPositions.reduce((acc, p) => {
    const asset = assetData.find(a => a.label === p.asset);
    const finalPrice = asset?.prices[endIdx - 1] || p.entry;
    const totalSize = p.originalSize + (p.addedSize || 0);
    const unrealizedPct = ((finalPrice - p.entry) / p.entry) * p.leverage;
    return acc + totalSize * (1 + unrealizedPct);
  }, 0);

  const totalReturn = (finalEquity - CAPITAL_INITIAL) / CAPITAL_INITIAL * 100;
  const yearsBT = (endIdx - startIdx) / 252;
  const returnYr = yearsBT > 0 ? totalReturn / yearsBT : 0;
  const wins = trades.filter(t => t.pnlPct > 0);
  return {
    period: periodName,
    days: endIdx - startIdx,
    trades: trades.length,
    return_total_pct: Number(totalReturn.toFixed(2)),
    return_pct_yr: Number(returnYr.toFixed(2)),
    dd_max: Number((maxDD * 100).toFixed(2)),
    win_rate: trades.length > 0 ? Number((wins.length / trades.length * 100).toFixed(1)) : 0,
    leveraged_trades: trades.filter(t => t.leverage > 1).length,
    borrow_cost: Number(borrowAccrued.toFixed(2)),
  };
}

// ───────────────────────────────────────────────────
// MAIN
// ───────────────────────────────────────────────────
async function main() {
  console.log('=== ALPHA BEAR TEST — survie sur les 4 plus gros crashes 2005-2022 ===\n');

  console.log('Fetching 20y data sur ' + ASSETS_LONG.length + ' actifs robustes...');
  const assetData = [];
  // Map prices -> dates (Yahoo expose les timestamps)
  for (const a of ASSETS_LONG) {
    try {
      // Récupère brut Yahoo avec timestamps
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(a.symbol)}?range=20y&interval=1d`;
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (!r.ok) { process.stdout.write('x'); continue; }
      const j = await r.json();
      const result = j.chart?.result?.[0];
      const ts = result?.timestamp;
      const closes = result?.indicators?.quote?.[0]?.close;
      if (!ts || !closes || ts.length < 500) { process.stdout.write('x'); continue; }
      const prices = closes.map(c => c == null ? null : c).filter(c => c != null);
      const dates = ts.map(t => new Date(t * 1000).toISOString().slice(0, 10));
      assetData.push({ ...a, prices, dates });
      process.stdout.write('.');
    } catch (e) { process.stdout.write('!'); }
  }
  console.log('\n' + assetData.length + '/' + ASSETS_LONG.length + ' loaded.\n');

  if (assetData.length < 5) { console.error('Pas assez de data'); return; }

  // Pour chaque période bear, retrouve les index correspondants
  const results = [];
  for (const period of BEAR_PERIODS) {
    console.log('=== ' + period.name + ' (' + period.start + ' → ' + period.end + ') ===');
    console.log('   ' + period.desc);
    // Take S&P 500 as reference for dates
    const sp = assetData.find(a => a.label === 'S&P 500');
    if (!sp) { console.log('   ⚠️ S&P 500 missing'); continue; }
    const startIdx = sp.dates.findIndex(d => d >= period.start);
    const endIdx = sp.dates.findIndex(d => d >= period.end);
    if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
      console.log('   ⚠️ période hors data disponible');
      continue;
    }
    // Compute B&H S&P 500
    const bhStart = sp.prices[startIdx];
    const bhEnd = sp.prices[endIdx];
    const bhReturnTotal = ((bhEnd / bhStart) - 1) * 100;
    const yearsBT = (endIdx - startIdx) / 252;
    const bhReturnYr = bhReturnTotal / yearsBT;
    // Run ALPHA
    const res = backtestPeriod(assetData, Math.max(WARMUP, startIdx), endIdx, period.name);
    if (!res) { console.log('   ⚠️ backtest failed'); continue; }
    res.bh_sp500_return_yr = Number(bhReturnYr.toFixed(2));
    res.bh_sp500_return_total = Number(bhReturnTotal.toFixed(2));
    res.alpha_vs_bh = Number((res.return_pct_yr - bhReturnYr).toFixed(2));
    results.push(res);
    const verdict = res.return_pct_yr > 0 ? '✅ POSITIF' : (res.return_pct_yr > -10 ? '⚠️ FLAT' : '❌ PERDU');
    console.log('   ALPHA: ' + res.return_pct_yr + '%/an (total ' + res.return_total_pct + '%) · DD ' + res.dd_max + '% · ' + res.trades + ' trades');
    console.log('   B&H S&P: ' + res.bh_sp500_return_yr + '%/an (total ' + res.bh_sp500_return_total + '%)');
    console.log('   EXCESS:  ' + (res.alpha_vs_bh >= 0 ? '+' : '') + res.alpha_vs_bh + '%/an ' + verdict);
    console.log('');
  }

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║ DIAGNOSTIC BEAR TEST                                          ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  results.forEach(r => {
    const verdict = r.return_pct_yr > 0 ? '✅' : (r.return_pct_yr > -10 ? '⚠️' : '❌');
    console.log('║ ' + r.period.padEnd(20) + ' ' + verdict + ' ALPHA ' + (r.return_pct_yr + '%').padStart(8) + ' · B&H ' + (r.bh_sp500_return_yr + '%').padStart(8) + ' · excess ' + (r.alpha_vs_bh >= 0 ? '+' : '') + r.alpha_vs_bh + '%');
  });
  const allPositive = results.every(r => r.return_pct_yr > 0);
  const allBeatBH = results.every(r => r.alpha_vs_bh > 0);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║ All bears positive? ' + (allPositive ? 'YES ✅' : 'NO ⚠️'));
  console.log('║ All beat B&H?       ' + (allBeatBH ? 'YES ✅' : 'NO ⚠️'));
  console.log('╚══════════════════════════════════════════════════════════════╝');

  await fs.writeFile(
    path.join(process.cwd(), 'data', 'sandbox', 'alpha_bear_test.json'),
    JSON.stringify({ generated: new Date().toISOString(), config: CONFIG, results, all_positive: allPositive, all_beat_bh: allBeatBH }, null, 2)
  );
  console.log('\nOutput: data/sandbox/alpha_bear_test.json');
}

main().catch(e => { console.error('bear test failed:', e); process.exit(1); });
