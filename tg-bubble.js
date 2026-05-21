/**
 * tg-bubble.js — v2.79
 *
 * Interface JS ↔ plugin natif Android TGBubble (forké du pattern BJ Genius).
 * Détecte l'environnement (Capacitor vs PWA) et fournit une API unifiée.
 *
 * Inclus sur les pages où on veut le contrôle de la bulle (vue IA).
 *
 * Côté Capacitor APK : appelle le plugin natif Java/Kotlin via window.Capacitor.Plugins.TGBubble
 * Côté PWA pure : no-op silencieux (la bulle native n'existe pas).
 *
 * API publique exposée sur window.TGBubble :
 *   - isNative : boolean
 *   - showBubble() / hideBubble()
 *   - hasOverlayPermission() / requestOverlayPermission()
 *   - setDecision({text, color})
 *   - onScanResult(cb) → unsubscribe fn (cb reçoit {type, ticker?, ...})
 *   - getDiagnostic() → objet de debug
 */
(function () {
  'use strict';

  const ua = (navigator.userAgent || '').toLowerCase();
  const isAndroid = /android/.test(ua);
  const hasCapacitor = !!window.Capacitor;
  const capacitorIsNative = !!(hasCapacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const platform = hasCapacitor && window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : 'web';
  const isCapacitor = capacitorIsNative;

  function getPlugin() {
    if (!hasCapacitor) return null;
    const plugins = window.Capacitor.Plugins || {};
    // Nouveau plugin TGBubble (v2.79+). Fallback BubbleOverlay pour compat ascendante.
    return plugins.TGBubble || plugins.BubbleOverlay || null;
  }

  function getDiagnostic() {
    const p = getPlugin();
    return {
      isAndroid,
      hasCapacitor,
      capacitorIsNative,
      platform,
      hasBubblePlugin: !!p,
      pluginName: p ? (window.Capacitor.Plugins.TGBubble ? 'TGBubble' : 'BubbleOverlay') : null,
      reason: !hasCapacitor ? 'Capacitor non chargé (mode navigateur web pur)'
        : !capacitorIsNative ? 'Capacitor en mode web (pas natif)'
        : !p ? 'Plugin TGBubble non enregistré (problème de build Android)'
        : 'OK',
    };
  }

  async function requestOverlayPermission() {
    const p = getPlugin();
    if (!p) return { granted: false, native: false };
    try {
      const r = await p.requestOverlayPermission();
      return Object.assign({ native: true }, r);
    } catch (e) {
      console.warn('[tg-bubble] requestOverlayPermission failed', e);
      return { granted: false, native: true, error: e.message };
    }
  }

  async function hasOverlayPermission() {
    const p = getPlugin();
    if (!p) return { granted: false, native: false };
    try {
      // TGBubble expose hasOverlayPermission ET checkOverlayPermission
      const fn = p.hasOverlayPermission || p.checkOverlayPermission;
      const r = await fn.call(p);
      return Object.assign({ native: true }, r);
    } catch { return { granted: false, native: true }; }
  }

  async function showBubble() {
    const p = getPlugin();
    if (!p) {
      console.info('[tg-bubble] PWA mode — bulle native indisponible');
      return { shown: false, native: false };
    }
    const has = await hasOverlayPermission();
    if (!has.granted) {
      const req = await requestOverlayPermission();
      if (!req.granted) return { shown: false, native: true, needsPermission: true };
    }
    try {
      // TGBubble expose start() (BJ pattern). showBubble en fallback.
      const fn = p.start || p.showBubble;
      const r = await fn.call(p);
      return Object.assign({ shown: true, native: true }, r);
    } catch (e) { return { shown: false, native: true, error: e.message }; }
  }

  async function hideBubble() {
    const p = getPlugin();
    if (!p) return { hidden: false, native: false };
    try {
      const fn = p.stop || p.hideBubble;
      const r = await fn.call(p);
      return Object.assign({ hidden: true, native: true }, r);
    } catch (e) { return { hidden: false, native: true, error: e.message }; }
  }

  async function setDecision(text, color) {
    const p = getPlugin();
    if (!p || !p.setDecision) return null;
    try {
      return await p.setDecision({ text: String(text || ''), color: color || '#22c55e' });
    } catch (e) { console.warn('[tg-bubble] setDecision failed', e); return null; }
  }

  async function triggerScan() {
    const p = getPlugin();
    if (!p) return null;
    try {
      if (p.triggerScan) return await p.triggerScan();
      // Fallback : on simule via emit local
      return null;
    } catch (e) { console.warn('[tg-bubble] triggerScan failed', e); return null; }
  }

  /**
   * Écoute les events de la bulle (tap scan, tap bulle, tap close).
   * Callback reçoit { type: 'scan_tap' | 'bubble_tap' | 'close_tap', ... }
   */
  function onScanResult(cb) {
    const p = getPlugin();
    if (!p) return () => {};
    // TGBubble emit 'bubbleEvent'. Compat ancien: 'bubbleScanResult'.
    const eventName = (p === window.Capacitor.Plugins.TGBubble) ? 'bubbleEvent' : 'bubbleScanResult';
    const handle = p.addListener(eventName, (event) => {
      try { cb(event); } catch (e) { console.warn('[tg-bubble] onScanResult cb failed', e); }
    });
    return () => { try { handle.remove && handle.remove(); } catch {} };
  }

  /**
   * Helper : à partir d'un ticker OCRisé (ou tap scan), identifie l'actif et
   * lance l'analyse via le FAB Analyste (tg-analyst.js).
   *
   * Pour l'instant (v2.79) le scan déclenche juste l'analyse de l'actif
   * courant sans OCR. L'OCR ML Kit viendra dans une version ultérieure.
   */
  function handleScanResult(scanData) {
    if (!scanData) return;
    // Cas 1 : event natif {type: 'scan_tap'} → on lance l'analyse du dernier actif vu
    if (scanData.type === 'scan_tap') {
      const lastAsset = localStorage.getItem('tg_last_analyzed_asset') || 'bitcoin';
      if (typeof window.tgaAnalyze === 'function') {
        window.tgaAnalyze(lastAsset);
      } else {
        console.warn('[tg-bubble] tgaAnalyze indisponible');
      }
      return;
    }
    // Cas 2 : OCR ticker (à venir)
    if (!scanData.ticker) {
      console.info('[tg-bubble] Pas de ticker dans le scan', scanData);
      return;
    }
    const ticker = scanData.ticker.toUpperCase().replace(/\//g, '');
    const map = {
      'BTC': 'bitcoin', 'BTCUSDT': 'bitcoin', 'BTCUSD': 'bitcoin',
      'ETH': 'ethereum', 'ETHUSDT': 'ethereum', 'ETHUSD': 'ethereum',
      'SOL': 'solana', 'SOLUSDT': 'solana',
      'BNB': 'binancecoin', 'BNBUSDT': 'binancecoin',
      'XRP': 'ripple', 'XRPUSDT': 'ripple',
      'ADA': 'cardano', 'DOGE': 'dogecoin',
      'AVAX': 'avalanche-2', 'DOT': 'polkadot', 'LINK': 'chainlink',
      'AAPL': 'AAPL', 'MSFT': 'MSFT', 'GOOGL': 'GOOGL', 'TSLA': 'TSLA',
      'AMZN': 'AMZN', 'META': 'META', 'NVDA': 'NVDA',
      'SPX': '^GSPC', 'NDX': '^IXIC', 'CAC': '^FCHI',
      'EURUSD': 'EURUSD=X', 'GBPUSD': 'GBPUSD=X', 'USDJPY': 'USDJPY=X',
      'XAU': 'GC=F', 'XAG': 'SI=F',
    };
    const assetId = map[ticker];
    if (!assetId) {
      console.info('[tg-bubble] Ticker', ticker, 'non reconnu');
      return;
    }
    if (typeof window.tgaAnalyze === 'function') {
      window.tgaAnalyze(assetId);
    } else {
      console.warn('[tg-bubble] tgaAnalyze indisponible');
    }
  }

  window.TGBubble = {
    isNative: isCapacitor,
    getDiagnostic,
    requestOverlayPermission,
    hasOverlayPermission,
    showBubble,
    hideBubble,
    setDecision,
    triggerScan,
    onScanResult,
    handleScanResult,
  };

  // Auto-wire : si on est natif, brancher onScanResult sur handleScanResult
  if (isCapacitor) {
    onScanResult((data) => {
      console.log('[tg-bubble] Event reçu :', data);
      handleScanResult(data);
    });
  }
})();
