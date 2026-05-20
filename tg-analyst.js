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
  const CATALOG = [
    // Crypto (CoinGecko id)
    { id: 'bitcoin',      label: 'Bitcoin',    sym: 'BTC',  kind: 'crypto', emoji: '₿',  currency: 'USD' },
    { id: 'ethereum',     label: 'Ethereum',   sym: 'ETH',  kind: 'crypto', emoji: 'Ξ',  currency: 'USD' },
    { id: 'solana',       label: 'Solana',     sym: 'SOL',  kind: 'crypto', emoji: '◎',  currency: 'USD' },
    { id: 'binancecoin',  label: 'BNB',        sym: 'BNB',  kind: 'crypto', emoji: '🟡', currency: 'USD' },
    { id: 'cardano',      label: 'Cardano',    sym: 'ADA',  kind: 'crypto', emoji: '🔷', currency: 'USD' },
    { id: 'ripple',       label: 'XRP',        sym: 'XRP',  kind: 'crypto', emoji: '✕',  currency: 'USD' },
    // Indices (Yahoo symbol)
    { id: '^GSPC',  label: 'S&P 500',    sym: 'SPX',   kind: 'index', emoji: '🇺🇸', currency: 'USD' },
    { id: '^IXIC',  label: 'Nasdaq',     sym: 'NDX',   kind: 'index', emoji: '💻', currency: 'USD' },
    { id: '^DJI',   label: 'Dow Jones',  sym: 'DJI',   kind: 'index', emoji: '🏛', currency: 'USD' },
    { id: '^FCHI',  label: 'CAC 40',     sym: 'CAC',   kind: 'index', emoji: '🇫🇷', currency: 'EUR' },
    { id: '^GDAXI', label: 'DAX',        sym: 'DAX',   kind: 'index', emoji: '🇩🇪', currency: 'EUR' },
    { id: '^FTSE',  label: 'FTSE 100',   sym: 'UKX',   kind: 'index', emoji: '🇬🇧', currency: 'GBP' },
    // Actions
    { id: 'AAPL', label: 'Apple',     sym: 'AAPL', kind: 'action', emoji: '🍎', currency: 'USD' },
    { id: 'TSLA', label: 'Tesla',     sym: 'TSLA', kind: 'action', emoji: '🚗', currency: 'USD' },
    { id: 'NVDA', label: 'Nvidia',    sym: 'NVDA', kind: 'action', emoji: '🟢', currency: 'USD' },
    { id: 'MSFT', label: 'Microsoft', sym: 'MSFT', kind: 'action', emoji: '🪟', currency: 'USD' },
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
  function computeIndicators(prices) {
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
    return { last, rsi: r, ma20: m20, ma50: m50, macd, boll, atr: at, adx: ax, mom };
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

    // Double bottom
    if (s.lows.length >= 2) {
      const r = s.lows.slice(-3);
      for (let i = 0; i < r.length - 1; i++) {
        const l1 = r[i], l2 = r[i+1];
        if (l2.idx - l1.idx < 5) continue;
        const diff = Math.abs(l1.price - l2.price) / l1.price;
        if (diff > 0.04) continue;
        const between = s.highs.filter(h => h.idx > l1.idx && h.idx < l2.idx);
        if (!between.length) continue;
        const neckline = Math.max(...between.map(h => h.price));
        const minLow = Math.min(l1.price, l2.price);
        const target = neckline + (neckline - minLow);
        if (last < minLow * 0.97) continue;
        out.push({ name: 'Double bottom', icon: 'W', direction: 'bullish',
          confidence: (diff < 0.02 && last > neckline) ? 'high' : 'medium',
          description: 'Deux creux au même niveau (~' + minLow.toFixed(2) + ') séparés par un sommet (~' + neckline.toFixed(2) + ').',
          why: 'Le marché a testé deux fois le même support sans le casser : les vendeurs s\'essoufflent.',
          neckline, target, stop: minLow * 0.98 });
        break;
      }
    }
    // Double top
    if (s.highs.length >= 2) {
      const r = s.highs.slice(-3);
      for (let i = 0; i < r.length - 1; i++) {
        const h1 = r[i], h2 = r[i+1];
        if (h2.idx - h1.idx < 5) continue;
        const diff = Math.abs(h1.price - h2.price) / h1.price;
        if (diff > 0.04) continue;
        const between = s.lows.filter(l => l.idx > h1.idx && l.idx < h2.idx);
        if (!between.length) continue;
        const neckline = Math.min(...between.map(l => l.price));
        const maxHigh = Math.max(h1.price, h2.price);
        const target = neckline - (maxHigh - neckline);
        if (last > maxHigh * 1.03) continue;
        out.push({ name: 'Double top', icon: 'M', direction: 'bearish',
          confidence: (diff < 0.02 && last < neckline) ? 'high' : 'medium',
          description: 'Deux sommets au même niveau (~' + maxHigh.toFixed(2) + ') séparés par un creux (~' + neckline.toFixed(2) + ').',
          why: 'Le marché a tenté deux fois de passer la même résistance sans y arriver.',
          neckline, target, stop: maxHigh * 1.02 });
        break;
      }
    }
    // Tendance HH/HL ou LH/LL
    if (s.lows.length >= 2 && s.highs.length >= 2) {
      const lh = s.highs.slice(-2), ll = s.lows.slice(-2);
      const hhH = lh[1].price > lh[0].price;
      const hhL = ll[1].price > ll[0].price;
      const lhH = lh[1].price < lh[0].price;
      const lhL = ll[1].price < ll[0].price;
      if (hhH && hhL) out.push({ name: 'Tendance haussière (HH + HL)', icon: '↗', direction: 'bullish', confidence: 'medium',
        description: 'Sommets et creux progressent vers le haut.',
        why: 'Chaque correction trouve un support plus haut : les acheteurs dominent.' });
      else if (lhH && lhL) out.push({ name: 'Tendance baissière (LH + LL)', icon: '↘', direction: 'bearish', confidence: 'medium',
        description: 'Sommets et creux descendent.',
        why: 'Chaque rebond échoue plus bas que le précédent : les vendeurs dominent.' });
    }
    // Triangles
    const rH = s.highs.filter(h => h.idx >= prices.length - 30);
    const rL = s.lows.filter(l => l.idx >= prices.length - 30);
    if (rH.length >= 2 && rL.length >= 2) {
      const hiT = (rH[rH.length-1].price - rH[0].price) / rH[0].price;
      const loT = (rL[rL.length-1].price - rL[0].price) / rL[0].price;
      if (Math.abs(hiT) < 0.015 && loT > 0.02) {
        const res = rH.map(h => h.price).reduce((a, b) => a + b, 0) / rH.length;
        out.push({ name: 'Triangle ascendant', icon: '◢', direction: 'bullish', confidence: 'medium',
          description: 'Sommets sur ligne horizontale (~' + res.toFixed(2) + '), creux montants.',
          why: 'Le prix bute sur la même résistance mais les acheteurs entrent de plus en plus haut.',
          target: res + (res - rL[0].price), stop: rL[rL.length-1].price * 0.98 });
      } else if (Math.abs(loT) < 0.015 && hiT < -0.02) {
        const sup = rL.map(l => l.price).reduce((a, b) => a + b, 0) / rL.length;
        out.push({ name: 'Triangle descendant', icon: '◣', direction: 'bearish', confidence: 'medium',
          description: 'Creux sur ligne horizontale (~' + sup.toFixed(2) + '), sommets descendants.',
          why: 'Les acheteurs défendent le même support mais les vendeurs entrent de plus en plus bas.',
          target: sup - (rH[0].price - sup), stop: rH[rH.length-1].price * 1.02 });
      } else if (hiT < -0.012 && loT > 0.012) {
        out.push({ name: 'Triangle symétrique', icon: '◆', direction: 'neutral', confidence: 'medium',
          description: 'Sommets et creux convergent : compression de volatilité.',
          why: 'La volatilité se contracte avant d\'"exploser". La direction de cassure suit la tendance précédente.' });
      }
    }
    return out;
  }

  // ───────────────────────────────────────────────────────────────────
  // Verdict tranché "quoi faire" — basé sur indicateurs + patterns
  // ───────────────────────────────────────────────────────────────────
  function tranchantVerdict(ind, patterns) {
    let score = 50;
    // Indicateurs
    if (ind.rsi != null) {
      if (ind.rsi < 30) score += 12;
      else if (ind.rsi > 70) score -= 12;
      else if (ind.rsi > 55) score += 6;
      else if (ind.rsi < 45) score -= 6;
    }
    if (ind.ma20 != null && ind.ma50 != null) {
      if (ind.ma20 > ind.ma50) score += 8;
      else score -= 8;
    }
    if (ind.last != null && ind.ma20 != null) {
      if (ind.last > ind.ma20) score += 4;
      else score -= 4;
    }
    if (ind.macd != null) score += ind.macd > 0 ? 6 : -6;
    if (ind.boll != null) {
      if (ind.boll < 0.15) score += 8;
      else if (ind.boll > 0.85) score -= 8;
    }
    if (ind.mom != null) score += Math.max(-8, Math.min(8, ind.mom));
    // Patterns
    const bullPat = patterns.filter(p => p.direction === 'bullish').length;
    const bearPat = patterns.filter(p => p.direction === 'bearish').length;
    score += bullPat * 7 - bearPat * 7;
    // ADX amplifie
    if (ind.adx != null && ind.adx > 25) score = 50 + (score - 50) * 1.2;
    score = Math.round(Math.max(0, Math.min(100, score)));

    let action, headline, cls, color;
    if (score >= 65) {
      action = 'long'; cls = 'bull'; color = '#22c55e';
      headline = '📈 Configuration ACHETEUSE';
    } else if (score <= 35) {
      action = 'short'; cls = 'bear'; color = '#ef4444';
      headline = '📉 Configuration VENDEUSE';
    } else if (score >= 55) {
      action = 'long_soft'; cls = 'bull-soft'; color = '#84cc16';
      headline = '🟢 Biais haussier modéré';
    } else if (score <= 45) {
      action = 'short_soft'; cls = 'bear-soft'; color = '#f97316';
      headline = '🟠 Biais baissier modéré';
    } else {
      action = 'wait'; cls = 'neutral'; color = '#facc15';
      headline = '⏸ Pas de signal clair — Attendre';
    }
    return { score, action, headline, cls, color };
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
    try {
      if (asset.kind === 'crypto') {
        const url = 'https://api.coingecko.com/api/v3/coins/' + asset.id + '/market_chart?vs_currency=usd&days=90&interval=daily';
        const r = await fetch(url);
        if (!r.ok) throw new Error('CG ' + r.status);
        const j = await r.json();
        return (j.prices || []).map(p => p[1]);
      } else {
        const u = 'https://query1.finance.yahoo.com/v8/finance/chart/' + asset.id + '?interval=1d&range=3mo';
        const proxied = 'https://corsproxy.io/?' + encodeURIComponent(u);
        const r = await fetch(proxied);
        if (!r.ok) throw new Error('YF ' + r.status);
        const j = await r.json();
        const res = j && j.chart && j.chart.result && j.chart.result[0];
        if (!res) throw new Error('Bad payload');
        const closes = (res.indicators && res.indicators.quote && res.indicators.quote[0].close) || [];
        return closes.filter(v => v != null);
      }
    } catch (e) {
      console.warn('fetchPrices failed', e);
      return null;
    }
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
    // Pages où on ne veut PAS le FAB
    const path = location.pathname.split('/').pop();
    if (/^(privacy|404)\.html$/i.test(path)) return;
    const fab = document.createElement('button');
    fab.id = 'tga-fab';
    fab.className = 'tga-fab';
    fab.setAttribute('aria-label', 'Analyste IA');
    fab.innerHTML = '<span aria-hidden="true">🤖</span>';
    fab.onclick = onFABClick;
    document.body.appendChild(fab);
    const lbl = document.createElement('div');
    lbl.className = 'tga-fab-label';
    lbl.textContent = '🔍 Analyser';
    document.body.appendChild(lbl);
    // Détecte si on a une bottom-nav
    if (!document.querySelector('.bottom-nav, #bottom-nav')) {
      document.body.classList.add('tga-no-bottomnav');
    }
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
      + grp('action', '🏢 Actions');
  }

  async function tgaAnalyze(id) {
    const asset = CATALOG.find(a => a.id === id);
    if (!asset) return;
    openOverlay(loadingHTML('Récupération des données ' + asset.label + '…'));
    const prices = await fetchPrices(asset);
    if (!prices || prices.length < 30) {
      openOverlay(''
        + '<div class="tga-head"><span class="tga-tag">🤖 Analyste IA</span>'
        + '<button class="tga-close" onclick="tgaCloseOverlay()" aria-label="Fermer">✕</button></div>'
        + '<p style="padding: 24px 8px; text-align: center;">❌ Impossible de récupérer les données ' + esc(asset.label) + '. Vérifie ta connexion ou réessaie dans quelques instants.</p>');
      return;
    }
    const ind = computeIndicators(prices);
    const patterns = detectPatterns(prices);
    const verdict = tranchantVerdict(ind, patterns);
    const reco = recommendation(verdict, ind, patterns);
    openOverlay(renderAnalysis(asset, ind, patterns, verdict, reco));
  }
  window.tgaAnalyze = tgaAnalyze;

  function renderAnalysis(asset, ind, patterns, verdict, reco) {
    // Plan d'action si direction tranchée
    let planHTML = '';
    if (verdict.action === 'long' || verdict.action === 'long_soft') {
      const atr = ind.atr ? (ind.atr / 100) * ind.last : ind.last * 0.02;
      const entry = ind.last;
      const stop = entry - 1.5 * atr;
      const tp1 = entry + 1.5 * atr;
      const tp2 = entry + 3 * atr;
      const rr = ((tp2 - entry) / (entry - stop)).toFixed(2);
      planHTML = '<div class="tga-section-title">💡 Si tu jouais ce scénario</div>'
        + '<div class="tga-plan">'
        +   '<div class="tga-plan-row"><span>Direction</span><strong>📈 Achat (long)</strong></div>'
        +   '<div class="tga-plan-row"><span>Entrée</span><strong>' + fmtPrice(entry, asset.currency) + '</strong></div>'
        +   '<div class="tga-plan-row"><span>Stop loss</span><strong>' + fmtPrice(stop, asset.currency) + '</strong></div>'
        +   '<div class="tga-plan-row"><span>Cible 1</span><strong>' + fmtPrice(tp1, asset.currency) + '</strong></div>'
        +   '<div class="tga-plan-row"><span>Cible 2</span><strong>' + fmtPrice(tp2, asset.currency) + '</strong></div>'
        +   '<div class="tga-plan-row"><span>Risk / Reward</span><strong>1:' + rr + '</strong></div>'
        + '</div>';
    } else if (verdict.action === 'short' || verdict.action === 'short_soft') {
      const atr = ind.atr ? (ind.atr / 100) * ind.last : ind.last * 0.02;
      const entry = ind.last;
      const stop = entry + 1.5 * atr;
      const tp1 = entry - 1.5 * atr;
      const tp2 = entry - 3 * atr;
      const rr = ((entry - tp2) / (stop - entry)).toFixed(2);
      planHTML = '<div class="tga-section-title">💡 Si tu jouais ce scénario (vente)</div>'
        + '<div class="tga-plan">'
        +   '<div class="tga-plan-row"><span>Direction</span><strong>📉 Vente (short)</strong></div>'
        +   '<div class="tga-plan-row"><span>Entrée</span><strong>' + fmtPrice(entry, asset.currency) + '</strong></div>'
        +   '<div class="tga-plan-row"><span>Stop loss</span><strong>' + fmtPrice(stop, asset.currency) + '</strong></div>'
        +   '<div class="tga-plan-row"><span>Cible 1</span><strong>' + fmtPrice(tp1, asset.currency) + '</strong></div>'
        +   '<div class="tga-plan-row"><span>Cible 2</span><strong>' + fmtPrice(tp2, asset.currency) + '</strong></div>'
        +   '<div class="tga-plan-row"><span>Risk / Reward</span><strong>1:' + rr + '</strong></div>'
        + '</div>';
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
      +   '<div class="tga-verdict-score">Score technique <strong>' + verdict.score + '</strong> / 100</div>'
      + '</div>'
      + '<div class="tga-reco">'
      +   '<div class="tga-reco-title">📋 Ce que je te recommande</div>'
      +   reco.map(t => '<p>' + esc(t) + '</p>').join('')
      + '</div>'
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
