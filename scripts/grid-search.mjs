#!/usr/bin/env node
/**
 * Trade Genius — Grid-search paramétrique massif (v2.85)
 *
 * Au lieu de stratégies hard-codées (tournament-strategies.mjs), on balaie
 * systématiquement l'espace des PARAMÈTRES. Chaque combinaison définit une
 * stratégie via :
 *   - Filtres d'entrée : RSI seuil + direction, MA cross, MACD, ADX min
 *   - Niveaux : multipliers ATR pour stop / TP1 / TP2
 *   - Fenêtre de hold
 *
 * L'algo :
 *   1) Pré-calcule pour chaque (asset, bar) un set de FLAGS booléens (rsi<25,
 *      ma_bull, macd_pos, etc.) UNE FOIS. Coûte ~3-5 min sur 86 actifs × 20y.
 *   2) Pour chaque combo de paramètres (~650), parcourt les bars cachés et
 *      teste un simple AND de flags. Si match, simule le trade.
 *   3) Agrège les stats par combo et trie par profil.
 *
 * Output : data/grid-search-results.json
 *   - top 50 combos par profil (CONSERVATEUR / ÉQUILIBRÉ / AGRESSIF)
 *   - meilleurs combos par classe d'actif
 *   - meilleurs combos par fenêtre de hold (DAY/WEEK/MONTH)
 *
 * Workflow GH : grid-search.yml (timeout 180 min, workflow_dispatch)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  fetchYahooHistorical,
  computeAllIndicators, atrPct,
} from './indicators.mjs';

const HISTORY_RANGE = process.env.TG_GRID_RANGE || '20y';
const OUTPUT_FILE = process.env.TG_GRID_OUTPUT || 'data/grid-search-results.json';
const WARMUP = 220;
const MAX_LOOK_AHEAD = 80;
const MIN_TRADES_VALID = 100;

// ─── PANIER (sous-ensemble représentatif pour gain de temps) ─────────
const ASSETS = [
  // Indices majeurs
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
  // Top actions US
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
  // ETF principaux
  { kind: 'action', symbol: 'SPY', label: 'SPY' },
  { kind: 'action', symbol: 'QQQ', label: 'QQQ' },
  { kind: 'action', symbol: 'IWM', label: 'IWM' },
  { kind: 'action', symbol: 'EEM', label: 'EEM' },
  { kind: 'action', symbol: 'GLD', label: 'GLD' },
  { kind: 'action', symbol: 'TLT', label: 'TLT' },
  { kind: 'action', symbol: 'XLK', label: 'XLK Tech' },
  { kind: 'action', symbol: 'XLF', label: 'XLF Finance' },
  { kind: 'action', symbol: 'XLE', label: 'XLE Energy' },
  // EU
  { kind: 'action', symbol: 'MC.PA', label: 'LVMH' },
  { kind: 'action', symbol: 'ASML.AS', label: 'ASML' },
  { kind: 'action', symbol: 'NESN.SW', label: 'Nestlé' },
  // Forex
  { kind: 'forex', symbol: 'EURUSD=X', label: 'EUR/USD' },
  { kind: 'forex', symbol: 'GBPUSD=X', label: 'GBP/USD' },
  { kind: 'forex', symbol: 'USDJPY=X', label: 'USD/JPY' },
  { kind: 'forex', symbol: 'USDCHF=X', label: 'USD/CHF' },
  { kind: 'forex', symbol: 'AUDUSD=X', label: 'AUD/USD' },
  // Métaux & Matières
  { kind: 'metal', symbol: 'GC=F', label: 'Or' },
  { kind: 'metal', symbol: 'SI=F', label: 'Argent' },
  { kind: 'metal', symbol: 'HG=F', label: 'Cuivre' },
  { kind: 'metal', symbol: 'CL=F', label: 'Pétrole' },
  { kind: 'metal', symbol: 'BZ=F', label: 'Brent' },
];

// ─── PARAM SPACE ─────────────────────────────────────────────────────
const PARAM_SPACE = {
  // RSI seuil + direction
  rsi_thr: [25, 30, 35, 40],
  rsi_dir: ['below', 'above'], // below=oversold (long contrarian), above=trend (long momentum)
  // MA cross condition
  ma_cross: ['bull', 'any'],   // bull = MA20>MA50, any = pas de filtre
  // MACD histogram
  macd_hist: ['positive', 'any'], // positive = >0, any = pas de filtre
  // ADX seuil minimum
  min_adx: [0, 20, 25],
  // Niveaux ATR multipliers
  atr_stop: [1.5, 2.0],
  atr_tp2: [3.0, 4.0, 5.0],
  // Fenêtre de hold (DAY / WEEK / MONTH)
  hold_days: [5, 15, 60],
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

const allCombos = [...iterCombos(PARAM_SPACE)];
console.log(`[grid] PARAM_SPACE = ${allCombos.length} combos`);

// ─── Précompute flags par bar pour un actif ──────────────────────────
function precomputeFlags(asset) {
  const { prices, volumes } = asset;
  if (!prices || prices.length < WARMUP + MAX_LOOK_AHEAD + 5) return null;
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
    flags[t] = {
      price: last,
      atrAbs,
      // RSI flags
      rsi_below_25: rsi < 25, rsi_below_30: rsi < 30, rsi_below_35: rsi < 35, rsi_below_40: rsi < 40,
      rsi_above_25: rsi > 25, rsi_above_30: rsi > 30, rsi_above_35: rsi > 35, rsi_above_40: rsi > 40,
      // MA cross
      ma_bull: ma20 != null && ma50 != null && ma20 > ma50,
      // MACD
      macd_pos: macdH != null && macdH > 0,
      // ADX
      adx_val: adx,
    };
  }
  return flags;
}

// Évalue un combo sur un (asset, bar). Retourne le signal ou null.
function evalCombo(combo, flags) {
  if (!flags) return null;
  const rsiKey = (combo.rsi_dir === 'below' ? 'rsi_below_' : 'rsi_above_') + combo.rsi_thr;
  if (!flags[rsiKey]) return null;
  if (combo.ma_cross === 'bull' && !flags.ma_bull) return null;
  if (combo.macd_hist === 'positive' && !flags.macd_pos) return null;
  if (combo.min_adx > 0 && flags.adx_val < combo.min_adx) return null;
  // Signal trouvé. Calcule les niveaux.
  const entry = flags.price;
  const stop = entry - combo.atr_stop * flags.atrAbs;
  const tp2 = entry + combo.atr_tp2 * flags.atrAbs;
  const tp1 = entry + (combo.atr_tp2 * 0.5) * flags.atrAbs; // tp1 mi-chemin
  if (stop >= entry || tp2 <= entry || tp1 <= entry || tp1 >= tp2) return null;
  const risk = entry - stop;
  const rr2 = (tp2 - entry) / risk;
  if (rr2 < 1.5) return null; // R/R min global
  return { entry, stop, tp1, tp2, rr2 };
}

function resolveTrade(prices, t, sig, holdDays) {
  const { entry, stop, tp1, tp2, rr2 } = sig;
  let touchedTp1 = false;
  const endIdx = Math.min(t + holdDays, prices.length - 1);
  for (let i = t + 1; i <= endIdx; i++) {
    const c = prices[i];
    if (c <= stop) {
      if (touchedTp1) return rr2 * 0.25; // partial win
      return -1; // loss
    }
    if (!touchedTp1 && c >= tp1) touchedTp1 = true;
    if (c >= tp2) return rr2; // full win
  }
  // Timeout
  const exitClose = prices[endIdx];
  const pnl = (exitClose - entry) / (entry - stop);
  if (touchedTp1) return Math.max(rr2 * 0.25, pnl / 2);
  return pnl;
}

// ─── Fetch ──────────────────────────────────────────────────────────
async function fetchAsset(a) {
  try {
    const d = await fetchYahooHistorical(a.symbol, HISTORY_RANGE);
    return { ...a, prices: d.prices, volumes: d.volumes };
  } catch (e) { return null; }
}

// ─── Stats helpers ───────────────────────────────────────────────────
function statsFor(pnls, kinds) {
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
    total_pnl: Number(totalPnl.toFixed(1)),
    expectancy: Number(expectancy.toFixed(3)),
    avg_win: Number(avgWin.toFixed(2)),
    avg_loss: Number(avgLoss.toFixed(2)),
  };
}

function classifyProfile(stats) {
  if (!stats || stats.num_trades < MIN_TRADES_VALID) return 'INVALID';
  if (stats.profit_factor < 1.2 || stats.expectancy < 0) return 'WEAK';
  if (stats.win_rate >= 55 && stats.profit_factor >= 1.8) return 'CONSERVATEUR';
  if (stats.win_rate >= 47 && stats.profit_factor >= 1.8) return 'ÉQUILIBRÉ';
  if (stats.expectancy >= 0.5) return 'AGRESSIF';
  return 'WEAK';
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log(`[grid] ${ASSETS.length} actifs, ${allCombos.length} combos, historique ${HISTORY_RANGE}`);

  // Fetch
  console.log('[grid] Fetching assets...');
  const assets = [];
  for (const a of ASSETS) {
    const r = await fetchAsset(a);
    if (r) assets.push(r);
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`\n[grid] ${assets.length}/${ASSETS.length} actifs OK`);

  // Précompute flags par actif
  console.log('[grid] Pre-computing flags...');
  const tStart = Date.now();
  const flagsByAsset = new Map();
  for (const a of assets) {
    const flags = precomputeFlags(a);
    flagsByAsset.set(a.label, flags);
    process.stdout.write('.');
  }
  console.log(`\n[grid] Flags ready in ${((Date.now()-tStart)/1000).toFixed(1)}s`);

  // Pour chaque combo, accumule trades
  console.log('[grid] Running grid search...');
  const results = [];
  let comboIdx = 0;
  const tGrid = Date.now();
  for (const combo of allCombos) {
    comboIdx++;
    const pnlsByKind = { index: [], action: [], forex: [], metal: [] };
    const allPnls = [];
    for (const a of assets) {
      const flags = flagsByAsset.get(a.label);
      if (!flags) continue;
      const { prices } = a;
      for (let t = WARMUP; t < prices.length - combo.hold_days - 1; t++) {
        const cell = flags[t];
        if (!cell) continue;
        const sig = evalCombo(combo, cell);
        if (!sig) continue;
        const pnl = resolveTrade(prices, t, sig, combo.hold_days);
        const rounded = Number(pnl.toFixed(2));
        allPnls.push(rounded);
        if (pnlsByKind[a.kind]) pnlsByKind[a.kind].push(rounded);
      }
    }
    const stats = statsFor(allPnls);
    const profile = classifyProfile(stats);
    const byKind = {};
    for (const k of Object.keys(pnlsByKind)) {
      const s = statsFor(pnlsByKind[k]);
      if (s) byKind[k] = s;
    }
    const combo_id = `rsi${combo.rsi_dir}${combo.rsi_thr}_ma${combo.ma_cross}_macd${combo.macd_hist}_adx${combo.min_adx}_atr${combo.atr_stop}-${combo.atr_tp2}_h${combo.hold_days}`;
    results.push({
      combo_id, ...combo,
      ...(stats || { num_trades: 0 }),
      profile, byKind,
    });
    if (comboIdx % 50 === 0) {
      const dt = ((Date.now()-tGrid)/1000).toFixed(0);
      const pct = ((comboIdx / allCombos.length) * 100).toFixed(0);
      console.log(`  [${comboIdx}/${allCombos.length}] (${pct}%, ${dt}s elapsed)`);
    }
  }
  console.log(`[grid] Grid search done in ${((Date.now()-tGrid)/1000).toFixed(0)}s`);

  // Tri par profil
  const byProfile = {
    CONSERVATEUR: results.filter(r => r.profile === 'CONSERVATEUR').sort((a, b) => b.expectancy - a.expectancy),
    'ÉQUILIBRÉ':  results.filter(r => r.profile === 'ÉQUILIBRÉ').sort((a, b) => b.expectancy - a.expectancy),
    AGRESSIF:     results.filter(r => r.profile === 'AGRESSIF').sort((a, b) => b.expectancy - a.expectancy),
  };
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('TOP 5 PAR PROFIL');
  console.log('═══════════════════════════════════════════════════════════');
  for (const profile of ['CONSERVATEUR', 'ÉQUILIBRÉ', 'AGRESSIF']) {
    console.log(`\n▸ ${profile} (${byProfile[profile].length} combos valides) :`);
    for (const c of byProfile[profile].slice(0, 5)) {
      console.log(`  ${c.combo_id}`);
      console.log(`    ${c.num_trades}t · win ${c.win_rate}% · PF ${c.profit_factor} · exp ${c.expectancy}R`);
    }
  }

  // Tri par fenêtre de hold (DAY/WEEK/MONTH)
  const byHold = {
    DAY:   results.filter(r => r.hold_days === 5).filter(r => r.profile !== 'WEAK' && r.profile !== 'INVALID').sort((a,b) => b.expectancy - a.expectancy),
    WEEK:  results.filter(r => r.hold_days === 15).filter(r => r.profile !== 'WEAK' && r.profile !== 'INVALID').sort((a,b) => b.expectancy - a.expectancy),
    MONTH: results.filter(r => r.hold_days === 60).filter(r => r.profile !== 'WEAK' && r.profile !== 'INVALID').sort((a,b) => b.expectancy - a.expectancy),
  };
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('TOP 3 PAR FENÊTRE TEMPORELLE');
  console.log('═══════════════════════════════════════════════════════════');
  for (const win of ['DAY', 'WEEK', 'MONTH']) {
    console.log(`\n▸ ${win} (hold ${{DAY:5,WEEK:15,MONTH:60}[win]}j, ${byHold[win].length} combos rentables) :`);
    for (const c of byHold[win].slice(0, 3)) {
      console.log(`  ${c.combo_id} (${c.profile})`);
      console.log(`    ${c.num_trades}t · win ${c.win_rate}% · PF ${c.profit_factor} · exp ${c.expectancy}R`);
    }
  }

  const out = {
    generated: new Date().toISOString(),
    history_range: HISTORY_RANGE,
    num_assets: assets.length,
    num_combos_tested: allCombos.length,
    min_trades_for_valid: MIN_TRADES_VALID,
    param_space: PARAM_SPACE,
    methodology: {
      description: 'Grid-search paramétrique : balaie systématiquement N combinaisons de paramètres (RSI, MA cross, MACD, ADX, ATR mult, hold) et identifie les meilleurs combos par profil de performance.',
      caveats: [
        'Closes uniquement (pas de high/low)',
        'Pas de slippage/frais',
        'Modèle simple long-only',
        'Le profil CONSERVATEUR/ÉQUILIBRÉ/AGRESSIF est un guide statistique, pas un dogme',
      ],
    },
    top_by_profile: {
      CONSERVATEUR: byProfile.CONSERVATEUR.slice(0, 50),
      'ÉQUILIBRÉ':  byProfile['ÉQUILIBRÉ'].slice(0, 50),
      AGRESSIF:     byProfile.AGRESSIF.slice(0, 50),
    },
    top_by_hold: {
      DAY:   byHold.DAY.slice(0, 20),
      WEEK:  byHold.WEEK.slice(0, 20),
      MONTH: byHold.MONTH.slice(0, 20),
    },
    counts: {
      total: results.length,
      CONSERVATEUR: byProfile.CONSERVATEUR.length,
      'ÉQUILIBRÉ': byProfile['ÉQUILIBRÉ'].length,
      AGRESSIF: byProfile.AGRESSIF.length,
      WEAK: results.filter(r => r.profile === 'WEAK').length,
      INVALID: results.filter(r => r.profile === 'INVALID').length,
    },
  };

  const target = path.join(process.cwd(), OUTPUT_FILE);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`\n[grid] Wrote ${target}`);
  console.log(`[grid] Counts:`, out.counts);
}

main().catch(e => { console.error('[grid] FAILED:', e); process.exit(1); });
