#!/usr/bin/env node
/**
 * Trade Genius — Build optimized agents (v2.91)
 *
 * Consomme data/grid-search-results.json (généré par grid-search.mjs) et
 * sélectionne mathématiquement les meilleurs combos paramétriques pour
 * refondre les 4 IA temporelles (DAY / WEEK / MONTH / CRYPTO).
 *
 * Output : data/optimized-agents.json
 *   - mapping IA → combo de paramètres + niveaux ATR
 *   - comparaison avec les agents actuels (atlas/zen/nova/kairo)
 *   - rapport texte lisible pour décision humaine
 *
 * Usage :
 *   node scripts/build-optimized-agents.mjs
 *
 * Note : à exécuter UNIQUEMENT après que grid-search.yml ait commit
 * data/grid-search-results.json (rerun manual ou cron).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const GRID_FILE = process.env.TG_GRID_FILE || 'data/grid-search-results.json';
const OUTPUT_FILE = process.env.TG_OPTIMIZED_OUTPUT || 'data/optimized-agents.json';

// Stats des agents actuels (v2.82, backtest 10y × 80 actifs).
// Sert de baseline pour mesurer l'amélioration.
const CURRENT_AGENTS_STATS = {
  // ATLAS = MONTH (LT structurel, 60j hold)
  atlas: { name: 'ATLAS', mapped_to: 'MONTH', num_trades: 2597, win_rate: 44.6, profit_factor: 2.53, expectancy: 0.85 },
  // ZEN = swing intermédiaire (30j hold) → équivalent WEEK
  zen:   { name: 'ZEN',   mapped_to: 'WEEK',  num_trades: 1437, win_rate: 52.9, profit_factor: 2.36, expectancy: 0.64 },
  // NOVA = swing court (21j hold) → équivalent WEEK
  nova:  { name: 'NOVA',  mapped_to: 'WEEK',  num_trades: 8753, win_rate: 56.2, profit_factor: 2.10, expectancy: 0.48 },
  // KAIRO = court terme (12j hold) → équivalent DAY
  kairo: { name: 'KAIRO', mapped_to: 'DAY',   num_trades: 5677, win_rate: 55.1, profit_factor: 1.69, expectancy: 0.29 },
};

// Mapping IA temporelle → hold_days cible dans le grid
const WINDOW_TO_HOLD = {
  DAY: 5,      // grid hold 5
  WEEK: 15,    // grid hold 15 (le grid en propose 15 et 30, 15 plus aligné avec WEEK)
  MONTH: 60,   // grid hold 60
};

function selectBestCombo(grid, holdDays) {
  // Tri par expectancy parmi les combos avec ce hold et profil valide
  const candidates = grid.all_combos
    ? grid.all_combos.filter(c => c.hold_days === holdDays && c.profile !== 'WEAK' && c.profile !== 'INVALID')
    : [];
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.expectancy - a.expectancy);
  return candidates[0];
}

function selectByProfile(grid, profileName) {
  // Pour le ranking par profil global
  const list = grid.top_by_profile?.[profileName] || [];
  return list[0] || null;
}

function compareWith(currentStats, newCombo) {
  if (!newCombo || !currentStats) return null;
  return {
    win_rate_delta: Number((newCombo.win_rate - currentStats.win_rate).toFixed(1)),
    pf_delta: Number((newCombo.profit_factor - currentStats.profit_factor).toFixed(2)),
    expectancy_delta: Number((newCombo.expectancy - currentStats.expectancy).toFixed(3)),
    relative_pf_gain_pct: Number((((newCombo.profit_factor / currentStats.profit_factor) - 1) * 100).toFixed(1)),
  };
}

function asReadable(c) {
  if (!c) return null;
  return {
    combo_id: c.combo_id,
    params: {
      rsi: `${c.rsi_dir} ${c.rsi_thr}`,
      ma_cross: c.ma_cross,
      macd_hist: c.macd_hist,
      min_adx: c.min_adx,
      boll_pos: c.boll_pos,
      atr_stop_mult: c.atr_stop,
      atr_tp2_mult: c.atr_tp2,
      hold_days: c.hold_days,
    },
    stats: {
      num_trades: c.num_trades,
      win_rate: c.win_rate,
      profit_factor: c.profit_factor,
      expectancy: c.expectancy,
    },
    profile: c.profile,
  };
}

async function main() {
  console.log(`[optimized] Loading ${GRID_FILE}...`);
  let grid;
  try {
    const txt = await fs.readFile(GRID_FILE, 'utf8');
    grid = JSON.parse(txt);
  } catch (e) {
    console.error(`[optimized] FATAL: cannot load ${GRID_FILE}: ${e.message}`);
    console.error(`[optimized] Run grid-search first: node scripts/grid-search.mjs`);
    process.exit(1);
  }
  console.log(`[optimized] Grid loaded: ${grid.num_combos_tested} combos × ${grid.num_assets} actifs sur ${grid.history_range}`);

  // Sélectionne le meilleur combo pour chaque fenêtre temporelle
  const bestByWindow = {
    DAY:   selectBestCombo(grid, WINDOW_TO_HOLD.DAY),
    WEEK:  selectBestCombo(grid, WINDOW_TO_HOLD.WEEK),
    MONTH: selectBestCombo(grid, WINDOW_TO_HOLD.MONTH),
  };

  // Comparaison avec les agents actuels
  const comparison = {
    DAY:   { from: CURRENT_AGENTS_STATS.kairo, to: asReadable(bestByWindow.DAY),
             gain: compareWith(CURRENT_AGENTS_STATS.kairo, bestByWindow.DAY) },
    WEEK:  { from: CURRENT_AGENTS_STATS.nova,  to: asReadable(bestByWindow.WEEK),
             gain: compareWith(CURRENT_AGENTS_STATS.nova, bestByWindow.WEEK) },
    MONTH: { from: CURRENT_AGENTS_STATS.atlas, to: asReadable(bestByWindow.MONTH),
             gain: compareWith(CURRENT_AGENTS_STATS.atlas, bestByWindow.MONTH) },
  };

  // Top par profil (référence supplémentaire)
  const topByProfile = {
    CONSERVATEUR: asReadable(selectByProfile(grid, 'CONSERVATEUR')),
    'ÉQUILIBRÉ':  asReadable(selectByProfile(grid, 'ÉQUILIBRÉ')),
    AGRESSIF:     asReadable(selectByProfile(grid, 'AGRESSIF')),
  };

  // Construit le rapport
  const out = {
    generated: new Date().toISOString(),
    grid_source: {
      file: GRID_FILE,
      generated: grid.generated,
      history_range: grid.history_range,
      num_combos: grid.num_combos_tested,
      num_assets: grid.num_assets,
    },
    optimized_per_window: {
      DAY:   asReadable(bestByWindow.DAY),
      WEEK:  asReadable(bestByWindow.WEEK),
      MONTH: asReadable(bestByWindow.MONTH),
      CRYPTO: null, // À calculer séparément avec un grid crypto dédié (v2.92)
    },
    top_per_profile: topByProfile,
    comparison_vs_current: comparison,
    methodology: 'Pour chaque fenêtre temporelle (DAY 5j / WEEK 15j / MONTH 60j), on sélectionne le combo paramétrique avec la plus haute expectancy parmi ceux classés profile != WEAK/INVALID dans le grid-search. Le tableau comparison_vs_current montre le delta vs les agents actuels mappés sur la même fenêtre.',
    next_action: 'Si gain positif sur expectancy → mettre à jour build-ai-study.mjs pour utiliser les nouveaux combos comme détecteurs internes des IA temporelles.',
  };

  // Affichage console
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('COMBOS OPTIMAUX PAR FENÊTRE TEMPORELLE');
  console.log('═══════════════════════════════════════════════════════════');
  for (const win of ['DAY', 'WEEK', 'MONTH']) {
    const c = bestByWindow[win];
    const cmp = comparison[win];
    if (!c) {
      console.log(`\n▸ ${win} : (aucun combo valide trouvé pour hold=${WINDOW_TO_HOLD[win]}j)`);
      continue;
    }
    console.log(`\n▸ ${win} (hold ${c.hold_days}j) :`);
    console.log(`  ${c.combo_id}`);
    console.log(`  ${c.num_trades} trades · win ${c.win_rate}% · PF ${c.profit_factor} · exp ${c.expectancy}R`);
    if (cmp?.from && cmp?.gain) {
      const arrow = cmp.gain.expectancy_delta >= 0 ? '✅' : '❌';
      console.log(`  vs ${cmp.from.name} actuel : ${arrow} PF ${cmp.gain.pf_delta >= 0 ? '+' : ''}${cmp.gain.pf_delta} (${cmp.gain.relative_pf_gain_pct >= 0 ? '+' : ''}${cmp.gain.relative_pf_gain_pct}%) · expectancy ${cmp.gain.expectancy_delta >= 0 ? '+' : ''}${cmp.gain.expectancy_delta}R`);
    }
  }

  const target = path.join(process.cwd(), OUTPUT_FILE);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`\n[optimized] Wrote ${target}`);
}

main().catch(e => { console.error('[optimized] FAILED:', e); process.exit(1); });
