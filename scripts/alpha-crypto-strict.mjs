#!/usr/bin/env node
/**
 * Trade Genius — v11.7 ALPHA CRYPTO STRICT
 *
 * On change d'arène : crypto au lieu d'actions US.
 * Pourquoi ?
 *  - Marché 24/7, plus volatil (~80% vol vs 18% SPY)
 *  - Dominé par le retail, pas par les hedge funds → patterns techniques marchent encore
 *  - Plus de mouvements explosifs (SOL +1000%, etc.)
 *
 * Test PUR OOS STRICT par année 2019-2025 :
 *   Pour chaque année Y :
 *   1. Bayesian optim sur 2019→Y-1 SEULEMENT
 *   2. Sélectionne top 3 configs
 *   3. Test BLIND sur Y avec stress max
 *
 * Stratégies testées (en parallèle) :
 *   - DONCHIAN-BREAKOUT (Turtle Traders : new 20-day high)
 *   - MOMENTUM-ROTATION (top N crypto par return 30j, rebalance hebdo)
 *   - MEAN-REVERSION (RSI<20 oversold + BB lower band)
 *   - TREND-FOLLOW (SMA20 cross SMA60, ADX>25)
 *
 * Output : data/sandbox/alpha_crypto_strict.json
 */
import fs from 'node:fs/promises';

function flog(msg) { process.stdout.write(msg + '\n'); }

