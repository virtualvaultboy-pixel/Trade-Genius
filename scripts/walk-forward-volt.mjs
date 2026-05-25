#!/usr/bin/env node
/**
 * Trade Genius — v7.13 Walk-forward validation VOLT
 *
 * Anti-overfit critique : découpe les 600j en 5 sous-périodes indépendantes
 * et lance A-SCALP-WIDE sur chacune. Mesure la stabilité réelle.
 *
 * Verdict :
 *   - Si médiane ≥ 8%/an ET tous folds > 0% → config robuste, on déploie
 *   - Si std > 50% du médian → instable, vraisemblablement chance de période
 *   - Si 1+ fold négatif → fragile, refondre filtres
 *
 * Output : data/sandbox/walkforward_volt.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchYahooHistorical, computeAllIndicators, atrPct, sma } from './indicators.mjs';

const CAPITAL_INITIAL = 1000;
const MAX_POSITIONS = 3;
const WARMUP = 220;
const HISTORY_RANGE = '5y';
const TOTAL_DAYS = 600;
const N_FOLDS = 5;
const FOLD_DAYS = Math.floor(TOTAL_DAYS / N_FOLDS);  // 120j par fold

// Config ABC-TRIPLE (champion v7.13 — Pattern A+B+C combinés)
const CONFIG = {
  name: 'ABC-TRIPLE',
  mode: 'patternABC',
  minQ: 65,
  timeoutDays: 15,
  trailingAfterTp1: true,
  atrStop: 0.6,
  atrTp2: 4.5,
};

// 41 actifs VOLT_UNIVERSE (synchro avec backtest-volt.mjs)
const VOLT_ASSETS = [
  { symbol: 'SOL-USD',  label: 'Solana',     kind: 'crypto' },
  { symbol: 'AVAX-USD', label: 'Avalanche',  kind: 'crypto' },
  { symbol: 'NEAR-USD', label: 'Near',       kind: 'crypto' },
  { symbol: 'RNDR-USD', label: 'Render',     kind: 'crypto' },
  { symbol: 'INJ-USD',  label: 'Injective',  kind: 'crypto' },
  { symbol: 'SUI-USD',  label: 'Sui',        kind: 'crypto' },
  { symbol: 'APT-USD',  label: 'Aptos',      kind: 'crypto' },
  { symbol: 'TIA-USD',  label: 'Celestia',   kind: 'crypto' },
  { symbol: 'SEI-USD',  label: 'Sei',        kind: 'crypto' },
  { symbol: 'LDO-USD',  label: 'Lido DAO',   kind: 'crypto' },
  { symbol: 'ARB-USD',  label: 'Arbitrum',   kind: 'crypto' },
  { symbol: 'OP-USD',   label: 'Optimism',   kind: 'crypto' },
  { symbol: 'FET-USD',  label: 'Fetch.ai',   kind: 'crypto' },
  { symbol: 'AGIX-USD', label: 'SingularityNET', kind: 'crypto' },
  { symbol: 'MATIC-USD', label: 'Polygon',   kind: 'crypto' },
  { symbol: 'ATOM-USD', label: 'Cosmos',     kind: 'crypto' },
  { symbol: 'FIL-USD',  label: 'Filecoin',   kind: 'crypto' },
  { symbol: 'ICP-USD',  label: 'Internet Computer', kind: 'crypto' },
  { symbol: 'TSLA', label: 'Tesla',          kind: 'action' },
  { symbol: 'PLTR', label: 'Palantir',       kind: 'action' },
  { symbol: 'COIN', label: 'Coinbase',       kind: 'action' },
  { symbol: 'MSTR', label: 'MicroStrategy',  kind: 'action' },
  { symbol: 'AFRM', label: 'Affirm',         kind: 'action' },
  { symbol: 'SOFI', label: 'SoFi',           kind: 'action' },
  { symbol: 'RIVN', label: 'Rivian',         kind: 'action' },
  { symbol: 'CVNA', label: 'Carvana',        kind: 'action' },
  { symbol: 'ARM',  label: 'Arm',            kind: 'action' },
  { symbol: 'SMCI', label: 'Super Micro',    kind: 'action' },
  { symbol: 'ASTS', label: 'AST SpaceMobile', kind: 'action' },
  { symbol: 'IONQ', label: 'IonQ',           kind: 'action' },
  { symbol: 'RKLB', label: 'Rocket Lab',     kind: 'action' },
  { symbol: 'ACHR', label: 'Archer Aviation', kind: 'action' },
  { symbol: 'LCID', label: 'Lucid',          kind: 'action' },
  { symbol: 'PLUG', label: 'Plug Power',     kind: 'action' },
  { symbol: 'JOBY', label: 'Joby Aviation',  kind: 'action' },
  { symbol: 'RBLX', label: 'Roblox',         kind: 'action' },
  { symbol: 'SNAP', label: 'Snap',           kind: 'action' },
  { symbol: 'U',    label: 'Unity',          kind: 'action' },
  { symbol: 'DKNG', label: 'DraftKings',     kind: 'action' },
  { symbol: 'ROKU', label: 'Roku',           kind: 'action' },
  { symbol: 'BYND', label: 'Beyond Meat',    kind: 'action' },
];

function detectRegime(prices) {
  if (!prices || prices.length < 200) return 'unknown';
  const sma200Now = sma(prices.slice(-200), 200);
  const sma200Ago = sma(prices.slice(-220, -20), 200);
  if (sma200Now == null || sma200Ago == null || sma200Ago === 0) return 'unknown';
  const slope = (sma200Now - sma200Ago) / sma200Ago;
  if (slope > 0.03) return 'bull';
  if (slope < -0.03) return 'bear';
  return 'sideways';
}

// ── Helper finalize (commun aux 3 patterns) ──────────
function _finalize(ind, close, atrAbs, regime, obvTrend) {
  const entry = close;
  const stop = entry - CONFIG.atrStop * atrAbs;
  const tp1 = entry + (CONFIG.atrTp2 * 0.5) * atrAbs;
  const tp2 = entry + CONFIG.atrTp2 * atrAbs;
  if (stop >= entry || tp1 <= entry || tp2 <= tp1) return null;
  const risk = entry - stop;
  const rr2 = (tp2 - entry) / risk;
  if (rr2 < 2.0) return null;
  // Quality score VOLT
  let q = 80;
  if (regime === 'bull') q += 10;
  else if (regime === 'sideways') q += 5;
  const adx = ind.adx?.value || 0;
  if (adx >= 35) q += 10; else if (adx >= 25) q += 5;
  if (rr2 >= 4) q += 10; else if (rr2 >= 3) q += 5;
  if (obvTrend === 'up') q += 5;
  q = Math.min(100, q);
  let sizing_pct = q >= 85 ? 8 : q >= 75 ? 5 : 3;
  return { quality: q, sizing_pct, entry, stop, tp1, tp2, rr1: (tp1 - entry) / risk, rr2, regime };
}

// ── Pattern A : contrarian RSI<25 ──────────
function _patternA(ind, prices) {
  const rsi = ind.rsi?.value, boll = ind.boll?.value, macdH = ind.macd?.value;
  if (rsi == null || rsi >= 25) return null;
  if (boll == null || boll >= 0.25) return null;
  if (macdH == null || macdH >= 0) return null;
  const regime = detectRegime(prices);
  if (regime === 'bear') return null;
  if (ind.mfi?.value > 70) return null;
  const atrPctV = ind.atr?.value;
  if (atrPctV == null) return null;
  const close = prices[prices.length - 1];
  return _finalize(ind, close, (atrPctV / 100) * close, regime, ind.obv?.trend);
}

// ── Pattern C : pullback Ichimoku bull ──────────
function _patternC(ind, prices) {
  const rsi = ind.rsi?.value, boll = ind.boll?.value, ichi = ind.ichimoku;
  if (rsi == null || rsi <= 35) return null;
  if (boll == null || boll >= 0.25) return null;
  if (!ichi || ichi.position !== 'above-cloud' || ichi.signal !== 'bull') return null;
  if (ind.obv?.trend === 'down') return null;
  const regime = detectRegime(prices);
  if (regime === 'bear') return null;
  const atrPctV = ind.atr?.value;
  if (atrPctV == null) return null;
  const close = prices[prices.length - 1];
  return _finalize(ind, close, (atrPctV / 100) * close, regime, ind.obv?.trend);
}

// ── Pattern B : trend-follow correction ──────────
function _patternB(ind, prices) {
  const rsi = ind.rsi?.value, adx = ind.adx?.value || 0, boll = ind.boll?.value, macdH = ind.macd?.value;
  if (rsi == null || rsi <= 35) return null;
  if (adx < 25) return null;
  if (boll == null || boll < 0.25 || boll > 0.75) return null;
  if (macdH == null || macdH >= 0) return null;
  const regime = detectRegime(prices);
  if (regime === 'bear') return null;
  if (ind.obv?.trend === 'down') return null;
  const atrPctV = ind.atr?.value;
  if (atrPctV == null) return null;
  const close = prices[prices.length - 1];
  return _finalize(ind, close, (atrPctV / 100) * close, regime, ind.obv?.trend);
}

// ── ABC-TRIPLE : A OU B OU C (premier qui matche) ──
function detectVoltScalp(prices, volumes) {
  if (!prices || prices.length < 60) return null;
  const ind = computeAllIndicators(prices, volumes);
  if (!ind) return null;
  return _patternA(ind, prices) || _patternC(ind, prices) || _patternB(ind, prices);
}

// Backtest sur une plage [startIdx, endIdx] (fold)
function runFold(data, startIdx, endIdx, foldName) {
  let cash = CAPITAL_INITIAL;
  let positions = [];
  const equityHist = [];
  const closed = [];

  for (let d = startIdx; d < endIdx; d++) {
    const today = d;
    const tomorrow = d + 1;

    // Update positions
    positions = positions.filter(pos => {
      const asset = data[pos.asset];
      if (!asset) return false;
      const cur = asset.prices[tomorrow];
      if (cur == null) return true;
      const ageDays = d - pos.opened_at;

      if (pos.high_since_entry == null || cur > pos.high_since_entry) pos.high_since_entry = cur;
      if (pos.touched_tp1 && CONFIG.trailingAfterTp1) {
        const initialRisk = pos.entry - pos.initial_stop;
        const chandStop = pos.high_since_entry - initialRisk;
        if (chandStop > pos.stop) pos.stop = chandStop;
      }

      if (cur <= pos.stop) {
        let pnl;
        if (pos.trailing_active && pos.stop > pos.entry) {
          const gainSecondHalf = ((pos.stop - pos.entry) / pos.entry) * pos.size_eur * 0.5;
          pnl = pos.size_eur * pos.rr1 * 0.5 * pos.risk_pct + gainSecondHalf;
        } else if (pos.touched_tp1) {
          pnl = pos.trailing_active
            ? pos.size_eur * pos.rr1 * 0.5 * pos.risk_pct
            : pos.size_eur * (pos.rr1 * 0.5 - 0.5) * pos.risk_pct;
        } else {
          pnl = -pos.size_eur * pos.risk_pct;
        }
        cash += pos.size_eur + pnl;
        closed.push({ ...pos, pnl_eur: pnl, closed_at: d });
        return false;
      }
      if (cur >= pos.tp2) {
        const pnl = pos.size_eur * pos.rr2 * pos.risk_pct;
        cash += pos.size_eur + pnl;
        closed.push({ ...pos, pnl_eur: pnl, closed_at: d });
        return false;
      }
      if (!pos.touched_tp1 && cur >= pos.tp1) {
        pos.touched_tp1 = true;
        pos.stop = pos.entry;
        pos.trailing_active = true;
      }
      if (ageDays >= CONFIG.timeoutDays) {
        const pnlPct = (cur - pos.entry) / pos.entry;
        const pnl = pos.size_eur * pnlPct;
        cash += pos.size_eur + pnl;
        closed.push({ ...pos, pnl_eur: pnl, closed_at: d });
        return false;
      }
      pos.current_price = cur;
      return true;
    });

    // Open new positions
    if (positions.length < MAX_POSITIONS && cash > 1) {
      const opened = new Set(positions.map(p => p.asset));
      const candidates = [];

      for (const [label, asset] of Object.entries(data)) {
        if (opened.has(label)) continue;
        const slice = asset.prices.slice(0, today + 1);
        if (slice.length < WARMUP) continue;
        const sliceVol = asset.volumes.slice(0, today + 1);
        const setup = detectVoltScalp(slice, sliceVol);
        if (!setup) continue;
        if (setup.quality < CONFIG.minQ) continue;
        candidates.push({ label, setup });
      }
      candidates.sort((a, b) => b.setup.quality - a.setup.quality);
      const slots = MAX_POSITIONS - positions.length;
      const recent5 = closed.slice(-5);
      let streakMult = 1;
      if (recent5.length >= 3) {
        const last3 = recent5.slice(-3);
        if (last3.every(t => (t.pnl_eur || 0) > 0)) streakMult = 1.2;
        else if (last3.every(t => (t.pnl_eur || 0) <= 0)) streakMult = 0.7;
      }
      for (const c of candidates.slice(0, slots)) {
        const size_eur = cash * (c.setup.sizing_pct * streakMult / 100);
        if (size_eur < 1) continue;
        cash -= size_eur;
        const risk_pct = (c.setup.entry - c.setup.stop) / c.setup.entry;
        positions.push({
          asset: c.label, quality: c.setup.quality,
          sizing_pct: c.setup.sizing_pct, regime: c.setup.regime,
          entry: c.setup.entry, stop: c.setup.stop, tp1: c.setup.tp1, tp2: c.setup.tp2,
          initial_stop: c.setup.stop, high_since_entry: c.setup.entry,
          rr1: c.setup.rr1, rr2: c.setup.rr2,
          size_eur, risk_pct,
          touched_tp1: false, trailing_active: false,
          opened_at: d,
        });
      }
    }

    let eq = cash;
    for (const p of positions) {
      const cur = data[p.asset].prices[today] || p.entry;
      eq += p.size_eur * (cur / p.entry);
    }
    equityHist.push({ day: d, equity: eq });
  }

  const finalEq = equityHist[equityHist.length - 1]?.equity || CAPITAL_INITIAL;
  const foldDays = endIdx - startIdx;
  const ret = ((finalEq - CAPITAL_INITIAL) / CAPITAL_INITIAL) * 100;
  const annualized = (Math.pow(1 + ret / 100, 252 / foldDays) - 1) * 100;
  const wins = closed.filter(t => t.pnl_eur > 0);
  const losses = closed.filter(t => t.pnl_eur <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl_eur, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl_eur, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (wins.length > 0 ? 999 : 0);
  const wr = closed.length > 0 ? wins.length / closed.length : 0;
  let maxEq = CAPITAL_INITIAL, maxDd = 0;
  equityHist.forEach(p => {
    if (p.equity > maxEq) maxEq = p.equity;
    const dd = (p.equity - maxEq) / maxEq;
    if (dd < maxDd) maxDd = dd;
  });
  return {
    fold: foldName,
    days: foldDays,
    equity_final: Number(finalEq.toFixed(2)),
    return_pct: Number(ret.toFixed(2)),
    annualized_pct: Number(annualized.toFixed(2)),
    profit_factor: Number(pf.toFixed(2)),
    max_dd_pct: Number((maxDd * 100).toFixed(2)),
    win_rate_pct: Number((wr * 100).toFixed(1)),
    trades_closed: closed.length,
  };
}

async function main() {
  console.log(`=== Walk-forward VOLT v7.13 · ${N_FOLDS} folds × ${FOLD_DAYS}j · 1000€ ===\n`);
  console.log('Fetching 41 actifs...');
  const data = {};
  for (const a of VOLT_ASSETS) {
    try {
      const d = await fetchYahooHistorical(a.symbol, HISTORY_RANGE);
      if (!d || !Array.isArray(d.prices) || d.prices.length < WARMUP + 50) continue;
      data[a.label] = { ...a, prices: d.prices, volumes: d.volumes || [] };
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  const assetsLoaded = Object.keys(data).length;
  console.log(`  ${assetsLoaded}/${VOLT_ASSETS.length} actifs chargés\n`);

  const lengths = Object.values(data).map(d => d.prices.length);
  const minLen = Math.min(...lengths);
  const startGlobal = minLen - TOTAL_DAYS;
  console.log(`Backtest global : indices [${startGlobal}, ${minLen}] = ${TOTAL_DAYS}j\n`);
  console.log(`Lancement des ${N_FOLDS} folds (chacun ${FOLD_DAYS}j indépendant)...\n`);

  const folds = [];
  for (let i = 0; i < N_FOLDS; i++) {
    const foldStart = startGlobal + i * FOLD_DAYS;
    const foldEnd = foldStart + FOLD_DAYS;
    const foldName = `FOLD-${i + 1}`;
    console.log(`  → ${foldName} : jours [${foldStart}, ${foldEnd}]`);
    const r = runFold(data, foldStart, foldEnd, foldName);
    folds.push(r);
  }

  // Stats agrégées
  const anns = folds.map(f => f.annualized_pct);
  const dds = folds.map(f => f.max_dd_pct);
  const pfs = folds.map(f => f.profit_factor);
  const wrs = folds.map(f => f.win_rate_pct);
  const sorted = [...anns].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = anns.reduce((s, x) => s + x, 0) / anns.length;
  const std = Math.sqrt(anns.reduce((s, x) => s + (x - mean) ** 2, 0) / anns.length);
  const min = Math.min(...anns);
  const max = Math.max(...anns);
  const positiveCount = anns.filter(a => a > 0).length;
  const worstDd = Math.min(...dds);

  // Verdict
  let verdict;
  if (positiveCount === N_FOLDS && median >= 10) {
    verdict = `✅ ROBUSTE : tous folds > 0%, médiane ${median.toFixed(1)}%/an, std ${std.toFixed(1)}. Config validée production.`;
  } else if (positiveCount === N_FOLDS && median >= 5) {
    verdict = `⚠️ ACCEPTABLE : tous folds > 0% mais médiane ${median.toFixed(1)}%/an (cible 10+). Honnête mais en-deçà.`;
  } else if (positiveCount >= N_FOLDS - 1 && median > 0) {
    verdict = `⚠️ FRAGILE : ${positiveCount}/${N_FOLDS} folds positifs, médiane ${median.toFixed(1)}%/an. Période-dépendant.`;
  } else {
    verdict = `❌ NON ROBUSTE : ${positiveCount}/${N_FOLDS} folds positifs. La config v7.12 est un fluke de période.`;
  }

  // Affichage
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log(`║ WALK-FORWARD VOLT · ${N_FOLDS} folds × ${FOLD_DAYS}j · config A-SCALP-WIDE                ║`);
  console.log('╠══════════╦═════════╦═════════╦══════╦═════════╦═══════╦═════════════════╣');
  console.log('║ Fold     ║ Final   ║ Annual. ║ PF   ║ Max DD  ║ WR    ║ Trades          ║');
  console.log('╟──────────╫─────────╫─────────╫──────╫─────────╫───────╫─────────────────╢');
  for (const f of folds) {
    const ann = (f.annualized_pct >= 0 ? '+' : '') + f.annualized_pct + '%';
    console.log(`║ ${f.fold.padEnd(8)} ║ ${f.equity_final.toFixed(0).padStart(5)}€  ║ ${ann.padStart(7)} ║ ${f.profit_factor.toFixed(2).padStart(4)} ║ ${(f.max_dd_pct.toFixed(1) + '%').padStart(7)} ║ ${(f.win_rate_pct.toFixed(0) + '%').padStart(5)} ║ ${f.trades_closed.toString().padStart(15)} ║`);
  }
  console.log('╠══════════╩═════════╩═════════╩══════╩═════════╩═══════╩═════════════════╣');
  console.log(`║ STATS    │ Médian: ${median.toFixed(2)}%  · Moyen: ${mean.toFixed(2)}%  · Std: ${std.toFixed(2)}%      ║`);
  console.log(`║          │ Min: ${min.toFixed(2)}%  · Max: ${max.toFixed(2)}%  · Worst DD: ${worstDd.toFixed(2)}%          ║`);
  console.log(`║          │ Folds positifs: ${positiveCount}/${N_FOLDS}                                       ║`);
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(`\n${verdict}\n`);

  // Save
  await fs.mkdir(path.join(process.cwd(), 'data', 'sandbox'), { recursive: true });
  await fs.writeFile(
    path.join(process.cwd(), 'data', 'sandbox', 'walkforward_volt.json'),
    JSON.stringify({
      generated: new Date().toISOString(),
      version: 'v7.13',
      config: CONFIG,
      n_folds: N_FOLDS,
      fold_days: FOLD_DAYS,
      assets_loaded: assetsLoaded,
      folds,
      stats: {
        median_annualized: Number(median.toFixed(2)),
        mean_annualized: Number(mean.toFixed(2)),
        std_annualized: Number(std.toFixed(2)),
        min_annualized: Number(min.toFixed(2)),
        max_annualized: Number(max.toFixed(2)),
        worst_dd: Number(worstDd.toFixed(2)),
        positive_folds: positiveCount,
      },
      verdict,
    }, null, 2) + '\n'
  );
}

main().catch(e => { console.error(e); process.exit(1); });
