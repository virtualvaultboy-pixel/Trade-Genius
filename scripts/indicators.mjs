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

/* ═══════════════════════════════════════════════════════════════════
   v2.72 — Indicateurs avancés (privés aux agents)
   ═══════════════════════════════════════════════════════════════════ */

// SMA 200 — moyenne 200 jours, le "filtre vérité" du trend LT
export function sma200(prices) {
  if (!prices || prices.length < 200) return null;
  let s = 0;
  for (let i = prices.length - 200; i < prices.length; i++) s += prices[i];
  return s / 200;
}

// v2.73 — MA7 (moyenne courte rapide) + direction
// Retourne { value, slope: 'up'/'down'/'flat' } sur les 3 derniers points
export function ma7(prices) {
  if (!prices || prices.length < 10) return null;
  const sma = (end) => {
    let s = 0;
    for (let i = end - 7; i < end; i++) s += prices[i];
    return s / 7;
  };
  const now = sma(prices.length);
  const prev3 = sma(prices.length - 3);
  const slope = now > prev3 * 1.003 ? 'up' : now < prev3 * 0.997 ? 'down' : 'flat';
  return { value: now, slope };
}

// v2.73 — Direction du cloud Ichimoku (ascendant/descendant/plat)
// Comparé sur les 5 dernières périodes
export function ichimokuDirection(prices) {
  if (!prices || prices.length < 60) return null;
  const calcCloud = (endIdx) => {
    const subset = prices.slice(0, endIdx);
    if (subset.length < 52) return null;
    const hh = (n) => Math.max.apply(null, subset.slice(-n));
    const ll = (n) => Math.min.apply(null, subset.slice(-n));
    const tenkan = (hh(9) + ll(9)) / 2;
    const kijun = (hh(26) + ll(26)) / 2;
    const spanA = (tenkan + kijun) / 2;
    const spanB = (hh(52) + ll(52)) / 2;
    return { tenkan, kijun, spanA, spanB, cloudMid: (spanA + spanB) / 2 };
  };
  const now = calcCloud(prices.length);
  const prev = calcCloud(prices.length - 5);
  if (!now || !prev) return null;
  const cloudGoingUp = now.cloudMid > prev.cloudMid * 1.005;
  const cloudGoingDown = now.cloudMid < prev.cloudMid * 0.995;
  const tenkanAboveKijun = now.tenkan > now.kijun;
  const spanAAboveB = now.spanA > now.spanB; // cloud "vert" = haussier
  return {
    direction: cloudGoingUp ? 'up' : cloudGoingDown ? 'down' : 'flat',
    tenkanAboveKijun,
    spanAAboveB,
    fullyBullish: cloudGoingUp && tenkanAboveKijun && spanAAboveB,
    fullyBearish: cloudGoingDown && !tenkanAboveKijun && !spanAAboveB,
  };
}

// VWAP — Volume Weighted Average Price sur N période
export function vwap(prices, volumes, period = 20) {
  if (!prices || !volumes || prices.length < period) return null;
  let pv = 0, v = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    pv += prices[i] * (volumes[i] || 0);
    v += (volumes[i] || 0);
  }
  return v > 0 ? pv / v : null;
}

// OBV (On-Balance Volume) — direction du volume cumulé sur N période
// Retourne { value, trend: 'up'/'down'/'flat' }
export function obv(prices, volumes, lookback = 20) {
  if (!prices || !volumes || prices.length < lookback + 1) return null;
  const series = [0];
  for (let i = 1; i < prices.length; i++) {
    const prev = series[series.length - 1];
    if (prices[i] > prices[i - 1]) series.push(prev + (volumes[i] || 0));
    else if (prices[i] < prices[i - 1]) series.push(prev - (volumes[i] || 0));
    else series.push(prev);
  }
  // Trend = pente sur les `lookback` dernières valeurs
  const recent = series.slice(-lookback);
  const slope = (recent[recent.length - 1] - recent[0]) / Math.abs(recent[0] || 1);
  return {
    value: series[series.length - 1],
    trend: slope > 0.05 ? 'up' : slope < -0.05 ? 'down' : 'flat',
    slope,
  };
}

