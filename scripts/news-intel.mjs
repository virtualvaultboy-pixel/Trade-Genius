/**
 * Trade Genius — v9.0 NEWS INTELLIGENCE ENGINE
 *
 * Enrichit le scoring des IA avec 11 signaux additionnels :
 *
 *  Tier 1 (impact max, dev rapide) :
 *   1. M&A detector (rachats, fusions, OPA)
 *   2. Earnings beat/miss tracker (Yahoo quoteSummary)
 *   3. Crypto Fear & Greed Index (alternative.me, gratuit)
 *   4. Insider buying tracker (Yahoo insiderTransactions)
 *   5. Short squeeze potential (Yahoo shortPercentOfFloat)
 *   6. Seasonality (Sell in May, Santa rally, January effect)
 *
 *  Tier 2 (impact moyen) :
 *   7. Tech event calendar (WWDC, GTC, Computex, halving)
 *   8. Analyst momentum (Yahoo recommendationTrend)
 *   9. News thematic keywords enrichis
 *
 *  Tier 3 (impact ciblé) :
 *  10. ETF flows proxy (volume relatif des ETF sectoriels)
 *  11. Geopolitical risk index (composite themes news)
 *
 * Toutes les API utilisées sont GRATUITES (Yahoo, alternative.me).
 * Pas de clé requise.
 */

// ─────────────────────────────────────────────────────────────────────
// 1. M&A DETECTOR — scan news pour rachats/fusions/OPA
// ─────────────────────────────────────────────────────────────────────
const MA_KEYWORDS = [
  'acquires', 'acquisition', 'acquired', 'merger', 'merge with',
  'takeover', 'buyout', 'buy out', 'tender offer', 'to acquire',
  'agrees to buy', 'set to acquire', 'in talks to acquire',
  'rachat', 'rachète', 'fusion', 'opa', 'offre publique',
];
const MA_RUMOR_KEYWORDS = [
  'rumor', 'in talks', 'considering', 'may acquire', 'could acquire',
  'reportedly', 'sources say', 'reported interest',
];

export function detectMAEvents(newsItems, assets) {
  const events = []; // { asset, target, kind: 'confirmed'|'rumor', title, url }
  for (const n of newsItems) {
    const text = (n.title + ' ' + (n.body || '')).toLowerCase();
    const hasMA = MA_KEYWORDS.some(k => text.includes(k));
    if (!hasMA) continue;
    const isRumor = MA_RUMOR_KEYWORDS.some(k => text.includes(k));
    // Trouve les actifs mentionnés dans le titre
    for (const a of assets) {
      const lbl = (a.label || '').toLowerCase();
      if (lbl.length < 3) continue;
      // Match strict : nom complet ou ticker majuscules
      const titleLower = n.title.toLowerCase();
      const sym = a.symbol || a.id || '';
      const matches = titleLower.includes(lbl) || (sym && n.title.includes(sym));
      if (matches) {
        events.push({
          asset: a.label,
          kind: isRumor ? 'rumor' : 'confirmed',
          title: n.title,
          url: n.url,
          source: n.source,
        });
      }
    }
  }
  return events;
}

