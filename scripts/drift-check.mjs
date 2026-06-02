#!/usr/bin/env node
/**
 * Trade Genius — Drift detection auto IAs (v11.16)
 *
 * Re-validation hebdo : compare les stats actuelles de stress_all_ias.json
 * à un baseline stocké. Si une IA décroche > 15% sur median_annualized
 * ou +50% sur worst_dd → alerte.
 *
 * 1er run : crée le baseline depuis le stress actuel, 0 alerte.
 * Runs suivants : compare et output alertes par IA.
 *
 * Workflow cron hebdo : lundi 06:00 UTC.
 * Lit data/sandbox/stress_all_ias.json (régénéré par stress-all-ias.mjs).
 * Output : data/drift-alerts.json.
 *
 * Pas d'action user — c'est de l'auto-monitoring continu.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const STRESS_FILE = 'data/sandbox/stress_all_ias.json';
const BASELINE_FILE = 'data/drift-baseline.json';
const ALERTS_FILE = 'data/drift-alerts.json';

// Seuils drift (% de variation considéré inacceptable)
const DRIFT_THRESHOLD_ANNUAL_PCT = 15;   // -15% sur median annualized = warning
const DRIFT_THRESHOLD_ANNUAL_PCT_CRIT = 30;  // -30% = critical
const DRIFT_THRESHOLD_DD_PCT = 50;       // +50% sur worst_dd = warning (DD doublé)
const DRIFT_THRESHOLD_DD_PCT_CRIT = 100; // +100% (DD triplé) = critical

async function loadJSON(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

function extractMetrics(stress) {
  if (!stress || !Array.isArray(stress.results)) return {};
  const out = {};
  for (const r of stress.results) {
    if (!r.ia_name || !r.stats) continue;
    out[r.ia_name] = {
      median_annualized: r.stats.median_annualized || 0,
      worst_dd: r.stats.worst_dd || 0,
      positive_folds: r.stats.positive_folds || 0,
      total_trades: r.stats.total_trades || 0,
    };
  }
  return out;
}

function computeDrift(baselineVal, currentVal, isDrawdown = false) {
  if (!Number.isFinite(baselineVal) || baselineVal === 0) return { pct: 0, severity: 'unknown' };
  const pct = ((currentVal - baselineVal) / Math.abs(baselineVal)) * 100;
  let severity = 'ok';
  if (isDrawdown) {
    // DD : plus négatif = pire (pct positif = DD doublé, c'est mauvais)
    const ddDeterioration = Math.abs(currentVal) > Math.abs(baselineVal)
      ? ((Math.abs(currentVal) - Math.abs(baselineVal)) / Math.abs(baselineVal)) * 100
      : 0;
    if (ddDeterioration >= DRIFT_THRESHOLD_DD_PCT_CRIT) severity = 'critical';
    else if (ddDeterioration >= DRIFT_THRESHOLD_DD_PCT) severity = 'warning';
    return { pct: Number(ddDeterioration.toFixed(1)), severity, direction: 'worse' };
  }
  // Annualized return : baisse = drift négatif
  if (pct <= -DRIFT_THRESHOLD_ANNUAL_PCT_CRIT) severity = 'critical';
  else if (pct <= -DRIFT_THRESHOLD_ANNUAL_PCT) severity = 'warning';
  return { pct: Number(pct.toFixed(1)), severity, direction: pct < 0 ? 'worse' : 'better' };
}

async function main() {
  console.log('Drift check : load current stress + baseline');
  const stress = await loadJSON(STRESS_FILE);
  if (!stress) {
    console.warn(`No stress file at ${STRESS_FILE} — abort`);
    process.exit(0);
  }
  const current = extractMetrics(stress);
  const baseline = await loadJSON(BASELINE_FILE);

  // 1er run : crée le baseline et sort 0 alerte
  if (!baseline) {
    const baselineOut = {
      created: new Date().toISOString(),
      source_version: stress.version,
      source_generated: stress.generated,
      metrics: current,
    };
    await fs.writeFile(BASELINE_FILE, JSON.stringify(baselineOut, null, 2) + '\n', 'utf8');
    console.log(`Baseline créé : ${Object.keys(current).length} IAs · ${Object.keys(current).join(', ')}`);
    const alertsOut = {
      generated: new Date().toISOString(),
      baseline_created: baselineOut.created,
      check: 'no-alerts (1st run, baseline just stored)',
      alerts: [],
    };
    await fs.writeFile(ALERTS_FILE, JSON.stringify(alertsOut, null, 2) + '\n', 'utf8');
    return;
  }

  // Run suivant : compare
  const alerts = [];
  console.log(`\nDrift comparison vs baseline (${baseline.created.slice(0, 10)}) :`);
  console.log('IA       | Annual base→cur (drift)        | DD base→cur (drift)             | Severity');
  console.log('---------+--------------------------------+--------------------------------+---------');
  for (const ia of Object.keys(current)) {
    const cur = current[ia];
    const base = baseline.metrics[ia];
    if (!base) {
      console.log(`  ${ia} : pas dans baseline (skip)`);
      continue;
    }
    const annualDrift = computeDrift(base.median_annualized, cur.median_annualized, false);
    const ddDrift = computeDrift(base.worst_dd, cur.worst_dd, true);
    const severity = (annualDrift.severity === 'critical' || ddDrift.severity === 'critical') ? 'critical'
                   : (annualDrift.severity === 'warning' || ddDrift.severity === 'warning') ? 'warning'
                   : 'ok';
    const annStr = `${base.median_annualized.toFixed(2)}→${cur.median_annualized.toFixed(2)} (${annualDrift.pct >= 0 ? '+' : ''}${annualDrift.pct}%)`;
    const ddStr = `${base.worst_dd.toFixed(2)}→${cur.worst_dd.toFixed(2)} (deteriorate ${ddDrift.pct}%)`;
    console.log(`  ${ia.padEnd(8)} | ${annStr.padEnd(30)} | ${ddStr.padEnd(30)} | ${severity}`);
    if (severity !== 'ok') {
      alerts.push({
        ia, severity,
        annual_drift_pct: annualDrift.pct,
        annual_base: base.median_annualized,
        annual_current: cur.median_annualized,
        dd_drift_pct: ddDrift.pct,
        dd_base: base.worst_dd,
        dd_current: cur.worst_dd,
        recommendation: severity === 'critical'
          ? `Retirer ${ia} du picker UI · ré-investiguer config`
          : `Surveiller ${ia} de près · prochain check J+7`,
      });
    }
  }

  const alertsOut = {
    generated: new Date().toISOString(),
    baseline_created: baseline.created,
    source_generated: stress.generated,
    n_ias_checked: Object.keys(current).length,
    n_alerts: alerts.length,
    alerts,
  };
  await fs.writeFile(ALERTS_FILE, JSON.stringify(alertsOut, null, 2) + '\n', 'utf8');
  console.log(`\n${alerts.length} alerte(s) écrites → ${ALERTS_FILE}`);
}

main().catch((e) => {
  console.error('drift-check.mjs failed:', e);
  process.exit(1);
});
