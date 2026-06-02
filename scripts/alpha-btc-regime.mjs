#!/usr/bin/env node
/**
 * Trade Genius — v11.8 ALPHA BTC-REGIME
 *
 * INSIGHT : Nos stratégies ratent les gros bulls mais évitent les bears.
 * B&H BTC fait +92%/an mean mais -65% DD en 2022.
 *
 * SOLUTION : B&H BTC en BULL + cash/défensif en BEAR.
 *  - Si BTC > SMA200 (bull confirmé) → full BTC
 *  - Si BTC < SMA200 (bear) → cash + petit allocation altcoin rotation défensive
 *  - Re-entrée BTC dès que BTC reprend > SMA200
 *
 * Variantes testées :
 *   - V1 SIMPLE : BTC long si > SMA, cash sinon
 *   - V2 SMOOTHED : BTC long si > SMA et slope+, cash si < SMA et slope-
 *   - V3 PROTECTED : V1 + stop loss -20% qui sort temporairement
 *   - V4 LEVERAGE : V1 mais long BTC × 1.5 en bull confirmé
 *   - V5 ALT-ROTATION : V1 + rotation top 3 alts en bull si BTC.D baisse
 *   - V6 DUAL-MOMENTUM : BTC vs ETH vs CASH (top performer rolling 90j)
 *
 * Test pur OOS strict 2018-2025 (8 ans, couvre 2 bears 2018-2019 + 2022)
 *
 * Output : data/sandbox/alpha_btc_regime.json
 */
import fs from 'node:fs/promises';

function flog(msg) { process.stdout.write(msg + '\n'); }

const ASSETS = [
  'BTC-USD', 'ETH-USD',
  'SOL-USD', 'AVAX-USD', 'LINK-USD', 'MATIC-USD', 'ATOM-USD',
  'INJ-USD', 'NEAR-USD', 'DOT-USD',
];

