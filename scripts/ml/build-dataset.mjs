#!/usr/bin/env node
/**
 * Trade Genius — v4.0 ML Pipeline · Étape 1/3 : Build dataset
 *
 * Pour chaque actif × jour historique, extrait un vecteur de features
 * techniques + un label forward-looking :
 *
 *   LABEL : si on entre LONG au close du jour D, est-ce que le prix
 *   atteint +N×ATR (TP2) avant -1×ATR (stop) dans les 30 jours suivants ?
 *     → +1 = WIN   (TP2 touché avant stop)
 *     → -1 = LOSS  (stop touché avant TP2)
 *     →  0 = TIMEOUT (ni l'un ni l'autre dans la fenêtre)
 *
 * On reproduit la convention des Patterns A/B/C (stop 1 ATR, TP variable
 * selon la fenêtre temporelle). Trois colonnes label distinctes sont
 * exportées (label_day, label_week, label_month) pour entraîner 3 modèles.
 *
 * Output : data/ml/dataset.csv (CSV plat, ~1M lignes pour 50 actifs × 20 ans)
 *
 * Lancement local :
 *   node --max-old-space-size=4096 scripts/ml/build-dataset.mjs
 *
 * Workflow GH : ml-train.yml
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  fetchYahooHistorical,
  computeAllIndicators, atrPct, sma, macd, rsi, obv, mfi,
} from '../indicators.mjs';

// v6.0 — Yahoo `range=max` retourne moins que `20y` pour les forex/futures
// (contracts roulés). 20y reste optimal : 117k rows × 24 features × 50 actifs.
// Couvre déjà 2008 Lehman, 2011 euro, 2015 China, 2020 COVID, 2022 bear.
const HISTORY_RANGE = process.env.TG_ML_RANGE || '20y';
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'ml');
const WARMUP = 260;          // ~1 an de warmup pour SMA200 + features 60j
const HOLD_DAY = 7;          // horizon DAY (3-7j)
const HOLD_WEEK = 21;        // horizon WEEK (1-3 semaines)
const HOLD_MONTH = 60;       // horizon MONTH (4-12 semaines)
const TP_DAY = 4;            // ATR multiplier DAY
const TP_WEEK = 5;
const TP_MONTH = 7;

const ASSETS = [
  { kind: 'index', symbol: '^GSPC', label: 'S&P 500' },
  { kind: 'index', symbol: '^IXIC', label: 'Nasdaq' },
  { kind: 'index', symbol: '^DJI', label: 'Dow Jones' },
  { kind: 'index', symbol: '^RUT', label: 'Russell 2000' },
  { kind: 'index', symbol: '^FCHI', label: 'CAC 40' },
  { kind: 'index', symbol: '^GDAXI', label: 'DAX' },
  { kind: 'index', symbol: '^FTSE', label: 'FTSE 100' },
  { kind: 'index', symbol: '^N225', label: 'Nikkei 225' },
  { kind: 'index', symbol: '^HSI', label: 'Hang Seng' },
  { kind: 'index', symbol: '^STOXX50E', label: 'Euro Stoxx 50' },
  { kind: 'action', symbol: 'AAPL', label: 'Apple' },
  { kind: 'action', symbol: 'MSFT', label: 'Microsoft' },
  { kind: 'action', symbol: 'GOOGL', label: 'Alphabet' },
  { kind: 'action', symbol: 'AMZN', label: 'Amazon' },
  { kind: 'action', symbol: 'META', label: 'Meta' },
  { kind: 'action', symbol: 'NVDA', label: 'Nvidia' },
  { kind: 'action', symbol: 'TSLA', label: 'Tesla' },
  { kind: 'action', symbol: 'JPM', label: 'JPMorgan' },
  { kind: 'action', symbol: 'V', label: 'Visa' },
  { kind: 'action', symbol: 'BRK-B', label: 'Berkshire' },
  { kind: 'action', symbol: 'WMT', label: 'Walmart' },
  { kind: 'action', symbol: 'JNJ', label: 'Johnson & J.' },
  { kind: 'action', symbol: 'XOM', label: 'Exxon' },
  { kind: 'action', symbol: 'PG', label: 'P&G' },
  { kind: 'action', symbol: 'KO', label: 'Coca-Cola' },
  { kind: 'action', symbol: 'NFLX', label: 'Netflix' },
  { kind: 'action', symbol: 'NKE', label: 'Nike' },
  { kind: 'action', symbol: 'DIS', label: 'Disney' },
  { kind: 'action', symbol: 'SPY', label: 'SPY' },
  { kind: 'action', symbol: 'QQQ', label: 'QQQ' },
  { kind: 'action', symbol: 'IWM', label: 'IWM' },
  { kind: 'action', symbol: 'EEM', label: 'EEM' },
  { kind: 'action', symbol: 'GLD', label: 'GLD' },
  { kind: 'action', symbol: 'TLT', label: 'TLT' },
  { kind: 'action', symbol: 'XLK', label: 'XLK Tech' },
  { kind: 'action', symbol: 'XLF', label: 'XLF Finance' },
  { kind: 'action', symbol: 'XLE', label: 'XLE Energy' },
  { kind: 'action', symbol: 'MC.PA', label: 'LVMH' },
  { kind: 'action', symbol: 'ASML.AS', label: 'ASML' },
  { kind: 'action', symbol: 'NESN.SW', label: 'Nestlé' },
  { kind: 'forex', symbol: 'EURUSD=X', label: 'EUR/USD' },
  { kind: 'forex', symbol: 'GBPUSD=X', label: 'GBP/USD' },
  { kind: 'forex', symbol: 'USDJPY=X', label: 'USD/JPY' },
  { kind: 'forex', symbol: 'USDCHF=X', label: 'USD/CHF' },
  { kind: 'forex', symbol: 'AUDUSD=X', label: 'AUD/USD' },
  { kind: 'metal', symbol: 'GC=F', label: 'Or' },
  { kind: 'metal', symbol: 'SI=F', label: 'Argent' },
  { kind: 'metal', symbol: 'HG=F', label: 'Cuivre' },
  { kind: 'metal', symbol: 'CL=F', label: 'Pétrole' },
  { kind: 'metal', symbol: 'BZ=F', label: 'Brent' },
];

function slope(arr, lookback) {
  if (!Array.isArray(arr) || arr.length < lookback + 1) return 0;
  const a = arr[arr.length - 1];
  const b = arr[arr.length - 1 - lookback];
  if (a == null || b == null || b === 0) return 0;
  return (a - b) / b;
}

function detectRegime(prices) {
  if (!Array.isArray(prices) || prices.length < 220) return 0;
  const sma200Now = sma(prices.slice(-200), 200);
  const sma200Ago = sma(prices.slice(-220, -20), 200);
  if (sma200Now == null || sma200Ago == null || sma200Ago === 0) return 0;
  const slopeBps = (sma200Now - sma200Ago) / sma200Ago;
  if (slopeBps > 0.02) return 1;       // bull
  if (slopeBps < -0.02) return -1;     // bear
  return 0;                              // sideways
}

/**
 * Pour un jour D (idx in prices), simule un trade LONG entry=close[D],
 * stop=close[D]-1×ATR, target=close[D]+M×ATR, horizon=H jours.
 * Renvoie +1 (win), -1 (loss), 0 (timeout).
 */