let _seed = 33333;
function setSeed(s) { _seed = s; }
function rand() {
  _seed |= 0; _seed = _seed + 0x6D2B79F5 | 0;
  let t = Math.imul(_seed ^ _seed >>> 15, 1 | _seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}
function gaussian(mu, sigma) {
  const u1 = Math.max(0.001, rand()), u2 = rand();
  return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
function clamp(x, mn, mx) { return Math.max(mn, Math.min(mx, x)); }
function snap(v, s) { return Math.round(v / s) * s; }

const CRYPTO_UNIVERSE = [
  // Majors
  'BTC-USD', 'ETH-USD',
  // L1 mid-cap (les vrais movers en bull market)
  'SOL-USD', 'AVAX-USD', 'NEAR-USD', 'ATOM-USD', 'DOT-USD', 'ADA-USD',
  'LINK-USD', 'INJ-USD', 'FTM-USD', 'ALGO-USD',
  // DeFi
  'UNI-USD', 'AAVE-USD', 'LDO-USD', 'CRV-USD', 'MKR-USD',
  // Layer 2
  'MATIC-USD',
  // AI / narratives
  'FET-USD', 'AGIX-USD', 'RNDR-USD',
  // Memecoins (extrême vol)
  'DOGE-USD', 'SHIB-USD',
  // Privacy / payments
  'XRP-USD', 'LTC-USD', 'BCH-USD', 'XLM-USD',
];

const SLIPPAGE_DEFAULT = 0.20; // % par côté
const COMMISSION_PCT = 0.10;   // % par trade (Binance taker fee réaliste)

// === STRATÉGIE 1 : DONCHIAN BREAKOUT (Turtle Traders) ===
function backtestDonchian(data, btc, startIdx, endIdx, params, opts = {}) {
  const stress = !!opts.stress;
  const slip = SLIPPAGE_DEFAULT + (stress ? 0.20 : 0);
  const commission = COMMISSION_PCT + (stress ? 0.05 : 0);

  let cap = 1000, peak = cap, maxDD = 0;
  let positions = {};
  const trades = [];

  for (let t = startIdx; t < endIdx; t++) {
    // Update equity & DD
    let eq = cap;
    for (const [asset, pos] of Object.entries(positions)) {
      const a = data.find(x => x.label === asset);
      if (a && t < a.prices.length) eq += pos.shares * a.prices[t];
    }
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < maxDD) maxDD = dd;

    // BTC dump filter
    let btcDump = false;
    if (btc && t > 0 && t < btc.prices.length) {
      const btcRet = (btc.prices[t] - btc.prices[t - 1]) / btc.prices[t - 1];
      if (btcRet < -0.05) btcDump = true;
    }

    // === Manage open positions : trailing stop + timeout ===
    for (const [asset, pos] of Object.entries(positions)) {
      const a = data.find(x => x.label === asset);
      if (!a || t >= a.prices.length) continue;
      const price = a.prices[t];
      pos.days++;
      if (price > pos.peak) pos.peak = price;
      const trail = pos.peak * (1 - params.trailingPct / 100);

      const exitReason =
        price <= trail ? 'trail' :
        pos.days >= params.maxHold ? 'timeout' :
        price <= pos.stop ? 'stop' :
        null;
      if (exitReason) {
        const exitPrice = price * (1 - slip / 100);
        const proceeds = pos.shares * exitPrice;
        const fee = proceeds * (commission / 100);
        cap += proceeds - fee;
        const pnlPct = ((exitPrice - pos.entry) / pos.entry) * 100;
        trades.push({ asset, pnlPct, reason: exitReason });
        delete positions[asset];
      }
    }

    // === Open new positions : Donchian breakout ===
    if (!btcDump && Object.keys(positions).length < params.maxPos) {
      const cands = [];
      for (const a of data) {
        if (t < params.lookback || t >= a.prices.length) continue;
        if (positions[a.label]) continue;
        const window = a.prices.slice(t - params.lookback, t);
        const high = Math.max(...window);
        const low = Math.min(...window);
        const price = a.prices[t];
        // Breakout = nouveau high
        if (price > high * (1 + params.breakoutPct / 100)) {
          // Filtre volatilité minimale
          const range = (high - low) / low;
          if (range >= params.minRange) {
            cands.push({ a, price, strength: range });
          }
        }
      }
      cands.sort((x, y) => y.strength - x.strength);
      for (let i = 0; i < Math.min(params.maxPos - Object.keys(positions).length, cands.length); i++) {
        const c = cands[i];
        const sizeUsd = cap * (params.sizingPct / 100);
        if (sizeUsd < 5 || cap < sizeUsd) continue;
        const entryPrice = c.price * (1 + slip / 100);
        const fee = sizeUsd * (commission / 100);
        const shares = (sizeUsd - fee) / entryPrice;
        positions[c.a.label] = {
          entry: entryPrice,
          shares,
          peak: entryPrice,
          stop: entryPrice * (1 - params.stopPct / 100),
          days: 0,
        };
        cap -= sizeUsd;
      }
    }
  }

  // Liquidation
  for (const [asset, pos] of Object.entries(positions)) {
    const a = data.find(x => x.label === asset);
    if (a && endIdx - 1 < a.prices.length) {
      const price = a.prices[endIdx - 1];
      const exitPrice = price * (1 - slip / 100);
      const proceeds = pos.shares * exitPrice;
      const fee = proceeds * (commission / 100);
      cap += proceeds - fee;
    }
  }

  const ret = (cap - 1000) / 1000 * 100;
  const yrs = (endIdx - startIdx) / 365;
  return {
    ret_yr: yrs > 0 ? ret / yrs : 0,
    dd: maxDD * 100,
    trades: trades.length,
    winrate: trades.length ? trades.filter(t => t.pnlPct > 0).length / trades.length : 0,
  };
}

// === STRATÉGIE 2 : MOMENTUM ROTATION (top N) ===
function backtestMomentum(data, btc, startIdx, endIdx, params, opts = {}) {
  const stress = !!opts.stress;
  const slip = SLIPPAGE_DEFAULT + (stress ? 0.20 : 0);
  const commission = COMMISSION_PCT + (stress ? 0.05 : 0);

  let cap = 1000, peak = cap, maxDD = 0;
  let positions = {};
  let lastRebalance = startIdx;
  let nTrades = 0;

  for (let t = startIdx; t < endIdx; t++) {
    let eq = cap;
    for (const [asset, pos] of Object.entries(positions)) {
      const a = data.find(x => x.label === asset);
      if (a && t < a.prices.length) eq += pos.shares * a.prices[t];
    }
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < maxDD) maxDD = dd;

    if (t - lastRebalance < params.rebalanceDays) continue;
    lastRebalance = t;

    // BTC trend filter : si BTC < SMA60, on reste cash
    if (btc && t >= 60 && t < btc.prices.length) {
      let smaB = 0;
      for (let i = t - 59; i <= t; i++) smaB += btc.prices[i];
      smaB /= 60;
      if (btc.prices[t] < smaB * params.btcFilterMult) {
        // Liquider tout
        for (const [asset, pos] of Object.entries(positions)) {
          const a = data.find(x => x.label === asset);
          if (a && t < a.prices.length) {
            const exit = a.prices[t] * (1 - slip / 100);
            const proceeds = pos.shares * exit;
            const fee = proceeds * (commission / 100);
            cap += proceeds - fee;
            nTrades++;
          }
        }
        positions = {};
        continue;
      }
    }

    // Calcul momentum de chaque actif
    const cands = [];
    for (const a of data) {
      if (t < params.momLookback || t >= a.prices.length) continue;
      const mom = (a.prices[t] / a.prices[t - params.momLookback] - 1) * 100;
      cands.push({ a, mom, price: a.prices[t] });
    }
    cands.sort((x, y) => y.mom - x.mom);
    const top = cands.filter(c => c.mom > params.minMom).slice(0, params.topN);
    const targetMap = {};
    for (const c of top) targetMap[c.a.label] = 1 / params.topN;

    // Liquider hors target
    for (const [asset, pos] of Object.entries(positions)) {
      if (!(asset in targetMap)) {
        const a = data.find(x => x.label === asset);
        if (a && t < a.prices.length) {
          const exit = a.prices[t] * (1 - slip / 100);
          const proceeds = pos.shares * exit;
          const fee = proceeds * (commission / 100);
          cap += proceeds - fee;
          nTrades++;
        }
        delete positions[asset];
      }
    }

    // Ajuster targets
    const newEq = cap + Object.entries(positions).reduce((acc, [asset, pos]) => {
      const a = data.find(x => x.label === asset);
      return acc + (a && t < a.prices.length ? pos.shares * a.prices[t] : 0);
    }, 0);

    for (const [asset, weight] of Object.entries(targetMap)) {
      const a = data.find(x => x.label === asset);
      if (!a || t >= a.prices.length) continue;
      const targetVal = newEq * weight * 0.95;
      const currentVal = positions[asset] ? positions[asset].shares * a.prices[t] : 0;
      const delta = targetVal - currentVal;

      if (Math.abs(delta) < newEq * 0.02) continue;

      if (delta > 0 && cap > delta + 5) {
        const entryPrice = a.prices[t] * (1 + slip / 100);
        const fee = delta * (commission / 100);
        const shares = (delta - fee) / entryPrice;
        if (positions[asset]) positions[asset].shares += shares;
        else positions[asset] = { entry: entryPrice, shares };
        cap -= delta;
        nTrades++;
      } else if (delta < 0 && positions[asset]) {
        const sharesToSell = Math.min(positions[asset].shares, (-delta) / a.prices[t]);
        const exit = a.prices[t] * (1 - slip / 100);
        const proceeds = sharesToSell * exit;
        const fee = proceeds * (commission / 100);
        positions[asset].shares -= sharesToSell;
        cap += proceeds - fee;
        nTrades++;
      }
    }
  }

  // Liquidation finale
  for (const [asset, pos] of Object.entries(positions)) {
    const a = data.find(x => x.label === asset);
    if (a && endIdx - 1 < a.prices.length) {
      const exit = a.prices[endIdx - 1] * (1 - slip / 100);
      const proceeds = pos.shares * exit;
      const fee = proceeds * (commission / 100);
      cap += proceeds - fee;
    }
  }

  const ret = (cap - 1000) / 1000 * 100;
  const yrs = (endIdx - startIdx) / 365;
  return {
    ret_yr: yrs > 0 ? ret / yrs : 0,
    dd: maxDD * 100,
    trades: nTrades,
  };
}