export function applyMAFilter(setup, maEvents) {
  const ev = maEvents.find(e => e.asset === setup.asset);
  if (!ev) return { keep: true, qualityMult: 1, reason: null };
  if (ev.kind === 'confirmed') {
    // Rachat confirmé : skip (le titre va surger ou stagner au prix de l'offre)
    return { keep: false, qualityMult: 0, reason: `M&A confirmé : ${ev.title.slice(0, 60)}...` };
  } else {
    // Rumeur : prudence, downgrade -20%
    return { keep: true, qualityMult: 0.80, reason: `Rumeur M&A → -20%` };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 2. EARNINGS BEAT/MISS TRACKER — Yahoo quoteSummary
// ─────────────────────────────────────────────────────────────────────
const _earningsResultsCache = new Map();
export async function fetchEarningsResult(symbol) {
  if (_earningsResultsCache.has(symbol)) return _earningsResultsCache.get(symbol);
  try {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=earningsHistory`;
    const r = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (trade-genius-bot)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) { _earningsResultsCache.set(symbol, null); return null; }
    const j = await r.json();
    const history = j?.quoteSummary?.result?.[0]?.earningsHistory?.history;
    if (!Array.isArray(history) || history.length === 0) {
      _earningsResultsCache.set(symbol, null);
      return null;
    }
    // Dernier trimestre publié
    const last = history[history.length - 1];
    const estimate = last?.epsEstimate?.raw;
    const actual = last?.epsActual?.raw;
    if (estimate == null || actual == null) {
      _earningsResultsCache.set(symbol, null);
      return null;
    }
    const surprisePct = ((actual - estimate) / Math.abs(estimate)) * 100;
    // Compte les beats consécutifs
    let consecutiveBeats = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const e = history[i]?.epsEstimate?.raw;
      const a = history[i]?.epsActual?.raw;
      if (a != null && e != null && a >= e) consecutiveBeats++;
      else break;
    }
    const result = { estimate, actual, surprisePct, consecutiveBeats };
    _earningsResultsCache.set(symbol, result);
    return result;
  } catch { _earningsResultsCache.set(symbol, null); return null; }
}

export function applyEarningsBeatFilter(setup, earningsResult) {
  if (!earningsResult) return { qualityMult: 1, reason: null };
  const surprise = earningsResult.surprisePct;
  // Beat fort : boost (l'action a montré sa résilience)
  if (surprise > 10) return { qualityMult: 1.15, reason: `Beat +${surprise.toFixed(1)}% → +15%` };
  if (surprise > 5) return { qualityMult: 1.08, reason: `Beat +${surprise.toFixed(1)}% → +8%` };
  // Miss fort : penalty
  if (surprise < -10) return { qualityMult: 0.80, reason: `Miss ${surprise.toFixed(1)}% → -20%` };
  if (surprise < -5) return { qualityMult: 0.90, reason: `Miss ${surprise.toFixed(1)}% → -10%` };
  // Streak 3+ beats : bonus trend
  if (earningsResult.consecutiveBeats >= 3) {
    return { qualityMult: 1.10, reason: `${earningsResult.consecutiveBeats} beats consécutifs → +10%` };
  }
  return { qualityMult: 1, reason: null };
}

// ─────────────────────────────────────────────────────────────────────
// 3. CRYPTO FEAR & GREED INDEX — alternative.me (gratuit, no key)
// ─────────────────────────────────────────────────────────────────────
let _fearGreedCache = null;
let _fearGreedCacheTs = 0;
export async function fetchFearGreed() {
  // Cache 1h (l'index ne bouge qu'1× par jour)
  if (_fearGreedCache && (Date.now() - _fearGreedCacheTs) < 3600000) return _fearGreedCache;
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=2', {
      headers: { 'user-agent': 'trade-genius-bot/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const today = j?.data?.[0];
    const yesterday = j?.data?.[1];
    if (!today) return null;
    const value = parseInt(today.value, 10);
    const result = {
      value,
      classification: today.value_classification, // Extreme Fear, Fear, Neutral, Greed, Extreme Greed
      change_1d: yesterday ? value - parseInt(yesterday.value, 10) : 0,
    };
    _fearGreedCache = result;
    _fearGreedCacheTs = Date.now();
    return result;
  } catch { return null; }
}

export function applyFearGreedFilter(setup, fg) {
  if (!fg || setup.kind !== 'crypto') return { qualityMult: 1, reason: null };
  // Extreme Fear (<25) : opportunité contrarian — boost les patterns A (contrarian)
  const isContrarianPattern = (setup.type || '').includes('-A') || (setup.label || '').toLowerCase().includes('survente');
  if (fg.value < 25 && isContrarianPattern) {
    return { qualityMult: 1.15, reason: `Fear & Greed ${fg.value} (Extreme Fear) → contrarian +15%` };
  }
  // Extreme Greed (>75) : danger top — penalty -10% sur tous les longs crypto
  if (fg.value > 75) {
    return { qualityMult: 0.90, reason: `Fear & Greed ${fg.value} (Extreme Greed) → -10% top risk` };
  }
  return { qualityMult: 1, reason: null };
}

// ─────────────────────────────────────────────────────────────────────
// 4. INSIDER BUYING TRACKER — Yahoo insiderTransactions
// ─────────────────────────────────────────────────────────────────────
const _insiderCache = new Map();
export async function fetchInsiderActivity(symbol) {
  if (_insiderCache.has(symbol)) return _insiderCache.get(symbol);
  try {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=insiderTransactions`;
    const r = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (trade-genius-bot)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) { _insiderCache.set(symbol, null); return null; }
    const j = await r.json();
    const txs = j?.quoteSummary?.result?.[0]?.insiderTransactions?.transactions;
    if (!Array.isArray(txs) || txs.length === 0) {
      _insiderCache.set(symbol, null);
      return null;
    }
    // Filtre transactions des 90 derniers jours
    const ninetyDaysAgo = Date.now() / 1000 - 90 * 86400;
    const recent = txs.filter(t => (t.startDate?.raw || 0) > ninetyDaysAgo);
    let buyValue = 0, sellValue = 0;
    for (const t of recent) {
      const val = (t.value?.raw || 0);
      const text = (t.transactionText || '').toLowerCase();
      if (text.includes('purchase') || text.includes('buy')) buyValue += val;
      else if (text.includes('sale') || text.includes('sell')) sellValue += val;
    }
    const netRatio = (buyValue + sellValue) > 0 ? buyValue / (buyValue + sellValue) : 0.5;
    const result = { buyValue, sellValue, netRatio, txCount: recent.length };
    _insiderCache.set(symbol, result);
    return result;
  } catch { _insiderCache.set(symbol, null); return null; }
}

export function applyInsiderFilter(setup, insider) {
  if (!insider || insider.txCount < 2) return { qualityMult: 1, reason: null };
  // Net buying (>70% des transactions sont des achats) : signal très fort
  if (insider.netRatio > 0.7 && insider.buyValue > 100000) {
    return { qualityMult: 1.12, reason: `Insider buying $${(insider.buyValue/1e6).toFixed(1)}M → +12%` };
  }
  // Heavy selling (>80% ventes, >$10M) : warning
  if (insider.netRatio < 0.2 && insider.sellValue > 10000000) {
    return { qualityMult: 0.85, reason: `Insider selling $${(insider.sellValue/1e6).toFixed(1)}M → -15%` };
  }
  return { qualityMult: 1, reason: null };
}

// ─────────────────────────────────────────────────────────────────────
// 5. SHORT SQUEEZE POTENTIAL — Yahoo defaultKeyStatistics
// ─────────────────────────────────────────────────────────────────────
const _shortCache = new Map();
export async function fetchShortInterest(symbol) {
  if (_shortCache.has(symbol)) return _shortCache.get(symbol);
  try {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=defaultKeyStatistics`;
    const r = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (trade-genius-bot)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) { _shortCache.set(symbol, null); return null; }
    const j = await r.json();
    const stats = j?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
    if (!stats) { _shortCache.set(symbol, null); return null; }
    const result = {
      shortPercentOfFloat: stats.shortPercentOfFloat?.raw || 0, // 0-1
      shortRatio: stats.shortRatio?.raw || 0, // days to cover
      sharesShort: stats.sharesShort?.raw || 0,
    };
    _shortCache.set(symbol, result);
    return result;
  } catch { _shortCache.set(symbol, null); return null; }
}

export function applyShortSqueezeFilter(setup, short) {
  if (!short || short.shortPercentOfFloat == null) return { qualityMult: 1, reason: null };
  const sip = short.shortPercentOfFloat * 100; // en %
  // Setup LONG + short interest élevé + momentum positif = squeeze potential
  if (setup.direction === 'long' && sip > 20 && (setup.type || '').includes('-B')) {
    // Pattern trend-follow + short squeeze = potentiel x2 du gain
    return { qualityMult: 1.18, reason: `Short interest ${sip.toFixed(0)}% → squeeze potential +18%` };
  }
  if (setup.direction === 'long' && sip > 15) {
    return { qualityMult: 1.08, reason: `Short interest ${sip.toFixed(0)}% → +8%` };
  }
  return { qualityMult: 1, reason: null };
}

// ─────────────────────────────────────────────────────────────────────
// 6. SEASONALITY — biais mensuels classiques
// ─────────────────────────────────────────────────────────────────────
// Statistiques historiques 1950-2024 (S&P 500)
const MONTHLY_SEASONALITY = {
  1:  { bias: +0.5, label: 'January effect (mid-cap rally)' },
  2:  { bias: 0,    label: 'Février neutre' },
  3:  { bias: +0.3, label: 'Mars favorable' },
  4:  { bias: +1.0, label: 'Avril historiquement fort' },
  5:  { bias: -0.5, label: 'Sell in May (saisonnalité négative)' },
  6:  { bias: -0.3, label: 'Juin faible (été)' },
  7:  { bias: +0.4, label: 'Juillet rebond' },
  8:  { bias: -0.5, label: 'Août vol estivale' },
  9:  { bias: -1.0, label: 'Septembre worst month historique' },
  10: { bias: +0.3, label: 'Octobre rebond (post-crash)' },
  11: { bias: +1.2, label: 'Novembre + Santa rally start' },
  12: { bias: +1.0, label: 'Santa rally décembre' },
};

export function getSeasonalityBias() {
  const month = new Date().getUTCMonth() + 1;
  return MONTHLY_SEASONALITY[month] || { bias: 0, label: '' };
}

export function applySeasonalityFilter(setup, season) {
  if (!season || season.bias === 0) return { qualityMult: 1, reason: null };
  // Bias positif : long boost / Bias négatif : long penalty
  if (setup.direction === 'long') {
    if (season.bias > 0.5) return { qualityMult: 1.05, reason: `Saisonnalité +${season.bias.toFixed(1)} → +5%` };
    if (season.bias < -0.5) return { qualityMult: 0.95, reason: `Saisonnalité ${season.bias.toFixed(1)} → -5%` };
  }
  return { qualityMult: 1, reason: null };
}

// ─────────────────────────────────────────────────────────────────────
// 7. TECH EVENT CALENDAR — WWDC, GTC, Computex, halving
// ─────────────────────────────────────────────────────────────────────
const TECH_EVENTS = [
  // Apple WWDC (juin) : impact AAPL/MSFT
  { date: '2026-06-08', name: 'WWDC Apple', impacts: ['Apple', 'Microsoft'], boost: 1.05 },
  // Nvidia GTC (mars) : impact NVDA + semicon
  { date: '2026-03-17', name: 'GTC Nvidia', impacts: ['Nvidia', 'AMD', 'TSMC', 'Broadcom'], boost: 1.08 },
  // Computex Taipei (juin) : impact semicon
  { date: '2026-06-02', name: 'Computex', impacts: ['AMD', 'Nvidia', 'TSMC'], boost: 1.05 },
  // BTC halving (2028) : impact crypto
  { date: '2028-04-15', name: 'BTC Halving', impacts: ['BTC', 'ETH'], boost: 1.10 },
  // Ethereum Pectra upgrade (estimé fin 2025 / début 2026)
  { date: '2026-02-15', name: 'Ethereum Pectra', impacts: ['ETH'], boost: 1.06 },
  // CES Las Vegas (janvier)
  { date: '2026-01-06', name: 'CES Las Vegas', impacts: ['Nvidia', 'AMD', 'Tesla', 'Sony'], boost: 1.03 },
];

export function getTechEventsInDays(maxDays = 10) {
  const now = Date.now();
  return TECH_EVENTS.filter(e => {
    const d = new Date(e.date).getTime();
    const days = (d - now) / 86400000;
    return days >= 0 && days <= maxDays;
  });
}

export function applyTechEventFilter(setup, techEvents) {
  if (!techEvents || techEvents.length === 0) return { qualityMult: 1, reason: null };
  for (const ev of techEvents) {
    if (ev.impacts.includes(setup.asset) && setup.direction === 'long') {
      return { qualityMult: ev.boost, reason: `${ev.name} <10j → +${((ev.boost - 1) * 100).toFixed(0)}%` };
    }
  }
  return { qualityMult: 1, reason: null };
}

// ─────────────────────────────────────────────────────────────────────
// 8. ANALYST MOMENTUM — Yahoo recommendationTrend
// ─────────────────────────────────────────────────────────────────────
const _analystCache = new Map();
export async function fetchAnalystTrend(symbol) {
  if (_analystCache.has(symbol)) return _analystCache.get(symbol);
  try {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=recommendationTrend`;
    const r = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (trade-genius-bot)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) { _analystCache.set(symbol, null); return null; }
    const j = await r.json();
    const trend = j?.quoteSummary?.result?.[0]?.recommendationTrend?.trend;
    if (!Array.isArray(trend) || trend.length === 0) {
      _analystCache.set(symbol, null);
      return null;
    }
    // trend[0] = mois actuel, trend[1] = -1 mois, etc.
    const current = trend[0];
    const previous = trend[1] || current;
    const buyDelta = (current.strongBuy + current.buy) - (previous.strongBuy + previous.buy);
    const sellDelta = (current.strongSell + current.sell) - (previous.strongSell + previous.sell);
    const result = {
      currentBuys: current.strongBuy + current.buy,
      currentSells: current.strongSell + current.sell,
      buyMomentum: buyDelta - sellDelta, // positif = analysts upgrade
    };
    _analystCache.set(symbol, result);
    return result;
  } catch { _analystCache.set(symbol, null); return null; }
}