// Money Flow Index — RSI pondéré par volume (close-only en proxy)
export function mfi(prices, volumes, period = 14) {
  if (!prices || !volumes || prices.length < period + 1) return null;
  let posFlow = 0, negFlow = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const flow = prices[i] * (volumes[i] || 0);
    if (prices[i] > prices[i - 1]) posFlow += flow;
    else if (prices[i] < prices[i - 1]) negFlow += flow;
  }
  if (negFlow === 0) return 100;
  const ratio = posFlow / negFlow;
  return 100 - (100 / (1 + ratio));
}

// Hull Moving Average — MA réactive (signale les retournements tôt)
export function hullMA(prices, period = 14) {
  if (!prices || prices.length < period) return null;
  function wma(arr, p) {
    if (arr.length < p) return null;
    let sum = 0, w = 0;
    for (let i = 0; i < p; i++) {
      const weight = i + 1;
      sum += arr[arr.length - p + i] * weight;
      w += weight;
    }
    return sum / w;
  }
  const half = Math.floor(period / 2);
  const sq = Math.floor(Math.sqrt(period));
  const w1 = wma(prices, half);
  const w2 = wma(prices, period);
  if (w1 == null || w2 == null) return null;
  // Pour la 2e WMA on a besoin d'une série, mais approximation : retour direct
  return 2 * w1 - w2; // Hull approximé (raw, sans 2e lissage faute de série)
}

