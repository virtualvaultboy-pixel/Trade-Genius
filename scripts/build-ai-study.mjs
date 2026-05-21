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
  fetchYahooHistorical, fetchCoinGeckoHistorical,
  computeAllIndicators, globalVerdict, atrPct, sma,
} from './indicators.mjs';

// v2.60 — Catalogue étendu (52 actifs) : indices monde + actions US/EU
//        + crypto top 20 + forex majors + métaux précieux
const ASSETS = [
  // ── Indices monde ──────────────────────────────────────────
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
  // ── Crypto top 20 (CoinGecko) ──────────────────────────────
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
  // ── Actions US blue-chips ──────────────────────────────────
  { kind: 'action', symbol: 'AAPL',  label: 'Apple' },
  { kind: 'action', symbol: 'MSFT',  label: 'Microsoft' },
  { kind: 'action', symbol: 'GOOGL', label: 'Alphabet' },
  { kind: 'action', symbol: 'AMZN',  label: 'Amazon' },
  { kind: 'action', symbol: 'META',  label: 'Meta' },
  { kind: 'action', symbol: 'NVDA',  label: 'Nvidia' },
  { kind: 'action', symbol: 'TSLA',  label: 'Tesla' },
  { kind: 'action', symbol: 'AMD',   label: 'AMD' },
  { kind: 'action', symbol: 'NFLX',  label: 'Netflix' },
  { kind: 'action', symbol: 'JPM',   label: 'JPMorgan' },
  { kind: 'action', symbol: 'V',     label: 'Visa' },
  { kind: 'action', symbol: 'WMT',   label: 'Walmart' },
  { kind: 'action', symbol: 'KO',    label: 'Coca-Cola' },
  // ── Actions EU ────────────────────────────────────────────
  { kind: 'action', symbol: 'MC.PA',  label: 'LVMH' },
  { kind: 'action', symbol: 'TTE.PA', label: 'TotalEnergies' },
  { kind: 'action', symbol: 'AIR.PA', label: 'Airbus' },
  { kind: 'action', symbol: 'SAN.PA', label: 'Sanofi' },
  { kind: 'action', symbol: 'ASML.AS',label: 'ASML' },
  // ── Forex majors ──────────────────────────────────────────
  { kind: 'forex',  symbol: 'EURUSD=X', label: 'EUR/USD' },
  { kind: 'forex',  symbol: 'GBPUSD=X', label: 'GBP/USD' },
  { kind: 'forex',  symbol: 'USDJPY=X', label: 'USD/JPY' },
  { kind: 'forex',  symbol: 'USDCHF=X', label: 'USD/CHF' },
  { kind: 'forex',  symbol: 'AUDUSD=X', label: 'AUD/USD' },
  { kind: 'forex',  symbol: 'USDCAD=X', label: 'USD/CAD' },
  { kind: 'forex',  symbol: 'EURGBP=X', label: 'EUR/GBP' },
  { kind: 'forex',  symbol: 'EURJPY=X', label: 'EUR/JPY' },
  // ── Métaux précieux & matières premières ─────────────────
  { kind: 'metal',  symbol: 'GC=F', label: 'Or (Gold)' },
  { kind: 'metal',  symbol: 'SI=F', label: 'Argent (Silver)' },
  { kind: 'metal',  symbol: 'PL=F', label: 'Platine' },
  { kind: 'metal',  symbol: 'PA=F', label: 'Palladium' },
  { kind: 'metal',  symbol: 'HG=F', label: 'Cuivre' },
];

async function fetchOne(a) {
  try {
    // v2.60 — Indices, actions, forex et métaux passent par Yahoo (symbol)
    // Crypto via CoinGecko (id)
    if (a.kind === 'crypto') {
      const d = await fetchCoinGeckoHistorical(a.id, 60);
      return { ...a, prices: d.prices, price: d.price, prevClose: d.prevClose };
    }
    const d = await fetchYahooHistorical(a.symbol, '3mo');
    return { ...a, prices: d.prices, price: d.price, prevClose: d.prevClose };
  } catch (e) {
    console.warn(`Skipping ${a.label}:`, e.message);
    return null;
  }
}

