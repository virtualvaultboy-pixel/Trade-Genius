#!/usr/bin/env node
/**
 * Trade Genius — v7.14 Stress Walk-forward VOLT
 *
 * Test de robustesse maximal (Aurélien : "pas le droit à l'erreur") :
 *   - 10 folds × 150j (vs 5×120j v7.13) → couvre bear crypto 2022, bull 2021, recovery 23-24
 *   - Slippage broker 0.2% in + 0.2% out (-0.4% par trade aller-retour réaliste)
 *   - Kill switch portefeuille : DD intra-fold ≤ -5% → pause 7j (skip nouveaux trades)
 *   - BTC dump filter : skip nouvelles cryptos si BTC -5%/j (contagion)
 *   - Cap sizing 5% max (au lieu de 8%) — réduit convexité gains/pertes
 *
 * Verdict :
 *   - Si tous 10 folds > 0% + médian ≥ 10%/an + DD max ≤ -8% → DÉPLOIEMENT SÛR
 *   - Si 1-2 folds négatifs mais perte ≤ -3% → ACCEPTABLE avec disclaimer
 *   - Si DD > -10% sur 1+ fold → REFUS DE DÉPLOIEMENT
 *
 * Output : data/sandbox/stress_walkforward_volt.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchYahooHistorical, computeAllIndicators, atrPct, sma } from './indicators.mjs';

const CAPITAL_INITIAL = 1000;
const MAX_POSITIONS = 3;
const WARMUP = 220;
const HISTORY_RANGE = '5y';
const N_FOLDS = 10;
const FOLD_DAYS = 150;
const TOTAL_DAYS = N_FOLDS * FOLD_DAYS;  // 1500j ≈ 6 ans

// Config ABC-TRIPLE figée (champion v7.13)
const CONFIG = {
  name: 'ABC-TRIPLE-PROTECTED',
  minQ: 65,
  timeoutDays: 15,
  trailingAfterTp1: true,
  atrStop: 0.6,
  atrTp2: 4.5,
  // v7.14 — Garde-fous anti-risque
  slippagePct: 0.002,           // 0.2% in + 0.2% out
  killSwitchDd: -0.05,          // DD ≤ -5% → pause 7j
  killSwitchPauseDays: 7,
  btcDumpThreshold: -0.05,      // BTC -5%/j → skip cryptos
  sizingCapPct: 5,              // Cap max 5% (vs 8% original)
};

// v7.14 — Univers STRESS : exclu les actifs jeunes (<1500j historique)
// pour pouvoir lancer 10 folds × 150j sur 1500j d'historique
// Actifs exclus du stress test : Sui, Celestia, Sei, Arbitrum, Optimism, Arm, Archer (trop jeunes)
// Note : en production live ces actifs SONT inclus (VOLT_UNIVERSE complet)
const VOLT_ASSETS = [
  { symbol: 'SOL-USD',  label: 'Solana',     kind: 'crypto' },
  { symbol: 'AVAX-USD', label: 'Avalanche',  kind: 'crypto' },
  { symbol: 'NEAR-USD', label: 'Near',       kind: 'crypto' },
  { symbol: 'INJ-USD',  label: 'Injective',  kind: 'crypto' },
  { symbol: 'LDO-USD',  label: 'Lido DAO',   kind: 'crypto' },
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
  { symbol: 'CVNA', label: 'Carvana',        kind: 'action' },
  { symbol: 'SMCI', label: 'Super Micro',    kind: 'action' },
  { symbol: 'ASTS', label: 'AST SpaceMobile', kind: 'action' },
  { symbol: 'IONQ', label: 'IonQ',           kind: 'action' },
  { symbol: 'RKLB', label: 'Rocket Lab',     kind: 'action' },
  { symbol: 'LCID', label: 'Lucid',          kind: 'action' },
  { symbol: 'PLUG', label: 'Plug Power',     kind: 'action' },
  { symbol: 'JOBY', label: 'Joby Aviation',  kind: 'action' },
  { symbol: 'RBLX', label: 'Roblox',         kind: 'action' },
  { symbol: 'SNAP', label: 'Snap',           kind: 'action' },
  { symbol: 'U',    label: 'Unity',          kind: 'action' },
  { symbol: 'DKNG', label: 'DraftKings',     kind: 'action' },
  { symbol: 'ROKU', label: 'Roku',           kind: 'action' },
  { symbol: 'BYND', label: 'Beyond Meat',    kind: 'action' },
  { symbol: 'RIVN', label: 'Rivian',         kind: 'action' },
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

// ── 3 patterns ABC ──────
function _finalize(ind, close, atrAbs, regime, obvTrend) {
  const entry = close;
  const stop = entry - CONFIG.atrStop * atrAbs;
  const tp1 = entry + (CONFIG.atrTp2 * 0.5) * atrAbs;
  const tp2 = entry + CONFIG.atrTp2 * atrAbs;
  if (stop >= entry || tp1 <= entry || tp2 <= tp1) return null;
  const risk = entry - stop;
  const rr2 = (tp2 - entry) / risk;
  if (rr2 < 2.0) return null;
  let q = 82;
  if (regime === 'bull') q += 10;
  else if (regime === 'sideways') q += 5;
  const adx = ind.adx?.value || 0;
  if (adx >= 35) q += 10; else if (adx >= 25) q += 5;
  if (rr2 >= 4) q += 10; else if (rr2 >= 3) q += 5;
  if (obvTrend === 'up') q += 5;
  q = Math.min(100, q);
  // v7.14 — Sizing cap 5% (au lieu de 8%)
  let sizing_pct = q >= 85 ? CONFIG.sizingCapPct : q >= 75 ? Math.min(CONFIG.sizingCapPct, 5) : 3;
  return { quality: q, sizing_pct, entry, stop, tp1, tp2, rr1: (tp1 - entry) / risk, rr2, regime };
}

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
function detectVoltScalp(prices, volumes) {
  if (!prices || prices.length < 60) return null;
  const ind = computeAllIndicators(prices, volumes);
  if (!ind) return null;
  return _patternA(ind, prices) || _patternC(ind, prices) || _patternB(ind, prices);
}

// ── Backtest sur un fold avec garde-fous ─────
function runFold(data, btcPrices, startIdx, endIdx, foldName) {
  let cash = CAPITAL_INITIAL;
  let positions = [];
  const equityHist = [];
  const closed = [];
  let highWaterMark = CAPITAL_INITIAL;
  let killSwitchUntil = -1;  // jour jusqu'auquel les nouveaux trades sont bloqués

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

      // v7.14 — Slippage exit (-0.2% sur le prix de sortie défavorable)
      const exitPriceWithSlip = (px) => px * (1 - CONFIG.slippagePct);

      if (cur <= pos.stop) {
        const exitPx = exitPriceWithSlip(pos.stop);
        let pnl;
        if (pos.trailing_active && pos.stop > pos.entry) {
          const gainSecondHalf = ((exitPx - pos.entry) / pos.entry) * pos.size_eur * 0.5;
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
        const exitPx = exitPriceWithSlip(pos.tp2);
        const realizedR = (exitPx - pos.entry) / (pos.entry - pos.initial_stop);
        const pnl = pos.size_eur * realizedR * pos.risk_pct;
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
        const exitPx = exitPriceWithSlip(cur);
        const pnlPct = (exitPx - pos.entry) / pos.entry;
        const pnl = pos.size_eur * pnlPct;
        cash += pos.size_eur + pnl;
        closed.push({ ...pos, pnl_eur: pnl, closed_at: d });
        return false;
      }
      pos.current_price = cur;
      return true;
    });

    // Compute equity actuelle
    let eq = cash;
    for (const p of positions) {
      const cur = data[p.asset].prices[today] || p.entry;
      eq += p.size_eur * (cur / p.entry);
    }
    if (eq > highWaterMark) highWaterMark = eq;
    const ddFromHigh = (eq - highWaterMark) / highWaterMark;

    // v7.14 — KILL SWITCH : si DD intra-fold ≤ -5% → pause 7j (skip nouveaux trades)
    if (ddFromHigh <= CONFIG.killSwitchDd && d > killSwitchUntil) {
      killSwitchUntil = d + CONFIG.killSwitchPauseDays;
    }

    // Open new positions (avec garde-fous)
    const canOpen = d > killSwitchUntil;
    if (canOpen && positions.length < MAX_POSITIONS && cash > 1) {
      const opened = new Set(positions.map(p => p.asset));
      // v7.14 — BTC dump filter (skip cryptos si BTC chute >5% sur 1j)
      let btcDumpToday = false;
      if (btcPrices && today >= 1) {
        const btcChg = (btcPrices[today] - btcPrices[today - 1]) / btcPrices[today - 1];
        if (btcChg <= CONFIG.btcDumpThreshold) btcDumpToday = true;
      }

      const candidates = [];
      for (const [label, asset] of Object.entries(data)) {
        if (opened.has(label)) continue;
        // v7.14 — Skip cryptos si BTC dump aujourd'hui
        if (btcDumpToday && asset.kind === 'crypto') continue;
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
        // v7.14 — Slippage entry (paid +0.2% sur le prix d'entrée défavorable)
        const entryWithSlip = c.setup.entry * (1 + CONFIG.slippagePct);
        const risk_pct = (entryWithSlip - c.setup.stop) / entryWithSlip;
        positions.push({
          asset: c.label, quality: c.setup.quality,
          sizing_pct: c.setup.sizing_pct, regime: c.setup.regime,
          entry: entryWithSlip, stop: c.setup.stop, tp1: c.setup.tp1, tp2: c.setup.tp2,
          initial_stop: c.setup.stop, high_since_entry: entryWithSlip,
          rr1: c.setup.rr1, rr2: c.setup.rr2,
          size_eur, risk_pct,
          touched_tp1: false, trailing_active: false,
          opened_at: d,
        });
      }
    }

    equityHist.push({ day: d, equity: eq, ddFromHigh });
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
  // Calcule la perf BTC sur le fold (pour comparaison contextuelle)
  let btcPerf = null;
  if (btcPrices && btcPrices[endIdx - 1] != null && btcPrices[startIdx] != null) {
    btcPerf = ((btcPrices[endIdx - 1] - btcPrices[startIdx]) / btcPrices[startIdx]) * 100;
  }
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
    btc_perf_pct: btcPerf != null ? Number(btcPerf.toFixed(1)) : null,
  };
}

async function main() {
  console.log(`=== Stress Walk-forward VOLT v7.14 · ${N_FOLDS} folds × ${FOLD_DAYS}j · slippage + garde-fous ===\n`);
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
  console.log(`  ${assetsLoaded}/${VOLT_ASSETS.length} actifs chargés`);

  // Charge BTC pour BTC-dump filter
  console.log('\nFetching BTC pour filter contagion...');
  let btcPrices = null;
  try {
    const d = await fetchYahooHistorical('BTC-USD', HISTORY_RANGE);
    btcPrices = d.prices;
    console.log(`  BTC: ${btcPrices.length} candles`);
  } catch (e) {
    console.warn(`  BTC fetch failed: ${e.message}`);
  }

  const lengths = Object.values(data).map(d => d.prices.length);
  const minLen = Math.min(...lengths);
  // Si moins de TOTAL_DAYS dispo, on adapte
  const effectiveTotal = Math.min(TOTAL_DAYS, minLen - WARMUP - 10);
  const effectiveFolds = Math.floor(effectiveTotal / FOLD_DAYS);
  const startGlobal = minLen - effectiveFolds * FOLD_DAYS;
  console.log(`\nHistorique : minLen=${minLen}j, total backtest=${effectiveFolds * FOLD_DAYS}j (${effectiveFolds} folds)`);
  console.log(`Folds : indices [${startGlobal}, ${minLen}]\n`);
  console.log(`Lancement des ${effectiveFolds} folds avec slippage + garde-fous...\n`);

  const folds = [];
  for (let i = 0; i < effectiveFolds; i++) {
    const foldStart = startGlobal + i * FOLD_DAYS;
    const foldEnd = foldStart + FOLD_DAYS;
    const foldName = `FOLD-${(i + 1).toString().padStart(2, '0')}`;
    process.stdout.write(`  → ${foldName} : `);
    const r = runFold(data, btcPrices, foldStart, foldEnd, foldName);
    const bullbear = r.btc_perf_pct != null ? (r.btc_perf_pct > 10 ? 'BULL' : r.btc_perf_pct < -10 ? 'BEAR' : 'SIDE') : '???';
    console.log(`${bullbear} (BTC ${r.btc_perf_pct != null ? (r.btc_perf_pct >= 0 ? '+' : '') + r.btc_perf_pct + '%' : 'n/a'}) → annualized ${(r.annualized_pct >= 0 ? '+' : '') + r.annualized_pct}% · ${r.trades_closed} trades`);
    folds.push(r);
  }

  // Stats
  const anns = folds.map(f => f.annualized_pct);
  const dds = folds.map(f => f.max_dd_pct);
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
  if (positiveCount === effectiveFolds && median >= 10 && worstDd >= -8) {
    verdict = `✅ DÉPLOIEMENT SÛR : ${effectiveFolds}/${effectiveFolds} folds positifs, médian ${median.toFixed(1)}%/an, worst DD ${worstDd.toFixed(1)}%. Garde-fous validés.`;
  } else if (positiveCount >= effectiveFolds - 2 && worstDd >= -8 && median >= 5) {
    verdict = `⚠️ ACCEPTABLE : ${positiveCount}/${effectiveFolds} folds positifs, médian ${median.toFixed(1)}%/an, worst DD ${worstDd.toFixed(1)}%. À déployer avec disclaimer renforcé.`;
  } else if (worstDd < -10) {
    verdict = `❌ REFUS DÉPLOIEMENT : worst DD ${worstDd.toFixed(1)}% (cible ≥-8%). Risque trop élevé même avec garde-fous.`;
  } else {
    verdict = `❌ NON ROBUSTE : ${positiveCount}/${effectiveFolds} folds positifs. Stratégie période-dépendante malgré garde-fous.`;
  }

  console.log('\n╔════════════════════════════════════════════════════════════════════════════════╗');
  console.log(`║ STRESS WALK-FORWARD VOLT v7.14 · ${effectiveFolds} folds × ${FOLD_DAYS}j · slippage 0.4%/trade        ║`);
  console.log('╠══════════╦═══════╦═════════╦═════════╦══════╦═════════╦═══════╦═════════════════╣');
  console.log('║ Fold     ║ BTC   ║ Final   ║ Annual. ║ PF   ║ Max DD  ║ WR    ║ Trades          ║');
  console.log('╟──────────╫───────╫─────────╫─────────╫──────╫─────────╫───────╫─────────────────╢');
  for (const f of folds) {
    const ann = (f.annualized_pct >= 0 ? '+' : '') + f.annualized_pct + '%';
    const btc = f.btc_perf_pct != null ? ((f.btc_perf_pct >= 0 ? '+' : '') + f.btc_perf_pct + '%') : 'n/a';
    console.log(`║ ${f.fold.padEnd(8)} ║ ${btc.padStart(5)} ║ ${f.equity_final.toFixed(0).padStart(5)}€  ║ ${ann.padStart(7)} ║ ${f.profit_factor.toFixed(2).padStart(4)} ║ ${(f.max_dd_pct.toFixed(1) + '%').padStart(7)} ║ ${(f.win_rate_pct.toFixed(0) + '%').padStart(5)} ║ ${f.trades_closed.toString().padStart(15)} ║`);
  }
  console.log('╠══════════╩═══════╩═════════╩═════════╩══════╩═════════╩═══════╩═════════════════╣');
  console.log(`║ Médian: ${median.toFixed(2)}%  · Moyen: ${mean.toFixed(2)}%  · Std: ${std.toFixed(2)}%  · Min: ${min.toFixed(2)}%  · Max: ${max.toFixed(2)}%     ║`);
  console.log(`║ Worst DD: ${worstDd.toFixed(2)}%  · Folds positifs: ${positiveCount}/${effectiveFolds}                                       ║`);
  console.log('╚════════════════════════════════════════════════════════════════════════════════╝');
  console.log(`\n${verdict}\n`);

  await fs.mkdir(path.join(process.cwd(), 'data', 'sandbox'), { recursive: true });
  await fs.writeFile(
    path.join(process.cwd(), 'data', 'sandbox', 'stress_walkforward_volt.json'),
    JSON.stringify({
      generated: new Date().toISOString(),
      version: 'v7.14',
      config: CONFIG,
      n_folds: effectiveFolds,
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
