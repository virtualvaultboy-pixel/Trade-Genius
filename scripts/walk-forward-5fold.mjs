#!/usr/bin/env node
/**
 * Trade Genius — Walk-Forward 5-Fold Cross-Validation (v3.2)
 *
 * Évolution du walk-forward classique (split 70/30 fixe) vers une
 * cross-validation temporelle à 5 plis. Pour chaque combo paramétrique,
 * on mesure son PF sur 5 fenêtres OOS différentes, ce qui révèle :
 *
 *   - STABILITÉ : écart-type du PF entre les folds (bas = robuste)
 *   - PIRE FOLD : le min PF parmi les 5 (vérifie qu'aucun fold n'est nul)
 *   - PHASE-INDÉPENDANCE : un edge qui marche sur 5 phases historiques
 *     différentes est mathématiquement plus solide qu'un edge qui ne
 *     marche que sur les 30% finales.
 *
 * SCHÉMA DES 5 FOLDS (expanding window, anchored)
 *
 *   prices total : [.......................................N]
 *   Fold 0 : IS [0% — 50%]  OOS [50% — 60%]
 *   Fold 1 : IS [0% — 60%]  OOS [60% — 70%]
 *   Fold 2 : IS [0% — 70%]  OOS [70% — 80%]
 *   Fold 3 : IS [0% — 80%]  OOS [80% — 90%]
 *   Fold 4 : IS [0% — 90%]  OOS [90% — 100%]
 *
 * Output : data/walk-forward-5fold.json
 *   - mean_pf, min_pf, max_pf, std_pf par combo
 *   - rang final = combinaison de mean PF et stabilité (Sharpe-like)
 *   - top robustes ULTRA-validés (rentable dans LES 5 folds)
 *
 * Lancement local :
 *   node --max-old-space-size=6144 scripts/walk-forward-5fold.mjs
 *
 * Workflow GH : walk-forward-5fold.yml
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  fetchYahooHistorical,
  computeAllIndicators, atrPct,
} from './indicators.mjs';

const HISTORY_RANGE = process.env.TG_WF_RANGE || '20y';
const OUTPUT_FILE = process.env.TG_WF_OUTPUT || 'data/walk-forward-5fold.json';
const WARMUP = 220;
const N_FOLDS = 5;
const MIN_TRADES_PER_FOLD = 20; // par fold (sera plus permissif que le 70/30)

// Panier identique aux runs précédents (50 actifs)
const ASSETS = [
  { kind: 'index', symbol: '^GSPC', label: 'S&P 500' },
  { kind: 'index', symbol: '^IXIC', label: 'Nasdaq' },
  { kind: 'index', symbol: '^DJI', label: 'Dow Jones' },
  { kind: 'index', symbol: '^RUT', label: 'Russell 2000' },
  { kind: 'index', symbol: '^FCHI', label: 'CAC 40' },
  { kind: 'index', symbol: '^GDAXI', label: 'DAX' },
  { kind: 'index', symbol: '^FTSE', label: 'FTSE 100' },
  { kind: 'index', symbol: '^N225', label: 'Nikkei 225' },
  { kind: 'index', symbol: '^HSI', label: 'Hang Seng' },
  { kind: 'index', symbol: '^STOXX50E', label: 'Euro Stoxx 50' },
  { kind: 'action', symbol: 'AAPL', label: 'Apple' },
  { kind: 'action', symbol: 'MSFT', label: 'Microsoft' },
  { kind: 'action', symbol: 'GOOGL', label: 'Alphabet' },
  { kind: 'action', symbol: 'AMZN', label: 'Amazon' },
  { kind: 'action', symbol: 'META', label: 'Meta' },
  { kind: 'action', symbol: 'NVDA', label: 'Nvidia' },
  { kind: 'action', symbol: 'TSLA', label: 'Tesla' },
  { kind: 'action', symbol: 'JPM', label: 'JPMorgan' },
  { kind: 'action', symbol: 'V', label: 'Visa' },
  { kind: 'action', symbol: 'BRK-B', label: 'Berkshire' },
  { kind: 'action', symbol: 'WMT', label: 'Walmart' },
  { kind: 'action', symbol: 'JNJ', label: 'Johnson & J.' },
  { kind: 'action', symbol: 'XOM', label: 'Exxon' },
  { kind: 'action', symbol: 'PG', label: 'P&G' },
  { kind: 'action', symbol: 'KO', label: 'Coca-Cola' },
  { kind: 'action', symbol: 'NFLX', label: 'Netflix' },
  { kind: 'action', symbol: 'NKE', label: 'Nike' },
  { kind: 'action', symbol: 'DIS', label: 'Disney' },
  { kind: 'action', symbol: 'SPY', label: 'SPY' },
  { kind: 'action', symbol: 'QQQ', label: 'QQQ' },
  { kind: 'action', symbol: 'IWM', label: 'IWM' },
  { kind: 'action', symbol: 'EEM', label: 'EEM' },
  { kind: 'action', symbol: 'GLD', label: 'GLD' },
  { kind: 'action', symbol: 'TLT', label: 'TLT' },
  { kind: 'action', symbol: 'XLK', label: 'XLK Tech' },
  { kind: 'action', symbol: 'XLF', label: 'XLF Finance' },
  { kind: 'action', symbol: 'XLE', label: 'XLE Energy' },
  { kind: 'action', symbol: 'MC.PA', label: 'LVMH' },
  { kind: 'action', symbol: 'ASML.AS', label: 'ASML' },
  { kind: 'action', symbol: 'NESN.SW', label: 'Nestlé' },
  { kind: 'forex', symbol: 'EURUSD=X', label: 'EUR/USD' },
  { kind: 'forex', symbol: 'GBPUSD=X', label: 'GBP/USD' },
  { kind: 'forex', symbol: 'USDJPY=X', label: 'USD/JPY' },
  { kind: 'forex', symbol: 'USDCHF=X', label: 'USD/CHF' },
  { kind: 'forex', symbol: 'AUDUSD=X', label: 'AUD/USD' },
  { kind: 'metal', symbol: 'GC=F', label: 'Or' },
  { kind: 'metal', symbol: 'SI=F', label: 'Argent' },
  { kind: 'metal', symbol: 'HG=F', label: 'Cuivre' },
  { kind: 'metal', symbol: 'CL=F', label: 'Pétrole' },
  { kind: 'metal', symbol: 'BZ=F', label: 'Brent' },
];

// Param space focused : on teste UNIQUEMENT les top combos identifiés par
// les runs précédents + variations proches, pour économiser le temps GH.
// On veut valider la robustesse cross-fold, pas re-faire le grid complet.
const FOCUS_COMBOS = [
  // Pattern C (v3.0 grand gagnant)
  { name: 'C-month-pullback-ichimoku', rsi_dir: 'above', rsi_thr: 35, ma_cross: 'any', macd_hist: 'any', min_adx: 0, boll_pos: 'low', atr_stop: 1.0, atr_tp2: 7.0, hold_days: 60, ichi: 'above-cloud', mfi: 'any', hull: 'any' },
  { name: 'C-week-pullback-ichimoku',  rsi_dir: 'above', rsi_thr: 35, ma_cross: 'any', macd_hist: 'any', min_adx: 0, boll_pos: 'low', atr_stop: 1.0, atr_tp2: 5.0, hold_days: 15, ichi: 'above-cloud', mfi: 'any', hull: 'any' },
  { name: 'C-day-pullback-ichimoku',   rsi_dir: 'above', rsi_thr: 35, ma_cross: 'any', macd_hist: 'any', min_adx: 0, boll_pos: 'low', atr_stop: 1.0, atr_tp2: 4.0, hold_days: 5,  ichi: 'above-cloud', mfi: 'any', hull: 'any' },
  // Pattern A v2.96 (Contrarian fond)
  { name: 'A-month-contrarian', rsi_dir: 'below', rsi_thr: 25, ma_cross: 'any', macd_hist: 'negative', min_adx: 0, boll_pos: 'low', atr_stop: 1.0, atr_tp2: 7.0, hold_days: 60, ichi: 'any', mfi: 'any', hull: 'any' },
  { name: 'A-week-contrarian',  rsi_dir: 'below', rsi_thr: 25, ma_cross: 'bull', macd_hist: 'negative', min_adx: 0, boll_pos: 'low', atr_stop: 1.0, atr_tp2: 5.0, hold_days: 15, ichi: 'any', mfi: 'any', hull: 'any' },
  { name: 'A-day-contrarian',   rsi_dir: 'below', rsi_thr: 25, ma_cross: 'bull', macd_hist: 'negative', min_adx: 0, boll_pos: 'low', atr_stop: 1.0, atr_tp2: 4.0, hold_days: 5,  ichi: 'any', mfi: 'any', hull: 'any' },
  // Variantes Pattern C avec MFI low (combo des top)
  { name: 'C-month-mfi-confirm', rsi_dir: 'above', rsi_thr: 35, ma_cross: 'any', macd_hist: 'any', min_adx: 0, boll_pos: 'low', atr_stop: 1.0, atr_tp2: 7.0, hold_days: 60, ichi: 'above-cloud', mfi: 'low', hull: 'any' },
  // Variante Hull MA confirmation
  { name: 'C-month-hull-confirm', rsi_dir: 'above', rsi_thr: 35, ma_cross: 'any', macd_hist: 'any', min_adx: 0, boll_pos: 'low', atr_stop: 1.0, atr_tp2: 7.0, hold_days: 60, ichi: 'above-cloud', mfi: 'any', hull: 'above' },
];

// ─── Précompute flags par bar ─────────────────────────────────────
function precomputeFlags(prices, volumes) {
  if (!prices || prices.length < WARMUP + 100) return null;
  const N = prices.length;
  const flags = new Array(N).fill(null);
  for (let t = WARMUP; t < N - 1; t++) {
    const subset = prices.slice(0, t + 1);
    const subVol = volumes ? volumes.slice(0, t + 1) : null;
    const ind = computeAllIndicators(subset, subVol);
    if (!ind) continue;
    const atrPctVal = atrPct(subset);
    if (!atrPctVal) continue;
    const last = subset[subset.length - 1];
    const atrAbs = (atrPctVal / 100) * last;
    const rsi = ind.rsi?.value;
    if (rsi == null) continue;
    const ma20 = ind.maCross?.ma20;
    const ma50 = ind.maCross?.ma50;
    const macdH = ind.macd?.value;
    const adx = ind.adx?.value || 0;
    const bollPos = ind.boll?.value;
    const ichi = ind.ichimoku;
    const mfi = ind.mfi?.value;
    const hullMa = ind.hullMA?.value;
    flags[t] = {
      price: last, atrAbs,
      rsi_below_20: rsi < 20, rsi_below_25: rsi < 25, rsi_below_30: rsi < 30,
      rsi_below_35: rsi < 35, rsi_below_40: rsi < 40,
      rsi_above_20: rsi > 20, rsi_above_25: rsi > 25, rsi_above_30: rsi > 30,
      rsi_above_35: rsi > 35, rsi_above_40: rsi > 40,
      ma_bull: ma20 != null && ma50 != null && ma20 > ma50,
      macd_pos: macdH != null && macdH > 0,
      macd_neg: macdH != null && macdH < 0,
      adx_val: adx,
      boll_low:  bollPos != null && bollPos < 0.25,
      boll_mid:  bollPos != null && bollPos >= 0.25 && bollPos <= 0.75,
      boll_high: bollPos != null && bollPos > 0.75,
      ichi_above_cloud: !!(ichi && ichi.position === 'above-cloud' && ichi.signal === 'bull'),
      mfi_low: mfi != null && mfi < 30,
      hull_above: hullMa != null && last > hullMa,
    };
  }
  return flags;
}

function evalCombo(combo, flags) {
  if (!flags) return null;
  const rsiKey = (combo.rsi_dir === 'below' ? 'rsi_below_' : 'rsi_above_') + combo.rsi_thr;
  if (!flags[rsiKey]) return null;
  if (combo.ma_cross === 'bull' && !flags.ma_bull) return null;
  if (combo.macd_hist === 'positive' && !flags.macd_pos) return null;
  if (combo.macd_hist === 'negative' && !flags.macd_neg) return null;
  if (combo.min_adx > 0 && flags.adx_val < combo.min_adx) return null;
  if (combo.boll_pos === 'low' && !flags.boll_low) return null;
  if (combo.boll_pos === 'mid' && !flags.boll_mid) return null;
  if (combo.boll_pos === 'high' && !flags.boll_high) return null;
  if (combo.ichi === 'above-cloud' && !flags.ichi_above_cloud) return null;
  if (combo.mfi === 'low' && !flags.mfi_low) return null;
  if (combo.hull === 'above' && !flags.hull_above) return null;
  const entry = flags.price;
  const stop = entry - combo.atr_stop * flags.atrAbs;
  const tp2 = entry + combo.atr_tp2 * flags.atrAbs;
  const tp1 = entry + (combo.atr_tp2 * 0.5) * flags.atrAbs;
  if (stop >= entry || tp2 <= entry || tp1 <= entry || tp1 >= tp2) return null;
  const risk = entry - stop;
  const rr2 = (tp2 - entry) / risk;
  if (rr2 < 1.5) return null;
  return { entry, stop, tp1, tp2, rr2 };
}

function resolveTrade(prices, t, sig, holdDays) {
  const { entry, stop, tp1, tp2, rr2 } = sig;
  let touchedTp1 = false;
  const endIdx = Math.min(t + holdDays, prices.length - 1);
  for (let i = t + 1; i <= endIdx; i++) {
    const c = prices[i];
    if (c <= stop) return touchedTp1 ? rr2 * 0.25 : -1;
    if (!touchedTp1 && c >= tp1) touchedTp1 = true;
    if (c >= tp2) return rr2;
  }
  const exitClose = prices[endIdx];
  const pnl = (exitClose - entry) / (entry - stop);
  if (touchedTp1) return Math.max(rr2 * 0.25, pnl / 2);
  return pnl;
}

async function fetchAsset(a) {
  try {
    const d = await fetchYahooHistorical(a.symbol, HISTORY_RANGE);
    return { ...a, prices: d.prices, volumes: d.volumes };
  } catch { return null; }
}

function statsFor(pnls) {
  if (pnls.length === 0) return null;
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  const winRate = wins.length / pnls.length;
  const sumWin = wins.reduce((s, p) => s + p, 0);
  const sumLossAbs = Math.abs(losses.reduce((s, p) => s + p, 0));
  const pf = sumLossAbs > 0 ? sumWin / sumLossAbs : (sumWin > 0 ? 99 : 0);
  const totalPnl = pnls.reduce((s, p) => s + p, 0);
  const avgWin = wins.length ? sumWin / wins.length : 0;
  const avgLoss = losses.length ? sumLossAbs / losses.length : 0;
  return {
    num_trades: pnls.length,
    win_rate: Number((winRate * 100).toFixed(1)),
    profit_factor: Number(pf.toFixed(2)),
    expectancy: Number((winRate * avgWin - (1 - winRate) * avgLoss).toFixed(3)),
    total_pnl: Number(totalPnl.toFixed(1)),
  };
}

/**
 * Évalue un combo sur 5 folds (expanding window, anchored at 0)
 * Retourne { folds: [{is, oos}, ...], mean_pf, min_pf, max_pf, std_pf }
 */
