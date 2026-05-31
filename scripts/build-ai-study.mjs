#!/usr/bin/env node
/**
 * Trade Genius — Génère data/ai-study.json
 * Études techniques générées par IA (Pollinations.ai gratuit, fallback Groq si secret).
 *
 * Tourne quotidiennement via .github/workflows/ai-study.yml.
 * Aucune clé API requise par défaut (Pollinations est gratuit et libre).
 * Si GROQ_API_KEY est défini en GitHub Secret, on utilise Groq (Llama 3.3 70B)
 * pour une meilleure qualité.
 *
 * Output : data/ai-study.json — analyse multi-actifs structurée avec
 * disclaimer fort. Ce n'est PAS un conseil en investissement personnalisé,
 * c'est de la pédagogie technique générée automatiquement.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  fetchYahooHistorical, fetchCoinGeckoHistorical, fetchEarningsDate,
  computeAllIndicators, globalVerdict, atrPct, sma,
  ma7, ichimokuDirection,
} from './indicators.mjs';
// v8.8 — Wisdom Engine : 15 events historiques + matcher + news themes
import {
  findHistoricalAnalogs, computeWisdomAdjustment,
  classifyNewsThemes, getDominantThemes,
} from './wisdom-base.mjs';
// v9.0 — News Intelligence : 11 signaux additionnels
import {
  detectMAEvents, applyMAFilter,
  fetchEarningsResult, applyEarningsBeatFilter,
  fetchFearGreed, applyFearGreedFilter,
  fetchInsiderActivity, applyInsiderFilter,
  fetchShortInterest, applyShortSqueezeFilter,
  getSeasonalityBias, applySeasonalityFilter,
  getTechEventsInDays, applyTechEventFilter,
  fetchAnalystTrend, applyAnalystFilter,
  detectEnrichedThemes, applyEnrichedThemeFilter,
  computeEtfFlowSignal,
  computeGeoRiskIndex, applyGeoRiskFilter,
} from './news-intel.mjs';

// ─────────────────────────────────────────────────────────────────────
// v2.86 — Croisement IA × news en direct (phase D de la roadmap)
//
// Charge data/news.json (généré par fetch-news.mjs avec fenêtre 48h) et
// pour chaque setup produit par les agents, vérifie si l'actif a des news
// récentes qui le mentionnent. Si oui, attache un news_context qui sera
// affiché dans l'UI pour avertir l'user d'un possible comportement
// anormal lié à l'actualité (earnings, M&A, geopolitical, etc.).
// ─────────────────────────────────────────────────────────────────────

async function loadNewsWindow() {
  try {
    const newsPath = path.join(process.cwd(), 'data', 'news.json');
    const txt = await fs.readFile(newsPath, 'utf8');
    const j = JSON.parse(txt);
    return Array.isArray(j?.news) ? j.news : [];
  } catch { return []; }
}

// v4.2 — MACRO CONTEXT FETCHER : VIX (peur du marché) + DXY (dollar fort/faible)
// Ces deux indices conditionnent le comportement des actifs risqués.
//   VIX > 30 = marché stressé, downgrade les setups (sauf contrarian profond)
//   DXY bull = dollar fort, pénalise les commodities (or, argent, cuivre)
//   DXY bear = dollar faible, booste les commodities
// v4.6 — EARNINGS AVOIDANCE
// Pour chaque action, on récupère la date prévue des prochains résultats
// trimestriels. Le filtre : skip si <7j (gros risque de gap) et downgrade
// si <14j. Cache mémoire pour éviter les requêtes répétées.
const _earningsCache = new Map();
async function getEarningsDays(symbol) {
  if (_earningsCache.has(symbol)) return _earningsCache.get(symbol);
  const date = await fetchEarningsDate(symbol);
  if (!date) { _earningsCache.set(symbol, null); return null; }
  const days = Math.floor((date.getTime() - Date.now()) / (24 * 3600 * 1000));
  _earningsCache.set(symbol, days);
  return days;
}

/**
 * Applique le filtre earnings : refuse si <7j, downgrade si <14j.
 * Renvoie {keep, qualityMult, reason}. Ne filtre que les actions
 * (les indices et forex ne sont pas concernés).
 */
async function applyEarningsFilter(setup, asset) {
  if (!setup || asset.kind !== 'action') return { keep: true, qualityMult: 1, reason: null };
  if (!asset.symbol) return { keep: true, qualityMult: 1, reason: null };
  const days = await getEarningsDays(asset.symbol);
  if (days == null) return { keep: true, qualityMult: 1, reason: null }; // donnée indisponible
  if (days < 0) return { keep: true, qualityMult: 1, reason: null }; // earnings passés
  if (days <= 7) {
    return { keep: false, qualityMult: 0, reason: `Earnings dans ${days}j (risque gap > opportunité)` };
  }
  if (days <= 14) {
    return { keep: true, qualityMult: 0.85, reason: `Earnings dans ${days}j → quality -15%` };
  }
  return { keep: true, qualityMult: 1, reason: null };
}

// v4.9 — CROSS-ASSET CORRELATIONS
// Si le S&P 500 a fait -2% sur le jour, on cap toutes les positions sur
// actions US (risque-off généralisé). Si Nasdaq -2.5%, idem mais plus
// strict sur les tech. Si VIX spike >+15% en 1 jour, signal de stress.
function computeCrossAssetSignal(assets) {
  const find = (lbl) => assets.find(a => a.label === lbl);
  const sp500 = find('S&P 500');
  const nasdaq = find('Nasdaq');
  const btc = find('BTC');
  const signal = {
    sp500_change: null,
    nasdaq_change: null,
    btc_change: null,      // v7.14
    risk_off: false,
    tech_risk_off: false,
    crypto_dump: false,    // v7.14 — BTC dump → contagion alts
    reason: null,
  };
  if (sp500?.prices?.length >= 2) {
    const last = sp500.prices[sp500.prices.length - 1];
    const prev = sp500.prices[sp500.prices.length - 2];
    signal.sp500_change = ((last - prev) / prev) * 100;
    if (signal.sp500_change < -2) signal.risk_off = true;
  }
  if (nasdaq?.prices?.length >= 2) {
    const last = nasdaq.prices[nasdaq.prices.length - 1];
    const prev = nasdaq.prices[nasdaq.prices.length - 2];
    signal.nasdaq_change = ((last - prev) / prev) * 100;
    if (signal.nasdaq_change < -2.5) signal.tech_risk_off = true;
  }
  // v7.14 — BTC dump filter pour VOLT (et NEXUS) : si BTC -5%/j → contagion crypto
  if (btc?.prices?.length >= 2) {
    const last = btc.prices[btc.prices.length - 1];
    const prev = btc.prices[btc.prices.length - 2];
    signal.btc_change = ((last - prev) / prev) * 100;
    if (signal.btc_change <= -5) signal.crypto_dump = true;
  }
  if (signal.risk_off) signal.reason = `S&P -${(-signal.sp500_change).toFixed(2)}% → risk-off`;
  else if (signal.tech_risk_off) signal.reason = `Nasdaq -${(-signal.nasdaq_change).toFixed(2)}% → tech risk-off`;
  if (signal.crypto_dump) signal.reason = (signal.reason ? signal.reason + ' · ' : '') + `BTC ${signal.btc_change.toFixed(2)}% → crypto dump`;
  return signal;
}

// Tech actions US qui suivent généralement le Nasdaq (high beta)
const TECH_US_ACTIONS = new Set(['Apple', 'Microsoft', 'Alphabet', 'Amazon', 'Meta', 'Nvidia', 'Tesla', 'Netflix', 'QQQ ETF', 'XLK Tech']);
// Actions US généralistes
const US_ACTIONS = new Set(['JPMorgan', 'Visa', 'Berkshire', 'Walmart', 'J&J', 'Exxon', 'P&G', 'Coca-Cola', 'Nike', 'Disney', 'SPY ETF', 'IWM ETF', 'XLF Fin', 'XLE Energy']);

function applyCrossAssetFilter(setup, asset, crossSignal) {
  if (!setup || !crossSignal) return { keep: true, qualityMult: 1, reason: null };
  // v7.14 — VOLT crypto dump filter : skip nouvelles cryptos VOLT si BTC -5%/j (contagion)
  const isVoltSetup = (setup.type || '').toLowerCase().includes('volt-');
  if (isVoltSetup && crossSignal.crypto_dump && setup.kind === 'crypto') {
    return { keep: false, qualityMult: 0, reason: `BTC ${crossSignal.btc_change.toFixed(2)}% → VOLT crypto skip (contagion)` };
  }
  if (crossSignal.tech_risk_off && TECH_US_ACTIONS.has(asset.label || setup.asset)) {
    return { keep: false, qualityMult: 0, reason: crossSignal.reason + ' → skip tech long' };
  }
  if (crossSignal.risk_off && (TECH_US_ACTIONS.has(asset.label || setup.asset) || US_ACTIONS.has(asset.label || setup.asset))) {
    return { keep: true, qualityMult: 0.75, reason: crossSignal.reason + ' → quality -25%' };
  }
  return { keep: true, qualityMult: 1, reason: null };
}

// v4.8 — MACRO CALENDAR (FOMC, CPI, NFP) — dates hardcodées 2025-2026
// Ces dates sont publiques et connues longtemps à l'avance via Federal Reserve / BLS.
// Si setup à ouvrir <24h avant un release, downgrade fort (volatilité imprévisible).
const MACRO_EVENTS_2025_2026 = [
  // FOMC meetings 2025-2026 (publiquement annoncés)
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30',
  '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29',
  '2026-09-16', '2026-10-28', '2026-12-09',
  // CPI releases approximatifs (mi-mois US)
  '2025-01-15', '2025-02-12', '2025-03-12', '2025-04-10', '2025-05-13',
  '2025-06-11', '2025-07-15', '2025-08-12', '2025-09-11', '2025-10-15',
  '2025-11-13', '2025-12-10',
  '2026-01-14', '2026-02-11', '2026-03-11', '2026-04-15', '2026-05-13',
  // NFP (premier vendredi du mois US)
  '2025-01-03', '2025-02-07', '2025-03-07', '2025-04-04', '2025-05-02',
  '2025-06-06', '2025-07-03', '2025-08-01', '2025-09-05', '2025-10-03',
  '2025-11-07', '2025-12-05',
];

function getMacroEventInDays(maxDays = 2) {
  const now = Date.now();
  for (const dateStr of MACRO_EVENTS_2025_2026) {
    const d = new Date(dateStr + 'T13:30:00Z').getTime(); // 13:30 UTC = 8:30 ET (heure type release)
    const days = (d - now) / (24 * 3600 * 1000);
    if (days >= -0.5 && days <= maxDays) {
      return { date: dateStr, days_until: Number(days.toFixed(1)) };
    }
  }
  return null;
}

function applyMacroEventFilter(setup) {
  const ev = getMacroEventInDays(2);
  if (!ev) return { keep: true, qualityMult: 1, reason: null };
  if (ev.days_until <= 1) {
    return { keep: true, qualityMult: 0.70, reason: `Macro release dans ${ev.days_until}j (${ev.date}) → quality -30%` };
  }
  return { keep: true, qualityMult: 0.90, reason: `Macro release dans ${ev.days_until}j (${ev.date}) → quality -10%` };
}

// v7.10 — SECTOR MOMENTUM : booste/cap les actions selon la perf 60j de leur ETF
// Si XLK Tech +12% sur 60j → boost les setups Apple/MSFT/NVDA/etc. +5% quality
// Si XLE Energy -10% sur 60j → cap les setups Exxon/Chevron/etc. -10% quality
// Mapping ticker action → ETF sectoriel correspondant
const ACTION_TO_SECTOR_ETF = {
  // Tech (XLK ou SOXX pour les semis)
  'Apple': 'XLK Tech', 'Microsoft': 'XLK Tech', 'Alphabet': 'XLK Tech', 'Amazon': 'XLK Tech',
  'Meta': 'XLK Tech', 'Netflix': 'XLK Tech', 'Adobe': 'XLK Tech', 'Salesforce': 'XLK Tech',
  'Oracle': 'XLK Tech', 'IBM': 'XLK Tech', 'ServiceNow': 'XLK Tech', 'Intuit': 'XLK Tech',
  'CrowdStrike': 'XLK Tech', 'Palo Alto Networks': 'XLK Tech', 'Snowflake': 'XLK Tech',
  'Datadog': 'XLK Tech', 'Cloudflare': 'XLK Tech', 'Atlassian': 'XLK Tech', 'Palantir': 'XLK Tech',
  'Shopify': 'XLK Tech', 'PayPal': 'XLK Tech', 'Block (Square)': 'XLK Tech',
  // Semis (préférence SOXX si dispo)
  'Nvidia': 'SOXX Semiconductors', 'AMD': 'SOXX Semiconductors', 'Intel': 'SOXX Semiconductors',
  'Broadcom': 'SOXX Semiconductors', 'Qualcomm': 'SOXX Semiconductors',
  'Texas Instruments': 'SOXX Semiconductors', 'Applied Materials': 'SOXX Semiconductors',
  'Lam Research': 'SOXX Semiconductors', 'KLA Corp': 'SOXX Semiconductors',
  'Micron': 'SOXX Semiconductors', 'TSMC': 'SOXX Semiconductors', 'ASML (US ADR)': 'SOXX Semiconductors',
  'NXP Semiconductors': 'SOXX Semiconductors', 'Marvell Tech': 'SOXX Semiconductors',
  'Super Micro': 'SOXX Semiconductors', 'ARM Holdings': 'SOXX Semiconductors',
  // Finance (XLF)
  'JPMorgan': 'XLF Finance', 'Bank of America': 'XLF Finance', 'Wells Fargo': 'XLF Finance',
  'Goldman Sachs': 'XLF Finance', 'Morgan Stanley': 'XLF Finance', 'Citigroup': 'XLF Finance',
  'BlackRock': 'XLF Finance', 'Charles Schwab': 'XLF Finance', 'Visa': 'XLF Finance',
  'Mastercard': 'XLF Finance', 'American Express': 'XLF Finance', 'Capital One': 'XLF Finance',
  'PNC Bank': 'XLF Finance', 'US Bancorp': 'XLF Finance', 'Truist': 'XLF Finance',
  'Berkshire': 'XLF Finance', 'Chubb': 'XLF Finance', 'Progressive': 'XLF Finance',
  'AIG': 'XLF Finance', 'MetLife': 'XLF Finance', 'Allstate': 'XLF Finance',
  // Énergie (XLE)
  'Exxon': 'XLE Energy', 'Chevron': 'XLE Energy', 'ConocoPhillips': 'XLE Energy',
  'EOG Resources': 'XLE Energy', 'Occidental': 'XLE Energy', 'Schlumberger': 'XLE Energy',
  'Phillips 66': 'XLE Energy', 'Valero': 'XLE Energy', 'Marathon Petroleum': 'XLE Energy',
  'Kinder Morgan': 'XLE Energy', 'Enbridge': 'XLE Energy', 'BP': 'XLE Energy', 'Shell': 'XLE Energy',
};

function _computeSectorMomentum(valid) {
  // Calcule la perf 60j (en %) de chaque ETF sectoriel présent dans valid
  const sectors = {};
  ['XLK Tech', 'XLF Finance', 'XLE Energy', 'XLV Healthcare', 'XLY Consumer Disc.',
   'XLP Consumer Staples', 'XLI Industrials', 'XLB Materials', 'XLRE Real Estate',
   'XLU Utilities', 'XLC Communication', 'SOXX Semiconductors', 'SMH Semi ETF',
   'KRE Regional Banks', 'KBE Banks', 'ITA Aerospace', 'IBB Biotech'].forEach(label => {
    const etf = valid.find(a => a.label === label);
    if (!etf || !Array.isArray(etf.prices) || etf.prices.length < 61) return;
    const now = etf.prices[etf.prices.length - 1];
    const ago = etf.prices[etf.prices.length - 61];
    if (!now || !ago) return;
    const chg60 = ((now - ago) / ago) * 100;
    sectors[label] = chg60;
  });
  return sectors;
}

function _applySectorMomentumFilter(setup, sectors) {
  if (!setup || !sectors || setup.kind !== 'action') return { qualityMult: 1, reason: null };
  const etfLabel = ACTION_TO_SECTOR_ETF[setup.asset];
  if (!etfLabel) return { qualityMult: 1, reason: null };
  // Fallback : si l'ETF spécifique manque, essayer XLK pour SOXX
  let chg = sectors[etfLabel];
  if (chg == null && etfLabel === 'SOXX Semiconductors') chg = sectors['XLK Tech'];
  if (chg == null) return { qualityMult: 1, reason: null };
  // Règles de pondération
  if (chg >= 10) return { qualityMult: 1.10, reason: 'Secteur ' + etfLabel + ' fort (' + chg.toFixed(1) + '% / 60j) → boost +10%' };
  if (chg >= 5)  return { qualityMult: 1.05, reason: 'Secteur ' + etfLabel + ' positif (' + chg.toFixed(1) + '%) → boost +5%' };
  if (chg <= -10) return { qualityMult: 0.85, reason: 'Secteur ' + etfLabel + ' faible (' + chg.toFixed(1) + '%) → cap -15%' };
  if (chg <= -5)  return { qualityMult: 0.93, reason: 'Secteur ' + etfLabel + ' baissier (' + chg.toFixed(1) + '%) → cap -7%' };
  return { qualityMult: 1, reason: null };
}

// v7.11 — VOLT : 5e IA "haute conviction / haute volatilité"
// Univers restreint aux actifs naturellement volatils où une asymétrie 1:4 est crédible
// Crypto mid-cap (volatilité 4-8% jour) + actions high-beta US (volatilité 3-6% jour)
// v7.19 — Labels alignés EXACTEMENT sur build-ai-study.mjs ASSETS
// (cryptos = labels courts SOL/AVAX/NEAR, actions = noms complets Tesla/Palantir)
// Sinon _isVoltAsset() retourne false et VOLT n'a 0 setup (bug v7.11-v7.18)
const VOLT_UNIVERSE = new Set([
  // Crypto mid-cap (haute volatilité, momentum-driven) — labels ASSETS short
  'SOL', 'AVAX', 'NEAR', 'INJ', 'LDO', 'ARB', 'OP', 'FET', 'ICP',
  'ATOM', 'FIL', 'MATIC', 'APT', 'SUI', 'TIA', 'SEI', 'RNDR', 'AGIX',
  // Actions high-beta US (tech spéculative + EV + nouvelles tech)
  'Tesla', 'Palantir', 'Coinbase', 'MicroStrategy', 'Affirm', 'SoFi',
  'Rivian', 'Carvana', 'ARM Holdings', 'Super Micro', 'AST SpaceMobile', 'IonQ',
  'Rocket Lab', 'Archer Aviation', 'Lucid', 'Plug Power', 'Joby Aviation',
  'Roblox', 'Snap', 'Unity', 'DraftKings', 'Roku', 'Beyond Meat',
]);

function _isVoltAsset(asset) {
  if (!asset || !asset.label) return false;
  return VOLT_UNIVERSE.has(asset.label);
}

// v8.7 — NEXUS : 15 cryptos majeurs (top market cap, liquidité élevée)
// Backtest documenté : PF 2.17 · DD <3.2% sur stacking A/B/C crypto
const NEXUS_UNIVERSE = new Set([
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX',
  'DOT', 'LINK', 'TRX', 'LTC', 'UNI', 'ATOM', 'XLM',
]);
function _isNexusAsset(asset) {
  if (!asset || !asset.label) return false;
  return asset.kind === 'crypto' && NEXUS_UNIVERSE.has(asset.label);
}

// v9.2 — NEXUS : config CRYPTO-FAST validée walk-forward IS/OOS v7.17
// atrStop 0.6 · atrTp2 4.0 · timeout 15j → OOS médian +7.91%/an (DD -2.11%)
function _detectMultiCrypto(asset) {
  if (!_isNexusAsset(asset)) return null;
  const c = _detectGridPullbackTrend(asset, {
    atrStop: 0.6, atrTp2: 4.0,
    type: 'nexus-C', label: 'Crypto pullback dans tendance majeure',
    timeframe: 'Crypto · 5-30 jours',
  });
  const a = _detectGridContrarian(asset, {
    rsiMax: 25, atrStop: 0.6, atrTp2: 4.0, requireMaBull: true,
    type: 'nexus-A', label: 'Crypto survente + rebond confirmé',
    timeframe: 'Crypto · 5-30 jours', expectedPF: '2.17',
  });
  const b = _detectGridTrendFollow(asset, {
    rsiMin: 35, adxMin: 25, atrStop: 0.6, atrTp2: 4.0,
    type: 'nexus-B', label: 'Crypto trend-follow correction',
    timeframe: 'Crypto · 5-30 jours', expectedPF: '2.17',
  });
  return _stackPatterns([c, a, b], null);
}

// v7.13 — Pattern D' : ABC-TRIPLE Multi-Pattern (exclusif à VOLT)
// Backtest 600j : +21.77%/an · PF 2.66 · DD -4.9% · WR 32% · 266 trades
// Walk-forward 5×120j : médian +28.6%/an · worst -0.26% · DD max -3.75%
// Logique : 3 patterns complémentaires sur univers VOLT (capture tous régimes)
//   - Pattern A (contrarian) : RSI<25 + BB<25% + MACD<0 (correction → rebond)
//   - Pattern C (pullback)   : RSI>35 + BB<25% + Ichimoku bull (continuation tendance)
//   - Pattern B (trend-follow): RSI>35 + ADX≥25 + BB mid + MACD<0 (correction dans trend)
// Niveaux communs : stop 0.6×ATR · TP1 2.25×ATR · TP2 4.5×ATR · timeout 15j · trailing après TP1
function _detectVoltMulti(asset) {
  if (!_isVoltAsset(asset)) return null;
  const ind = asset.indRaw;
  const prices = asset.prices;
  if (!ind || !prices || prices.length < 60) return null;
  const regime = detectMarketRegime(prices);
  if (regime === 'bear') return null;  // skip bear séculaire (tous patterns)
  const atrPctV = ind.atr?.value;
  if (atrPctV == null) return null;
  const close = prices[prices.length - 1];
  const atrAbs = asset.atrAbs || (atrPctV * close / 100);

  // Lectures indicateurs
  const rsi = ind.rsi?.value;
  const boll = ind.boll?.value;
  const macdH = ind.macd?.value;
  const adx = ind.adx?.value || 0;
  const obvTrend = ind.obv?.trend;
  const mfi = ind.mfi?.value;
  const ichi = ind.ichimoku;

  // Détection (A prioritaire, puis C, puis B)
  let patternKind = null, patternConfig = '';
  if (rsi != null && rsi < 25 && boll != null && boll < 0.25 && macdH != null && macdH < 0 && (mfi == null || mfi <= 70)) {
    patternKind = 'A-contrarian';
    patternConfig = 'RSI ' + rsi.toFixed(0) + ' (survente) · BB ' + (boll*100).toFixed(0) + '% · MACD ' + macdH.toFixed(2);
  } else if (rsi != null && rsi > 35 && boll != null && boll < 0.25 && ichi && ichi.position === 'above-cloud' && ichi.signal === 'bull' && obvTrend !== 'down') {
    patternKind = 'C-pullback';
    patternConfig = 'RSI ' + rsi.toFixed(0) + ' · BB ' + (boll*100).toFixed(0) + '% · Ichimoku above-cloud bull';
  } else if (rsi != null && rsi > 35 && adx >= 25 && boll != null && boll >= 0.25 && boll <= 0.75 && macdH != null && macdH < 0 && obvTrend !== 'down') {
    patternKind = 'B-trendfollow';
    patternConfig = 'RSI ' + rsi.toFixed(0) + ' · ADX ' + adx.toFixed(0) + ' · BB ' + (boll*100).toFixed(0) + '% (mid) · MACD ' + macdH.toFixed(2);
  }
  if (!patternKind) return null;

  // Niveaux communs validés walk-forward
  const entry = close;
  const stop = entry - 0.6 * atrAbs;
  const tp1 = entry + 2.25 * atrAbs;
  const tp2 = entry + 4.5 * atrAbs;
  if (stop >= entry || tp1 <= entry || tp2 <= tp1) return null;
  const risk = entry - stop;
  const rr2Calc = (tp2 - entry) / risk;
  if (rr2Calc < 2) return null;

  return {
    type: 'volt-D-' + patternKind,
    label: 'Setup VOLT — haute conviction',
    timeframe: 'Haute conviction · 3-15 jours',
    confidence: 'high',
    config: 'Setup haute conviction sur actif volatil · R/R 1:' + rr2Calc.toFixed(1) + '.',
    rationale: '⚡ VOLT — Setup haute conviction sur actif volatil. Méthode validée avec garde-fous anti-risque automatiques (sizing renforcé, exit rapide sur faux signaux).',
    direction: 'long', entry, stop, tp1, tp2,
    rr1: ((tp1 - entry) / risk).toFixed(2),
    rr2: rr2Calc.toFixed(2),
    trailing_after_tp1: true,
    regime,
  };
}

// v10.9 — ALPHA WINNER : config WINNER-1 validée 14 ans walk-forward
// Source : scripts/alpha-top3-deep-validation.mjs (commit ff44201 v10.8)
// Résultats : 40.02%/an médian / DD -4.13% / Calmar 9.68 / 14/14 ans positifs
// Stratégie : réutilise A/B/C avec params ultra-serrés (atrStop 0.5 / atrTp2 7 = R/R 14:1)
// + filtre minQuality 85 appliqué post-detection dans le pipeline agentsOutput
// → ultra-sélectif (estimé 1-2 setups/an/actif vs 5-10 pour BASTION)
function _detectAlphaWinner(asset) {
  const c = _detectGridPullbackTrend(asset, {
    atrStop: 0.5, atrTp2: 7.0,
    type: 'alpha-C', label: 'ALPHA pullback ultra-sélectif',
    timeframe: 'ALPHA · 5-30 jours',
  });
  const a = _detectGridContrarian(asset, {
    rsiMax: 22, atrStop: 0.5, atrTp2: 7.0, requireMaBull: true,
    type: 'alpha-A', label: 'ALPHA survente extrême + tendance',
    timeframe: 'ALPHA · 5-30 jours',
  });
  const b = _detectGridTrendFollow(asset, {
    rsiMin: 38, adxMin: 30, atrStop: 0.5, atrTp2: 7.0,
    type: 'alpha-B', label: 'ALPHA trend-follow correction forte',
    timeframe: 'ALPHA · 5-30 jours',
  });
  return _stackPatterns([c, a, b], null);
}

