#!/usr/bin/env node
/**
 * Trade Genius — v11.4 ALPHA TREND-REGIME
 *
 * Nouvelle hypothèse : ALPHA actuelle ÉVITE le momentum tech (RSI<22, contrarian)
 * → perd en 2023-2024 (Nvidia +200%, Mag7 rally)
 *
 * Nouvelle approche radicalement différente :
 *  1. DUAL MOMENTUM (Gary Antonacci 2014, validé académiquement)
 *     - Rank actifs par momentum (return 6 mois)
 *     - Achète top N si momentum > 0 (absolu) ET > T-bills (relatif)
 *  2. REGIME FILTER (SMA200 + slope + DD)
 *     - BULL : long top momentum, sizing 100%
 *     - SIDEWAYS : long top momentum, sizing 50%
 *     - BEAR : 100% cash (ou TLT/GLD défensif)
 *  3. VOLATILITY TARGETING
 *     - Chaque position sizée à ~10% vol annualisée
 *     - Limite max 25% par position
 *  4. REBALANCE MENSUEL
 *
 * Test PUR OOS STRICT par année 2019-2025 (même protocole alpha-ultimate)
 *
 * Output : data/sandbox/alpha_trend_regime.json
 */
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function flog(msg) { process.stdout.write(msg + '\n'); }

let _seed = 22222;
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
function clamp(x, min, max) { return Math.max(min, Math.min(max, x)); }
function snap(value, snap) { return Math.round(value / snap) * snap; }

// Hyperparamètres TREND-REGIME (ranges pour Bayesian)
const RANGES = {
  momentumLookback: { min: 90, max: 252, snap: 21 },    // 4 mois → 1 an
  topN:             { min: 3, max: 8, snap: 1 },         // top 3 à 8 momentum
  rebalanceDays:    { min: 21, max: 63, snap: 21 },      // mensuel→trimestriel
  regimeSMA:        { min: 150, max: 250, snap: 25 },    // 150 à 250 jours
  volTarget:        { min: 0.08, max: 0.18, snap: 0.02 },// 8-18% vol annu
  maxPosPct:        { min: 15, max: 35, snap: 5 },       // 15-35% max par pos
  minMomentum:      { min: -5, max: 10, snap: 1 },       // seuil absolu en %
  bearAction:       { values: ['cash', 'tlt', 'gld'] },  // refuge en bear
};

function randomConfig() {
  const c = {};
  for (const [key, r] of Object.entries(RANGES)) {
    if (r.values) {
      c[key] = r.values[Math.floor(rand() * r.values.length)];
    } else {
      c[key] = clamp(snap(r.min + rand() * (r.max - r.min), r.snap), r.min, r.max);
    }
  }
  return c;
}
function sampleAround(base, sigmaFactor = 0.10) {
  const c = {};
  for (const [key, r] of Object.entries(RANGES)) {
    if (r.values) {
      c[key] = rand() < 0.85 ? base[key] : r.values[Math.floor(rand() * r.values.length)];
    } else {
      const sigma = (r.max - r.min) * sigmaFactor;
      c[key] = clamp(snap(gaussian(base[key], sigma), r.snap), r.min, r.max);
    }
  }
  return c;
}
function configKey(c) {
  return Object.entries(c).map(([k, v]) => k + ':' + (typeof v === 'number' ? v.toFixed(2) : v)).join('|');
}

// Univers — momentum-friendly (équités + ETF + refuges)
const ASSETS_TREND = [
  // Indices monde
  '^GSPC','^IXIC','^DJI','^RUT',
  // Mega-caps US (les vrais leaders momentum)
  'AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','AMD','ORCL','CRM',
  'ADBE','NFLX','TXN','QCOM','AVGO','TMO','LIN','HON','COST','LLY',
  // Sectoriels & broad ETF
  'SPY','QQQ','SOXX','SMH','XLK','XLF','XLE','XLV','XLP','XLY','XLI','XLU','XLB',
  // Refuges
  'TLT','GLD','SHY','IEF',
  // International
  'EFA','EEM','VEA','VWO',
  // Diversification
  'JPM','V','MA','WMT','HD','JNJ','UNH','XOM','CVX','BRK-B',
];