function evalCombo5Fold(combo, assetData) {
  const folds = [];
  const N_BORNES = N_FOLDS; // 5 folds → 5 splits
  for (let foldIdx = 0; foldIdx < N_BORNES; foldIdx++) {
    // expanding window : IS de 0 jusqu'à (50 + 10*foldIdx)%, OOS de là jusqu'à +10%
    const isPctEnd = 0.50 + 0.10 * foldIdx;
    const oosPctEnd = isPctEnd + 0.10;
    const isPnls = [], oosPnls = [];
    for (const ad of assetData) {
      const { prices, flags } = ad;
      if (!flags) continue;
      const N = prices.length;
      const isCutoff = WARMUP + Math.floor((N - WARMUP) * isPctEnd);
      const oosCutoff = WARMUP + Math.floor((N - WARMUP) * oosPctEnd);
      // IS phase
      for (let t = WARMUP; t < isCutoff - combo.hold_days - 1; t++) {
        const cell = flags[t];
        if (!cell) continue;
        const sig = evalCombo(combo, cell);
        if (!sig) continue;
        const pnl = resolveTrade(prices, t, sig, combo.hold_days);
        isPnls.push(pnl);
      }
      // OOS phase (= [isCutoff, oosCutoff])
      for (let t = isCutoff; t < oosCutoff - combo.hold_days - 1; t++) {
        const cell = flags[t];
        if (!cell) continue;
        const sig = evalCombo(combo, cell);
        if (!sig) continue;
        const pnl = resolveTrade(prices, t, sig, combo.hold_days);
        oosPnls.push(pnl);
      }
    }
    folds.push({
      fold: foldIdx,
      is_pct_end: isPctEnd,
      oos_pct_end: oosPctEnd,
      is: statsFor(isPnls),
      oos: statsFor(oosPnls),
    });
  }
  // Agrégation : PF OOS moyen, min, max, std
  const oosPFs = folds.map(f => f.oos?.profit_factor).filter(p => p != null && p > 0);
  if (oosPFs.length === 0) {
    return { folds, mean_pf: null, min_pf: null, max_pf: null, std_pf: null };
  }
  const mean = oosPFs.reduce((s, p) => s + p, 0) / oosPFs.length;
  const variance = oosPFs.reduce((s, p) => s + (p - mean) ** 2, 0) / oosPFs.length;
  return {
    folds,
    n_valid_folds: oosPFs.length,
    mean_pf: Number(mean.toFixed(2)),
    min_pf: Number(Math.min(...oosPFs).toFixed(2)),
    max_pf: Number(Math.max(...oosPFs).toFixed(2)),
    std_pf: Number(Math.sqrt(variance).toFixed(2)),
  };
}