export function applyAnalystFilter(setup, analyst) {
  if (!analyst) return { qualityMult: 1, reason: null };
  if (setup.direction !== 'long') return { qualityMult: 1, reason: null };
  // Buy momentum >3 = vrai trend analyst upgrade
  if (analyst.buyMomentum > 3) {
    return { qualityMult: 1.08, reason: `Analystes upgrade +${analyst.buyMomentum} → +8%` };
  }
  if (analyst.buyMomentum < -3) {
    return { qualityMult: 0.92, reason: `Analystes downgrade ${analyst.buyMomentum} → -8%` };
  }
  return { qualityMult: 1, reason: null };
}

// ─────────────────────────────────────────────────────────────────────
// 9. NEWS THEMATIC KEYWORDS ENRICHIS — détection thèmes ciblés
// ─────────────────────────────────────────────────────────────────────
export const ENRICHED_THEME_KEYWORDS = {
  // Tech AI specific
  ai_breakthrough: ['breakthrough', 'gpt-5', 'agi', 'llm', 'blackwell', 'hopper', 'tpu'],
  semicon_supply: ['supply chain', 'wafer', 'foundry', 'capacity', 'shortage'],
  ev_battery: ['ev', 'electric vehicle', 'battery', 'solid-state', 'lithium'],
  biotech_fda: ['fda approval', 'phase 3', 'phase iii', 'clinical trial', 'breakthrough therapy'],
  // Crypto specific
  crypto_etf: ['spot etf', 'btc etf', 'eth etf', 'sec approval', 'blackrock'],
  crypto_hack: ['hack', 'exploit', 'drained', 'stolen', 'compromised'],
  defi_growth: ['tvl', 'defi', 'staking', 'yield farming'],
  // Macro extremes
  recession: ['recession', 'gdp contraction', 'jobless', 'unemployment rise'],
  rate_pivot: ['pivot', 'pause', 'end of hikes', 'first cut', 'last hike'],
};

