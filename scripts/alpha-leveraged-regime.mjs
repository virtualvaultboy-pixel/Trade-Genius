#!/usr/bin/env node
/**
 * Trade Genius — v11.6 ALPHA LEVERAGED-REGIME
 *
 * Dernier essai logique : si on ne peut pas battre B&H par stock-picking,
 * on essaie d'AMPLIFIER B&H avec gestion de risque :
 *
 *  - En BULL confirmé (SPY > SMA200 + slope+ + low vol) : leverage 1.3-1.5x SPY
 *  - En SIDEWAYS : 100% SPY
 *  - En BEAR (SPY < SMA200) : 50% SPY + 50% TLT (réduit DD)
 *  - En CRASH (DD > 15% en 30j) : 100% cash 30j puis reentrée si SPY > SMA50
 *
 * Coût leverage = borrow 6% annuel
 * Test PUR OOS strict par année 2019-2025
 */
import fs from 'node:fs/promises';

function flog(msg) { process.stdout.write(msg + '\n'); }

const ASSETS = ['^GSPC', 'SPY', 'TLT', 'IEF', 'GLD'];

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

function sma(prices, t, n) {
  if (t < n) return null;
  let s = 0;
  for (let i = t - n + 1; i <= t; i++) s += prices[i];
  return s / n;
}

function realizedVol(prices, t, lookback = 60) {
  if (t < lookback + 1) return null;
  const rets = [];
  for (let i = t - lookback + 1; i <= t; i++) {
    rets.push(Math.log(prices[i] / prices[i - 1]));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) * (r - mean), 0) / rets.length;
  return Math.sqrt(variance) * Math.sqrt(252);
}

function detectRegime(spy, t, params) {
  const sma200 = sma(spy, t, params.smaLen);
  const sma50 = sma(spy, t, 50);
  if (sma200 == null || sma50 == null) return 'neutral';
  const price = spy[t];
  const slope = t >= 50 + params.smaLen ? (sma200 - sma(spy, t - 50, params.smaLen)) / sma(spy, t - 50, params.smaLen) : 0;
  const vol = realizedVol(spy, t, 60);

  // Crash récent (DD > 15% sur 30 derniers j)
  if (t > 30) {
    const recentHigh = Math.max(...spy.slice(t - 30, t + 1));
    const recentDD = (price - recentHigh) / recentHigh;
    if (recentDD < -0.15) return 'crash';
  }

  if (price > sma200 && slope > 0.005 && vol < 0.20) return 'bull-strong';
  if (price > sma200 && slope > 0) return 'bull';
  if (price > sma200) return 'sideways-up';
  if (price < sma200 && slope < -0.005) return 'bear-deep';
  if (price < sma200) return 'bear';
  return 'neutral';
}

