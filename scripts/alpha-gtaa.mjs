#!/usr/bin/env node
/**
 * Trade Genius — v11.5 ALPHA GTAA
 *
 * Global Tactical Asset Allocation (Mebane Faber 2007, validé 100 ans backtest)
 *
 * APPROCHE ULTRA SIMPLE :
 *  1. Univers : SPY (US stocks), EFA (intl developed), VWO (emerging),
 *               IEF (7-10y bonds), TLT (20+y bonds), GLD (gold), DBC (commodities)
 *  2. Pour chaque actif :
 *     - Si prix > SMA(N mois) → équipondéré dans top performers (momentum 6m)
 *     - Sinon → cash/refuge
 *  3. Rebalance fin de mois
 *  4. Variantes testées :
 *     - GTAA classic (SPY/IEF switch)
 *     - GTAA 5-asset (Faber original)
 *     - GTAA 7-asset (Faber expanded)
 *     - Dual Momentum (Antonacci)
 *
 * Test PUR OOS STRICT par année 2019-2025
 *
 * Output : data/sandbox/alpha_gtaa.json
 */
import fs from 'node:fs/promises';

function flog(msg) { process.stdout.write(msg + '\n'); }

const ASSETS_GTAA = [
  '^GSPC',  // S&P 500 (référence B&H)
  'SPY',    // US stocks
  'EFA',    // Intl developed
  'VWO',    // Emerging
  'IEF',    // 7-10y bonds
  'TLT',    // 20+y bonds
  'GLD',    // Gold
  'DBC',    // Commodities
  'VNQ',    // REITs
  'SHY',    // Short bonds (cash-like)
];

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

function momentum(prices, t, lookback) {
  if (t < lookback) return null;
  return (prices[t] / prices[t - lookback] - 1) * 100;
}

function getSlip(label) {
  if (['SPY','QQQ','IEF','TLT','GLD','SHY','EFA','VWO','VNQ','DBC'].includes(label)) return 0.05;
  if (label.startsWith('^')) return 0.10;
  return 0.15;
}