export function detectEnrichedThemes(newsItems) {
  const themes = {};
  for (const n of newsItems) {
    const text = (n.title + ' ' + (n.body || '')).toLowerCase();
    for (const [theme, kws] of Object.entries(ENRICHED_THEME_KEYWORDS)) {
      const matches = kws.filter(k => text.includes(k)).length;
      if (matches > 0) themes[theme] = (themes[theme] || 0) + matches;
    }
  }
  return themes;
}

export function applyEnrichedThemeFilter(setup, enrichedThemes) {
  let mult = 1, reasons = [];
  // Crypto hack actif → skip toutes les cryptos (contagion sentiment)
  if (enrichedThemes.crypto_hack > 2 && setup.kind === 'crypto') {
    return { keep: false, qualityMult: 0, reason: 'Hack crypto majeur dans news → skip' };
  }
  // Recession theme dominant + setup long → penalty
  if (enrichedThemes.recession > 5 && setup.direction === 'long') {
    mult *= 0.92; reasons.push('Récession dans news → -8%');
  }
  // Rate pivot detected + long → boost
  if (enrichedThemes.rate_pivot > 2 && setup.direction === 'long') {
    mult *= 1.10; reasons.push('Fed pivot signal → +10%');
  }
  // AI breakthrough + tech action long → boost
  const isTechAsset = ['Nvidia', 'AMD', 'Microsoft', 'Alphabet', 'Meta', 'Apple', 'TSMC', 'Broadcom'].includes(setup.asset);
  if (enrichedThemes.ai_breakthrough > 1 && isTechAsset && setup.direction === 'long') {
    mult *= 1.08; reasons.push('AI breakthrough news → +8%');
  }
  // FDA approval + biotech long → boost (rare mais énorme)
  if (enrichedThemes.biotech_fda > 1 && setup.direction === 'long') {
    const isBiotech = ['Moderna', 'Pfizer', 'Vertex', 'Regeneron', 'Gilead'].includes(setup.asset);
    if (isBiotech) { mult *= 1.15; reasons.push('FDA approval news → +15%'); }
  }
  if (mult === 1) return { keep: true, qualityMult: 1, reason: null };
  return { keep: true, qualityMult: mult, reason: reasons.join(' · ') };
}

