/**
 * tg-bubble.js — v2.75
 *
 * Interface JS ↔ plugin natif Android BubbleOverlay.
 * Détecte l'environnement (Capacitor vs PWA) et fournit l'API unifiée.
 *
 * Inclus sur les pages où on veut le contrôle de la bulle (paramètres / IA).
 *
 * Côté Capacitor : appelle le plugin natif (Kotlin) via window.Capacitor.
 * Côté PWA pure : no-op silencieux (la bulle native n'existe pas).
 */
(function () {
  'use strict';

  const isCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  function getPlugin() {
    if (!isCapacitor) return null;
    const plugins = window.Capacitor.Plugins || {};
    return plugins.BubbleOverlay || null;
  }

  /** Demande la permission SYSTEM_ALERT_WINDOW (renvoie vers settings si nécessaire) */
  async function requestOverlayPermission() {
    const p = getPlugin();
    if (!p) return { granted: false, native: false };
    try {
      const r = await p.requestOverlayPermission();
      return Object.assign({ native: true }, r);
    } catch (e) {
      console.warn('requestOverlayPermission failed', e);
      return { granted: false, native: true, error: e.message };
    }
  }

  async function hasOverlayPermission() {
    const p = getPlugin();
    if (!p) return { granted: false, native: false };
    try {
      const r = await p.hasOverlayPermission();
      return Object.assign({ native: true }, r);
    } catch { return { granted: false, native: true }; }
  }

  /** Lance le service qui affiche la bulle système (par-dessus toutes les apps) */
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
      const r = await p.showBubble();
      return Object.assign({ native: true }, r);
    } catch (e) { return { shown: false, native: true, error: e.message }; }
  }

  async function hideBubble() {
    const p = getPlugin();
    if (!p) return { hidden: false, native: false };
    try {
      const r = await p.hideBubble();
      return Object.assign({ native: true }, r);
    } catch (e) { return { hidden: false, native: true, error: e.message }; }
  }

  /** Déclenche un scan ponctuel (sans avoir la bulle visible) */
  async function triggerScan() {
    const p = getPlugin();
    if (!p) return null;
    try {
      const r = await p.triggerScan();
      return r;
    } catch (e) { console.warn('triggerScan failed', e); return null; }
  }

  /**
   * Écoute les résultats de scan (déclenché par tap sur la bulle ou triggerScan).
   * Callback reçoit { text, ticker, price, ts }
   * Le code JS doit ensuite identifier l'actif et lancer l'analyse de l'agent actif.
   */
  function onScanResult(cb) {
    const p = getPlugin();
    if (!p) return () => {};
    const handle = p.addListener('bubbleScanResult', (event) => {
      try { cb(event); } catch (e) { console.warn(e); }
    });
    return () => { try { handle.remove && handle.remove(); } catch {} };
  }

  /**
   * Helper : à partir d'un ticker OCRisé, identifie l'actif dans le catalogue
   * et lance l'analyse via le FAB Analyste (tg-analyst.js).
   */
  function handleScanResult(scanData) {
    if (!scanData || !scanData.ticker) {
      console.info('[tg-bubble] Ticker non détecté dans le scan');
      return;
    }
    const ticker = scanData.ticker.toUpperCase().replace(/\//g, '');
    // Mapping ticker → asset id (catalog tg-analyst.js)
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
      console.info('[tg-bubble] Ticker', ticker, 'non reconnu dans le catalogue');
      return;
    }
    // Lance l'analyse via le FAB Analyste (tg-analyst.js)
    if (typeof window.tgaAnalyze === 'function') {
      window.tgaAnalyze(assetId);
    } else {
      console.warn('[tg-bubble] tgaAnalyze indisponible');
    }
  }

  window.TGBubble = {
    isNative: isCapacitor,
    requestOverlayPermission,
    hasOverlayPermission,
    showBubble,
    hideBubble,
    triggerScan,
    onScanResult,
    handleScanResult,
  };

  // Auto-wire : si on est natif, brancher onScanResult sur handleScanResult
  if (isCapacitor) {
    onScanResult((data) => {
      console.log('[tg-bubble] Scan reçu :', data);
      handleScanResult(data);
    });
  }
})();