function labelForward(prices, idx, atrAbs, tpMult, horizon) {
  if (atrAbs == null || atrAbs <= 0) return null;
  const entry = prices[idx];
  if (entry == null) return null;
  const stop = entry - atrAbs;
  const tp = entry + tpMult * atrAbs;
  const endIdx = Math.min(idx + horizon, prices.length - 1);
  for (let i = idx + 1; i <= endIdx; i++) {
    const p = prices[i];
    if (p == null) continue;
    if (p <= stop) return -1;
    if (p >= tp) return 1;
  }
  return 0;
}

/**
 * Pour un jour D, extrait un vecteur de ~25 features techniques.
 * On utilise computeAllIndicators sur le slice [0..D] (pas de leak futur).
 */
// Stochastique simple (K = position du close dans la range [low..high] sur N jours)
// Sur close-only data : on approxime low/high par min/max des closes.
function stochasticK(prices, period = 14) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const lo = Math.min(...slice);
  const hi = Math.max(...slice);
  if (hi === lo) return 50;
  return ((prices[prices.length - 1] - lo) / (hi - lo)) * 100;
}

// v6.0 — FEATURES STATISTIQUES enrichies
// Calcul des returns log sur N derniers jours, puis stats de forme
function logReturns(prices, n) {
  const out = [];
  for (let i = prices.length - n; i < prices.length; i++) {
    if (i > 0 && prices[i - 1] > 0 && prices[i] > 0) {
      out.push(Math.log(prices[i] / prices[i - 1]));
    }
  }
  return out;
}
function skewness(arr) {
  if (arr.length < 3) return 0;
  const n = arr.length;
  const mean = arr.reduce((s, x) => s + x, 0) / n;
  const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  const skew = arr.reduce((s, x) => s + ((x - mean) / std) ** 3, 0) / n;
  return skew;
}
function kurtosis(arr) {
  if (arr.length < 4) return 0;
  const n = arr.length;
  const mean = arr.reduce((s, x) => s + x, 0) / n;
  const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  if (variance === 0) return 0;
  const kurt = arr.reduce((s, x) => s + (x - mean) ** 4, 0) / n / (variance ** 2);
  return kurt - 3; // excess kurtosis
}
function drawdownFromHigh(prices, lookback) {
  if (prices.length < lookback) return 0;
  const slice = prices.slice(-lookback);
  const high = Math.max(...slice);
  const last = prices[prices.length - 1];
  if (high === 0) return 0;
  return (last - high) / high; // négatif si en drawdown
}
function volatilityRegime(prices, lookback = 60) {
  if (prices.length < lookback + 1) return 0;
  const recentRets = logReturns(prices, 20);
  const longRets = logReturns(prices, lookback);
  if (recentRets.length === 0 || longRets.length === 0) return 0;
  const recentStd = Math.sqrt(recentRets.reduce((s, r) => s + r * r, 0) / recentRets.length);
  const longStd = Math.sqrt(longRets.reduce((s, r) => s + r * r, 0) / longRets.length);
  if (longStd === 0) return 0;
  return recentStd / longStd; // >1.5 = spike vol, <0.7 = calm
}
function maSpread(prices) {
  if (prices.length < 50) return 0;
  const ma20 = sma(prices.slice(-20), 20);
  const ma50 = sma(prices.slice(-50), 50);
  if (!ma20 || !ma50 || ma50 === 0) return 0;
  return (ma20 - ma50) / ma50; // positif si MA20 > MA50 (bull)
}
function psychRoundDistance(price) {
  if (!price || price <= 0) return 0;
  // Distance au niveau psychologique rond le plus proche en %
  const magnitude = Math.pow(10, Math.floor(Math.log10(price)));
  const lowerRound = Math.floor(price / magnitude) * magnitude;
  const upperRound = lowerRound + magnitude;
  const distLow = (price - lowerRound) / price;
  const distHigh = (upperRound - price) / price;
  return Math.min(distLow, distHigh); // ∈ [0, 0.5], plus proche de 0 = près d'un niveau rond
}