// Force Index (Elder) — flux acheteur/vendeur via volume
export function forceIndex(prices, volumes, period = 13) {
  if (!prices || !volumes || prices.length < period + 1) return null;
  // Moyenne exponentielle de (close - prevClose) * volume sur period
  const arr = [];
  for (let i = prices.length - period; i < prices.length; i++) {
    arr.push((prices[i] - prices[i - 1]) * (volumes[i] || 0));
  }
  // EMA simple sur arr
  const k = 2 / (period + 1);
  let e = arr[0];
  for (let i = 1; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

// +DI / -DI (composantes directionnelles de l'ADX, en close-only)
export function directionalIndex(prices, period = 14) {
  if (!prices || prices.length < period + 1) return null;
  let plusDM = 0, minusDM = 0, tr = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const move = prices[i] - prices[i - 1];
    if (move > 0) plusDM += move;
    if (move < 0) minusDM += -move;
    tr += Math.abs(move);
  }
  if (tr === 0) return { plusDI: 50, minusDI: 50 };
  return {
    plusDI: (plusDM / tr) * 100,
    minusDI: (minusDM / tr) * 100,
  };
}

// Détection de divergence RSI haussière (prix fait LL, RSI fait HL)
// Retourne { type: 'bullish'/'bearish'/null, strength: 0-1 }
export function rsiDivergence(prices, period = 14, lookback = 30) {
  if (!prices || prices.length < lookback + period + 1) return null;
  // Calcule RSI sur chaque point dans la fenêtre
  function rsiAt(idx) {
    if (idx < period) return null;
    let g = 0, l = 0;
    for (let k = 1; k <= period; k++) {
      const d = prices[idx - period + k] - prices[idx - period + k - 1];
      if (d >= 0) g += d; else l -= d;
    }
    if (l === 0) return 100;
    return 100 - (100 / (1 + (g / period) / (l / period)));
  }
  // Trouve les 2 plus bas locaux récents
  function findRecentLows(window) {
    const lows = [];
    for (let i = 2; i < window.length - 2; i++) {
      if (window[i].price < window[i - 1].price && window[i].price < window[i - 2].price
          && window[i].price < window[i + 1].price && window[i].price < window[i + 2].price) {
        lows.push(window[i]);
      }
    }
    return lows;
  }
  // Fenêtre lookback récente avec (price, rsi)
  const start = prices.length - lookback;
  const window = [];
  for (let i = start; i < prices.length; i++) {
    const r = rsiAt(i);
    if (r != null) window.push({ idx: i, price: prices[i], rsi: r });
  }
  const lows = findRecentLows(window);
  if (lows.length >= 2) {
    const [l1, l2] = lows.slice(-2);
    // Divergence haussière : prix plus bas mais RSI plus haut
    if (l2.price < l1.price * 0.985 && l2.rsi > l1.rsi + 3) {
      return { type: 'bullish', strength: Math.min(1, (l2.rsi - l1.rsi) / 10) };
    }
  }
  // Plus hauts pour divergence baissière (prix HH mais RSI LH)
  function findRecentHighs(window) {
    const highs = [];
    for (let i = 2; i < window.length - 2; i++) {
      if (window[i].price > window[i - 1].price && window[i].price > window[i - 2].price
          && window[i].price > window[i + 1].price && window[i].price > window[i + 2].price) {
        highs.push(window[i]);
      }
    }
    return highs;
  }
  const highs = findRecentHighs(window);
  if (highs.length >= 2) {
    const [h1, h2] = highs.slice(-2);
    if (h2.price > h1.price * 1.015 && h2.rsi < h1.rsi - 3) {
      return { type: 'bearish', strength: Math.min(1, (h1.rsi - h2.rsi) / 10) };
    }
  }
  return null;
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
export function computeAllIndicators(prices, volumes) {
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

  // v2.72 — Indicateurs avancés (privés aux agents)
  const m200 = sma200(prices);
  if (m200 != null) {
    const distance = ((last - m200) / m200) * 100;
    out.sma200 = {
      value: m200, distance,
      signal: last > m200 ? 'bull' : 'bear',
      extended: Math.abs(distance) > 20,
    };
  }
  if (Array.isArray(volumes) && volumes.length >= 20) {
    const vw = vwap(prices, volumes, 20);
    if (vw != null) out.vwap = { value: vw, signal: last > vw ? 'bull' : 'bear', distancePct: ((last - vw) / vw) * 100 };
    const ob = obv(prices, volumes, 20);
    if (ob) out.obv = { value: ob.value, trend: ob.trend, signal: ob.trend === 'up' ? 'bull' : ob.trend === 'down' ? 'bear' : 'neutral' };
    const mf = mfi(prices, volumes);
    if (mf != null) out.mfi = { value: mf, signal: mf < 20 ? 'bull' : mf > 80 ? 'bear' : 'neutral' };
    const fi = forceIndex(prices, volumes);
    if (fi != null) out.forceIndex = { value: fi, signal: fi > 0 ? 'bull' : 'bear' };
  }
  const hma = hullMA(prices, 14);
  if (hma != null) out.hullMA = { value: hma, signal: last > hma ? 'bull' : 'bear' };
  const di = directionalIndex(prices);
  if (di) out.directional = { plusDI: di.plusDI, minusDI: di.minusDI, signal: di.plusDI > di.minusDI ? 'bull' : 'bear' };
  const div = rsiDivergence(prices);
  if (div) out.rsiDivergence = { type: div.type, strength: div.strength, signal: div.type === 'bullish' ? 'bull' : 'bear' };

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

export async function fetchYahooHistorical(symbol, range = '6mo') {
  // v2.72 — range étendu à 6mo pour permettre le calcul de SMA200
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (trade-genius-bot)' } });
  if (!r.ok) throw new Error(`Yahoo ${symbol} HTTP ${r.status}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`Yahoo ${symbol} bad payload`);
  const quote = res.indicators?.quote?.[0] || {};
  const rawCloses = quote.close || [];
  const rawVolumes = quote.volume || [];
  // On garde les paires (close, volume) où close existe
  const closes = [], volumes = [];
  for (let i = 0; i < rawCloses.length; i++) {
    if (rawCloses[i] != null) {
      closes.push(rawCloses[i]);
      volumes.push(rawVolumes[i] != null ? rawVolumes[i] : 0);
    }
  }
  const meta = res.meta || {};
  return {
    symbol,
    name: meta.shortName || meta.longName || symbol,
    price: meta.regularMarketPrice ?? closes[closes.length - 1],
    prevClose: meta.previousClose ?? closes[closes.length - 2],
    prices: closes, volumes,
    currency: meta.currency || 'USD',
  };
}

export async function fetchCoinGeckoHistorical(id, days = 200) {
  // v2.72 — 200j pour permettre SMA200
  const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const r = await fetch(url, { headers: { 'user-agent': 'trade-genius-bot/1.0' } });
  if (!r.ok) throw new Error(`CoinGecko ${id} HTTP ${r.status}`);
  const j = await r.json();
  const prices = (j.prices || []).map(p => p[1]);
  const volumes = (j.total_volumes || []).map(v => v[1]);
  return {
    id,
    prices, volumes,
    price: prices[prices.length - 1],
    prevClose: prices[prices.length - 2],
    currency: 'USD',
  };
}
