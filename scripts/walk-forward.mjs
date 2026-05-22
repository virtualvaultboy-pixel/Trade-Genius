#!/usr/bin/env node
/**
 * Trade Genius — Walk-Forward Validation (v2.94)
 *
 * PROBLÈME RÉSOLU : le grid-search v2.93 trouve le meilleur combo sur
 * TOUT l'historique 2006-2026. Mais ce dataset CONTIENT la "réponse" :
 * le système peut sur-apprendre des patterns spécifiques au passé qui
 * ne se reproduiront pas. C'est l'OVERFITTING.
 *
 * SOLUTION : walk-forward validation.
 *   1. Split l'historique : 70% in-sample (IS, training)
 *                          30% out-of-sample (OOS, validation)
 *   2. Re-run le grid-search SUR L'IN-SAMPLE UNIQUEMENT
 *   3. Pour chaque top combo IS, mesurer ses stats sur l'OOS
 *   4. Mesurer le DECAY = (PF_IS - PF_OOS) / PF_IS × 100
 *      - decay < 30% → combo ROBUSTE (vrai edge)
 *      - decay 30-50% → combo PASSABLE (à monitorer)
 *      - decay > 50% → combo OVERFIT (à exclure)
 *
 * Output : data/walk-forward-results.json
 *   - Verdict pour chaque combo top : ROBUSTE / PASSABLE / OVERFIT
 *   - Décision finale : utiliser ou rejeter
 *   - Stats IS et OOS pour chaque combo gardé
 *
 * Lancement :
 *   node --max-old-space-size=6144 scripts/walk-forward.mjs
 *
 * Workflow GH : walk-forward.yml
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  fetchYahooHistorical,
  computeAllIndicators, atrPct,
} from './indicators.mjs';

const HISTORY_RANGE = process.env.TG_WF_RANGE || '20y';
const OUTPUT_FILE = process.env.TG_WF_OUTPUT || 'data/walk-forward-results.json';
const IS_RATIO = 0.70; // 70% in-sample / 30% out-of-sample
const WARMUP = 220;
const MIN_TRADES_FOR_VALID = 50; // par phase (IS ou OOS)

// Panier (sous-ensemble représentatif, identique au grid-search)
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

// v2.97 — PARAM SPACE ÉTENDU : +3 indicateurs (Ichimoku, MFI, Hull MA)
// + granularité RSI étendue (5 valeurs au lieu de 4)
// Total : 5×2×2×3×4×4×4×4×4×2×2×2 = 122 880 combos (vs 49 152 v2.93)
const PARAM_SPACE = {
  // Dimensions existantes (granularité étendue)
  rsi_thr: [20, 25, 30, 35, 40],                  // 5 (vs 4)
  rsi_dir: ['below', 'above'],                    // 2
  ma_cross: ['bull', 'any'],                      // 2
  macd_hist: ['positive', 'negative', 'any'],     // 3
  min_adx: [0, 20, 25, 30],                       // 4
  boll_pos: ['low', 'mid', 'high', 'any'],        // 4
  atr_stop: [1.0, 1.5, 2.0, 2.5],                 // 4
  atr_tp2: [3.0, 4.0, 5.0, 7.0],                  // 4
  hold_days: [5, 15, 30, 60],                     // 4
  // v2.97 — Nouvelles dimensions (filtres on/off pour économiser le combo space)
  ichi: ['above-cloud', 'any'],                   // 2 (NEW)
  mfi:  ['low', 'any'],                           // 2 (NEW) - MFI<30 ou pas de filtre
  hull: ['above', 'any'],                         // 2 (NEW) - prix > Hull MA ou pas de filtre
};

function* iterCombos(space) {
  const keys = Object.keys(space);
  const vals = keys.map(k => space[k]);
  const idx = vals.map(() => 0);
  while (true) {
    const combo = {};
    for (let k = 0; k < keys.length; k++) combo[keys[k]] = vals[k][idx[k]];
    yield combo;
    let i = idx.length - 1;
    while (i >= 0) {
      idx[i]++;
      if (idx[i] < vals[i].length) break;
      idx[i] = 0;
      i--;
    }
    if (i < 0) return;
  }
}
const ALL_COMBOS = [...iterCombos(PARAM_SPACE)];

// Précompute flags par bar (identique au grid-search)
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
    // v2.97 — Nouveaux indicateurs
    const ichi = ind.ichimoku;
    const mfi = ind.mfi?.value;
    const hullMa = ind.hullMA?.value;
    flags[t] = {
      price: last, atrAbs,
      // RSI granular (5 seuils v2.97)
      rsi_below_20: rsi < 20, rsi_below_25: rsi < 25, rsi_below_30: rsi < 30, rsi_below_35: rsi < 35, rsi_below_40: rsi < 40,
      rsi_above_20: rsi > 20, rsi_above_25: rsi > 25, rsi_above_30: rsi > 30, rsi_above_35: rsi > 35, rsi_above_40: rsi > 40,
      ma_bull: ma20 != null && ma50 != null && ma20 > ma50,
      macd_pos: macdH != null && macdH > 0,
      macd_neg: macdH != null && macdH < 0,
      adx_val: adx,
      boll_low:  bollPos != null && bollPos < 0.25,
      boll_mid:  bollPos != null && bollPos >= 0.25 && bollPos <= 0.75,
      boll_high: bollPos != null && bollPos > 0.75,
      // v2.97 — Nouveaux indicateurs
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
  if (combo.boll_pos === 'low'  && !flags.boll_low)  return null;
  if (combo.boll_pos === 'mid'  && !flags.boll_mid)  return null;
  if (combo.boll_pos === 'high' && !flags.boll_high) return null;
  // v2.97 — Nouveaux filtres
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
    if (c <= stop) {
      if (touchedTp1) return rr2 * 0.25;
      return -1;
    }
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
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;
  return {
    num_trades: pnls.length,
    win_rate: Number((winRate * 100).toFixed(1)),
    profit_factor: Number(pf.toFixed(2)),
    expectancy: Number(expectancy.toFixed(3)),
    total_pnl: Number(totalPnl.toFixed(1)),
  };
}

// Évalue un combo SÉPARÉMENT sur la portion in-sample et out-of-sample
function evalComboPhased(combo, assetDataList) {
  const isPnls = [], oosPnls = [];
  for (const ad of assetDataList) {
    const { prices, isCutoff, isFlags, oosFlags } = ad;
    if (!isFlags || !oosFlags) continue;
    // IS : signaux dans [WARMUP, isCutoff - holdDays]
    for (let t = WARMUP; t < isCutoff - combo.hold_days - 1; t++) {
      const cell = isFlags[t];
      if (!cell) continue;
      const sig = evalCombo(combo, cell);
      if (!sig) continue;
      const pnl = resolveTrade(prices, t, sig, combo.hold_days);
      isPnls.push(pnl);
    }
    // OOS : signaux dans [isCutoff, prices.length - holdDays]
    for (let t = isCutoff; t < prices.length - combo.hold_days - 1; t++) {
      const cell = oosFlags[t];
      if (!cell) continue;
      const sig = evalCombo(combo, cell);
      if (!sig) continue;
      const pnl = resolveTrade(prices, t, sig, combo.hold_days);
      oosPnls.push(pnl);
    }
  }
  return { is: statsFor(isPnls), oos: statsFor(oosPnls) };
}

function comboId(combo) {
  // v2.97 — Ajout dimensions ichi / mfi / hull (suffixés seulement si non-any)
  let id = `rsi${combo.rsi_dir}${combo.rsi_thr}_ma${combo.ma_cross}_macd${combo.macd_hist}_adx${combo.min_adx}_boll${combo.boll_pos}_atr${combo.atr_stop}-${combo.atr_tp2}_h${combo.hold_days}`;
  if (combo.ichi && combo.ichi !== 'any') id += `_ichi${combo.ichi}`;
  if (combo.mfi  && combo.mfi  !== 'any') id += `_mfi${combo.mfi}`;
  if (combo.hull && combo.hull !== 'any') id += `_hull${combo.hull}`;
  return id;
}

function classifyRobustness(isStat, oosStat) {
  if (!isStat || !oosStat) return 'INVALID';
  if (isStat.num_trades < MIN_TRADES_FOR_VALID || oosStat.num_trades < MIN_TRADES_FOR_VALID) return 'INVALID';
  if (isStat.profit_factor < 1.2) return 'WEAK_IS';
  const decayPct = ((isStat.profit_factor - oosStat.profit_factor) / isStat.profit_factor) * 100;
  if (oosStat.profit_factor < 1.0) return 'OVERFIT';     // PnL négatif OOS → catastrophe
  if (decayPct > 50) return 'OVERFIT';                   // perte > 50% du PF
  if (decayPct > 30) return 'PASSABLE';                  // perte 30-50% du PF
  if (decayPct < 0)  return 'ROBUSTE_BONUS';              // OOS meilleur que IS (rare, peut-être chance)
  return 'ROBUSTE';                                       // perte < 30% = vrai edge
}

async function main() {
  console.log(`[wf] ${ASSETS.length} actifs, ${ALL_COMBOS.length} combos, range ${HISTORY_RANGE}`);
  console.log(`[wf] Split : ${(IS_RATIO * 100).toFixed(0)}% in-sample / ${((1 - IS_RATIO) * 100).toFixed(0)}% out-of-sample`);

  // Fetch séquentiel
  console.log('[wf] Fetching assets...');
  const assets = [];
  for (const a of ASSETS) {
    const r = await fetchAsset(a);
    if (r) assets.push(r);
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`\n[wf] ${assets.length}/${ASSETS.length} actifs OK`);

  // Pour chaque actif : précompute flags séparés pour IS et OOS
  // (en réalité c'est un seul tableau de flags ; on note juste l'index de coupure)
  console.log('[wf] Pre-computing flags + computing IS cutoff per asset...');
  const tStart = Date.now();
  const assetData = [];
  for (const a of assets) {
    const N = a.prices.length;
    const isCutoff = WARMUP + Math.floor((N - WARMUP) * IS_RATIO);
    const flags = precomputeFlags(a.prices, a.volumes);
    if (!flags) continue;
    // On utilise le même tableau flags pour IS et OOS, distingués par t < isCutoff vs >= isCutoff
    assetData.push({
      label: a.label, kind: a.kind, prices: a.prices,
      isCutoff,
      isFlags: flags, oosFlags: flags, // même tableau, juste lecture différente
      is_period_bars: isCutoff - WARMUP,
      oos_period_bars: N - isCutoff,
    });
    process.stdout.write('.');
  }
  console.log(`\n[wf] Flags ready in ${((Date.now()-tStart)/1000).toFixed(1)}s for ${assetData.length} actifs`);

  // Walk-forward evaluation : pour chaque combo, IS et OOS
  console.log(`[wf] Walk-forward evaluation on ${ALL_COMBOS.length} combos...`);
  const tWf = Date.now();
  const results = [];
  let i = 0;
  for (const combo of ALL_COMBOS) {
    i++;
    const { is: isStat, oos: oosStat } = evalComboPhased(combo, assetData);
    const robustness = classifyRobustness(isStat, oosStat);
    if (robustness === 'INVALID' || robustness === 'WEAK_IS') {
      // On ne stocke pas les combos invalides pour économiser la RAM
    } else {
      const decayPct = isStat && oosStat
        ? ((isStat.profit_factor - oosStat.profit_factor) / isStat.profit_factor) * 100
        : null;
      results.push({
        combo_id: comboId(combo),
        ...combo,
        is_stats: isStat,
        oos_stats: oosStat,
        decay_pct: decayPct ? Number(decayPct.toFixed(1)) : null,
        robustness,
      });
    }
    if (i % 1000 === 0) {
      const pct = ((i / ALL_COMBOS.length) * 100).toFixed(0);
      const dt = ((Date.now() - tWf) / 1000).toFixed(0);
      console.log(`  [${i}/${ALL_COMBOS.length}] ${pct}% (${dt}s)`);
    }
  }
  console.log(`[wf] Walk-forward done in ${((Date.now()-tWf)/1000).toFixed(0)}s`);

  // Filtre les ROBUSTES et trie par OOS expectancy
  const robustes = results.filter(r => r.robustness === 'ROBUSTE' || r.robustness === 'ROBUSTE_BONUS')
    .sort((a, b) => (b.oos_stats?.expectancy || 0) - (a.oos_stats?.expectancy || 0));
  const passables = results.filter(r => r.robustness === 'PASSABLE')
    .sort((a, b) => (b.oos_stats?.expectancy || 0) - (a.oos_stats?.expectancy || 0));
  const overfits = results.filter(r => r.robustness === 'OVERFIT');

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('WALK-FORWARD VERDICT');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  ROBUSTE        : ${robustes.length} combos (decay < 30%)`);
  console.log(`  PASSABLE       : ${passables.length} combos (decay 30-50%)`);
  console.log(`  OVERFIT        : ${overfits.length} combos (decay > 50% ou OOS PF < 1.0)`);
  console.log(`  TOTAL ÉVALUÉS  : ${results.length}`);

  console.log('\n═══ TOP 5 COMBOS ROBUSTES (vraies armes mathématiques) ═══');
  for (const r of robustes.slice(0, 5)) {
    console.log(`\n  ${r.combo_id}`);
    console.log(`    IS  : ${r.is_stats.num_trades}t · win ${r.is_stats.win_rate}% · PF ${r.is_stats.profit_factor} · exp ${r.is_stats.expectancy}R`);
    console.log(`    OOS : ${r.oos_stats.num_trades}t · win ${r.oos_stats.win_rate}% · PF ${r.oos_stats.profit_factor} · exp ${r.oos_stats.expectancy}R`);
    console.log(`    Decay: ${r.decay_pct}% (verdict ${r.robustness})`);
  }

  // v2.97 — Refs v2.93 ÉTENDUES avec les nouvelles dimensions (ichi/mfi/hull = any)
  // pour qu'elles matchent avec le PARAM_SPACE v2.97
  const referenceCombos = [
    { name: 'DAY (v2.93)',   spec: { rsi_thr: 25, rsi_dir: 'below', ma_cross: 'bull', macd_hist: 'negative', min_adx: 0, boll_pos: 'low', atr_stop: 1.0, atr_tp2: 4.0, hold_days: 5,  ichi: 'any', mfi: 'any', hull: 'any' } },
    { name: 'WEEK (v2.93)',  spec: { rsi_thr: 25, rsi_dir: 'below', ma_cross: 'bull', macd_hist: 'negative', min_adx: 0, boll_pos: 'low', atr_stop: 1.0, atr_tp2: 5.0, hold_days: 15, ichi: 'any', mfi: 'any', hull: 'any' } },
    { name: 'MONTH (v2.93)', spec: { rsi_thr: 25, rsi_dir: 'below', ma_cross: 'bull', macd_hist: 'negative', min_adx: 0, boll_pos: 'low', atr_stop: 1.0, atr_tp2: 7.0, hold_days: 60, ichi: 'any', mfi: 'any', hull: 'any' } },
  ];
  console.log('\n═══ VÉRIFICATION DES COMBOS v2.93 ACTUELS ═══');
  const refResults = [];
  for (const ref of referenceCombos) {
    const matching = results.find(r =>
      r.rsi_thr === ref.spec.rsi_thr && r.rsi_dir === ref.spec.rsi_dir &&
      r.ma_cross === ref.spec.ma_cross && r.macd_hist === ref.spec.macd_hist &&
      r.min_adx === ref.spec.min_adx && r.boll_pos === ref.spec.boll_pos &&
      r.atr_stop === ref.spec.atr_stop && r.atr_tp2 === ref.spec.atr_tp2 &&
      r.hold_days === ref.spec.hold_days);
    if (matching) {
      console.log(`\n  ${ref.name} → ${matching.robustness} (decay ${matching.decay_pct}%)`);
      console.log(`    IS  PF ${matching.is_stats.profit_factor} · exp ${matching.is_stats.expectancy}R`);
      console.log(`    OOS PF ${matching.oos_stats.profit_factor} · exp ${matching.oos_stats.expectancy}R`);
      refResults.push({ name: ref.name, ...matching });
    } else {
      // Si pas dans results (filtré comme INVALID/WEAK_IS), on l'évalue manuellement
      const { is: isStat, oos: oosStat } = evalComboPhased(ref.spec, assetData);
      const robust = classifyRobustness(isStat, oosStat);
      console.log(`\n  ${ref.name} → ${robust} (filtré du résultats principal)`);
      if (isStat) console.log(`    IS  PF ${isStat.profit_factor} · ${isStat.num_trades}t`);
      if (oosStat) console.log(`    OOS PF ${oosStat.profit_factor} · ${oosStat.num_trades}t`);
      refResults.push({ name: ref.name, robustness: robust, is_stats: isStat, oos_stats: oosStat });
    }
  }

  const out = {
    generated: new Date().toISOString(),
    history_range: HISTORY_RANGE,
    is_ratio: IS_RATIO,
    num_assets: assets.length,
    num_combos_tested: ALL_COMBOS.length,
    methodology: {
      description: 'Walk-forward validation : split historique 70%/30%, optimisation sur IS, validation OOS. Mesure du DECAY pour chaque combo. Robust si decay < 30%, overfit si decay > 50% ou PF OOS < 1.0.',
      classifications: {
        ROBUSTE: 'IS PF ≥ 1.2, decay < 30% — VRAI EDGE',
        ROBUSTE_BONUS: 'OOS PF > IS PF — possible chance',
        PASSABLE: 'decay 30-50% — à monitorer',
        OVERFIT: 'decay > 50% ou OOS PF < 1.0 — À EXCLURE',
        WEAK_IS: 'PF IS < 1.2 — pas rentable en training',
        INVALID: 'pas assez de trades pour stats fiables',
      },
    },
    summary: {
      ROBUSTE: robustes.length,
      PASSABLE: passables.length,
      OVERFIT: overfits.length,
      total_evaluated: results.length,
    },
    top_robustes: robustes.slice(0, 50),
    top_passables: passables.slice(0, 20),
    reference_v293_combos: refResults,
  };
  const target = path.join(process.cwd(), OUTPUT_FILE);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`\n[wf] Wrote ${target}`);
}

main().catch(e => { console.error('[wf] FAILED:', e); process.exit(1); });