// Stratégie GTAA générique
function backtestGTAA(data, startIdx, endIdx, params, opts = {}) {
  const stress = !!opts.stress;
  const commission = opts.commission || 1;
  const slipBonus = stress ? 0.5 : 0;

  const universe = params.universe; // array of labels
  const smaLen = params.smaDays;    // SMA threshold (200 ≈ 10 months)
  const momLookback = params.momLookback || 126; // 6 months
  const topN = params.topN || 3;
  const rebalanceDays = params.rebalanceDays || 21;
  const refugeLabel = params.refuge || 'IEF';

  let cap = 1000;
  let peak = cap;
  let maxDD = 0;
  let positions = {}; // {asset: {shares, cost}}
  let lastRebalance = startIdx;
  let nTrades = 0;

  for (let t = startIdx; t < endIdx; t++) {
    // Update equity
    let equity = cap;
    for (const [asset, pos] of Object.entries(positions)) {
      const a = data.find(x => x.label === asset);
      if (a && t < a.prices.length) equity += pos.shares * a.prices[t];
    }
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDD) maxDD = dd;

    if (t - lastRebalance < rebalanceDays) continue;
    lastRebalance = t;

    // Phase 1 : filtrer univers par trend filter (prix > SMA)
    const inTrend = [];
    for (const label of universe) {
      const a = data.find(x => x.label === label);
      if (!a || t >= a.prices.length) continue;
      const price = a.prices[t];
      const smaVal = sma(a.prices, t, smaLen);
      if (smaVal == null) continue;
      if (price > smaVal) {
        const mom = momentum(a.prices, t, momLookback);
        if (mom != null) inTrend.push({ label, mom, price });
      }
    }

    // Phase 2 : rank par momentum, top N
    inTrend.sort((a, b) => b.mom - a.mom);
    const selected = inTrend.slice(0, topN);

    // Si moins de topN actifs en trend, le reste va au refuge
    const refugeWeight = (topN - selected.length) / topN;
    const targetMap = {};
    for (const s of selected) targetMap[s.label] = 1 / topN;
    if (refugeWeight > 0 && refugeLabel !== 'cash') {
      const refuge = data.find(a => a.label === refugeLabel);
      if (refuge && t < refuge.prices.length) {
        targetMap[refugeLabel] = (targetMap[refugeLabel] || 0) + refugeWeight;
      }
    }

    // Fermer positions hors target
    for (const [asset, pos] of Object.entries(positions)) {
      if (!(asset in targetMap)) {
        const a = data.find(x => x.label === asset);
        if (a && t < a.prices.length) {
          const slip = getSlip(asset) + slipBonus;
          const exit = a.prices[t] * (1 - slip / 100);
          cap += pos.shares * exit - commission;
          nTrades++;
        }
        delete positions[asset];
      }
    }

    // Ajuster positions
    const newEq = cap + Object.entries(positions).reduce((acc, [asset, pos]) => {
      const a = data.find(x => x.label === asset);
      return acc + (a && t < a.prices.length ? pos.shares * a.prices[t] : 0);
    }, 0);

    for (const [asset, weight] of Object.entries(targetMap)) {
      const a = data.find(x => x.label === asset);
      if (!a || t >= a.prices.length) continue;
      const targetVal = newEq * weight * 0.98; // 2% cash buffer
      const currentVal = positions[asset] ? positions[asset].shares * a.prices[t] : 0;
      const delta = targetVal - currentVal;
      const slip = getSlip(asset) + slipBonus;

      if (Math.abs(delta) < newEq * 0.01) continue;

      if (delta > 0 && cap > delta + 5) {
        const entry = a.prices[t] * (1 + slip / 100);
        const shares = delta / entry;
        if (positions[asset]) {
          positions[asset].shares += shares;
          positions[asset].cost += delta;
        } else {
          positions[asset] = { shares, cost: delta };
        }
        cap -= delta + commission;
        nTrades++;
      } else if (delta < 0 && positions[asset]) {
        const exit = a.prices[t] * (1 - slip / 100);
        const sharesToSell = (-delta) / a.prices[t];
        const actualVal = sharesToSell * exit;
        positions[asset].shares -= sharesToSell;
        cap += actualVal - commission;
        nTrades++;
      }
    }
  }

  // Liquidation
  for (const [asset, pos] of Object.entries(positions)) {
    const a = data.find(x => x.label === asset);
    if (a && endIdx - 1 < a.prices.length) {
      const slip = getSlip(asset) + slipBonus;
      const exit = a.prices[endIdx - 1] * (1 - slip / 100);
      cap += pos.shares * exit;
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
  flog('=== ALPHA GTAA v11.5 ===');
  flog('Global Tactical Asset Allocation (Faber/Antonacci approach)\n');

  flog('Fetching 20y data...');
  const data = [];
  for (const s of ASSETS_GTAA) {
    const p = await fetchYahoo20y(s);
    if (p && p.prices.length >= 500) {
      data.push({ label: s, prices: p.prices, timestamps: p.timestamps });
      process.stdout.write('.');
    } else process.stdout.write('x');
  }
  flog('\n' + data.length + '/' + ASSETS_GTAA.length + ' loaded\n');

  const sp = data.find(a => a.label === '^GSPC');
  function findIdx(year, month = 0, day = 1) {
    const target = new Date(year, month, day).getTime() / 1000;
    return sp.timestamps.findIndex(t => t >= target);
  }

  // Variantes à tester
  const VARIANTS = [
    {
      name: 'GTAA-classic',
      universe: ['SPY','IEF'],
      smaDays: 200, momLookback: 126, topN: 1, rebalanceDays: 21, refuge: 'IEF',
    },
    {
      name: 'GTAA-5asset',
      universe: ['SPY','EFA','IEF','GLD','DBC'],
      smaDays: 200, momLookback: 126, topN: 3, rebalanceDays: 21, refuge: 'IEF',
    },
    {
      name: 'GTAA-7asset',
      universe: ['SPY','EFA','VWO','IEF','TLT','GLD','VNQ'],
      smaDays: 200, momLookback: 126, topN: 3, rebalanceDays: 21, refuge: 'IEF',
    },
    {
      name: 'DualMom-Antonacci',
      universe: ['SPY','EFA','VWO'],
      smaDays: 200, momLookback: 252, topN: 1, rebalanceDays: 21, refuge: 'IEF',
    },
    {
      name: 'GTAA-aggressive',
      universe: ['SPY','EFA','VWO','GLD','DBC'],
      smaDays: 150, momLookback: 63, topN: 2, rebalanceDays: 21, refuge: 'TLT',
    },
    {
      name: 'GTAA-monthly10mo',
      universe: ['SPY','EFA','VWO','IEF','TLT','GLD','VNQ','DBC'],
      smaDays: 210, momLookback: 126, topN: 3, rebalanceDays: 21, refuge: 'SHY',
    },
    {
      name: 'GTAA-defensive',
      universe: ['SPY','TLT','GLD'],
      smaDays: 200, momLookback: 126, topN: 2, rebalanceDays: 21, refuge: 'SHY',
    },
  ];

  // Test sur 2019-2025 (pur OOS — pas d'optimisation, paramètres fixés a priori par littérature)
  const TARGET_YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
  const allResults = {};

  for (const variant of VARIANTS) {
    flog(`\n=== Variant ${variant.name} ===`);
    const results = [];
    for (const year of TARGET_YEARS) {
      const start = findIdx(year);
      const end = findIdx(year + 1);
      if (start < 0 || end <= start) continue;
      const r = backtestGTAA(data, start, end, variant, { stress: true, commission: 1 });
      const bh = ((sp.prices[end - 1] / sp.prices[start]) - 1) * 100 / ((end - start) / 252);
      flog(`  ${year}: ${r.ret_yr.toFixed(1)}% · DD ${r.dd.toFixed(1)}% · ${r.trades} trades · B&H ${bh.toFixed(1)}%`);
      results.push({ year, ret: r.ret_yr, dd: r.dd, trades: r.trades, bh });
    }
    allResults[variant.name] = results;
  }

  // VERDICT comparatif
  flog('\n\n╔══════════════════════════════════════════════════════════════════════════════╗');
  flog('║ GTAA VARIANTS — VERDICT FINAL (PUR OOS strict, paramètres fixés littérature) ║');
  flog('╠══════════════════════════════════════════════════════════════════════════════╣');
  flog('║ Variant              │ Med    │ Mean   │ +pos │ >B&H │ AvgDD │');
  flog('╠══════════════════════╪════════╪════════╪══════╪══════╪═══════╣');

  let best = { name: '', score: -Infinity, mean: 0 };
  for (const [name, res] of Object.entries(allResults)) {
    const rets = res.map(r => r.ret).sort((a, b) => a - b);
    const med = rets[Math.floor(rets.length / 2)];
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const pos = res.filter(r => r.ret > 0).length;
    const beat = res.filter(r => r.ret > r.bh).length;
    const avgDD = res.reduce((a, b) => a + b.dd, 0) / res.length;
    flog(`║ ${name.padEnd(20)} │ ${med.toFixed(1).padStart(5)}% │ ${mean.toFixed(1).padStart(5)}% │ ${pos}/${res.length}  │ ${beat}/${res.length}  │ ${avgDD.toFixed(1)}% │`);
    const score = mean - Math.abs(avgDD) * 0.3;
    if (score > best.score) best = { name, score, mean, med, pos, beat, avgDD };
  }
  flog('╚══════════════════════════════════════════════════════════════════════════════╝');

  // B&H benchmark
  flog('\n=== B&H S&P 500 ===');
  const bhRets = [];
  for (const year of TARGET_YEARS) {
    const start = findIdx(year);
    const end = findIdx(year + 1);
    if (start < 0 || end <= start) continue;
    const bh = ((sp.prices[end - 1] / sp.prices[start]) - 1) * 100 / ((end - start) / 252);
    bhRets.push(bh);
    flog(`  ${year}: ${bh.toFixed(1)}%`);
  }
  const bhMed = [...bhRets].sort((a, b) => a - b)[Math.floor(bhRets.length / 2)];
  const bhMean = bhRets.reduce((a, b) => a + b, 0) / bhRets.length;
  flog(`B&H S&P 500 — Med ${bhMed.toFixed(1)}% · Mean ${bhMean.toFixed(1)}%`);

  flog('\n=== BEST GTAA VARIANT ===');
  flog(`${best.name} · Médian ${best.med?.toFixed(1)}% · Mean ${best.mean.toFixed(1)}% · ${best.pos}/7 positifs · DD ${best.avgDD?.toFixed(1)}%`);

  await fs.mkdir('data/sandbox', { recursive: true });
  await fs.writeFile('data/sandbox/alpha_gtaa.json', JSON.stringify({
    variants: allResults,
    bhBenchmark: { median: bhMed, mean: bhMean, returns: bhRets },
    best,
  }, null, 2));
  flog('\nOutput: data/sandbox/alpha_gtaa.json');
}

main();
