#!/usr/bin/env node
/**
 * Trade Genius — v9.2 GRID-SEARCH MASSIVE
 *
 * Teste des NOUVELLES dimensions d'optimisation au-delà de atrStop/atrTp2 :
 *  - Sizing per trade (3% / 5% / 7% / 10%)
 *  - MinQuality threshold (50 / 55 / 60 / 65 / 70)
 *  - Pyramiding (off / +30% à TP1 / +50% à TP1)
 *  - Trailing stop (off / breakeven à TP1 / dynamic 0.5 ATR)
 *  - Max positions (3 / 5 / 8)
 *
 * Backtest causal sur 1000 jours (~4 ans) avec 40 actifs représentatifs.
 *
 * Output : data/sandbox/grid_massive_v92.json (top 20 configs par IA)
 *
 * Durée estimée : 30-60 min (selon connexion Yahoo/CoinGecko)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  fetchYahooHistorical, fetchCoinGeckoHistorical,
  computeAllIndicators,
} from './indicators.mjs';

const CAPITAL_INITIAL = 1000;
const SLIPPAGE_PCT = 0.4;
const BACKTEST_DAYS = 1000; // ~4 ans
const HISTORY_RANGE = '5y';

// Univers représentatif : 40 actifs (15 indices + 15 actions US + 10 cryptos)
const ASSETS = [
  // Indices (15)
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
  // Actions US (15)
  { kind: 'action', symbol: 'AAPL',  label: 'Apple' },
  { kind: 'action', symbol: 'MSFT',  label: 'Microsoft' },
  { kind: 'action', symbol: 'GOOGL', label: 'Alphabet' },
  { kind: 'action', symbol: 'AMZN',  label: 'Amazon' },
  { kind: 'action', symbol: 'META',  label: 'Meta' },
  { kind: 'action', symbol: 'NVDA',  label: 'Nvidia' },
  { kind: 'action', symbol: 'TSLA',  label: 'Tesla' },
  { kind: 'action', symbol: 'AMD',   label: 'AMD' },
  { kind: 'action', symbol: 'JPM',   label: 'JPMorgan' },
  { kind: 'action', symbol: 'V',     label: 'Visa' },
  { kind: 'action', symbol: 'BRK-B', label: 'Berkshire' },
  { kind: 'action', symbol: 'WMT',   label: 'Walmart' },
  { kind: 'action', symbol: 'JNJ',   label: 'J&J' },
  { kind: 'action', symbol: 'XOM',   label: 'Exxon' },
  { kind: 'action', symbol: 'NFLX',  label: 'Netflix' },
  // Cryptos (10)
  { kind: 'crypto', id: 'bitcoin', label: 'BTC' },
  { kind: 'crypto', id: 'ethereum', label: 'ETH' },
  { kind: 'crypto', id: 'solana', label: 'SOL' },
  { kind: 'crypto', id: 'binancecoin', label: 'BNB' },
  { kind: 'crypto', id: 'cardano', label: 'ADA' },
  { kind: 'crypto', id: 'avalanche-2', label: 'AVAX' },
  { kind: 'crypto', id: 'polkadot', label: 'DOT' },
  { kind: 'crypto', id: 'chainlink', label: 'LINK' },
  { kind: 'crypto', id: 'litecoin', label: 'LTC' },
  { kind: 'crypto', id: 'cosmos', label: 'ATOM' },
];

// 5 IA avec configs v9.2 bestOos (déployées) + nouvelles dimensions à tester
const IA_BASE_CONFIGS = [
  { id: 'bastion', name: 'BASTION', atrStop: 0.6, atrTp2: 6.0, holdMax: 45, kinds: ['index', 'action'] },
  { id: 'phenix',  name: 'PHÉNIX',  atrStop: 1.0, atrTp2: 5.0, holdMax: 30, kinds: ['index', 'action'] },
  { id: 'rafale',  name: 'RAFALE',  atrStop: 0.6, atrTp2: 5.0, holdMax: 18, kinds: ['index', 'action'] },
  { id: 'nexus',   name: 'NEXUS',   atrStop: 0.6, atrTp2: 4.0, holdMax: 15, kinds: ['crypto'] },
];

// Dimensions de grid-search
const SIZING_VALUES = [3, 5, 7, 10];        // 4
const MIN_QUALITY_VALUES = [50, 55, 60, 65, 70]; // 5
const PYRAMIDING_VALUES = [0, 30, 50];      // 3 (% size additionnel à TP1)
const TRAILING_VALUES = [false, true];      // 2 (breakeven à TP1)
const MAX_POS_VALUES = [3, 5, 8];           // 3
// Total combinaisons par IA : 4*5*3*2*3 = 360 configs

// ───────────────────────────────────────────────────
// Détecteurs ABC (alignés sur build-ai-study v9.2)
// ───────────────────────────────────────────────────
function _buildSetup(close, atrAbs, config, q) {
  const entry = close;
  const stop = entry - config.atrStop * atrAbs;
  const tp1 = entry + (config.atrTp2 / 2) * atrAbs; // TP1 = mid-way
  const tp2 = entry + config.atrTp2 * atrAbs;
  if (stop >= entry || tp2 <= entry) return null;
  const rr = (tp2 - entry) / (entry - stop);
  if (rr < 1.8) return null;
  return { entry, stop, tp1, tp2, atrAbs, quality: Math.max(0, Math.min(100, Math.round(q))) };
}

function detectBestSetup(prices, config) {
  if (prices.length < 60) return null;
  const ind = computeAllIndicators(prices);
  if (!ind?.rsi || !ind?.boll || !ind?.atr) return null;
  const rsi = ind.rsi.value, boll = ind.boll.value;
  const close = prices[prices.length - 1];
  const atrAbs = ind.atr.value * close / 100;
  const candidates = [];

  // Pattern A
  if (rsi != null && rsi < 28 && boll != null && boll < 0.30) {
    const q = 60 + (28 - rsi) + (0.30 - boll) * 30;
    const s = _buildSetup(close, atrAbs, config, q);
    if (s) candidates.push({ ...s, pattern: 'A' });
  }
  // Pattern B
  if (ind.adx && ind.macd) {
    const adx = ind.adx.value, macd = ind.macd.value;
    if (rsi != null && rsi >= 35 && rsi <= 60 && adx != null && adx >= 25 &&
        macd != null && macd < 0 && boll != null && boll >= 0.25 && boll <= 0.75) {
      const q = 62 + Math.min(15, adx - 25) + Math.min(10, 50 - rsi);
      const s = _buildSetup(close, atrAbs, config, q);
      if (s) candidates.push({ ...s, pattern: 'B' });
    }
  }
  // Pattern C
  if (ind.ichimoku) {
    const ichi = ind.ichimoku;
    if (rsi != null && rsi >= 35 && rsi <= 60 && boll != null && boll < 0.30 &&
        ichi.position === 'above-cloud' && ichi.signal === 'bull') {
      const q = 65 + Math.min(15, 50 - rsi) + (0.30 - boll) * 25;
      const s = _buildSetup(close, atrAbs, config, q);
      if (s) candidates.push({ ...s, pattern: 'C' });
    }
  }
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.quality - a.quality)[0];
}

// ───────────────────────────────────────────────────
// Backtest causal d'une IA avec une config spécifique
// ───────────────────────────────────────────────────
function backtestConfig(assetData, iaBase, dim) {
  // dim : { sizing, minQuality, pyramiding, trailing, maxPos }
  let capital = CAPITAL_INITIAL;
  let peakCapital = capital;
  let maxDD = 0;
  const trades = [];
  const openPositions = []; // [{ asset, entry, stop, tp1, tp2, daysHeld, quality, originalSize, addedSize, tp1Hit }]

  const eligibleAssets = assetData.filter(a => iaBase.kinds.includes(a.kind));
  if (eligibleAssets.length === 0) return { trades: 0, return_pct: 0, dd_max: 0, pf: 0, win_rate: 0 };

  const minLen = Math.min(...eligibleAssets.map(a => a.prices.length));
  const startDay = Math.max(60, minLen - BACKTEST_DAYS);

  for (let t = startDay; t < minLen; t++) {
    // 1. Update positions ouvertes
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i];
      const asset = eligibleAssets.find(a => a.label === pos.asset);
      if (!asset) { openPositions.splice(i, 1); continue; }
      const priceToday = asset.prices[t];
      pos.daysHeld++;

      // Trailing stop : si TP1 touché et trailing on → SL à breakeven
      if (dim.trailing && !pos.tp1Hit && priceToday >= pos.tp1) {
        pos.tp1Hit = true;
        pos.stop = pos.entry; // breakeven
      }

      // Pyramiding : si TP1 touché et pas encore ajouté → ajoute size
      if (dim.pyramiding > 0 && pos.tp1Hit && !pos.added && priceToday >= pos.tp1) {
        pos.added = true;
        pos.addedSize = pos.originalSize * (dim.pyramiding / 100);
        capital -= pos.addedSize; // alloue le capital additionnel
      }

      const hitStop = priceToday <= pos.stop;
      const hitTp2 = priceToday >= pos.tp2;
      const timeout = pos.daysHeld >= iaBase.holdMax;

      if (hitStop || hitTp2 || timeout) {
        let exitPrice = priceToday;
        if (hitStop) exitPrice = pos.stop;
        else if (hitTp2) exitPrice = pos.tp2;
        exitPrice *= (1 - SLIPPAGE_PCT / 100);
        const pnlPct = (exitPrice - pos.entry) / pos.entry;
        const totalSize = pos.originalSize + (pos.addedSize || 0);
        const pnlEur = totalSize * pnlPct;
        capital += totalSize + pnlEur; // restore size + gain/loss
        trades.push({
          asset: pos.asset, pnl: pnlPct, pnlEur,
          outcome: hitTp2 ? 'tp' : (hitStop ? 'sl' : 'timeout'),
          quality: pos.quality, pyramided: pos.added || false,
        });
        openPositions.splice(i, 1);
      }
    }

    // 2. Cherche nouveaux setups si slot disponible
    if (openPositions.length < dim.maxPos) {
      const candidates = [];
      for (const asset of eligibleAssets) {
        if (openPositions.some(p => p.asset === asset.label)) continue;
        const setup = detectBestSetup(asset.prices.slice(0, t + 1), iaBase);
        if (setup && setup.quality >= dim.minQuality) {
          candidates.push({ asset: asset.label, setup });
        }
      }
      // Trie par quality desc et prend les meilleurs
      candidates.sort((a, b) => b.setup.quality - a.setup.quality);
      const slotsAvail = dim.maxPos - openPositions.length;
      for (let i = 0; i < Math.min(slotsAvail, candidates.length); i++) {
        const c = candidates[i];
        const sizeEur = capital * (dim.sizing / 100);
        if (sizeEur < 1 || capital < sizeEur * 1.1) continue; // garde du cash
        const entryWithSlip = c.setup.entry * (1 + SLIPPAGE_PCT / 100);
        capital -= sizeEur;
        openPositions.push({
          asset: c.asset,
          entry: entryWithSlip,
          stop: c.setup.stop,
          tp1: c.setup.tp1,
          tp2: c.setup.tp2,
          daysHeld: 0,
          quality: c.setup.quality,
          originalSize: sizeEur,
          addedSize: 0,
          tp1Hit: false,
          added: false,
        });
      }
    }

    // 3. Track equity (mark-to-market grossier)
    const equityNow = capital + openPositions.reduce((acc, p) => {
      const asset = eligibleAssets.find(a => a.label === p.asset);
      if (!asset) return acc;
      const priceNow = asset.prices[t];
      const totalSize = p.originalSize + (p.addedSize || 0);
      const unrealizedPct = (priceNow - p.entry) / p.entry;
      return acc + totalSize * (1 + unrealizedPct);
    }, 0);
    if (equityNow > peakCapital) peakCapital = equityNow;
    const ddNow = (equityNow - peakCapital) / peakCapital;
    if (ddNow < maxDD) maxDD = ddNow;
  }

  // Final equity : close all positions
  const finalEquity = capital + openPositions.reduce((acc, p) => {
    const asset = eligibleAssets.find(a => a.label === p.asset);
    if (!asset) return acc;
    const finalPrice = asset.prices[asset.prices.length - 1];
    const totalSize = p.originalSize + (p.addedSize || 0);
    return acc + totalSize * (finalPrice / p.entry);
  }, 0);

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const totalReturn = ((finalEquity - CAPITAL_INITIAL) / CAPITAL_INITIAL) * 100;
  const sumWins = wins.reduce((a, t) => a + t.pnlEur, 0);
  const sumLosses = Math.abs(losses.reduce((a, t) => a + t.pnlEur, 0));
  const pf = sumLosses > 0 ? sumWins / sumLosses : (sumWins > 0 ? 99 : 0);
  const yearsBT = BACKTEST_DAYS / 252;
  const returnPctYr = totalReturn / yearsBT;

  return {
    trades: trades.length,
    return_pct: Number(totalReturn.toFixed(2)),
    return_pct_yr: Number(returnPctYr.toFixed(2)),
    dd_max: Number((maxDD * 100).toFixed(2)),
    pf: Number(pf.toFixed(2)),
    win_rate: Number(winRate.toFixed(1)),
    final_equity: Number(finalEquity.toFixed(2)),
    calmar: maxDD < 0 ? Number((returnPctYr / Math.abs(maxDD * 100)).toFixed(2)) : 99,
  };
}

// ───────────────────────────────────────────────────
// Main : fetch + grid-search
// ───────────────────────────────────────────────────
async function main() {
  console.log('=== GRID-SEARCH MASSIVE v9.2 ===');
  console.log('4 IA × 360 configs × 4 ans = ~1440 backtests\n');

  console.log('Fetching ' + ASSETS.length + ' assets (' + HISTORY_RANGE + ')...');
  const assetData = [];
  for (const a of ASSETS) {
    try {
      let data;
      if (a.kind === 'crypto') {
        data = await fetchCoinGeckoHistorical(a.id, BACKTEST_DAYS + 100);
      } else {
        data = await fetchYahooHistorical(a.symbol, HISTORY_RANGE);
      }
      if (data?.prices?.length >= 200) {
        assetData.push({ ...a, prices: data.prices });
        process.stdout.write('.');
      } else process.stdout.write('x');
    } catch (e) { process.stdout.write('!'); }
    // Throttle CoinGecko pour éviter 429
    if (a.kind === 'crypto') await new Promise(r => setTimeout(r, 1500));
  }
  console.log('\n' + assetData.length + '/' + ASSETS.length + ' assets loaded.\n');

  // Save cached data pour relances rapides
  const cachePath = path.join(process.cwd(), 'data', 'sandbox', '_cache_grid_data.json');
  await fs.writeFile(cachePath, JSON.stringify(assetData, null, 0));

  const allResults = [];
  for (const iaBase of IA_BASE_CONFIGS) {
    console.log('\n=== ' + iaBase.name + ' ===');
    const configResults = [];
    let count = 0;
    const total = SIZING_VALUES.length * MIN_QUALITY_VALUES.length * PYRAMIDING_VALUES.length * TRAILING_VALUES.length * MAX_POS_VALUES.length;
    for (const sizing of SIZING_VALUES) {
      for (const minQuality of MIN_QUALITY_VALUES) {
        for (const pyramiding of PYRAMIDING_VALUES) {
          for (const trailing of TRAILING_VALUES) {
            for (const maxPos of MAX_POS_VALUES) {
              const dim = { sizing, minQuality, pyramiding, trailing, maxPos };
              const res = backtestConfig(assetData, iaBase, dim);
              configResults.push({ ...dim, ...res });
              count++;
              if (count % 60 === 0) process.stdout.write('.');
            }
          }
        }
      }
    }
    // Trie par calmar (best risk-adjusted)
    configResults.sort((a, b) => b.calmar - a.calmar);
    console.log('\n  Top 5 configs (by Calmar) :');
    configResults.slice(0, 5).forEach((c, i) => {
      console.log('   ' + (i + 1) + '. siz=' + c.sizing + '% mQ=' + c.minQuality + ' pyr=' + c.pyramiding + ' trl=' + c.trailing + ' pos=' + c.maxPos + ' → ' + c.return_pct_yr + '%/an DD ' + c.dd_max + '% PF ' + c.pf + ' Calmar ' + c.calmar + ' (' + c.trades + ' trades)');
    });
    allResults.push({ ia: iaBase.name, top_20: configResults.slice(0, 20) });
  }

  const outPath = path.join(process.cwd(), 'data', 'sandbox', 'grid_massive_v92.json');
  await fs.writeFile(outPath, JSON.stringify({
    generated: new Date().toISOString(),
    config: {
      backtest_days: BACKTEST_DAYS,
      assets: assetData.length,
      total_configs_per_ia: SIZING_VALUES.length * MIN_QUALITY_VALUES.length * PYRAMIDING_VALUES.length * TRAILING_VALUES.length * MAX_POS_VALUES.length,
      sizing_values: SIZING_VALUES,
      min_quality_values: MIN_QUALITY_VALUES,
      pyramiding_values: PYRAMIDING_VALUES,
      trailing_values: TRAILING_VALUES,
      max_pos_values: MAX_POS_VALUES,
    },
    results: allResults,
  }, null, 2));
  console.log('\n\nOutput: ' + outPath);

  // Récap WINNING CONFIG per IA
  console.log('\n=== WINNING CONFIGS (best Calmar par IA) ===');
  allResults.forEach(r => {
    const w = r.top_20[0];
    console.log(r.ia.padEnd(10), '→ ' + w.return_pct_yr + '%/an · DD ' + w.dd_max + '% · PF ' + w.pf + ' · Calmar ' + w.calmar);
    console.log('             sizing=' + w.sizing + '%, minQ=' + w.minQuality + ', pyramiding=' + w.pyramiding + '%, trailing=' + w.trailing + ', maxPos=' + w.maxPos);
  });
}

main().catch(e => {
  console.error('grid-search-massive failed:', e);
  process.exit(1);
});
