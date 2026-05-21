/**
 * tg-analyst.js — v2.51
 *
 * FAB flottant universel qui analyse l'actif en cours et donne un verdict
 * tranché "quoi faire" (acheteur / vendeur / attendre) avec plan d'action.
 *
 * Inclus sur toutes les pages via <script src="tg-analyst.js"></script>.
 * S'auto-injecte au DOMContentLoaded. Zéro dépendance.
 *
 * Cadre AMF : on ne dit jamais "achète/vends" directement. On parle de
 * "configuration favorable aux acheteurs", "ce qu'un trader regarderait",
 * "schéma observé". Le verdict est tranché mais reste pédagogique.
 */
(function () {
  'use strict';

  // ───────────────────────────────────────────────────────────────────
  // Catalogue d'actifs (mini-picker)
  // ───────────────────────────────────────────────────────────────────
  // v2.60 — Catalogue étendu : crypto + indices + actions + forex + métaux
  const CATALOG = [
    // ── Crypto top 16 (CoinGecko id) ──
    { id: 'bitcoin',      label: 'Bitcoin',    sym: 'BTC',  kind: 'crypto', emoji: '₿',  currency: 'USD' },
    { id: 'ethereum',     label: 'Ethereum',   sym: 'ETH',  kind: 'crypto', emoji: 'Ξ',  currency: 'USD' },
    { id: 'solana',       label: 'Solana',     sym: 'SOL',  kind: 'crypto', emoji: '◎',  currency: 'USD' },
    { id: 'binancecoin',  label: 'BNB',        sym: 'BNB',  kind: 'crypto', emoji: '🟡', currency: 'USD' },
    { id: 'ripple',       label: 'XRP',        sym: 'XRP',  kind: 'crypto', emoji: '✕',  currency: 'USD' },
    { id: 'cardano',      label: 'Cardano',    sym: 'ADA',  kind: 'crypto', emoji: '🔷', currency: 'USD' },
    { id: 'dogecoin',     label: 'Dogecoin',   sym: 'DOGE', kind: 'crypto', emoji: '🐕', currency: 'USD' },
    { id: 'avalanche-2',  label: 'Avalanche',  sym: 'AVAX', kind: 'crypto', emoji: '🔺', currency: 'USD' },
    { id: 'polkadot',     label: 'Polkadot',   sym: 'DOT',  kind: 'crypto', emoji: '⚫', currency: 'USD' },
    { id: 'chainlink',    label: 'Chainlink',  sym: 'LINK', kind: 'crypto', emoji: '🔗', currency: 'USD' },
    { id: 'tron',         label: 'TRON',       sym: 'TRX',  kind: 'crypto', emoji: '🎮', currency: 'USD' },
    { id: 'litecoin',     label: 'Litecoin',   sym: 'LTC',  kind: 'crypto', emoji: 'Ł',  currency: 'USD' },
    { id: 'uniswap',      label: 'Uniswap',    sym: 'UNI',  kind: 'crypto', emoji: '🦄', currency: 'USD' },
    { id: 'cosmos',       label: 'Cosmos',     sym: 'ATOM', kind: 'crypto', emoji: '⚛',  currency: 'USD' },
    { id: 'stellar',      label: 'Stellar',    sym: 'XLM',  kind: 'crypto', emoji: '⭐', currency: 'USD' },
    { id: 'near',         label: 'NEAR',       sym: 'NEAR', kind: 'crypto', emoji: '🌐', currency: 'USD' },
    // ── Indices monde (Yahoo symbol) ──
    { id: '^GSPC',     label: 'S&P 500',       sym: 'SPX',     kind: 'index', emoji: '🇺🇸', currency: 'USD' },
    { id: '^IXIC',     label: 'Nasdaq',        sym: 'NDX',     kind: 'index', emoji: '💻', currency: 'USD' },
    { id: '^DJI',      label: 'Dow Jones',     sym: 'DJI',     kind: 'index', emoji: '🏛', currency: 'USD' },
    { id: '^RUT',      label: 'Russell 2000',  sym: 'RUT',     kind: 'index', emoji: '🏗', currency: 'USD' },
    { id: '^FCHI',     label: 'CAC 40',        sym: 'CAC',     kind: 'index', emoji: '🇫🇷', currency: 'EUR' },
    { id: '^GDAXI',    label: 'DAX',           sym: 'DAX',     kind: 'index', emoji: '🇩🇪', currency: 'EUR' },
    { id: '^FTSE',     label: 'FTSE 100',      sym: 'UKX',     kind: 'index', emoji: '🇬🇧', currency: 'GBP' },
    { id: '^STOXX50E', label: 'Euro Stoxx 50', sym: 'SX5E',    kind: 'index', emoji: '🇪🇺', currency: 'EUR' },
    { id: '^N225',     label: 'Nikkei 225',    sym: 'N225',    kind: 'index', emoji: '🇯🇵', currency: 'JPY' },
    { id: '^HSI',      label: 'Hang Seng',     sym: 'HSI',     kind: 'index', emoji: '🇭🇰', currency: 'HKD' },
    // ── Actions US blue-chips ──
    { id: 'AAPL',  label: 'Apple',     sym: 'AAPL',  kind: 'action', emoji: '🍎', currency: 'USD' },
    { id: 'MSFT',  label: 'Microsoft', sym: 'MSFT',  kind: 'action', emoji: '🪟', currency: 'USD' },
    { id: 'GOOGL', label: 'Alphabet',  sym: 'GOOGL', kind: 'action', emoji: '🔍', currency: 'USD' },
    { id: 'AMZN',  label: 'Amazon',    sym: 'AMZN',  kind: 'action', emoji: '📦', currency: 'USD' },
    { id: 'META',  label: 'Meta',      sym: 'META',  kind: 'action', emoji: '👤', currency: 'USD' },
    { id: 'NVDA',  label: 'Nvidia',    sym: 'NVDA',  kind: 'action', emoji: '🟢', currency: 'USD' },
    { id: 'TSLA',  label: 'Tesla',     sym: 'TSLA',  kind: 'action', emoji: '🚗', currency: 'USD' },
    { id: 'AMD',   label: 'AMD',       sym: 'AMD',   kind: 'action', emoji: '🔴', currency: 'USD' },
    { id: 'NFLX',  label: 'Netflix',   sym: 'NFLX',  kind: 'action', emoji: '🎬', currency: 'USD' },
    { id: 'JPM',   label: 'JPMorgan',  sym: 'JPM',   kind: 'action', emoji: '🏦', currency: 'USD' },
    { id: 'V',     label: 'Visa',      sym: 'V',     kind: 'action', emoji: '💳', currency: 'USD' },
    { id: 'WMT',   label: 'Walmart',   sym: 'WMT',   kind: 'action', emoji: '🛒', currency: 'USD' },
    { id: 'KO',    label: 'Coca-Cola', sym: 'KO',    kind: 'action', emoji: '🥤', currency: 'USD' },
    // ── Actions EU ──
    { id: 'MC.PA',  label: 'LVMH',           sym: 'MC',    kind: 'action', emoji: '👜', currency: 'EUR' },
    { id: 'TTE.PA', label: 'TotalEnergies',  sym: 'TTE',   kind: 'action', emoji: '⛽', currency: 'EUR' },
    { id: 'AIR.PA', label: 'Airbus',         sym: 'AIR',   kind: 'action', emoji: '✈',  currency: 'EUR' },
    { id: 'SAN.PA', label: 'Sanofi',         sym: 'SAN',   kind: 'action', emoji: '💊', currency: 'EUR' },
    { id: 'ASML.AS',label: 'ASML',           sym: 'ASML',  kind: 'action', emoji: '🔬', currency: 'EUR' },
    // ── Forex majors ──
    { id: 'EURUSD=X', label: 'EUR/USD', sym: 'EURUSD', kind: 'forex', emoji: '💱', currency: 'USD' },
    { id: 'GBPUSD=X', label: 'GBP/USD', sym: 'GBPUSD', kind: 'forex', emoji: '💱', currency: 'USD' },
    { id: 'USDJPY=X', label: 'USD/JPY', sym: 'USDJPY', kind: 'forex', emoji: '💱', currency: 'JPY' },
    { id: 'USDCHF=X', label: 'USD/CHF', sym: 'USDCHF', kind: 'forex', emoji: '💱', currency: 'CHF' },
    { id: 'AUDUSD=X', label: 'AUD/USD', sym: 'AUDUSD', kind: 'forex', emoji: '💱', currency: 'USD' },
    { id: 'USDCAD=X', label: 'USD/CAD', sym: 'USDCAD', kind: 'forex', emoji: '💱', currency: 'CAD' },
    { id: 'EURGBP=X', label: 'EUR/GBP', sym: 'EURGBP', kind: 'forex', emoji: '💱', currency: 'GBP' },
    { id: 'EURJPY=X', label: 'EUR/JPY', sym: 'EURJPY', kind: 'forex', emoji: '💱', currency: 'JPY' },
    // ── Métaux & matières premières ──
    { id: 'GC=F', label: 'Or (Gold)',         sym: 'XAU', kind: 'metal', emoji: '🥇', currency: 'USD' },
    { id: 'SI=F', label: 'Argent (Silver)',   sym: 'XAG', kind: 'metal', emoji: '🥈', currency: 'USD' },
    { id: 'PL=F', label: 'Platine',           sym: 'XPT', kind: 'metal', emoji: '⚪', currency: 'USD' },
    { id: 'PA=F', label: 'Palladium',         sym: 'XPD', kind: 'metal', emoji: '⚫', currency: 'USD' },
    { id: 'HG=F', label: 'Cuivre',            sym: 'HG',  kind: 'metal', emoji: '🟠', currency: 'USD' },
  ];

  // ───────────────────────────────────────────────────────────────────
  // Indicateurs techniques (copies compactes de index.html)
  // ───────────────────────────────────────────────────────────────────
  const _last = (a) => a[a.length - 1];
  function sma(arr, p) { if (arr.length < p) return null; let s = 0; for (let i = arr.length - p; i < arr.length; i++) s += arr[i]; return s / p; }
  function ema(arr, p) {
    if (arr.length < p) return null;
    const k = 2 / (p + 1); let e = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
    for (let i = p; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
    return e;
  }
  function rsi(prices, p = 14) {
    if (prices.length < p + 1) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) { const d = prices[i] - prices[i-1]; if (d >= 0) g += d; else l -= d; }
    g /= p; l /= p;
    for (let i = p + 1; i < prices.length; i++) {
      const d = prices[i] - prices[i-1];
      g = (g * (p-1) + Math.max(d, 0)) / p;
      l = (l * (p-1) + Math.max(-d, 0)) / p;
    }
    if (l === 0) return 100;
    return 100 - (100 / (1 + g / l));
  }
  function macdHist(prices) {
    if (prices.length < 35) return null;
    const e12 = ema(prices, 12), e26 = ema(prices, 26);
    if (e12 == null || e26 == null) return null;
    const macdLine = e12 - e26;
    // signal = EMA9 du MACD line — approximation : reconstituer 9 dernières
    const macds = [];
    for (let i = 26; i <= prices.length; i++) {
      const slice = prices.slice(0, i);
      const a = ema(slice, 12), b = ema(slice, 26);
      if (a != null && b != null) macds.push(a - b);
    }
    if (macds.length < 9) return macdLine;
    const sig = ema(macds, 9);
    return macdLine - sig;
  }
  function bollingerPos(prices, p = 20, k = 2) {
    if (prices.length < p) return null;
    const slice = prices.slice(-p);
    const m = slice.reduce((a, b) => a + b, 0) / p;
    const v = slice.reduce((s, x) => s + (x - m) ** 2, 0) / p;
    const sd = Math.sqrt(v);
    const upper = m + k * sd, lower = m - k * sd;
    if (upper === lower) return 0.5;
    return (_last(prices) - lower) / (upper - lower);
  }
  function atrPct(prices, p = 14) {
    if (prices.length < p + 1) return null;
    let s = 0, n = 0;
    for (let i = prices.length - p; i < prices.length; i++) {
      s += Math.abs(prices[i] - prices[i-1]) / prices[i-1];
      n++;
    }
    return (s / n) * 100;
  }
  function adx(prices, p = 14) {
    if (prices.length < p + 1) return null;
    let upSum = 0, dnSum = 0, n = 0;
    for (let i = prices.length - p; i < prices.length; i++) {
      const d = prices[i] - prices[i-1];
      if (d > 0) upSum += d;
      else dnSum += -d;
      n++;
    }
    const range = upSum + dnSum;
    if (range === 0) return 0;
    return (Math.abs(upSum - dnSum) / range) * 100;
  }
  // v2.68 — Ichimoku Kinko Hyo
  function ichimoku(prices) {
    if (!prices || prices.length < 52) return null;
    const hh = (n) => Math.max.apply(null, prices.slice(-n));
    const ll = (n) => Math.min.apply(null, prices.slice(-n));
    const tenkan = (hh(9) + ll(9)) / 2;
    const kijun = (hh(26) + ll(26)) / 2;
    const spanA = (tenkan + kijun) / 2;
    const spanB = (hh(52) + ll(52)) / 2;
    const cloudHigh = Math.max(spanA, spanB);
    const cloudLow = Math.min(spanA, spanB);
    const last = _last(prices);
    let position = 'inside';
    let signal = 'neutral';
    if (last > cloudHigh) { position = 'above'; signal = tenkan > kijun ? 'bull' : 'neutral'; }
    else if (last < cloudLow) { position = 'below'; signal = tenkan < kijun ? 'bear' : 'neutral'; }
    return { tenkan, kijun, spanA, spanB, cloudHigh, cloudLow, position, signal, tkCross: tenkan > kijun ? 'bull' : 'bear' };
  }

  function computeIndicators(prices, volumes) {
    if (!prices || prices.length < 30) return null;
    const last = _last(prices);
    const r = rsi(prices);
    const m20 = sma(prices, 20);
    const m50 = sma(prices, 50) || sma(prices, Math.min(50, prices.length - 1));
    const macd = macdHist(prices);
    const boll = bollingerPos(prices);
    const at = atrPct(prices);
    const ax = adx(prices);
    const mom = prices.length > 11 ? ((last - prices[prices.length - 11]) / prices[prices.length - 11]) * 100 : 0;
    const ichi = ichimoku(prices);
    // v2.67 — Volume : ratio volume actuel / moyenne 20j
    let volRatio = null, lastVol = null, avgVol = null;
    if (Array.isArray(volumes) && volumes.length >= 20) {
      lastVol = volumes[volumes.length - 1];
      const last20 = volumes.slice(-20);
      avgVol = last20.reduce((a, b) => a + b, 0) / last20.length;
      if (avgVol > 0) volRatio = lastVol / avgVol;
    }
    // ATH / ATL sur la période
    const high = Math.max.apply(null, prices);
    const low = Math.min.apply(null, prices);
    const fromHigh = ((last - high) / high) * 100;
    const fromLow = ((last - low) / low) * 100;
    return { last, rsi: r, ma20: m20, ma50: m50, macd, boll, atr: at, adx: ax, mom,
      volRatio, lastVol, avgVol, high, low, fromHigh, fromLow,
      ichimoku: ichi };
  }

  // ───────────────────────────────────────────────────────────────────
  // Pattern detector (synchronisé avec celui d'index.html)
  // ───────────────────────────────────────────────────────────────────
  function findSwings(prices, lb) {
    lb = lb || 3;
    const highs = [], lows = [];
    for (let i = lb; i < prices.length - lb; i++) {
      let isH = true, isL = true;
      for (let j = 1; j <= lb; j++) {
        if (prices[i] <= prices[i-j] || prices[i] <= prices[i+j]) isH = false;
        if (prices[i] >= prices[i-j] || prices[i] >= prices[i+j]) isL = false;
      }
      if (isH) highs.push({ idx: i, price: prices[i] });
      if (isL) lows.push({ idx: i, price: prices[i] });
    }
    return { highs, lows };
  }

  function detectPatterns(prices) {
    if (!prices || prices.length < 30) return [];
    const last = _last(prices);
    const s = findSwings(prices, 3);
    const out = [];

    // Double bottom — v2.52 : on prend les 2 derniers lows uniquement, exigences serrées
    if (s.lows.length >= 2) {
      const l1 = s.lows[s.lows.length - 2];
      const l2 = s.lows[s.lows.length - 1];
      const diff = Math.abs(l1.price - l2.price) / l1.price;
      const between = s.highs.filter(h => h.idx > l1.idx && h.idx < l2.idx);
      if (l2.idx - l1.idx >= 5 && diff <= 0.04 && between.length > 0) {
        const neckline = Math.max.apply(null, between.map(h => h.price));
        const minLow = Math.min(l1.price, l2.price);
        if (last >= minLow * 1.005) {
          out.push({ name: 'Double bottom', icon: 'W', direction: 'bullish',
            confidence: (diff < 0.02 && last > neckline) ? 'high' : 'medium',
            description: 'Deux creux au même niveau (~' + minLow.toFixed(2) + ') séparés par un sommet (~' + neckline.toFixed(2) + ').',
            why: 'Le marché a testé deux fois le même support sans le casser : les vendeurs s\'essoufflent.',
            neckline, target: neckline + (neckline - minLow), stop: minLow * 0.98,
            lastIdx: l2.idx });
        }
      }
    }
    // Double top
    if (s.highs.length >= 2) {
      const h1 = s.highs[s.highs.length - 2];
      const h2 = s.highs[s.highs.length - 1];
      const diff = Math.abs(h1.price - h2.price) / h1.price;
      const between = s.lows.filter(l => l.idx > h1.idx && l.idx < h2.idx);
      if (h2.idx - h1.idx >= 5 && diff <= 0.04 && between.length > 0) {
        const neckline = Math.min.apply(null, between.map(l => l.price));
        const maxHigh = Math.max(h1.price, h2.price);
        if (last <= maxHigh * 0.995) {
          out.push({ name: 'Double top', icon: 'M', direction: 'bearish',
            confidence: (diff < 0.02 && last < neckline) ? 'high' : 'medium',
            description: 'Deux sommets au même niveau (~' + maxHigh.toFixed(2) + ') séparés par un creux (~' + neckline.toFixed(2) + ').',
            why: 'Le marché a tenté deux fois de passer la même résistance sans y arriver.',
            neckline, target: neckline - (maxHigh - neckline), stop: maxHigh * 1.02,
            lastIdx: h2.idx });
        }
      }
    }
    // Tendance HH/HL ou LH/LL
    if (s.lows.length >= 2 && s.highs.length >= 2) {
      const lh = s.highs.slice(-2), ll = s.lows.slice(-2);
      const lastIdx = Math.max(lh[1].idx, ll[1].idx);
      const hhH = lh[1].price > lh[0].price;
      const hhL = ll[1].price > ll[0].price;
      const lhH = lh[1].price < lh[0].price;
      const lhL = ll[1].price < ll[0].price;
      if (hhH && hhL) out.push({ name: 'Tendance haussière (HH + HL)', icon: '↗', direction: 'bullish', confidence: 'medium',
        description: 'Sommets et creux progressent vers le haut.',
        why: 'Chaque correction trouve un support plus haut : les acheteurs dominent.', lastIdx });
      else if (lhH && lhL) out.push({ name: 'Tendance baissière (LH + LL)', icon: '↘', direction: 'bearish', confidence: 'medium',
        description: 'Sommets et creux descendent.',
        why: 'Chaque rebond échoue plus bas que le précédent : les vendeurs dominent.', lastIdx });
    }
    // Triangles
    const rH = s.highs.filter(h => h.idx >= prices.length - 30);
    const rL = s.lows.filter(l => l.idx >= prices.length - 30);
    if (rH.length >= 2 && rL.length >= 2) {
      const hiT = (rH[rH.length-1].price - rH[0].price) / rH[0].price;
      const loT = (rL[rL.length-1].price - rL[0].price) / rL[0].price;
      const lastIdx = Math.max(rH[rH.length-1].idx, rL[rL.length-1].idx);
      if (Math.abs(hiT) < 0.015 && loT > 0.02) {
        const res = rH.map(h => h.price).reduce((a, b) => a + b, 0) / rH.length;
        out.push({ name: 'Triangle ascendant', icon: '◢', direction: 'bullish', confidence: 'medium',
          description: 'Sommets sur ligne horizontale (~' + res.toFixed(2) + '), creux montants.',
          why: 'Le prix bute sur la même résistance mais les acheteurs entrent de plus en plus haut.',
          target: res + (res - rL[0].price), stop: rL[rL.length-1].price * 0.98, lastIdx });
      } else if (Math.abs(loT) < 0.015 && hiT < -0.02) {
        const sup = rL.map(l => l.price).reduce((a, b) => a + b, 0) / rL.length;
        out.push({ name: 'Triangle descendant', icon: '◣', direction: 'bearish', confidence: 'medium',
          description: 'Creux sur ligne horizontale (~' + sup.toFixed(2) + '), sommets descendants.',
          why: 'Les acheteurs défendent le même support mais les vendeurs entrent de plus en plus bas.',
          target: sup - (rH[0].price - sup), stop: rH[rH.length-1].price * 1.02, lastIdx });
      } else if (hiT < -0.012 && loT > 0.012) {
        out.push({ name: 'Triangle symétrique', icon: '◆', direction: 'neutral', confidence: 'medium',
          description: 'Sommets et creux convergent : compression de volatilité.',
          why: 'La volatilité se contracte avant d\'"exploser". La direction de cassure suit la tendance précédente.',
          lastIdx });
      }
    }
    // v2.69 — Doji (doji-reversal du formateur IVT Live Trading)
    _detectDoji(prices, out);
    // v2.52 — Filtrage des contradictions (bullish + bearish coexistants)
    return filterContradictions(out);
  }

  // v2.74 — Doji simple + Ponchy (Doji + Ichimoku ascendant + MA7 ascendante = signature Deponchy)
  function _detectDoji(prices, out) {
    if (!prices || prices.length < 5) return;
    const N = prices.length;
    const c1 = prices[N - 1], c2 = prices[N - 2], c3 = prices[N - 3], c4 = prices[N - 4];
    const DOJI_TH = 0.003, BODY_TH = 0.005;
    const mv = (a, b) => (a - b) / b;
    const dojiMove = Math.abs(mv(c2, c3));
    const confirmMove = mv(c1, c2);
    const contextMove = mv(c3, c4);
    const ponchy = _checkPonchyConfirmations(prices);
    if (contextMove < -BODY_TH && dojiMove < DOJI_TH && confirmMove > BODY_TH) {
      if (ponchy.bullish) {
        out.push({
          name: 'Ponchy', icon: '🎯', direction: 'bullish', confidence: 'high',
          description: 'Doji + Ichimoku cloud ascendant + MA7 ascendante : triple confluence détectée.',
          why: 'Pattern Ponchy (signature Deponchy Studio) : retournement Doji confirmé par structure de tendance Ichimoku haussière ET moyenne courte ascendante. Très haute conviction. Stop au plus bas de la bougie rouge, sortie au prochain Doji baissier.',
          stop: Math.min(c3, c4) * 0.998,
          lastIdx: N - 1,
        });
      } else {
        out.push({
          name: 'Doji haussier', icon: '🟡', direction: 'bullish',
          confidence: confirmMove > 0.01 ? 'high' : 'medium',
          description: 'Doji ' + (dojiMove * 100).toFixed(2) + '% après bougie rouge ' + (contextMove * 100).toFixed(1) + '%, puis bougie verte +' + (confirmMove * 100).toFixed(1) + '%.',
          why: 'Après une chute, un doji marque le combat acheteur/vendeur. La bougie verte confirme que les acheteurs ont gagné. Stop au plus bas de la bougie rouge. Pour un signal Ponchy premium, il faudrait aussi Ichimoku ascendant et MA7 ascendante.',
          stop: Math.min(c3, c4) * 0.998,
          lastIdx: N - 1,
        });
      }
    }
    if (contextMove > BODY_TH && dojiMove < DOJI_TH && confirmMove < -BODY_TH) {
      if (ponchy.bearish) {
        out.push({
          name: 'Ponchy baissier', icon: '🎯', direction: 'bearish', confidence: 'high',
          description: 'Doji + Ichimoku cloud descendant + MA7 descendante : triple confluence baissière.',
          why: 'Inverse du Ponchy haussier : 3 signaux baissiers alignés. Stop au plus haut de la bougie verte.',
          stop: Math.max(c3, c4) * 1.002,
          lastIdx: N - 1,
        });
      } else {
        out.push({
          name: 'Doji baissier', icon: '🟡', direction: 'bearish',
          confidence: Math.abs(confirmMove) > 0.01 ? 'high' : 'medium',
          description: 'Doji après bougie verte +' + (contextMove * 100).toFixed(1) + '%, puis bougie rouge ' + (confirmMove * 100).toFixed(1) + '%.',
          why: 'Doji marque l\'épuisement des acheteurs, la bougie rouge confirme. Stop au plus haut de la bougie verte.',
          stop: Math.max(c3, c4) * 1.002,
          lastIdx: N - 1,
        });
      }
    }
  }

  // v2.74 — Vérifie les 2 confirmations Ponchy : Ichimoku ascendant + MA7 ascendante
  function _checkPonchyConfirmations(prices) {
    if (!prices || prices.length < 60) return { bullish: false, bearish: false };
    const sma7 = (end) => {
      let s = 0;
      for (let i = end - 7; i < end; i++) s += prices[i];
      return s / 7;
    };
    const ma7Now = sma7(prices.length);
    const ma7Prev3 = sma7(prices.length - 3);
    const ma7Up = ma7Now > ma7Prev3 * 1.003;
    const ma7Down = ma7Now < ma7Prev3 * 0.997;
    const calcCloudMid = (endIdx) => {
      const subset = prices.slice(0, endIdx);
      if (subset.length < 52) return null;
      const hh = (n) => Math.max.apply(null, subset.slice(-n));
      const ll = (n) => Math.min.apply(null, subset.slice(-n));
      const tenkan = (hh(9) + ll(9)) / 2;
      const kijun = (hh(26) + ll(26)) / 2;
      const spanA = (tenkan + kijun) / 2;
      const spanB = (hh(52) + ll(52)) / 2;
      return { mid: (spanA + spanB) / 2, tenkanAboveKijun: tenkan > kijun };
    };
    const now = calcCloudMid(prices.length);
    const prev = calcCloudMid(prices.length - 5);
    if (!now || !prev) return { bullish: false, bearish: false };
    const cloudUp = now.mid > prev.mid * 1.005 && now.tenkanAboveKijun;
    const cloudDown = now.mid < prev.mid * 0.995 && !now.tenkanAboveKijun;
    return { bullish: ma7Up && cloudUp, bearish: ma7Down && cloudDown };
  }

  function filterContradictions(patterns) {
    if (patterns.length <= 1) return patterns;
    const bull = patterns.filter(p => p.direction === 'bullish');
    const bear = patterns.filter(p => p.direction === 'bearish');
    const neutral = patterns.filter(p => p.direction === 'neutral');
    if (bull.length === 0 || bear.length === 0) return patterns;
    const bullMax = Math.max.apply(null, bull.map(p => p.lastIdx || 0));
    const bearMax = Math.max.apply(null, bear.map(p => p.lastIdx || 0));
    if (bullMax > bearMax + 1) return bull.concat(neutral);
    if (bearMax > bullMax + 1) return bear.concat(neutral);
    const bullHigh = bull.some(p => p.confidence === 'high');
    const bearHigh = bear.some(p => p.confidence === 'high');
    if (bullHigh && !bearHigh) return bull.concat(neutral);
    if (bearHigh && !bullHigh) return bear.concat(neutral);
    return neutral;
  }

  // ───────────────────────────────────────────────────────────────────
  // v2.54 — Verdict tranché en mode ULTRA FIABLE
  // Compte les confirmations alignées (bullish / bearish). Ne tranche que si
  // on a un alignement net (>= 4 confirmations cohérentes sans contradiction).
  // Sinon "attendre". Plus de faux signaux.
  // ───────────────────────────────────────────────────────────────────
  function tranchantVerdict(ind, patterns) {
    // 1) Calcul du score continu (0-100) — pour affichage
    let score = 50;
    if (ind.rsi != null) {
      if (ind.rsi < 30) score += 12;
      else if (ind.rsi > 70) score -= 12;
      else if (ind.rsi > 55) score += 6;
      else if (ind.rsi < 45) score -= 6;
    }
    if (ind.ma20 != null && ind.ma50 != null) score += ind.ma20 > ind.ma50 ? 8 : -8;
    if (ind.last != null && ind.ma20 != null) score += ind.last > ind.ma20 ? 4 : -4;
    if (ind.macd != null) score += ind.macd > 0 ? 6 : -6;
    if (ind.boll != null) {
      if (ind.boll < 0.15) score += 8;
      else if (ind.boll > 0.85) score -= 8;
    }
    if (ind.mom != null) score += Math.max(-8, Math.min(8, ind.mom));
    const bullPat = patterns.filter(p => p.direction === 'bullish').length;
    const bearPat = patterns.filter(p => p.direction === 'bearish').length;
    score += bullPat * 7 - bearPat * 7;
    if (ind.adx != null && ind.adx > 25) score = 50 + (score - 50) * 1.2;
    score = Math.round(Math.max(0, Math.min(100, score)));

    // 2) Compte des CONFIRMATIONS alignées (strict) — c'est ce qui décide
    const bullSignals = [];
    const bearSignals = [];
    if (ind.rsi != null) {
      if (ind.rsi >= 50 && ind.rsi <= 70) bullSignals.push('RSI sain (' + ind.rsi.toFixed(0) + ')');
      else if (ind.rsi < 30) bullSignals.push('RSI survente');
      else if (ind.rsi > 70) bearSignals.push('RSI surachat');
      else if (ind.rsi < 50) bearSignals.push('RSI faible (' + ind.rsi.toFixed(0) + ')');
    }
    if (ind.ma20 != null && ind.ma50 != null) {
      if (ind.ma20 > ind.ma50) bullSignals.push('MA20 > MA50');
      else bearSignals.push('MA20 < MA50');
    }
    if (ind.last != null && ind.ma20 != null) {
      if (ind.last > ind.ma20) bullSignals.push('Prix > MA20');
      else bearSignals.push('Prix < MA20');
    }
    if (ind.macd != null) {
      if (ind.macd > 0) bullSignals.push('MACD positif');
      else bearSignals.push('MACD négatif');
    }
    if (ind.mom != null) {
      if (ind.mom > 1) bullSignals.push('Momentum +' + ind.mom.toFixed(1) + '%');
      else if (ind.mom < -1) bearSignals.push('Momentum ' + ind.mom.toFixed(1) + '%');
    }
    if (ind.boll != null) {
      if (ind.boll < 0.2) bullSignals.push('Bollinger basse');
      else if (ind.boll > 0.8) bearSignals.push('Bollinger haute');
    }
    if (bullPat > 0) bullSignals.push(bullPat + ' pattern bullish');
    if (bearPat > 0) bearSignals.push(bearPat + ' pattern bearish');
    const trendStrong = ind.adx != null && ind.adx > 22;

    const alignedBull = bullSignals.length;
    const alignedBear = bearSignals.length;
    const diff = alignedBull - alignedBear;

    let action, headline, cls;
    // Règle ULTRA FIABLE : tranche seulement si majorité claire ET tendance forte
    if (diff >= 4 && alignedBear <= 1 && trendStrong) {
      action = 'long'; cls = 'bull';
      headline = '📈 Configuration ACHETEUSE — signaux alignés';
    } else if (diff <= -4 && alignedBull <= 1 && trendStrong) {
      action = 'short'; cls = 'bear';
      headline = '📉 Configuration VENDEUSE — signaux alignés';
    } else if (diff >= 3 && alignedBear <= 2) {
      action = 'long_soft'; cls = 'bull-soft';
      headline = '🟢 Biais haussier — attends confirmation';
    } else if (diff <= -3 && alignedBull <= 2) {
      action = 'short_soft'; cls = 'bear-soft';
      headline = '🟠 Biais baissier — pas un bon moment pour acheter';
    } else {
      action = 'wait'; cls = 'neutral';
      headline = '⏸ Signaux contradictoires — Attendre';
    }
    return { score, action, headline, cls, alignedBull, alignedBear, bullSignals, bearSignals, trendStrong };
  }

  // v2.54 — Valide qu'un plan long est cohérent (TP1>entry, stop<entry, R/R≥1.8)
  function validateLongPlan(entry, stop, tp1, tp2) {
    if (stop >= entry) return null;
    if (tp1 <= entry) tp1 = entry + 1.5 * (entry - stop); // force TP1 cohérent
    if (tp2 <= tp1) tp2 = tp1 + (entry - stop);
    const rr2 = (tp2 - entry) / (entry - stop);
    if (rr2 < 1.8) return null;
    return { entry, stop, tp1, tp2, rr2 };
  }
  function validateShortPlan(entry, stop, tp1, tp2) {
    if (stop <= entry) return null;
    if (tp1 >= entry) tp1 = entry - 1.5 * (stop - entry);
    if (tp2 >= tp1) tp2 = tp1 - (stop - entry);
    const rr2 = (entry - tp2) / (stop - entry);
    if (rr2 < 1.8) return null;
    return { entry, stop, tp1, tp2, rr2 };
  }

  // Recommandation textuelle pédagogique (AMF-safe)
  function recommendation(verdict, ind, patterns) {
    const mainPat = patterns.find(p => p.direction !== 'neutral') || patterns[0];
    const txt = [];
    if (verdict.action === 'long' || verdict.action === 'long_soft') {
      txt.push(verdict.action === 'long'
        ? 'Plusieurs signaux convergent vers les acheteurs. Un trader expérimenté testerait ici un position longue (achat) avec un stop loss serré.'
        : 'Léger biais acheteur mais sans excès. Un trader patient attendrait une confirmation supplémentaire avant d\'entrer.');
      if (mainPat && mainPat.direction === 'bullish') txt.push('Pattern technique détecté : ' + mainPat.name + ' — ' + mainPat.description);
      if (ind.rsi != null && ind.rsi > 70) txt.push('⚠ Attention : RSI ' + ind.rsi.toFixed(0) + ' = zone de surachat. Le potentiel haussier restant est limité.');
    } else if (verdict.action === 'short' || verdict.action === 'short_soft') {
      txt.push(verdict.action === 'short'
        ? 'Plusieurs signaux convergent vers les vendeurs. Pour les traders qui savent shorter, c\'est une configuration à étudier. Pour les autres : éviter d\'acheter maintenant et attendre.'
        : 'Léger biais baissier. Mieux vaut ne pas être acheteur ici. Attendre que le prix retrouve un support clair.');
      if (mainPat && mainPat.direction === 'bearish') txt.push('Pattern technique détecté : ' + mainPat.name + ' — ' + mainPat.description);
      if (ind.rsi != null && ind.rsi < 30) txt.push('⚠ Attention : RSI ' + ind.rsi.toFixed(0) + ' = zone de survente. Un rebond technique est possible à tout moment.');
    } else {
      txt.push('Le marché est en consolidation ou les signaux se contredisent. Le mieux est d\'attendre une cassure claire avant de s\'engager.');
      if (ind.boll != null && ind.boll > 0.45 && ind.boll < 0.55) txt.push('Le prix est au milieu de la bande de Bollinger : pas de pression directionnelle.');
    }
    return txt;
  }

  // ───────────────────────────────────────────────────────────────────
  // Fetch prices
  // ───────────────────────────────────────────────────────────────────
  async function fetchPrices(asset) {
    return _fetchYahooOrCG(asset, 'daily');
  }

  // v2.66 — Multi-timeframe : fetch 1h en plus du daily
  async function _fetchYahooOrCG(asset, tf) {
    try {
      if (asset.kind === 'crypto') {
        // CoinGecko : days=2 donne du hourly, days=90 donne du daily
        const days = tf === 'hourly' ? 2 : 90;
        const url = 'https://api.coingecko.com/api/v3/coins/' + asset.id + '/market_chart?vs_currency=usd&days=' + days + (tf === 'daily' ? '&interval=daily' : '');
        const r = await fetch(url);
        if (!r.ok) throw new Error('CG ' + r.status);
        const j = await r.json();
        return { prices: (j.prices || []).map(p => p[1]), volumes: (j.total_volumes || []).map(v => v[1]) };
      }
      // Yahoo : 1h via interval=1h&range=1mo
      const interval = tf === 'hourly' ? '1h' : '1d';
      const range = tf === 'hourly' ? '1mo' : '3mo';
      const u = 'https://query1.finance.yahoo.com/v8/finance/chart/' + asset.id + '?interval=' + interval + '&range=' + range;
      const proxied = 'https://corsproxy.io/?' + encodeURIComponent(u);
      const r = await fetch(proxied);
      if (!r.ok) throw new Error('YF ' + r.status);
      const j = await r.json();
      const res = j && j.chart && j.chart.result && j.chart.result[0];
      if (!res) throw new Error('Bad payload');
      const quote = res.indicators && res.indicators.quote && res.indicators.quote[0] || {};
      const closes = (quote.close || []).filter(v => v != null);
      const volumes = (quote.volume || []).filter(v => v != null);
      return { prices: closes, volumes };
    } catch (e) {
      console.warn('fetch ' + tf + ' failed', e);
      return null;
    }
  }
  async function fetchPricesMulti(asset) {
    // Lance daily + hourly en parallèle
    const [d, h] = await Promise.all([
      _fetchYahooOrCG(asset, 'daily'),
      _fetchYahooOrCG(asset, 'hourly'),
    ]);
    return { daily: d, hourly: h };
  }

  // ───────────────────────────────────────────────────────────────────
  // Détection du contexte (asset courant)
  // ───────────────────────────────────────────────────────────────────
  function detectContextAsset() {
    const params = new URLSearchParams(location.search);
    const a = params.get('asset');
    if (a) {
      const f = CATALOG.find(x => x.id === a || x.sym.toLowerCase() === a.toLowerCase()
        || x.label.toLowerCase().includes(a.toLowerCase()));
      if (f) return f;
    }
    return null;
  }

  // ───────────────────────────────────────────────────────────────────
  // UI : FAB + Overlay + Picker
  // ───────────────────────────────────────────────────────────────────
  function fmtPrice(p, currency) {
    if (p == null) return '—';
    // v2.57 — Utilise le formatter central si pref != native
    if (window.TG && window.TG.formatPriceConverted && window.TG.getCurrencyPref && window.TG.getCurrencyPref() !== 'native') {
      return window.TG.formatPriceConverted(p, currency || 'USD', window.TG.fxRates);
    }
    let v;
    if (p >= 10000) v = Math.round(p).toLocaleString('fr-FR');
    else if (p >= 100) v = p.toFixed(0);
    else if (p >= 1) v = p.toFixed(2);
    else v = p.toFixed(4);
    return v + ' ' + (currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  }

  const CSS = `
    .tga-fab {
      position: fixed; right: 16px; bottom: 90px;
      width: 60px; height: 60px; border-radius: 50%;
      background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
      border: none; cursor: pointer;
      box-shadow: 0 6px 24px rgba(59,130,246,0.5), 0 2px 8px rgba(0,0,0,0.4);
      display: flex; align-items: center; justify-content: center;
      font-size: 28px; line-height: 1; color: #fff;
      z-index: 9990;
      transition: transform 0.18s, box-shadow 0.18s;
      animation: tga-pulse 3.6s ease-in-out infinite;
    }
    .tga-fab:hover { transform: scale(1.08); box-shadow: 0 8px 28px rgba(139,92,246,0.6); }
    .tga-fab:active { transform: scale(0.95); }
    .tga-fab-label {
      position: fixed; right: 84px; bottom: 100px;
      background: rgba(15,15,20,0.92); color: #fff;
      padding: 7px 11px; border-radius: 8px;
      font-family: 'Space Mono', 'Courier New', monospace; font-size: 11px;
      font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
      white-space: nowrap; z-index: 9989;
      border: 1px solid rgba(139,92,246,0.4);
      pointer-events: none;
      opacity: 0; transform: translateX(8px);
      transition: opacity 0.24s ease 0.5s, transform 0.24s ease 0.5s;
    }
    .tga-fab:hover + .tga-fab-label { opacity: 1; transform: translateX(0); }
    @keyframes tga-pulse {
      0%, 100% { box-shadow: 0 6px 24px rgba(59,130,246,0.5), 0 2px 8px rgba(0,0,0,0.4); }
      50% { box-shadow: 0 6px 30px rgba(139,92,246,0.75), 0 2px 8px rgba(0,0,0,0.4); }
    }
    @media (max-width: 360px) { .tga-fab { width: 54px; height: 54px; font-size: 24px; bottom: 84px; } }
    body.tga-no-bottomnav .tga-fab { bottom: 24px; }
    body.tga-no-bottomnav .tga-fab-label { bottom: 34px; }

    .tga-overlay {
      position: fixed; inset: 0; z-index: 10000;
      background: rgba(5,5,10,0.88);
      backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
      display: none; align-items: flex-start; justify-content: center;
      padding: 20px 12px; overflow-y: auto;
    }
    .tga-overlay.show { display: flex; }
    .tga-card {
      width: 100%; max-width: 520px;
      background: linear-gradient(180deg, rgba(20,20,28,0.98) 0%, rgba(12,12,18,0.98) 100%);
      border: 1px solid rgba(139,92,246,0.35);
      border-radius: 16px; padding: 18px 16px;
      color: #f5f5f7; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      box-shadow: 0 20px 60px rgba(0,0,0,0.7);
      margin-top: 30px;
    }
    .tga-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .tga-tag {
      font-family: 'Space Mono', monospace; font-size: 10px; font-weight: 700;
      letter-spacing: 0.08em; text-transform: uppercase; color: #c4b5fd;
      background: rgba(139,92,246,0.18); padding: 4px 9px; border-radius: 999px;
    }
    .tga-close {
      background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1);
      color: #fff; cursor: pointer; width: 30px; height: 30px;
      border-radius: 50%; font-size: 14px; font-weight: 700; line-height: 1;
    }
    .tga-loading { text-align: center; padding: 36px 8px; font-size: 14px; opacity: 0.85; }
    .tga-loading-spin {
      display: inline-block; width: 28px; height: 28px; border-radius: 50%;
      border: 3px solid rgba(139,92,246,0.25); border-top-color: #8b5cf6;
      animation: tga-spin 0.9s linear infinite; margin-bottom: 14px;
    }
    @keyframes tga-spin { to { transform: rotate(360deg); } }

    .tga-asset-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.08); }
    .tga-asset-name { font-size: 16px; font-weight: 700; color: #fff; }
    .tga-asset-name small { font-size: 12px; opacity: 0.6; font-weight: 500; margin-left: 8px; }
    .tga-asset-price { font-family: 'Space Mono', monospace; font-size: 20px; font-weight: 800; }

    .tga-verdict {
      padding: 18px 14px; border-radius: 14px; margin-bottom: 12px;
      text-align: center; position: relative; overflow: hidden;
    }
    .tga-verdict.bull { background: linear-gradient(135deg, rgba(34,197,94,0.18), rgba(34,197,94,0.05)); border: 1.5px solid rgba(34,197,94,0.45); }
    .tga-verdict.bear { background: linear-gradient(135deg, rgba(239,68,68,0.18), rgba(239,68,68,0.05)); border: 1.5px solid rgba(239,68,68,0.45); }
    .tga-verdict.bull-soft { background: linear-gradient(135deg, rgba(132,204,22,0.16), rgba(132,204,22,0.04)); border: 1.5px solid rgba(132,204,22,0.4); }
    .tga-verdict.bear-soft { background: linear-gradient(135deg, rgba(249,115,22,0.16), rgba(249,115,22,0.04)); border: 1.5px solid rgba(249,115,22,0.4); }
    .tga-verdict.neutral { background: linear-gradient(135deg, rgba(250,204,21,0.14), rgba(250,204,21,0.04)); border: 1.5px solid rgba(250,204,21,0.4); }
    /* v2.61 — Graph SVG */
    .tga-graph { margin: 8px 0 12px; border-radius: 8px; overflow: hidden; }
    .tga-graph svg { max-width: 100%; }
    /* v2.66 — Multi-timeframe */
    .tga-tf { margin: 0 0 12px; padding: 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; }
    .tga-tf-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
    .tga-tf-cell { padding: 8px; background: rgba(0,0,0,0.28); border-radius: 8px; }
    .tga-tf-label { font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.65; margin-bottom: 4px; }
    .tga-tf-val { font-family: 'Space Mono', monospace; font-size: 12px; font-weight: 700; }
    .tga-tf-val.bull { color: #86efac; }
    .tga-tf-val.bear { color: #fca5a5; }
    .tga-tf-val.bull-soft { color: #bef264; }
    .tga-tf-val.bear-soft { color: #fdba74; }
    .tga-tf-val.neutral { color: #fde68a; }
    .tga-tf-coh { display: block; text-align: center; font-size: 11.5px; font-weight: 600; padding: 6px; border-radius: 6px; }
    .tga-tf-coh.ok { background: rgba(74,222,128,0.12); color: #86efac; }
    .tga-tf-coh.warn { background: rgba(250,204,21,0.12); color: #fde68a; }
    .tga-verdict-headline { font-size: 22px; font-weight: 800; line-height: 1.2; margin-bottom: 6px; }
    .tga-verdict-score { font-family: 'Space Mono', monospace; font-size: 13px; opacity: 0.85; }
    .tga-verdict-score strong { font-size: 16px; }

    .tga-reco {
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px; padding: 12px 14px; margin-bottom: 12px;
    }
    .tga-reco-title { font-family: 'Space Mono', monospace; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #c4b5fd; margin-bottom: 6px; }
    .tga-reco p { font-size: 13px; line-height: 1.55; margin: 0 0 8px; }
    .tga-reco p:last-child { margin-bottom: 0; }

    .tga-plan { background: rgba(96,165,250,0.06); border: 1px solid rgba(96,165,250,0.28); border-radius: 12px; padding: 4px 12px; margin-bottom: 12px; }
    .tga-plan-row { display: flex; justify-content: space-between; align-items: center; padding: 9px 0; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .tga-plan-row:last-child { border-bottom: none; }
    .tga-plan-row span { opacity: 0.7; }
    .tga-plan-row strong { font-family: 'Space Mono', monospace; font-weight: 700; color: #fff; }

    .tga-ind-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; margin-bottom: 12px; }
    .tga-ind-cell { padding: 8px; border-radius: 8px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); }
    .tga-ind-name { font-size: 10px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.55; margin-bottom: 2px; }
    .tga-ind-val { font-family: 'Space Mono', monospace; font-size: 14px; font-weight: 700; }
    .tga-ind-cell.bull .tga-ind-val { color: #86efac; }
    .tga-ind-cell.bear .tga-ind-val { color: #fca5a5; }

    /* v2.54 — Signaux alignés (transparence sur la décision) */
    .tga-signals { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
    .tga-sig { font-size: 11px; padding: 4px 8px; border-radius: 6px; font-weight: 600; }
    .tga-sig.bull { background: rgba(34,197,94,0.12); color: #86efac; border: 1px solid rgba(34,197,94,0.28); }
    .tga-sig.bear { background: rgba(239,68,68,0.12); color: #fca5a5; border: 1px solid rgba(239,68,68,0.28); }
    .tga-align { font-size: 11.5px; opacity: 0.8; margin-bottom: 12px; text-align: center; padding: 6px; background: rgba(255,255,255,0.04); border-radius: 6px; }
    .tga-align strong { color: #fff; }

    .tga-disc {
      font-size: 11px; padding: 10px; border-radius: 8px;
      background: rgba(0,0,0,0.32); border-left: 2px solid rgba(250,204,21,0.5);
      line-height: 1.45; opacity: 0.78;
    }
    .tga-disc strong { color: #fde68a; }

    .tga-picker { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 8px; }
    .tga-picker-btn {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px; border-radius: 10px;
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1);
      color: #fff; cursor: pointer; text-align: left;
      transition: background 0.15s, border-color 0.15s;
    }
    .tga-picker-btn:hover { background: rgba(139,92,246,0.18); border-color: rgba(139,92,246,0.55); }
    .tga-picker-emoji { font-size: 18px; flex-shrink: 0; }
    .tga-picker-info { flex: 1; min-width: 0; }
    .tga-picker-name { font-size: 13px; font-weight: 700; line-height: 1.2; }
    .tga-picker-sub { font-size: 10.5px; opacity: 0.55; margin-top: 2px; }
    .tga-picker-section { font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.6; margin: 10px 0 4px; }
    .tga-pat { display: inline-block; margin: 4px 6px 4px 0; padding: 4px 9px; border-radius: 8px; font-size: 11px; font-weight: 600; }
    .tga-pat.bull { background: rgba(34,197,94,0.15); color: #86efac; }
    .tga-pat.bear { background: rgba(239,68,68,0.15); color: #fca5a5; }
    .tga-pat.neutral { background: rgba(250,204,21,0.15); color: #fde68a; }
    .tga-section-title { font-family: 'Space Mono', monospace; font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.65; margin: 12px 0 6px; }
  `;

  function injectStyles() {
    if (document.getElementById('tga-styles')) return;
    const s = document.createElement('style');
    s.id = 'tga-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function injectFAB() {
    if (document.getElementById('tga-fab')) return;
    // v2.53 — Le FAB n'est visible QUE dans la vue IA (#view-resultats).
    // Sur les autres pages (welcome, scene-XX, glossary, etc.) on ne l'injecte pas.
    const viewIA = document.getElementById('view-resultats');
    if (!viewIA) return;
    const fab = document.createElement('button');
    fab.id = 'tga-fab';
    fab.className = 'tga-fab';
    fab.setAttribute('aria-label', 'Analyste IA');
    fab.innerHTML = '<span aria-hidden="true">🤖</span>';
    fab.onclick = onFABClick;
    fab.style.display = 'none';
    document.body.appendChild(fab);
    const lbl = document.createElement('div');
    lbl.className = 'tga-fab-label';
    lbl.textContent = '🔍 Analyser';
    lbl.style.display = 'none';
    document.body.appendChild(lbl);
    // Détecte si on a une bottom-nav
    if (!document.querySelector('.bottom-nav, #bottom-nav')) {
      document.body.classList.add('tga-no-bottomnav');
    }
    // Affiche/cache selon la vue active
    function updateVis() {
      const active = viewIA.classList.contains('active');
      fab.style.display = active ? '' : 'none';
      lbl.style.display = active ? '' : 'none';
      // S'assure que rien n'est caché : ajoute du padding-bottom à la vue IA
      // (l'espace de 110px laisse passer le FAB + bottom-nav sans recouvrement)
      if (active) viewIA.style.paddingBottom = '110px';
    }
    const mo = new MutationObserver(updateVis);
    mo.observe(viewIA, { attributes: true, attributeFilter: ['class'] });
    updateVis();
  }

  function ensureOverlay() {
    let ov = document.getElementById('tga-overlay');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'tga-overlay';
    ov.className = 'tga-overlay';
    ov.innerHTML = '<div class="tga-card" id="tga-card"></div>';
    ov.addEventListener('click', (e) => { if (e.target === ov) closeOverlay(); });
    document.body.appendChild(ov);
    return ov;
  }
  function openOverlay(html) {
    injectStyles();
    const ov = ensureOverlay();
    document.getElementById('tga-card').innerHTML = html;
    ov.classList.add('show');
    document.body.style.overflow = 'hidden';
    if (navigator.vibrate) navigator.vibrate(6);
  }
  function closeOverlay() {
    const ov = document.getElementById('tga-overlay');
    if (ov) ov.classList.remove('show');
    document.body.style.overflow = '';
  }
  window.tgaCloseOverlay = closeOverlay;

  function loadingHTML(txt) {
    return ''
      + '<div class="tga-head">'
      +   '<span class="tga-tag">🤖 Analyste IA</span>'
      +   '<button class="tga-close" onclick="tgaCloseOverlay()" aria-label="Fermer">✕</button>'
      + '</div>'
      + '<div class="tga-loading"><div class="tga-loading-spin"></div><div>' + esc(txt || 'Analyse en cours…') + '</div></div>';
  }

  function pickerHTML() {
    const grp = (kind, title) => {
      const items = CATALOG.filter(a => a.kind === kind);
      return '<div class="tga-picker-section">' + title + '</div><div class="tga-picker">'
        + items.map(a => '<button class="tga-picker-btn" onclick="tgaAnalyze(\'' + a.id + '\')">'
          + '<span class="tga-picker-emoji">' + a.emoji + '</span>'
          + '<span class="tga-picker-info"><div class="tga-picker-name">' + esc(a.label) + '</div>'
          + '<div class="tga-picker-sub">' + esc(a.sym) + ' · ' + esc(a.currency) + '</div></span>'
          + '</button>').join('')
        + '</div>';
    };
    return ''
      + '<div class="tga-head">'
      +   '<span class="tga-tag">🤖 Analyste IA</span>'
      +   '<button class="tga-close" onclick="tgaCloseOverlay()" aria-label="Fermer">✕</button>'
      + '</div>'
      + '<h3 style="margin: 4px 0 12px; font-size: 16px; font-weight: 700;">Quel actif veux-tu analyser ?</h3>'
      + '<p style="font-size: 12.5px; opacity: 0.75; line-height: 1.5; margin: 0 0 8px;">Je vais scanner les 90 derniers jours de prix, détecter les patterns chartistes, calculer les indicateurs techniques et te donner un verdict clair.</p>'
      + grp('crypto', '⚡ Crypto')
      + grp('index', '📊 Indices')
      + grp('action', '🏢 Actions')
      + grp('forex', '💱 Forex')
      + grp('metal', '🥇 Métaux & matières premières');
  }

  async function tgaAnalyze(id) {
    const asset = CATALOG.find(a => a.id === id);
    if (!asset) return;
    openOverlay(loadingHTML('Récupération des données ' + asset.label + ' (multi-timeframe)…'));
    // v2.66 — Multi-timeframe : daily + hourly en parallèle
    const multi = await fetchPricesMulti(asset);
    const daily = multi.daily;
    if (!daily || !daily.prices || daily.prices.length < 30) {
      openOverlay(''
        + '<div class="tga-head"><span class="tga-tag">🤖 Analyste IA</span>'
        + '<button class="tga-close" onclick="tgaCloseOverlay()" aria-label="Fermer">✕</button></div>'
        + '<p style="padding: 24px 8px; text-align: center;">❌ Impossible de récupérer les données ' + esc(asset.label) + '. Vérifie ta connexion ou réessaie dans quelques instants.</p>');
      return;
    }
    const prices = daily.prices;
    const volumes = daily.volumes || [];
    const ind = computeIndicators(prices, volumes);
    const patterns = detectPatterns(prices);
    const verdict = tranchantVerdict(ind, patterns);
    const reco = recommendation(verdict, ind, patterns);
    // Mini-verdict 1h
    let hourlyVerdict = null;
    if (multi.hourly && multi.hourly.prices && multi.hourly.prices.length >= 30) {
      const indH = computeIndicators(multi.hourly.prices, multi.hourly.volumes);
      const patH = detectPatterns(multi.hourly.prices);
      hourlyVerdict = tranchantVerdict(indH, patH);
    }
    openOverlay(renderAnalysis(asset, ind, patterns, verdict, reco, prices.slice(-60), volumes.slice(-60), hourlyVerdict));
  }
  window.tgaAnalyze = tgaAnalyze;

  /* ═════════════════════════════════════════════════════════════════
     v2.67 — Comparaison historique
     Cherche dans les 90j passés des configurations RSI similaires à la
     actuelle et regarde ce qui s'est passé les 10 jours après. Donne un
     échantillon empirique de ce qu'a fait l'actif dans ces conditions.
     ═════════════════════════════════════════════════════════════════ */
  function findHistoricalMatches(prices, currentRsi, currentMomentum) {
    if (!prices || prices.length < 50 || currentRsi == null) return [];
    function rsiAt(p) {
      if (p < 14) return null;
      let g = 0, l = 0;
      for (let k = 1; k <= 14; k++) { const d = prices[p - 14 + k] - prices[p - 14 + k - 1]; if (d >= 0) g += d; else l -= d; }
      if (l === 0) return 100;
      return 100 - (100 / (1 + (g/14) / (l/14)));
    }
    const matches = [];
    // On parcourt les points historiques et on regarde ceux dont le RSI est ±5 du current
    for (let i = 30; i < prices.length - 10; i++) {
      const rsi = rsiAt(i);
      if (rsi == null) continue;
      const mom = prices.length > i - 10 && i >= 10 ? ((prices[i] - prices[i - 10]) / prices[i - 10]) * 100 : 0;
      // Match si RSI proche ET momentum dans le même sens
      if (Math.abs(rsi - currentRsi) <= 5 && Math.sign(mom) === Math.sign(currentMomentum || 0)) {
        const future = prices[i + 10];
        const pct = ((future - prices[i]) / prices[i]) * 100;
        matches.push({ i, rsi, mom, pct10d: pct });
      }
    }
    return matches;
  }

  // v2.66 — Comparaison verdict 1h vs 1d (multi-timeframe)
  function renderTfBlock(dailyV, hourlyV) {
    const sameDir = (dailyV.action === hourlyV.action)
      || (dailyV.action.startsWith('long') && hourlyV.action.startsWith('long'))
      || (dailyV.action.startsWith('short') && hourlyV.action.startsWith('short'));
    const cohesion = sameDir
      ? '<span class="tga-tf-coh ok">✅ Court & moyen terme alignés — signal renforcé</span>'
      : '<span class="tga-tf-coh warn">⚠ Divergence — court terme ≠ moyen terme, prudence</span>';
    return '<div class="tga-tf">'
      + '<div class="tga-tf-row">'
      +   '<div class="tga-tf-cell"><div class="tga-tf-label">Court terme (1 h)</div><div class="tga-tf-val ' + hourlyV.cls + '">' + (hourlyV.score) + '/100 · ' + esc(hourlyV.headline.split(' — ')[0]) + '</div></div>'
      +   '<div class="tga-tf-cell"><div class="tga-tf-label">Moyen terme (1 j)</div><div class="tga-tf-val ' + dailyV.cls + '">' + (dailyV.score) + '/100 · ' + esc(dailyV.headline.split(' — ')[0]) + '</div></div>'
      + '</div>'
      + cohesion
      + '</div>';
  }

  // v2.61 — Calcule les niveaux entry/stop/TP à dessiner selon le verdict
  function planLevelsFor(verdict, ind) {
    const lvls = {};
    if (!ind || ind.last == null) return lvls;
    const atr = ind.atr ? (ind.atr / 100) * ind.last : ind.last * 0.02;
    if (verdict.action === 'long' || verdict.action === 'long_soft') {
      lvls.entry = ind.last;
      lvls.stop = ind.last - 1.5 * atr;
      lvls.tp1 = ind.last + 1.5 * atr;
      lvls.tp2 = ind.last + 3 * atr;
    } else if (verdict.action === 'short' || verdict.action === 'short_soft') {
      lvls.entry = ind.last;
      lvls.stop = ind.last + 1.5 * atr;
      lvls.tp1 = ind.last - 1.5 * atr;
      lvls.tp2 = ind.last - 3 * atr;
    } else {
      lvls.entry = ind.last; // pour situer le prix actuel sur le graph
    }
    return lvls;
  }

  function renderAnalysis(asset, ind, patterns, verdict, reco, prices60, volumes60, hourlyVerdict) {
    // v2.54 — Plan d'action SEULEMENT si direction tranchée (long/short).
    // Plus de plan pour "wait" ou les "soft" (on évite les fausses pistes).
    let planHTML = '';
    if (verdict.action === 'long' || verdict.action === 'long_soft') {
      const atr = ind.atr ? (ind.atr / 100) * ind.last : ind.last * 0.02;
      const entry = ind.last;
      const ma20 = ind.ma20;
      // Stop : 1.5 ATR sous l'entrée OU sous MA20 si MA20 plus proche
      const stop = ma20 != null && ma20 < entry
        ? Math.min(entry - 1.5 * atr, ma20 * 0.99)
        : entry - 1.5 * atr;
      // TP1 = +1.5 ATR (toujours > entry), TP2 = +3 ATR
      const tp1 = entry + 1.5 * atr;
      const tp2 = entry + 3 * atr;
      const plan = validateLongPlan(entry, stop, tp1, tp2);
      if (plan) {
        planHTML = '<div class="tga-section-title">💡 Si tu jouais ce scénario</div>'
          + '<div class="tga-plan">'
          +   '<div class="tga-plan-row"><span>Direction</span><strong>📈 Achat (long)</strong></div>'
          +   '<div class="tga-plan-row"><span>Entrée</span><strong>' + fmtPrice(plan.entry, asset.currency) + '</strong></div>'
          +   '<div class="tga-plan-row"><span>Stop loss</span><strong>' + fmtPrice(plan.stop, asset.currency) + '</strong></div>'
          +   '<div class="tga-plan-row"><span>Cible 1</span><strong>' + fmtPrice(plan.tp1, asset.currency) + '</strong></div>'
          +   '<div class="tga-plan-row"><span>Cible 2</span><strong>' + fmtPrice(plan.tp2, asset.currency) + '</strong></div>'
          +   '<div class="tga-plan-row"><span>Risk / Reward</span><strong>1:' + plan.rr2.toFixed(2) + '</strong></div>'
          + '</div>';
      }
    } else if (verdict.action === 'short' || verdict.action === 'short_soft') {
      const atr = ind.atr ? (ind.atr / 100) * ind.last : ind.last * 0.02;
      const entry = ind.last;
      const stop = entry + 1.5 * atr;
      const tp1 = entry - 1.5 * atr;
      const tp2 = entry - 3 * atr;
      const plan = validateShortPlan(entry, stop, tp1, tp2);
      if (plan) {
        planHTML = '<div class="tga-section-title">💡 Si tu jouais ce scénario (vente à découvert)</div>'
          + '<div class="tga-plan">'
          +   '<div class="tga-plan-row"><span>Direction</span><strong>📉 Vente (short)</strong></div>'
          +   '<div class="tga-plan-row"><span>Entrée</span><strong>' + fmtPrice(plan.entry, asset.currency) + '</strong></div>'
          +   '<div class="tga-plan-row"><span>Stop loss</span><strong>' + fmtPrice(plan.stop, asset.currency) + '</strong></div>'
          +   '<div class="tga-plan-row"><span>Cible 1</span><strong>' + fmtPrice(plan.tp1, asset.currency) + '</strong></div>'
          +   '<div class="tga-plan-row"><span>Cible 2</span><strong>' + fmtPrice(plan.tp2, asset.currency) + '</strong></div>'
          +   '<div class="tga-plan-row"><span>Risk / Reward</span><strong>1:' + plan.rr2.toFixed(2) + '</strong></div>'
          + '</div>';
      }
    }

    // v2.54 — Récap des signaux alignés (transparence sur la décision)
    let signalsHTML = '';
    if (verdict.bullSignals && (verdict.bullSignals.length || verdict.bearSignals.length)) {
      signalsHTML = '<div class="tga-section-title">⚙ Signaux détectés</div><div class="tga-signals">';
      verdict.bullSignals.forEach(s => signalsHTML += '<span class="tga-sig bull">✓ ' + esc(s) + '</span>');
      verdict.bearSignals.forEach(s => signalsHTML += '<span class="tga-sig bear">✗ ' + esc(s) + '</span>');
      signalsHTML += '</div>';
      signalsHTML += '<div class="tga-align"><strong>' + verdict.alignedBull + '</strong> haussiers · <strong>' + verdict.alignedBear + '</strong> baissiers' + (verdict.trendStrong ? ' · ADX > 22 (tendance forte)' : ' · ADX faible (pas de tendance claire)') + '</div>';
    }

    // Patterns
    let patternsHTML = '';
    if (patterns.length > 0) {
      patternsHTML = '<div class="tga-section-title">🎯 Patterns détectés</div><div>'
        + patterns.map(p => '<span class="tga-pat ' + (p.direction === 'bullish' ? 'bull' : p.direction === 'bearish' ? 'bear' : 'neutral') + '">' + esc(p.name) + '</span>').join('') + '</div>';
    }

    // Indicateurs grid
    const indCell = (name, val, sig) => '<div class="tga-ind-cell ' + (sig || '') + '"><div class="tga-ind-name">' + name + '</div><div class="tga-ind-val">' + val + '</div></div>';
    let indHTML = '<div class="tga-section-title">📊 Indicateurs techniques</div><div class="tga-ind-grid">';
    if (ind.rsi != null) indHTML += indCell('RSI 14', ind.rsi.toFixed(0), ind.rsi < 30 ? 'bull' : ind.rsi > 70 ? 'bear' : '');
    if (ind.ma20 != null && ind.ma50 != null) indHTML += indCell('Tendance MA', ind.ma20 > ind.ma50 ? '↗ Haussière' : '↘ Baissière', ind.ma20 > ind.ma50 ? 'bull' : 'bear');
    if (ind.boll != null) indHTML += indCell('Bollinger', (ind.boll * 100).toFixed(0) + '%', ind.boll < 0.2 ? 'bull' : ind.boll > 0.8 ? 'bear' : '');
    if (ind.macd != null) indHTML += indCell('MACD histo', ind.macd.toFixed(2), ind.macd > 0 ? 'bull' : 'bear');
    if (ind.adx != null) indHTML += indCell('Force tendance', ind.adx.toFixed(0), ind.adx > 25 ? 'bull' : '');
    if (ind.mom != null) indHTML += indCell('Momentum 10j', (ind.mom > 0 ? '+' : '') + ind.mom.toFixed(1) + '%', ind.mom > 0 ? 'bull' : 'bear');
    // v2.67 — Volume (si dispo)
    if (ind.volRatio != null) {
      const volSig = ind.volRatio > 1.5 ? 'bull' : ind.volRatio < 0.6 ? 'bear' : '';
      indHTML += indCell('Volume vs moy20', '×' + ind.volRatio.toFixed(2), volSig);
    }
    // v2.68 — ATH / ATL (sur la période fetchée, 90 j)
    if (ind.fromHigh != null) indHTML += indCell('Vs plus haut 90j', ind.fromHigh.toFixed(1) + '%', ind.fromHigh > -5 ? 'bull' : ind.fromHigh < -20 ? 'bear' : '');
    if (ind.fromLow != null)  indHTML += indCell('Vs plus bas 90j', '+' + ind.fromLow.toFixed(1) + '%', ind.fromLow < 5 ? 'bull' : '');
    // v2.68 — Ichimoku
    if (ind.ichimoku) {
      const ich = ind.ichimoku;
      const posLabel = ich.position === 'above' ? '☁️↑ Au-dessus' : ich.position === 'below' ? '☁️↓ Sous' : '☁ Dans';
      indHTML += indCell('Ichimoku · Nuage', posLabel, ich.signal);
      indHTML += indCell('Tenkan/Kijun', ich.tkCross === 'bull' ? '↗ Bull' : '↘ Bear', ich.tkCross);
    }
    indHTML += '</div>';

    return ''
      + '<div class="tga-head">'
      +   '<span class="tga-tag">🤖 Analyste IA</span>'
      +   '<button class="tga-close" onclick="tgaCloseOverlay()" aria-label="Fermer">✕</button>'
      + '</div>'
      + '<div class="tga-asset-row">'
      +   '<div class="tga-asset-name">' + esc(asset.emoji) + ' ' + esc(asset.label) + '<small>' + esc(asset.sym) + '</small></div>'
      +   '<div class="tga-asset-price">' + fmtPrice(ind.last, asset.currency) + '</div>'
      + '</div>'
      + '<div class="tga-verdict ' + verdict.cls + '">'
      +   '<div class="tga-verdict-headline">' + esc(verdict.headline) + '</div>'
      +   '<div class="tga-verdict-score">Score technique <strong>' + verdict.score + '</strong> / 100 · timeframe journalier (90 j)</div>'
      + '</div>'
      // v2.66 — Verdict multi-timeframe (1h vs 1d)
      + (hourlyVerdict ? renderTfBlock(verdict, hourlyVerdict) : '')
      // v2.61 — Mini-graph SVG
      + ((prices60 && window.TG && window.TG.renderMiniGraph)
          ? '<div class="tga-graph">' + window.TG.renderMiniGraph(prices60, planLevelsFor(verdict, ind), { width: 480, height: 200 }) + '</div>'
          : '')
      + '<div class="tga-reco">'
      +   '<div class="tga-reco-title">📋 Ce que je te recommande</div>'
      +   reco.map(t => '<p>' + esc(t) + '</p>').join('')
      + '</div>'
      + signalsHTML
      + planHTML
      + patternsHTML
      + indHTML
      + '<div class="tga-disc"><strong>⚠ Pédagogique uniquement.</strong> Analyse technique automatique basée sur 90 jours de prix. Ce n\'est pas un conseil en investissement personnalisé. Ne risque jamais plus de 1-2 % de ton capital sur un trade.</div>';
  }

  function onFABClick() {
    const ctx = detectContextAsset();
    if (ctx) {
      tgaAnalyze(ctx.id);
    } else {
      openOverlay(pickerHTML());
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // Init
  // ───────────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    injectFAB();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