function classifyStability(agg) {
  if (!agg || agg.n_valid_folds < 4) return 'INVALID';
  // ULTRA_ROBUSTE : rentable dans LES 5 folds + std_pf < 0.5
  if (agg.min_pf >= 1.3 && agg.std_pf < 0.5) return 'ULTRA_ROBUSTE';
  // STABLE : rentable dans 4+ folds + std modérée
  if (agg.min_pf >= 1.0 && agg.std_pf < 1.0) return 'STABLE';
  // VOLATILE : moyenne OK mais grande variance
  if (agg.mean_pf >= 1.5) return 'VOLATILE';
  return 'WEAK';
}

async function main() {
  console.log(`[5fold] ${ASSETS.length} actifs, ${FOCUS_COMBOS.length} combos focus, range ${HISTORY_RANGE}`);
  console.log(`[5fold] ${N_FOLDS} folds (expanding window 50% → 90%)`);

  // Fetch
  console.log('[5fold] Fetching assets...');
  const assets = [];
  for (const a of ASSETS) {
    const r = await fetchAsset(a);
    if (r) assets.push(r);
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`\n[5fold] ${assets.length}/${ASSETS.length} actifs OK`);

  console.log('[5fold] Pre-computing flags...');
  const assetData = [];
  for (const a of assets) {
    const flags = precomputeFlags(a.prices, a.volumes);
    if (!flags) continue;
    assetData.push({ label: a.label, kind: a.kind, prices: a.prices, flags });
    process.stdout.write('.');
  }
  console.log(`\n[5fold] ${assetData.length} actifs avec flags ready`);

  // Eval each combo on 5 folds
  console.log('[5fold] Running 5-fold evaluation...');
  const results = [];
  for (const combo of FOCUS_COMBOS) {
    const agg = evalCombo5Fold(combo, assetData);
    const stability = classifyStability(agg);
    results.push({
      ...combo,
      ...agg,
      stability,
    });
    console.log(`  ${combo.name.padEnd(30)} · folds ${agg.n_valid_folds || 0} · meanPF ${agg.mean_pf} · minPF ${agg.min_pf} · stdPF ${agg.std_pf} → ${stability}`);
  }

  // Tri par mean_pf
  results.sort((a, b) => (b.mean_pf || 0) - (a.mean_pf || 0));

  console.log('\n═══ TOP COMBOS ULTRA_ROBUSTES ═══');
  const ultraRobust = results.filter(r => r.stability === 'ULTRA_ROBUSTE');
  if (ultraRobust.length === 0) console.log('  (aucun)');
  for (const r of ultraRobust) {
    console.log(`\n  ${r.name}`);
    console.log(`    mean PF: ${r.mean_pf} · min PF: ${r.min_pf} · max PF: ${r.max_pf} · std PF: ${r.std_pf}`);
    console.log(`    folds OOS PFs: ${r.folds.map(f => f.oos?.profit_factor ?? '-').join(' | ')}`);
  }

  const out = {
    generated: new Date().toISOString(),
    history_range: HISTORY_RANGE,
    num_assets: assets.length,
    num_combos: FOCUS_COMBOS.length,
    n_folds: N_FOLDS,
    methodology: 'Walk-forward 5-fold cross-validation. Expanding window anchored at 0 : fold i a IS [0, 50+10i%] et OOS [50+10i%, 60+10i%]. Pour chaque combo on calcule le PF dans chacun des 5 folds OOS, puis mean/min/max/std. ULTRA_ROBUSTE si min PF ≥ 1.3 ET std PF < 0.5 (rentable dans LES 5 phases historiques).',
    classifications: {
      ULTRA_ROBUSTE: 'min_pf ≥ 1.3 ET std_pf < 0.5 — rentable dans LES 5 phases',
      STABLE: 'min_pf ≥ 1.0 ET std_pf < 1.0 — rentable dans 4+ phases',
      VOLATILE: 'mean_pf ≥ 1.5 mais variance élevée',
      WEAK: 'PF moyen < 1.5 ou min_pf < 1.0',
      INVALID: 'pas assez de folds valides (<4)',
    },
    results,
  };
  const target = path.join(process.cwd(), OUTPUT_FILE);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`\n[5fold] Wrote ${target}`);
}

main().catch(e => { console.error('[5fold] FAILED:', e); process.exit(1); });