function backtest(data, startIdx, endIdx, params, opts = {}) {
  const stress = !!opts.stress;
  const commission = opts.commission || 1;
  const slipBonus = stress ? 0.5 : 0;
  const BORROW_YR = stress ? 0.07 : 0.05;

  const spy = data.find(a => a.label === 'SPY');
  const tlt = data.find(a => a.label === 'TLT');
  const ief = data.find(a => a.label === 'IEF');
  if (!spy || !tlt) return { ret_yr: 0, dd: 0, trades: 0 };

  let cap = 1000;
  let peak = cap;
  let maxDD = 0;
  let nTrades = 0;
  let positions = { SPY: 0, TLT: 0, IEF: 0 }; // shares
  let entry = { SPY: 0, TLT: 0, IEF: 0 }; // cost basis
  let leverage = 1;
  let lastRebalance = startIdx;
  let crashCooldown = 0;

  function getEquity(t) {
    let eq = cap;
    if (positions.SPY > 0 && t < spy.prices.length) eq += positions.SPY * spy.prices[t];
    if (positions.TLT > 0 && t < tlt.prices.length) eq += positions.TLT * tlt.prices[t];
    if (positions.IEF > 0 && ief && t < ief.prices.length) eq += positions.IEF * ief.prices[t];
    // Coût leverage
    if (leverage > 1) eq -= cap * (leverage - 1) * (BORROW_YR / 252);
    return eq;
  }

  for (let t = startIdx; t < endIdx; t++) {
    // Update DD
    const eq = getEquity(t);
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < maxDD) maxDD = dd;

    if (crashCooldown > 0) crashCooldown--;

    if (t - lastRebalance < params.rebalanceDays) continue;
    lastRebalance = t;

    const regime = detectRegime(spy.prices, t, params);

    // Cible allocation selon régime
    let target = { SPY: 0, TLT: 0, IEF: 0 };
    let targetLev = 1;
    if (crashCooldown > 0) {
      target = { SPY: 0, TLT: 0, IEF: 1.0 }; // refuge total
      targetLev = 1;
    } else if (regime === 'crash') {
      // Entrer crash mode
      target = { SPY: 0, TLT: 0, IEF: 1.0 };
      targetLev = 1;
      crashCooldown = 30;
    } else if (regime === 'bull-strong') {
      target = { SPY: 1.0, TLT: 0, IEF: 0 };
      targetLev = params.bullLeverage; // 1.3-1.5x
    } else if (regime === 'bull') {
      target = { SPY: 1.0, TLT: 0, IEF: 0 };
      targetLev = 1.1;
    } else if (regime === 'sideways-up') {
      target = { SPY: 0.85, TLT: 0.15, IEF: 0 };
      targetLev = 1;
    } else if (regime === 'bear') {
      target = { SPY: 0.4, TLT: 0.6, IEF: 0 };
      targetLev = 1;
    } else if (regime === 'bear-deep') {
      target = { SPY: 0.2, TLT: 0.5, IEF: 0.3 };
      targetLev = 1;
    } else {
      target = { SPY: 0.7, TLT: 0.3, IEF: 0 };
      targetLev = 1;
    }

    // Réajuster positions
    const newEq = getEquity(t);
    leverage = targetLev;
    const investBudget = newEq * targetLev;

    for (const asset of ['SPY', 'TLT', 'IEF']) {
      const a = data.find(x => x.label === asset);
      if (!a || t >= a.prices.length) continue;
      const slip = 0.05 + slipBonus;
      const targetVal = investBudget * target[asset];
      const currentVal = positions[asset] * a.prices[t];
      const delta = targetVal - currentVal;

      if (Math.abs(delta) < newEq * 0.02) continue;

      if (delta > 0 && cap > delta + 5) {
        const buyPrice = a.prices[t] * (1 + slip / 100);
        const shares = delta / buyPrice;
        positions[asset] += shares;
        entry[asset] = (entry[asset] * (positions[asset] - shares) + delta) / Math.max(positions[asset], 0.0001);
        cap -= delta + commission;
        nTrades++;
      } else if (delta < 0 && positions[asset] > 0) {
        const exitPrice = a.prices[t] * (1 - slip / 100);
        const sharesToSell = Math.min(positions[asset], (-delta) / a.prices[t]);
        cap += sharesToSell * exitPrice - commission;
        positions[asset] -= sharesToSell;
        nTrades++;
      }
    }
  }

  // Liquidation
  for (const asset of ['SPY', 'TLT', 'IEF']) {
    const a = data.find(x => x.label === asset);
    if (a && endIdx - 1 < a.prices.length && positions[asset] > 0) {
      const slip = 0.05 + slipBonus;
      const exit = a.prices[endIdx - 1] * (1 - slip / 100);
      cap += positions[asset] * exit;
      positions[asset] = 0;
    }
  }

  const ret = (cap - 1000) / 1000 * 100;
  const yrs = (endIdx - startIdx) / 252;
  return {
    ret_yr: yrs > 0 ? ret / yrs : 0,
    dd: maxDD * 100,
    trades: nTrades,
  };
}