// === Ranges Bayesian ===
const RANGES_DONCHIAN = {
  lookback:     { min: 14, max: 60, snap: 2 },
  breakoutPct:  { min: 0, max: 3, snap: 0.5 },
  trailingPct:  { min: 8, max: 25, snap: 1 },
  stopPct:      { min: 5, max: 15, snap: 1 },
  maxHold:      { min: 10, max: 60, snap: 5 },
  maxPos:       { min: 2, max: 6, snap: 1 },
  sizingPct:    { min: 8, max: 25, snap: 1 },
  minRange:     { min: 0.05, max: 0.30, snap: 0.05 },
};

const RANGES_MOMENTUM = {
  momLookback:    { min: 14, max: 90, snap: 7 },
  rebalanceDays:  { min: 5, max: 21, snap: 1 },
  topN:           { min: 2, max: 6, snap: 1 },
  minMom:         { min: -10, max: 20, snap: 2 },
  btcFilterMult:  { min: 0.85, max: 1.05, snap: 0.05 },
};

function randomConfig(ranges) {
  const c = {};
  for (const [key, r] of Object.entries(ranges)) {
    c[key] = clamp(snap(r.min + rand() * (r.max - r.min), r.snap), r.min, r.max);
  }
  return c;
}
function sampleAround(base, ranges, sigmaFactor = 0.10) {
  const c = {};
  for (const [key, r] of Object.entries(ranges)) {
    const sigma = (r.max - r.min) * sigmaFactor;
    c[key] = clamp(snap(gaussian(base[key], sigma), r.snap), r.min, r.max);
  }
  return c;
}
function configKey(c) {
  return Object.values(c).map(v => v.toFixed(2)).join('-');
}

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