// ─────────────────────────────────────────────────────────────────────
// 10. ETF FLOWS PROXY — volume relatif des ETF sectoriels
// ─────────────────────────────────────────────────────────────────────
// Calcule volume J vs moyenne 20j. ETF avec volume anormal = inflows institutionnels.
export function computeEtfFlowSignal(assets) {
  const signals = {};
  const ETF_SECTORS = ['XLK Tech', 'XLF Fin', 'XLE Energy', 'XLV Health', 'XLP Conso', 'SPY ETF', 'QQQ ETF'];
  for (const lbl of ETF_SECTORS) {
    const etf = assets.find(a => a.label === lbl);
    if (!etf || !etf.volumes || etf.volumes.length < 20) continue;
    const recent20 = etf.volumes.slice(-20);
    const avg20 = recent20.reduce((a, b) => a + b, 0) / 20;
    const today = etf.volumes[etf.volumes.length - 1];
    const ratio = today / avg20;
    if (ratio > 1.5) signals[lbl] = { ratio, kind: 'inflow' };
    else if (ratio < 0.5) signals[lbl] = { ratio, kind: 'outflow' };
  }
  return signals;
}

// ─────────────────────────────────────────────────────────────────────
// 11. GEOPOLITICAL RISK INDEX — composite themes news
// ─────────────────────────────────────────────────────────────────────
export function computeGeoRiskIndex(newsThemesMap) {
  const war = newsThemesMap.war || 0;
  const credit = newsThemesMap.credit || 0;
  const geopol = newsThemesMap.geopolitical || 0;
  // Pondération empirique
  const raw = war * 1.5 + credit * 1.2 + geopol * 1.0;
  // Normalisation 0-100 (cap arbitraire)
  const index = Math.min(100, Math.round(raw * 2));
  const level = index < 25 ? 'low' : (index < 50 ? 'moderate' : (index < 75 ? 'elevated' : 'extreme'));
  return { index, level, war, credit, geopol };
}

export function applyGeoRiskFilter(setup, geoRisk) {
  if (!geoRisk) return { qualityMult: 1, reason: null };
  if (geoRisk.level === 'extreme' && setup.direction === 'long') {
    return { qualityMult: 0.85, reason: `Géopolitique extrême (${geoRisk.index}/100) → -15%` };
  }
  if (geoRisk.level === 'elevated' && setup.direction === 'long') {
    return { qualityMult: 0.95, reason: `Géopolitique élevée → -5%` };
  }
  // Boost defensive si géopolitique extrême
  const isDefensive = ['Gold', 'GLD', 'TLT', 'XLU Util', 'XLP Conso'].includes(setup.asset);
  if (geoRisk.level === 'extreme' && isDefensive && setup.direction === 'long') {
    return { qualityMult: 1.10, reason: 'Géopolitique extrême + defensive → +10%' };
  }
  return { qualityMult: 1, reason: null };
}