function getSlippage(label) {
  if (label.startsWith('^')) return 0.10;
  if (['SPY','QQQ','TLT','GLD','SHY','IEF','SOXX','SMH','XLK','XLF','XLE','XLV','XLP','XLY','XLI','XLU','XLB','EFA','EEM','VEA','VWO'].includes(label)) return 0.05;
  if (['AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','BRK-B','JPM','V','WMT','HD','JNJ','UNH','XOM','MCD','LLY','COST'].includes(label)) return 0.10;
  return 0.25;
}

// Calculs simples
function momentum(prices, t, lookback) {
  if (t < lookback) return null;
  return (prices[t] / prices[t - lookback] - 1) * 100;
}

function realizedVol(prices, t, lookback = 60) {
  if (t < lookback) return null;
  const rets = [];
  for (let i = t - lookback + 1; i <= t; i++) {
    if (i > 0) rets.push(Math.log(prices[i] / prices[i - 1]));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) * (r - mean), 0) / rets.length;
  return Math.sqrt(variance) * Math.sqrt(252); // annualisée
}

function sma(prices, t, n) {
  if (t < n) return null;
  let s = 0;
  for (let i = t - n + 1; i <= t; i++) s += prices[i];
  return s / n;
}

// Détection régime sur SPY
function detectRegime(spyPrices, t, smaLen) {
  if (t < smaLen + 50) return 'sideways';
  const smaNow = sma(spyPrices, t, smaLen);
  const smaPrev = sma(spyPrices, t - 50, smaLen);
  if (smaNow == null || smaPrev == null) return 'sideways';
  const price = spyPrices[t];
  const slope = (smaNow - smaPrev) / smaPrev;

  // Bear : prix sous SMA + SMA en pente baissière
  if (price < smaNow && slope < -0.005) return 'bear';
  // Bull : prix au-dessus SMA + pente positive
  if (price > smaNow && slope > 0.002) return 'bull';
  // Entre les deux
  return 'sideways';
}

