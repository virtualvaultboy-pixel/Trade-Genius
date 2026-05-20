#!/usr/bin/env node
/**
 * Trade Genius — Génère data/decryptages.json
 * Décryptage hebdo auto-généré : fetch 60j d'historique des indices et
 * crypto, calcule 10 indicateurs + verdict global pondéré, génère
 * titre+méthode+lectures+conclusion par template. Tourne le dimanche
 * 18h UTC via .github/workflows/weekly-decryptage.yml.
 *
 * Archive : garde les 12 derniers décryptages dans le JSON.
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
  { kind: 'index',  symbol: '^DJI',  label: 'Dow' },
  { kind: 'crypto', id: 'bitcoin',   label: 'BTC' },
  { kind: 'crypto', id: 'ethereum',  label: 'ETH' },
];

function isoWeek(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
}

async function fetchOne(a) {
  try {
    if (a.kind === 'index') {
      const d = await fetchYahooHistorical(a.symbol, '3mo');
      return { ...a, prices: d.prices };
    }
    const d = await fetchCoinGeckoHistorical(a.id, 60);
    return { ...a, prices: d.prices };
  } catch (e) {
    console.warn(`Skipping ${a.label}:`, e.message);
    return null;
  }
}

function readingFromIndicators(ind, change5d) {
  const parts = [];
  if (ind.rsi != null) parts.push(`RSI ${ind.rsi.value.toFixed(0)}`);
  if (ind.maCross) parts.push(ind.maCross.signal === 'bull' ? 'MA20 > MA50' : 'MA20 < MA50');
  if (ind.macd != null) parts.push(ind.macd.signal === 'bull' ? 'MACD positif' : ind.macd.signal === 'bear' ? 'MACD négatif' : 'MACD plat');
  if (Math.abs(change5d) > 0.1) parts.push(`${change5d >= 0 ? '+' : ''}${change5d.toFixed(1)}% / 5j`);
  return parts.slice(0, 4).join(' · ');
}

function buildTitle(verdicts) {
  const bullN = verdicts.filter(v => v.cls === 'bull').length;
  const bearN = verdicts.filter(v => v.cls === 'bear').length;
  if (bullN >= 4) return 'Marchés portés · les hausses dominent';
  if (bearN >= 4) return 'Marchés sous pression · biais vendeur partout';
  if (bullN > bearN) return 'Marchés mitigés · biais haussier prudent';
  if (bearN > bullN) return 'Marchés mitigés · biais baissier prudent';
  return 'Marchés en pause · pas de direction nette';
}

function buildConclusion(verdicts) {
  const cumScore = Math.round(verdicts.reduce((a, v) => a + v.score, 0) / verdicts.length);
  if (cumScore >= 70) return '<strong class="bull">Vague haussière confirmée.</strong> Plus de 5 actifs majeurs sur 6 pointent dans la même direction, avec ADX qui valide la dynamique. À surveiller : les zones de surachat (RSI > 70) qui peuvent appeler une pause.';
  if (cumScore >= 55) return '<strong class="bull">Biais acheteur modéré.</strong> La majorité des outils signalent un environnement favorable, mais sans unanimité. La prudence reste de mise sur les zones tendues.';
  if (cumScore >= 45) return '<strong class="neutral">Marché sans conviction.</strong> Les outils sont partagés, aucun signal franc d\'un côté ou de l\'autre. Mieux vaut attendre une confirmation avant de prendre position.';
  if (cumScore >= 30) return '<strong class="bear">Biais vendeur modéré.</strong> Plus de signaux baissiers qu\'acheteurs. Les zones de survente (RSI < 30) peuvent provoquer des rebonds techniques mais la pression reste à la baisse.';
  return '<strong class="bear">Configuration baissière nette.</strong> La majorité des indicateurs pointent dans la même direction, prudence générale sur les positions longues.';
}

async function main() {
  console.log('Building weekly decryptage…');
  const results = await Promise.all(ASSETS.map(fetchOne));
  const valid = results.filter(Boolean);

  const lectures = valid.map(a => {
    const ind = computeAllIndicators(a.prices);
    const v = ind ? globalVerdict(ind) : null;
    const last = a.prices[a.prices.length - 1];
    const last5 = a.prices[a.prices.length - 6] || last;
    const change5d = ((last - last5) / last5) * 100;
    return {
      symbol: a.label,
      verdict: v,
      reading: ind ? readingFromIndicators(ind, change5d) : '—',
      change5d,
    };
  });

  // Verdict global de la semaine = moyenne des verdicts d'actifs
  const verdicts = lectures.filter(l => l.verdict).map(l => l.verdict);
  const avgScore = verdicts.length
    ? Math.round(verdicts.reduce((a, v) => a + v.score, 0) / verdicts.length)
    : 50;
  const cls = avgScore >= 60 ? 'bull' : avgScore <= 40 ? 'bear' : 'neutral';
  const label = avgScore >= 75 ? 'Haussier fort'
    : avgScore >= 60 ? 'Plutôt haussier'
    : avgScore >= 45 ? 'Indécis'
    : avgScore >= 30 ? 'Plutôt baissier'
    : 'Baissier fort';

  const now = new Date();
  const sem = isoWeek(now);

  const entry = {
    id: 'sem' + sem + '-' + now.getFullYear(),
    week: 'Sem. ' + sem,
    date: now.toISOString().slice(0, 10),
    title: buildTitle(verdicts),
    method: 'Lecture des 4 grands indices (S&P, Nasdaq, CAC, Dow) + 2 crypto majors (BTC, ETH) sur le tf daily. Agrégation des outils RSI · MA20/MA50 · MACD · Bollinger · ADX · ATR · Momentum.',
    verdict: { score: avgScore, cls, label },
    indicators: lectures.map(l => ({
      sym: l.symbol,
      read: l.reading,
      sig: l.verdict?.cls || 'neutral',
      val: l.verdict ? (l.verdict.label) : '—',
    })),
    conclusion: buildConclusion(verdicts),
    generated: now.toISOString(),
  };

  // Append + dedupe + keep last 12
  const target = path.join(process.cwd(), 'data', 'decryptages.json');
  let prev = { generated: null, entries: [] };
  try {
    const raw = await fs.readFile(target, 'utf8');
    prev = JSON.parse(raw);
    if (!Array.isArray(prev.entries)) prev.entries = [];
  } catch {}

  const filtered = prev.entries.filter(e => e.id !== entry.id);
  filtered.unshift(entry);
  const next = {
    generated: now.toISOString(),
    sources: ['Yahoo Finance', 'CoinGecko'],
    entries: filtered.slice(0, 12),
  };

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log(`Wrote decryptage ${entry.id} (${next.entries.length} total in archive)`);
  console.log('Verdict:', label, '·', avgScore + '/100');
}

main().catch(e => {
  console.error('build-weekly-decryptage.mjs failed:', e);
  process.exit(1);
});
