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
  computeAllIndicators, globalVerdict,
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
    price: a.price,
    change: change.toFixed(2),
    rsi: ind.rsi?.value.toFixed(0),
    maCross: ind.maCross?.signal,
    macdHist: ind.macd?.value.toFixed(2),
    boll: ind.boll ? (ind.boll.value * 100).toFixed(0) + '%' : null,
    adx: ind.adx?.value.toFixed(0),
    atr: ind.atr ? ind.atr.value.toFixed(1) + '%' : null,
    verdict: v.label,
    score: v.score,
    cls: v.cls,
  };
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

async function generateStudy(prompt) {
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try { return parseAIResponse(await callGroq(prompt, groqKey)); }
    catch (e) { console.warn('Groq failed, fallback Pollinations:', e.message); }
  }
  return parseAIResponse(await callPollinations(prompt));
}

async function main() {
  console.log('Building AI study…');
  const results = await Promise.all(ASSETS.map(fetchOne));
  const valid = results.filter(Boolean).map(summarizeAsset).filter(Boolean);
  if (valid.length === 0) {
    throw new Error('No asset data available — abort');
  }

  const prompt = buildPrompt(valid);
  const ai = await generateStudy(prompt);

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
  const out = {
    generated: now.toISOString(),
    source: process.env.GROQ_API_KEY ? 'Groq · llama-3.3-70b' : 'Pollinations · openai',
    date: now.toISOString().slice(0, 10),
    title: ai.title || 'Étude IA du jour',
    summary: ai.summary || '',
    observations: Array.isArray(ai.observations) ? ai.observations.slice(0, 6) : [],
    plan_pedago: Array.isArray(ai.plan_pedago) ? ai.plan_pedago.slice(0, 5) : [],
    verdict: { score: avgScore, cls: avgCls, label: avgLabel },
    assets: valid,
    disclaimer: "Analyse pédagogique générée par IA — pas un conseil en investissement personnalisé. Les marchés financiers comportent un risque de perte en capital.",
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