async function fetchMacroContext() {
  const ctx = { vix: null, vixRegime: 'unknown', dxy: null, dxyTrend: 'unknown' };
  try {
    const vixData = await fetchYahooHistorical('^VIX', '3mo');
    if (vixData?.prices?.length) {
      const last = vixData.prices[vixData.prices.length - 1];
      ctx.vix = Number(last.toFixed(2));
      if (last < 15) ctx.vixRegime = 'calm';
      else if (last < 25) ctx.vixRegime = 'normal';
      else if (last < 35) ctx.vixRegime = 'stressed';
      else if (last < 45) ctx.vixRegime = 'panic';
      else ctx.vixRegime = 'extreme-panic';
    }
  } catch (e) { console.warn('VIX fetch failed:', e.message); }
  try {
    // DX-Y.NYB = US Dollar Index (basket EUR/JPY/GBP/CAD/SEK/CHF)
    const dxyData = await fetchYahooHistorical('DX-Y.NYB', '6mo');
    if (dxyData?.prices?.length >= 100) {
      const last = dxyData.prices[dxyData.prices.length - 1];
      const ago60 = dxyData.prices[dxyData.prices.length - 60];
      const chg60d = (last - ago60) / ago60;
      ctx.dxy = Number(last.toFixed(2));
      if (chg60d > 0.04) ctx.dxyTrend = 'strong-bull';
      else if (chg60d > 0.01) ctx.dxyTrend = 'bull';
      else if (chg60d < -0.04) ctx.dxyTrend = 'strong-bear';
      else if (chg60d < -0.01) ctx.dxyTrend = 'bear';
      else ctx.dxyTrend = 'neutral';
    }
  } catch (e) { console.warn('DXY fetch failed:', e.message); }
  console.log(`v4.2 Macro context: VIX=${ctx.vix} (${ctx.vixRegime}) · DXY=${ctx.dxy} (${ctx.dxyTrend})`);
  return ctx;
}

/**
 * v4.2 — Applique filtres macro à un setup :
 *   - Si VIX panic (>35), refuse les Pattern B/C (trend-follow) qui marchent
 *     mal en panic. Pattern A (contrarian) reste autorisé : un VIX panic
 *     EST une opportunité contrarian.
 *   - Si VIX extreme-panic (>45) : downgrade quality_score de 25%.
 *   - Si VIX stressed (25-35) : downgrade quality_score de 10%.
 *   - Si DXY strong-bull et asset = metal/commodity : downgrade 15%.
 *   - Si DXY strong-bear et asset = metal : booster 10%.
 * Retourne {keep: bool, qualityMult: 0..1.1, reason: string}
 */
function applyMacroFilter(setup, macroCtx) {
  if (!setup || !macroCtx) return { keep: true, qualityMult: 1, reason: null };
  const reasons = [];
  let mult = 1;
  // VIX rules
  if (macroCtx.vixRegime === 'extreme-panic') {
    if (!setup.type || !setup.type.includes('-a')) {
      return { keep: false, qualityMult: 0, reason: 'VIX extrême (panique) — seuls les setups contrarian sont autorisés' };
    }
    mult *= 0.75;
    reasons.push(`VIX panic ${macroCtx.vix}`);
  } else if (macroCtx.vixRegime === 'panic') {
    if (setup.type && (setup.type.includes('-b') || setup.type.includes('-c'))) {
      return { keep: false, qualityMult: 0, reason: 'VIX panic — trend-follow trop risqué' };
    }
    mult *= 0.85;
    reasons.push(`VIX panic ${macroCtx.vix}`);
  } else if (macroCtx.vixRegime === 'stressed') {
    mult *= 0.90;
    reasons.push(`VIX stress ${macroCtx.vix}`);
  }
  // DXY rules : impacte les commodities et certains forex
  if (setup.kind === 'metal') {
    if (macroCtx.dxyTrend === 'strong-bull') {
      mult *= 0.85;
      reasons.push(`DXY strong-bull ${macroCtx.dxy} → headwind`);
    } else if (macroCtx.dxyTrend === 'strong-bear') {
      mult *= 1.10;
      reasons.push(`DXY strong-bear ${macroCtx.dxy} → tailwind métaux`);
    }
  }
  return { keep: true, qualityMult: mult, reason: reasons.length ? reasons.join(' · ') : null };
}

// v4.0 — ML rules loader (optionnel : si data/ml/rules.json existe, on l'utilise
// pour pondérer le quality_score par l'AUC de chaque horizon. Fallback safe si
// le fichier n'existe pas — comportement v3.4 inchangé).
async function loadMlRules() {
  try {
    const p = path.join(process.cwd(), 'data', 'ml', 'rules.json');
    const txt = await fs.readFile(p, 'utf8');
    const j = JSON.parse(txt);
    if (j?.horizons) {
      console.log(`v4.0 ML rules loaded (trained ${j.trained_at}) — DAY auc=${j.horizons.day?.auc?.toFixed?.(3)} WEEK=${j.horizons.week?.auc?.toFixed?.(3)} MONTH=${j.horizons.month?.auc?.toFixed?.(3)}`);
      return j;
    }
  } catch { /* fichier absent : comportement v3.4 préservé */ }
  return null;
}

// v4.0 — Map agent_id → horizon ML clé. kairo=day, nova=week, atlas=month.
const _ML_HORIZON_BY_AGENT = { kairo: 'day', nova: 'week', atlas: 'month' };

/**
 * v4.0 — Pondère un quality_score par l'AUC ML de l'horizon correspondant.
 *   AUC 0.50 (random) → multiplicateur 1.00 (neutre)
 *   AUC 0.60         → multiplicateur 1.05
 *   AUC 0.70         → multiplicateur 1.10
 *   AUC 0.80+        → multiplicateur 1.15 (cap)
 *   AUC < 0.50       → multiplicateur 0.95 (signal anti-edge, downgrade léger)
 * Cappé à [0,100] final.
 */
function _applyMlBoost(score, agentId, mlRules) {
  if (!mlRules || !mlRules.horizons || score == null) return score;
  const horizon = _ML_HORIZON_BY_AGENT[agentId];
  if (!horizon) return score;
  const auc = Number(mlRules.horizons[horizon]?.auc);
  if (!Number.isFinite(auc)) return score;
  const edge = auc - 0.5;            // -0.5..+0.5
  const mult = 1 + Math.max(-0.05, Math.min(0.15, edge * 0.3));
  return Math.max(0, Math.min(100, Math.round(score * mult)));
}

function buildAssetPatterns(assets) {
  const out = {};
  const aliases = {
    'bitcoin': ['btc'], 'ethereum': ['eth'], 'solana': ['sol'],
    'binancecoin': ['bnb', 'binance coin'], 'ripple': ['xrp'],
    'cardano': ['ada'], 'dogecoin': ['doge'], 'avalanche-2': ['avax', 'avalanche'],
    'polkadot': ['dot'], 'chainlink': ['link'], 'tron': ['trx'],
    'litecoin': ['ltc'],
    's&p 500': ['s&p500', 's&p', 'sp500', 'spx'],
    'nasdaq': ['composite', 'qqq'],
    'dow jones': ['dow', 'djia'],
    'cac 40': ['cac40', 'cac'],
    'dax': ['germany 40'],
    'nikkei 225': ['nikkei'],
    'apple': ['aapl'], 'microsoft': ['msft'], 'alphabet': ['googl', 'google'],
    'amazon': ['amzn'], 'meta': ['fb', 'facebook'], 'nvidia': ['nvda'],
    'tesla': ['tsla'], 'netflix': ['nflx'],
  };
  for (const a of assets) {
    const pats = new Set();
    if (a.label) pats.add(a.label.toLowerCase());
    if (a.symbol) {
      const clean = a.symbol.toLowerCase().replace(/[\^=\.][\w-]+$/, '').replace(/[\^=]/g, '');
      if (clean.length >= 3) pats.add(clean);
    }
    if (a.id) pats.add(a.id.toLowerCase());
    const key = (a.label || a.id || '').toLowerCase();
    if (aliases[key]) aliases[key].forEach(p => pats.add(p));
    out[a.label] = [...pats].filter(p => p && p.length >= 3);
  }
  return out;
}

