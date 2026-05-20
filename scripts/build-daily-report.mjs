#!/usr/bin/env node
/**
 * Trade Genius — Génère data/daily.json
 * Rapport journalier auto : prix, change %, verdict simple pour les
 * principaux indices et crypto. Tourne tous les soirs à 22h UTC
 * (après clôture US) via .github/workflows/daily-report.yml.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchYahooHistorical, fetchCoinGeckoHistorical, rsi } from './indicators.mjs';

const ASSETS = [
  { kind: 'index',  symbol: '^GSPC', label: 'S&P 500',  name: 'S&P 500' },
  { kind: 'index',  symbol: '^IXIC', label: 'Nasdaq',   name: 'Nasdaq Composite' },
  { kind: 'index',  symbol: '^FCHI', label: 'CAC 40',   name: 'CAC 40' },
  { kind: 'index',  symbol: '^DJI',  label: 'Dow',      name: 'Dow Jones' },
  { kind: 'crypto', id: 'bitcoin',   label: 'BTC',      name: 'Bitcoin' },
  { kind: 'crypto', id: 'ethereum',  label: 'ETH',      name: 'Ethereum' },
];

function pct(price, prev) {
  if (price == null || prev == null || prev === 0) return 0;
  return ((price - prev) / prev) * 100;
}
function verdictFromRsiChange(r, change) {
  if (change > 2) return r > 70 ? 'overheated' : 'bull';
  if (change < -2) return r < 30 ? 'oversold' : 'bear';
  if (change > 0.3) return 'bull-soft';
  if (change < -0.3) return 'bear-soft';
  return 'flat';
}
const VERDICT_LABELS = {
  'overheated': '↑ haussier mais surchauffe',
  'bull': '↑ haussier net',
  'bull-soft': '↗ légère hausse',
  'flat': '→ stable',
  'bear-soft': '↘ légère baisse',
  'bear': '↓ baissier net',
  'oversold': '↓ baissier survendu',
};

async function fetchOne(a) {
  try {
    if (a.kind === 'index') {
      const d = await fetchYahooHistorical(a.symbol, '1mo');
      return { ...a, prices: d.prices, price: d.price, prevClose: d.prevClose, currency: d.currency };
    }
    const d = await fetchCoinGeckoHistorical(a.id, 30);
    return { ...a, prices: d.prices, price: d.price, prevClose: d.prevClose, currency: 'USD' };
  } catch (e) {
    console.warn(`Skipping ${a.label}:`, e.message);
    return null;
  }
}

function buildHighlight(asset, change, verdict) {
  const arrow = change >= 0 ? '+' : '';
  const tag = VERDICT_LABELS[verdict] || '→';
  return `${asset.label} ${arrow}${change.toFixed(2)}% · ${tag}`;
}

function buildSummary(items) {
  const ups = items.filter(i => i.change > 0.3);
  const downs = items.filter(i => i.change < -0.3);
  if (ups.length >= 4) return 'Séance largement positive sur les principaux indices et la crypto.';
  if (downs.length >= 4) return 'Séance largement négative — tous les actifs majeurs reculent.';
  if (ups.length > downs.length) return 'Plus de hausses que de baisses sur la journée, mais sans direction unanime.';
  if (downs.length > ups.length) return 'Plus de baisses que de hausses sur la journée, biais vendeur modéré.';
  return 'Séance partagée : pas de direction nette du marché aujourd\'hui.';
}

async function main() {
  console.log('Building daily report…');
  const results = await Promise.all(ASSETS.map(fetchOne));
  const items = results
    .filter(Boolean)
    .map(a => {
      const change = pct(a.price, a.prevClose);
      const r = rsi(a.prices) || 50;
      const verdict = verdictFromRsiChange(r, change);
      return {
        kind: a.kind,
        symbol: a.label,
        name: a.name,
        price: a.price,
        change,
        rsi: Number(r.toFixed(1)),
        verdict,
        verdictLabel: VERDICT_LABELS[verdict],
        currency: a.currency || 'USD',
      };
    });

  const out = {
    generated: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    title: `Rapport du ${new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`,
    summary: buildSummary(items),
    highlights: items.map(it => buildHighlight(it, it.change, it.verdict)),
    items,
  };

  const target = path.join(process.cwd(), 'data', 'daily.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${items.length} items to data/daily.json`);
  console.log('Summary:', out.summary);
}

main().catch(e => {
  console.error('build-daily-report.mjs failed:', e);
  process.exit(1);
});