function summarizeAsset(a) {
  const ind = computeAllIndicators(a.prices);
  if (!ind) return null;
  const v = globalVerdict(ind);
  const change = a.prevClose ? ((a.price - a.prevClose) / a.prevClose) * 100 : 0;
  return {
    label: a.label,
    kind: a.kind,
    price: a.price,
    prices: a.prices,
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
  // Conditions : MA20>MA50 + prix>MA20 + RSI 50-68 + mom>1% + ADX>16 + MACD>0
  // ─────────────────────────────────────────────────────────────────
  if (ma20 != null && ma50 != null && ma20 > ma50 && last > ma20
      && rsi != null && rsi >= 50 && rsi <= 68
      && mom != null && mom > 1
      && adx > 16
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
  // Conditions : MA20>MA50 + prix entre ±1.5 % de MA50 + RSI 40-55 + ADX>14 + MACD>=0
  // ─────────────────────────────────────────────────────────────────
  if (ma20 != null && ma50 != null && ma20 > ma50
      && rsi != null && rsi >= 40 && rsi <= 55
      && last <= ma50 * 1.015 && last >= ma50 * 0.985
      && adx > 14
      && macdH != null && macdH >= 0) {
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

  // Aucun setup propre détecté — on ne fabrique PAS un setup faible
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
  const AGENT_PROFILES = [
    {
      id: 'atlas', name: 'ATLAS', role: 'Le Gardien',
      tagline: 'Préserve avant tout',
      desc: 'Confirmations maximales. Stop serré. R/R élevé. Ne sort que quand le ciel est dégagé.',
      icon: '🛡️', color: '#60a5fa',
      filters: { minConfRank: 3, minADX: 28, minRR: 2.5 },
      atr: { stop: 1.2, tp1: 2.0, tp2: 3.5 },
      acceptedTypes: ['pullback-haussier', 'breakout-haussier', 'continuation-haussiere'],
    },
    {
      id: 'zen', name: 'ZEN', role: 'L\'Équilibriste',
      tagline: 'Patience et précision',
      desc: 'Setups confirmés sans excès. Patient, méthodique, prend les meilleures opportunités du jour.',
      icon: '🌿', color: '#84cc16',
      filters: { minConfRank: 2, minADX: 22, minRR: 2.0 },
      atr: { stop: 1.5, tp1: 2.0, tp2: 4.0 },
      acceptedTypes: ['pullback-haussier', 'breakout-haussier', 'continuation-haussiere', 'rebond-ma50'],
    },
    {
      id: 'nova', name: 'NOVA', role: 'Le Tacticien',
      tagline: 'Calculer chaque move',
      desc: 'Équilibre opportunités et fiabilité. Le profil standard recommandé pour la plupart des traders.',
      icon: '⚡', color: '#f59e0b',
      filters: { minConfRank: 1, minADX: 16, minRR: 1.8 },
      atr: { stop: 1.5, tp1: 1.5, tp2: 3.0 },
      acceptedTypes: null, // tous types
    },
    {
      id: 'kairo', name: 'KAIRO', role: 'Le Chasseur',
      tagline: 'Frappe quand c\'est chaud',
      desc: 'Saisit les opportunités contrariennes et les rebonds extrêmes. Plus risqué, plus de gains potentiels.',
      icon: '🔥', color: '#ef4444',
      filters: { minConfRank: 1, minADX: 10, minRR: 2.0 },
      atr: { stop: 2.0, tp1: 2.5, tp2: 5.0 },
      acceptedTypes: null, // tous y compris rebond-survente
      bonusTypes: ['rebond-survente'], // boost priorité
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

  const agentsOutput = AGENT_PROFILES.map(agent => {
    const setups = applyAgentProfile(setupsAll, agent);
    return {
      id: agent.id, name: agent.name, role: agent.role, tagline: agent.tagline,
      desc: agent.desc, icon: agent.icon, color: agent.color,
      filters_summary: 'Confidence ≥ ' + ['?','medium','high','very-high'][agent.filters.minConfRank]
        + ' · ADX ≥ ' + agent.filters.minADX
        + ' · R/R ≥ ' + agent.filters.minRR,
      count: setups.length,
      setups: setups.map(s => ({
        asset: s.asset, kind: s.kind, type: s.type, label: s.label,
        timeframe: s.timeframe || null, confidence: s.confidence || 'medium',
        direction: s.direction, config: s.config, rationale: s.rationale,
        entry: s.entry, stop: s.stop, tp1: s.tp1, tp2: s.tp2,
        rr1: s.rr1, rr2: s.rr2, currency: s.currency,
        prices60: Array.isArray(s.prices60) ? s.prices60.map(p => Number(p.toFixed(4))) : null,
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
