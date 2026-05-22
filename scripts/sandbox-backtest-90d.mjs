#!/usr/bin/env node
/**
 * Trade Genius — v4.5 SANDBOX BACKTEST 90 JOURS
 *
 * Simule rétrospectivement ce qu'aurait donné le système v4.1-4.3 complet
 * (volume filters + macro + stacking + trailing) avec 100€ virtuels sur les
 * 90 derniers jours de marché.
 *
 * Méthode :
 *   1. Fetch ~20 actifs Yahoo (1 an d'historique)
 *   2. Pour chaque jour T des 90 derniers :
 *      a. Compute indicators sur prices[0..T] (causal, pas de leak)
 *      b. Détecte Pattern A/B/C avec filtres v4.1
 *      c. Update positions ouvertes avec prices[T+1] (close du lendemain)
 *      d. Ouvre nouvelles positions selon quality_score
 *   3. Track equity day-by-day → résultat final
 *
 * Output : data/sandbox/backtest_90d.json
 *
 * Lancement : node scripts/sandbox-backtest-90d.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  fetchYahooHistorical, computeAllIndicators, atrPct, sma,
} from './indicators.mjs';

const CAPITAL_INITIAL = 100;
const MAX_POSITIONS = 5;
const MIN_QUALITY = 60; // medium-high acceptable
const BACKTEST_DAYS = 180;
const HISTORY_RANGE = '2y';

// Univers ciblé : indices + actions majeures + métaux
const ASSETS = [
  { kind: 'index', symbol: '^GSPC', label: 'S&P 500' },
  { kind: 'index', symbol: '^IXIC', label: 'Nasdaq' },
  { kind: 'index', symbol: '^DJI', label: 'Dow Jones' },
  { kind: 'index', symbol: '^RUT', label: 'Russell 2000' },
  { kind: 'index', symbol: '^FCHI', label: 'CAC 40' },
  { kind: 'index', symbol: '^GDAXI', label: 'DAX' },
  { kind: 'index', symbol: '^FTSE', label: 'FTSE 100' },
  { kind: 'index', symbol: '^N225', label: 'Nikkei 225' },
  { kind: 'action', symbol: 'AAPL', label: 'Apple' },
  { kind: 'action', symbol: 'MSFT', label: 'Microsoft' },
  { kind: 'action', symbol: 'GOOGL', label: 'Alphabet' },
  { kind: 'action', symbol: 'AMZN', label: 'Amazon' },
  { kind: 'action', symbol: 'META', label: 'Meta' },
  { kind: 'action', symbol: 'NVDA', label: 'Nvidia' },
  { kind: 'action', symbol: 'TSLA', label: 'Tesla' },
  { kind: 'action', symbol: 'JPM', label: 'JPMorgan' },
  { kind: 'action', symbol: 'V', label: 'Visa' },
  { kind: 'action', symbol: 'WMT', label: 'Walmart' },
  { kind: 'action', symbol: 'JNJ', label: 'J&J' },
  { kind: 'action', symbol: 'XOM', label: 'Exxon' },
  { kind: 'action', symbol: 'KO', label: 'Coca-Cola' },
  { kind: 'action', symbol: 'NFLX', label: 'Netflix' },
  { kind: 'action', symbol: 'SPY', label: 'SPY ETF' },
  { kind: 'action', symbol: 'QQQ', label: 'QQQ ETF' },
  { kind: 'action', symbol: 'XLK', label: 'XLK Tech' },
  { kind: 'action', symbol: 'XLF', label: 'XLF Fin' },
  { kind: 'action', symbol: 'MC.PA', label: 'LVMH' },
  { kind: 'action', symbol: 'ASML.AS', label: 'ASML' },
  { kind: 'metal', symbol: 'GC=F', label: 'Or' },
  { kind: 'metal', symbol: 'SI=F', label: 'Argent' },
];

// ── Régime LT (SMA200 slope) ──────────────────────────────────────
function detectRegime(prices) {
  if (!prices || prices.length < 220) return 'unknown';
  const sma200Now = sma(prices.slice(-200), 200);
  const sma200Ago = sma(prices.slice(-220, -20), 200);
  if (sma200Now == null || sma200Ago == null || sma200Ago === 0) return 'unknown';
  const slope = (sma200Now - sma200Ago) / sma200Ago;
  if (slope > 0.02) return 'bull';
  if (slope < -0.02) return 'bear';
  return 'sideways';
}

// ── Patterns v4.1 (réimplémentation minimale identique à build-ai-study) ─────
function patternContrarian(ind, prices, atr, regime) {
  const rsi = ind.rsi?.value, boll = ind.boll?.value, macdH = ind.macd?.value;
  const mfi = ind.mfi?.value;
  if (rsi == null || rsi >= 25) return null;
  if (boll == null || boll >= 0.25) return null;
  if (macdH == null || macdH >= 0) return null;
  if (regime === 'bear') return null;
  if (mfi != null && mfi > 70) return null; // v4.1 filter
  return { type: 'A', conf: 'high', base: 70 };
}
function patternPullback(ind, prices, atr, regime) {
  const rsi = ind.rsi?.value, boll = ind.boll?.value, ichi = ind.ichimoku;
  if (rsi == null || rsi <= 35) return null;
  if (boll == null || boll >= 0.25) return null;
  if (!ichi || ichi.position !== 'above-cloud' || ichi.signal !== 'bull') return null;
  if (regime === 'bear') return null;
  if (ind.obv?.trend === 'down') return null;
  if (ind.forceIndex?.signal === 'bear') return null;
  return { type: 'C', conf: regime === 'bull' ? 'very-high' : 'high', base: regime === 'bull' ? 75 : 55 };
}
function patternTrendFollow(ind, prices, atr, regime) {
  const rsi = ind.rsi?.value, adx = ind.adx?.value || 0, boll = ind.boll?.value, macdH = ind.macd?.value;
  if (rsi == null || rsi <= 35) return null;
  if (adx < 30) return null;
  if (boll == null || boll < 0.25 || boll > 0.75) return null;
  if (macdH == null || macdH >= 0) return null;
  if (regime === 'bear') return null;
  if (ind.obv?.trend === 'down') return null;
  return { type: 'B', conf: 'high', base: 60 };
}

function computeQuality(ind, p, regime) {
  let s = p.base;
  if (regime === 'bull') s += 10;
  else if (regime === 'sideways') s += 5;
  const adx = ind.adx?.value || 0;
  if (adx >= 35) s += 10;
  else if (adx >= 25) s += 5;
  // RR bonus : on a stop=1 ATR, tp2=N ATR. RR = N → toujours >= 2 dans notre cas. +5 ou +10.
  if (p.atrTp2 >= 5) s += 10; else if (p.atrTp2 >= 3) s += 5;
  if (ind.obv?.trend === 'up' || ind.obv?.signal === 'bull') s += 5;
  if (p.stacked) s += (p.stackedCount >= 3 ? 20 : 15);
  return Math.min(100, s);
}

function detectSetupForHorizon(ind, prices, atrAbs, regime, atrTp2) {
  if (!atrAbs || atrAbs <= 0) return null;
  // Détecte les 3 patterns indépendamment + stacking
  const c = patternPullback(ind, prices, atrAbs, regime);
  const a = patternContrarian(ind, prices, atrAbs, regime);
  const b = patternTrendFollow(ind, prices, atrAbs, regime);
  const hits = [c, a, b].filter(Boolean);
  if (hits.length === 0) return null;
  const best = hits.sort((x, y) => (x.conf === 'very-high' ? -1 : 1))[0];
  const stacked = hits.length >= 2;
  if (stacked) {
    best.stacked = true;
    best.stackedCount = hits.length;
    best.conf = 'very-high';
  }
  best.atrTp2 = atrTp2;
  const quality = computeQuality(ind, best, regime);
  let sizing_pct = 0.5;
  if (quality >= 85) sizing_pct = 3;
  else if (quality >= 70) sizing_pct = 2;
  else if (quality >= 55) sizing_pct = 1;
  return {
    pattern: best.type, conf: best.conf, quality, sizing_pct,
    stacked, atrTp2,
  };
}

// ── Backtest main loop ──────────────────────────────────────────
async function main() {
  console.log(`Fetching ${ASSETS.length} assets (1y history)...`);
  const data = {};
  for (const a of ASSETS) {
    try {
      const d = await fetchYahooHistorical(a.symbol, HISTORY_RANGE);
      data[a.label] = { ...a, prices: d.prices, volumes: d.volumes || [] };
      console.log(`  ${a.label}: ${d.prices.length} candles`);
    } catch (e) {
      console.warn(`  SKIP ${a.label}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 150));
  }

  // Synchronise sur le plus court (les actifs ont des longueurs varient)
  const lengths = Object.values(data).map(d => d.prices.length);
  const minLen = Math.min(...lengths);
  console.log(`Min length: ${minLen}, starting backtest from day ${minLen - BACKTEST_DAYS}`);

  // Portfolio
  let cash = CAPITAL_INITIAL;
  let positions = []; // {asset, entry, stop, tp1, tp2, size_eur, ...}
  const equityHistory = [];
  const closedTrades = [];

  // Horizon : on prend Atlas (MONTH) en horizon principal car PF le plus stable
  const ATR_TP2 = 7.0;

  // Loop sur les BACKTEST_DAYS derniers jours
  const startIdx = minLen - BACKTEST_DAYS;
  for (let d = startIdx; d < minLen - 1; d++) {
    const today = d;
    const tomorrow = d + 1;

    // ── 1) Update positions open avec le close du jour ──
    positions = positions.filter(pos => {
      const asset = data[pos.asset];
      if (!asset) return false;
      const cur = asset.prices[tomorrow]; // close lendemain = exécution
      if (cur == null) return true;
      const ageDays = d - pos.opened_at;

      // Stop touché (avec trailing eventually moved to entry)
      if (cur <= pos.stop) {
        const pnlEur = pos.touched_tp1
          ? (pos.trailing_active ? pos.size_eur * pos.rr1 * 0.5 * pos.risk_pct : pos.size_eur * (pos.rr1 * 0.5 - 0.5) * pos.risk_pct)
          : -pos.size_eur * pos.risk_pct;
        cash += pos.size_eur + pnlEur;
        closedTrades.push({ ...pos, exit_price: pos.stop, pnl_eur: pnlEur, status: pos.trailing_active ? 'breakeven' : (pos.touched_tp1 ? 'partial_stop' : 'loss'), closed_at: d });
        return false;
      }
      // TP2 touché
      if (cur >= pos.tp2) {
        const pnlEur = pos.size_eur * pos.rr2 * pos.risk_pct;
        cash += pos.size_eur + pnlEur;
        closedTrades.push({ ...pos, exit_price: pos.tp2, pnl_eur: pnlEur, status: 'win', closed_at: d });
        return false;
      }
      // TP1 touché → trailing
      if (!pos.touched_tp1 && cur >= pos.tp1) {
        pos.touched_tp1 = true;
        pos.stop = pos.entry; // trailing
        pos.trailing_active = true;
      }
      // Timeout 60j
      if (ageDays >= 60) {
        const pnlPct = (cur - pos.entry) / pos.entry;
        const pnlEur = pos.size_eur * pnlPct;
        cash += pos.size_eur + pnlEur;
        closedTrades.push({ ...pos, exit_price: cur, pnl_eur: pnlEur, status: 'timeout', closed_at: d });
        return false;
      }
      pos.current_price = cur;
      return true;
    });

    // ── 2) Open new positions ──
    const slots = MAX_POSITIONS - positions.length;
    if (slots > 0 && cash > 1) {
      const opened = new Set(positions.map(p => p.asset));
      const candidates = [];
      for (const [label, asset] of Object.entries(data)) {
        if (opened.has(label)) continue;
        const slice = asset.prices.slice(0, today + 1);
        const sliceVol = asset.volumes.slice(0, today + 1);
        if (slice.length < 220) continue;
        const ind = computeAllIndicators(slice, sliceVol);
        if (!ind) continue;
        const atrP = atrPct(slice);
        if (atrP == null) continue;
        const last = slice[slice.length - 1];
        const atrAbs = (atrP / 100) * last;
        const regime = detectRegime(slice);
        const setup = detectSetupForHorizon(ind, slice, atrAbs, regime, ATR_TP2);
        if (!setup) continue;
        if (setup.quality < MIN_QUALITY) continue;
        const entry = last;
        const stop = entry - 1.0 * atrAbs;
        const tp1 = entry + (ATR_TP2 * 0.5) * atrAbs;
        const tp2 = entry + ATR_TP2 * atrAbs;
        if (stop >= entry || tp1 <= entry || tp2 <= tp1) continue;
        candidates.push({ label, kind: asset.kind, setup, entry, stop, tp1, tp2 });
      }
      candidates.sort((a, b) => b.setup.quality - a.setup.quality);
      for (const c of candidates.slice(0, slots)) {
        const size_eur = cash * (c.setup.sizing_pct / 100);
        if (size_eur < 0.5) continue;
        cash -= size_eur;
        const risk_pct = (c.entry - c.stop) / c.entry;
        positions.push({
          asset: c.label, kind: c.kind, pattern: c.setup.pattern,
          quality: c.setup.quality, sizing_pct: c.setup.sizing_pct,
          stacked: c.setup.stacked === true,
          entry: c.entry, stop: c.stop, tp1: c.tp1, tp2: c.tp2,
          rr1: (c.tp1 - c.entry) / (c.entry - c.stop),
          rr2: (c.tp2 - c.entry) / (c.entry - c.stop),
          size_eur, risk_pct,
          touched_tp1: false, trailing_active: false,
          opened_at: d,
        });
      }
    }

    // ── 3) Equity ──
    let equity = cash;
    for (const p of positions) {
      const cur = data[p.asset].prices[today] || p.entry;
      equity += p.size_eur * (cur / p.entry);
    }
    equityHistory.push({ day: d, equity: Number(equity.toFixed(2)), cash: Number(cash.toFixed(2)), positions: positions.length });
  }

  // ── Final stats ──
  const finalEquity = equityHistory[equityHistory.length - 1].equity;
  const totalReturn = ((finalEquity - CAPITAL_INITIAL) / CAPITAL_INITIAL) * 100;
  const wins = closedTrades.filter(t => t.pnl_eur > 0);
  const losses = closedTrades.filter(t => t.pnl_eur <= 0);
  const profitSum = wins.reduce((s, t) => s + t.pnl_eur, 0);
  const lossSum = Math.abs(losses.reduce((s, t) => s + t.pnl_eur, 0));
  const pf = lossSum > 0 ? profitSum / lossSum : (profitSum > 0 ? 999 : 0);
  const winRate = closedTrades.length > 0 ? wins.length / closedTrades.length : 0;
  let maxEq = CAPITAL_INITIAL, maxDd = 0;
  equityHistory.forEach(p => {
    if (p.equity > maxEq) maxEq = p.equity;
    const dd = (p.equity - maxEq) / maxEq;
    if (dd < maxDd) maxDd = dd;
  });

  const result = {
    version: '4.5',
    backtest_period_days: BACKTEST_DAYS,
    assets_count: Object.keys(data).length,
    capital_initial: CAPITAL_INITIAL,
    equity_final: finalEquity,
    total_return_pct: Number(totalReturn.toFixed(2)),
    trades_closed: closedTrades.length,
    trades_open_at_end: positions.length,
    win_rate: Number((winRate * 100).toFixed(1)),
    profit_factor: Number(pf.toFixed(2)),
    max_drawdown_pct: Number((maxDd * 100).toFixed(2)),
    equity_high: Number(maxEq.toFixed(2)),
    cash_final: Number(equityHistory[equityHistory.length - 1].cash.toFixed(2)),
    avg_pnl_per_trade: closedTrades.length > 0 ? Number((closedTrades.reduce((s, t) => s + t.pnl_eur, 0) / closedTrades.length).toFixed(2)) : 0,
    trades_by_pattern: { A: closedTrades.filter(t => t.pattern === 'A').length, B: closedTrades.filter(t => t.pattern === 'B').length, C: closedTrades.filter(t => t.pattern === 'C').length },
    trades_by_outcome: { win: wins.length, loss: closedTrades.filter(t => t.status === 'loss').length, breakeven: closedTrades.filter(t => t.status === 'breakeven').length, partial_stop: closedTrades.filter(t => t.status === 'partial_stop').length, timeout: closedTrades.filter(t => t.status === 'timeout').length },
    stacked_trades: closedTrades.filter(t => t.stacked).length,
    equity_history: equityHistory,
    closed_trades_sample: closedTrades.slice(-15),
    generated: new Date().toISOString(),
  };

  await fs.mkdir(path.join(process.cwd(), 'data', 'sandbox'), { recursive: true });
  const out = path.join(process.cwd(), 'data', 'sandbox', 'backtest_90d.json');
  await fs.writeFile(out, JSON.stringify(result, null, 2) + '\n', 'utf8');

  console.log('\n=== RÉSULTAT BACKTEST 90j ===');
  console.log(`Capital initial : ${CAPITAL_INITIAL.toFixed(2)} €`);
  console.log(`Equity finale   : ${result.equity_final.toFixed(2)} €`);
  console.log(`Performance     : ${result.total_return_pct >= 0 ? '+' : ''}${result.total_return_pct}%`);
  console.log(`Trades clos     : ${result.trades_closed} (${result.trades_open_at_end} encore open)`);
  console.log(`Win rate        : ${result.win_rate}%`);
  console.log(`Profit Factor   : ${result.profit_factor}`);
  console.log(`Max drawdown    : ${result.max_drawdown_pct}%`);
  console.log(`Equity high     : ${result.equity_high} €`);
  console.log(`Patterns        :`, result.trades_by_pattern);
  console.log(`Outcomes        :`, result.trades_by_outcome);
  console.log(`Stacked trades  : ${result.stacked_trades}`);
  console.log(`\nWrote ${out}`);
}

main().catch(e => {
  console.error('backtest failed:', e);
  process.exit(1);
});
