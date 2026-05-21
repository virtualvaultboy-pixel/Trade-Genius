#!/usr/bin/env node
/**
 * Trade Genius — Génère data/econ-calendar.json
 *
 * Récupère les événements économiques majeurs des 14 prochains jours.
 * Source : Trading Economics RSS (gratuit, sans clé)
 *
 * Output : data/econ-calendar.json — liste structurée avec date, pays,
 * événement, impact (high/medium/low).
 *
 * Tourne 1x/jour via GitHub Actions.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

// v2.68 — Liste hardcodée des événements clés récurrents
// (NFP = 1er vendredi du mois, FOMC = 8 réunions/an, BCE = 8 réunions/an)
// Pour une version vraiment dynamique : scraper Trading Economics ou utiliser
// FRED API (gratuit pour FED). En attendant, on a une base utile.

function nextFirstFriday(after) {
  const d = new Date(after);
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  return d;
}

function generateRecurrentEvents() {
  const now = new Date();
  const horizon = new Date(now); horizon.setDate(horizon.getDate() + 30);
  const out = [];

  // NFP — 1er vendredi du mois 14h30 UTC
  const nfp1 = nextFirstFriday(now);
  if (nfp1 <= horizon) {
    nfp1.setUTCHours(13, 30, 0, 0); // ~14h30 Paris
    out.push({
      ts: nfp1.toISOString(), country: '🇺🇸', label: 'NFP (Emploi US)',
      impact: 'high',
      desc: 'Rapport mensuel sur l\'emploi américain. Forte volatilité sur l\'USD, les indices US et l\'or.',
    });
  }

  // FOMC — dates approximatives 2026 (à ajuster manuellement chaque année)
  const fomcDates2026 = ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-11-04', '2026-12-16'];
  fomcDates2026.forEach(d => {
    const dt = new Date(d + 'T19:00:00Z');
    if (dt >= now && dt <= horizon) {
      out.push({
        ts: dt.toISOString(), country: '🇺🇸', label: 'Décision FOMC (taux Fed)',
        impact: 'high',
        desc: 'Annonce de la décision sur les taux directeurs de la Fed. Impact majeur sur tous les actifs USD, crypto et indices.',
      });
    }
  });

  // BCE — dates approximatives 2026
  const ecbDates2026 = ['2026-01-22', '2026-03-12', '2026-04-30', '2026-06-04', '2026-07-23', '2026-09-10', '2026-10-29', '2026-12-17'];
  ecbDates2026.forEach(d => {
    const dt = new Date(d + 'T12:15:00Z');
    if (dt >= now && dt <= horizon) {
      out.push({
        ts: dt.toISOString(), country: '🇪🇺', label: 'Décision BCE (taux)',
        impact: 'high',
        desc: 'Annonce de la décision sur les taux directeurs de la BCE. Impact majeur sur l\'EUR, les indices européens et les actions EU.',
      });
    }
  });

  // CPI US — 2ème mardi/mercredi du mois 14h30
  const cpiBase = new Date(now);
  cpiBase.setDate(1);
  cpiBase.setMonth(cpiBase.getMonth() + 1);
  while (cpiBase.getDay() !== 2) cpiBase.setDate(cpiBase.getDate() + 1);
  cpiBase.setDate(cpiBase.getDate() + 7); // 2e mardi
  cpiBase.setUTCHours(13, 30, 0, 0);
  if (cpiBase >= now && cpiBase <= horizon) {
    out.push({
      ts: cpiBase.toISOString(), country: '🇺🇸', label: 'CPI US (inflation)',
      impact: 'high',
      desc: 'Indice des prix à la consommation US. Impact direct sur les anticipations de taux Fed → volatilité USD/crypto/indices.',
    });
  }

  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

async function main() {
  console.log('Building econ calendar…');
  const events = generateRecurrentEvents();
  const now = new Date();
  const out = {
    generated: now.toISOString(),
    horizon_days: 14,
    events,
    count: events.length,
  };
  const target = path.join(process.cwd(), 'data', 'econ-calendar.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('Wrote econ calendar (' + events.length + ' events in 14 days)');
}

main().catch((e) => {
  console.error('build-econ-calendar.mjs failed:', e);
  process.exit(1);
});
