/**
 * Module d'indicateurs techniques — version Node ES (utilisée par
 * scripts/build-daily-report.mjs et scripts/build-weekly-decryptage.mjs).
 *
 * Mêmes signatures que les fonctions JS dans index.html (v2.27).
 * Si tu modifies l'un, pense à synchroniser l'autre.
 */

export function sma(arr, period) {
  if (arr.length < period) return null;
  let s = 0;
  for (let i = arr.length - period; i < arr.length; i++) s += arr[i];
  return s / period;
}

export function emaSeries(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  const out = new Array(arr.length).fill(null);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += arr[i];
  ema /= period;
  out[period - 1] = ema;
  for (let i = period; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

export function rsi(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

export function macd(prices) {
  const e12 = emaSeries(prices, 12);
  const e26 = emaSeries(prices, 26);
  if (!e12 || !e26) return null;
  const macdSeries = e12.map((v, i) => (v != null && e26[i] != null) ? v - e26[i] : null);
  const valid = macdSeries.filter(v => v != null);
  if (valid.length < 9) return null;
  const sig = emaSeries(valid, 9);
  if (!sig) return null;
  const sigLast = sig[sig.length - 1];
  const macdLast = macdSeries[macdSeries.length - 1];
  return { macd: macdLast, signal: sigLast, hist: macdLast - sigLast };
}

export function bollinger(prices, period = 20, mult = 2) {
  if (prices.length < period) return null;
  const ma = sma(prices, period);
  let v = 0;
  for (let i = prices.length - period; i < prices.length; i++) v += (prices[i] - ma) ** 2;
  const std = Math.sqrt(v / period);
  const last = prices[prices.length - 1];
  return { ma, upper: ma + mult * std, lower: ma - mult * std, pos: (last - (ma - mult * std)) / (2 * mult * std) };
}

export function momentum(prices, period = 10) {
  if (prices.length < period + 1) return null;
  return prices[prices.length - 1] - prices[prices.length - 1 - period];
}

export function adx(prices, period = 14) {
  if (prices.length < period * 2 + 1) return null;
  const dms = [], trs = [];
  for (let i = 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    dms.push({ plus: d > 0 ? d : 0, minus: d < 0 ? -d : 0 });
    trs.push(Math.abs(d));
  }
  const recent = dms.slice(-period);
  const trRecent = trs.slice(-period);
  const plusDM = recent.reduce((a, b) => a + b.plus, 0);
  const minusDM = recent.reduce((a, b) => a + b.minus, 0);
  const trSum = trRecent.reduce((a, b) => a + b, 0);
  if (trSum === 0) return 0;
  const plusDI = 100 * (plusDM / trSum);
  const minusDI = 100 * (minusDM / trSum);
  const denom = plusDI + minusDI;
  return denom === 0 ? 0 : (Math.abs(plusDI - minusDI) / denom) * 100;
}

/**
 * v2.68 — Ichimoku Kinko Hyo (5 lignes japonais)
 * - Tenkan-sen (9) : (max(9) + min(9)) / 2 — ligne rapide
 * - Kijun-sen (26) : (max(26) + min(26)) / 2 — ligne de référence
 * - Senkou Span A : (Tenkan + Kijun) / 2, projeté +26
 * - Senkou Span B : (max(52) + min(52)) / 2, projeté +26
 * - Chikou Span : close décalé -26 (lagging)
 *
 * Signal pratique :
 *   - Prix > cloud + Tenkan > Kijun = setup haussier
 *   - Prix < cloud + Tenkan < Kijun = setup baissier
 *   - Prix DANS le cloud = indécis (range)
 */
export function ichimoku(prices) {
  if (!prices || prices.length < 52) return null;
  const hh = (n, end) => {
    let m = -Infinity;
    for (let i = end - n; i < end; i++) if (prices[i] > m) m = prices[i];
    return m;
  };
  const ll = (n, end) => {
    let m = Infinity;
    for (let i = end - n; i < end; i++) if (prices[i] < m) m = prices[i];
    return m;
  };
  const end = prices.length;
  const tenkan = (hh(9, end) + ll(9, end)) / 2;
  const kijun = (hh(26, end) + ll(26, end)) / 2;
  const spanA = (tenkan + kijun) / 2;
  const spanB = (hh(52, end) + ll(52, end)) / 2;
  const cloudHigh = Math.max(spanA, spanB);
  const cloudLow = Math.min(spanA, spanB);
  const last = prices[end - 1];
  // Signal global
  let signal = 'neutral';
  let position = 'cloud-inside';
  if (last > cloudHigh) {
    position = 'above-cloud';
    signal = tenkan > kijun ? 'bull' : 'neutral';
  } else if (last < cloudLow) {
    position = 'below-cloud';
    signal = tenkan < kijun ? 'bear' : 'neutral';
  }
  return {
    tenkan, kijun, spanA, spanB, cloudHigh, cloudLow,
    position, signal,
    tenkanKijunCross: tenkan > kijun ? 'bull' : 'bear',
  };
}

export function atrPct(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < prices.length; i++) trs.push(Math.abs(prices[i] - prices[i - 1]));
  const recent = trs.slice(-period);
  const atr = recent.reduce((a, b) => a + b, 0) / period;
  return (atr / prices[prices.length - 1]) * 100;
}

/**
 * Calcule tous les indicateurs + signal bull/bear/neutral pour chaque.
 * Retourne null si pas assez de data.
 */
export function computeAllIndicators(prices) {
  if (!prices || prices.length < 30) return null;
  const last = prices[prices.length - 1];
  const out = {};

  const r = rsi(prices);
  if (r != null) {
    let sig = 'neutral';
    if (r < 30) sig = 'bull';
    else if (r > 70) sig = 'bear';
    else if (r > 55) sig = 'bull';
    else if (r < 45) sig = 'bear';
    out.rsi = { value: r, signal: sig };
  }

  const ma20 = sma(prices, 20);
  if (ma20 != null) {
    out.ma20 = { value: ma20, signal: last > ma20 ? 'bull' : 'bear' };
  }

  const ma50 = sma(prices, Math.min(50, prices.length - 1));
  if (ma20 != null && ma50 != null) {
    out.maCross = { signal: ma20 > ma50 ? 'bull' : 'bear', ma20, ma50 };
  }

  const m = macd(prices);
  if (m) {
    let sig = 'neutral';
    if (m.hist > 0) sig = 'bull';
    else if (m.hist < 0) sig = 'bear';
    out.macd = { value: m.hist, signal: sig };
  }

  const b = bollinger(prices);
  if (b) {
    let sig = 'neutral';
    if (b.pos < 0.15) sig = 'bull';
    else if (b.pos > 0.85) sig = 'bear';
    else if (b.pos > 0.55) sig = 'bull';
    else if (b.pos < 0.45) sig = 'bear';
    out.boll = { value: b.pos, signal: sig };
  }

  const mom = momentum(prices);
  if (mom != null) {
    out.mom = { value: mom, valuePct: (mom / last) * 100, signal: mom > 0 ? 'bull' : mom < 0 ? 'bear' : 'neutral' };
  }

  const a = adx(prices);
  if (a != null) out.adx = { value: a, signal: 'neutral', strong: a > 25 };

  const at = atrPct(prices);
  if (at != null) out.atr = { value: at, signal: 'neutral' };

  // v2.68 — Ichimoku Kinko Hyo
  const ichi = ichimoku(prices);
  if (ichi) out.ichimoku = ichi;

  return out;
}

const INDICATOR_WEIGHTS = {
  rsi: 12, ma20: 10, maCross: 14, macd: 14, boll: 9, mom: 11, adx: 6, atr: 4,
};

/**
 * Score 0-100, label, classe. Identique à computeGlobalVerdict d'index.html.
 */
export function globalVerdict(ind) {
  if (!ind) return null;
  let totalW = 0, score = 0, bull = 0, bear = 0;
  Object.entries(ind).forEach(([key, i]) => {
    const w = INDICATOR_WEIGHTS[key] || 0;
    totalW += w;
    if (i.signal === 'bull') { score += w; bull++; }
    else if (i.signal === 'bear') { score -= w; bear++; }
  });
  if (ind.adx?.strong) score *= 1.15;
  const norm = totalW ? Math.max(0, Math.min(100, 50 + (score / totalW) * 50)) : 50;
  const cls = norm >= 60 ? 'bull' : norm <= 40 ? 'bear' : 'neutral';
  let label;
  if (norm >= 75) label = 'Haussier fort';
  else if (norm >= 60) label = 'Plutôt haussier';
  else if (norm >= 45) label = 'Indécis';
  else if (norm >= 30) label = 'Plutôt baissier';
  else label = 'Baissier fort';
  return { score: Math.round(norm), cls, label, bull, bear };
}

/* ============ Fetch helpers ============ */

export async function fetchYahooHistorical(symbol, range = '3mo') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (trade-genius-bot)' } });
  if (!r.ok) throw new Error(`Yahoo ${symbol} HTTP ${r.status}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`Yahoo ${symbol} bad payload`);
  const closes = (res.indicators?.quote?.[0]?.close || []).filter(v => v != null);
  const meta = res.meta || {};
  return {
    symbol,
    name: meta.shortName || meta.longName || symbol,
    price: meta.regularMarketPrice ?? closes[closes.length - 1],
    prevClose: meta.previousClose ?? closes[closes.length - 2],
    prices: closes,
    currency: meta.currency || 'USD',
  };
}

export async function fetchCoinGeckoHistorical(id, days = 60) {
  const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const r = await fetch(url, { headers: { 'user-agent': 'trade-genius-bot/1.0' } });
  if (!r.ok) throw new Error(`CoinGecko ${id} HTTP ${r.status}`);
  const j = await r.json();
  const prices = (j.prices || []).map(p => p[1]);
  return {
    id,
    prices,
    price: prices[prices.length - 1],
    prevClose: prices[prices.length - 2],
    currency: 'USD',
  };
}