async function main() {
  flog('=== ALPHA CRYPTO STRICT v11.7 ===');
  flog('Walk-forward strict par année + 2 stratégies (Donchian, Momentum)\n');

  flog('Fetching ' + CRYPTO_UNIVERSE.length + ' cryptos...');
  const data = [];
  for (const s of CRYPTO_UNIVERSE) {
    const p = await fetchYahoo10y(s);
    if (p && p.prices.length >= 365) {
      data.push({ label: s, prices: p.prices, timestamps: p.timestamps });
      process.stdout.write('.');
    } else process.stdout.write('x');
  }
  flog('\n' + data.length + '/' + CRYPTO_UNIVERSE.length + ' loaded\n');

  const btc = data.find(a => a.label === 'BTC-USD');
  if (!btc) { flog('BTC missing'); return; }
  function findIdx(year, month = 0, day = 1) {
    const target = new Date(year, month, day).getTime() / 1000;
    return btc.timestamps.findIndex(t => t >= target);
  }

  // BTC B&H per year (référence)
  function bhBtc(start, end) {
    return ((btc.prices[end - 1] / btc.prices[start]) - 1) * 100 / ((end - start) / 365);
  }

  const TARGET_YEARS = [2020, 2021, 2022, 2023, 2024, 2025];
  const allStrategies = [
    { name: 'DONCHIAN', backtest: backtestDonchian, ranges: RANGES_DONCHIAN },
    { name: 'MOMENTUM', backtest: backtestMomentum, ranges: RANGES_MOMENTUM },
  ];

  const verdictByStrategy = {};

  for (const strat of allStrategies) {
    flog(`\n═══════════════════════════════════════════════════════════════`);
    flog(`STRATÉGIE : ${strat.name}`);
    flog(`═══════════════════════════════════════════════════════════════`);

    const yearlyResults = [];

    for (const year of TARGET_YEARS) {
      flog(`\n--- Année ${year} ---`);
      const trainStart = findIdx(2018);
      const trainEnd = findIdx(year);
      if (trainStart < 0 || trainEnd <= trainStart) { flog('  data insuffisante'); continue; }

      // Train folds : 6 mois chacun dans 2018→Y-1
      const trainFolds = [];
      for (let y = 2018; y < year; y += 1) {
        const s1 = findIdx(y), e1 = findIdx(y, 6);
        const s2 = findIdx(y, 6), e2 = findIdx(y + 1);
        if (s1 >= 60 && e1 > s1) trainFolds.push({ s: s1, e: e1 });
        if (s2 >= 60 && e2 > s2) trainFolds.push({ s: s2, e: e2 });
      }
      flog(`  Train folds: ${trainFolds.length}`);

      function evalTrain(c) {
        const folds = trainFolds.map(f => strat.backtest(data, btc, f.s, f.e, c));
        const rets = folds.map(r => r.ret_yr).sort((a, b) => a - b);
        const median = rets[Math.floor(rets.length / 2)];
        const positive = folds.filter(r => r.ret_yr > 0).length;
        const avgDD = folds.reduce((a, b) => a + b.dd, 0) / folds.length;
        return { median, positive, totalFolds: folds.length, avgDD };
      }
      function score(r) {
        if (!r) return -Infinity;
        const posRatio = r.positive / r.totalFolds;
        return r.median * (1 + (posRatio - 0.5)) / (1 + Math.abs(r.avgDD) / 100);
      }

      setSeed(year * 1000 + strat.name.length);
      const tested = {};
      const trainResults = [];

      // Round 1 : random 30
      for (let i = 0; i < 30; i++) {
        const c = randomConfig(strat.ranges);
        const k = configKey(c);
        if (tested[k]) continue;
        tested[k] = true;
        const r = evalTrain(c);
        const s = score(r);
        trainResults.push({ config: c, ...r, score: s });
      }

      // Round 2 : Bayesian top 5, 6 samples chaque
      trainResults.sort((a, b) => b.score - a.score);
      const top5 = trainResults.slice(0, 5);
      for (const t of top5) {
        for (let i = 0; i < 6; i++) {
          const c = sampleAround(t.config, strat.ranges, 0.10);
          const k = configKey(c);
          if (tested[k]) continue;
          tested[k] = true;
          const r = evalTrain(c);
          const s = score(r);
          trainResults.push({ config: c, ...r, score: s });
        }
      }

      // Round 3 : Bayesian tighter top 3, 5 samples
      trainResults.sort((a, b) => b.score - a.score);
      const top3 = trainResults.slice(0, 3);
      for (const t of top3) {
        for (let i = 0; i < 5; i++) {
          const c = sampleAround(t.config, strat.ranges, 0.05);
          const k = configKey(c);
          if (tested[k]) continue;
          tested[k] = true;
          const r = evalTrain(c);
          const s = score(r);
          trainResults.push({ config: c, ...r, score: s });
        }
      }

      trainResults.sort((a, b) => b.score - a.score);
      const finalTop3 = trainResults.slice(0, 3);
      flog(`  Top 3 train:`);
      for (let i = 0; i < 3; i++) {
        const t = finalTop3[i];
        flog(`    ${i + 1}. train med ${t.median.toFixed(1)}% · ${t.positive}/${t.totalFolds} pos · DD ${t.avgDD.toFixed(1)}%`);
      }

      // TEST année cible STRESS
      const testStart = findIdx(year);
      const testEnd = findIdx(year + 1);
      if (testStart < 0 || testEnd <= testStart) continue;
      const bh = bhBtc(testStart, testEnd);

      flog(`  TEST ${year} STRESS:`);
      const topResults = [];
      for (let i = 0; i < 3; i++) {
        const r = strat.backtest(data, btc, testStart, testEnd, finalTop3[i].config, { stress: true });
        flog(`    Top ${i + 1}: ${r.ret_yr.toFixed(1)}%/an · DD ${r.dd.toFixed(1)}% · ${r.trades} trades`);
        topResults.push({ config: finalTop3[i].config, ...r });
      }
      flog(`    B&H BTC: ${bh.toFixed(1)}%/an`);
      yearlyResults.push({ year, bh, top1: topResults[0], top2: topResults[1], top3: topResults[2] });
    }

    // Synthèse strat
    const top1Rets = yearlyResults.map(y => y.top1.ret_yr).sort((a, b) => a - b);
    const top1Med = top1Rets[Math.floor(top1Rets.length / 2)];
    const top1Mean = top1Rets.reduce((a, b) => a + b, 0) / top1Rets.length;
    const top1Pos = yearlyResults.filter(y => y.top1.ret_yr > 0).length;
    const beatBH = yearlyResults.filter(y => y.top1.ret_yr > y.bh).length;
    verdictByStrategy[strat.name] = {
      yearlyResults,
      top1Median: top1Med,
      top1Mean,
      top1Positive: top1Pos,
      beatBH,
      n: yearlyResults.length,
    };
    flog(`\n  >>> ${strat.name} : Med ${top1Med.toFixed(1)}% · Mean ${top1Mean.toFixed(1)}% · ${top1Pos}/${yearlyResults.length} pos · ${beatBH}/${yearlyResults.length} beat BTC`);
  }

  // VERDICT FINAL
  flog('\n\n╔══════════════════════════════════════════════════════════════════════════════╗');
  flog('║ CRYPTO WALK-FORWARD STRICT — VERDICT FINAL                                    ║');
  flog('╠══════════════════════════════════════════════════════════════════════════════╣');
  for (const [name, v] of Object.entries(verdictByStrategy)) {
    flog(`║ ${name.padEnd(12)} │ Med ${v.top1Median.toFixed(1).padStart(6)}% · Mean ${v.top1Mean.toFixed(1).padStart(6)}% · ${v.top1Positive}/${v.n} pos · ${v.beatBH}/${v.n} beat BTC`);
  }

  // B&H BTC référence
  flog('║');
  flog('║ B&H BTC années :');
  for (const year of TARGET_YEARS) {
    const s = findIdx(year), e = findIdx(year + 1);
    if (s < 0 || e <= s) continue;
    flog(`║   ${year} : ${bhBtc(s, e).toFixed(1)}%`);
  }
  flog('╚══════════════════════════════════════════════════════════════════════════════╝');

  await fs.mkdir('data/sandbox', { recursive: true });
  await fs.writeFile('data/sandbox/alpha_crypto_strict.json', JSON.stringify(verdictByStrategy, null, 2));
  flog('\nOutput: data/sandbox/alpha_crypto_strict.json');
}

main();
