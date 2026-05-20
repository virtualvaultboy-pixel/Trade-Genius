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

const ASSETS = [
  { kind: 'index',  symbol: '^GSPC', label: 'S&P 500' },
  { kind: 'index',  symbol: '^IXIC', label: 'Nasdaq' },
  { kind: 'index',  symbol: '^FCHI', label: 'CAC 40' },
  { kind: 'crypto', id: 'bitcoin',   label: 'BTC' },
  { kind: 'crypto', id: 'ethereum',  label: 'ETH' },
];

async function fetchOne(a) {
  try {
    if (a.kind === 'index') {
      const d = await fetchYahooHistorical(a.symbol, '3mo');
      return { ...a, prices: d.prices, price: d.price, prevClose: d.prevClose };
    }
    const d = await fetchCoinGeckoHistorical(a.id, 60);
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
function detectSetup(a) {
  if (!a || !a.indRaw || !a.atrAbs) return null;
  const ind = a.indRaw;
  const last = a.prices[a.prices.length - 1];
  const atr = a.atrAbs;
  const rsi = ind.rsi?.value;
  const adx = ind.adx?.value || 0;

  // Setup 1 : Rebond survente (RSI <30, Bollinger bande basse)
  if (rsi != null && rsi < 32 && ind.boll && ind.boll.value < 0.18) {
    const entry = last;
    const stop = entry - 1.2 * atr;
    // TP1 = retour vers MA20 (mean reversion) MAIS clamped pour rester < TP2
    const tp1Raw = ind.ma20?.value || (entry + 1.5 * atr);
    const tp2 = entry + 3 * atr;
    const tp1 = Math.min(tp1Raw, tp2 * 0.95); // garantit TP1 < TP2
    return {
      type: 'rebond-survente',
      label: 'Rebond technique sur survente',
      config: 'RSI ' + rsi.toFixed(0) + ' (zone survente) + prix sur bande basse de Bollinger. Configuration que les traders contrarians surveillent.',
      entry, stop, tp1, tp2,
      rr1: ((tp1 - entry) / (entry - stop)).toFixed(2),
      rr2: ((tp2 - entry) / (entry - stop)).toFixed(2),
      rationale: 'Le couple RSI<30 + bande basse Bollinger marque historiquement des zones de rebond technique. Le stop sous le swing low + 1.2 ATR protège contre la continuation. Cible 1 = retour vers la MA20 (mean reversion). Cible 2 = +3 ATR.',
      direction: 'long',
    };
  }

  // Setup 2 : Pullback haussier (prix > MA50, MA20 > MA50, RSI 40-60, MACD ≥ 0)
  if (ind.maCross?.signal === 'bull' && rsi != null && rsi >= 38 && rsi <= 62 && ind.macd?.value >= 0 && adx > 18) {
    const entry = last;
    const stop = entry - 1.5 * atr;
    const tp1 = entry + 1.5 * atr;
    const tp2 = entry + 3 * atr;
    return {
      type: 'pullback-haussier',
      label: 'Pullback dans une tendance haussière',
      config: 'MA20 > MA50 (tendance MT haussière) · RSI ' + rsi.toFixed(0) + ' (neutre, pas surchauffé) · MACD positif · ADX ' + adx.toFixed(0) + ' (tendance présente).',
      entry, stop, tp1, tp2,
      rr1: ((tp1 - entry) / (entry - stop)).toFixed(2),
      rr2: ((tp2 - entry) / (entry - stop)).toFixed(2),
      rationale: 'Schéma classique : tendance haussière confirmée par les MA + momentum sain (RSI neutre) + MACD au-dessus de zéro. Stop technique à 1.5 ATR pour absorber le bruit. Cibles symétriques 1.5 et 3 ATR (R/R 1:1 et 1:2).',
      direction: 'long',
    };
  }

  // Setup 3 : Breakout haussier (RSI > 55, prix > Bollinger upper après compression)
  if (rsi != null && rsi > 55 && ind.boll && ind.boll.value > 0.85 && ind.atr && ind.atr.value < 4 && adx > 20) {
    const entry = last;
    const stop = entry - 2 * atr;
    const tp1 = entry + 2 * atr;
    const tp2 = entry + 4 * atr;
    return {
      type: 'breakout-haussier',
      label: 'Cassure haussière sur volatilité contractée',
      config: 'Prix sur bande haute de Bollinger après période de compression (ATR ' + ind.atr.value.toFixed(1) + '%). RSI ' + rsi.toFixed(0) + ' · ADX ' + adx.toFixed(0) + ' (force confirmée).',
      entry, stop, tp1, tp2,
      rr1: ((tp1 - entry) / (entry - stop)).toFixed(2),
      rr2: ((tp2 - entry) / (entry - stop)).toFixed(2),
      rationale: 'Après une phase de compression (ATR bas), une cassure de la bande haute marque souvent le début d\'une nouvelle phase directionnelle. Le stop sous le niveau de cassure + 2 ATR évite les faux signaux. Cibles symétriques R/R 1:1 et 1:2.',
      direction: 'long',
    };
  }

  // Pas de setup clair : marche en range ou signaux contradictoires
  return null;
}

function priceFmt(p, kind) {
  if (p == null) return '—';
  if (p >= 10000) return Math.round(p).toLocaleString('fr-FR');
  if (p >= 100) return p.toFixed(0);
  if (p >= 1) return p.toFixed(2);
  return p.toFixed(4);
}

function buildPrompt(assets) {
  const table = assets
    .map((a) => `${a.label}: prix ${a.price?.toFixed(2)} (${a.change}%) · RSI ${a.rsi} · MA ${a.maCross} · MACD histo ${a.macdHist} · Bollinger ${a.boll} · ADX ${a.adx} · ATR ${a.atr} → verdict ${a.verdict} (${a.score}/100)`)
    .join('\n');

  return `Tu es analyste technique pour une app pédagogique de bourse (Trade Genius). Tu écris en français pour des débutants/intermédiaires.

CONTEXTE — données techniques d'aujourd'hui :
${table}

CONSIGNES :
1. Écris une analyse pédagogique synthétique (max 200 mots) qui présente la situation technique générale.
2. Ne dis JAMAIS "achète", "vends", "il faut" — c'est interdit (cadre légal AMF français).
3. Utilise plutôt : "on observe", "schéma classique", "un trader expérimenté surveillerait", "à considérer".
4. Mentionne 2-3 actifs spécifiques avec leur lecture technique.
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

  const head = valid.slice(0, 3).map(a =>
    `${a.label} ${a.change > 0 ? '+' : ''}${a.change}% (RSI ${a.rsi}, ${a.verdict.toLowerCase()})`
  ).join(' · ');

  const summary = `Sur les 5 actifs majeurs suivis aujourd'hui : ${head}. ` +
    `Globalement, ${bullN} actifs en biais haussier contre ${bearN} en baissier. ` +
    `On observe une configuration ${bullN > bearN ? 'plutôt favorable aux acheteurs' : bearN > bullN ? 'plutôt favorable aux vendeurs' : 'partagée sans direction claire'}. ` +
    `Un trader expérimenté surveillerait surtout les zones de surachat (RSI > 70) ou de survente (RSI < 30) pour timing un entry, ainsi que la position du prix par rapport à la MA50 pour situer la tendance moyen terme.`;

  const observations = valid.slice(0, 4).map(a => {
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
  const setupsAll = valid
    .map(a => {
      const s = detectSetup(a);
      if (!s) return null;
      return {
        ...s,
        asset: a.label,
        kind: a.kind,
        score: a.score,
        currency: a.kind === 'crypto' || a.label === 'S&P 500' || a.label === 'Nasdaq' || a.label === 'Dow' ? 'USD' : 'EUR',
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.rr2) - Number(a.rr2));
  // Setup principal (pour rétrocompat) = celui avec meilleur R/R
  const bestSetup = setupsAll[0] || null;

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
    assets: assetsClean,
    // v2.44 — liste de TOUS les setups propices (1 par actif max)
    setups: setupsAll.map(s => ({
      asset: s.asset, kind: s.kind, type: s.type, label: s.label,
      direction: s.direction, config: s.config, rationale: s.rationale,
      entry: s.entry, stop: s.stop, tp1: s.tp1, tp2: s.tp2,
      rr1: s.rr1, rr2: s.rr2, currency: s.currency,
    })),
    // Retro-compat : setup principal (le meilleur R/R)
    setup: bestSetup ? {
      asset: bestSetup.asset, kind: bestSetup.kind, type: bestSetup.type,
      label: bestSetup.label, direction: bestSetup.direction, config: bestSetup.config,
      rationale: bestSetup.rationale, entry: bestSetup.entry, stop: bestSetup.stop,
      tp1: bestSetup.tp1, tp2: bestSetup.tp2, rr1: bestSetup.rr1, rr2: bestSetup.rr2,
      currency: bestSetup.currency,
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