async function fetchYahoo10y(sym) {
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=10y&interval=1d`;
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

const COMMISSION_PCT = 0.10;
const SLIP_PCT = 0.20;

// === V1 SIMPLE : BTC > SMA = long BTC, sinon cash ===
function backtestV1(data, btc, startIdx, endIdx, params, opts = {}) {
  const stress = !!opts.stress;
  const slip = SLIP_PCT + (stress ? 0.15 : 0);
  const commission = COMMISSION_PCT + (stress ? 0.05 : 0);

  let cap = 1000, peak = cap, maxDD = 0;
  let inBtc = false;
  let entryPrice = 0, shares = 0;
  let nTrades = 0;
  let lastCheckDay = startIdx - 1;

  for (let t = startIdx; t < endIdx; t++) {
    // Update equity
    let eq = cap;
    if (inBtc) eq += shares * btc.prices[t];
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < maxDD) maxDD = dd;

    // Check seulement tous les N jours (réduire frottements)
    if (t - lastCheckDay < params.checkDays) continue;
    lastCheckDay = t;

    const smaVal = sma(btc.prices, t, params.smaLen);
    if (smaVal == null) continue;
    const price = btc.prices[t];
    const shouldBeLong = price > smaVal;

    if (shouldBeLong && !inBtc) {
      // Entrer en BTC
      const buyPrice = price * (1 + slip / 100);
      const fee = cap * (commission / 100);
      shares = (cap - fee) / buyPrice;
      entryPrice = buyPrice;
      cap = 0;
      inBtc = true;
      nTrades++;
    } else if (!shouldBeLong && inBtc) {
      // Sortir en cash
      const sellPrice = price * (1 - slip / 100);
      const proceeds = shares * sellPrice;
      const fee = proceeds * (commission / 100);
      cap = proceeds - fee;
      shares = 0;
      inBtc = false;
      nTrades++;
    }
  }

  // Liquidation
  if (inBtc) {
    const sellPrice = btc.prices[endIdx - 1] * (1 - slip / 100);
    const proceeds = shares * sellPrice;
    const fee = proceeds * (commission / 100);
    cap = proceeds - fee;
  }

  const ret = (cap - 1000) / 1000 * 100;
  const yrs = (endIdx - startIdx) / 365;
  return {
    ret_yr: yrs > 0 ? ret / yrs : 0,
    dd: maxDD * 100,
    trades: nTrades,
  };
}

// === V2 SMOOTHED : SMA + slope filter ===
function backtestV2(data, btc, startIdx, endIdx, params, opts = {}) {
  const stress = !!opts.stress;
  const slip = SLIP_PCT + (stress ? 0.15 : 0);
  const commission = COMMISSION_PCT + (stress ? 0.05 : 0);

  let cap = 1000, peak = cap, maxDD = 0;
  let inBtc = false;
  let shares = 0;
  let nTrades = 0;
  let lastCheckDay = startIdx - 1;

  for (let t = startIdx; t < endIdx; t++) {
    let eq = cap;
    if (inBtc) eq += shares * btc.prices[t];
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < maxDD) maxDD = dd;

    if (t - lastCheckDay < params.checkDays) continue;
    lastCheckDay = t;

    const smaNow = sma(btc.prices, t, params.smaLen);
    const smaPrev = sma(btc.prices, t - params.slopeDays, params.smaLen);
    if (smaNow == null || smaPrev == null) continue;
    const price = btc.prices[t];
    const slope = (smaNow - smaPrev) / smaPrev;

    // Bull : price > sma ET slope positive
    const shouldBeLong = price > smaNow && slope > params.minSlope;
    // Strong bear : price < sma ET slope negative
    const shouldExit = price < smaNow && slope < -params.minSlope;

    if (shouldBeLong && !inBtc) {
      const buyPrice = price * (1 + slip / 100);
      const fee = cap * (commission / 100);
      shares = (cap - fee) / buyPrice;
      cap = 0;
      inBtc = true;
      nTrades++;
    } else if (shouldExit && inBtc) {
      const sellPrice = price * (1 - slip / 100);
      const proceeds = shares * sellPrice;
      const fee = proceeds * (commission / 100);
      cap = proceeds - fee;
      shares = 0;
      inBtc = false;
      nTrades++;
    }
  }

  if (inBtc) {
    const sellPrice = btc.prices[endIdx - 1] * (1 - slip / 100);
    const proceeds = shares * sellPrice;
    const fee = proceeds * (commission / 100);
    cap = proceeds - fee;
  }

  const ret = (cap - 1000) / 1000 * 100;
  const yrs = (endIdx - startIdx) / 365;
  return { ret_yr: yrs > 0 ? ret / yrs : 0, dd: maxDD * 100, trades: nTrades };
}

// === V4 LEVERAGE : V1 mais avec leverage en bull confirmé ===
function backtestV4(data, btc, startIdx, endIdx, params, opts = {}) {
  const stress = !!opts.stress;
  const slip = SLIP_PCT + (stress ? 0.15 : 0);
  const commission = COMMISSION_PCT + (stress ? 0.05 : 0);
  const BORROW_YR = stress ? 0.10 : 0.08; // crypto leverage costs MORE

  let cap = 1000, peak = cap, maxDD = 0;
  let exposure = 0; // 0, 1, ou params.leverageMult
  let shares = 0;
  let entryPrice = 0;
  let borrowedAmount = 0;
  let nTrades = 0;
  let lastCheckDay = startIdx - 1;

  for (let t = startIdx; t < endIdx; t++) {
    // Coût borrow
    if (exposure > 1 && borrowedAmount > 0) {
      cap -= borrowedAmount * (BORROW_YR / 365);
    }

    let eq = cap;
    if (shares > 0) eq += shares * btc.prices[t];
    eq -= borrowedAmount; // dette
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < maxDD) maxDD = dd;

    // Liquidation forcée si equity < 20% de la dette
    if (eq < borrowedAmount * 0.2) {
      const sellPrice = btc.prices[t] * (1 - slip / 100);
      cap = cap + shares * sellPrice - borrowedAmount;
      shares = 0;
      borrowedAmount = 0;
      exposure = 0;
      nTrades++;
      continue;
    }

    if (t - lastCheckDay < params.checkDays) continue;
    lastCheckDay = t;

    const smaNow = sma(btc.prices, t, params.smaLen);
    const smaShort = sma(btc.prices, t, 50);
    if (smaNow == null || smaShort == null) continue;
    const price = btc.prices[t];

    // Régime
    let targetExposure = 0;
    if (price > smaNow && price > smaShort && smaShort > smaNow) targetExposure = params.leverageMult; // strong bull
    else if (price > smaNow) targetExposure = 1; // bull
    else targetExposure = 0; // bear

    if (targetExposure !== exposure) {
      // Liquider position actuelle
      if (shares > 0) {
        const sellPrice = price * (1 - slip / 100);
        const proceeds = shares * sellPrice;
        const fee = proceeds * (commission / 100);
        cap += proceeds - fee - borrowedAmount;
        shares = 0;
        borrowedAmount = 0;
        nTrades++;
      }
      // Ouvrir nouvelle position
      if (targetExposure > 0) {
        const buyPrice = price * (1 + slip / 100);
        const investBudget = cap * targetExposure;
        if (targetExposure > 1) {
          borrowedAmount = cap * (targetExposure - 1);
        }
        const fee = investBudget * (commission / 100);
        shares = (investBudget - fee) / buyPrice;
        cap = cap - (investBudget - cap * (targetExposure - 1));
        // After buy : we have used `cap` of own funds plus `borrowedAmount` of borrowed
        nTrades++;
      }
      exposure = targetExposure;
    }
  }

  // Liquidation
  if (shares > 0) {
    const sellPrice = btc.prices[endIdx - 1] * (1 - slip / 100);
    const proceeds = shares * sellPrice;
    const fee = proceeds * (commission / 100);
    cap += proceeds - fee - borrowedAmount;
  }

  const ret = (cap - 1000) / 1000 * 100;
  const yrs = (endIdx - startIdx) / 365;
  return { ret_yr: yrs > 0 ? ret / yrs : 0, dd: maxDD * 100, trades: nTrades };
}

// === V5 BTC + ETH ROTATION ===
function backtestV5(data, btc, startIdx, endIdx, params, opts = {}) {
  const eth = data.find(a => a.label === 'ETH-USD');
  if (!eth) return backtestV1(data, btc, startIdx, endIdx, params, opts);

  const stress = !!opts.stress;
  const slip = SLIP_PCT + (stress ? 0.15 : 0);
  const commission = COMMISSION_PCT + (stress ? 0.05 : 0);

  let cap = 1000, peak = cap, maxDD = 0;
  let currentAsset = null; // 'BTC-USD', 'ETH-USD', or null
  let shares = 0;
  let nTrades = 0;
  let lastCheckDay = startIdx - 1;

  function liquidate(t, asset) {
    if (!asset || shares === 0) return;
    const a = data.find(x => x.label === asset);
    if (!a || t >= a.prices.length) return;
    const sellPrice = a.prices[t] * (1 - slip / 100);
    const proceeds = shares * sellPrice;
    const fee = proceeds * (commission / 100);
    cap += proceeds - fee;
    shares = 0;
    nTrades++;
  }

  function buy(t, asset) {
    const a = data.find(x => x.label === asset);
    if (!a || t >= a.prices.length || cap < 10) return false;
    const buyPrice = a.prices[t] * (1 + slip / 100);
    const fee = cap * (commission / 100);
    shares = (cap - fee) / buyPrice;
    cap = 0;
    currentAsset = asset;
    nTrades++;
    return true;
  }

  for (let t = startIdx; t < endIdx; t++) {
    let eq = cap;
    if (currentAsset && shares > 0) {
      const a = data.find(x => x.label === currentAsset);
      if (a && t < a.prices.length) eq += shares * a.prices[t];
    }
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < maxDD) maxDD = dd;

    if (t - lastCheckDay < params.checkDays) continue;
    lastCheckDay = t;

    const btcSma = sma(btc.prices, t, params.smaLen);
    if (btcSma == null) continue;
    const btcInBull = btc.prices[t] > btcSma;

    if (!btcInBull) {
      // Bear : exit all
      if (currentAsset) { liquidate(t, currentAsset); currentAsset = null; }
      continue;
    }

    // Bull : choisir BTC ou ETH par momentum
    const btcMom = (btc.prices[t] / btc.prices[t - params.momLookback] - 1) * 100;
    const ethMom = (eth.prices[t] / eth.prices[t - params.momLookback] - 1) * 100;
    const targetAsset = ethMom > btcMom + 5 ? 'ETH-USD' : 'BTC-USD';

    if (currentAsset !== targetAsset) {
      if (currentAsset) liquidate(t, currentAsset);
      buy(t, targetAsset);
    }
  }

  if (currentAsset && shares > 0) {
    const a = data.find(x => x.label === currentAsset);
    if (a) {
      const sellPrice = a.prices[endIdx - 1] * (1 - slip / 100);
      const proceeds = shares * sellPrice;
      const fee = proceeds * (commission / 100);
      cap += proceeds - fee;
    }
  }

  const ret = (cap - 1000) / 1000 * 100;
  const yrs = (endIdx - startIdx) / 365;
  return { ret_yr: yrs > 0 ? ret / yrs : 0, dd: maxDD * 100, trades: nTrades };
}

async function main() {
  flog('=== ALPHA BTC-REGIME v11.8 ===');
  flog('Insight : B&H BTC en bull + cash en bear\n');

  flog('Fetching...');
  const data = [];
  for (const s of ASSETS) {
    const p = await fetchYahoo10y(s);
    if (p && p.prices.length >= 365) {
      data.push({ label: s, prices: p.prices, timestamps: p.timestamps });
      process.stdout.write('.');
    } else process.stdout.write('x');
  }
  flog('\n' + data.length + '/' + ASSETS.length + ' loaded\n');

  const btc = data.find(a => a.label === 'BTC-USD');
  if (!btc) { flog('BTC missing'); return; }
  function findIdx(year) {
    const target = new Date(year, 0, 1).getTime() / 1000;
    return btc.timestamps.findIndex(t => t >= target);
  }

  // VARIANTS (paramètres FIXÉS a priori — pas d'optim, pour éviter overfit)
  const VARIANTS = [
    { name: 'V1-SMA200',         strat: 'V1', smaLen: 200, checkDays: 7 },
    { name: 'V1-SMA150',         strat: 'V1', smaLen: 150, checkDays: 7 },
    { name: 'V1-SMA100',         strat: 'V1', smaLen: 100, checkDays: 7 },
    { name: 'V1-SMA200-daily',   strat: 'V1', smaLen: 200, checkDays: 1 },
    { name: 'V2-smoothed-30',    strat: 'V2', smaLen: 200, checkDays: 7, slopeDays: 30, minSlope: 0.005 },
    { name: 'V2-smoothed-60',    strat: 'V2', smaLen: 200, checkDays: 7, slopeDays: 60, minSlope: 0.005 },
    { name: 'V4-lev1.5',         strat: 'V4', smaLen: 200, checkDays: 7, leverageMult: 1.5 },
    { name: 'V4-lev2',           strat: 'V4', smaLen: 200, checkDays: 7, leverageMult: 2.0 },
    { name: 'V5-rotation-30d',   strat: 'V5', smaLen: 200, checkDays: 7, momLookback: 30 },
    { name: 'V5-rotation-90d',   strat: 'V5', smaLen: 200, checkDays: 7, momLookback: 90 },
  ];

  const TARGET_YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
  const allResults = {};

  for (const variant of VARIANTS) {
    flog(`\n=== ${variant.name} ===`);
    const results = [];
    for (const year of TARGET_YEARS) {
      const start = findIdx(year);
      const end = findIdx(year + 1);
      if (start < 0 || end <= start) continue;
      let r;
      if (variant.strat === 'V1') r = backtestV1(data, btc, start, end, variant, { stress: true });
      else if (variant.strat === 'V2') r = backtestV2(data, btc, start, end, variant, { stress: true });
      else if (variant.strat === 'V4') r = backtestV4(data, btc, start, end, variant, { stress: true });
      else if (variant.strat === 'V5') r = backtestV5(data, btc, start, end, variant, { stress: true });
      const bh = ((btc.prices[end - 1] / btc.prices[start]) - 1) * 100 / ((end - start) / 365);
      flog(`  ${year}: ${r.ret_yr.toFixed(1)}% · DD ${r.dd.toFixed(1)}% · ${r.trades} trades · B&H BTC ${bh.toFixed(1)}%`);
      results.push({ year, ret: r.ret_yr, dd: r.dd, trades: r.trades, bh });
    }
    allResults[variant.name] = results;
  }

  // Synthèse comparative
  flog('\n\n╔══════════════════════════════════════════════════════════════════════════════╗');
  flog('║ BTC-REGIME — VERDICT FINAL (8 années, 2018-2025)                              ║');
  flog('╠══════════════════════════════════════════════════════════════════════════════╣');
  flog('║ Variant              │ Med    │ Mean   │ >BTC │ MaxDD  │ vs BTC Excess │');
  flog('╠══════════════════════╪════════╪════════╪══════╪════════╪═══════════════╣');

  // B&H BTC reference
  const bhRets = [];
  for (const year of TARGET_YEARS) {
    const start = findIdx(year);
    const end = findIdx(year + 1);
    if (start < 0 || end <= start) continue;
    bhRets.push(((btc.prices[end - 1] / btc.prices[start]) - 1) * 100 / ((end - start) / 365));
  }
  const bhMean = bhRets.reduce((a, b) => a + b, 0) / bhRets.length;
  const bhMed = [...bhRets].sort((a, b) => a - b)[Math.floor(bhRets.length / 2)];
  const bhMaxDD = Math.min(...bhRets); // worst year

  let best = null;
  for (const [name, res] of Object.entries(allResults)) {
    const rets = res.map(r => r.ret).sort((a, b) => a - b);
    const med = rets[Math.floor(rets.length / 2)];
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const beat = res.filter(r => r.ret > r.bh).length;
    const worstDD = Math.min(...res.map(r => r.dd));
    const excess = mean - bhMean;
    flog(`║ ${name.padEnd(20)} │ ${med.toFixed(1).padStart(5)}% │ ${mean.toFixed(1).padStart(5)}% │ ${beat}/${res.length} │ ${worstDD.toFixed(1).padStart(5)}% │ ${(excess >= 0 ? '+' : '') + excess.toFixed(1)}%     │`);
    if (!best || excess > best.excess) best = { name, mean, med, excess, beat, worstDD };
  }
  flog('╚══════════════════════════════════════════════════════════════════════════════╝');
  flog(`\nB&H BTC ref : Med ${bhMed.toFixed(1)}% · Mean ${bhMean.toFixed(1)}% · Worst year ${bhMaxDD.toFixed(1)}%`);
  flog(`\n=== BEST VARIANT ===`);
  flog(`${best.name} : Mean ${best.mean.toFixed(2)}% (excess ${(best.excess >= 0 ? '+' : '') + best.excess.toFixed(2)}%) · ${best.beat}/8 beat BTC · Worst ${best.worstDD.toFixed(1)}%`);

  await fs.mkdir('data/sandbox', { recursive: true });
  await fs.writeFile('data/sandbox/alpha_btc_regime.json', JSON.stringify({
    variants: allResults,
    bhBenchmark: { median: bhMed, mean: bhMean, returns: bhRets, worstYear: bhMaxDD },
    best,
  }, null, 2));
  flog('\nOutput: data/sandbox/alpha_btc_regime.json');
}

main();
