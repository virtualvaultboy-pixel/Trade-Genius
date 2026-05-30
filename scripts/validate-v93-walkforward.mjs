#!/usr/bin/env node
/**
 * Trade Genius — v9.3 VALIDATION WALK-FORWARD (5 folds × 1 an)
 *
 * Test honnête anti-overfit : les configs v9.3 BOOST sont appliquées
 * AVEUGLÉMENT sur chaque fold (1 an) — pas de réoptimisation, pas de cherry-pick.
 *
 * Si la perf reste cohérente (16-22%/an) sur folds 3-5 → robuste.
 * Si elle s'effondre → overfit, à revoir.
 *
 * Use cached data from grid-search (data/sandbox/_cache_grid_data.json)
 * Affiche aussi les 10 derniers trades détaillés pour transparence.
 *
 * Output : data/sandbox/validation_v93.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { computeAllIndicators } from './indicators.mjs';

const CACHE_PATH = path.join(process.cwd(), 'data', 'sandbox', '_cache_grid_data.json');
const OUT_PATH = path.join(process.cwd(), 'data', 'sandbox', 'validation_v93.json');

const CAPITAL_INITIAL = 1000;
const SLIPPAGE_PCT = 0.4;
const FOLD_DAYS = 250; // ~1 an
const WARMUP_DAYS = 60;

// Configs v9.3 BOOST (déployées) — appliquées AVEUGLÉMENT
const IA_CONFIGS = [
  {
    id: 'bastion', name: 'BASTION',
    atrStop: 0.6, atrTp2: 6.0, holdMax: 45,
    sizing: 10, minQuality: 50, maxPos: 5, pyramiding: 50, trailing: true,
    kinds: ['index', 'action'],
  },
  {
    id: 'phenix', name: 'PHÉNIX',
    atrStop: 1.0, atrTp2: 5.0, holdMax: 30,
    sizing: 10, minQuality: 50, maxPos: 5, pyramiding: 50, trailing: true,
    kinds: ['index', 'action'],
  },
  {
    id: 'rafale', name: 'RAFALE',
    atrStop: 0.6, atrTp2: 5.0, holdMax: 18,
    sizing: 10, minQuality: 65, maxPos: 3, pyramiding: 50, trailing: true,
    kinds: ['index', 'action'],
  },
  {
    id: 'nexus', name: 'NEXUS',
    atrStop: 0.6, atrTp2: 4.0, holdMax: 15,
    sizing: 7, minQuality: 60, maxPos: 5, pyramiding: 30, trailing: true,
    kinds: ['crypto'],
  },
];

// ───────────────────────────────────────────────────
// Détecteurs ABC (alignés sur build-ai-study)
// ───────────────────────────────────────────────────
function _buildSetup(close, atrAbs, config, q) {
  const entry = close;
  const stop = entry - config.atrStop * atrAbs;
  const tp1 = entry + (config.atrTp2 / 2) * atrAbs;
  const tp2 = entry + config.atrTp2 * atrAbs;
  if (stop >= entry || tp2 <= entry) return null;
  const rr = (tp2 - entry) / (entry - stop);
  if (rr < 1.8) return null;
  return { entry, stop, tp1, tp2, atrAbs, quality: Math.max(0, Math.min(100, Math.round(q))) };
}

function detectBestSetup(prices, config) {
  if (prices.length < 60) return null;
  const ind = computeAllIndicators(prices);
  if (!ind?.rsi || !ind?.boll || !ind?.atr) return null;
  const rsi = ind.rsi.value, boll = ind.boll.value;
  const close = prices[prices.length - 1];
  const atrAbs = ind.atr.value * close / 100;
  const candidates = [];

  if (rsi != null && rsi < 28 && boll != null && boll < 0.30) {
    const q = 60 + (28 - rsi) + (0.30 - boll) * 30;
    const s = _buildSetup(close, atrAbs, config, q);
    if (s) candidates.push({ ...s, pattern: 'A' });
  }
  if (ind.adx && ind.macd) {
    const adx = ind.adx.value, macd = ind.macd.value;
    if (rsi != null && rsi >= 35 && rsi <= 60 && adx != null && adx >= 25 &&
        macd != null && macd < 0 && boll != null && boll >= 0.25 && boll <= 0.75) {
      const q = 62 + Math.min(15, adx - 25) + Math.min(10, 50 - rsi);
      const s = _buildSetup(close, atrAbs, config, q);
      if (s) candidates.push({ ...s, pattern: 'B' });
    }
  }
  if (ind.ichimoku) {
    const ichi = ind.ichimoku;
    if (rsi != null && rsi >= 35 && rsi <= 60 && boll != null && boll < 0.30 &&
        ichi.position === 'above-cloud' && ichi.signal === 'bull') {
      const q = 65 + Math.min(15, 50 - rsi) + (0.30 - boll) * 25;
      const s = _buildSetup(close, atrAbs, config, q);
      if (s) candidates.push({ ...s, pattern: 'C' });
    }
  }
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.quality - a.quality)[0];
}

// ───────────────────────────────────────────────────
// Backtest causal d'une IA sur une période (fold)
// ───────────────────────────────────────────────────
function backtestFold(assetData, ia, foldStart, foldEnd, foldName) {
  let capital = CAPITAL_INITIAL;
  let peakCapital = capital;
  let maxDD = 0;
  const trades = [];
  const openPositions = [];

  const eligibleAssets = assetData.filter(a => ia.kinds.includes(a.kind));
  if (eligibleAssets.length === 0) return null;

  const minLen = Math.min(...eligibleAssets.map(a => a.prices.length));
  // foldEnd capped à minLen, foldStart bumped pour avoir warmup
  const realStart = Math.max(foldStart, WARMUP_DAYS);
  const realEnd = Math.min(foldEnd, minLen);
  if (realEnd - realStart < 50) return null;

  for (let t = realStart; t < realEnd; t++) {
    // 1. Update positions
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i];
      const asset = eligibleAssets.find(a => a.label === pos.asset);
      if (!asset) { openPositions.splice(i, 1); continue; }
      const priceToday = asset.prices[t];
      pos.daysHeld++;

      // Trailing
      if (ia.trailing && !pos.tp1Hit && priceToday >= pos.tp1) {
        pos.tp1Hit = true;
        pos.stop = pos.entry;
      }
      // Pyramiding
      if (ia.pyramiding > 0 && pos.tp1Hit && !pos.added && priceToday >= pos.tp1) {
        const addCash = Math.min(pos.originalSize * (ia.pyramiding / 100), capital * 0.95);
        if (addCash > 0) {
          pos.added = true;
          pos.addedSize = addCash;
          capital -= addCash;
        }
      }

      const hitStop = priceToday <= pos.stop;
      const hitTp = priceToday >= pos.tp2;
      const timeout = pos.daysHeld >= ia.holdMax;
      if (hitStop || hitTp || timeout) {
        let exitPrice = priceToday;
        if (hitStop) exitPrice = pos.stop;
        else if (hitTp) exitPrice = pos.tp2;
        exitPrice *= (1 - SLIPPAGE_PCT / 100);
        const pnlPct = (exitPrice - pos.entry) / pos.entry;
        const totalSize = pos.originalSize + (pos.addedSize || 0);
        const pnlEur = totalSize * pnlPct;
        capital += totalSize + pnlEur;
        trades.push({
          asset: pos.asset, entryPrice: pos.entry, exitPrice,
          pnlPct: Number((pnlPct * 100).toFixed(2)),
          pnlEur: Number(pnlEur.toFixed(2)),
          daysHeld: pos.daysHeld,
          outcome: hitTp ? 'tp2' : (hitStop ? (pos.tp1Hit ? 'breakeven' : 'sl') : 'timeout'),
          pyramided: pos.added,
          quality: pos.quality, pattern: pos.pattern,
        });
        openPositions.splice(i, 1);
      }
    }

    // 2. New setups
    if (openPositions.length < ia.maxPos) {
      const candidates = [];
      for (const asset of eligibleAssets) {
        if (openPositions.some(p => p.asset === asset.label)) continue;
        const setup = detectBestSetup(asset.prices.slice(0, t + 1), ia);
        if (setup && setup.quality >= ia.minQuality) {
          candidates.push({ asset: asset.label, setup });
        }
      }
      candidates.sort((a, b) => b.setup.quality - a.setup.quality);
      const slots = ia.maxPos - openPositions.length;
      for (let i = 0; i < Math.min(slots, candidates.length); i++) {
        const c = candidates[i];
        const sizeEur = capital * (ia.sizing / 100);
        if (sizeEur < 1 || capital < sizeEur * 1.1) continue;
        const entryWithSlip = c.setup.entry * (1 + SLIPPAGE_PCT / 100);
        capital -= sizeEur;
        openPositions.push({
          asset: c.asset,
          entry: entryWithSlip,
          stop: c.setup.stop,
          tp1: c.setup.tp1,
          tp2: c.setup.tp2,
          daysHeld: 0,
          quality: c.setup.quality,
          pattern: c.setup.pattern,
          originalSize: sizeEur,
          addedSize: 0,
          tp1Hit: false,
          added: false,
        });
      }
    }

    // 3. Equity track
    const equity = capital + openPositions.reduce((acc, p) => {
      const asset = eligibleAssets.find(a => a.label === p.asset);
      const price = asset?.prices[t] || p.entry;
      const totalSize = p.originalSize + (p.addedSize || 0);
      return acc + totalSize * (price / p.entry);
    }, 0);
    if (equity > peakCapital) peakCapital = equity;
    const dd = (equity - peakCapital) / peakCapital;
    if (dd < maxDD) maxDD = dd;
  }

  // Close all at fold end
  const finalEquity = capital + openPositions.reduce((acc, p) => {
    const asset = eligibleAssets.find(a => a.label === p.asset);
    const finalPrice = asset?.prices[realEnd - 1] || p.entry;
    const totalSize = p.originalSize + (p.addedSize || 0);
    return acc + totalSize * (finalPrice / p.entry);
  }, 0);

  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const winRate = trades.length > 0 ? wins.length / trades.length * 100 : 0;
  const totalReturn = (finalEquity - CAPITAL_INITIAL) / CAPITAL_INITIAL * 100;
  const sumWins = wins.reduce((a, t) => a + t.pnlEur, 0);
  const sumLosses = Math.abs(losses.reduce((a, t) => a + t.pnlEur, 0));
  const pf = sumLosses > 0 ? sumWins / sumLosses : (sumWins > 0 ? 99 : 0);
  const yearsBT = (realEnd - realStart) / 252;
  const returnPctYr = yearsBT > 0 ? totalReturn / yearsBT : 0;

  return {
    fold: foldName,
    days: realEnd - realStart,
    trades: trades.length,
    return_pct: Number(totalReturn.toFixed(2)),
    return_pct_yr: Number(returnPctYr.toFixed(2)),
    dd_max: Number((maxDD * 100).toFixed(2)),
    pf: Number(pf.toFixed(2)),
    win_rate: Number(winRate.toFixed(1)),
    final_equity: Number(finalEquity.toFixed(2)),
    last_trades: trades.slice(-10), // 10 derniers trades pour transparence
    sample_trades: trades.length > 0 ? [
      trades.reduce((a, b) => a.pnlEur > b.pnlEur ? a : b), // meilleur
      trades.reduce((a, b) => a.pnlEur < b.pnlEur ? a : b), // pire
    ] : [],
  };
}

// ───────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────
async function main() {
  console.log('=== VALIDATION v9.3 — WALK-FORWARD 5 FOLDS (anti-overfit) ===\n');
  console.log('Méthode honnête : configs v9.3 BOOST appliquées AVEUGLÉMENT sur chaque fold,');
  console.log('sans réoptimisation. Si robuste, perf cohérente. Si overfit, perf s\'effondre.\n');

  const assetData = JSON.parse(await fs.readFile(CACHE_PATH, 'utf8'));
  const minLen = Math.min(...assetData.map(a => a.prices.length));
  console.log('Assets:', assetData.length, '· Days available:', minLen, '(' + (minLen / 252).toFixed(1) + ' ans)\n');

  // Split en 5 folds chronologiques de FOLD_DAYS chacun
  const folds = [];
  for (let i = 0; i < 5; i++) {
    const start = i * FOLD_DAYS;
    const end = Math.min(start + FOLD_DAYS + WARMUP_DAYS, minLen);
    folds.push({ name: 'Fold-' + (i + 1), start, end });
  }
  console.log('Folds:');
  folds.forEach(f => console.log('  ' + f.name + ': jours', f.start, '→', f.end));
  console.log('');

  const allResults = [];
  for (const ia of IA_CONFIGS) {
    console.log('\n=== ' + ia.name + ' ===');
    console.log('Config: sizing', ia.sizing + '% · minQ', ia.minQuality, '· pyramiding', ia.pyramiding + '% · trailing', ia.trailing, '· maxPos', ia.maxPos);
    const foldResults = [];
    for (const fold of folds) {
      const res = backtestFold(assetData, ia, fold.start, fold.end, fold.name);
      if (!res) {
        console.log('  ' + fold.name + ': skipped (insufficient data)');
        continue;
      }
      foldResults.push(res);
      console.log('  ' + fold.name + ': ' + res.return_pct_yr + '%/an · DD ' + res.dd_max + '% · PF ' + res.pf + ' · WR ' + res.win_rate + '% (' + res.trades + ' trades)');
    }
    // Median + worst/best fold
    if (foldResults.length > 0) {
      const sorted = [...foldResults].sort((a, b) => a.return_pct_yr - b.return_pct_yr);
      const median = sorted[Math.floor(sorted.length / 2)].return_pct_yr;
      const worst = sorted[0];
      const best = sorted[sorted.length - 1];
      const avgDD = foldResults.reduce((a, b) => a + b.dd_max, 0) / foldResults.length;
      const positiveFolds = foldResults.filter(r => r.return_pct_yr > 0).length;
      console.log('  ─────────────────────');
      console.log('  MÉDIAN: ' + median + '%/an · MOY DD ' + avgDD.toFixed(2) + '% · ' + positiveFolds + '/' + foldResults.length + ' folds positifs');
      console.log('  WORST fold: ' + worst.fold + ' ' + worst.return_pct_yr + '%/an · BEST fold: ' + best.fold + ' ' + best.return_pct_yr + '%/an');
      allResults.push({
        ia: ia.name,
        config: ia,
        folds: foldResults,
        summary: {
          median_return_yr: median,
          worst_fold: worst.fold,
          worst_return_yr: worst.return_pct_yr,
          best_fold: best.fold,
          best_return_yr: best.return_pct_yr,
          avg_dd: Number(avgDD.toFixed(2)),
          positive_folds: positiveFolds,
          total_folds: foldResults.length,
          robustness_score: Number((positiveFolds / foldResults.length * 100).toFixed(1)),
        },
      });
    }
  }

  // Diagnostic global
  console.log('\n\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║ DIAGNOSTIC ROBUSTESSE v9.3 (verdict final)                          ║');
  console.log('╠══════════╦═══════════╦═══════════╦═══════════╦═══════════════════╣');
  console.log('║ IA       ║ Médian/an ║ Worst/an  ║ Best/an   ║ Folds positifs    ║');
  console.log('╠══════════╬═══════════╬═══════════╬═══════════╬═══════════════════╣');
  allResults.forEach(r => {
    const s = r.summary;
    console.log('║ ' + r.ia.padEnd(8) + ' ║ ' + (s.median_return_yr + '%').padStart(9) + ' ║ ' + (s.worst_return_yr + '%').padStart(9) + ' ║ ' + (s.best_return_yr + '%').padStart(9) + ' ║ ' + (s.positive_folds + '/' + s.total_folds + ' (' + s.robustness_score + '%)').padStart(17) + ' ║');
  });
  console.log('╚══════════╩═══════════╩═══════════╩═══════════╩═══════════════════╝');

  // 10 trades exemples du dernier fold (OOS-le-plus-récent)
  console.log('\n=== 10 TRADES EXEMPLES (Fold-5, le plus récent — VRAI OOS) ===');
  allResults.forEach(r => {
    const last = r.folds[r.folds.length - 1];
    if (!last || !last.last_trades) return;
    console.log('\n' + r.ia + ' :');
    last.last_trades.slice(-5).forEach(t => {
      const sign = t.pnlPct > 0 ? '+' : '';
      console.log('  ' + t.asset.padEnd(15) + ' Q=' + t.quality + ' pat=' + t.pattern + ' → ' + sign + t.pnlPct + '% (' + sign + t.pnlEur + '€) [' + t.outcome + ', ' + t.daysHeld + 'j' + (t.pyramided ? ', PYR' : '') + ']');
    });
  });

  await fs.writeFile(OUT_PATH, JSON.stringify({
    generated: new Date().toISOString(),
    method: 'Walk-forward strict 5 folds × 250j (1 an). Configs v9.3 appliquées sans réoptimisation.',
    folds_def: folds,
    results: allResults,
  }, null, 2));
  console.log('\n\nOutput: ' + OUT_PATH);
}

main().catch(e => { console.error('validate-v93 failed:', e); process.exit(1); });
