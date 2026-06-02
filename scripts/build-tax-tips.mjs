#!/usr/bin/env node
/**
 * Trade Genius — Tax tips auto (cible FR : PEA / CTO / crypto)
 *
 * Génère data/tax-tips.json avec les conseils fiscaux ACTIFS selon la date.
 * Cron quotidien. L'app lit et affiche les tips pertinents en haut du feed.
 *
 * Exemples de tips :
 *  - Décembre : tax-loss harvesting CTO (vendre les moins-values pour réduire impôt)
 *  - Avril/Mai : déclaration revenus de capitaux (IFU, formulaire 2042-C)
 *  - Septembre : début nouvelle année fiscale crypto (revente après plus-value cumulée)
 *  - Toute l'année : PEA = 5 ans pour éviter les prélèvements sociaux, etc.
 *
 * Source : règles fiscales FR 2026 (sans conseil personnalisé, pédago uniquement).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

// Liste exhaustive des tips fiscaux pour la cible FR.
// Chaque tip a : id, title, body, category, active_from, active_to (jour de l'année 1-365)
const ALL_TIPS = [
  {
    id: 'tlh-dec',
    category: 'cto',
    priority: 'high',
    title: '🍂 Tax-loss harvesting (CTO) — Décembre',
    body: 'En décembre, vendre les positions en moins-value de ton CTO permet de COMPENSER les plus-values déjà réalisées dans l\'année. Tu réduis ton impôt (PFU 30%) sans changer ton expo (rachat possible après J+30 sans wash-sale FR).',
    actionable: 'Vérifie tes positions CTO en moins-value avant le 31 décembre.',
    period: 'Novembre-Décembre',
    months_active: [11, 12],
  },
  {
    id: 'pea-5y',
    category: 'pea',
    priority: 'medium',
    title: '⏳ PEA : la règle des 5 ans',
    body: 'Tant que ton PEA a moins de 5 ans, tout retrait clôture le plan et tu paies les impôts. Après 5 ans : retraits libres, exonération d\'impôt (seuls 17.2% de prélèvements sociaux restent).',
    actionable: 'Ne touche pas à ton PEA avant ses 5 ans, sauf urgence.',
    period: 'Toute l\'année',
    months_active: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  },
  {
    id: 'ifu-april',
    category: 'declaration',
    priority: 'high',
    title: '📄 Déclaration revenus (IFU) — Avril-Mai',
    body: 'Ton broker FR (Trade Republic, BoursoBank...) génère un IFU (Imprimé Fiscal Unique) en mars. Reporte les montants dans la déclaration 2042 (cases 2DC, 3VG selon plus-values).',
    actionable: 'Récupère ton IFU dans l\'app du broker · check formulaire 2042.',
    period: 'Avril-Mai',
    months_active: [4, 5],
  },
  {
    id: 'crypto-pvmd',
    category: 'crypto',
    priority: 'medium',
    title: '🪙 Crypto : seuil 305€ de plus-value',
    body: 'En FR, les plus-values crypto < 305€/an sont exonérées d\'impôt. Au-delà : PFU 30% (12.8% IR + 17.2% PS). À déclarer via formulaire 2086.',
    actionable: 'Track ton P&L crypto réalisé · stay below 305€ si profil faible expo.',
    period: 'Toute l\'année',
    months_active: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  },
  {
    id: 'crypto-flat',
    category: 'crypto',
    priority: 'low',
    title: '💸 Crypto-to-crypto = pas d\'imposition',
    body: 'En FR, échanger une crypto contre une autre (BTC → ETH) ne déclenche PAS d\'imposition. Seule la conversion crypto → fiat (€/$) ou achat de biens en crypto crée un événement fiscal.',
    actionable: 'Profite des arbitrages BTC↔ETH↔stables sans impact fiscal.',
    period: 'Toute l\'année',
    months_active: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  },
  {
    id: 'pea-ceiling',
    category: 'pea',
    priority: 'low',
    title: '📊 PEA : plafond 150 000 € (225 000 € avec PEA-PME)',
    body: 'Plafond versement PEA = 150k€. Pour aller au-delà sans payer plein PFU : ouvre un PEA-PME (75k€ supplémentaires) ou un CTO complémentaire.',
    actionable: 'Si proche du plafond, demande PEA-PME à ton broker.',
    period: 'Toute l\'année',
    months_active: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  },
  {
    id: 'cto-flat-tax',
    category: 'cto',
    priority: 'medium',
    title: '⚖️ CTO : PFU 30% par défaut (option barème)',
    body: 'Sur ton CTO, les plus-values sont taxées au PFU 30% (12.8% IR + 17.2% PS). Si ta tranche marginale d\'imposition (TMI) est < 12.8%, tu peux opter pour le barème progressif lors de la déclaration.',
    actionable: 'Calcule ta TMI · si < 12.8%, coche option barème case 2OP.',
    period: 'Avril-Mai (lors de la déclaration)',
    months_active: [4, 5],
  },
  {
    id: 'av-life',
    category: 'pea',
    priority: 'low',
    title: '🛡️ Assurance-vie : 8 ans pour la fiscalité optimale',
    body: 'Après 8 ans : abattement de 4 600€/an (9 200€ couple) sur les retraits. Au-delà : PFU 7.5% pour les versements < 150k€ (vs 12.8% sur le CTO).',
    actionable: 'Pour les gros patrimoines, AV > 8 ans = meilleur outil de transmission.',
    period: 'Toute l\'année',
    months_active: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  },
];

// Pas de Math.random / Date.now en script pour reproductibilité — on prend l'env vars OK.
function currentMonth() {
  return new Date().getUTCMonth() + 1; // 1-12
}

async function main() {
  const month = currentMonth();
  const active = ALL_TIPS.filter(t => t.months_active.includes(month));
  // Tri : priority high → medium → low, puis category spécifique → général
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  active.sort((a, b) => (priorityOrder[a.priority] - priorityOrder[b.priority]));

  // On garde max 3 tips actifs pour ne pas surcharger le feed
  const top = active.slice(0, 3);

  const out = {
    generated: new Date().toISOString(),
    current_month: month,
    locale: 'FR',
    disclaimer: 'Informations fiscales pédagogiques 2026. Pas un conseil personnalisé. Consulte un expert-comptable pour ta situation.',
    n_tips_active: top.length,
    n_tips_total: ALL_TIPS.length,
    tips: top,
  };

  const target = path.join(process.cwd(), 'data', 'tax-tips.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${top.length} active tax tips (month=${month}) → ${target}`);
  console.log('Active tips :');
  for (const t of top) console.log(`  - [${t.priority}] ${t.id} : ${t.title}`);
}

main().catch((e) => {
  console.error('build-tax-tips.mjs failed:', e);
  process.exit(1);
});