function matchNewsToAssets(news, assets) {
  if (!news || news.length === 0) return {};
  const patterns = buildAssetPatterns(assets);
  const matches = {};
  for (const n of news) {
    const text = ((n.title || '') + ' ' + (n.body || '')).toLowerCase();
    for (const [label, pats] of Object.entries(patterns)) {
      for (const p of pats) {
        const re = new RegExp(`\\b${p.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
        if (re.test(text)) {
          if (!matches[label]) matches[label] = [];
          matches[label].push({ title: n.title, time: n.time, source: n.source, url: n.url });
          break;
        }
      }
    }
  }
  for (const k of Object.keys(matches)) {
    matches[k].sort((a, b) => new Date(b.time) - new Date(a.time));
    if (matches[k].length > 3) matches[k].length = 3;
  }
  return matches;
}

function buildNewsContext(setup, newsMatches) {
  const m = newsMatches[setup.asset];
  if (!m || m.length === 0) return null;
  let risk = 'normal';
  if (m.length >= 2) risk = 'caution';
  if (m.length >= 3) risk = 'alert';
  return {
    count: m.length,
    risk,
    items: m.slice(0, 2).map(n => ({
      title: n.title.length > 120 ? n.title.slice(0, 117) + '…' : n.title,
      time: n.time,
      source: n.source,
    })),
  };
}

// v4.7 — NEWS SENTIMENT NLP (via Pollinations, gratuit)
// Pour chaque setup avec news_context, classifie les news <48h en
// positive/negative/neutral. Si majorité négative → downgrade ou refuse.
// Timeout 8s par appel, fallback silencieux si KO (préserve le pipeline).
const _sentimentCache = new Map();
async function classifyNewsSentiment(titles) {
  if (!Array.isArray(titles) || titles.length === 0) return null;
  const key = titles.join('|').slice(0, 500);
  if (_sentimentCache.has(key)) return _sentimentCache.get(key);
  try {
    const joined = titles.slice(0, 5).map((t, i) => `${i + 1}. ${t}`).join('\n');
    const prompt = `Tu es un analyste financier. Pour chaque titre d'actu ci-dessous, classe l'impact attendu sur le cours de l'actif mentionné : POSITIF / NÉGATIF / NEUTRE.
Réponds UNIQUEMENT avec une ligne par titre au format "N: LABEL" (ex: "1: POSITIF").

Titres :
${joined}`;
    const url = 'https://text.pollinations.ai/' + encodeURIComponent(prompt);
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'trade-genius-bot' } });
    if (!r.ok) { _sentimentCache.set(key, null); return null; }
    const txt = await r.text();
    const labels = [];
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*\d+\s*[:.\-]\s*(POSITIF|NEGATIF|NÉGATIF|NEUTRE)/i);
      if (m) {
        const lbl = m[1].toUpperCase().replace('É', 'E');
        labels.push(lbl === 'POSITIF' ? 'positive' : (lbl === 'NEGATIF' ? 'negative' : 'neutral'));
      }
    }
    if (labels.length === 0) { _sentimentCache.set(key, null); return null; }
    const pos = labels.filter(l => l === 'positive').length;
    const neg = labels.filter(l => l === 'negative').length;
    const out = {
      positive: pos, negative: neg, neutral: labels.length - pos - neg,
      net: pos - neg, total: labels.length,
      verdict: pos - neg >= 2 ? 'positive' : (neg - pos >= 2 ? 'negative' : 'neutral'),
    };
    _sentimentCache.set(key, out);
    return out;
  } catch { _sentimentCache.set(key, null); return null; }
}

/**
 * Applique le filtre sentiment :
 *   - verdict 'negative' net >= 2 → quality -25%, et refuse si quality < 50 après
 *   - verdict 'positive' net >= 2 → quality +10% (cap 100)
 *   - neutre → pas de changement
 */
function applyNewsSentimentFilter(setup, sentiment) {
  if (!sentiment || !setup) return { keep: true, qualityMult: 1, reason: null };
  if (sentiment.verdict === 'negative') {
    const newQuality = Math.round((setup.quality_score || 0) * 0.75);
    if (newQuality < 50) return { keep: false, qualityMult: 0, reason: `News négatives (${sentiment.negative}/${sentiment.total}) → quality < seuil` };
    return { keep: true, qualityMult: 0.75, reason: `News négatives (${sentiment.negative}/${sentiment.total}) → -25%` };
  }
  if (sentiment.verdict === 'positive') {
    return { keep: true, qualityMult: 1.10, reason: `News positives (${sentiment.positive}/${sentiment.total}) → +10%` };
  }
  return { keep: true, qualityMult: 1, reason: null };
}

// v2.60 — Catalogue étendu (52 actifs) : indices monde + actions US/EU
//        + crypto top 20 + forex majors + métaux précieux
const ASSETS = [
  // v6.9 — UNIVERS ÉTENDU : 130+ actifs scannés par les IAs à chaque cycle
  // ── Indices monde (24) ──────────────────────────────────────
  { kind: 'index',  symbol: '^GSPC',     label: 'S&P 500' },
  { kind: 'index',  symbol: '^IXIC',     label: 'Nasdaq' },
  { kind: 'index',  symbol: '^DJI',      label: 'Dow Jones' },
  { kind: 'index',  symbol: '^RUT',      label: 'Russell 2000' },
  { kind: 'index',  symbol: '^FCHI',     label: 'CAC 40' },
  { kind: 'index',  symbol: '^GDAXI',    label: 'DAX' },
  { kind: 'index',  symbol: '^FTSE',     label: 'FTSE 100' },
  { kind: 'index',  symbol: '^STOXX50E', label: 'Euro Stoxx 50' },
  { kind: 'index',  symbol: '^N225',     label: 'Nikkei 225' },
  { kind: 'index',  symbol: '^HSI',      label: 'Hang Seng' },
  { kind: 'index',  symbol: '^IBEX',     label: 'IBEX 35' },
  { kind: 'index',  symbol: '^AEX',      label: 'AEX Amsterdam' },
  { kind: 'index',  symbol: '^SSMI',     label: 'SMI Swiss' },
  { kind: 'index',  symbol: '^OMX',      label: 'OMX Stockholm' },
  { kind: 'index',  symbol: '^BSESN',    label: 'Sensex India' },
  { kind: 'index',  symbol: '^KS11',     label: 'KOSPI Corée' },
  { kind: 'index',  symbol: '^AXJO',     label: 'ASX 200 Australie' },
  { kind: 'index',  symbol: '^BVSP',     label: 'Bovespa Brésil' },
  { kind: 'index',  symbol: '^TWII',     label: 'Taiwan' },
  { kind: 'index',  symbol: '^MXX',      label: 'Mexico IPC' },
  { kind: 'index',  symbol: '000001.SS', label: 'Shanghai' },
  { kind: 'index',  symbol: '^STI',      label: 'Singapore STI' },
  { kind: 'index',  symbol: '^NSEI',     label: 'Nifty 50 India' },
  { kind: 'index',  symbol: '^JN0U.JO',  label: 'JSE Top 40 Afrique du Sud' },

  // ── Crypto majeurs (28, CoinGecko) ──────────────────────────
  { kind: 'crypto', id: 'bitcoin',         label: 'BTC' },
  { kind: 'crypto', id: 'ethereum',        label: 'ETH' },
  { kind: 'crypto', id: 'solana',          label: 'SOL' },
  { kind: 'crypto', id: 'binancecoin',     label: 'BNB' },
  { kind: 'crypto', id: 'ripple',          label: 'XRP' },
  { kind: 'crypto', id: 'cardano',         label: 'ADA' },
  { kind: 'crypto', id: 'dogecoin',        label: 'DOGE' },
  { kind: 'crypto', id: 'avalanche-2',     label: 'AVAX' },
  { kind: 'crypto', id: 'polkadot',        label: 'DOT' },
  { kind: 'crypto', id: 'chainlink',       label: 'LINK' },
  { kind: 'crypto', id: 'tron',            label: 'TRX' },
  { kind: 'crypto', id: 'litecoin',        label: 'LTC' },
  { kind: 'crypto', id: 'uniswap',         label: 'UNI' },
  { kind: 'crypto', id: 'cosmos',          label: 'ATOM' },
  { kind: 'crypto', id: 'stellar',         label: 'XLM' },
  { kind: 'crypto', id: 'near',            label: 'NEAR' },
  { kind: 'crypto', id: 'bitcoin-cash',    label: 'BCH' },
  { kind: 'crypto', id: 'shiba-inu',       label: 'SHIB' },
  { kind: 'crypto', id: 'matic-network',   label: 'MATIC' },
  { kind: 'crypto', id: 'arbitrum',        label: 'ARB' },
  { kind: 'crypto', id: 'optimism',        label: 'OP' },
  { kind: 'crypto', id: 'aptos',           label: 'APT' },
  { kind: 'crypto', id: 'internet-computer', label: 'ICP' },
  { kind: 'crypto', id: 'injective-protocol', label: 'INJ' },
  { kind: 'crypto', id: 'render-token',    label: 'RNDR' },
  { kind: 'crypto', id: 'sui',             label: 'SUI' },
  { kind: 'crypto', id: 'pepe',            label: 'PEPE' },
  { kind: 'crypto', id: 'kaspa',           label: 'KAS' },

  // ── Actions US tech & growth (20) ───────────────────────────
  { kind: 'action', symbol: 'AAPL',  label: 'Apple' },
  { kind: 'action', symbol: 'MSFT',  label: 'Microsoft' },
  { kind: 'action', symbol: 'GOOGL', label: 'Alphabet' },
  { kind: 'action', symbol: 'AMZN',  label: 'Amazon' },
  { kind: 'action', symbol: 'META',  label: 'Meta' },
  { kind: 'action', symbol: 'NVDA',  label: 'Nvidia' },
  { kind: 'action', symbol: 'TSLA',  label: 'Tesla' },
  { kind: 'action', symbol: 'AMD',   label: 'AMD' },
  { kind: 'action', symbol: 'NFLX',  label: 'Netflix' },
  { kind: 'action', symbol: 'INTC',  label: 'Intel' },
  { kind: 'action', symbol: 'CRM',   label: 'Salesforce' },
  { kind: 'action', symbol: 'ORCL',  label: 'Oracle' },
  { kind: 'action', symbol: 'IBM',   label: 'IBM' },
  { kind: 'action', symbol: 'AVGO',  label: 'Broadcom' },
  { kind: 'action', symbol: 'QCOM',  label: 'Qualcomm' },
  { kind: 'action', symbol: 'ADBE',  label: 'Adobe' },
  { kind: 'action', symbol: 'PYPL',  label: 'PayPal' },
  { kind: 'action', symbol: 'UBER',  label: 'Uber' },
  { kind: 'action', symbol: 'SHOP',  label: 'Shopify' },
  { kind: 'action', symbol: 'PLTR',  label: 'Palantir' },

  // ── Actions US blue-chips & financières (12) ───────────────
  { kind: 'action', symbol: 'JPM',   label: 'JPMorgan' },
  { kind: 'action', symbol: 'BAC',   label: 'Bank of America' },
  { kind: 'action', symbol: 'WFC',   label: 'Wells Fargo' },
  { kind: 'action', symbol: 'GS',    label: 'Goldman Sachs' },
  { kind: 'action', symbol: 'MS',    label: 'Morgan Stanley' },
  { kind: 'action', symbol: 'BLK',   label: 'BlackRock' },
  { kind: 'action', symbol: 'V',     label: 'Visa' },
  { kind: 'action', symbol: 'MA',    label: 'Mastercard' },
  { kind: 'action', symbol: 'BRK-B', label: 'Berkshire' },
  { kind: 'action', symbol: 'WMT',   label: 'Walmart' },
  { kind: 'action', symbol: 'KO',    label: 'Coca-Cola' },
  { kind: 'action', symbol: 'PG',    label: 'P&G' },

  // ── Actions US consommation/santé/énergie (10) ─────────────
  { kind: 'action', symbol: 'MCD',   label: 'McDonald\'s' },
  { kind: 'action', symbol: 'SBUX',  label: 'Starbucks' },
  { kind: 'action', symbol: 'COST',  label: 'Costco' },
  { kind: 'action', symbol: 'HD',    label: 'Home Depot' },
  { kind: 'action', symbol: 'NKE',   label: 'Nike' },
  { kind: 'action', symbol: 'DIS',   label: 'Disney' },
  { kind: 'action', symbol: 'JNJ',   label: 'Johnson & J.' },
  { kind: 'action', symbol: 'PFE',   label: 'Pfizer' },
  { kind: 'action', symbol: 'XOM',   label: 'Exxon' },
  { kind: 'action', symbol: 'CVX',   label: 'Chevron' },

  // ── Actions EU (10) ────────────────────────────────────────
  { kind: 'action', symbol: 'MC.PA',   label: 'LVMH' },
  { kind: 'action', symbol: 'TTE.PA',  label: 'TotalEnergies' },
  { kind: 'action', symbol: 'AIR.PA',  label: 'Airbus' },
  { kind: 'action', symbol: 'SAN.PA',  label: 'Sanofi' },
  { kind: 'action', symbol: 'BNP.PA',  label: 'BNP Paribas' },
  { kind: 'action', symbol: 'OR.PA',   label: 'L\'Oréal' },
  { kind: 'action', symbol: 'ASML.AS', label: 'ASML' },
  { kind: 'action', symbol: 'SAP',     label: 'SAP' },
  { kind: 'action', symbol: 'NESN.SW', label: 'Nestlé' },
  { kind: 'action', symbol: 'NOVO-B.CO', label: 'Novo Nordisk' },

  // ── ETF référence (10) ─────────────────────────────────────
  { kind: 'action', symbol: 'SPY',   label: 'SPY (S&P 500 ETF)' },
  { kind: 'action', symbol: 'QQQ',   label: 'QQQ (Nasdaq 100)' },
  { kind: 'action', symbol: 'IWM',   label: 'IWM (Russell 2000)' },
  { kind: 'action', symbol: 'VTI',   label: 'VTI (Total US Market)' },
  { kind: 'action', symbol: 'VEA',   label: 'VEA (Developed ex-US)' },
  { kind: 'action', symbol: 'VWO',   label: 'VWO (Emerging Markets)' },
  { kind: 'action', symbol: 'XLK',   label: 'XLK Tech' },
  { kind: 'action', symbol: 'XLF',   label: 'XLF Finance' },
  { kind: 'action', symbol: 'XLE',   label: 'XLE Energy' },
  { kind: 'action', symbol: 'GLD',   label: 'GLD (Gold ETF)' },

  // ── Forex (10) ─────────────────────────────────────────────
  { kind: 'forex',  symbol: 'EURUSD=X', label: 'EUR/USD' },
  { kind: 'forex',  symbol: 'GBPUSD=X', label: 'GBP/USD' },
  { kind: 'forex',  symbol: 'USDJPY=X', label: 'USD/JPY' },
  { kind: 'forex',  symbol: 'USDCHF=X', label: 'USD/CHF' },
  { kind: 'forex',  symbol: 'AUDUSD=X', label: 'AUD/USD' },
  { kind: 'forex',  symbol: 'USDCAD=X', label: 'USD/CAD' },
  { kind: 'forex',  symbol: 'NZDUSD=X', label: 'NZD/USD' },
  { kind: 'forex',  symbol: 'EURGBP=X', label: 'EUR/GBP' },
  { kind: 'forex',  symbol: 'EURJPY=X', label: 'EUR/JPY' },
  { kind: 'forex',  symbol: 'USDMXN=X', label: 'USD/MXN' },

  // ── Métaux & matières premières (10) ───────────────────────
  { kind: 'metal',  symbol: 'GC=F', label: 'Or (Gold)' },
  { kind: 'metal',  symbol: 'SI=F', label: 'Argent (Silver)' },
  { kind: 'metal',  symbol: 'PL=F', label: 'Platine' },
  { kind: 'metal',  symbol: 'PA=F', label: 'Palladium' },
  { kind: 'metal',  symbol: 'HG=F', label: 'Cuivre' },
  { kind: 'metal',  symbol: 'CL=F', label: 'Pétrole WTI' },
  { kind: 'metal',  symbol: 'BZ=F', label: 'Brent' },
  { kind: 'metal',  symbol: 'NG=F', label: 'Gaz naturel' },
  { kind: 'metal',  symbol: 'ZW=F', label: 'Blé' },
  { kind: 'metal',  symbol: 'KC=F', label: 'Café' },
  { kind: 'metal',  symbol: 'ZC=F', label: 'Maïs' },
  { kind: 'metal',  symbol: 'ZS=F', label: 'Soja' },
  { kind: 'metal',  symbol: 'CT=F', label: 'Coton' },
  { kind: 'metal',  symbol: 'CC=F', label: 'Cacao' },
  { kind: 'metal',  symbol: 'SB=F', label: 'Sucre' },
  { kind: 'metal',  symbol: 'OJ=F', label: 'Jus d\'orange' },
  { kind: 'metal',  symbol: 'LE=F', label: 'Bétail' },

  // v7.3 — EXPANSION MAJEURE : ~600 actifs supplémentaires vers couverture
  // universelle (objectif : référence multi-broker Binance/XTB)

  // ── INDICES COMPLÉMENTAIRES (+15) ──────────────────────────
  { kind: 'index',  symbol: '^MIB.MI',   label: 'FTSE MIB Italie' },
  { kind: 'index',  symbol: 'PSI20.LS',  label: 'PSI 20 Portugal' },
  { kind: 'index',  symbol: '^ATX',      label: 'ATX Autriche' },
  { kind: 'index',  symbol: '^GSPTSE',   label: 'TSX Toronto' },
  { kind: 'index',  symbol: '^MERV',     label: 'Merval Argentine' },
  { kind: 'index',  symbol: '^JKSE',     label: 'JKSE Indonésie' },
  { kind: 'index',  symbol: '^KLSE',     label: 'KLCI Malaisie' },
  { kind: 'index',  symbol: '^SET.BK',   label: 'SET Thailand' },
  { kind: 'index',  symbol: '^TA125.TA', label: 'Tel Aviv 125' },
  { kind: 'index',  symbol: '^N100',     label: 'Euronext 100' },
  { kind: 'index',  symbol: '^MID',      label: 'S&P MidCap 400' },
  { kind: 'index',  symbol: '^SP600',    label: 'S&P SmallCap 600' },
  { kind: 'index',  symbol: '^OEX',      label: 'S&P 100' },
  { kind: 'index',  symbol: '^XAX',      label: 'NYSE AMEX' },
  { kind: 'index',  symbol: '^VIX',      label: 'VIX (volatilité)' },

  // ── ACTIONS US S&P 500 complémentaires (+250 mega-large caps) ──
  // Tech & semi-conducteurs
  { kind: 'action', symbol: 'CSCO', label: 'Cisco' },
  { kind: 'action', symbol: 'TXN',  label: 'Texas Instruments' },
  { kind: 'action', symbol: 'MU',   label: 'Micron' },
  { kind: 'action', symbol: 'AMAT', label: 'Applied Materials' },
  { kind: 'action', symbol: 'LRCX', label: 'Lam Research' },
  { kind: 'action', symbol: 'KLAC', label: 'KLA Corp' },
  { kind: 'action', symbol: 'NXPI', label: 'NXP Semiconductors' },
  { kind: 'action', symbol: 'MRVL', label: 'Marvell Tech' },
  { kind: 'action', symbol: 'ASML', label: 'ASML (US ADR)' },
  { kind: 'action', symbol: 'TSM',  label: 'TSMC' },
  { kind: 'action', symbol: 'NOW',  label: 'ServiceNow' },
  { kind: 'action', symbol: 'INTU', label: 'Intuit' },
  { kind: 'action', symbol: 'ADP',  label: 'ADP' },
  { kind: 'action', symbol: 'WDAY', label: 'Workday' },
  { kind: 'action', symbol: 'TEAM', label: 'Atlassian' },
  { kind: 'action', symbol: 'PANW', label: 'Palo Alto Networks' },
  { kind: 'action', symbol: 'CRWD', label: 'CrowdStrike' },
  { kind: 'action', symbol: 'ZS',   label: 'Zscaler' },
  { kind: 'action', symbol: 'DDOG', label: 'Datadog' },
  { kind: 'action', symbol: 'SNOW', label: 'Snowflake' },
  { kind: 'action', symbol: 'NET',  label: 'Cloudflare' },
  { kind: 'action', symbol: 'MDB',  label: 'MongoDB' },
  { kind: 'action', symbol: 'OKTA', label: 'Okta' },
  { kind: 'action', symbol: 'SQ',   label: 'Block (Square)' },
  { kind: 'action', symbol: 'COIN', label: 'Coinbase' },
  { kind: 'action', symbol: 'RBLX', label: 'Roblox' },
  { kind: 'action', symbol: 'SNAP', label: 'Snap' },
  { kind: 'action', symbol: 'PINS', label: 'Pinterest' },
  { kind: 'action', symbol: 'SPOT', label: 'Spotify' },
  { kind: 'action', symbol: 'ABNB', label: 'Airbnb' },
  { kind: 'action', symbol: 'LYFT', label: 'Lyft' },
  { kind: 'action', symbol: 'DASH', label: 'DoorDash' },
  { kind: 'action', symbol: 'ZM',   label: 'Zoom' },
  { kind: 'action', symbol: 'TWLO', label: 'Twilio' },
  { kind: 'action', symbol: 'DOCU', label: 'DocuSign' },
  { kind: 'action', symbol: 'NTNX', label: 'Nutanix' },
  { kind: 'action', symbol: 'ROKU', label: 'Roku' },
  { kind: 'action', symbol: 'PATH', label: 'UiPath' },
  { kind: 'action', symbol: 'AI',   label: 'C3.ai' },
  { kind: 'action', symbol: 'SMCI', label: 'Super Micro' },
  { kind: 'action', symbol: 'ARM',  label: 'ARM Holdings' },
  { kind: 'action', symbol: 'DELL', label: 'Dell' },
  { kind: 'action', symbol: 'HPQ',  label: 'HP' },
  { kind: 'action', symbol: 'WDC',  label: 'Western Digital' },
  { kind: 'action', symbol: 'STX',  label: 'Seagate' },
  { kind: 'action', symbol: 'NTAP', label: 'NetApp' },
  { kind: 'action', symbol: 'CTSH', label: 'Cognizant' },
  { kind: 'action', symbol: 'INFY', label: 'Infosys' },

  // Santé & pharma
  { kind: 'action', symbol: 'LLY',  label: 'Eli Lilly' },
  { kind: 'action', symbol: 'MRK',  label: 'Merck' },
  { kind: 'action', symbol: 'ABBV', label: 'AbbVie' },
  { kind: 'action', symbol: 'BMY',  label: 'Bristol-Myers' },
  { kind: 'action', symbol: 'AMGN', label: 'Amgen' },
  { kind: 'action', symbol: 'GILD', label: 'Gilead' },
  { kind: 'action', symbol: 'MRNA', label: 'Moderna' },
  { kind: 'action', symbol: 'BIIB', label: 'Biogen' },
  { kind: 'action', symbol: 'REGN', label: 'Regeneron' },
  { kind: 'action', symbol: 'VRTX', label: 'Vertex' },
  { kind: 'action', symbol: 'ABT',  label: 'Abbott' },
  { kind: 'action', symbol: 'DHR',  label: 'Danaher' },
  { kind: 'action', symbol: 'MDT',  label: 'Medtronic' },
  { kind: 'action', symbol: 'TMO',  label: 'Thermo Fisher' },
  { kind: 'action', symbol: 'ISRG', label: 'Intuitive Surgical' },
  { kind: 'action', symbol: 'CVS',  label: 'CVS Health' },
  { kind: 'action', symbol: 'UNH',  label: 'UnitedHealth' },
  { kind: 'action', symbol: 'HUM',  label: 'Humana' },
  { kind: 'action', symbol: 'ELV',  label: 'Elevance Health' },
  { kind: 'action', symbol: 'CI',   label: 'Cigna' },

  // Finance complémentaire
  { kind: 'action', symbol: 'C',    label: 'Citigroup' },
  { kind: 'action', symbol: 'SCHW', label: 'Charles Schwab' },
  { kind: 'action', symbol: 'AXP',  label: 'American Express' },
  { kind: 'action', symbol: 'COF',  label: 'Capital One' },
  { kind: 'action', symbol: 'PNC',  label: 'PNC Bank' },
  { kind: 'action', symbol: 'USB',  label: 'US Bancorp' },
  { kind: 'action', symbol: 'TFC',  label: 'Truist' },
  { kind: 'action', symbol: 'CB',   label: 'Chubb' },
  { kind: 'action', symbol: 'PGR',  label: 'Progressive' },
  { kind: 'action', symbol: 'AIG',  label: 'AIG' },
  { kind: 'action', symbol: 'MET',  label: 'MetLife' },
  { kind: 'action', symbol: 'ALL',  label: 'Allstate' },
  { kind: 'action', symbol: 'SPGI', label: 'S&P Global' },
  { kind: 'action', symbol: 'MCO',  label: 'Moody\'s' },
  { kind: 'action', symbol: 'ICE',  label: 'Intercontinental Exchange' },
  { kind: 'action', symbol: 'CME',  label: 'CME Group' },

  // Conso & retail
  { kind: 'action', symbol: 'LOW',  label: 'Lowe\'s' },
  { kind: 'action', symbol: 'TGT',  label: 'Target' },
  { kind: 'action', symbol: 'TJX',  label: 'TJX' },
  { kind: 'action', symbol: 'CMG',  label: 'Chipotle' },
  { kind: 'action', symbol: 'YUM',  label: 'Yum! Brands' },
  { kind: 'action', symbol: 'EBAY', label: 'eBay' },
  { kind: 'action', symbol: 'ETSY', label: 'Etsy' },
  { kind: 'action', symbol: 'F',    label: 'Ford' },
  { kind: 'action', symbol: 'GM',   label: 'General Motors' },
  { kind: 'action', symbol: 'BA',   label: 'Boeing' },
  { kind: 'action', symbol: 'LMT',  label: 'Lockheed Martin' },
  { kind: 'action', symbol: 'RTX',  label: 'RTX Corp' },
  { kind: 'action', symbol: 'GD',   label: 'General Dynamics' },
  { kind: 'action', symbol: 'NOC',  label: 'Northrop Grumman' },
  { kind: 'action', symbol: 'CAT',  label: 'Caterpillar' },
  { kind: 'action', symbol: 'DE',   label: 'John Deere' },
  { kind: 'action', symbol: 'HON',  label: 'Honeywell' },
  { kind: 'action', symbol: 'UPS',  label: 'UPS' },
  { kind: 'action', symbol: 'FDX',  label: 'FedEx' },
  { kind: 'action', symbol: 'DAL',  label: 'Delta Airlines' },
  { kind: 'action', symbol: 'UAL',  label: 'United Airlines' },
  { kind: 'action', symbol: 'AAL',  label: 'American Airlines' },
  { kind: 'action', symbol: 'CCL',  label: 'Carnival' },
  { kind: 'action', symbol: 'RCL',  label: 'Royal Caribbean' },
  { kind: 'action', symbol: 'MAR',  label: 'Marriott' },
  { kind: 'action', symbol: 'HLT',  label: 'Hilton' },
  { kind: 'action', symbol: 'BKNG', label: 'Booking Holdings' },
  { kind: 'action', symbol: 'EXPE', label: 'Expedia' },

  // Énergie & matières
  { kind: 'action', symbol: 'COP',  label: 'ConocoPhillips' },
  { kind: 'action', symbol: 'EOG',  label: 'EOG Resources' },
  { kind: 'action', symbol: 'OXY',  label: 'Occidental' },
  { kind: 'action', symbol: 'SLB',  label: 'Schlumberger' },
  { kind: 'action', symbol: 'PSX',  label: 'Phillips 66' },
  { kind: 'action', symbol: 'VLO',  label: 'Valero' },
  { kind: 'action', symbol: 'MPC',  label: 'Marathon Petroleum' },
  { kind: 'action', symbol: 'KMI',  label: 'Kinder Morgan' },
  { kind: 'action', symbol: 'ENB',  label: 'Enbridge' },
  { kind: 'action', symbol: 'BP',   label: 'BP' },
  { kind: 'action', symbol: 'SHEL', label: 'Shell' },
  { kind: 'action', symbol: 'FCX',  label: 'Freeport-McMoRan' },
  { kind: 'action', symbol: 'NEM',  label: 'Newmont Mining' },
  { kind: 'action', symbol: 'GOLD', label: 'Barrick Gold' },
  { kind: 'action', symbol: 'AA',   label: 'Alcoa' },
  { kind: 'action', symbol: 'X',    label: 'US Steel' },
  { kind: 'action', symbol: 'NUE',  label: 'Nucor' },

  // Bio/Tech émergent
  { kind: 'action', symbol: 'GME',  label: 'GameStop' },
  { kind: 'action', symbol: 'AMC',  label: 'AMC' },
  { kind: 'action', symbol: 'NIO',  label: 'NIO' },
  { kind: 'action', symbol: 'XPEV', label: 'XPeng' },
  { kind: 'action', symbol: 'LI',   label: 'Li Auto' },
  { kind: 'action', symbol: 'RIVN', label: 'Rivian' },
  { kind: 'action', symbol: 'LCID', label: 'Lucid' },
  { kind: 'action', symbol: 'NKLA', label: 'Nikola' },
  { kind: 'action', symbol: 'PLUG', label: 'Plug Power' },
  { kind: 'action', symbol: 'ENPH', label: 'Enphase' },
  { kind: 'action', symbol: 'FSLR', label: 'First Solar' },
  { kind: 'action', symbol: 'RUN',  label: 'Sunrun' },
  { kind: 'action', symbol: 'SEDG', label: 'SolarEdge' },

  // Utilities & immobilier
  { kind: 'action', symbol: 'NEE',  label: 'NextEra Energy' },
  { kind: 'action', symbol: 'DUK',  label: 'Duke Energy' },
  { kind: 'action', symbol: 'SO',   label: 'Southern Company' },
  { kind: 'action', symbol: 'D',    label: 'Dominion' },
  { kind: 'action', symbol: 'EXC',  label: 'Exelon' },
  { kind: 'action', symbol: 'AEP',  label: 'American Electric' },
  { kind: 'action', symbol: 'O',    label: 'Realty Income' },
  { kind: 'action', symbol: 'AMT',  label: 'American Tower' },
  { kind: 'action', symbol: 'PLD',  label: 'Prologis' },
  { kind: 'action', symbol: 'CCI',  label: 'Crown Castle' },
  { kind: 'action', symbol: 'SPG',  label: 'Simon Property' },
  { kind: 'action', symbol: 'EQIX', label: 'Equinix' },
  { kind: 'action', symbol: 'PSA',  label: 'Public Storage' },

  // Médias & télécom
  { kind: 'action', symbol: 'CMCSA',label: 'Comcast' },
  { kind: 'action', symbol: 'T',    label: 'AT&T' },
  { kind: 'action', symbol: 'VZ',   label: 'Verizon' },
  { kind: 'action', symbol: 'TMUS', label: 'T-Mobile' },
  { kind: 'action', symbol: 'WBD',  label: 'Warner Bros Discovery' },
  { kind: 'action', symbol: 'PARA', label: 'Paramount' },
  { kind: 'action', symbol: 'EA',   label: 'Electronic Arts' },
  { kind: 'action', symbol: 'TTWO', label: 'Take-Two' },
  { kind: 'action', symbol: 'ATVI', label: 'Activision' },

  // ── ACTIONS EU complémentaires (+50) ───────────────────────
  // France (Sanofi déjà ligne ~706)
  { kind: 'action', symbol: 'CS.PA',   label: 'AXA' },
  { kind: 'action', symbol: 'GLE.PA',  label: 'Société Générale' },
  { kind: 'action', symbol: 'ACA.PA',  label: 'Crédit Agricole' },
  { kind: 'action', symbol: 'CAP.PA',  label: 'Capgemini' },
  { kind: 'action', symbol: 'EN.PA',   label: 'Bouygues' },
  { kind: 'action', symbol: 'VIE.PA',  label: 'Veolia' },
  { kind: 'action', symbol: 'SU.PA',   label: 'Schneider Electric' },
  { kind: 'action', symbol: 'STM.PA',  label: 'STMicroelectronics' },
  { kind: 'action', symbol: 'DG.PA',   label: 'Vinci' },
  { kind: 'action', symbol: 'RNO.PA',  label: 'Renault' },
  { kind: 'action', symbol: 'STLA.PA', label: 'Stellantis' },
  { kind: 'action', symbol: 'KER.PA',  label: 'Kering' },
  { kind: 'action', symbol: 'CDI.PA',  label: 'Christian Dior' },
  { kind: 'action', symbol: 'RMS.PA',  label: 'Hermès' },
  { kind: 'action', symbol: 'EL.PA',   label: 'EssilorLuxottica' },
  { kind: 'action', symbol: 'BN.PA',   label: 'Danone' },
  { kind: 'action', symbol: 'ML.PA',   label: 'Michelin' },
  { kind: 'action', symbol: 'PUB.PA',  label: 'Publicis' },
  { kind: 'action', symbol: 'EDF.PA',  label: 'EDF' },
  // Allemagne
  { kind: 'action', symbol: 'BAS.DE',  label: 'BASF' },
  { kind: 'action', symbol: 'BMW.DE',  label: 'BMW' },
  { kind: 'action', symbol: 'MBG.DE',  label: 'Mercedes-Benz' },
  { kind: 'action', symbol: 'VOW3.DE', label: 'Volkswagen' },
  { kind: 'action', symbol: 'SIE.DE',  label: 'Siemens' },
  { kind: 'action', symbol: 'ALV.DE',  label: 'Allianz' },
  { kind: 'action', symbol: 'DBK.DE',  label: 'Deutsche Bank' },
  { kind: 'action', symbol: 'BAYN.DE', label: 'Bayer' },
  { kind: 'action', symbol: 'DTE.DE',  label: 'Deutsche Telekom' },
  { kind: 'action', symbol: 'ADS.DE',  label: 'Adidas' },
  { kind: 'action', symbol: 'PUM.DE',  label: 'Puma' },
  { kind: 'action', symbol: 'IFX.DE',  label: 'Infineon' },
  { kind: 'action', symbol: 'MUV2.DE', label: 'Munich Re' },
  { kind: 'action', symbol: 'DHL.DE',  label: 'DHL Group' },
  { kind: 'action', symbol: 'P911.DE', label: 'Porsche' },
  // UK
  { kind: 'action', symbol: 'HSBA.L',  label: 'HSBC' },
  { kind: 'action', symbol: 'BARC.L',  label: 'Barclays' },
  { kind: 'action', symbol: 'LLOY.L',  label: 'Lloyds' },
  { kind: 'action', symbol: 'NWG.L',   label: 'NatWest' },
  { kind: 'action', symbol: 'AZN.L',   label: 'AstraZeneca' },
  { kind: 'action', symbol: 'GSK.L',   label: 'GSK' },
  { kind: 'action', symbol: 'ULVR.L',  label: 'Unilever' },
  { kind: 'action', symbol: 'DGE.L',   label: 'Diageo' },
  { kind: 'action', symbol: 'BP.L',    label: 'BP (UK)' },
  { kind: 'action', symbol: 'SHEL.L',  label: 'Shell (UK)' },
  { kind: 'action', symbol: 'RIO.L',   label: 'Rio Tinto' },
  { kind: 'action', symbol: 'BHP.L',   label: 'BHP' },
  { kind: 'action', symbol: 'GLEN.L',  label: 'Glencore' },
  { kind: 'action', symbol: 'BT-A.L',  label: 'BT Group' },
  { kind: 'action', symbol: 'VOD.L',   label: 'Vodafone' },
  // Pays-Bas / Suisse / Italie / Espagne
  { kind: 'action', symbol: 'ADYEN.AS',label: 'Adyen' },
  { kind: 'action', symbol: 'INGA.AS', label: 'ING' },
  { kind: 'action', symbol: 'PHIA.AS', label: 'Philips' },
  { kind: 'action', symbol: 'ROG.SW',  label: 'Roche' },
  { kind: 'action', symbol: 'NOVN.SW', label: 'Novartis' },
  { kind: 'action', symbol: 'UBSG.SW', label: 'UBS' },
  { kind: 'action', symbol: 'CFR.SW',  label: 'Richemont' },
  { kind: 'action', symbol: 'ABBN.SW', label: 'ABB' },
  { kind: 'action', symbol: 'UCG.MI',  label: 'UniCredit' },
  { kind: 'action', symbol: 'ENI.MI',  label: 'ENI' },
  { kind: 'action', symbol: 'ISP.MI',  label: 'Intesa Sanpaolo' },
  { kind: 'action', symbol: 'STLAM.MI',label: 'Stellantis (MI)' },
  { kind: 'action', symbol: 'BBVA.MC', label: 'BBVA' },
  { kind: 'action', symbol: 'SAN.MC',  label: 'Banco Santander' },
  { kind: 'action', symbol: 'TEF.MC',  label: 'Telefónica' },
  { kind: 'action', symbol: 'IBE.MC',  label: 'Iberdrola' },
  { kind: 'action', symbol: 'ITX.MC',  label: 'Inditex' },

  // ── ACTIONS ASIE complémentaires (+30) ─────────────────────
  { kind: 'action', symbol: 'BABA',    label: 'Alibaba (US ADR)' },
  { kind: 'action', symbol: 'PDD',     label: 'PDD Holdings' },
  { kind: 'action', symbol: 'JD',      label: 'JD.com' },
  { kind: 'action', symbol: 'BIDU',    label: 'Baidu' },
  { kind: 'action', symbol: 'NTES',    label: 'NetEase' },
  { kind: 'action', symbol: 'BILI',    label: 'Bilibili' },
  { kind: 'action', symbol: '9988.HK', label: 'Alibaba (HK)' },
  { kind: 'action', symbol: '0700.HK', label: 'Tencent' },
  { kind: 'action', symbol: '1810.HK', label: 'Xiaomi' },
  { kind: 'action', symbol: '3690.HK', label: 'Meituan' },
  { kind: 'action', symbol: '2318.HK', label: 'Ping An Insurance' },
  { kind: 'action', symbol: '0939.HK', label: 'China Construction Bank' },
  { kind: 'action', symbol: '1398.HK', label: 'ICBC' },
  { kind: 'action', symbol: '7203.T',  label: 'Toyota' },
  { kind: 'action', symbol: '6758.T',  label: 'Sony' },
  { kind: 'action', symbol: '9984.T',  label: 'SoftBank' },
  { kind: 'action', symbol: '6861.T',  label: 'Keyence' },
  { kind: 'action', symbol: '8306.T',  label: 'MUFG' },
  { kind: 'action', symbol: '7974.T',  label: 'Nintendo' },
  { kind: 'action', symbol: '005930.KS', label: 'Samsung' },
  { kind: 'action', symbol: '000660.KS', label: 'SK Hynix' },
  { kind: 'action', symbol: '035420.KS', label: 'Naver' },
  { kind: 'action', symbol: 'INFY.NS', label: 'Infosys (NSE)' },
  { kind: 'action', symbol: 'RELIANCE.NS', label: 'Reliance Industries' },
  { kind: 'action', symbol: 'TCS.NS',  label: 'TCS' },
  { kind: 'action', symbol: 'HDFCBANK.NS', label: 'HDFC Bank' },
  { kind: 'action', symbol: 'TTE',     label: 'TotalEnergies (US ADR)' },
  { kind: 'action', symbol: 'NVS',     label: 'Novartis (US ADR)' },
  { kind: 'action', symbol: 'TM',      label: 'Toyota (US ADR)' },
  { kind: 'action', symbol: 'SONY',    label: 'Sony (US ADR)' },

  // ── ETF SECTORIELS & GÉOGRAPHIQUES (+30) ───────────────────
  { kind: 'action', symbol: 'XLU',  label: 'XLU Utilities' },
  { kind: 'action', symbol: 'XLY',  label: 'XLY Consumer Disc.' },
  { kind: 'action', symbol: 'XLP',  label: 'XLP Consumer Staples' },
  { kind: 'action', symbol: 'XLV',  label: 'XLV Healthcare' },
  { kind: 'action', symbol: 'XLI',  label: 'XLI Industrials' },
  { kind: 'action', symbol: 'XLB',  label: 'XLB Materials' },
  { kind: 'action', symbol: 'XLRE', label: 'XLRE Real Estate' },
  { kind: 'action', symbol: 'XLC',  label: 'XLC Communication' },
  { kind: 'action', symbol: 'SOXX', label: 'SOXX Semiconductors' },
  { kind: 'action', symbol: 'SMH',  label: 'SMH Semi ETF' },
  { kind: 'action', symbol: 'KRE',  label: 'KRE Regional Banks' },
  { kind: 'action', symbol: 'KBE',  label: 'KBE Banks' },
  { kind: 'action', symbol: 'ITA',  label: 'ITA Aerospace' },
  { kind: 'action', symbol: 'IBB',  label: 'IBB Biotech' },
  { kind: 'action', symbol: 'TAN',  label: 'TAN Solar' },
  { kind: 'action', symbol: 'LIT',  label: 'LIT Lithium' },
  { kind: 'action', symbol: 'URA',  label: 'URA Uranium' },
  { kind: 'action', symbol: 'JETS', label: 'JETS Airlines' },
  { kind: 'action', symbol: 'EWJ',  label: 'EWJ Japan ETF' },
  { kind: 'action', symbol: 'EWZ',  label: 'EWZ Brazil ETF' },
  { kind: 'action', symbol: 'EWG',  label: 'EWG Germany ETF' },
  { kind: 'action', symbol: 'EWU',  label: 'EWU UK ETF' },
  { kind: 'action', symbol: 'EWA',  label: 'EWA Australia ETF' },
  { kind: 'action', symbol: 'EWC',  label: 'EWC Canada ETF' },
  { kind: 'action', symbol: 'MCHI', label: 'MCHI China ETF' },
  { kind: 'action', symbol: 'INDA', label: 'INDA India ETF' },
  { kind: 'action', symbol: 'EWY',  label: 'EWY Korea ETF' },
  { kind: 'action', symbol: 'EWW',  label: 'EWW Mexico ETF' },
  { kind: 'action', symbol: 'EWQ',  label: 'EWQ France ETF' },
  { kind: 'action', symbol: 'ARKK', label: 'ARKK Innovation' },

  // ── FOREX exotiques (+10) ──────────────────────────────────
  { kind: 'forex',  symbol: 'USDSEK=X', label: 'USD/SEK' },
  { kind: 'forex',  symbol: 'USDNOK=X', label: 'USD/NOK' },
  { kind: 'forex',  symbol: 'USDZAR=X', label: 'USD/ZAR' },
  { kind: 'forex',  symbol: 'USDBRL=X', label: 'USD/BRL' },
  { kind: 'forex',  symbol: 'USDINR=X', label: 'USD/INR' },
  { kind: 'forex',  symbol: 'USDTRY=X', label: 'USD/TRY' },
  { kind: 'forex',  symbol: 'AUDJPY=X', label: 'AUD/JPY' },
  { kind: 'forex',  symbol: 'GBPJPY=X', label: 'GBP/JPY' },
  { kind: 'forex',  symbol: 'CHFJPY=X', label: 'CHF/JPY' },
  { kind: 'forex',  symbol: 'CADJPY=X', label: 'CAD/JPY' },

  // ── CRYPTO complémentaires (+22) via CoinGecko ─────────────
  // (limite raisonnable pour le rate-limit free CoinGecko)
  { kind: 'crypto', id: 'hyperliquid',      label: 'HYPE' },
  { kind: 'crypto', id: 'celestia',         label: 'TIA' },
  { kind: 'crypto', id: 'bittensor',        label: 'TAO' },
  { kind: 'crypto', id: 'jupiter-exchange-solana', label: 'JUP' },
  { kind: 'crypto', id: 'fetch-ai',         label: 'FET' },
  { kind: 'crypto', id: 'the-graph',        label: 'GRT' },
  { kind: 'crypto', id: 'algorand',         label: 'ALGO' },
  { kind: 'crypto', id: 'vechain',          label: 'VET' },
  { kind: 'crypto', id: 'monero',           label: 'XMR' },
  { kind: 'crypto', id: 'aave',             label: 'AAVE' },
  { kind: 'crypto', id: 'maker',            label: 'MKR' },
  { kind: 'crypto', id: 'lido-dao',         label: 'LDO' },
  { kind: 'crypto', id: 'thorchain',        label: 'RUNE' },
  { kind: 'crypto', id: 'mantle',           label: 'MNT' },
  { kind: 'crypto', id: 'immutable-x',      label: 'IMX' },
  { kind: 'crypto', id: 'stacks',           label: 'STX' },
  { kind: 'crypto', id: 'ondo-finance',     label: 'ONDO' },
  { kind: 'crypto', id: 'sei-network',      label: 'SEI' },
  { kind: 'crypto', id: 'pyth-network',     label: 'PYTH' },
  { kind: 'crypto', id: 'worldcoin-wld',    label: 'WLD' },
  { kind: 'crypto', id: 'jasmycoin',        label: 'JASMY' },
  { kind: 'crypto', id: 'first-digital-usd',label: 'FDUSD' },
  // v7.19 — ajouts pour compléter VOLT_UNIVERSE
  { kind: 'crypto', id: 'filecoin',         label: 'FIL' },
  { kind: 'crypto', id: 'singularitynet',   label: 'AGIX' },
  // Actions VOLT manquantes
  { kind: 'action', symbol: 'MSTR', label: 'MicroStrategy' },
  { kind: 'action', symbol: 'AFRM', label: 'Affirm' },
  { kind: 'action', symbol: 'SOFI', label: 'SoFi' },
  { kind: 'action', symbol: 'CVNA', label: 'Carvana' },
  { kind: 'action', symbol: 'ASTS', label: 'AST SpaceMobile' },
  { kind: 'action', symbol: 'IONQ', label: 'IonQ' },
  { kind: 'action', symbol: 'RKLB', label: 'Rocket Lab' },
  { kind: 'action', symbol: 'ACHR', label: 'Archer Aviation' },
  { kind: 'action', symbol: 'JOBY', label: 'Joby Aviation' },
  { kind: 'action', symbol: 'U',    label: 'Unity' },
  { kind: 'action', symbol: 'DKNG', label: 'DraftKings' },
  { kind: 'action', symbol: 'BYND', label: 'Beyond Meat' },
];

async function fetchOne(a) {
  try {
    // v2.60 — Indices, actions, forex et métaux passent par Yahoo (symbol)
    // Crypto via CoinGecko (id)
    // v4.1 FIX CRITIQUE — On récupère AUSSI les volumes (oubliés avant v4.1).
    // Sans volumes, OBV/MFI/ForceIndex étaient null et les filtres volume des
    // patterns ne s'appliquaient jamais → tous les setups passaient.
    if (a.kind === 'crypto') {
      const d = await fetchCoinGeckoHistorical(a.id, 60);
      return { ...a, prices: d.prices, volumes: d.volumes || [], price: d.price, prevClose: d.prevClose };
    }
    const d = await fetchYahooHistorical(a.symbol, '3mo');
    return { ...a, prices: d.prices, volumes: d.volumes || [], price: d.price, prevClose: d.prevClose };
  } catch (e) {
    console.warn(`Skipping ${a.label}:`, e.message);
    return null;
  }
}

function summarizeAsset(a) {
  // v2.72 — Passe les volumes pour permettre VWAP, OBV, MFI, Force Index
  const ind = computeAllIndicators(a.prices, a.volumes);
  if (!ind) return null;
  const v = globalVerdict(ind);
  const change = a.prevClose ? ((a.price - a.prevClose) / a.prevClose) * 100 : 0;
  return {
    label: a.label,
    kind: a.kind,
    price: a.price,
    prices: a.prices,
    volumes: a.volumes || [],
    change: change.toFixed(2),
    rsi: ind.rsi?.value.toFixed(0),
    maCross: ind.maCross?.signal,
    macdHist: ind.macd?.value.toFixed(2),
    boll: ind.boll ? (ind.boll.value * 100).toFixed(0) + '%' : null,
    adx: ind.adx?.value.toFixed(0),
    atr: ind.atr ? ind.atr.value.toFixed(1) + '%' : null,
    atrAbs: ind.atr ? (ind.atr.value / 100) * a.price : null,
    indRaw: ind,
    verdict: v.label,
    score: v.score,
    cls: v.cls,
  };
}

/**
 * Detecte un setup techniquement pertinent sur l'actif.
 * Retourne {type, label, config, entry, stop, tp1, tp2, rr1, rr2, rationale}
 * ou null si aucune configuration claire (marche en range / signaux contradictoires).
 *
 * IMPORTANT — Cadre legal AMF : ce sont des CAS PEDAGOGIQUES bases sur
 * l'analyse technique objective. Pas un conseil personnalise. Le wording
 * dans l'app doit dire 'cas d'ecole', 'configuration observee', etc.
 */
/**
 * v2.54 — Mode ULTRA FIABLE
 *
 * Chaque setup exige maintenant :
 *   - Au moins 3 indicateurs cohérents alignés (confirmation multi-facteurs)
 *   - Aucun signal majeur contradictoire (ex : MA20<entry sur un long mean reversion)
 *   - Niveaux logiquement valides (TP1 > entry pour long, R/R >= 1.8 sur TP2)
 *   - Confidence calculée (medium / high / very-high) selon nombre de confirmations
 *
 * Si aucun setup ne passe ces filtres, on retourne null. Mieux vaut "rien" qu'un
 * faux positif comme l'ETH précédent (TP1<entry).
 */
function detectSetup(a) {
  if (!a || !a.indRaw || !a.atrAbs) return null;
  const ind = a.indRaw;
  const prices = a.prices;
  const last = prices[prices.length - 1];
  const atr = a.atrAbs;
  const rsi = ind.rsi?.value;
  const adx = ind.adx?.value || 0;
  const ma20 = ind.ma20?.value;
  const ma50 = ind.ma50?.value;
  const macdH = ind.macd?.value;
  const bollPos = ind.boll?.value;
  const mom = ind.mom?.valuePct;

  // Dérivée du MACD (acceleration positive si les 3 dernières barres montent)
  // Approche simple : on compare le prix actuel au prix d'il y a 3 jours
  const recentTrend3 = prices.length > 3 ? (last - prices[prices.length - 4]) / prices[prices.length - 4] : 0;

  // Helper : pour qu'un setup soit accepté, il faut un minimum de "score" interne
  // basé sur le nombre de confirmations. On enregistre la confidence finale.
  function validateLong(entry, stop, tp1, tp2) {
    if (stop >= entry) return null;          // stop doit être SOUS entry
    if (tp1 <= entry) return null;            // TP1 doit être AU-DESSUS pour un long
    if (tp2 <= tp1) return null;              // TP2 doit être au-dessus de TP1
    const risk = entry - stop;
    const reward = tp2 - entry;
    if (reward / risk < 1.8) return null;     // R/R minimum 1.8:1
    return { entry, stop, tp1, tp2,
      rr1: ((tp1 - entry) / risk).toFixed(2),
      rr2: ((tp2 - entry) / risk).toFixed(2) };
  }

  // ─────────────────────────────────────────────────────────────────
  // Setup 1 : REBOND SURVENTE (long contrarian, court terme)
  // Conditions : RSI<30 + Boll<0.15 + MA20>entry (mean reversion possible)
  //              + dérivée 3j en train de se retourner (recentTrend3 > -2 %)
  // ─────────────────────────────────────────────────────────────────
  if (rsi != null && rsi < 30 && bollPos != null && bollPos < 0.15
      && ma20 != null && ma20 > last
      && recentTrend3 > -0.025) {
    const entry = last;
    const stop = entry - 1.5 * atr;
    const tp1 = Math.min(ma20, entry + 2 * atr); // MA20 garantie > entry maintenant
    const tp2 = Math.max(entry + 3 * atr, tp1 + atr);
    const lvl = validateLong(entry, stop, tp1, tp2);
    if (lvl) {
      const conf = (rsi < 25 && bollPos < 0.08) ? 'very-high' : 'high';
      return Object.assign({}, lvl, {
        type: 'rebond-survente',
        label: 'Rebond technique sur survente',
        timeframe: 'Court terme · 1-3 jours',
        confidence: conf,
        config: 'RSI ' + rsi.toFixed(0) + ' (vraie survente) · Bollinger ' + (bollPos*100).toFixed(0) + '% (bande basse) · MA20 au-dessus du prix (cible mean reversion possible) · prix ne fait plus de plus bas (dérivée 3j ' + (recentTrend3*100).toFixed(1) + '%).',
        rationale: 'Couple RSI<30 + bande basse Bollinger + MA20 au-dessus + plus de continuation baissière = setup contrarian classique. Stop 1.5 ATR sous l\'entrée pour absorber la volatilité de survente. TP1 = retour à la MA20 (mean reversion). TP2 = +3 ATR.',
        direction: 'long',
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Setup 2 : PULLBACK HAUSSIER (long trend-follow, swing court)
  // Conditions : MA20>MA50 + prix>=MA50 + RSI 38-60 + MACD>0 + ADX>20 + mom 10j>0
  // ─────────────────────────────────────────────────────────────────
  if (ma20 != null && ma50 != null && ma20 > ma50 && last >= ma50
      && rsi != null && rsi >= 38 && rsi <= 60
      && macdH != null && macdH > 0
      && adx > 20
      && mom != null && mom > 0) {
    const entry = last;
    const stop = Math.min(entry - 1.5 * atr, ma50 * 0.985);
    const tp1 = entry + 1.5 * atr;
    const tp2 = entry + 3 * atr;
    const lvl = validateLong(entry, stop, tp1, tp2);
    if (lvl) {
      const conf = (adx > 28 && macdH > 0) ? 'very-high' : 'high';
      return Object.assign({}, lvl, {
        type: 'pullback-haussier',
        label: 'Pullback dans une tendance haussière confirmée',
        timeframe: 'Swing · 1-2 semaines',
        confidence: conf,
        config: 'MA20>MA50 (tendance MT) · prix>=MA50 · RSI ' + rsi.toFixed(0) + ' (neutre) · MACD ' + macdH.toFixed(2) + ' (>0) · ADX ' + adx.toFixed(0) + ' (forte tendance) · momentum +' + mom.toFixed(1) + '%.',
        rationale: '5 confirmations alignées : tendance MT (MA), prix au-dessus du support MA50, RSI neutre (pas surchauffé), MACD positif, ADX fort. Le pullback dans cette config se résout généralement par une continuation haussière.',
        direction: 'long',
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Setup 3 : BREAKOUT HAUSSIER (long trend follow, après compression)
  // Conditions : RSI 55-70 + Boll>0.85 + ATR<4% + ADX>22 + MA20>MA50 + macd>0
  // ─────────────────────────────────────────────────────────────────
  if (rsi != null && rsi >= 55 && rsi <= 70
      && bollPos != null && bollPos > 0.85
      && ind.atr && ind.atr.value < 4
      && adx > 22
      && ma20 != null && ma50 != null && ma20 > ma50
      && macdH != null && macdH > 0) {
    const entry = last;
    const stop = entry - 2 * atr;
    const tp1 = entry + 2 * atr;
    const tp2 = entry + 4 * atr;
    const lvl = validateLong(entry, stop, tp1, tp2);
    if (lvl) {
      return Object.assign({}, lvl, {
        type: 'breakout-haussier',
        label: 'Cassure haussière sur volatilité contractée',
        timeframe: 'Trend follow · 2-4 semaines',
        confidence: adx > 30 ? 'very-high' : 'high',
        config: 'Bollinger ' + (bollPos*100).toFixed(0) + '% (bande haute) · ATR ' + ind.atr.value.toFixed(1) + '% (compression) · ADX ' + adx.toFixed(0) + ' (force confirmée) · MA20>MA50 · MACD>0.',
        rationale: 'Après une phase de compression (ATR bas), la cassure de la bande haute avec ADX>22 et MACD>0 marque souvent le début d\'une nouvelle phase directionnelle. Stop 2 ATR sous l\'entrée pour absorber les faux signaux.',
        direction: 'long',
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Setup 4 : CONTINUATION HAUSSIÈRE (long trend follow)
  // v2.81 — Filtres resserrés post-backtest : ADX 16→22, mom 1→1.5
  // (validé sur 720 trades de backtest)
  // Conditions : MA20>MA50 + prix>MA20 + RSI 50-68 + mom>1.5% + ADX>22 + MACD>0
  // ─────────────────────────────────────────────────────────────────
  if (ma20 != null && ma50 != null && ma20 > ma50 && last > ma20
      && rsi != null && rsi >= 50 && rsi <= 68
      && mom != null && mom > 1.5
      && adx > 22
      && macdH != null && macdH > 0) {
    const entry = last;
    const stop = Math.min(entry - 1.8 * atr, ma20 * 0.985);
    const tp1 = entry + 2 * atr;
    const tp2 = entry + 4 * atr;
    const lvl = validateLong(entry, stop, tp1, tp2);
    if (lvl) {
      return Object.assign({}, lvl, {
        type: 'continuation-haussiere',
        label: 'Continuation dans le mouvement haussier',
        timeframe: 'Swing · 1-3 semaines',
        confidence: 'medium',
        config: 'MA20>MA50 · prix>MA20 · RSI ' + rsi.toFixed(0) + ' (sain) · momentum +' + mom.toFixed(1) + '% · ADX ' + adx.toFixed(0) + ' · MACD>0.',
        rationale: 'Tendance haussière confirmée par 5 indicateurs alignés. Le marché monte sans être encore en surchauffe, le momentum positif et l\'ADX > 16 indiquent une dynamique acheteuse durable.',
        direction: 'long',
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Setup 5 : REBOND MA50 (long mean reversion swing)
  // v2.81 — Filtres resserrés post-backtest : ADX 14→20, MACD>=0 → >0
  // Conditions : MA20>MA50 + prix entre ±1.5 % de MA50 + RSI 40-55 + ADX>20 + MACD>0
  // ─────────────────────────────────────────────────────────────────
  if (ma20 != null && ma50 != null && ma20 > ma50
      && rsi != null && rsi >= 40 && rsi <= 55
      && last <= ma50 * 1.015 && last >= ma50 * 0.985
      && adx > 20
      && macdH != null && macdH > 0) {
    const entry = last;
    const stop = Math.min(entry - 1.5 * atr, ma50 * 0.97);
    const tp1 = entry + 1.5 * atr;
    const tp2 = Math.max(ma20, entry + 3 * atr);
    const lvl = validateLong(entry, stop, tp1, tp2);
    if (lvl) {
      return Object.assign({}, lvl, {
        type: 'rebond-ma50',
        label: 'Rebond technique sur la MA50',
        timeframe: 'Swing · 1-2 semaines',
        confidence: 'medium',
        config: 'Prix à ±1.5 % de MA50 (' + ma50.toFixed(2) + ') · MA20>MA50 (tendance préservée) · RSI ' + rsi.toFixed(0) + ' · ADX ' + adx.toFixed(0) + ' · MACD ' + macdH.toFixed(2) + '.',
        rationale: 'La MA50 est un support dynamique majeur en tendance haussière. Quand le prix la teste précisément sans la casser et que le MACD reste positif, c\'est une zone d\'entrée historiquement favorable.',
        direction: 'long',
      });
    }
  }

  // v2.69 — DOJI haussier : Doji après bougie rouge + confirmation bougie verte
  // Le marché a baissé, hésité (doji = combat), puis les acheteurs ont gagné
  // Entry = close confirmation · Stop = bas de la bougie rouge · Exit = Doji baissier suivant
  const doji = detectDoji(prices, atr);
  if (doji && doji.direction === 'long') {
    const entry = last;
    const stop = doji.stopLevel; // plus bas de la bougie rouge
    if (stop < entry) {
      // TP basé sur l'amplitude moyenne du mouvement (3 ATR conservateur, sortie réelle au prochain Doji baissier)
      const tp1 = entry + 2 * atr;
      const tp2 = entry + 4 * atr;
      const risk = entry - stop;
      const reward = tp2 - entry;
      if (reward / risk >= 1.8) {
        return {
          type: 'doji-haussier',
          label: 'Doji — Retournement haussier',
          timeframe: 'Swing · 3-10 jours (sortie sur Doji inverse)',
          confidence: 'high',
          config: 'Doji détecté après bougie rouge (' + doji.redCandlePct + '%) puis bougie verte de confirmation (+' + doji.greenCandlePct + '%). Combat acheteurs/vendeurs résolu côté acheteur.',
          rationale: 'Stratégie Heikin Ashi adaptée : après une chute, un doji marque une hésitation (combat acheteur/vendeur). La bougie verte qui suit confirme que les acheteurs ont gagné. Stop technique au plus bas de la bougie rouge. Sortie discrétionnaire au prochain Doji baissier (doji après bougie verte).',
          direction: 'long',
          entry, stop, tp1, tp2,
          rr1: ((tp1 - entry) / risk).toFixed(2),
          rr2: ((tp2 - entry) / risk).toFixed(2),
        };
      }
    }
  }
  if (doji && doji.direction === 'short') {
    const entry = last;
    const stop = doji.stopLevel;
    if (stop > entry) {
      const tp1 = entry - 2 * atr;
      const tp2 = entry - 4 * atr;
      const risk = stop - entry;
      const reward = entry - tp2;
      if (reward / risk >= 1.8) {
        return {
          type: 'doji-baissier',
          label: 'Doji — Retournement baissier',
          timeframe: 'Swing · 3-10 jours (sortie sur Doji inverse)',
          confidence: 'high',
          config: 'Doji après bougie verte (+' + doji.greenCandlePct + '%) puis bougie rouge de confirmation (' + doji.redCandlePct + '%). Vendeurs ont pris le contrôle.',
          rationale: 'Inverse du Doji haussier : après une hausse, un doji marque l\'épuisement des acheteurs. La bougie rouge confirme. Stop au plus haut de la bougie verte. Pour les comptes qui shortent — sinon, signal "sors de ton long".',
          direction: 'short',
          entry, stop, tp1, tp2,
          rr1: ((entry - tp1) / risk).toFixed(2),
          rr2: (reward / risk).toFixed(2),
        };
      }
    }
  }

  // Aucun setup propre détecté — on ne fabrique PAS un setup faible
  return null;
}

/**
 * v2.69 — Détection DOJI (doji-reversal du formateur IVT Live Trading)
 * v2.73 — Avec confirmations IVT COMPLÈTES : Ichimoku ascendant + MA7 ascendante
 *
 * Doji haussier  : bougie ROUGE → DOJI → bougie VERTE (confirmation)
 * Doji baissier  : bougie VERTE → DOJI → bougie ROUGE (confirmation)
 *
 * Note : on travaille sur close-only, donc :
 *   - "bougie rouge" = close[t] < close[t-1] de plus de 0.5%
 *   - "doji"         = |close[t] - close[t-1]| / close[t-1] < 0.3%
 *   - "bougie verte" = close[t] > close[t-1] de plus de 0.5%
 *
 * v2.73 — Le setup "IVT complet" exige EN PLUS :
 *   - Ichimoku cloud ASCENDANT (cloud direction up)
 *   - MA7 ASCENDANTE (slope up)
 *
 * Si ces 2 confirmations sont là → confidence very-high
 * Sinon → setup détecté mais confidence medium (à l'utilisateur de décider)
 *
 * Stop = close de la bougie rouge (approximation du low en mode close-only)
 */
/**
 * v3.1 — Détection du régime de marché par actif (bull/bear/sideways)
 *
 * Filtre supplémentaire crucial pour éviter d'acheter le dip dans un
 * marché en bear (= attraper un couteau qui tombe). Le walk-forward
 * v2.97 a montré que cette absence de filtre coûtait du PF en OOS.
 *
 *   BULL    : prix > SMA200 ET slope SMA200 sur 20j > +0.5%
 *   BEAR    : prix < SMA200 ET slope SMA200 sur 20j < -0.5%
 *   SIDEWAYS: tout le reste (range, transition, indécis)
 */
function detectMarketRegime(prices) {
  if (!prices || prices.length < 220) return 'unknown';
  const last = prices[prices.length - 1];
  const sma200_now = sma(prices, 200);
  if (sma200_now == null) return 'unknown';
  const prices_20ago = prices.slice(0, prices.length - 20);
  if (prices_20ago.length < 200) return 'unknown';
  const sma200_20ago = sma(prices_20ago, 200);
  if (sma200_20ago == null) return 'unknown';
  const slopePct = ((sma200_now - sma200_20ago) / sma200_20ago) * 100;
  if (last > sma200_now && slopePct > 0.5) return 'bull';
  if (last < sma200_now && slopePct < -0.5) return 'bear';
  return 'sideways';
}

function detectDoji(prices, atr) {
  if (!prices || prices.length < 5) return null;
  const N = prices.length;
  const c1 = prices[N - 1]; // dernière bougie (confirmation)
  const c2 = prices[N - 2]; // doji (Doji)
  const c3 = prices[N - 3]; // bougie rouge ou verte (contexte)
  const c4 = prices[N - 4]; // référence
  const DOJI_TH = 0.003;    // 0.3%
  const BODY_TH = 0.005;    // 0.5%

  const move = (a, b) => (a - b) / b;
  const dojiMove = Math.abs(move(c2, c3));
  const confirmMove = move(c1, c2);
  const contextMove = move(c3, c4);

  // v2.73 — Vérification confirmations IVT (MA7 + Ichimoku ascendants)
  const ma7Info = ma7(prices);
  const ichiDir = ichimokuDirection(prices);
  const ma7Up = ma7Info && ma7Info.slope === 'up';
  const ma7Down = ma7Info && ma7Info.slope === 'down';
  const cloudUp = ichiDir && ichiDir.direction === 'up' && ichiDir.tenkanAboveKijun;
  const cloudDown = ichiDir && ichiDir.direction === 'down' && !ichiDir.tenkanAboveKijun;

  // Doji haussier
  if (contextMove < -BODY_TH && dojiMove < DOJI_TH && confirmMove > BODY_TH) {
    const ivtComplete = ma7Up && cloudUp;
    return {
      direction: 'long',
      dojiPrice: c2,
      redCandlePct: (contextMove * 100).toFixed(1),
      greenCandlePct: (confirmMove * 100).toFixed(1),
      stopLevel: Math.min(c3, c4) * 0.998,
      // v2.73 — Nouvelles infos méthodo IVT
      ivtComplete,
      ma7Trend: ma7Info ? ma7Info.slope : null,
      cloudTrend: ichiDir ? ichiDir.direction : null,
      cloudBullish: cloudUp,
    };
  }
  // Doji baissier
  if (contextMove > BODY_TH && dojiMove < DOJI_TH && confirmMove < -BODY_TH) {
    const ivtCompleteShort = ma7Down && cloudDown;
    return {
      direction: 'short',
      dojiPrice: c2,
      greenCandlePct: (contextMove * 100).toFixed(1),
      redCandlePct: (confirmMove * 100).toFixed(1),
      stopLevel: Math.max(c3, c4) * 1.002,
      ivtComplete: ivtCompleteShort,
      ma7Trend: ma7Info ? ma7Info.slope : null,
      cloudTrend: ichiDir ? ichiDir.direction : null,
      cloudBearish: cloudDown,
    };
  }
  return null;
}

/**
 * v2.68 — Détection AGRESSIVE dédiée à KAIRO (Le Chasseur)
 * Critères plus laxistes : on cherche les rebonds extrêmes, les momentums
 * vifs, et les zones de retournement potentielles que les autres agents
 * écarteraient. KAIRO trouve TOUJOURS quelque chose à chasser.
 */
function detectAggressiveSetup(a) {
  if (!a || !a.indRaw || !a.atrAbs) return null;
  const ind = a.indRaw;
  const prices = a.prices;
  const last = prices[prices.length - 1];
  const atr = a.atrAbs;
  const rsi = ind.rsi?.value;
  const ma20 = ind.ma20?.value;
  const ma50 = ind.ma50?.value;

  function validate(entry, stop, tp1, tp2) {
    if (stop >= entry) return null;
    if (tp1 <= entry) return null;
    if (tp2 <= tp1) return null;
    const risk = entry - stop;
    const reward = tp2 - entry;
    if (reward / risk < 2.0) return null;
    return { entry, stop, tp1, tp2,
      rr1: ((tp1 - entry) / risk).toFixed(2),
      rr2: ((tp2 - entry) / risk).toFixed(2) };
  }

  // 1) Rebond contrarien sur RSI < 35 (au lieu de 30 strict)
  if (rsi != null && rsi < 35 && ma50 != null && last > ma50 * 0.88) {
    const entry = last;
    const stop = entry - 2 * atr;
    const tp1 = ma20 && ma20 > entry ? ma20 : entry + 2 * atr;
    const tp2 = entry + 5 * atr;
    const v = validate(entry, stop, tp1, tp2);
    if (v) return Object.assign({}, v, {
      type: 'kairo-contrarien',
      label: 'Rebond contrarien agressif',
      timeframe: 'Court terme · 2-5 jours',
      confidence: rsi < 28 ? 'high' : 'medium',
      config: 'RSI ' + rsi.toFixed(0) + ' (zone faible) · prix au-dessus de la MA50 dégradée (' + ma50.toFixed(2) + '). KAIRO chasse le rebond avant que les autres voient venir.',
      rationale: 'Pari contrarien : RSI bas + actif proche d\'un support clé. Plus risqué que les setups conventionnels mais potentiel de gain x2 ATR si le rebond se matérialise. À surveiller serré, le marché peut continuer sa baisse.',
      direction: 'long',
    });
  }

  // 2) Momentum vif récent : +5% sur 5 jours
  if (prices.length >= 6) {
    const p5 = prices.slice(-6);
    const surge = (p5[5] - p5[0]) / p5[0];
    if (surge > 0.05 && rsi != null && rsi < 78) {
      const entry = last;
      const stop = entry - 2.2 * atr;
      const tp1 = entry + 2 * atr;
      const tp2 = entry + 4.5 * atr;
      const v = validate(entry, stop, tp1, tp2);
      if (v) return Object.assign({}, v, {
        type: 'kairo-momentum',
        label: 'Momentum vif — saute dedans',
        timeframe: 'Court terme · 1-3 jours',
        confidence: 'medium',
        config: 'Surge +' + (surge * 100).toFixed(1) + '% sur 5 jours + RSI ' + rsi.toFixed(0) + '. KAIRO entre dans un mouvement déjà engagé en pariant sur sa continuation.',
        rationale: 'Stratégie momentum : on saute dans un mouvement vif en pariant sur sa continuation à court terme. Risque : retournement violent si le momentum casse. Stop large à 2.2 ATR.',
        direction: 'long',
      });
    }
    // Inverse : crash de -5% sur 5 jours = court bearish
    if (surge < -0.05 && rsi != null && rsi > 22) {
      const entry = last;
      const stop = entry + 2.2 * atr;
      const tp1 = entry - 2 * atr;
      const tp2 = entry - 4.5 * atr;
      const reward = entry - tp2;
      const risk = stop - entry;
      if (risk > 0 && reward / risk >= 2.0) {
        return {
          type: 'kairo-shortMomentum',
          label: 'Crash vif — short tactique',
          timeframe: 'Court terme · 1-3 jours',
          confidence: 'medium',
          config: 'Plongeon ' + (surge * 100).toFixed(1) + '% sur 5 jours. KAIRO joue la continuation baissière. Réservé aux brokers qui supportent le short.',
          rationale: 'Stratégie momentum baissier : on suit le mouvement déjà engagé. Pour les traders qui savent shorter (ou crypto via futures). Sinon : éviter d\'acheter ici et attendre stabilisation.',
          direction: 'short',
          entry, stop, tp1, tp2,
          rr1: ((entry - tp1) / risk).toFixed(2),
          rr2: (reward / risk).toFixed(2),
        };
      }
    }
  }

  // 3) Squeeze de volatilité : ATR très bas + Bollinger compressé → cassure proche
  if (ind.atr && ind.atr.value < 1.5 && ind.boll && ind.boll.value > 0.3 && ind.boll.value < 0.7) {
    const entry = last;
    const stop = entry - 2.5 * atr;
    const tp1 = entry + 2 * atr;
    const tp2 = entry + 5 * atr;
    const v = validate(entry, stop, tp1, tp2);
    if (v) return Object.assign({}, v, {
      type: 'kairo-squeeze',
      label: 'Volatilité comprimée — cassure proche',
      timeframe: 'Court terme · 3-7 jours',
      confidence: 'medium',
      config: 'ATR ' + ind.atr.value.toFixed(2) + '% (très bas) + prix au milieu de Bollinger. KAIRO anticipe une explosion de volatilité.',
      rationale: 'Théorie : la volatilité finit toujours par revenir. Quand l\'ATR est anormalement bas, une cassure directionnelle se prépare. La direction n\'est pas garantie, mais on positionne un long si la tendance MT est haussière (MA20>MA50).',
      direction: 'long',
    });
  }

  return null;
}

function priceFmt(p, kind) {
  if (p == null) return '—';
  if (p >= 10000) return Math.round(p).toLocaleString('fr-FR');
  if (p >= 100) return p.toFixed(0);
  if (p >= 1) return p.toFixed(2);
  return p.toFixed(4);
}

// v2.60 — Mixe les actifs en piochant dans chaque catégorie (indices, crypto,
// actions, forex, métaux). Garantit que le summary IA mentionne tous les univers.
function pickMixed(assets, nIdx = 2, nCrypto = 2, nAction = 2, nForex = 1, nMetal = 1) {
  const byKind = (k) => assets.filter(a => a.kind === k);
  const out = [
    ...byKind('index').slice(0, nIdx),
    ...byKind('crypto').slice(0, nCrypto),
    ...byKind('action').slice(0, nAction),
    ...byKind('forex').slice(0, nForex),
    ...byKind('metal').slice(0, nMetal),
  ];
  const target = nIdx + nCrypto + nAction + nForex + nMetal;
  if (out.length < target) {
    for (const a of assets) {
      if (!out.includes(a)) out.push(a);
      if (out.length >= target) break;
    }
  }
  return out;
}

function buildPrompt(assets) {
  // v2.49 — tableau complet pour le LLM (il a besoin de la vue d'ensemble)
  const table = assets
    .map((a) => `${a.label} [${a.kind}]: prix ${a.price?.toFixed(2)} (${a.change}%) · RSI ${a.rsi} · MA ${a.maCross} · MACD histo ${a.macdHist} · Bollinger ${a.boll} · ADX ${a.adx} · ATR ${a.atr} → verdict ${a.verdict} (${a.score}/100)`)
    .join('\n');

  return `Tu es analyste technique pour une app pédagogique de bourse (Trade Genius). Tu écris en français pour des débutants/intermédiaires.

CONTEXTE — données techniques d'aujourd'hui (indices + crypto + actions) :
${table}

CONSIGNES :
1. Écris une analyse pédagogique synthétique (max 200 mots) qui présente la situation technique générale.
2. Ne dis JAMAIS "achète", "vends", "il faut" — c'est interdit (cadre légal AMF français).
3. Utilise plutôt : "on observe", "schéma classique", "un trader expérimenté surveillerait", "à considérer".
4. **OBLIGATOIRE** : mentionne au moins 1 indice, 1 crypto et 1 action dans le summary (mix des 3 univers).
5. Termine par une mini-section "ce que regarderait un trader" avec 3 points concrets.

Réponds EN JSON STRICT avec cette structure :
{
  "title": "Titre court accrocheur, max 60 caractères",
  "summary": "Analyse pédagogique 150-200 mots, prose fluide",
  "observations": ["obs 1 court", "obs 2", "obs 3", "obs 4"],
  "plan_pedago": ["point 1", "point 2", "point 3"]
}

Ne mets RIEN avant ou après le JSON. Pas de balise markdown.`;
}

async function callPollinations(prompt) {
  console.log('Calling Pollinations.ai…');
  const r = await fetch('https://text.pollinations.ai/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      model: 'openai',
      jsonMode: true,
      seed: Math.floor(Date.now() / (24 * 60 * 60 * 1000)), // déterministe par jour
    }),
  });
  if (!r.ok) throw new Error(`Pollinations HTTP ${r.status}`);
  const text = await r.text();
  return text;
}

async function callGroq(prompt, key) {
  console.log('Calling Groq (llama-3.3-70b-versatile)…');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.5,
      max_tokens: 800,
    }),
  });
  if (!r.ok) throw new Error(`Groq HTTP ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content || '';
}

function parseAIResponse(raw) {
  // Cleanup : enlève balises markdown si l'IA en a mis quand même
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  // Trouve le 1er { et le dernier }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in IA response');
  s = s.slice(start, end + 1);
  return JSON.parse(s);
}

function buildFallbackStudy(valid) {
  // Si l'IA échoue : on génère du contenu pédago par template à partir des
  // vraies données techniques. Pas aussi varié qu'une IA, mais utile et stable.
  const bullN = valid.filter(a => a.cls === 'bull').length;
  const bearN = valid.filter(a => a.cls === 'bear').length;
  let title;
  if (bullN >= 4) title = 'Marchés bien orientés sur les majeurs';
  else if (bearN >= 4) title = 'Marchés sous pression — biais vendeur';
  else if (bullN > bearN) title = 'Marchés mitigés, biais haussier modéré';
  else if (bearN > bullN) title = 'Marchés mitigés, biais baissier modéré';
  else title = 'Marchés sans direction nette';

  // v2.49 — Pick un mix indices + crypto + actions au lieu des 5 premiers
  const mixHead = pickMixed(valid, 2, 2, 1); // 2 idx + 2 crypto + 1 action
  const head = mixHead.slice(0, 5).map(a =>
    `${a.label} ${a.change > 0 ? '+' : ''}${a.change}% (RSI ${a.rsi}, ${a.verdict.toLowerCase()})`
  ).join(' · ');

  const idxN = valid.filter(a => a.kind === 'index').length;
  const cryN = valid.filter(a => a.kind === 'crypto').length;
  const actN = valid.filter(a => a.kind === 'action').length;

  const summary = `Tour d'horizon multi-univers (${idxN} indices · ${cryN} crypto · ${actN} actions) : ${head}. ` +
    `Globalement, ${bullN} actifs en biais haussier contre ${bearN} en baissier. ` +
    `On observe une configuration ${bullN > bearN ? 'plutôt favorable aux acheteurs' : bearN > bullN ? 'plutôt favorable aux vendeurs' : 'partagée sans direction claire'}. ` +
    `Un trader expérimenté surveillerait surtout les zones de surachat (RSI > 70) ou de survente (RSI < 30) pour timer une entrée, ainsi que la position du prix par rapport à la MA50 pour situer la tendance moyen terme.`;

  // v2.49 — Observations mixées aussi (1 par catégorie minimum)
  const obsAssets = pickMixed(valid, 2, 2, 1);
  const observations = obsAssets.slice(0, 5).map(a => {
    if (a.cls === 'bull') return `${a.label} : tendance haussière confirmée (RSI ${a.rsi}, ${a.maCross} MA50)`;
    if (a.cls === 'bear') return `${a.label} : pression vendeuse persistante (RSI ${a.rsi})`;
    return `${a.label} : sans direction nette (RSI ${a.rsi})`;
  });

  return {
    title,
    summary,
    observations,
    plan_pedago: [
      'Vérifier la position du prix par rapport à la MA50 pour identifier la tendance moyen terme',
      'Surveiller les croisements MACD pour confirmer un changement de momentum',
      'Calculer la taille de position pour ne pas risquer plus de 1-2% du capital',
      'Définir stop loss et take profit AVANT d\'entrer sur le marché',
    ],
  };
}

async function generateStudy(prompt, valid) {
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try { return parseAIResponse(await callGroq(prompt, groqKey)); }
    catch (e) { console.warn('Groq failed, fallback Pollinations:', e.message); }
  }
  try { return parseAIResponse(await callPollinations(prompt)); }
  catch (e) {
    console.warn('Pollinations failed, fallback template:', e.message);
    return buildFallbackStudy(valid);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   v2.70 — MÉTHODOLOGIES PRIVÉES PAR AGENT
   ───────────────────────────────────────────────────────────────────
   Chaque agent applique SA propre logique de détection avec SES outils
   privilégiés. Aucune information sur les outils utilisés n'est exposée
   dans le JSON public — c'est la marque de fabrique Trade Genius.
   Seul le résultat (setup) est partagé avec l'utilisateur.
   ═══════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════
   v2.96 — DÉTECTEURS GRID-OPTIMAL post walk-forward validation
   ═══════════════════════════════════════════════════════════════════
   2 patterns mathématiquement gagnants découverts par grid-search 49k
   combos + walk-forward 70/30 (decay négatif ou < 5% pour les 3 IA) :

   PATTERN A — CONTRARIAN FOND
     RSI < 25  ·  Boll position < 25%  ·  MACD histogramme < 0
     (le filtre MA bull est OPTIONNEL — le walk-forward montre que ma=any
      donne 3× plus de trades avec OOS PF identique pour MONTH)
     stop = entry - 1.0 × ATR
     tp2  = entry + N × ATR  (4j / 5j / 7j selon fenêtre)

   PATTERN B — TREND-FOLLOW CORRECTION (NEW v2.96)
     RSI > 35  ·  ADX >= 30  ·  Boll mid (0.25-0.75)  ·  MACD < 0
     "Acheter pendant la correction d'une forte tendance établie"
     stop = entry - 1.0 × ATR
     tp2  = entry + 7 × ATR  (h=30j ou 60j)

   Stats walk-forward validées (IS 70% / OOS 30% sur 20 ans) :
     PATTERN A MONTH (ma=any) : 7103t IS / 2882t OOS · PF 2.75 → 3.42
     PATTERN B          (h60) : 1804t IS /  747t OOS · PF 2.70 → 3.42

   FIX CRITIQUE v2.96 : le filtre MACD < 0 manquait dans v2.93,
   alors que le combo testé en grid l'incluait. Désormais aligné.
   ═══════════════════════════════════════════════════════════════════ */

// ─────────────────────────────────────────────────────────────────────
// v7.9 — FILTRES DE PRÉCISION (Tier 1)
// ─────────────────────────────────────────────────────────────────────
// 3 filtres ajoutés à TOUS les patterns pour réduire le bruit :
//   1. Cohérence multi-TF : tendance court terme ne doit pas contredire LT
//   2. Liquidité minimum : skip si dollar volume moyen 20j < seuil
//   3. ATR minimum : skip si volatilité insuffisante pour atteindre TP
// ─────────────────────────────────────────────────────────────────────

// Détecte la tendance COURT TERME (SMA20 slope sur 10 derniers jours)
// Retourne 'bull' / 'sideways' / 'bear' / 'unknown'
function _detectShortTermTrend(prices) {
  if (!Array.isArray(prices) || prices.length < 30) return 'unknown';
  const ma20Now = sma(prices.slice(-20), 20);
  const ma20Ago = sma(prices.slice(-30, -10), 20);
  if (ma20Now == null || ma20Ago == null || ma20Ago === 0) return 'unknown';
  const slope = (ma20Now - ma20Ago) / ma20Ago;
  if (slope > 0.015) return 'bull';      // SMA20 +1.5% sur 10j
  if (slope < -0.015) return 'bear';     // SMA20 -1.5% sur 10j
  return 'sideways';
}

// FILTRE COHÉRENCE MULTI-TF
// Pour un signal LONG :
//   - Si régime LT bull + tendance CT bear : DIVERGENCE → soit signal early reversal soit faux signal
//     → on accepte si Pattern A (contrarian) mais on rejette si B/C (trend-follow)
//   - Si régime LT sideways + tendance CT bear : faux signal → rejette tout
//   - Sinon : OK
function _checkMultiTfCoherence(prices, regime, patternType) {
  const stTrend = _detectShortTermTrend(prices);
  if (regime === 'sideways' && stTrend === 'bear') {
    return { ok: false, reason: 'Régime sideways + CT bear = pas de momentum acheteur' };
  }
  if (regime === 'bull' && stTrend === 'bear' && patternType !== 'A') {
    // Pattern A contrarian peut accepter cette config (achat dip dans bull MT)
    // Mais Pattern B/C trend-follow refusent : on attend que CT confirme le LT
    return { ok: false, reason: 'Divergence régime LT bull / CT bear (trend-follow rejette)' };
  }
  return { ok: true, st_trend: stTrend };
}

// FILTRE LIQUIDITÉ : dollar volume moyen 20 derniers jours
// Seuils par classe (en USD) :
//   - action : $10M/jour (large caps US, blue chips EU OK ; micro-caps OUT)
//   - crypto : $5M/jour (top 50 crypto OK ; memecoins/illiquides OUT)
//   - forex/metal/index : pas de filtre (toujours liquides)
const LIQUIDITY_MIN_USD = { action: 10_000_000, crypto: 5_000_000 };
function _checkLiquidity(asset) {
  const kind = asset.kind;
  const minUsd = LIQUIDITY_MIN_USD[kind];
  if (!minUsd) return { ok: true };  // pas de filtre pour forex/metal/index
  if (!Array.isArray(asset.volumes) || asset.volumes.length < 20) {
    return { ok: true };  // donnée volume indispo → on accepte (fallback safe)
  }
  const prices = asset.prices.slice(-20);
  const volumes = asset.volumes.slice(-20);
  let sumDV = 0, validCount = 0;
  for (let i = 0; i < prices.length; i++) {
    if (prices[i] != null && volumes[i] != null && volumes[i] > 0) {
      sumDV += prices[i] * volumes[i];
      validCount++;
    }
  }
  if (validCount < 10) return { ok: true };  // pas assez de data → safe pass
  const avgDV = sumDV / validCount;
  if (avgDV < minUsd) {
    return { ok: false, reason: 'Liquidité insuffisante ($' + (avgDV / 1e6).toFixed(1) + 'M/j vs $' + (minUsd / 1e6) + 'M requis)' };
  }
  return { ok: true, avg_dollar_volume: avgDV };
}

// FILTRE ATR MINIMUM : volatilité suffisante pour que le TP soit significatif
// Si ATR % du prix < 0.5%, alors TP 5×ATR = 2.5% de gain → frais broker mangent
// Seuil : ATR ≥ 0.5% (généreux, exclut juste les ultra-calmes)
function _checkAtrMin(atrPctValue) {
  if (atrPctValue == null || atrPctValue < 0.5) {
    return { ok: false, reason: 'ATR ' + (atrPctValue || 0).toFixed(2) + '% trop bas (frais broker > gain potentiel)' };
  }
  return { ok: true };
}

// PATTERN A — Contrarian fond (RSI bas + Boll low + MACD négatif)
// v3.1 — Ajout filtre régime de marché
// v7.9 — Filtres précision : multi-TF + liquidité + ATR min
function _detectGridContrarian(asset, params) {
  const ind = asset.indRaw;
  const prices = asset.prices;
  if (!ind || !prices || prices.length < 30) return null;
  const rsi = ind.rsi?.value;
  const ma20 = ind.ma20?.value;
  const ma50 = ind.maCross?.ma50;
  const boll = ind.boll?.value;
  const macdH = ind.macd?.value;
  // Conditions exactes du grid (post walk-forward) :
  if (rsi == null || rsi >= (params.rsiMax || 25)) return null;
  if (boll == null || boll >= 0.25) return null;
  if (macdH == null || macdH >= 0) return null;          // v2.96 FIX : MACD<0 (manquait)
  if (params.requireMaBull) {                              // v2.96 : optionnel (WEEK/DAY) vs facultatif (MONTH)
    if (!ma20 || !ma50 || ma20 <= ma50) return null;
  }
  // v3.1 — FILTRE RÉGIME : refuser si bear market (signal contrarian ↔ acheter
  // un dip dans un bear market = catastrophe sur 5+ années de bear séculaire)
  const regime = detectMarketRegime(prices);
  if (regime === 'bear') return null;
  // v4.1 — FILTRE VOLUME : si MFI > 70 sur RSI<25, c'est un rebond fictif
  // (le RSI dit "oversold" mais le money flow ne suit pas → distribution
  // déguisée en accumulation). Statistiquement les pires entrées contrarian.
  const mfiVal = ind.mfi?.value;
  if (mfiVal != null && mfiVal > 70) return null;
  // v7.9 — FILTRES PRÉCISION
  const mtfCheck = _checkMultiTfCoherence(prices, regime, 'A');
  if (!mtfCheck.ok) return null;
  const liqCheck = _checkLiquidity(asset);
  if (!liqCheck.ok) return null;
  const atrCheck = _checkAtrMin(ind.atr?.value);
  if (!atrCheck.ok) return null;
  const last = prices[prices.length - 1];
  const atr = asset.atrAbs;
  if (!atr) return null;
  const entry = last;
  const stop = entry - params.atrStop * atr;
  const tp1 = entry + (params.atrTp2 * 0.5) * atr;
  const tp2 = entry + params.atrTp2 * atr;
  if (stop >= entry || tp1 <= entry || tp2 <= tp1) return null;
  const risk = entry - stop;
  if ((tp2 - entry) / risk < 1.5) return null;
  return {
    type: params.type, label: params.label,
    timeframe: params.timeframe, confidence: 'high',
    config: 'RSI ' + rsi.toFixed(0) + ' (survente extrême) · Bollinger ' + (boll*100).toFixed(0) + '% (bande basse) · MACD ' + macdH.toFixed(2) + ' (correction confirmée)' + (params.requireMaBull && ma20 && ma50 ? ' · MA20>MA50 (tendance MT préservée)' : '') + (mfiVal != null ? ' · MFI ' + mfiVal.toFixed(0) + ' (flux validé)' : '') + ' · stop ' + params.atrStop + ' ATR · cible ' + params.atrTp2 + ' ATR.',
    rationale: 'Configuration contrarian validée sur 20 ans × 50 actifs (PF ' + params.expectedPF + ' walk-forward OOS). Le marché est en survente technique extrême + correction MACD confirmée. Stop technique serré, cible étendue pour capter le retournement complet.',
    direction: 'long', entry, stop, tp1, tp2,
    rr1: ((tp1 - entry) / risk).toFixed(2),
    rr2: ((tp2 - entry) / risk).toFixed(2),
    trailing_after_tp1: true, // v4.1 — Stop monte à entry quand TP1 touché
  };
}

// PATTERN C — Pullback dans tendance LT confirmée Ichimoku (v3.0, NEW)
// v3.1 — Ajout filtre régime de marché : skip en bear (anti couteau qui tombe)
// Découvert par walk-forward v2.97 sur 491 520 combos : PF OOS 5.65 (vs 3.42 max actuel)
function _detectGridPullbackTrend(asset, params) {
  const ind = asset.indRaw;
  const prices = asset.prices;
  if (!ind || !prices || prices.length < 30) return null;
  const rsi = ind.rsi?.value;
  const boll = ind.boll?.value;
  const ichi = ind.ichimoku;
  // 3 conditions exactes du combo TOP du walk-forward v2.97
  if (rsi == null || rsi <= 35) return null;
  if (boll == null || boll >= 0.25) return null;
  if (!ichi || ichi.position !== 'above-cloud' || ichi.signal !== 'bull') return null;
  // v3.1 — FILTRE RÉGIME : refuser si bear market (le pattern ne marche que
  // si la tendance LT globale est bull ou au moins sideways)
  const regime = detectMarketRegime(prices);
  if (regime === 'bear') return null;
  // v4.1 — FILTRE VOLUME : pullback dans tendance LT confirmée = on a besoin
  // que le volume confirme la continuation du trend. OBV en down ou ForceIndex
  // négatif = le smart money sort, le pullback n'est pas une opportunité.
  const obvTrend = ind.obv?.trend;
  if (obvTrend === 'down') return null;
  const forceSig = ind.forceIndex?.signal;
  if (forceSig === 'bear') return null;
  // v7.9 — FILTRES PRÉCISION (Pattern C : trend-follow strict, cohérence multi-TF cruciale)
  const mtfCheckC = _checkMultiTfCoherence(prices, regime, 'C');
  if (!mtfCheckC.ok) return null;
  const liqCheckC = _checkLiquidity(asset);
  if (!liqCheckC.ok) return null;
  const atrCheckC = _checkAtrMin(ind.atr?.value);
  if (!atrCheckC.ok) return null;
  const last = prices[prices.length - 1];
  const atr = asset.atrAbs;
  if (!atr) return null;
  const entry = last;
  const stop = entry - params.atrStop * atr;
  const tp1 = entry + (params.atrTp2 * 0.5) * atr;
  const tp2 = entry + params.atrTp2 * atr;
  if (stop >= entry || tp1 <= entry || tp2 <= tp1) return null;
  const risk = entry - stop;
  if ((tp2 - entry) / risk < 1.5) return null;
  const regimeLabel = regime === 'bull' ? 'tendance LT haussière confirmée' : (regime === 'sideways' ? 'tendance LT neutre (sideways)' : 'tendance LT non confirmée');
  return {
    type: params.type, label: params.label,
    timeframe: params.timeframe,
    // v3.1 — Confidence pondérée par le régime
    confidence: regime === 'bull' ? 'very-high' : 'high',
    regime,
    config: 'RSI ' + rsi.toFixed(0) + ' (mid-neutre) · Bollinger ' + (boll*100).toFixed(0) + '% (bande basse = retracement) · Ichimoku above-cloud · Régime ' + regime + ' (' + regimeLabel + ')' + (obvTrend ? ' · OBV ' + obvTrend + ' (volume confirme)' : '') + ' · stop ' + params.atrStop + ' ATR · cible ' + params.atrTp2 + ' ATR.',
    rationale: 'Configuration premium découverte par walk-forward 491 520 combos (PF OOS 5.65). Le prix est en pullback dans une tendance LT confirmée par 2 filtres indépendants (Ichimoku + SMA200 slope) + volume validé (OBV/ForceIndex). C\'est le "buy the dip" mathématiquement validé : on achète une correction dans un trend établi, pas un début de bear market.',
    direction: 'long', entry, stop, tp1, tp2,
    rr1: ((tp1 - entry) / risk).toFixed(2),
    rr2: ((tp2 - entry) / risk).toFixed(2),
    trailing_after_tp1: true, // v4.1 — Stop monte à entry quand TP1 touché
  };
}

// PATTERN B — Trend-follow correction (v2.96, NEW)
// v3.1 — Ajout filtre régime de marché
function _detectGridTrendFollow(asset, params) {
  const ind = asset.indRaw;
  const prices = asset.prices;
  if (!ind || !prices || prices.length < 30) return null;
  const rsi = ind.rsi?.value;
  const adx = ind.adx?.value || 0;
  const boll = ind.boll?.value;
  const macdH = ind.macd?.value;
  if (rsi == null || rsi <= (params.rsiMin || 35)) return null;
  if (adx < (params.adxMin || 30)) return null;
  if (boll == null || boll < 0.25 || boll > 0.75) return null; // mid
  if (macdH == null || macdH >= 0) return null;
  // v3.1 — FILTRE RÉGIME : la trend-follow ne fait sens que si la tendance LT
  // est dans le sens du trade (bull). En bear ou sideways, signal moins fiable.
  const regime = detectMarketRegime(prices);
  if (regime === 'bear') return null;
  // v4.1 — FILTRE VOLUME : trend-follow exige que le volume confirme la tendance.
  // OBV en down = le trend s'essouffle, on n'achète pas la correction.
  const obvTrend = ind.obv?.trend;
  if (obvTrend === 'down') return null;
  // v7.9 — FILTRES PRÉCISION (Pattern B : trend-follow strict)
  const mtfCheckB = _checkMultiTfCoherence(prices, regime, 'B');
  if (!mtfCheckB.ok) return null;
  const liqCheckB = _checkLiquidity(asset);
  if (!liqCheckB.ok) return null;
  const atrCheckB = _checkAtrMin(ind.atr?.value);
  if (!atrCheckB.ok) return null;
  const last = prices[prices.length - 1];
  const atr = asset.atrAbs;
  if (!atr) return null;
  const entry = last;
  const stop = entry - params.atrStop * atr;
  const tp1 = entry + (params.atrTp2 * 0.5) * atr;
  const tp2 = entry + params.atrTp2 * atr;
  if (stop >= entry || tp1 <= entry || tp2 <= tp1) return null;
  const risk = entry - stop;
  if ((tp2 - entry) / risk < 1.5) return null;
  return {
    type: params.type, label: params.label,
    timeframe: params.timeframe, confidence: 'high',
    config: 'RSI ' + rsi.toFixed(0) + ' (neutre+) · ADX ' + adx.toFixed(0) + ' (tendance forte) · Bollinger ' + (boll*100).toFixed(0) + '% (milieu de bande) · MACD ' + macdH.toFixed(2) + ' (correction en cours)' + (obvTrend ? ' · OBV ' + obvTrend : '') + ' · stop ' + params.atrStop + ' ATR · cible ' + params.atrTp2 + ' ATR.',
    rationale: 'Configuration trend-follow validée sur 20 ans (PF 3.42 walk-forward OOS). Une forte tendance (ADX ≥ 30) en correction courte (MACD<0, Boll mid) avec volume confirmant (OBV non-baissier) est statistiquement le meilleur point d\'entrée pour suivre le mouvement principal.',
    direction: 'long', entry, stop, tp1, tp2,
    rr1: ((tp1 - entry) / risk).toFixed(2),
    rr2: ((tp2 - entry) / risk).toFixed(2),
    trailing_after_tp1: true, // v4.1 — Stop monte à entry quand TP1 touché
  };
}

/* ═══════════════════════════════════════════════════════════════════
   v3.4 — QUALITY SCORE + POSITION SIZING
   ═══════════════════════════════════════════════════════════════════
   Score 0-100 par setup basé sur :
     - Type de pattern (statistique walk-forward + 5-fold CV)
         · Pattern A (ULTRA_ROBUSTE std 0.21) : base 70
         · Pattern C bull regime               : base 75
         · Pattern C sideways                  : base 55
         · Pattern B trend-follow              : base 60
         · Ponchy premium                      : base 85
         · Legacy fallback                     : base 50
     - Régime de marché aligné (+0/+5/+10)
     - Force de tendance ADX (+0/+5/+10)
     - R/R ratio (+0/+5/+10)
     - Confirmation volume OBV (+0/+5)

   Position sizing recommandé (% du capital) :
     - score >= 85 : 3% (high conviction)
     - score 70-84 : 2% (medium-high)
     - score 55-69 : 1% (medium)
     - score < 55  : 0.5% (low, skip recommandé)
   ═══════════════════════════════════════════════════════════════════ */
function _computeQualityScore(setup, asset) {
  if (!setup) return { score: 0, sizing_pct: 0, sizing_label: 'skip' };
  const ind = asset?.indRaw || {};
  const t = (setup.type || '').toLowerCase();

  // Base par pattern
  let base = 50;
  if (t.includes('ponchy')) base = 85;
  else if (t.includes('volt-d')) base = 82;        // v7.13 — VOLT ABC-TRIPLE (médiane +28.6%/an walk-forward)
  else if (t.includes('-c')) base = setup.regime === 'bull' ? 75 : 55;
  else if (t.includes('-a')) base = 70;            // Pattern A ULTRA_ROBUSTE
  else if (t.includes('-b')) base = 60;
  // legacy reste 50

  // Bonus régime (Pattern C l'inclut déjà mais on récompense la cohérence)
  const regime = setup.regime || (asset?.prices ? detectMarketRegime(asset.prices) : null);
  let regimeBonus = 0;
  if (regime === 'bull') regimeBonus = 10;
  else if (regime === 'sideways') regimeBonus = 5;

  // Bonus ADX (force de la tendance directionnelle)
  const adx = Number(ind.adx?.value) || 0;
  let adxBonus = 0;
  if (adx >= 35) adxBonus = 10;
  else if (adx >= 25) adxBonus = 5;

  // Bonus R/R
  const rr2 = Number(setup.rr2) || 0;
  let rrBonus = 0;
  if (rr2 >= 3) rrBonus = 10;
  else if (rr2 >= 2) rrBonus = 5;

  // Bonus OBV (confirmation volume si dispo)
  let obvBonus = 0;
  const obvSig = ind.obv?.signal || ind.obv?.trend;
  if (obvSig === 'bull' || obvSig === 'bullish' || obvSig === 'up') obvBonus = 5;

  // v4.3 — Bonus STACKING : si plusieurs patterns convergents firent sur ce
  // setup, on récompense la confluence (signal indépendant doublé = +rare et +fiable)
  let stackingBonus = 0;
  if (setup.stacked) {
    stackingBonus = setup.stacked_count >= 3 ? 20 : 15; // 3 patterns = jackpot
  }

  const score = Math.min(100, base + regimeBonus + adxBonus + rrBonus + obvBonus + stackingBonus);

  // v7.14 — VOLT sizing CAP 5% max (vs 8% v7.13) après stress walk-forward 6 folds
  // Garde-fou : réduit convexité gains/pertes → DD max validé -2.8% incl bear crypto BTC -46%
  const isVolt = t.includes('volt-');
  let sizing_pct = 0.5, sizing_label = 'low';
  if (isVolt) {
    // VOLT : 3% (base) → 4% (medium) → 5% (high) — cap 5% imposé par stress test
    if (score >= 85) { sizing_pct = 5; sizing_label = 'volt-high'; }
    else if (score >= 75) { sizing_pct = 4; sizing_label = 'volt-medium'; }
    else { sizing_pct = 3; sizing_label = 'volt-base'; }
  } else {
    // Sizing standard (autres IA conservatrices)
    if (score >= 85) { sizing_pct = 3; sizing_label = 'high'; }
    else if (score >= 70) { sizing_pct = 2; sizing_label = 'medium-high'; }
    else if (score >= 55) { sizing_pct = 1; sizing_label = 'medium'; }
  }

  return {
    score, sizing_pct, sizing_label,
    breakdown: { base, regimeBonus, adxBonus, rrBonus, obvBonus, regime },
  };
}

/**
 * v4.3 — STACKING ENSEMBLE
 * Si plusieurs patterns firent sur le même actif simultanément (typiquement
 * B + C : trend-follow correction ET pullback Ichimoku), c'est une
 * configuration RARE et STATISTIQUEMENT puissante (deux signaux indépendants
 * confirment la même thèse). On garde le setup avec la plus haute confidence
 * et on flag stacked=true → bonus quality_score +15 dans _computeQualityScore.
 *
 * Pattern A est généralement exclusif avec B/C (RSI<25 vs RSI>=35), donc le
 * stacking se concentre sur B + C dans la majorité des cas.
 */
const CONF_RANK_STACK = { 'very-high': 4, high: 3, medium: 2, low: 1 };
function _stackPatterns(hits, fallbackLegacy) {
  const valid = hits.filter(Boolean);
  if (valid.length === 0) return fallbackLegacy;
  if (valid.length === 1) return valid[0];
  const best = [...valid].sort((a, b) =>
    (CONF_RANK_STACK[b.confidence] || 0) - (CONF_RANK_STACK[a.confidence] || 0)
  )[0];
  best.stacked = true;
  best.stacked_count = valid.length;
  best.stacked_patterns = valid.map(h => h.type);
  best.confidence = 'very-high'; // upgrade auto
  best.rationale = '🔗 STACKING ' + valid.length + ' patterns convergents (' + best.stacked_patterns.join('+') + ') · ' + best.rationale;
  return best;
}

// Wrappers v3.0 → v9.2 : configs validées par walk-forward IS/OOS (v7.17) DÉPLOYÉES
// BASTION : SCALP-WIDE   (atrStop 0.6, tp2 6, timeout 45) → OOS médian +9.71%/an (DD -0.74%)
// PHÉNIX  : BASELINE     (atrStop 1.0, tp2 5, timeout 30) → OOS médian +9.37%/an (DD -0.76%)
// RAFALE  : WIDE-TP      (atrStop 0.6, tp2 5, timeout 18) → OOS médian +9.69%/an (DD -0.58%)
// Gain cumulé déploiement vs v7.16 : ~+3 pts/an (validé out-of-sample, anti-overfit)
function _detectAtlasGrid(asset) {
  // MONTH — v9.2 SCALP-WIDE (atrStop 0.6, tp2 6, timeout 45) → OOS +9.71%/an
  const c = _detectGridPullbackTrend(asset, {
    atrStop: 0.6, atrTp2: 6.0,
    type: 'grid-month-C', label: 'Pullback dans tendance LT (Ichimoku)',
    timeframe: 'Long terme · 4-12 semaines',
  });
  const a = _detectGridContrarian(asset, {
    rsiMax: 25, atrStop: 0.6, atrTp2: 6.0, requireMaBull: false,
    type: 'grid-month-A', label: 'Survente extrême + correction MACD',
    timeframe: 'Long terme · 4-12 semaines', expectedPF: '3.42',
  });
  const b = _detectGridTrendFollow(asset, {
    rsiMin: 35, adxMin: 30, atrStop: 0.6, atrTp2: 6.0,
    type: 'grid-month-B', label: 'Trend-follow correction sur tendance forte',
    timeframe: 'Long terme · 4-12 semaines', expectedPF: '3.42',
  });
  return _stackPatterns([c, a, b], _detectAtlas(asset));
}
function _detectNovaGrid(asset) {
  // WEEK — v9.2 BASELINE (atrStop 1.0, tp2 5, timeout 30) → OOS +9.37%/an
  const c = _detectGridPullbackTrend(asset, {
    atrStop: 1.0, atrTp2: 5.0,
    type: 'grid-week-C', label: 'Pullback dans tendance MT (Ichimoku)',
    timeframe: 'Swing · 1-3 semaines',
  });
  const a = _detectGridContrarian(asset, {
    rsiMax: 25, atrStop: 1.0, atrTp2: 5.0, requireMaBull: true,
    type: 'grid-week-A', label: 'Survente + tendance MT confirmée',
    timeframe: 'Swing · 1-3 semaines', expectedPF: '3.17',
  });
  const b = _detectGridTrendFollow(asset, {
    rsiMin: 35, adxMin: 30, atrStop: 1.0, atrTp2: 5.0,
    type: 'grid-week-B', label: 'Trend-follow correction swing',
    timeframe: 'Swing · 1-3 semaines', expectedPF: '3.17',
  });
  return _stackPatterns([c, a, b], _detectNova(asset));
}
function _detectKairoGrid(asset) {
  // DAY — v9.2 WIDE-TP (atrStop 0.6, tp2 5, timeout 18) → OOS +9.69%/an
  const c = _detectGridPullbackTrend(asset, {
    atrStop: 0.6, atrTp2: 5.0,
    type: 'grid-day-C', label: 'Pullback dans tendance courte (Ichimoku)',
    timeframe: 'Court terme · 3-7 jours',
  });
  const a = _detectGridContrarian(asset, {
    rsiMax: 25, atrStop: 0.6, atrTp2: 5.0, requireMaBull: true,
    type: 'grid-day-A', label: 'Rebond rapide sur survente + correction',
    timeframe: 'Court terme · 3-7 jours', expectedPF: '2.80',
  });
  const b = _detectGridTrendFollow(asset, {
    rsiMin: 35, adxMin: 30, atrStop: 0.6, atrTp2: 5.0,
    type: 'grid-day-B', label: 'Trend-follow correction CT',
    timeframe: 'Court terme · 3-7 jours', expectedPF: '2.80',
  });
  return _stackPatterns([c, a, b], _detectKairo(asset));
}

/**
 * ATLAS — Le Gardien (v2.72) — détecteur legacy (fallback du grid)
 * Focus : tendance LT prouvée + qualité du flux (volume + force directionnelle)
 * Outils privés : SMA200 + MA50 + Ichimoku + OBV + +DI/-DI + ADX + RSI sain
 *                + distance % à SMA200 (rejet si trop étiré)
 */
function _detectAtlas(asset) {
  const ind = asset.indRaw;
  const prices = asset.prices;
  if (!ind || !prices || prices.length < 60) return null;
  // v2.73 — Bonus : si Ponchy COMPLET détecté (3 confirmations alignées),
  // ATLAS accepte exceptionnellement ce signal premium même sans toutes ses conditions LT
  const ivt = detectPonchy(asset);
  if (ivt) {
    const last = prices[prices.length - 1];
    const atr = asset.atrAbs;
    const entry = last;
    const stop = Math.min(ivt.stopLevel, entry - 1.5 * atr);
    const tp1 = entry + 3 * atr;
    const tp2 = entry + 6 * atr;
    const risk = entry - stop;
    if (risk > 0 && (tp2 - entry) / risk >= 2.5) {
      return {
        type: 'atlas-ponchy',
        label: 'Ponchy premium — 3 confirmations',
        timeframe: 'Swing+ · 2-5 semaines',
        confidence: 'very-high',
        config: 'Triple confluence IVT : Doji haussier + Ichimoku cloud ascendant + MA7 ascendante.',
        rationale: 'Le Gardien valide exceptionnellement ce signal court terme parce que les 3 confirmations structurelles sont alignées (ce qui est rare). Stop au plus bas de la bougie rouge. Cible étendue à +6 ATR pour capter les meilleurs mouvements. Sortie discrétionnaire sur le prochain Doji baissier OU rupture de MA20.',
        direction: 'long', entry, stop, tp1, tp2,
        rr1: ((tp1 - entry) / risk).toFixed(2),
        rr2: ((tp2 - entry) / risk).toFixed(2),
      };
    }
  }
  const last = prices[prices.length - 1];
  const atr = asset.atrAbs;
  const rsi = ind.rsi?.value;
  const adx = ind.adx?.value || 0;
  const macdH = ind.macd?.value;
  const ichi = ind.ichimoku;
  const ma20 = ind.ma20?.value;
  const ma50 = ind.ma50?.value;
  const sma200 = ind.sma200?.value;
  const sma200Dist = ind.sma200?.distance;
  const obv = ind.obv;
  const di = ind.directional;
  // ── Filtres structurels stricts ──
  // 1) Si on a SMA200 : prix > SMA200 ET MA50 > SMA200 (golden cross structurel)
  if (sma200) {
    if (last <= sma200) return null;
    if (ma50 && ma50 <= sma200) return null;
    // Distance pas trop étirée
    if (sma200Dist != null && (sma200Dist > 25 || sma200Dist < 2)) return null;
  }
  // 2) Ichimoku au-dessus du nuage avec signal bull
  if (!ichi || ichi.position !== 'above-cloud' || ichi.signal !== 'bull') return null;
  // 3) Tendance MT confirmée
  if (!ma20 || !ma50 || ma20 <= ma50) return null;
  if (last <= ma20) return null;
  // 4) Force directionnelle
  if (adx < 25) return null;
  if (di && di.plusDI <= di.minusDI) return null;
  // 5) Volume confirmant (OBV en tendance haussière)
  if (obv && obv.trend === 'down') return null;
  // 6) RSI sain (pas surchauffe, pas faiblesse)
  if (rsi == null || rsi < 45 || rsi > 65) return null;
  // 7) MACD positif
  if (macdH == null || macdH <= 0) return null;
  // ── Niveaux ──
  const entry = last;
  const stop = Math.min(entry - 1.3 * atr, ma20 * 0.99);
  const tp1 = entry + 2.5 * atr;
  const tp2 = entry + 5 * atr;
  const risk = entry - stop;
  if (risk <= 0 || tp1 <= entry || tp2 <= tp1) return null;
  if ((tp2 - entry) / risk < 2.5) return null;
  return {
    type: 'atlas-tendance', label: 'Tendance long terme confirmée',
    timeframe: 'Long terme · 3-8 semaines', confidence: 'very-high',
    config: 'Structure haussière complète : tendance MT et LT alignées avec volume confirmant.',
    rationale: 'Configuration acheteuse safe : tous les indicateurs structurels et le flux volume sont alignés. Stop technique serré sous la moyenne mobile dynamique. Cible 1 à +2.5 ATR, cible 2 à +5 ATR pour capter la suite du mouvement.',
    direction: 'long', entry, stop, tp1, tp2,
    rr1: ((tp1 - entry) / risk).toFixed(2),
    rr2: ((tp2 - entry) / risk).toFixed(2),
  };
}

/**
 * v2.73 — Détection Ponchy COMPLET (utilisé en bonus par ATLAS et ZEN)
 * Trouve un Doji haussier ET vérifie les 2 confirmations IVT :
 * Ichimoku cloud ascendant + MA7 ascendante. Si tout aligné, signal premium.
 */
function detectPonchy(asset) {
  if (!asset.prices) return null;
  const s = detectDoji(asset.prices, asset.atrAbs);
  if (!s || s.direction !== 'long' || !s.ivtComplete) return null;
  return s;
}

/**
 * ZEN — L'Équilibriste (v2.72)
 * Focus : SWING dans tendance avec ENTRÉE TACTIQUE (VWAP / Doji / Pullback)
 * Outils privés : MA20/MA50 + MACD + VWAP (entrée fair-price) + Bollinger pos
 *                + RSI 40-60 + Doji + Hull MA (timing)
 */
function _detectZen(asset) {
  const ind = asset.indRaw;
  const prices = asset.prices;
  if (!ind || !prices || prices.length < 30) return null;
  const last = prices[prices.length - 1];
  const atr = asset.atrAbs;
  const rsi = ind.rsi?.value;
  const macdH = ind.macd?.value;
  const ma20 = ind.ma20?.value;
  const ma50 = ind.ma50?.value;
  const boll = ind.boll?.value;
  const adx = ind.adx?.value || 0;
  const vw = ind.vwap;
  // Filtres structurels
  if (!ma20 || !ma50 || ma20 <= ma50) return null;
  if (macdH == null || macdH <= 0) return null;
  if (adx < 18) return null;
  // ZEN cherche une entrée tactique parmi 3 voies :
  // 1) Doji haussier (avec bonus IVT si Ichimoku + MA7 confirment)
  const doji = detectDoji(prices, atr);
  if (doji && doji.direction === 'long') {
    const entry = last;
    const stop = Math.min(doji.stopLevel, entry - 1.5 * atr);
    const tp1 = entry + 2 * atr;
    const tp2 = doji.ivtComplete ? entry + 5 * atr : entry + 4 * atr;
    const risk = entry - stop;
    if (risk > 0 && (tp2 - entry) / risk >= 2.0) {
      return {
        type: doji.ivtComplete ? 'zen-ponchy' : 'zen-doji',
        label: doji.ivtComplete ? 'Ponchy complet (signal premium)' : 'Doji haussier (entrée swing)',
        timeframe: 'Swing · 1-3 semaines',
        confidence: doji.ivtComplete ? 'very-high' : 'high',
        config: doji.ivtComplete
          ? 'Triple confluence : Doji-reversal + Ichimoku cloud ascendant + MA7 ascendante. Signal premium.'
          : 'Doji-reversal validé dans tendance MT haussière. Confirmation MACD>0 + ADX>18.',
        rationale: doji.ivtComplete
          ? 'Configuration IVT complète : retournement Doji + structure Ichimoku haussière (cloud monte) + moyenne mobile courte ascendante. Les 3 confirmations alignées = très haute conviction. Stop sous le swing low, cible étendue +5 ATR. Sortie discrétionnaire au prochain Doji baissier (méthode du formateur).'
          : 'Entrée tactique sur un signal de retournement court terme dans une tendance MT confirmée. Stop sous le swing low, cible swing avec R/R 1:2 minimum.',
        direction: 'long', entry, stop, tp1, tp2,
        rr1: ((tp1 - entry) / risk).toFixed(2),
        rr2: ((tp2 - entry) / risk).toFixed(2),
      };
    }
  }
  // 2) Entrée sur retest VWAP en zone neutre (rebond VWAP)
  if (vw && vw.distancePct >= -2 && vw.distancePct <= 0.5
      && rsi != null && rsi >= 40 && rsi <= 60) {
    const entry = last;
    const stop = Math.min(entry - 1.4 * atr, (vw.value || entry) * 0.99);
    const tp1 = entry + 2 * atr;
    const tp2 = entry + 3.5 * atr;
    const risk = entry - stop;
    if (risk > 0 && (tp2 - entry) / risk >= 2.0) {
      return {
        type: 'zen-vwap-retest', label: 'Retest VWAP — entrée tactique',
        timeframe: 'Swing · 1-2 semaines', confidence: 'high',
        config: 'Prix au niveau du VWAP 20j (zone d\'équilibre acheteur/vendeur) dans une tendance haussière confirmée.',
        rationale: 'Le VWAP est le "fair price" calculé sur 20 séances pondéré par les volumes. Acheter au VWAP dans tendance haussière = entrée institutionnelle classique. Stop sous le VWAP, cibles à +2 et +3.5 ATR.',
        direction: 'long', entry, stop, tp1, tp2,
        rr1: ((tp1 - entry) / risk).toFixed(2),
        rr2: ((tp2 - entry) / risk).toFixed(2),
      };
    }
  }
  // 3) Pullback classique sur Bollinger médiane + RSI sain
  if (rsi != null && rsi >= 40 && rsi <= 58
      && boll != null && boll >= 0.25 && boll <= 0.55) {
    const entry = last;
    const stop = Math.min(entry - 1.5 * atr, ma50 * 0.985);
    const tp1 = entry + 2 * atr;
    const tp2 = entry + 4 * atr;
    const risk = entry - stop;
    if (risk > 0 && (tp2 - entry) / risk >= 2.0) {
      return {
        type: 'zen-pullback', label: 'Pullback dans tendance haussière',
        timeframe: 'Swing · 1-3 semaines', confidence: 'high',
        config: 'Tendance MT (MA20>MA50) + MACD positif + RSI ' + rsi.toFixed(0) + ' + Bollinger au milieu de bande.',
        rationale: 'Repli sain dans une tendance confirmée, sans excès de volatilité. Stop technique sous la MA50, cibles symétriques.',
        direction: 'long', entry, stop, tp1, tp2,
        rr1: ((tp1 - entry) / risk).toFixed(2),
        rr2: ((tp2 - entry) / risk).toFixed(2),
      };
    }
  }
  return null;
}

/**
 * NOVA — Le Tacticien
 * Focus : multi-confirmations équilibrées (le profil polyvalent)
 * Outils internes : tous les indicateurs, multi-confirmations
 *                  Utilise detectSetup() standard
 */
function _detectNova(asset) {
  const setup = detectSetup(asset);
  if (setup) return setup;
  // Si rien de propre, tente une détection Doji en backup
  const doji = detectDoji(asset.prices, asset.atrAbs);
  if (doji && doji.direction === 'long') {
    const ind = asset.indRaw;
    if (!ind.maCross || ind.maCross.signal !== 'bull') return null;
    const last = asset.prices[asset.prices.length - 1];
    const atr = asset.atrAbs;
    const entry = last;
    const stop = doji.stopLevel;
    const tp1 = entry + 2 * atr;
    const tp2 = entry + 3.5 * atr;
    const risk = entry - stop;
    if (risk <= 0 || (tp2 - entry) / risk < 1.8) return null;
    return {
      type: 'nova-doji', label: 'Doji haussier (NOVA)',
      timeframe: 'Swing · 1-2 semaines', confidence: 'medium',
      config: 'Setup Doji détecté dans tendance MT haussière.',
      rationale: 'Approche multi-conf : Doji + tendance MT confirmée = entrée swing.',
      direction: 'long', entry, stop, tp1, tp2,
      rr1: ((tp1 - entry) / risk).toFixed(2),
      rr2: ((tp2 - entry) / risk).toFixed(2),
    };
  }
  return null;
}

/**
 * KAIRO — Le Chasseur (v2.72)
 * Focus : CONTRARIAN + DIVERGENCES + capitulation volume
 * Outils privés : RSI Divergence + MFI + Force Index + Hull MA + Momentum vif
 *                + Doji baissier (short tactique)
 * Ignore : ADX, MA200 (n'attend pas de tendance établie)
 */
function _detectKairo(asset) {
  const ind = asset.indRaw;
  const prices = asset.prices;
  if (!ind || !prices) return null;
  const last = prices[prices.length - 1];
  const atr = asset.atrAbs;
  const rsi = ind.rsi?.value;
  const div = ind.rsiDivergence;
  const mf = ind.mfi?.value;
  const fi = ind.forceIndex?.value;
  const hma = ind.hullMA?.value;
  const ma50 = ind.ma50?.value;

  // VOIE 1 — Divergence RSI haussière (signal contrarian premium)
  if (div && div.type === 'bullish' && div.strength >= 0.3
      && ma50 && last > ma50 * 0.9) {
    const entry = last;
    const stop = entry - 2 * atr;
    const tp1 = entry + 2.5 * atr;
    const tp2 = entry + 5 * atr;
    const risk = entry - stop;
    if (risk > 0 && (tp2 - entry) / risk >= 2.0) {
      return {
        type: 'kairo-divergence', label: 'Divergence haussière confirmée',
        timeframe: 'Swing court · 3-7 jours', confidence: div.strength > 0.6 ? 'high' : 'medium',
        config: 'Le prix fait un plus bas mais l\'oscillateur fait un plus haut — signal de retournement classique.',
        rationale: 'Divergence : le marché baisse mais perd de la force. Les vendeurs s\'essoufflent. KAIRO entre AVANT que les autres voient venir. Stop large pour absorber le bruit final.',
        direction: 'long', entry, stop, tp1, tp2,
        rr1: ((tp1 - entry) / risk).toFixed(2),
        rr2: ((tp2 - entry) / risk).toFixed(2),
      };
    }
  }

  // VOIE 2 — Capitulation MFI (volume baissier massif)
  if (mf != null && mf < 22 && rsi != null && rsi < 40
      && hma && last > hma * 0.97) { // Hull MA proche = retournement potentiel
    const entry = last;
    const stop = entry - 2.2 * atr;
    const tp1 = entry + 2 * atr;
    const tp2 = entry + 5 * atr;
    const risk = entry - stop;
    if (risk > 0 && (tp2 - entry) / risk >= 2.0) {
      return {
        type: 'kairo-capitulation', label: 'Capitulation volume — rebond imminent',
        timeframe: 'Court terme · 2-5 jours', confidence: 'medium',
        config: 'MFI ' + mf.toFixed(0) + ' (capitulation vendeuse) + RSI bas + signal Hull MA proche.',
        rationale: 'Money Flow Index très bas = volume vendeur extrême. Combiné à un RSI faible et au prix qui approche la Hull MA (ligne réactive), c\'est souvent le creux avant un rebond technique.',
        direction: 'long', entry, stop, tp1, tp2,
        rr1: ((tp1 - entry) / risk).toFixed(2),
        rr2: ((tp2 - entry) / risk).toFixed(2),
      };
    }
  }

  // VOIE 3 — Force Index très négative + Doji haussier
  const doji = detectDoji(prices, atr);
  if (doji && doji.direction === 'long' && fi != null && fi < 0) {
    const entry = last;
    const stop = Math.min(doji.stopLevel, entry - 2 * atr);
    const tp1 = entry + 2 * atr;
    const tp2 = entry + 5 * atr;
    const risk = entry - stop;
    if (risk > 0 && (tp2 - entry) / risk >= 2.0) {
      return {
        type: 'kairo-doji', label: 'Doji + Force Index négatif → reprise',
        timeframe: 'Court terme · 3-7 jours', confidence: 'high',
        config: 'Doji après bougie rouge confirmé par bougie verte alors que le Force Index est encore négatif.',
        rationale: 'KAIRO chasse le creux : Doji haussier précoce + Force Index encore négatif = on entre avant la majorité. Plus risqué mais asymétrie de gain favorable.',
        direction: 'long', entry, stop, tp1, tp2,
        rr1: ((tp1 - entry) / risk).toFixed(2),
        rr2: ((tp2 - entry) / risk).toFixed(2),
      };
    }
  }

  // v2.81 — VOIE 3bis : Hull reversal sans-volume (déclenche sur forex où
  // MFI/Force Index sont indisponibles faute de volumes Yahoo fiables)
  if (rsi != null && rsi < 30 && hma != null
      && last > hma * 1.002 && prices.length > 3 && last > prices[prices.length - 4]) {
    const entry = last;
    const stop = entry - 2 * atr;
    const tp1 = entry + 2 * atr;
    const tp2 = entry + 4 * atr;
    const risk = entry - stop;
    if (risk > 0 && (tp2 - entry) / risk >= 2.0) {
      return {
        type: 'kairo-hull-reversal',
        label: 'Hull MA reversal — entrée contrarian',
        timeframe: 'Court terme · 3-7 jours',
        confidence: 'medium',
        config: 'RSI ' + rsi.toFixed(0) + ' (bas) + prix qui repasse au-dessus de la Hull MA + slope-up 3 derniers jours.',
        rationale: 'Quand un actif (souvent forex/devises sans volumes fiables) ressort par le haut de sa Hull MA après un RSI bas et que la pente vient de s\'inverser, c\'est un signal de retournement précoce. KAIRO entre avant que la tendance ne soit confirmée par les MA classiques.',
        direction: 'long', entry, stop, tp1, tp2,
        rr1: ((tp1 - entry) / risk).toFixed(2),
        rr2: ((tp2 - entry) / risk).toFixed(2),
      };
    }
  }

  // VOIE 4 — Setups agressifs classiques (momentum vif, squeeze) déjà implémentés
  const aggressive = detectAggressiveSetup(asset);
  if (aggressive) return aggressive;

  // VOIE 5 — Doji baissier (short tactique)
  if (doji && doji.direction === 'short') {
    const entry = last;
    const stop = doji.stopLevel;
    const tp1 = entry - 2 * atr;
    const tp2 = entry - 4 * atr;
    const risk = stop - entry;
    if (risk > 0 && (entry - tp2) / risk >= 2.0) {
      return {
        type: 'kairo-doji-short', label: 'Doji baissier (short tactique)',
        timeframe: 'Court terme · 2-5 jours', confidence: 'medium',
        config: 'Doji après bougie verte puis bougie rouge — retournement court terme.',
        rationale: 'Short tactique réservé aux comptes qui shortent. Sinon : signal "sors de ton long".',
        direction: 'short', entry, stop, tp1, tp2,
        rr1: ((entry - tp1) / risk).toFixed(2),
        rr2: ((entry - tp2) / risk).toFixed(2),
      };
    }
  }
  return null;
}

async function main() {
  console.log('Building AI study…');
  const results = await Promise.all(ASSETS.map(fetchOne));
  const valid = results.filter(Boolean).map(summarizeAsset).filter(Boolean);
  if (valid.length === 0) {
    throw new Error('No asset data available — abort');
  }

  // Détection des setups propices sur TOUS les actifs (pas seulement le meilleur)
  // Chaque actif peut produire 0 ou 1 setup. On expose la liste complète pour
  // que l'utilisateur ait soit notre reco directe (suivre l'IA), soit la matière
  // pour faire sa propre analyse dans Marché en direct.
  const CONF_RANK = { 'very-high': 3, 'high': 2, 'medium': 1, 'low': 0 };
  const setupsAll = valid
    .map(a => {
      const s = detectSetup(a);
      if (!s) return null;
      return {
        ...s,
        asset: a.label,
        kind: a.kind,
        score: a.score,
        // v2.61 — embarquer les 60 dernières bougies pour rendu graph SVG
        prices60: a.prices.slice(-60),
        currency: a.kind === 'crypto' || a.label === 'S&P 500' || a.label === 'Nasdaq' || a.label === 'Dow' ? 'USD' : 'EUR',
      };
    })
    .filter(Boolean)
    // v2.54 — Tri par CONFIDENCE puis R/R (pas seulement R/R)
    .sort((a, b) => {
      const dc = (CONF_RANK[b.confidence] || 0) - (CONF_RANK[a.confidence] || 0);
      if (dc !== 0) return dc;
      return Number(b.rr2) - Number(a.rr2);
    });
  // Setup principal (pour rétrocompat) = celui avec meilleure confidence puis R/R
  const bestSetup = setupsAll[0] || null;

  // ─────────────────────────────────────────────────────────────────
  // v2.67 — 4 AGENTS IA avec profils de risque distincts
  // Chaque agent filtre les setups et recalibre les niveaux ATR.
  // ─────────────────────────────────────────────────────────────────
  // v5.0 — Renommage personnalité × performance backtest 4 ans :
  //   BASTION (ex-ATLAS)  : long terme · 1-3 mois · +8.9%/an · DD <1.5% · WR 41%
  //   PHÉNIX  (ex-NOVA)   : moyen · 1-3 semaines · +7.7%/an · WR 58%
  //   RAFALE  (ex-KAIRO)  : court · 3-7 jours · +6-7%/an · WR 52%
  //   ZEN reste legacy (pas exposé dans le picker UI)
  const AGENT_PROFILES = [
    {
      id: 'atlas', name: 'BASTION', role: 'Le Stoïque',
      tagline: 'Forteresse stable, patience récompensée',
      desc: 'Long terme · 1-3 mois · Patience haute · 3-4 trades/semaine. Win rate plus bas mais chaque gagnant rapporte gros (R/R 3.5). Risque très maîtrisé.',
      icon: '🗿', color: '#60a5fa',
      filters: { minConfRank: 3, minADX: 28, minRR: 2.5 },
      atr: { stop: 1.2, tp1: 2.0, tp2: 3.5 },
      acceptedTypes: ['pullback-haussier', 'breakout-haussier', 'continuation-haussiere'],
    },
    {
      id: 'zen', name: 'ZEN', role: 'L\'Équilibriste',
      tagline: 'Patience et précision (legacy, non exposé)',
      desc: 'Swing tactique legacy. Entrée précise sur Doji, retest VWAP ou pullback Bollinger en tendance confirmée. Non exposé dans le picker temporel UI.',
      icon: '🌿', color: '#84cc16',
      filters: { minConfRank: 2, minADX: 22, minRR: 2.0 },
      atr: { stop: 1.5, tp1: 2.0, tp2: 4.0 },
      acceptedTypes: ['pullback-haussier', 'breakout-haussier', 'continuation-haussiere', 'rebond-ma50', 'doji-haussier'],
    },
    {
      id: 'nova', name: 'PHÉNIX', role: 'L\'Équilibré',
      tagline: 'Résilience et constance, le pivot du système',
      desc: 'Moyen terme · 1-3 semaines · Patience moyenne · 5-7 trades/semaine. Le meilleur compromis fréquence/qualité. Risque très maîtrisé.',
      icon: '🔥', color: '#f59e0b',
      filters: { minConfRank: 1, minADX: 16, minRR: 1.8 },
      atr: { stop: 1.5, tp1: 1.5, tp2: 3.0 },
      acceptedTypes: null,
    },
    {
      id: 'kairo', name: 'RAFALE', role: 'Le Rapide',
      tagline: 'Cadence courte, gains fréquents',
      desc: 'Court terme · 3-7 jours · Patience faible · 5-9 trades/semaine. Idéal si tu veux voir l\'app travailler chaque jour. Risque très maîtrisé.',
      icon: '⚡', color: '#ef4444',
      filters: { minConfRank: 1, minADX: 10, minRR: 2.0 },
      atr: { stop: 2.0, tp1: 2.5, tp2: 5.0 },
      acceptedTypes: null,
      bonusTypes: ['rebond-survente'],
    },
    // v8.7 — NEXUS : 5e IA temporelle (crypto-only, 15 majeures)
    {
      id: 'multi', name: 'NEXUS', role: 'Le Convergent',
      tagline: 'Agrège les cycles crypto majeurs',
      desc: 'Crypto · 5-30 jours · 15 cryptos majeurs (BTC/ETH/SOL/BNB/XRP/ADA/DOGE/AVAX/DOT/LINK/TRX/LTC/UNI/ATOM/XLM). PF 2.17 backtesté. Drawdown maîtrisé.',
      icon: '₿', color: '#a855f7',
      filters: { minConfRank: 1, minADX: 10, minRR: 1.8 },
      atr: { stop: 0.8, tp1: 2.0, tp2: 5.0 },
      acceptedTypes: ['nexus-A', 'nexus-B', 'nexus-C'],
      cryptoOnly: true,
    },
    // v7.14 — VOLT : 5e IA PREMIUM ABC-TRIPLE-PROTECTED (stress walk-forward 6 folds × 150j + slippage + garde-fous)
    // Validation : 6/6 folds positifs incluant bear crypto BTC -46.6% (+6.5%/an), worst DD -2.8%
    {
      id: 'volt', name: 'VOLT', role: 'L\'Opportuniste',
      tagline: 'Haute conviction sur actifs volatils',
      desc: 'PREMIUM · Haute conviction sur actifs volatils. Univers : 19 cryptos mid-cap + 23 actions high-beta. Méthode haute conviction avec garde-fous anti-risque automatiques. Max 3 positions, sizing renforcé. ⚠️ Capital à risque — pas pour débutants.',
      icon: '⚡', color: '#a855f7',
      filters: { minConfRank: 2, minADX: 0, minRR: 2.0 },
      atr: { stop: 0.6, tp1: 2.25, tp2: 4.5 },
      acceptedTypes: ['volt-D-A-contrarian', 'volt-D-C-pullback', 'volt-D-B-trendfollow'],
      premium: true,
      maxOpenPositions: 3,
      sizingRangeOverride: [3, 5],  // v7.14 — cap réduit 8→5 (DD contenu, validation stress)
    },
    // v10.9 — ALPHA WINNER : 6e IA PREMIUM ULTRA (config WINNER-1 v10.8)
    // Validation walk-forward 14 ans × 14 folds × 54 actifs :
    //   40.02%/an médian · DD -4.13% · Calmar 9.68 · 14/14 positifs · 1298 trades
    // Source : alpha-top3-deep-validation.mjs (commit ff44201)
    // Ultra-sélectif : minQuality 85 (~1-2 setups/an/actif), atrStop 0.5 (serré),
    // atrTp2 7.0 (R/R 14:1). À utiliser en complément de BASTION/PHENIX, pas seul.
    {
      id: 'alpha', name: 'ALPHA', role: 'Le Sniper',
      tagline: 'Validation 14 ans · 40%/an médian · ultra-sélectif',
      desc: 'PREMIUM ULTRA · Système le plus sélectif. Validation walk-forward 14 ans (54 actifs, 1298 trades) : 40.02%/an médian, DD -4.13%, Calmar 9.68, 14/14 années positives. Quality 85+ requis (très peu de signaux par an). R/R 14:1 sur cible étendue. ⚠️ Patience requise : 0 signal pendant des semaines est normal.',
      icon: '🎯', color: '#facc15',
      filters: { minConfRank: 2, minADX: 25, minRR: 5.0, minQuality: 85 },
      atr: { stop: 0.5, tp1: 3.5, tp2: 7.0 },
      acceptedTypes: ['alpha-A', 'alpha-B', 'alpha-C'],
      premium: true,
      maxOpenPositions: 5,
      sizingRangeOverride: [15, 20],  // sizing WINNER-1 = 18%
    },
  ];

  function applyAgentProfile(allSetups, agent) {
    const out = [];
    for (const s of allSetups) {
      // Filtre type accepté
      if (agent.acceptedTypes && !agent.acceptedTypes.includes(s.type)) continue;
      // Filtre confidence
      if ((CONF_RANK[s.confidence] || 0) < agent.filters.minConfRank) continue;
      // Filtre R/R
      if (Number(s.rr2) < agent.filters.minRR) continue;
      // Recalcul niveaux selon ATR mult de l'agent
      // On a besoin de l'ATR absolu. On reconstitue depuis le R/R existant.
      const risk = s.entry - s.stop;
      const atrAbs = risk / 1.5; // approximation : default stop = 1.5 ATR
      const entry = s.entry;
      const stop = entry - agent.atr.stop * atrAbs;
      const tp1 = entry + agent.atr.tp1 * atrAbs;
      const tp2 = entry + agent.atr.tp2 * atrAbs;
      if (stop >= entry || tp1 <= entry || tp2 <= tp1) continue;
      const newRR2 = (tp2 - entry) / (entry - stop);
      if (newRR2 < agent.filters.minRR) continue;
      out.push({
        ...s,
        entry, stop, tp1, tp2,
        rr1: ((tp1 - entry) / (entry - stop)).toFixed(2),
        rr2: newRR2.toFixed(2),
        agentId: agent.id,
      });
    }
    // Bonus types remontent en tête
    if (agent.bonusTypes) {
      out.sort((a, b) => {
        const aBonus = agent.bonusTypes.includes(a.type) ? 1 : 0;
        const bBonus = agent.bonusTypes.includes(b.type) ? 1 : 0;
        if (aBonus !== bBonus) return bBonus - aBonus;
        return Number(b.rr2) - Number(a.rr2);
      });
    } else {
      out.sort((a, b) => {
        const dc = (CONF_RANK[b.confidence] || 0) - (CONF_RANK[a.confidence] || 0);
        if (dc !== 0) return dc;
        return Number(b.rr2) - Number(a.rr2);
      });
    }
    return out;
  }

  // v2.70 — Chaque agent applique sa propre méthodologie privée
  // Le JSON public ne révèle PAS les outils utilisés (marque de fabrique)
  // v2.93 — Les détecteurs grid-optimal (issus du grid-search 49k combos sur 20y)
  // priorisent le combo mathématiquement validé. Fallback vers ancien détecteur
  // si pas de signal grid (préserve la richesse des opportunités).
  const _agentDetectors = {
    atlas: _detectAtlasGrid,  // MONTH (60j) : RSI<25 + MA bull + boll low + ATR 1/7
    zen: _detectZen,          // ZEN reste legacy (pas utilisé par le picker UI v2.84)
    nova: _detectNovaGrid,    // WEEK (15-21j) : RSI<25 + MA bull + boll low + ATR 1/5
    kairo: _detectKairoGrid,  // DAY (5-12j) : RSI<25 + MA bull + boll low + ATR 1/4
    multi: _detectMultiCrypto, // v8.7 — NEXUS crypto-only (15 majeures, ABC stacking)
    volt: _detectVoltMulti,    // v7.13 — ABC-TRIPLE multi-pattern validé walk-forward (médiane +28.6%/an)
    alpha: _detectAlphaWinner, // v10.9 — ALPHA WINNER-1 validé 14 ans (40.02%/an médian, DD -4.13%)
  };
  function runAgentOnAssets(agentId) {
    const detect = _agentDetectors[agentId];
    if (!detect) return [];
    return valid
      .map(a => {
        const s = detect(a);
        if (!s) return null;
        // v3.4 — Quality score + position sizing
        const q = _computeQualityScore(s, a);
        return {
          ...s,
          asset: a.label, kind: a.kind, score: a.score,
          quality_score: q.score,
          sizing_pct: q.sizing_pct,
          sizing_label: q.sizing_label,
          prices60: a.prices.slice(-60),
          currency: a.kind === 'crypto' || a.label === 'S&P 500' || a.label === 'Nasdaq' || a.label === 'Dow' ? 'USD' : 'EUR',
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        // v3.4 — Tri primaire par quality_score décroissant, puis confidence, puis RR
        const dq = (b.quality_score || 0) - (a.quality_score || 0);
        if (dq !== 0) return dq;
        const dc = (CONF_RANK[b.confidence] || 0) - (CONF_RANK[a.confidence] || 0);
        if (dc !== 0) return dc;
        return Number(b.rr2) - Number(a.rr2);
      });
  }

  // v2.86 — Charge la fenêtre des news 48h et calcule les matches assets
  const recentNews = await loadNewsWindow();
  const newsMatches = matchNewsToAssets(recentNews, valid);
  const newsMatchCount = Object.keys(newsMatches).length;
  console.log(`v2.86 News context : ${recentNews.length} news chargées, ${newsMatchCount} actifs avec match`);

  // v4.0 — Charge les rules ML si dispo (fallback safe si absent)
  const mlRules = await loadMlRules();
  // v4.2 — Récupère VIX + DXY pour conditionner les setups
  const macroCtx = await fetchMacroContext();
  // v4.9 — Signal cross-asset (S&P et Nasdaq daily change)
  const crossSignal = computeCrossAssetSignal(valid);
  if (crossSignal.reason) console.log(`v4.9 Cross-asset: ${crossSignal.reason}`);
  // v7.10 — Sector momentum : perf 60j de chaque ETF sectoriel
  const sectorMomentum = _computeSectorMomentum(valid);
  const sectorLog = Object.entries(sectorMomentum)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k.split(' ')[0]}=${v >= 0 ? '+' : ''}${v.toFixed(1)}%`)
    .join(' · ');
  if (sectorLog) console.log(`v7.10 Sector momentum 60j: ${sectorLog}`);
  // v4.8 — Macro event imminent (FOMC, CPI, NFP)
  const macroEvent = getMacroEventInDays(2);
  if (macroEvent) console.log(`v4.8 Macro event imminent: ${macroEvent.date} (dans ${macroEvent.days_until}j)`);

  // ─────────────────────────────────────────────────────────────────────
  // v8.8 — WISDOM ENGINE : lecture marché + match historique 30 ans
  // ─────────────────────────────────────────────────────────────────────
  // Construit le snapshot actuel de marché (VIX, DXY, BTC 30d, S&P 30d,
  // secteurs dominants, thèmes news), puis match contre 15 events historiques.
  const sp500Asset = valid.find(a => a.label === 'S&P 500');
  const btcAsset = valid.find(a => a.label === 'BTC');
  const compute30dChange = (prices) => {
    if (!prices || prices.length < 30) return null;
    const now = prices[prices.length - 1];
    const past = prices[prices.length - 30];
    return ((now - past) / past) * 100;
  };
  const sp500_30d_change = sp500Asset ? compute30dChange(sp500Asset.prices) : null;
  const btc_30d_change = btcAsset ? compute30dChange(btcAsset.prices) : null;

  // Top 3 secteurs dominants (par momentum 60j)
  const topSectors = Object.entries(sectorMomentum)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k.split(' ')[0]); // ex 'XLK Tech' → 'XLK'

  // Thèmes news dominants (mots-clés sur 48h de news)
  const newsThemesMap = classifyNewsThemes(recentNews);
  const dominantThemes = getDominantThemes(newsThemesMap, 3);

  // Yield curve estimée via DXY trend (proxy faute de données réelles 2y/10y)
  // TODO v8.9 — fetch ^IRX / ^TNX pour vraie yield curve
  const yieldCurveProxy = macroCtx.dxy_trend === 'up' ? 'flat' : (macroCtx.dxy_trend === 'down' ? 'steep' : null);

  // Special flags (réutilise crossSignal + macroEvent)
  const specialFlags = [];
  if (crossSignal.risk_off) specialFlags.push('risk_off');
  if (crossSignal.tech_risk_off) specialFlags.push('tech_dump');
  if (crossSignal.crypto_dump) specialFlags.push('btc_dump');
  if (macroEvent) specialFlags.push('macro_event_imminent');

  const currentMarketState = {
    vix: macroCtx.vix,
    dxy_trend: macroCtx.dxy_trend,
    yield_curve: yieldCurveProxy,
    btc_30d_change,
    sp500_30d_change,
    dominant_sectors: topSectors,
    dominant_news_themes: dominantThemes,
    special_flags: specialFlags,
  };

  // Top 3 analogues historiques
  const historicalAnalogs = findHistoricalAnalogs(currentMarketState, 3);
  const topAnalog = historicalAnalogs[0];
  if (topAnalog) {
    console.log(`v8.8 Wisdom: top analog = ${topAnalog.name} (${topAnalog.date.slice(0,4)}) similarity ${topAnalog.similarity}%`);
    console.log(`v8.8 Wisdom lesson: ${topAnalog.lesson}`);
  }

  // Pré-calcule l'ajustement wisdom par IA (factorisé)
  const wisdomAdjustments = {};
  for (const iaId of ['atlas', 'nova', 'kairo', 'multi', 'volt']) {
    wisdomAdjustments[iaId] = computeWisdomAdjustment(iaId, topAnalog);
  }
  console.log(`v8.8 Wisdom adjustments by IA:`,
    Object.entries(wisdomAdjustments).map(([k, v]) => `${k}=${v.adjustment > 0 ? '+' : ''}${v.adjustment}`).join(' '));

  // ─────────────────────────────────────────────────────────────────────
  // v9.0 — NEWS INTELLIGENCE : 11 signaux additionnels
  // ─────────────────────────────────────────────────────────────────────
  // Pré-déclare actionAssets (utilisé aussi par v4.6 plus bas)
  const actionAssets = valid.filter(a => a.kind === 'action');

  // 1. M&A events détectés dans les news (45 mots-clés FR/EN)
  const maEvents = detectMAEvents(recentNews, valid);
  if (maEvents.length > 0) console.log(`v9.0 M&A events: ${maEvents.length} (${maEvents.filter(e => e.kind === 'confirmed').length} confirmés)`);

  // 2. Earnings beat/miss : précharge pour toutes les actions
  console.log(`v9.0 Preloading earnings results for ${actionAssets.length} actions...`);
  const earningsResultsMap = new Map();
  await Promise.all(actionAssets.map(async a => {
    const sym = ASSETS.find(x => x.label === a.label)?.symbol;
    if (sym) {
      const r = await fetchEarningsResult(sym);
      if (r) earningsResultsMap.set(a.label, r);
    }
  }));

  // 3. Crypto Fear & Greed (1 fetch global)
  const fearGreed = await fetchFearGreed();
  if (fearGreed) console.log(`v9.0 Fear & Greed: ${fearGreed.value} (${fearGreed.classification}) Δ${fearGreed.change_1d > 0 ? '+' : ''}${fearGreed.change_1d}`);

  // 4. Insider activity : précharge actions (parallèle)
  console.log(`v9.0 Preloading insider activity...`);
  const insiderMap = new Map();
  await Promise.all(actionAssets.slice(0, 100).map(async a => {
    const sym = ASSETS.find(x => x.label === a.label)?.symbol;
    if (sym) {
      const r = await fetchInsiderActivity(sym);
      if (r) insiderMap.set(a.label, r);
    }
  }));

  // 5. Short interest : précharge actions (parallèle)
  console.log(`v9.0 Preloading short interest...`);
  const shortMap = new Map();
  await Promise.all(actionAssets.slice(0, 100).map(async a => {
    const sym = ASSETS.find(x => x.label === a.label)?.symbol;
    if (sym) {
      const r = await fetchShortInterest(sym);
      if (r) shortMap.set(a.label, r);
    }
  }));

  // 6. Seasonality (calcul instantané)
  const seasonality = getSeasonalityBias();
  console.log(`v9.0 Seasonality: bias ${seasonality.bias} (${seasonality.label})`);

  // 7. Tech events imminents (<10j)
  const techEvents = getTechEventsInDays(10);
  if (techEvents.length > 0) console.log(`v9.0 Tech events <10j: ${techEvents.map(e => e.name).join(', ')}`);

  // 8. Analyst momentum : précharge actions
  console.log(`v9.0 Preloading analyst trends...`);
  const analystMap = new Map();
  await Promise.all(actionAssets.slice(0, 100).map(async a => {
    const sym = ASSETS.find(x => x.label === a.label)?.symbol;
    if (sym) {
      const r = await fetchAnalystTrend(sym);
      if (r) analystMap.set(a.label, r);
    }
  }));

  // 9. Enriched themes (FDA, AI breakthrough, crypto hack, recession, rate pivot)
  const enrichedThemes = detectEnrichedThemes(recentNews);
  const enrichedTop = Object.entries(enrichedThemes).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (enrichedTop.length > 0) console.log(`v9.0 Enriched themes:`, enrichedTop.map(([k, v]) => `${k}=${v}`).join(' · '));

  // 10. ETF flow signals (volume anormal)
  const etfFlows = computeEtfFlowSignal(valid);
  const flowEntries = Object.entries(etfFlows);
  if (flowEntries.length > 0) console.log(`v9.0 ETF flows:`, flowEntries.map(([k, v]) => `${k.split(' ')[0]}=${v.kind}×${v.ratio.toFixed(1)}`).join(' · '));

  // 11. Geopolitical risk index (composite)
  const geoRisk = computeGeoRiskIndex(newsThemesMap);
  console.log(`v9.0 Geo risk: ${geoRisk.index}/100 (${geoRisk.level})`);
  // v4.6 — Préchargement earnings dates pour toutes les actions (parallèle)
  // (actionAssets déclaré plus haut dans le bloc v9.0)
  console.log(`v4.6 Preloading earnings for ${actionAssets.length} actions...`);
  await Promise.all(actionAssets.map(async a => {
    const sym = ASSETS.find(x => x.label === a.label)?.symbol;
    if (sym) await getEarningsDays(sym);
  }));

  // v4.7 — Préchargement sentiment NLP des actifs qui ont des news matched
  const sentimentMap = new Map();
  const assetsWithNews = Object.keys(newsMatches).filter(k => Array.isArray(newsMatches[k]) && newsMatches[k].length > 0);
  if (assetsWithNews.length > 0) {
    console.log(`v4.7 Classifying sentiment for ${assetsWithNews.length} assets with news (Pollinations)...`);
    // Chunks de 8 en parallèle pour ne pas saturer Pollinations
    for (let i = 0; i < assetsWithNews.length; i += 8) {
      const chunk = assetsWithNews.slice(i, i + 8);
      await Promise.all(chunk.map(async assetLabel => {
        const titles = newsMatches[assetLabel].map(n => n.title);
        const s = await classifyNewsSentiment(titles);
        if (s) sentimentMap.set(assetLabel, s);
      }));
    }
    const negCount = [...sentimentMap.values()].filter(s => s.verdict === 'negative').length;
    const posCount = [...sentimentMap.values()].filter(s => s.verdict === 'positive').length;
    console.log(`v4.7 Sentiment results: ${posCount} positifs, ${negCount} négatifs, ${sentimentMap.size - posCount - negCount} neutres`);
  }
  const earningsLog = [];
  for (const a of actionAssets) {
    const sym = ASSETS.find(x => x.label === a.label)?.symbol;
    if (sym && _earningsCache.get(sym) != null && _earningsCache.get(sym) >= 0 && _earningsCache.get(sym) <= 21) {
      earningsLog.push(`${a.label}=${_earningsCache.get(sym)}j`);
    }
  }
  if (earningsLog.length) console.log(`v4.6 Earnings <21j: ${earningsLog.join(', ')}`);

  // Helper synchrone pour le filtre (lecture du cache préchargé)
  const applyEarningsFilterSync = (setup, assetLabel) => {
    if (!setup) return { keep: true, qualityMult: 1, reason: null };
    const sym = ASSETS.find(x => x.label === assetLabel)?.symbol;
    if (!sym) return { keep: true, qualityMult: 1, reason: null };
    const days = _earningsCache.get(sym);
    if (days == null || days < 0) return { keep: true, qualityMult: 1, reason: null };
    if (days <= 7) return { keep: false, qualityMult: 0, reason: `Earnings dans ${days}j` };
    if (days <= 14) return { keep: true, qualityMult: 0.85, reason: `Earnings dans ${days}j → -15%` };
    return { keep: true, qualityMult: 1, reason: null };
  };

  const agentsOutput = AGENT_PROFILES.map(agent => {
    let setups = runAgentOnAssets(agent.id);
    // v10.9 — Filtre quality minimum (ex: ALPHA exige >= 85)
    if (agent.filters?.minQuality != null) {
      const before = setups.length;
      setups = setups.filter(s => (s.quality_score || 0) >= agent.filters.minQuality);
      if (before !== setups.length) {
        console.log(`v10.9 ${agent.name} : quality >= ${agent.filters.minQuality} → ${setups.length}/${before}`);
      }
    }
    // v4.2 — Filtres macro (VIX panic, DXY trend)
    setups = setups.filter(s => {
      const m = applyMacroFilter(s, macroCtx);
      if (!m.keep) {
        console.log(`v4.2 macro reject ${s.asset} (${s.type}) : ${m.reason}`);
        return false;
      }
      if (m.qualityMult !== 1 && s.quality_score != null) {
        s.quality_score_pre_macro = s.quality_score;
        s.quality_score = Math.max(0, Math.min(100, Math.round(s.quality_score * m.qualityMult)));
        s.macro_reason = m.reason;
      }
      return true;
    });
    // v4.6 — Filtre earnings (actions uniquement, skip si <7j)
    setups = setups.filter(s => {
      const e = applyEarningsFilterSync(s, s.asset);
      if (!e.keep) { console.log(`v4.6 earnings reject ${s.asset}: ${e.reason}`); return false; }
      if (e.qualityMult !== 1 && s.quality_score != null) {
        s.quality_score = Math.max(0, Math.min(100, Math.round(s.quality_score * e.qualityMult)));
        s.earnings_reason = e.reason;
      }
      return true;
    });
    // v4.9/v7.14 — Filtre cross-asset (S&P/Nasdaq dump → cap actions US · BTC dump → skip VOLT cryptos)
    if (crossSignal.risk_off || crossSignal.tech_risk_off || crossSignal.crypto_dump) {
      setups = setups.filter(s => {
        const ca = applyCrossAssetFilter(s, { label: s.asset }, crossSignal);
        if (!ca.keep) { console.log(`v4.9/v7.14 cross-asset reject ${s.asset}: ${ca.reason}`); return false; }
        if (ca.qualityMult !== 1 && s.quality_score != null) {
          s.quality_score = Math.max(0, Math.min(100, Math.round(s.quality_score * ca.qualityMult)));
          s.cross_asset_reason = ca.reason;
        }
        return true;
      });
    }
    // v7.10 — Filtre sector momentum (ETF sectoriels 60j → boost/cap quality)
    setups.forEach(s => {
      const sec = _applySectorMomentumFilter(s, sectorMomentum);
      if (sec.qualityMult !== 1 && s.quality_score != null) {
        s.quality_score = Math.max(0, Math.min(100, Math.round(s.quality_score * sec.qualityMult)));
        s.sector_reason = sec.reason;
      }
    });
    // v4.8 — Filtre macro event (FOMC/CPI/NFP imminent)
    if (macroEvent) {
      setups.forEach(s => {
        const me = applyMacroEventFilter(s);
        if (me.qualityMult !== 1 && s.quality_score != null) {
          s.quality_score = Math.max(0, Math.min(100, Math.round(s.quality_score * me.qualityMult)));
          s.macro_event_reason = me.reason;
        }
      });
    }
    // v4.7 — Filtre news sentiment (NLP via Pollinations, cache mémoire)
    if (sentimentMap.size > 0) {
      setups = setups.filter(s => {
        const sent = sentimentMap.get(s.asset);
        if (!sent) return true;
        const ns = applyNewsSentimentFilter(s, sent);
        if (!ns.keep) { console.log(`v4.7 sentiment reject ${s.asset}: ${ns.reason}`); return false; }
        if (ns.qualityMult !== 1 && s.quality_score != null) {
          s.quality_score = Math.max(0, Math.min(100, Math.round(s.quality_score * ns.qualityMult)));
          s.news_sentiment_reason = ns.reason;
        }
        s.news_sentiment = sent.verdict;
        return true;
      });
    }
    // ────────────────────────────────────────────────────────────────
    // v9.0 — NEWS INTELLIGENCE FILTERS (11 signaux additionnels)
    // ────────────────────────────────────────────────────────────────
    // 1. M&A : skip si rachat confirmé, -20% si rumeur
    if (maEvents.length > 0) {
      setups = setups.filter(s => {
        const f = applyMAFilter(s, maEvents);
        if (!f.keep) { console.log(`v9.0 M&A reject ${s.asset}: ${f.reason}`); return false; }
        if (f.qualityMult !== 1 && s.quality_score != null) {
          s.quality_score = Math.max(0, Math.min(100, Math.round(s.quality_score * f.qualityMult)));
          s.ma_reason = f.reason;
        }
        return true;
      });
    }
    // 2. Earnings beat/miss : ±8-15%
    setups.forEach(s => {
      const er = earningsResultsMap.get(s.asset);
      if (er) {
        const f = applyEarningsBeatFilter(s, er);
        if (f.qualityMult !== 1 && s.quality_score != null) {
          s.quality_score = Math.max(0, Math.min(100, Math.round(s.quality_score * f.qualityMult)));
          s.earnings_beat_reason = f.reason;
        }
      }
    });
    // 3. Crypto Fear & Greed : contrarian boost / top penalty
    if (fearGreed) {
      setups.forEach(s => {
        const f = applyFearGreedFilter(s, fearGreed);
        if (f.qualityMult !== 1 && s.quality_score != null) {
          s.quality_score = Math.max(0, Math.min(100, Math.round(s.quality_score * f.qualityMult)));
          s.fear_greed_reason = f.reason;
        }
      });
    }
    // 4. Insider activity : ±12-15%
    setups.forEach(s => {
      const ins = insiderMap.get(s.asset);
      if (ins) {
        const f = applyInsiderFilter(s, ins);
        if (f.qualityMult !== 1 && s.quality_score != null) {
          s.quality_score = Math.max(0, Math.min(100, Math.round(s.quality_score * f.qualityMult)));
          s.insider_reason = f.reason;
        }
      }
    });
    // 5. Short squeeze : +8-18% sur longs avec short interest élevé
    setups.forEach(s => {
      const sh = shortMap.get(s.asset);
      if (sh) {
        const f = applyShortSqueezeFilter(s, sh);
        if (f.qualityMult !== 1 && s.quality_score != null) {
          s.quality_score = Math.max(0, Math.min(100, Math.round(s.quality_score * f.qualityMult)));
          s.short_squeeze_reason = f.reason;
        }
      }
    });
    // 6. Seasonality : ±5% selon mois
    setups.forEach(s => {
      const f = applySeasonalityFilter(s, seasonality);
      if (f.qualityMult !== 1 && s.quality_score != null) {
        s.quality_score = Math.max(0, Math.min(100, Math.round(s.quality_score * f.qualityMult)));
        s.seasonality_reason = f.reason;
      }
    });
    // 7. Tech events : +3-10% si event imminent et actif impacté
    if (techEvents.length > 0) {
      setups.forEach(s => {
        const f = applyTechEventFilter(s, techEvents);
        if (f.qualityMult !== 1 && s.quality_score != null) {
          s.quality_score = Math.max(0, Math.min(100, Math.round(s.quality_score * f.qualityMult)));
          s.tech_event_reason = f.reason;
        }
      });
    }
    // 8. Analyst momentum : ±8% selon upgrades/downgrades
    setups.forEach(s => {
      const an = analystMap.get(s.asset);
      if (an) {
        const f = applyAnalystFilter(s, an);
        if (f.qualityMult !== 1 && s.quality_score != null) {
          s.quality_score = Math.max(0, Math.min(100, Math.round(s.quality_score * f.qualityMult)));
          s.analyst_reason = f.reason;
        }
      }
    });
    // 9. Enriched themes : skip si hack crypto, boost si FDA/AI/pivot
    if (Object.keys(enrichedThemes).length > 0) {
      setups = setups.filter(s => {
        const f = applyEnrichedThemeFilter(s, enrichedThemes);
        if (!f.keep) { console.log(`v9.0 Enriched theme reject ${s.asset}: ${f.reason}`); return false; }
        if (f.qualityMult !== 1 && s.quality_score != null) {
          s.quality_score = Math.max(0, Math.min(100, Math.round(s.quality_score * f.qualityMult)));
          s.enriched_theme_reason = f.reason;
        }
        return true;
      });
    }
    // 11. Geopolitical risk : -5/-15% si tension élevée
    setups.forEach(s => {
      const f = applyGeoRiskFilter(s, geoRisk);
      if (f.qualityMult !== 1 && s.quality_score != null) {
        s.quality_score = Math.max(0, Math.min(100, Math.round(s.quality_score * f.qualityMult)));
        s.geo_risk_reason = f.reason;
      }
    });

    // v8.8 — Wisdom adjustment : ajuste quality_score selon le top analog historique
    const wAdj = wisdomAdjustments[agent.id];
    if (wAdj && wAdj.adjustment !== 0) {
      setups.forEach(s => {
        if (s.quality_score != null) {
          s.quality_score_pre_wisdom = s.quality_score;
          s.quality_score = Math.max(0, Math.min(100, s.quality_score + wAdj.adjustment));
          s.wisdom_adjustment = wAdj.adjustment;
          s.wisdom_note = wAdj.note;
          s.historical_analog = wAdj.historical_analog;
        }
      });
    }
    // v4.0 — Booste quality_score par AUC ML de l'horizon de l'agent
    if (mlRules) {
      setups.forEach(s => {
        const boosted = _applyMlBoost(s.quality_score, agent.id, mlRules);
        if (boosted !== s.quality_score) {
          s.quality_score_pre_ml = s.quality_score;
          s.quality_score = boosted;
        }
      });
    }
    return {
      // v2.70 — On expose UNIQUEMENT l'identité publique + les setups
      // Aucune information sur la méthodologie / outils internes
      id: agent.id, name: agent.name, role: agent.role, tagline: agent.tagline,
      desc: agent.desc, icon: agent.icon, color: agent.color,
      count: setups.length,
      setups: setups.map(s => ({
        asset: s.asset, kind: s.kind, type: s.type, label: s.label,
        timeframe: s.timeframe || null, confidence: s.confidence || 'medium',
        direction: s.direction, config: s.config, rationale: s.rationale,
        entry: s.entry, stop: s.stop, tp1: s.tp1, tp2: s.tp2,
        rr1: s.rr1, rr2: s.rr2, currency: s.currency,
        prices60: Array.isArray(s.prices60) ? s.prices60.map(p => Number(p.toFixed(4))) : null,
        // v3.4 — quality score + position sizing recommandé (dev-only côté UI)
        quality_score: s.quality_score || null,
        sizing_pct: s.sizing_pct || null,
        sizing_label: s.sizing_label || null,
        // v4.1 — flag trailing stop (move stop=entry quand TP1 touché)
        trailing_after_tp1: s.trailing_after_tp1 === true,
        // v4.2 — raison macro éventuelle (downgrade VIX/DXY, dev-only utile)
        macro_reason: s.macro_reason || null,
        // v4.6 — earnings proches (raison du downgrade éventuel)
        earnings_reason: s.earnings_reason || null,
        // v4.7 — sentiment NLP des news <48h matchées
        news_sentiment: s.news_sentiment || null,
        news_sentiment_reason: s.news_sentiment_reason || null,
        // v4.8 — release macro imminent (FOMC/CPI/NFP)
        macro_event_reason: s.macro_event_reason || null,
        // v4.9 — risk-off cross-asset (S&P/Nasdaq dump)
        cross_asset_reason: s.cross_asset_reason || null,
        // v7.10 — sector momentum (ETF 60j boost/cap)
        sector_reason: s.sector_reason || null,
        // v4.3 — stacking : si plusieurs patterns convergents
        stacked: s.stacked === true,
        stacked_count: s.stacked_count || null,
        stacked_patterns: Array.isArray(s.stacked_patterns) ? s.stacked_patterns : null,
        // v2.86 — news context attaché si l'actif a des news <48h
        news_context: buildNewsContext(s, newsMatches),
        // v8.8 — Wisdom : ajustement quality_score selon top analog historique
        wisdom_adjustment: s.wisdom_adjustment || 0,
        wisdom_note: s.wisdom_note || null,
        historical_analog: s.historical_analog || null,
        quality_score_pre_wisdom: s.quality_score_pre_wisdom || null,
      })),
    };
  });

  // v2.56/v2.60 — Statistiques "Recommandations du jour" basées sur notre analyseur ULTRA FIABLE
  const recommended = {
    count: setupsAll.length,
    byKind: { index: 0, crypto: 0, action: 0, forex: 0, metal: 0 },
    byConfidence: { 'very-high': 0, high: 0, medium: 0 },
    assets: setupsAll.map(s => ({
      label: s.asset, kind: s.kind, type: s.type, label_setup: s.label,
      confidence: s.confidence || 'medium', direction: s.direction, rr2: s.rr2,
    })),
  };
  setupsAll.forEach(s => {
    recommended.byKind[s.kind] = (recommended.byKind[s.kind] || 0) + 1;
    recommended.byConfidence[s.confidence] = (recommended.byConfidence[s.confidence] || 0) + 1;
  });
  // Verdict global cohérent avec le nombre d'opportunités détectées
  let opportunityVerdict;
  if (setupsAll.length === 0) opportunityVerdict = { cls: 'neutral', label: 'Aucune opportunité claire aujourd\'hui', desc: 'Notre analyseur n\'a détecté aucun setup propre passant les filtres ultra-fiables. Patience : un signal clean arrive toujours.' };
  else if (setupsAll.length === 1) opportunityVerdict = { cls: 'neutral', label: '1 opportunité détectée', desc: 'Un seul actif présente une configuration alignée selon notre analyseur — sélectivité maximale.' };
  else if (setupsAll.length <= 3) opportunityVerdict = { cls: 'bull-soft', label: setupsAll.length + ' opportunités détectées', desc: 'Marché offrant quelques setups propres. Profil sélectif favorable.' };
  else opportunityVerdict = { cls: 'bull', label: setupsAll.length + ' opportunités détectées', desc: 'Plusieurs actifs alignés simultanément — contexte large favorable aux acheteurs trend-follow.' };
  recommended.opportunityVerdict = opportunityVerdict;

  const prompt = buildPrompt(valid);
  const ai = await generateStudy(prompt, valid);

  // Verdict moyen pour la card
  const scores = valid.map((a) => a.score);
  const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const avgCls = avgScore >= 60 ? 'bull' : avgScore <= 40 ? 'bear' : 'neutral';
  const avgLabel =
    avgScore >= 75 ? 'Haussier fort' :
    avgScore >= 60 ? 'Plutôt haussier' :
    avgScore >= 45 ? 'Indécis' :
    avgScore >= 30 ? 'Plutôt baissier' : 'Baissier fort';

  const now = new Date();
  // Nettoyage : on ne stocke pas les indRaw ni prices dans le JSON public
  const assetsClean = valid.map(a => ({
    label: a.label, kind: a.kind, price: a.price, change: a.change,
    rsi: a.rsi, maCross: a.maCross, macdHist: a.macdHist, boll: a.boll,
    adx: a.adx, atr: a.atr, verdict: a.verdict, score: a.score, cls: a.cls,
  }));

  const out = {
    generated: now.toISOString(),
    source: process.env.GROQ_API_KEY ? 'Groq · llama-3.3-70b' : 'Pollinations · openai',
    date: now.toISOString().slice(0, 10),
    title: ai.title || 'Étude IA du jour',
    summary: ai.summary || '',
    observations: Array.isArray(ai.observations) ? ai.observations.slice(0, 6) : [],
    plan_pedago: Array.isArray(ai.plan_pedago) ? ai.plan_pedago.slice(0, 5) : [],
    verdict: { score: avgScore, cls: avgCls, label: avgLabel },
    // v2.56 — Recommandations chiffrées issues de l'analyseur ULTRA FIABLE
    recommended: recommended,
    // v2.67 — 4 agents IA avec profils de risque distincts
    agents: agentsOutput,
    assets: assetsClean,
    // v2.44 — liste de TOUS les setups propices (1 par actif max)
    // v2.54 — confidence exposée
    // v2.61 — prices60 pour rendu graph SVG
    setups: setupsAll.map(s => ({
      asset: s.asset, kind: s.kind, type: s.type, label: s.label,
      timeframe: s.timeframe || null, confidence: s.confidence || 'medium',
      direction: s.direction, config: s.config, rationale: s.rationale,
      entry: s.entry, stop: s.stop, tp1: s.tp1, tp2: s.tp2,
      rr1: s.rr1, rr2: s.rr2, currency: s.currency,
      prices60: Array.isArray(s.prices60) ? s.prices60.map(p => Number(p.toFixed(4))) : null,
      // v2.86 — news context attaché si l'actif a des news <48h
      news_context: buildNewsContext(s, newsMatches),
      // v8.8 — Wisdom (historical analog) si déjà calculé sur le setup
      wisdom_adjustment: s.wisdom_adjustment || 0,
      historical_analog: s.historical_analog || null,
    })),
    // v2.86 — Compteur global de news croisées
    news_summary: {
      window_news: recentNews.length,
      matched_assets: newsMatchCount,
    },
    // v4.2-4.9 — Contexte macro complet : VIX, DXY, cross-asset, macro event
    macro: {
      ...macroCtx,
      cross_asset: crossSignal,
      next_event: macroEvent,
    },
    // v8.8 — WISDOM ENGINE : lecture marché + match historique 30 ans
    market_reading: {
      current_state: currentMarketState,
      dominant_themes: dominantThemes,
      theme_counts: newsThemesMap,
      top_sectors_60d: topSectors,
      historical_analogs: historicalAnalogs.map(a => ({
        id: a.id,
        name: a.name,
        date: a.date,
        category: a.category,
        similarity: a.similarity,
        lesson: a.lesson,
        market_response: a.market_response,
      })),
      top_analog: topAnalog ? {
        name: topAnalog.name,
        year: topAnalog.date.slice(0, 4),
        similarity: topAnalog.similarity,
        lesson: topAnalog.lesson,
      } : null,
      ia_priorities: Object.fromEntries(
        Object.entries(wisdomAdjustments).map(([k, v]) => [
          ({ atlas: 'BASTION', nova: 'PHÉNIX', kairo: 'RAFALE', multi: 'NEXUS', volt: 'VOLT', alpha: 'ALPHA' })[k] || k,
          { adjustment: v.adjustment, note: v.note },
        ])
      ),
    },
    // v9.0 — NEWS INTELLIGENCE : signaux additionnels exposés à l'UI
    news_intel: {
      ma_events: maEvents.slice(0, 10).map(e => ({
        asset: e.asset, kind: e.kind, title: e.title, url: e.url, source: e.source,
      })),
      ma_count: maEvents.length,
      fear_greed: fearGreed,
      seasonality,
      tech_events_upcoming: techEvents,
      enriched_themes: enrichedThemes,
      etf_flows: etfFlows,
      geo_risk: geoRisk,
      earnings_top_beats: [...earningsResultsMap.entries()]
        .filter(([, r]) => r.surprisePct > 5)
        .sort((a, b) => b[1].surprisePct - a[1].surprisePct)
        .slice(0, 10)
        .map(([asset, r]) => ({ asset, surprisePct: Number(r.surprisePct.toFixed(1)), consecutiveBeats: r.consecutiveBeats })),
      insider_top_buys: [...insiderMap.entries()]
        .filter(([, r]) => r.netRatio > 0.7 && r.buyValue > 100000)
        .sort((a, b) => b[1].buyValue - a[1].buyValue)
        .slice(0, 10)
        .map(([asset, r]) => ({ asset, buyValue: r.buyValue, netRatio: Number(r.netRatio.toFixed(2)) })),
      short_squeeze_candidates: [...shortMap.entries()]
        .filter(([, r]) => r.shortPercentOfFloat > 0.15)
        .sort((a, b) => b[1].shortPercentOfFloat - a[1].shortPercentOfFloat)
        .slice(0, 10)
        .map(([asset, r]) => ({ asset, shortPct: Number((r.shortPercentOfFloat * 100).toFixed(1)), daysToCover: r.shortRatio })),
    },
    // v7.2 — MARKET SNAPSHOT : état des 134 actifs analysés pour heatmap UI
    // Léger : juste label/kind/rsi/change/verdict (pas les prices)
    market_snapshot: valid.map(a => ({
      label: a.label,
      kind: a.kind,
      rsi: Number(a.rsi) || null,
      change: Number(a.change) || 0,
      adx: Number(a.adx) || null,
      verdict: a.verdict,
      cls: a.cls,
      score: a.score,
    })),
    // Retro-compat : setup principal (meilleure confidence + R/R)
    setup: bestSetup ? {
      asset: bestSetup.asset, kind: bestSetup.kind, type: bestSetup.type,
      label: bestSetup.label, timeframe: bestSetup.timeframe || null,
      confidence: bestSetup.confidence || 'medium',
      direction: bestSetup.direction, config: bestSetup.config,
      rationale: bestSetup.rationale, entry: bestSetup.entry, stop: bestSetup.stop,
      tp1: bestSetup.tp1, tp2: bestSetup.tp2, rr1: bestSetup.rr1, rr2: bestSetup.rr2,
      currency: bestSetup.currency,
      prices60: Array.isArray(bestSetup.prices60) ? bestSetup.prices60.map(p => Number(p.toFixed(4))) : null,
    } : null,
    disclaimer: "Cas pédagogique basé sur l'analyse technique — pas un conseil en investissement personnalisé. Les marchés financiers comportent un risque de perte en capital. Tu décides si tu copies ce plan ou pas.",
  };

  const target = path.join(process.cwd(), 'data', 'ai-study.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`Wrote AI study (source: ${out.source}, score ${avgScore}/100)`);
  console.log('Title:', out.title);
}

main().catch((e) => {
  console.error('build-ai-study.mjs failed:', e);
  process.exit(1);
});