// Backtest TREND-REGIME
function backtest(data, startIdx, endIdx, params, opts = {}) {
  const stress = !!opts.stress;
  const commission = opts.commission || 1; // 1€/trade par défaut
  const slipBonus = stress ? 0.5 : 0;

  let cap = 1000;
  let peak = cap;
  let maxDD = 0;
  const trades = [];
  let positions = {}; // {asset: {entry, shares, slippage}}

  const sp = data.find(a => a.label === '^GSPC');
  const spy = sp ? sp.prices : null;

  let lastRebalance = startIdx;

  for (let t = startIdx; t < endIdx; t++) {
    // Update equity
    let equity = cap;
    for (const [asset, pos] of Object.entries(positions)) {
      const a = data.find(x => x.label === asset);
      if (a && t < a.prices.length) {
        equity += pos.shares * a.prices[t];
      }
    }
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDD) maxDD = dd;

    // Rebalance ?
    if (t - lastRebalance < params.rebalanceDays) continue;
    lastRebalance = t;

    // 1. Détection régime
    const regime = spy ? detectRegime(spy, t, params.regimeSMA) : 'sideways';

    // 2. Calcul momentum + vol pour tous les actifs
    const candidates = [];
    for (const a of data) {
      if (t >= a.prices.length) continue;
      const mom = momentum(a.prices, t, params.momentumLookback);
      const vol = realizedVol(a.prices, t, 60);
      if (mom == null || vol == null || vol < 0.01) continue;
      // Exclure refuges du screening momentum (ce sont des cibles bear)
      if (['TLT','GLD','SHY','IEF'].includes(a.label)) continue;
      candidates.push({ asset: a.label, momentum: mom, vol, price: a.prices[t] });
    }

    // 3. Décision selon régime
    let targets = []; // [{asset, weight}]
    if (regime === 'bear') {
      // Refuge ou cash
      if (params.bearAction === 'cash') {
        targets = [];
      } else {
        const refugeLabel = params.bearAction === 'tlt' ? 'TLT' : 'GLD';
        const refuge = data.find(a => a.label === refugeLabel);
        if (refuge && t < refuge.prices.length) {
          targets = [{ asset: refugeLabel, weight: 0.95 }];
        }
      }
    } else {
      // BULL ou SIDEWAYS : top N momentum filtré
      const filtered = candidates
        .filter(c => c.momentum >= params.minMomentum)
        .sort((a, b) => b.momentum - a.momentum)
        .slice(0, params.topN);

      if (filtered.length > 0) {
        // Vol targeting : chaque pos sizée pour ~params.volTarget annualisée
        const totalBudget = regime === 'bull' ? 0.98 : 0.60; // sideways = 60% exposé
        const rawWeights = filtered.map(c => params.volTarget / Math.max(c.vol, 0.05));
        const sumRaw = rawWeights.reduce((a, b) => a + b, 0);
        const normWeights = rawWeights.map(w => (w / sumRaw) * totalBudget);
        // Capper à maxPosPct
        const cappedWeights = normWeights.map(w => Math.min(w, params.maxPosPct / 100));
        targets = filtered.map((c, i) => ({ asset: c.asset, weight: cappedWeights[i] }));
      }
    }

    // 4. Sortir des positions non-targets ou réduire
    const targetMap = {};
    for (const t2 of targets) targetMap[t2.asset] = t2.weight;
    for (const [asset, pos] of Object.entries(positions)) {
      if (!(asset in targetMap)) {
        // Sortir totalement
        const a = data.find(x => x.label === asset);
        if (a && t < a.prices.length) {
          const slippage = getSlippage(asset) + slipBonus;
          const exitPrice = a.prices[t] * (1 - slippage / 100);
          const value = pos.shares * exitPrice;
          const pnl = value - pos.cost;
          cap += value - commission;
          trades.push({ asset, pnl, pnlPct: (pnl / pos.cost) * 100 });
        }
        delete positions[asset];
      }
    }

    // 5. Ajuster positions existantes + ouvrir nouvelles
    const newEquity = cap + Object.entries(positions).reduce((acc, [asset, pos]) => {
      const a = data.find(x => x.label === asset);
      return acc + (a && t < a.prices.length ? pos.shares * a.prices[t] : 0);
    }, 0);

    for (const tgt of targets) {
      const a = data.find(x => x.label === tgt.asset);
      if (!a || t >= a.prices.length) continue;
      const targetValue = newEquity * tgt.weight;
      const currentValue = positions[tgt.asset] ? positions[tgt.asset].shares * a.prices[t] : 0;
      const delta = targetValue - currentValue;
      const slippage = getSlippage(tgt.asset) + slipBonus;

      if (Math.abs(delta) < newEquity * 0.01) continue; // micro-rebalance skip

      if (delta > 0 && cap > delta + 5) {
        // Acheter
        const entryPrice = a.prices[t] * (1 + slippage / 100);
        const shares = delta / entryPrice;
        if (positions[tgt.asset]) {
          positions[tgt.asset].shares += shares;
          positions[tgt.asset].cost += delta;
        } else {
          positions[tgt.asset] = { entry: entryPrice, shares, cost: delta, slippage };
        }
        cap -= (delta + commission);
      } else if (delta < 0 && positions[tgt.asset]) {
        // Réduire
        const sellValue = -delta;
        const exitPrice = a.prices[t] * (1 - slippage / 100);
        const sharesToSell = sellValue / a.prices[t];
        const actualValue = sharesToSell * exitPrice;
        positions[tgt.asset].shares -= sharesToSell;
        positions[tgt.asset].cost *= positions[tgt.asset].shares / (positions[tgt.asset].shares + sharesToSell);
        cap += actualValue - commission;
      }
    }
  }

  // Liquidation finale
  for (const [asset, pos] of Object.entries(positions)) {
    const a = data.find(x => x.label === asset);
    if (a && endIdx - 1 < a.prices.length) {
      const slippage = getSlippage(asset) + slipBonus;
      const exitPrice = a.prices[endIdx - 1] * (1 - slippage / 100);
      const value = pos.shares * exitPrice;
      cap += value;
      const pnl = value - pos.cost;
      trades.push({ asset, pnl, pnlPct: (pnl / pos.cost) * 100 });
    }
  }

  const ret = (cap - 1000) / 1000 * 100;
  const yrs = (endIdx - startIdx) / 252;
  return {
    ret_yr: yrs > 0 ? ret / yrs : 0,
    dd: maxDD * 100,
    trades: trades.length,
  };
}

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

