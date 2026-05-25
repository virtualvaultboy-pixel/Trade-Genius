#!/usr/bin/env node
/**
 * Trade Genius — v7.15 STRESS TEST COMPLET 5 IA
 *
 * Audit exhaustif : applique le même protocole stress walk-forward que VOLT
 * sur les 4 autres IA (BASTION/PHÉNIX/RAFALE/NEXUS) pour vérifier que leurs
 * promesses (+8.9%/an, +7.7%/an, +6-7%/an, +8%/an) tiennent face à la même
 * exigence : 6 folds × 150j + slippage 0.4%/trade.
 *
 * Output : data/sandbox/stress_all_ias.json
 *
 * Univers par IA :
 *   - BASTION (atlas) : indices + actions blue-chip (long terme)
 *   - PHÉNIX (nova)   : indices + actions (moyen terme)
 *   - RAFALE (kairo)  : indices + actions (court terme)
 *   - NEXUS (multi)   : crypto only (15 majeurs)
 *   - VOLT            : VOLT_UNIVERSE (cryptos mid-cap + actions high-beta)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchYahooHistorical, computeAllIndicators, atrPct, sma } from './indicators.mjs';

const CAPITAL_INITIAL = 1000;
const WARMUP = 220;
const HISTORY_RANGE = '5y';
const N_FOLDS = 6;
const FOLD_DAYS = 150;
const SLIPPAGE_PCT = 0.002;

// ── Univers : actions + indices (BASTION/PHÉNIX/RAFALE) ──
const STOCK_INDEX_UNIVERSE = [
  // Indices
  { symbol: '^GSPC',  label: 'S&P 500',     kind: 'index' },
  { symbol: '^IXIC',  label: 'Nasdaq',      kind: 'index' },
  { symbol: '^DJI',   label: 'Dow Jones',   kind: 'index' },
  { symbol: '^FCHI',  label: 'CAC 40',      kind: 'index' },
  { symbol: '^GDAXI', label: 'DAX',         kind: 'index' },
  { symbol: '^FTSE',  label: 'FTSE 100',    kind: 'index' },
  // Actions US blue-chip
  { symbol: 'AAPL',  label: 'Apple',       kind: 'action' },
  { symbol: 'MSFT',  label: 'Microsoft',   kind: 'action' },
  { symbol: 'GOOGL', label: 'Alphabet',    kind: 'action' },
  { symbol: 'AMZN',  label: 'Amazon',      kind: 'action' },
  { symbol: 'META',  label: 'Meta',        kind: 'action' },
  { symbol: 'NVDA',  label: 'Nvidia',      kind: 'action' },
  { symbol: 'TSLA',  label: 'Tesla',       kind: 'action' },
  { symbol: 'NFLX',  label: 'Netflix',     kind: 'action' },
  { symbol: 'JPM',   label: 'JPMorgan',    kind: 'action' },
  { symbol: 'V',     label: 'Visa',        kind: 'action' },
  { symbol: 'WMT',   label: 'Walmart',     kind: 'action' },
  { symbol: 'JNJ',   label: 'J&J',         kind: 'action' },
  { symbol: 'PG',    label: 'P&G',         kind: 'action' },
  { symbol: 'KO',    label: 'Coca-Cola',   kind: 'action' },
  { symbol: 'DIS',   label: 'Disney',      kind: 'action' },
  { symbol: 'BAC',   label: 'BoA',         kind: 'action' },
  { symbol: 'MA',    label: 'Mastercard',  kind: 'action' },
  { symbol: 'XOM',   label: 'Exxon',       kind: 'action' },
  { symbol: 'CVX',   label: 'Chevron',     kind: 'action' },
  { symbol: 'NKE',   label: 'Nike',        kind: 'action' },
];

// ── Univers crypto (NEXUS) ──
const CRYPTO_UNIVERSE = [
  { symbol: 'BTC-USD',  label: 'BTC',     kind: 'crypto' },
  { symbol: 'ETH-USD',  label: 'ETH',     kind: 'crypto' },
  { symbol: 'BNB-USD',  label: 'BNB',     kind: 'crypto' },
  { symbol: 'XRP-USD',  label: 'XRP',     kind: 'crypto' },
  { symbol: 'ADA-USD',  label: 'ADA',     kind: 'crypto' },
  { symbol: 'DOGE-USD', label: 'DOGE',    kind: 'crypto' },
  { symbol: 'DOT-USD',  label: 'DOT',     kind: 'crypto' },
  { symbol: 'LINK-USD', label: 'LINK',    kind: 'crypto' },
  { symbol: 'TRX-USD',  label: 'TRX',     kind: 'crypto' },
  { symbol: 'LTC-USD',  label: 'LTC',     kind: 'crypto' },
  { symbol: 'UNI-USD',  label: 'UNI',     kind: 'crypto' },
  { symbol: 'XLM-USD',  label: 'XLM',     kind: 'crypto' },
  { symbol: 'BCH-USD',  label: 'BCH',     kind: 'crypto' },
];

// ── Univers VOLT (subset stable >1500j d'historique) ──
const VOLT_UNIVERSE = [
  { symbol: 'SOL-USD',  label: 'Solana',     kind: 'crypto' },
  { symbol: 'AVAX-USD', label: 'Avalanche',  kind: 'crypto' },
  { symbol: 'NEAR-USD', label: 'Near',       kind: 'crypto' },
  { symbol: 'INJ-USD',  label: 'Injective',  kind: 'crypto' },
  { symbol: 'LDO-USD',  label: 'Lido DAO',   kind: 'crypto' },
  { symbol: 'FET-USD',  label: 'Fetch.ai',   kind: 'crypto' },
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
  { symbol: 'RBLX', label: 'Roblox',         kind: 'action' },
  { symbol: 'SNAP', label: 'Snap',           kind: 'action' },
  { symbol: 'DKNG', label: 'DraftKings',     kind: 'action' },
  { symbol: 'ROKU', label: 'Roku',           kind: 'action' },
];

// ── Configs des 5 IA (synchro avec build-ai-study.mjs AGENT_PROFILES + _agentDetectors) ──
const IA_CONFIGS = {
  BASTION: {
    universe: STOCK_INDEX_UNIVERSE,
    atrStop: 1.0, atrTp2: 7.0,   // grid-month (atlas)
    minQ: 65, timeoutDays: 60,
    trailingAfterTp1: true,
    sizingCapPct: 5,             // standard (vs VOLT 5)
    promise: '+8.9%/an · DD <1.5%',
  },
  PHENIX: {
    universe: STOCK_INDEX_UNIVERSE,
    atrStop: 1.0, atrTp2: 5.0,   // grid-week (nova)
    minQ: 65, timeoutDays: 30,
    trailingAfterTp1: true,
    sizingCapPct: 5,
    promise: '+7.7%/an · WR 58%',
  },
  RAFALE: {
    universe: STOCK_INDEX_UNIVERSE,
    atrStop: 1.0, atrTp2: 4.0,   // grid-day (kairo)
    minQ: 65, timeoutDays: 14,
    trailingAfterTp1: true,
    sizingCapPct: 5,
    promise: '+6-7%/an · WR 52%',
  },
  NEXUS: {
    universe: CRYPTO_UNIVERSE,
    atrStop: 1.0, atrTp2: 5.0,
    minQ: 65, timeoutDays: 30,
    trailingAfterTp1: true,
    sizingCapPct: 5,
    promise: '+8%/an · WR 42%',
  },
  VOLT: {
    universe: VOLT_UNIVERSE,
    atrStop: 0.6, atrTp2: 4.5,   // ABC-TRIPLE v7.14
    minQ: 65, timeoutDays: 15,
    trailingAfterTp1: true,
    sizingCapPct: 5,
    promise: 'v7.14 stress validé +9.1%/an',
  },
};

const MAX_POSITIONS = 3;

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

// ── 3 patterns A/B/C (synchro avec grid v3.0 build-ai-study.mjs) ──
function _patternA(ind, prices) {
  const rsi = ind.rsi?.value, boll = ind.boll?.value, macdH = ind.macd?.value;
  if (rsi == null || rsi >= 25) return null;
  if (boll == null || boll >= 0.25) return null;
  if (macdH == null || macdH >= 0) return null;
  const regime = detectRegime(prices);
  if (regime === 'bear') return null;
  if (ind.mfi?.value > 70) return null;
  return { regime, kind: 'A' };
}
function _patternC(ind, prices) {
  const rsi = ind.rsi?.value, boll = ind.boll?.value, ichi = ind.ichimoku;
  if (rsi == null || rsi <= 35) return null;
  if (boll == null || boll >= 0.25) return null;
  if (!ichi || ichi.position !== 'above-cloud' || ichi.signal !== 'bull') return null;
  if (ind.obv?.trend === 'down') return null;
  const regime = detectRegime(prices);
  if (regime === 'bear') return null;
  return { regime, kind: 'C' };
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
  return { regime, kind: 'B' };
}

function detectSetup(prices, volumes, config) {
  if (!prices || prices.length < 60) return null;
  const ind = computeAllIndicators(prices, volumes);
  if (!ind) return null;
  // ABC-TRIPLE (toutes IA utilisent les 3 patterns combinés)
  const pat = _patternA(ind, prices) || _patternC(ind, prices) || _patternB(ind, prices);
  if (!pat) return null;
  const atrPctV = ind.atr?.value;
  if (atrPctV == null) return null;
  const close = prices[prices.length - 1];
  const atrAbs = (atrPctV / 100) * close;
  const entry = close;
  const stop = entry - config.atrStop * atrAbs;
  const tp1 = entry + (config.atrTp2 * 0.5) * atrAbs;
  const tp2 = entry + config.atrTp2 * atrAbs;
  if (stop >= entry || tp1 <= entry || tp2 <= tp1) return null;
  const risk = entry - stop;
  const rr2 = (tp2 - entry) / risk;
  if (rr2 < 1.5) return null;
  // Quality score
  let q = (pat.kind === 'C' && pat.regime === 'bull') ? 75 : pat.kind === 'A' ? 70 : 60;
  if (pat.regime === 'bull') q += 10;
  else if (pat.regime === 'sideways') q += 5;
  const adx = ind.adx?.value || 0;
  if (adx >= 35) q += 10; else if (adx >= 25) q += 5;
  if (rr2 >= 4) q += 10; else if (rr2 >= 3) q += 5;
  if (ind.obv?.trend === 'up') q += 5;
  q = Math.min(100, q);
  let sizing_pct = q >= 85 ? config.sizingCapPct : q >= 75 ? Math.min(config.sizingCapPct, 4) : Math.min(config.sizingCapPct, 2);
  return { quality: q, sizing_pct, entry, stop, tp1, tp2, rr1: (tp1 - entry) / risk, rr2, regime: pat.regime, pattern: pat.kind };
}

// ── Backtest sur un fold ──
function runFold(data, btcPrices, startIdx, endIdx, foldName, config) {
  let cash = CAPITAL_INITIAL;
  let positions = [];
  const equityHist = [];
  const closed = [];

  for (let d = startIdx; d < endIdx; d++) {
    const today = d;
    const tomorrow = d + 1;

    positions = positions.filter(pos => {
      const asset = data[pos.asset];
      if (!asset) return false;
      const cur = asset.prices[tomorrow];
      if (cur == null) return true;
      const ageDays = d - pos.opened_at;

      if (pos.high_since_entry == null || cur > pos.high_since_entry) pos.high_since_entry = cur;
      if (pos.touched_tp1 && config.trailingAfterTp1) {
        const initialRisk = pos.entry - pos.initial_stop;
        const chandStop = pos.high_since_entry - initialRisk;
        if (chandStop > pos.stop) pos.stop = chandStop;
      }

      const exitWithSlip = (px) => px * (1 - SLIPPAGE_PCT);

      if (cur <= pos.stop) {
        let pnl;
        if (pos.trailing_active && pos.stop > pos.entry) {
          const exitPx = exitWithSlip(pos.stop);
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
        const exitPx = exitWithSlip(pos.tp2);
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
      if (ageDays >= config.timeoutDays) {
        const exitPx = exitWithSlip(cur);
        const pnlPct = (exitPx - pos.entry) / pos.entry;
        const pnl = pos.size_eur * pnlPct;
        cash += pos.size_eur + pnl;
        closed.push({ ...pos, pnl_eur: pnl, closed_at: d });
        return false;
      }
      pos.current_price = cur;
      return true;
    });

    if (positions.length < MAX_POSITIONS && cash > 1) {
      const opened = new Set(positions.map(p => p.asset));
      const candidates = [];

      for (const [label, asset] of Object.entries(data)) {
        if (opened.has(label)) continue;
        const slice = asset.prices.slice(0, today + 1);
        if (slice.length < WARMUP) continue;
        const sliceVol = asset.volumes.slice(0, today + 1);
        const setup = detectSetup(slice, sliceVol, config);
        if (!setup) continue;
        if (setup.quality < config.minQ) continue;
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
        const entryWithSlip = c.setup.entry * (1 + SLIPPAGE_PCT);
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
  let btcPerf = null;
  if (btcPrices && btcPrices[endIdx - 1] != null && btcPrices[startIdx] != null) {
    btcPerf = ((btcPrices[endIdx - 1] - btcPrices[startIdx]) / btcPrices[startIdx]) * 100;
  }
  return {
    fold: foldName, days: foldDays,
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

async function runIA(iaName, config, btcPrices) {
  console.log(`\n━━━ ${iaName} (${config.universe.length} actifs · stop ${config.atrStop} ATR · TP ${config.atrTp2} ATR · timeout ${config.timeoutDays}j) ━━━`);
  const data = {};
  for (const a of config.universe) {
    try {
      const d = await fetchYahooHistorical(a.symbol, HISTORY_RANGE);
      if (!d || !Array.isArray(d.prices) || d.prices.length < WARMUP + 50) continue;
      data[a.label] = { ...a, prices: d.prices, volumes: d.volumes || [] };
    } catch {}
    await new Promise(r => setTimeout(r, 80));
  }
  const assetsLoaded = Object.keys(data).length;
  console.log(`  ${assetsLoaded}/${config.universe.length} actifs chargés`);

  const lengths = Object.values(data).map(d => d.prices.length);
  const minLen = Math.min(...lengths);
  const effectiveTotal = Math.min(N_FOLDS * FOLD_DAYS, minLen - WARMUP - 10);
  const effectiveFolds = Math.floor(effectiveTotal / FOLD_DAYS);
  const startGlobal = minLen - effectiveFolds * FOLD_DAYS;
  console.log(`  Backtest : ${effectiveFolds} folds × ${FOLD_DAYS}j (minLen=${minLen}j)`);

  const folds = [];
  for (let i = 0; i < effectiveFolds; i++) {
    const foldStart = startGlobal + i * FOLD_DAYS;
    const foldEnd = foldStart + FOLD_DAYS;
    const r = runFold(data, btcPrices, foldStart, foldEnd, `F${(i+1).toString().padStart(2, '0')}`, config);
    const btc = r.btc_perf_pct != null ? ((r.btc_perf_pct >= 0 ? '+' : '') + r.btc_perf_pct + '%') : 'n/a';
    console.log(`    ${r.fold} (BTC ${btc.padStart(7)}) → ${(r.annualized_pct >= 0 ? '+' : '') + r.annualized_pct}%/an · DD ${r.max_dd_pct.toFixed(1)}% · PF ${r.profit_factor.toFixed(2)} · ${r.trades_closed} trades`);
    folds.push(r);
  }

  const anns = folds.map(f => f.annualized_pct);
  const dds = folds.map(f => f.max_dd_pct);
  const sorted = [...anns].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = anns.reduce((s, x) => s + x, 0) / anns.length;
  const std = Math.sqrt(anns.reduce((s, x) => s + (x - mean) ** 2, 0) / anns.length);
  const worstDd = Math.min(...dds);
  const positiveCount = anns.filter(a => a > 0).length;

  return {
    ia_name: iaName,
    config,
    assets_loaded: assetsLoaded,
    n_folds: effectiveFolds,
    folds,
    stats: {
      median_annualized: Number(median.toFixed(2)),
      mean_annualized: Number(mean.toFixed(2)),
      std_annualized: Number(std.toFixed(2)),
      worst_dd: Number(worstDd.toFixed(2)),
      positive_folds: positiveCount,
      total_trades: folds.reduce((s, f) => s + f.trades_closed, 0),
    },
  };
}

async function main() {
  console.log(`=== STRESS TEST COMPLET 5 IA v7.15 · 6 folds × 150j · slippage 0.4%/trade ===\n`);

  // Charge BTC en premier (sert pour stats fold + filter)
  console.log('Fetching BTC pour context...');
  let btcPrices = null;
  try {
    const d = await fetchYahooHistorical('BTC-USD', HISTORY_RANGE);
    btcPrices = d.prices;
    console.log(`  BTC: ${btcPrices.length} candles`);
  } catch (e) {
    console.warn(`  BTC fetch failed: ${e.message}`);
  }

  const results = [];
  for (const [iaName, config] of Object.entries(IA_CONFIGS)) {
    const r = await runIA(iaName, config, btcPrices);
    results.push(r);
  }

  // Synthèse tableau
  console.log(`\n\n╔════════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║ SYNTHÈSE STRESS TEST 5 IA · 6 folds × 150j · slippage 0.4%/trade · cap 5% size ║`);
  console.log(`╠══════════╦═════════╦═════════╦═════════╦═════════╦═══════╦═══════╦═════════════╣`);
  console.log(`║ IA       ║ Médian  ║ Moyen   ║ Std     ║ Worst DD║ +Folds║Trades ║ Promesse UI ║`);
  console.log(`╟──────────╫─────────╫─────────╫─────────╫─────────╫───────╫───────╫─────────────╢`);
  for (const r of results) {
    const s = r.stats;
    const med = (s.median_annualized >= 0 ? '+' : '') + s.median_annualized.toFixed(1) + '%';
    const moy = (s.mean_annualized >= 0 ? '+' : '') + s.mean_annualized.toFixed(1) + '%';
    console.log(`║ ${r.ia_name.padEnd(8)} ║ ${med.padStart(7)} ║ ${moy.padStart(7)} ║ ${s.std_annualized.toFixed(1).padStart(6)}% ║ ${(s.worst_dd.toFixed(1) + '%').padStart(7)} ║ ${(s.positive_folds + '/' + r.n_folds).padStart(5)} ║ ${s.total_trades.toString().padStart(5)} ║ ${r.config.promise.padEnd(11)} ║`);
  }
  console.log(`╚══════════╩═════════╩═════════╩═════════╩═════════╩═══════╩═══════╩═════════════╝`);

  // Verdicts
  console.log(`\n=== VERDICTS PAR IA ===\n`);
  for (const r of results) {
    const s = r.stats;
    let verdict;
    if (s.positive_folds === r.n_folds && s.worst_dd >= -10 && s.median_annualized >= 5) {
      verdict = `✅ ROBUSTE · ${s.positive_folds}/${r.n_folds} folds positifs · médian ${s.median_annualized}%/an · DD ${s.worst_dd}%`;
    } else if (s.positive_folds >= r.n_folds - 1 && s.worst_dd >= -10) {
      verdict = `⚠️ ACCEPTABLE · ${s.positive_folds}/${r.n_folds} folds positifs · médian ${s.median_annualized}%/an · DD ${s.worst_dd}%`;
    } else if (s.worst_dd < -15) {
      verdict = `🚨 RISQUE ÉLEVÉ · DD ${s.worst_dd}% (cap suggéré -10%)`;
    } else {
      verdict = `❌ FRAGILE · ${s.positive_folds}/${r.n_folds} folds positifs · médian ${s.median_annualized}%/an`;
    }
    console.log(`  ${r.ia_name.padEnd(8)} : ${verdict}`);
  }

  await fs.mkdir(path.join(process.cwd(), 'data', 'sandbox'), { recursive: true });
  await fs.writeFile(
    path.join(process.cwd(), 'data', 'sandbox', 'stress_all_ias.json'),
    JSON.stringify({
      generated: new Date().toISOString(),
      version: 'v7.15',
      protocol: { n_folds: N_FOLDS, fold_days: FOLD_DAYS, slippage_pct: SLIPPAGE_PCT, max_positions: MAX_POSITIONS },
      results,
    }, null, 2) + '\n'
  );
  console.log(`\n✓ Résultats sauvegardés dans data/sandbox/stress_all_ias.json\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