// v4.1 — Resample daily prices/volumes en weekly (5-day non-overlapping buckets)
// pour vraies features multi-TF. Retourne {prices: [...], volumes: [...]} avec
// 1 entrée par "semaine" (close = dernier close du bucket, volume = somme).
function resampleWeekly(prices, volumes) {
  const wp = [], wv = [];
  for (let i = 4; i < prices.length; i += 5) {
    wp.push(prices[i]);
    let v = 0;
    for (let j = i - 4; j <= i; j++) v += (volumes?.[j] || 0);
    wv.push(v);
  }
  return { prices: wp, volumes: wv };
}

function extractFeatures(prices, idx, volumes) {
  // Slice strictement causal
  const sub = prices.slice(0, idx + 1);
  const subV = Array.isArray(volumes) ? volumes.slice(0, idx + 1) : null;
  if (sub.length < WARMUP) return null;
  const ind = computeAllIndicators(sub, subV);
  if (!ind || !ind.rsi || !ind.macd || !ind.boll) return null;
  const atrPctVal = atrPct(sub);
  if (atrPctVal == null) return null;
  const mFull = macd(sub); // pour récupérer line + signal (pas dans computeAllIndicators)

  const last = sub[sub.length - 1];
  const ma20 = ind.ma20?.value;
  const ma50 = ind.maCross?.ma50;
  const ma200 = ind.sma200?.value;

  // Slope MA20 sur 5j
  const ma20Series = [];
  for (let i = 19; i < sub.length; i++) ma20Series.push(sma(sub.slice(i - 19, i + 1), 20));
  const ma50Slope = ma20Series.length >= 6 ? slope(ma20Series, 5) : 0;

  const ichi = ind.ichimoku || {};
  const ichiPos = ichi.position === 'above-cloud' ? 1 : (ichi.position === 'below-cloud' ? -1 : 0);
  const ichiSig = ichi.signal === 'bull' ? 1 : (ichi.signal === 'bear' ? -1 : 0);

  const adxVal = Number(ind.adx?.value) || 0;
  const stochK = stochasticK(sub, 14) ?? 50;
  const stochK3 = stochasticK(sub, 5) ?? 50; // proxy %D rapide

  // Volatilité 20j (std des returns)
  let vol20 = 0;
  if (sub.length >= 21) {
    const rets = [];
    for (let i = sub.length - 20; i < sub.length; i++) {
      if (sub[i - 1] && sub[i]) rets.push((sub[i] - sub[i - 1]) / sub[i - 1]);
    }
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    vol20 = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
  }

  // Price changes lookback
  const chg5 = sub.length >= 6 ? (last - sub[sub.length - 6]) / sub[sub.length - 6] : 0;
  const chg20 = sub.length >= 21 ? (last - sub[sub.length - 21]) / sub[sub.length - 21] : 0;

  // v4.1 — VOLUME FEATURES
  // obv_slope_10 : pente normalisée de l'OBV sur 10j (positif = accumulation)
  let obvSlope10 = 0;
  let mfiVal = 50;
  let volRel20 = 1;
  if (subV && subV.length === sub.length) {
    const obvSeries = [];
    let cum = 0;
    for (let i = 1; i < sub.length; i++) {
      if (sub[i] > sub[i - 1]) cum += (subV[i] || 0);
      else if (sub[i] < sub[i - 1]) cum -= (subV[i] || 0);
      obvSeries.push(cum);
    }
    if (obvSeries.length >= 11) {
      const o0 = obvSeries[obvSeries.length - 11];
      const o1 = obvSeries[obvSeries.length - 1];
      const ref = Math.abs(o0) || 1;
      obvSlope10 = (o1 - o0) / ref;
    }
    const mf = mfi(sub, subV, 14);
    if (mf != null) mfiVal = mf;
    // Volume actuel / moyenne 20j
    if (subV.length >= 21) {
      const vMean = subV.slice(-20).reduce((s, v) => s + (v || 0), 0) / 20;
      if (vMean > 0) volRel20 = (subV[subV.length - 1] || 0) / vMean;
    }
  }

  // v4.1 — MULTI-TIMEFRAME FEATURES (resample weekly)
  // Vrai multi-TF : on regroupe les daily en weekly (1 candle/semaine) puis
  // on calcule RSI + slope MA sur cette série hebdomadaire.
  let rsiWeekly = 50;
  let ma20RelWeekly = 0;
  const wk = resampleWeekly(sub, subV);
  if (wk.prices.length >= 30) {
    const rW = rsi(wk.prices, 14);
    if (rW != null) rsiWeekly = rW;
    const ma20W = sma(wk.prices, 20);
    if (ma20W) ma20RelWeekly = (wk.prices[wk.prices.length - 1] - ma20W) / ma20W;
  }

  // v6.0 — Features statistiques enrichies
  const ret60 = logReturns(sub, 60);
  const skew60 = skewness(ret60);
  const kurt60 = kurtosis(ret60);
  const dd60 = drawdownFromHigh(sub, 60);
  const volRegime = volatilityRegime(sub, 60);
  const maSpread2050 = maSpread(sub);
  const psychDist = psychRoundDistance(last);
  // Saisonnalité : jour de la semaine et mois (proxy via len % 7 et % 252)
  const dow = (sub.length % 5);   // 0..4 ≈ lundi-vendredi (jours bourse)
  const moy = (Math.floor(sub.length / 21) % 12); // 0..11 ≈ mois calendaire

  return {
    rsi: Number(ind.rsi.value) || 50,
    macd_line: Number(mFull?.macd) || 0,
    macd_signal: Number(mFull?.signal) || 0,
    macd_hist: Number(mFull?.hist) || 0,
    ma20_rel: ma20 ? (last - ma20) / ma20 : 0,
    ma50_rel: ma50 ? (last - ma50) / ma50 : 0,
    ma200_rel: ma200 ? (last - ma200) / ma200 : 0,
    ma50_slope: ma50Slope,
    boll_pos: Number(ind.boll?.value) || 0.5,
    atr_pct: atrPctVal,
    adx: adxVal,
    stoch_k: stochK,
    stoch_d: stochK3,
    ichi_pos: ichiPos,
    ichi_sig: ichiSig,
    vol20,
    chg5,
    chg20,
    regime: detectRegime(sub),
    // v4.1 — Volume
    obv_slope_10: obvSlope10,
    mfi: mfiVal,
    vol_rel_20: volRel20,
    // v4.1 — Multi-TF (weekly)
    rsi_weekly: rsiWeekly,
    ma20_rel_weekly: ma20RelWeekly,
    // v6.0 — Stats avancées (forme distribution + drawdown + saisonnalité)
    skew60, kurt60,
    dd_from_high60: dd60,
    vol_regime: volRegime,
    ma_spread_20_50: maSpread2050,
    psych_round_dist: psychDist,
    dow, moy,
  };
}