async function main() {
  flog('=== ALPHA TREND-REGIME v11.4 ===');
  flog('Approche : Dual Momentum + Regime Filter + Vol Targeting');
  flog('Test : pur OOS strict par année 2019-2025\n');

  const uniqueAssets = [...new Set(ASSETS_TREND)];
  flog('Fetching 20y data sur ' + uniqueAssets.length + ' actifs...');
  const data = [];
  for (const s of uniqueAssets) {
    const p = await fetchYahoo20y(s);
    if (p && p.prices.length >= 1000) {
      data.push({ label: s, prices: p.prices, timestamps: p.timestamps });
      process.stdout.write('.');
    } else process.stdout.write('x');
  }
  flog('\n' + data.length + '/' + uniqueAssets.length + ' loaded\n');

  const sp = data.find(a => a.label === '^GSPC');
  if (!sp) { flog('S&P 500 missing'); return; }
  function findIdx(year, month = 0, day = 1) {
    const target = new Date(year, month, day).getTime() / 1000;
    return sp.timestamps.findIndex(t => t >= target);
  }

  flog('═══════════════════════════════════════════════════════════════');
  flog('WALK-FORWARD STRICT PAR ANNÉE');
  flog('═══════════════════════════════════════════════════════════════\n');

  const TARGET_YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
  const yearlyResults = [];

  for (const year of TARGET_YEARS) {
    flog(`\n=== Année cible ${year} ===`);

    // Train folds : périodes de 2 ans dans 2010 → Y-1
    const trainStart = findIdx(2010);
    const trainEnd = findIdx(year);
    if (trainStart < 0 || trainEnd <= trainStart) { flog('  data insuffisante'); continue; }

    const trainFolds = [];
    for (let y = 2010; y < year; y += 2) {
      const s = findIdx(y), e = findIdx(Math.min(y + 2, year));
      if (s >= 0 && e > s) trainFolds.push({ s: Math.max(252, s), e });
    }
    flog(`  Train folds: ${trainFolds.length}`);

    function evalTrain(c) {
      const folds = trainFolds.map(f => backtest(data, f.s, f.e, c));
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

    setSeed(year * 1000 + 999);
    const tested = {};
    const trainResults = [];

    // Random round 1
    for (let i = 0; i < 25; i++) {
      const c = randomConfig();
      const k = configKey(c);
      if (tested[k]) continue;
      tested[k] = true;
      const r = evalTrain(c);
      const s = score(r);
      trainResults.push({ config: c, ...r, score: s });
    }

    // Round 2 : Bayesian around top 5
    trainResults.sort((a, b) => b.score - a.score);
    const top5 = trainResults.slice(0, 5);
    for (const t of top5) {
      for (let i = 0; i < 5; i++) {
        const c = sampleAround(t.config, 0.10);
        const k = configKey(c);
        if (tested[k]) continue;
        tested[k] = true;
        const r = evalTrain(c);
        const s = score(r);
        trainResults.push({ config: c, ...r, score: s });
      }
    }

    // Round 3 : Bayesian tighter around top 3
    trainResults.sort((a, b) => b.score - a.score);
    const top3 = trainResults.slice(0, 3);
    for (const t of top3) {
      for (let i = 0; i < 5; i++) {
        const c = sampleAround(t.config, 0.05);
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
    flog('  Top 3 train:');
    for (let i = 0; i < 3; i++) {
      const t = finalTop3[i];
      flog(`    ${i + 1}. train med ${t.median.toFixed(1)}% · ${t.positive}/${t.totalFolds} pos · DD ${t.avgDD.toFixed(1)}%`);
    }

    // TEST sur année cible avec STRESS MAX
    const testStart = findIdx(year);
    const testEnd = findIdx(year + 1);
    if (testStart < 0 || testEnd <= testStart) { flog('  data test indispo'); continue; }
    const bhRet = ((sp.prices[testEnd - 1] / sp.prices[testStart]) - 1) * 100 / ((testEnd - testStart) / 252);

    flog(`  TEST ${year} STRESS MAX (commission 1€/trade · slip+0.5%):`);
    const topResults = [];
    for (let i = 0; i < 3; i++) {
      const r = backtest(data, testStart, testEnd, finalTop3[i].config, { stress: true, commission: 1 });
      flog(`    Top ${i + 1}: ${r.ret_yr.toFixed(1)}%/an · DD ${r.dd.toFixed(1)}% · ${r.trades} trades`);
      topResults.push({ config: finalTop3[i].config, ...r });
    }
    flog(`    B&H S&P 500: ${bhRet.toFixed(1)}%`);

    yearlyResults.push({
      year,
      bh: bhRet,
      top1: topResults[0],
      top2: topResults[1],
      top3: topResults[2],
    });
  }

  // VERDICT
  flog('\n\n╔══════════════════════════════════════════════════════════════════════════════╗');
  flog('║ TREND-REGIME WALK-FORWARD STRICT — VERDICT FINAL                              ║');
  flog('╠══════════════════════════════════════════════════════════════════════════════╣');
  flog('║ Année │ B&H    │ Top1   │ Top2  │ Top3  │ Best OOS │ Excess vs B&H  ║');
  flog('╠═══════╪════════╪════════╪═══════╪═══════╪══════════╪════════════════╣');
  let bestSum = 0, top1Sum = 0;
  let top1Pos = 0, beatBH = 0;
  for (const yr of yearlyResults) {
    const best = Math.max(yr.top1.ret_yr, yr.top2.ret_yr, yr.top3.ret_yr);
    const excess = yr.top1.ret_yr - yr.bh;
    bestSum += best;
    top1Sum += yr.top1.ret_yr;
    if (yr.top1.ret_yr > 0) top1Pos++;
    if (yr.top1.ret_yr > yr.bh) beatBH++;
    flog(`║ ${yr.year}  │ ${yr.bh.toFixed(1).padStart(6)}% │ ${yr.top1.ret_yr.toFixed(1).padStart(6)}% │ ${yr.top2.ret_yr.toFixed(1).padStart(5)}% │ ${yr.top3.ret_yr.toFixed(1).padStart(5)}% │ ${best.toFixed(1).padStart(8)}% │ ${(excess >= 0 ? '+' : '') + excess.toFixed(1)}%`);
  }
  flog('╚══════════════════════════════════════════════════════════════════════════════╝');

  const n = yearlyResults.length;
  const top1Med = [...yearlyResults.map(y => y.top1.ret_yr)].sort((a, b) => a - b)[Math.floor(n / 2)];
  const bestMed = [...yearlyResults.map(y => Math.max(y.top1.ret_yr, y.top2.ret_yr, y.top3.ret_yr))].sort((a, b) => a - b)[Math.floor(n / 2)];

  flog('\n=== TOP1 (best train) sur ' + n + ' années PUR OOS ===');
  flog(`Médian: ${top1Med.toFixed(2)}%/an · Moyen: ${(top1Sum / n).toFixed(2)}%/an`);
  flog(`Années positives: ${top1Pos}/${n} · Battent B&H: ${beatBH}/${n}`);
  flog(`Best of TOP1/2/3 retrospective: médian ${bestMed.toFixed(2)}% · moyen ${(bestSum / n).toFixed(2)}%`);

  await fs.mkdir('data/sandbox', { recursive: true });
  await fs.writeFile('data/sandbox/alpha_trend_regime.json', JSON.stringify({
    yearlyResults,
    summary: { top1Median: top1Med, top1Mean: top1Sum / n, top1Positive: top1Pos, beatBH, n },
  }, null, 2));
  flog('\nOutput: data/sandbox/alpha_trend_regime.json');
}

main();
