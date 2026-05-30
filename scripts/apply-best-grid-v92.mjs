#!/usr/bin/env node
/**
 * Trade Genius — v9.3 APPLY BEST GRID CONFIGS
 *
 * Lit data/sandbox/grid_massive_v92.json, identifie les meilleures configs
 * (best Calmar par IA = return/DD optimal) et :
 *   1. Patche sandbox-cycle-multi.mjs avec les nouveaux sizing/minQuality/maxPos
 *   2. Génère un rapport de comparaison avant/après
 *   3. Output : data/sandbox/best_configs_v93.json
 *
 * Pyramiding et trailing : actuellement loggés mais nécessitent une modif
 * du code sandbox-cycle-multi.mjs pour être pleinement appliqués (TODO v9.4).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const GRID_PATH = path.join(process.cwd(), 'data', 'sandbox', 'grid_massive_v92.json');
const SANDBOX_PATH = path.join(process.cwd(), 'scripts', 'sandbox-cycle-multi.mjs');
const OUT_PATH = path.join(process.cwd(), 'data', 'sandbox', 'best_configs_v93.json');

async function main() {
  // 1. Charger les résultats grid-search
  let grid;
  try {
    grid = JSON.parse(await fs.readFile(GRID_PATH, 'utf8'));
  } catch (e) {
    console.error('grid_massive_v92.json introuvable. Lance d\'abord grid-search-massive-v92.mjs.');
    process.exit(1);
  }

  console.log('=== APPLY BEST GRID CONFIGS v9.3 ===\n');
  console.log('Grid generated:', grid.generated);
  console.log('Tested configs/IA:', grid.config.total_configs_per_ia);
  console.log('');

  // 2. Pour chaque IA, identifie le best Calmar (équilibre return/DD)
  const winners = {};
  for (const r of grid.results) {
    // Filtre out les configs aberrantes (trop peu de trades)
    const valid = r.top_20.filter(c => c.trades >= 10 && c.dd_max > -15);
    if (valid.length === 0) {
      console.log(r.ia, ': aucune config valide (filtres trop stricts)');
      continue;
    }
    const winner = valid[0]; // top_20 déjà trié par Calmar
    winners[r.ia] = winner;
    console.log('🏆 ' + r.ia + ' winner:');
    console.log('   sizing=' + winner.sizing + '% minQ=' + winner.minQuality + ' pyramiding=' + winner.pyramiding + '% trailing=' + winner.trailing + ' maxPos=' + winner.maxPos);
    console.log('   → ' + winner.return_pct_yr + '%/an · DD ' + winner.dd_max + '% · PF ' + winner.pf + ' · Calmar ' + winner.calmar + ' (' + winner.trades + ' trades)');
    console.log('');
  }

  // 3. Patche sandbox-cycle-multi.mjs avec nouveaux sizing/maxPos/minQuality
  // Mapping IA name → sandbox ID
  const IA_TO_SBID = {
    BASTION: 'bastion', 'PHÉNIX': 'phenix', RAFALE: 'rafale', NEXUS: 'nexus', VOLT: 'volt',
  };

  let sandboxCode = await fs.readFile(SANDBOX_PATH, 'utf8');
  let patchedSandbox = sandboxCode;
  const patchedSandboxes = [];

  for (const [iaName, winner] of Object.entries(winners)) {
    const sbId = IA_TO_SBID[iaName];
    if (!sbId) continue;
    // Regex pour matcher la ligne SANDBOXES de cette IA
    // Pattern : { id: 'bastion', backendId: 'atlas', name: 'BASTION', icon: '🗿', holdMax: 60 },
    const re = new RegExp("(\\{\\s*id:\\s*'" + sbId + "'[^}]*?)(,?\\s*\\})", 'g');
    let matched = false;
    patchedSandbox = patchedSandbox.replace(re, (full, head, tail) => {
      matched = true;
      // Insère/replace les nouveaux params
      let newHead = head;
      // Replace ou ajoute sizing (si pas présent, ajoute) — pour le moment on log seulement
      // Note : sandbox-cycle-multi calcule sizing via Kelly streak, donc on ne touche pas
      // On peut ajouter minQuality custom
      if (!head.includes('minQuality')) {
        newHead += ", minQuality: " + winner.minQuality;
      } else {
        newHead = newHead.replace(/minQuality:\s*\d+/, 'minQuality: ' + winner.minQuality);
      }
      if (!head.includes('maxPositions')) {
        newHead += ", maxPositions: " + winner.maxPos;
      } else {
        newHead = newHead.replace(/maxPositions:\s*\d+/, 'maxPositions: ' + winner.maxPos);
      }
      // sizingPct override
      if (!head.includes('sizingPct')) {
        newHead += ", sizingPct: " + winner.sizing;
      } else {
        newHead = newHead.replace(/sizingPct:\s*\d+(\.\d+)?/, 'sizingPct: ' + winner.sizing);
      }
      return newHead + tail;
    });
    if (matched) patchedSandboxes.push(sbId);
  }

  if (patchedSandboxes.length > 0) {
    await fs.writeFile(SANDBOX_PATH, patchedSandbox);
    console.log('✅ sandbox-cycle-multi.mjs patché pour : ' + patchedSandboxes.join(', '));
  } else {
    console.log('⚠️ Aucun patch appliqué (regex ne match pas — vérifier format SANDBOXES)');
  }

  // 4. Output
  const out = {
    generated: new Date().toISOString(),
    grid_source_generated: grid.generated,
    winners,
    patched_sandboxes: patchedSandboxes,
    note: 'Pyramiding et trailing nécessitent modif code sandbox-cycle-multi.mjs (TODO v9.4)',
  };
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
  console.log('\nOutput: ' + OUT_PATH);
}

main().catch(e => { console.error('apply-best-grid failed:', e); process.exit(1); });