const FEATURE_KEYS = [
  'rsi', 'macd_line', 'macd_signal', 'macd_hist',
  'ma20_rel', 'ma50_rel', 'ma200_rel', 'ma50_slope',
  'boll_pos', 'atr_pct', 'adx', 'stoch_k', 'stoch_d',
  'ichi_pos', 'ichi_sig', 'vol20', 'chg5', 'chg20', 'regime',
  // v4.1 — 5 features Volume + Multi-TF
  'obv_slope_10', 'mfi', 'vol_rel_20', 'rsi_weekly', 'ma20_rel_weekly',
  // v6.0 — 8 features statistiques avancées
  'skew60', 'kurt60', 'dd_from_high60', 'vol_regime', 'ma_spread_20_50',
  'psych_round_dist', 'dow', 'moy',
];

async function processAsset(asset, csvRows) {
  let d;
  try {
    d = await fetchYahooHistorical(asset.symbol, HISTORY_RANGE);
  } catch (e) {
    console.warn(`SKIP ${asset.label}: ${e.message}`);
    return 0;
  }
  const prices = d.prices;
  const volumes = d.volumes || []; // v4.1 — volumes Yahoo
  if (!prices || prices.length < WARMUP + 30) {
    console.warn(`SKIP ${asset.label}: not enough history (${prices?.length || 0})`);
    return 0;
  }
  console.log(`${asset.label} : ${prices.length} candles${volumes.length ? ' (+volumes)' : ''}`);
  let added = 0;
  // On échantillonne 1 sur 2 pour éviter dataset trop massif (~500k lignes vs 1M)
  for (let i = WARMUP; i < prices.length - HOLD_MONTH - 1; i += 2) {
    const sub = prices.slice(0, i + 1);
    const atrPctVal = atrPct(sub);
    if (atrPctVal == null) continue;
    const last = sub[sub.length - 1];
    const atrAbs = (atrPctVal / 100) * last;
    if (!atrAbs || atrAbs <= 0) continue;
    const feats = extractFeatures(prices, i, volumes);
    if (!feats) continue;
    const labelDay = labelForward(prices, i, atrAbs, TP_DAY, HOLD_DAY);
    const labelWeek = labelForward(prices, i, atrAbs, TP_WEEK, HOLD_WEEK);
    const labelMonth = labelForward(prices, i, atrAbs, TP_MONTH, HOLD_MONTH);
    if (labelDay == null && labelWeek == null && labelMonth == null) continue;
    const row = [
      asset.label, asset.kind, i,
      ...FEATURE_KEYS.map(k => feats[k]?.toFixed(6) ?? '0'),
      labelDay ?? '',
      labelWeek ?? '',
      labelMonth ?? '',
    ];
    csvRows.push(row.join(','));
    added++;
  }
  return added;
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const header = [
    'asset', 'kind', 'idx',
    ...FEATURE_KEYS,
    'label_day', 'label_week', 'label_month',
  ].join(',');
  const csvRows = [header];
  let total = 0;
  for (const a of ASSETS) {
    const n = await processAsset(a, csvRows);
    total += n;
    await new Promise(r => setTimeout(r, 200)); // soft rate-limit Yahoo
  }
  const outFile = path.join(OUTPUT_DIR, 'dataset.csv');
  await fs.writeFile(outFile, csvRows.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${total} rows to ${outFile}`);
  // Stats rapides labels
  let winDay = 0, lossDay = 0, toDay = 0;
  for (let i = 1; i < csvRows.length; i++) {
    const cols = csvRows[i].split(',');
    const lbl = cols[cols.length - 3];
    if (lbl === '1') winDay++;
    else if (lbl === '-1') lossDay++;
    else if (lbl === '0') toDay++;
  }
  console.log(`label_day : ${winDay} win / ${lossDay} loss / ${toDay} timeout`);
}

main().catch(e => {
  console.error('build-dataset failed:', e);
  process.exit(1);
});
