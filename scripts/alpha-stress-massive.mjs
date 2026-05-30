#!/usr/bin/env node
/**
 * Trade Genius — v10.1 ALPHA STRESS MASSIVE
 *
 * Test ALPHA dans des conditions BRUTALES pour casser l'overfit :
 *  - Univers 200+ actifs (S&P 500 + Russell 2000 sampling + intl + cryptos + LOSERS)
 *  - Cost of borrow leverage : 6%/an sur la part empruntée (réaliste broker)
 *  - Slippage variable : 0.3% large-cap / 0.8% mid-cap / 1.5% small-cap
 *  - Gap d'ouverture modélisé : variance gaussienne ±0.5%
 *  - Walk-forward strict 5 folds + Monte-Carlo 200 trade-shuffles
 *  - Comparison vs B&H S&P 500 sur même période (vrai alpha)
 *
 * Output : data/sandbox/alpha_stress_massive.json
 *
 * Si ALPHA tient à 20-30%/an dans ces conditions = robuste.
 * Si s'effondre à <10%/an = overfit, retour v9.3.
 *
 * Durée : 30-90 min (fetch 200+ actifs + 5 folds + 200 monte-carlo)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchYahooHistorical, computeAllIndicators } from './indicators.mjs';

const CAPITAL_INITIAL = 1000;
const FOLD_DAYS = 250;
const WARMUP = 60;
const BORROW_COST_YR = 0.06;  // 6%/an sur leverage emprunté
const GAP_VOLATILITY = 0.005; // gap d'ouverture ±0.5% gaussien
const MC_RUNS = 200;          // Monte-Carlo

// UNIVERS MASSIF — 200+ actifs incluant LOSERS pour casser survivorship bias
const ASSETS_MASSIVE = [
  // === INDICES (15) ===
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
  { kind: 'index', symbol: '^IBEX', label: 'IBEX 35' },
  { kind: 'index', symbol: '^AEX',  label: 'AEX' },
  { kind: 'index', symbol: '^BSESN',label: 'Sensex' },
  { kind: 'index', symbol: '^AXJO', label: 'ASX 200' },
  { kind: 'index', symbol: '^BVSP', label: 'Bovespa' },
  // === LARGE-CAP US (40) ===
  ...['AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','AMD','AVGO','ORCL',
      'JPM','V','MA','BAC','WFC','GS','MS','BLK','C','AXP',
      'BRK-B','UNH','JNJ','LLY','ABBV','MRK','PFE','TMO','ABT','CVS',
      'WMT','HD','PG','KO','PEP','MCD','NKE','SBUX','LOW','TGT'].map(s => ({ kind: 'action', symbol: s, label: s })),
  // === MID-CAP US (30) — moins liquide, plus volatil ===
  ...['CRM','ADBE','NFLX','PYPL','INTC','CSCO','QCOM','IBM','TXN','MU',
      'AMAT','LRCX','MRVL','KLAC','SNPS','CDNS','PANW','CRWD','SNOW','DDOG',
      'ZS','OKTA','NET','SHOP','SQ','PLTR','RBLX','U','ROKU','SNAP'].map(s => ({ kind: 'action', symbol: s, label: s })),
  // === LOSERS HISTORIQUES (15) — vrais titres qui ont sous-performé/chuté ===
  // Cassent le survivorship bias
  ...['BBY','BBBY','GME','AMC','WISH','PTON','TWTR','RIDE','HOOD','SPCE',
      'LCID','RIVN','SOFI','UPST','OPEN'].map(s => ({ kind: 'action', symbol: s, label: s + ' (loser)' })),
  // === ACTIONS EUROPE (20) ===
  ...[
    ['BNP.PA','BNP Paribas'],['SAN.PA','Sanofi'],['MC.PA','LVMH'],['OR.PA','L\'Oréal'],['AI.PA','Air Liquide'],
    ['DG.PA','Vinci'],['CS.PA','AXA'],['SU.PA','Schneider'],['BN.PA','Danone'],['ML.PA','Michelin'],
    ['SAP.DE','SAP'],['SIE.DE','Siemens'],['ALV.DE','Allianz'],['BAS.DE','BASF'],['BMW.DE','BMW'],
    ['NESN.SW','Nestle'],['NOVN.SW','Novartis'],['ASML.AS','ASML'],['HSBA.L','HSBC'],['BP.L','BP'],
  ].map(([s,l]) => ({ kind: 'action', symbol: s, label: l })),
  // === ETF SECTORIELS (15) ===
  ...['XLK','XLF','XLE','XLV','XLP','XLY','XLI','XLU','XLB','XLC','XLRE',
      'SOXX','SMH','SPY','QQQ'].map(s => ({ kind: 'action', symbol: s, label: s + ' ETF' })),
  // === COMMODITIES via Yahoo (5) ===
  ...[
    ['GLD','Gold ETF'],['SLV','Silver ETF'],['USO','Oil ETF'],['UNG','NatGas ETF'],['TLT','20Y Treasury'],
  ].map(([s,l]) => ({ kind: 'action', symbol: s, label: l })),
];

const CONFIG = {
  atrStop: 0.6, atrTp2: 5.5, holdMax: 25,
  baseSizing: 10, maxPos: 5, pyramiding: 50,
  minQuality: 55,
  leverageQualityThreshold: 85,
  leverageMultiplier: 2.0,
  trailingATRMult: 0.5,
};

// ───────────────────────────────────────────────────
// SLIPPAGE VARIABLE selon type d'actif
// ───────────────────────────────────────────────────
function getSlippagePct(asset) {
  // Large-cap US connus
  const largeCap = ['Apple','Microsoft','Alphabet','Amazon','Meta','Nvidia','Tesla','S&P 500','Nasdaq','Dow Jones'];
  if (largeCap.includes(asset.label)) return 0.3;
  // ETF
  if (asset.label.includes('ETF')) return 0.3;
  // Indices internationaux
  if (asset.kind === 'index') return 0.4;
  // Losers (illiquides)
  if (asset.label.includes('loser')) return 1.5;
  // Mid-cap actions
  return 0.8;
}

// ───────────────────────────────────────────────────
// GAP D'OUVERTURE simulé (variance gaussienne)
// ───────────────────────────────────────────────────
function gapNoise(seed) {
  // Box-Muller pour gaussienne (déterministe via seed)
  const u1 = ((seed * 9301 + 49297) % 233280) / 233280;
  const u2 = (((seed + 1) * 9301 + 49297) % 233280) / 233280;
  const z = Math.sqrt(-2 * Math.log(Math.max(0.001, u1))) * Math.cos(2 * Math.PI * u2);
  return z * GAP_VOLATILITY;
}

// ───────────────────────────────────────────────────
// PATTERNS (3 base + 5 ensemble, identique alpha-engine)
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
    const s = _build(close, atrAbs, 60 + (28 - rsi) + (0.30 - boll) * 30, 'A-contrarian'); if (s) out.push(s);
  }
  if (ind.adx && ind.macd) {
    const adx = ind.adx.value, macd = ind.macd.value;
    if (rsi != null && rsi >= 35 && rsi <= 60 && adx != null && adx >= 25 &&
        macd != null && macd < 0 && boll != null && boll >= 0.25 && boll <= 0.75) {
      const s = _build(close, atrAbs, 62 + Math.min(15, adx - 25) + Math.min(10, 50 - rsi), 'B-trendfollow'); if (s) out.push(s);
    }
  }
  if (ind.ichimoku) {
    const ichi = ind.ichimoku;
    if (rsi != null && rsi >= 35 && rsi <= 60 && boll != null && boll < 0.30 &&
        ichi.position === 'above-cloud' && ichi.signal === 'bull') {
      const s = _build(close, atrAbs, 65 + Math.min(15, 50 - rsi) + (0.30 - boll) * 25, 'C-pullback'); if (s) out.push(s);
    }
  }
  // D-breakout
  if (prices.length >= 25) {
    const last20 = prices.slice(-22, -1);
    const high20 = Math.max(...last20);
    if (close > high20 * 1.005) {
      const s = _build(close, atrAbs, 65 + Math.min(20, ((close / high20) - 1) * 400), 'D-breakout20'); if (s) out.push(s);
    }
  }
  // E-mean-rev
  if (rsi != null && rsi < 35 && rsi >= 25 && boll != null && boll < 0.15) {
    const s = _build(close, atrAbs, 58 + (35 - rsi) + (0.15 - boll) * 100, 'E-mean-rev'); if (s) out.push(s);
  }
  // G-rsi-div
  if (prices.length >= 30) {
    const prices14 = prices.slice(-14);
    const isFreshLow = prices14.indexOf(Math.min(...prices14)) >= 10;
    if (isFreshLow && rsi != null && rsi > 30 && rsi < 50) {
      const s = _build(close, atrAbs, 60 + (50 - rsi), 'G-rsi-div'); if (s) out.push(s);
    }
  }
  // H-bb-squeeze
  if (prices.length >= 30) {
    const last20 = prices.slice(-20);
    const mean20 = last20.reduce((a, b) => a + b, 0) / 20;
    const std20 = Math.sqrt(last20.reduce((a, b) => a + (b - mean20) ** 2, 0) / 20);
    const last5 = prices.slice(-5);
    const mean5 = last5.reduce((a, b) => a + b, 0) / 5;
    const std5 = Math.sqrt(last5.reduce((a, b) => a + (b - mean5) ** 2, 0) / 5);
    if (std20 / close < 0.015 && std5 > std20 * 1.5 && close > mean20) {
      const s = _build(close, atrAbs, 70 + Math.min(15, (std5 / std20 - 1.5) * 10), 'H-bb-squeeze'); if (s) out.push(s);
    }
  }
  return out;
}

// ───────────────────────────────────────────────────
// BACKTEST avec coûts réalistes
// ───────────────────────────────────────────────────
function backtestFold(assetData, foldStart, foldEnd, foldName) {
  let capital = CAPITAL_INITIAL;
  let peakCapital = capital;
  let maxDD = 0;
  const trades = [];
  const openPositions = [];
  let borrowAccrued = 0;

  const minLen = Math.min(...assetData.map(a => a.prices.length));
  const realStart = Math.max(foldStart, WARMUP);
  const realEnd = Math.min(foldEnd, minLen);
  if (realEnd - realStart < 50) return null;

  for (let t = realStart; t < realEnd; t++) {
    // 1. Cost of borrow journalier sur leverage
    for (const p of openPositions) {
      if (p.leverage > 1) {
        const borrowed = p.originalSize * (p.leverage - 1);
        const dailyBorrow = borrowed * (BORROW_COST_YR / 252);
        borrowAccrued += dailyBorrow;
        capital -= dailyBorrow;
      }
    }

    // 2. Update positions
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i];
      const asset = assetData.find(a => a.label === pos.asset);
      if (!asset) { openPositions.splice(i, 1); continue; }
      // Gap d'ouverture modélisé
      const gapAdj = gapNoise(t * 1000 + i);
      const priceToday = asset.prices[t] * (1 + gapAdj);
      pos.daysHeld++;
      if (priceToday > pos.highSinceEntry) pos.highSinceEntry = priceToday;
      // Trailing breakeven puis ATR
      if (!pos.tp1Hit && priceToday >= pos.tp1) {
        pos.tp1Hit = true;
        pos.stop = pos.entry;
      }
      if (pos.tp1Hit) {
        const newStop = pos.highSinceEntry - CONFIG.trailingATRMult * pos.atrAbs;
        if (newStop > pos.stop) pos.stop = newStop;
      }
      // Pyramiding
      if (CONFIG.pyramiding > 0 && pos.tp1Hit && !pos.added && priceToday >= pos.tp1) {
        const addCash = Math.min(pos.originalSize * (CONFIG.pyramiding / 100), capital * 0.95);
        if (addCash > 0) {
          pos.added = true;
          pos.addedSize = addCash;
          capital -= addCash;
        }
      }
      const hitStop = priceToday <= pos.stop;
      const hitTp = priceToday >= pos.tp2;
      const timeout = pos.daysHeld >= CONFIG.holdMax;
      if (hitStop || hitTp || timeout) {
        let exitPrice = priceToday;
        if (hitStop) exitPrice = pos.stop;
        else if (hitTp) exitPrice = pos.tp2;
        // Slippage variable selon liquidité
        exitPrice *= (1 - pos.slippagePct / 100);
        const pnlPct = (exitPrice - pos.entry) / pos.entry;
        const totalSize = pos.originalSize + (pos.addedSize || 0);
        const leveragedPnl = pnlPct * pos.leverage;
        const pnlEur = totalSize * leveragedPnl;
        capital += totalSize + pnlEur;
        trades.push({
          asset: pos.asset,
          pnlPct: Number((pnlPct * 100).toFixed(2)),
          pnlEur: Number(pnlEur.toFixed(2)),
          daysHeld: pos.daysHeld,
          outcome: hitTp ? 'tp2' : (hitStop ? (pos.tp1Hit ? 'trail' : 'sl') : 'timeout'),
          pattern: pos.pattern, quality: pos.quality,
          leverage: pos.leverage, slippage: pos.slippagePct,
        });
        openPositions.splice(i, 1);
      }
    }

    // 3. New setups
    if (openPositions.length < CONFIG.maxPos) {
      const candidates = [];
      for (const asset of assetData) {
        if (openPositions.some(p => p.asset === asset.label)) continue;
        const setups = detectPatterns(asset.prices.slice(0, t + 1));
        for (const setup of setups) {
          if (setup.quality >= CONFIG.minQuality) {
            candidates.push({ asset, setup });
          }
        }
      }
      candidates.sort((a, b) => b.setup.quality - a.setup.quality);
      const slots = CONFIG.maxPos - openPositions.length;
      for (let i = 0; i < Math.min(slots, candidates.length); i++) {
        const c = candidates[i];
        const sizeEur = capital * (CONFIG.baseSizing / 100);
        if (sizeEur < 1 || capital < sizeEur * 1.1) continue;
        const leverage = c.setup.quality >= CONFIG.leverageQualityThreshold ? CONFIG.leverageMultiplier : 1;
        const slippagePct = getSlippagePct(c.asset);
        const entryWithSlip = c.setup.entry * (1 + slippagePct / 100);
        capital -= sizeEur;
        openPositions.push({
          asset: c.asset.label,
          entry: entryWithSlip,
          stop: c.setup.stop, tp1: c.setup.tp1, tp2: c.setup.tp2,
          atrAbs: c.setup.atrAbs,
          highSinceEntry: entryWithSlip,
          daysHeld: 0, quality: c.setup.quality, pattern: c.setup.pattern,
          originalSize: sizeEur, addedSize: 0, leverage,
          tp1Hit: false, added: false,
          slippagePct,
        });
      }
    }

    // 4. Equity track
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
    const finalPrice = asset?.prices[realEnd - 1] || p.entry;
    const totalSize = p.originalSize + (p.addedSize || 0);
    const unrealizedPct = ((finalPrice - p.entry) / p.entry) * p.leverage;
    return acc + totalSize * (1 + unrealizedPct);
  }, 0);

  const wins = trades.filter(t => t.pnlPct > 0);
  const totalReturn = (finalEquity - CAPITAL_INITIAL) / CAPITAL_INITIAL * 100;
  const winRate = trades.length > 0 ? wins.length / trades.length * 100 : 0;
  const yearsBT = (realEnd - realStart) / 252;
  const returnYr = yearsBT > 0 ? totalReturn / yearsBT : 0;

  return {
    fold: foldName,
    trades: trades.length,
    return_pct_yr: Number(returnYr.toFixed(2)),
    dd_max: Number((maxDD * 100).toFixed(2)),
    win_rate: Number(winRate.toFixed(1)),
    final_equity: Number(finalEquity.toFixed(2)),
    calmar: maxDD < 0 ? Number((returnYr / Math.abs(maxDD * 100)).toFixed(2)) : 99,
    leveraged_trades: trades.filter(t => t.leverage > 1).length,
    borrow_cost_eur: Number(borrowAccrued.toFixed(2)),
    sample_trades_pnl: trades.map(t => t.pnlEur), // pour Monte-Carlo
  };
}

// ───────────────────────────────────────────────────
// MONTE-CARLO : shuffle trades order pour confidence interval
// ───────────────────────────────────────────────────
function monteCarloReturns(allTradePnls, runs = MC_RUNS) {
  if (allTradePnls.length < 20) return null;
  const returns = [];
  for (let r = 0; r < runs; r++) {
    // Shuffle Fisher-Yates (déterministe via seed)
    const arr = [...allTradePnls];
    for (let i = arr.length - 1; i > 0; i--) {
      const seed = (r * 1000 + i * 7) % 233280;
      const j = Math.floor(((seed * 9301 + 49297) % 233280) / 233280 * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    let equity = CAPITAL_INITIAL;
    let peak = equity;
    let maxDD = 0;
    for (const pnl of arr) {
      equity += pnl;
      if (equity > peak) peak = equity;
      const dd = (equity - peak) / peak;
      if (dd < maxDD) maxDD = dd;
    }
    const totalRet = (equity - CAPITAL_INITIAL) / CAPITAL_INITIAL * 100;
    returns.push({ ret: totalRet, dd: maxDD * 100 });
  }
  returns.sort((a, b) => a.ret - b.ret);
  return {
    p5: returns[Math.floor(runs * 0.05)].ret,
    p50: returns[Math.floor(runs * 0.50)].ret,
    p95: returns[Math.floor(runs * 0.95)].ret,
    median_dd: returns[Math.floor(runs * 0.50)].dd,
    worst_dd: Math.min(...returns.map(r => r.dd)),
  };
}

// ───────────────────────────────────────────────────
// MAIN
// ───────────────────────────────────────────────────
async function main() {
  console.log('=== ALPHA STRESS MASSIVE v10.1 ===');
  console.log('Univers:', ASSETS_MASSIVE.length, 'actifs (incluant losers/illiquides)');
  console.log('Coûts: borrow', BORROW_COST_YR * 100 + '%/an · gap ±' + (GAP_VOLATILITY * 100) + '% · slippage variable');
  console.log('Monte-Carlo:', MC_RUNS, 'runs\n');

  console.log('Fetching ' + ASSETS_MASSIVE.length + ' actifs (5y)...');
  const assetData = [];
  let i = 0;
  for (const a of ASSETS_MASSIVE) {
    i++;
    try {
      const data = await fetchYahooHistorical(a.symbol, '5y');
      if (data?.prices?.length >= 200) {
        assetData.push({ ...a, prices: data.prices });
        process.stdout.write('.');
      } else process.stdout.write('x');
    } catch (e) { process.stdout.write('!'); }
    if (i % 50 === 0) process.stdout.write(' [' + i + '/' + ASSETS_MASSIVE.length + ']\n');
  }
  console.log('\n' + assetData.length + '/' + ASSETS_MASSIVE.length + ' actifs chargés.\n');

  // Save cache
  await fs.writeFile(
    path.join(process.cwd(), 'data', 'sandbox', '_cache_massive.json'),
    JSON.stringify(assetData.map(a => ({ kind: a.kind, label: a.label, symbol: a.symbol, prices: a.prices })))
  );

  const minLen = Math.min(...assetData.map(a => a.prices.length));
  console.log('Min days available:', minLen, '(' + (minLen / 252).toFixed(1) + ' ans)\n');

  // Folds
  const folds = [];
  for (let i = 0; i < 5; i++) {
    folds.push({ name: 'Fold-' + (i + 1), start: i * FOLD_DAYS, end: Math.min((i + 1) * FOLD_DAYS + WARMUP, minLen) });
  }

  console.log('=== WALK-FORWARD STRESS ===');
  const foldResults = [];
  const allPnls = [];
  for (const fold of folds) {
    const res = backtestFold(assetData, fold.start, fold.end, fold.name);
    if (!res) { console.log(fold.name + ': skipped'); continue; }
    foldResults.push(res);
    allPnls.push(...res.sample_trades_pnl);
    console.log(fold.name + ': ' + res.return_pct_yr + '%/an · DD ' + res.dd_max + '% · WR ' + res.win_rate + '% · Calmar ' + res.calmar + ' (' + res.trades + ' trades, ' + res.leveraged_trades + ' lev, borrow cost ' + res.borrow_cost_eur + '€)');
  }

  if (foldResults.length === 0) { console.log('No results'); return; }

  const sorted = [...foldResults].sort((a, b) => a.return_pct_yr - b.return_pct_yr);
  const median = sorted[Math.floor(sorted.length / 2)].return_pct_yr;
  const avgDD = foldResults.reduce((a, b) => a + b.dd_max, 0) / foldResults.length;

  // Monte-Carlo confidence interval
  console.log('\n=== MONTE-CARLO 200 RUNS ===');
  const mc = monteCarloReturns(allPnls);
  if (mc) {
    console.log('Return distribution (' + allPnls.length + ' trades shuffled 200×) :');
    console.log('  P5  (pessimiste 5%) : ' + mc.p5.toFixed(2) + '% total');
    console.log('  P50 (médian)        : ' + mc.p50.toFixed(2) + '% total');
    console.log('  P95 (optimiste 5%)  : ' + mc.p95.toFixed(2) + '% total');
    console.log('  Median DD shuffle   : ' + mc.median_dd.toFixed(2) + '%');
    console.log('  Worst DD shuffle    : ' + mc.worst_dd.toFixed(2) + '%');
  }

  // Compare vs B&H S&P 500
  const sp500 = assetData.find(a => a.label === 'S&P 500');
  let bhReturn = 0;
  if (sp500) {
    const firstPrice = sp500.prices[WARMUP];
    const lastPrice = sp500.prices[sp500.prices.length - 1];
    const yearsTotal = (sp500.prices.length - WARMUP) / 252;
    bhReturn = (((lastPrice / firstPrice) - 1) * 100) / yearsTotal;
  }

  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║ DIAGNOSTIC ALPHA STRESS (vs B&H S&P 500)                    ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log('║ ALPHA médian/an     : ' + median.toFixed(2) + '%');
  console.log('║ B&H S&P 500/an      : ' + bhReturn.toFixed(2) + '%');
  console.log('║ ALPHA (alpha)       : ' + (median - bhReturn).toFixed(2) + '% surplus');
  console.log('║ ALPHA DD moyen      : ' + avgDD.toFixed(2) + '%');
  console.log('║ Folds positifs      : ' + foldResults.filter(r => r.return_pct_yr > 0).length + '/' + foldResults.length);
  console.log('║ Total trades        : ' + allPnls.length);
  console.log('║ Cost of borrow cumul: ' + foldResults.reduce((a, b) => a + b.borrow_cost_eur, 0).toFixed(2) + '€');
  console.log('╚═══════════════════════════════════════════════════════════╝');

  await fs.writeFile(path.join(process.cwd(), 'data', 'sandbox', 'alpha_stress_massive.json'), JSON.stringify({
    generated: new Date().toISOString(),
    config: CONFIG, borrow_cost_yr: BORROW_COST_YR, gap_volatility: GAP_VOLATILITY,
    universe_count: assetData.length,
    folds: foldResults.map(f => ({ ...f, sample_trades_pnl: undefined })), // strip pnls (trop gros)
    monte_carlo: mc,
    bh_sp500_yr: Number(bhReturn.toFixed(2)),
    alpha_median_yr: Number(median.toFixed(2)),
    excess_return: Number((median - bhReturn).toFixed(2)),
  }, null, 2));
  console.log('\nOutput: data/sandbox/alpha_stress_massive.json');
}

main().catch(e => { console.error('stress failed:', e); process.exit(1); });