async function main() {
  flog('=== ALPHA LEVERAGED-REGIME v11.6 ===');
  flog('Dernier essai : amplifier B&H par regime detection + leverage\n');

  flog('Fetching...');
  const data = [];
  for (const s of ASSETS) {
    const p = await fetchYahoo20y(s);
    if (p) {
      data.push({ label: s, prices: p.prices, timestamps: p.timestamps });
      process.stdout.write('.');
    } else process.stdout.write('x');
  }
  flog('\n' + data.length + '/' + ASSETS.length + ' loaded\n');

  const sp = data.find(a => a.label === '^GSPC');
  function findIdx(year) {
    const target = new Date(year, 0, 1).getTime() / 1000;
    return sp.timestamps.findIndex(t => t >= target);
  }

  const VARIANTS = [
    { name: 'LEV-1.3', smaLen: 200, bullLeverage: 1.3, rebalanceDays: 21 },
    { name: 'LEV-1.5', smaLen: 200, bullLeverage: 1.5, rebalanceDays: 21 },
    { name: 'LEV-1.7', smaLen: 200, bullLeverage: 1.7, rebalanceDays: 21 },
    { name: 'LEV-2.0', smaLen: 200, bullLeverage: 2.0, rebalanceDays: 21 },
    { name: 'LEV-1.5-sma150', smaLen: 150, bullLeverage: 1.5, rebalanceDays: 21 },
    { name: 'LEV-1.5-weekly', smaLen: 200, bullLeverage: 1.5, rebalanceDays: 5 },
    { name: 'LEV-1.3-quarterly', smaLen: 200, bullLeverage: 1.3, rebalanceDays: 63 },
  ];

  // Test long-range : 2010-2025 (15 ans, inclut 2 vrais bear)
  const TARGET_YEARS = [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
  const allResults = {};

  for (const variant of VARIANTS) {
    flog(`\n=== ${variant.name} ===`);
    const results = [];
    for (const year of TARGET_YEARS) {
      const start = findIdx(year);
      const end = findIdx(year + 1);
      if (start < 0 || end <= start) continue;
      const r = backtest(data, start, end, variant, { stress: true, commission: 1 });
      const bh = ((sp.prices[end - 1] / sp.prices[start]) - 1) * 100 / ((end - start) / 252);
      results.push({ year, ret: r.ret_yr, dd: r.dd, trades: r.trades, bh });
    }
    allResults[variant.name] = results;
    const rets = results.map(r => r.ret).sort((a, b) => a - b);
    const med = rets[Math.floor(rets.length / 2)];
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const beat = results.filter(r => r.ret > r.bh).length;
    const ddAvg = results.reduce((a, b) => a + b.dd, 0) / results.length;
    flog(`  Med ${med.toFixed(1)}% · Mean ${mean.toFixed(1)}% · ${beat}/${results.length} beat B&H · AvgDD ${ddAvg.toFixed(1)}%`);
  }

  // B&H benchmark
  const bhRets = [];
  for (const year of TARGET_YEARS) {
    const start = findIdx(year);
    const end = findIdx(year + 1);
    if (start < 0 || end <= start) continue;
    bhRets.push(((sp.prices[end - 1] / sp.prices[start]) - 1) * 100 / ((end - start) / 252));
  }
  const bhMean = bhRets.reduce((a, b) => a + b, 0) / bhRets.length;
  const bhMed = [...bhRets].sort((a, b) => a - b)[Math.floor(bhRets.length / 2)];

  flog('\n\n╔══════════════════════════════════════════════════════════════════════════════╗');
  flog('║ LEVERAGED-REGIME — VERDICT (16 années, 2010-2025)                            ║');
  flog('╠══════════════════════════════════════════════════════════════════════════════╣');
  flog('║ Variant              │ Med    │ Mean   │ >B&H  │ AvgDD  │ vs B&H Excess │');
  flog('╠══════════════════════╪════════╪════════╪═══════╪════════╪═══════════════╣');
  let best = null;
  for (const [name, res] of Object.entries(allResults)) {
    const rets = res.map(r => r.ret).sort((a, b) => a - b);
    const med = rets[Math.floor(rets.length / 2)];
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const beat = res.filter(r => r.ret > r.bh).length;
    const avgDD = res.reduce((a, b) => a + b.dd, 0) / res.length;
    const excess = mean - bhMean;
    flog(`║ ${name.padEnd(20)} │ ${med.toFixed(1).padStart(5)}% │ ${mean.toFixed(1).padStart(5)}% │ ${beat}/${res.length} │ ${avgDD.toFixed(1).padStart(5)}% │ ${(excess >= 0 ? '+' : '') + excess.toFixed(1)}%     │`);
    if (!best || excess > best.excess) best = { name, mean, med, excess, beat, avgDD };
  }
  flog('╚══════════════════════════════════════════════════════════════════════════════╝');
  flog(`\nB&H S&P 500 — Med ${bhMed.toFixed(1)}% · Mean ${bhMean.toFixed(1)}% sur ${bhRets.length} ans`);
  flog(`\n=== BEST VARIANT : ${best.name} ===`);
  flog(`Mean ${best.mean.toFixed(2)}% (excess ${(best.excess >= 0 ? '+' : '') + best.excess.toFixed(2)}%) · ${best.beat}/16 beat B&H · DD ${best.avgDD.toFixed(1)}%`);

  await fs.mkdir('data/sandbox', { recursive: true });
  await fs.writeFile('data/sandbox/alpha_leveraged_regime.json', JSON.stringify({
    variants: allResults,
    bhBenchmark: { median: bhMed, mean: bhMean, returns: bhRets },
    best,
  }, null, 2));
  flog('\nOutput: data/sandbox/alpha_leveraged_regime.json');
}

main();
