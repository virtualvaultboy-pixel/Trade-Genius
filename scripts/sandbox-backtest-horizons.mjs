#!/usr/bin/env node
/**
 * Trade Genius — Backtest multi-horizons : compare hold court vs long.
 *
 * Sur les mêmes 50 actifs et 4 ans de daily data, teste 4 horizons :
 *   - DAY1   : hold max 1 jour,  TP2 = 1.0 ATR  (≈ day-trade)
 *   - SWING2 : hold max 2 jours, TP2 = 1.5 ATR  (achat-vente 2 jours)
 *   - SWING5 : hold max 5 jours, TP2 = 2.5 ATR  (swing court)
 *   - SWING30: hold max 30j,     TP2 = 5.0 ATR  (référence v4 actuelle)
 *
 * Stop reste à 1 ATR pour tous (pour comparer le ratio gain/perte).
 * Sizing balanced (5%/3%/2%/1%) sur les 4.
 *
 * Note : sur du daily data, "hold 1 jour" signifie entry au close J,
 * exit au close J+1 (pas vrai intraday — pour ça il faut data 1h/15min).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchYahooHistorical, computeAllIndicators, atrPct, sma } from './indicators.mjs';

const CAPITAL_INITIAL = 100;
const MIN_QUALITY = 60;
const HISTORY_RANGE = '5y';
const BACKTEST_DAYS = 1000;
const MAX_POSITIONS = 5;
const SIZING = { high: 5, midHigh: 3, mid: 2, low: 1 };

const HORIZONS = [
  { name: 'DAY1',    holdMax: 1,  atrTp2: 1.0 },
  { name: 'SWING2',  holdMax: 2,  atrTp2: 1.5 },
  { name: 'SWING5',  holdMax: 5,  atrTp2: 2.5 },
  { name: 'SWING30', holdMax: 30, atrTp2: 5.0 },
];

const ASSETS = [
  { kind: 'index', symbol: '^GSPC',     label: 'S&P 500' },
  { kind: 'index', symbol: '^IXIC',     label: 'Nasdaq' },
  { kind: 'index', symbol: '^DJI',      label: 'Dow Jones' },
  { kind: 'index', symbol: '^RUT',      label: 'Russell 2000' },
  { kind: 'index', symbol: '^FCHI',     label: 'CAC 40' },
  { kind: 'index', symbol: '^GDAXI',    label: 'DAX' },
  { kind: 'index', symbol: '^FTSE',     label: 'FTSE 100' },
  { kind: 'index', symbol: '^STOXX50E', label: 'Euro Stoxx 50' },
  { kind: 'index', symbol: '^N225',     label: 'Nikkei 225' },
  { kind: 'index', symbol: '^HSI',      label: 'Hang Seng' },
  { kind: 'action', symbol: 'AAPL',  label: 'Apple' },
  { kind: 'action', symbol: 'MSFT',  label: 'Microsoft' },
  { kind: 'action', symbol: 'GOOGL', label: 'Alphabet' },
  { kind: 'action', symbol: 'AMZN',  label: 'Amazon' },
  { kind: 'action', symbol: 'META',  label: 'Meta' },
  { kind: 'action', symbol: 'NVDA',  label: 'Nvidia' },
  { kind: 'action', symbol: 'TSLA',  label: 'Tesla' },
  { kind: 'action', symbol: 'JPM',   label: 'JPMorgan' },
  { kind: 'action', symbol: 'V',     label: 'Visa' },
  { kind: 'action', symbol: 'BRK-B', label: 'Berkshire' },
  { kind: 'action', symbol: 'WMT',   label: 'Walmart' },
  { kind: 'action', symbol: 'JNJ',   label: 'J&J' },
  { kind: 'action', symbol: 'XOM',   label: 'Exxon' },
  { kind: 'action', symbol: 'PG',    label: 'P&G' },
  { kind: 'action', symbol: 'KO',    label: 'Coca-Cola' },
  { kind: 'action', symbol: 'NFLX',  label: 'Netflix' },
  { kind: 'action', symbol: 'NKE',   label: 'Nike' },
  { kind: 'action', symbol: 'DIS',   label: 'Disney' },
  { kind: 'action', symbol: 'SPY',   label: 'SPY ETF' },
  { kind: 'action', symbol: 'QQQ',   label: 'QQQ ETF' },
  { kind: 'action', symbol: 'IWM',   label: 'IWM ETF' },
  { kind: 'action', symbol: 'EEM',   label: 'EEM' },
  { kind: 'action', symbol: 'GLD',   label: 'GLD' },
  { kind: 'action', symbol: 'TLT',   label: 'TLT' },
  { kind: 'action', symbol: 'XLK',   label: 'XLK Tech' },
  { kind: 'action', symbol: 'XLF',   label: 'XLF Fin' },
  { kind: 'action', symbol: 'XLE',   label: 'XLE Energy' },
  { kind: 'action', symbol: 'MC.PA',   label: 'LVMH' },
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

function patternContrarian(ind, regime) {
  const rsi = ind.rsi?.value, boll = ind.boll?.value, macdH = ind.macd?.value;
  if (rsi == null || rsi >= 25) return null;
  if (boll == null || boll >= 0.25) return null;
  if (macdH == null || macdH >= 0) return null;
  if (regime === 'bear') return null;
  if (ind.mfi?.value > 70) return null;
  return { type: 'A', conf: 'high', base: 70 };
}
function patternPullback(ind, regime) {
  const rsi = ind.rsi?.value, boll = ind.boll?.value, ichi = ind.ichimoku;
  if (rsi == null || rsi <= 35) return null;
  if (boll == null || boll >= 0.25) return null;
  if (!ichi || ichi.position !== 'above-cloud' || ichi.signal !== 'bull') return null;
  if (regime === 'bear') return null;
  if (ind.obv?.trend === 'down') return null;
  if (ind.forceIndex?.signal === 'bear') return null;
  return { type: 'C', conf: regime === 'bull' ? 'very-high' : 'high', base: regime === 'bull' ? 75 : 55 };
}
function patternTrendFollow(ind, regime) {
  const rsi = ind.rsi?.value, adx = ind.adx?.value || 0, boll = ind.boll?.value, macdH = ind.macd?.value;
  if (rsi == null || rsi <= 35) return null;
  if (adx < 30) return null;
  if (boll == null || boll < 0.25 || boll > 0.75) return null;
  if (macdH == null || macdH >= 0) return null;
  if (regime === 'bear') return null;
  if (ind.obv?.trend === 'down') return null;
  return { type: 'B', conf: 'high', base: 60 };
}

function computeQuality(ind, p, regime, atrTp2) {
  let s = p.base;
  if (regime === 'bull') s += 10;
  else if (regime === 'sideways') s += 5;
  const adx = ind.adx?.value || 0;
  if (adx >= 35) s += 10; else if (adx >= 25) s += 5;
  if (atrTp2 >= 5) s += 10; else if (atrTp2 >= 3) s += 5;
  if (ind.obv?.trend === 'up' || ind.obv?.signal === 'bull') s += 5;
  if (p.stacked) s += (p.stackedCount >= 3 ? 20 : 15);
  return Math.min(100, s);
}

function detectSetup(ind, regime, atrTp2) {
  const c = patternPullback(ind, regime);
  const a = patternContrarian(ind, regime);
  const b = patternTrendFollow(ind, regime);
  const hits = [c, a, b].filter(Boolean);
  if (hits.length === 0) return null;
  const best = hits.sort((x, y) => (x.conf === 'very-high' ? -1 : 1))[0];
  if (hits.length >= 2) { best.stacked = true; best.stackedCount = hits.length; best.conf = 'very-high'; }
  const quality = computeQuality(ind, best, regime, atrTp2);
  let sizing_pct = SIZING.low;
  if (quality >= 85) sizing_pct = SIZING.high;
  else if (quality >= 70) sizing_pct = SIZING.midHigh;
  else if (quality >= 55) sizing_pct = SIZING.mid;
  return { pattern: best.type, quality, sizing_pct, stacked: best.stacked === true };
}

function runHorizon(data, minLen, horizon) {
  const { holdMax, atrTp2 } = horizon;
  let cash = CAPITAL_INITIAL;
  let positions = [];
  const equityHist = [];
  const closed = [];
  const startIdx = minLen - BACKTEST_DAYS;

  for (let d = startIdx; d < minLen - 1; d++) {
    const today = d;
    const tomorrow = d + 1;

    // Update positions open
    positions = positions.filter(pos => {
      const asset = data[pos.asset];
      if (!asset) return false;
      const cur = asset.prices[tomorrow];
      if (cur == null) return true;
      const ageDays = d - pos.opened_at;

      if (cur <= pos.stop) {
        const pnl = pos.touched_tp1
          ? (pos.trailing_active ? pos.size_eur * pos.rr1 * 0.5 * pos.risk_pct : pos.size_eur * (pos.rr1 * 0.5 - 0.5) * pos.risk_pct)
          : -pos.size_eur * pos.risk_pct;
        cash += pos.size_eur + pnl;
        closed.push({ ...pos, pnl_eur: pnl, status: pos.trailing_active ? 'breakeven' : (pos.touched_tp1 ? 'partial' : 'loss'), closed_at: d });
        return false;
      }
      if (cur >= pos.tp2) {
        const pnl = pos.size_eur * pos.rr2 * pos.risk_pct;
        cash += pos.size_eur + pnl;
        closed.push({ ...pos, pnl_eur: pnl, status: 'win', closed_at: d });
        return false;
      }
      if (!pos.touched_tp1 && cur >= pos.tp1) {
        pos.touched_tp1 = true;
        pos.stop = pos.entry;
        pos.trailing_active = true;
      }
      if (ageDays >= holdMax) {
        // Timeout : exit au close du jour
        const pnlPct = (cur - pos.entry) / pos.entry;
        const pnl = pos.size_eur * pnlPct;
        cash += pos.size_eur + pnl;
        closed.push({ ...pos, pnl_eur: pnl, status: 'timeout', closed_at: d });
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
        if (slice.length < 220) continue;
        const sliceVol = asset.volumes.slice(0, today + 1);
        const ind = computeAllIndicators(slice, sliceVol);
        if (!ind) continue;
        const atrP = atrPct(slice);
        if (atrP == null) continue;
        const last = slice[slice.length - 1];
        const atrAbs = (atrP / 100) * last;
        const regime = detectRegime(slice);
        const setup = detectSetup(ind, regime, atrTp2);
        if (!setup || setup.quality < MIN_QUALITY) continue;
        const entry = last;
        const stop = entry - 1.0 * atrAbs;
        const tp1 = entry + (atrTp2 * 0.5) * atrAbs;
        const tp2 = entry + atrTp2 * atrAbs;
        if (stop >= entry || tp1 <= entry || tp2 <= tp1) continue;
        candidates.push({ label, kind: asset.kind, setup, entry, stop, tp1, tp2 });
      }
      candidates.sort((a, b) => b.setup.quality - a.setup.quality);
      const slots = MAX_POSITIONS - positions.length;
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

    let eq = cash;
    for (const p of positions) {
      const cur = data[p.asset].prices[today] || p.entry;
      eq += p.size_eur * (cur / p.entry);
    }
    equityHist.push({ day: d, equity: eq });
  }

  // Stats
  const finalEq = equityHist[equityHist.length - 1].equity;
  const ret = ((finalEq - CAPITAL_INITIAL) / CAPITAL_INITIAL) * 100;
  const wins = closed.filter(t => t.pnl_eur > 0);
  const losses = closed.filter(t => t.pnl_eur <= 0);
  const pf = losses.length > 0 && Math.abs(losses.reduce((s, t) => s + t.pnl_eur, 0)) > 0
    ? wins.reduce((s, t) => s + t.pnl_eur, 0) / Math.abs(losses.reduce((s, t) => s + t.pnl_eur, 0))
    : (wins.length > 0 ? 999 : 0);
  const wr = closed.length > 0 ? wins.length / closed.length : 0;
  let maxEq = CAPITAL_INITIAL, maxDd = 0;
  equityHist.forEach(p => {
    if (p.equity > maxEq) maxEq = p.equity;
    const dd = (p.equity - maxEq) / maxEq;
    if (dd < maxDd) maxDd = dd;
  });
  // Hold moyen (en jours)
  const holdDays = closed.map(t => (t.closed_at || 0) - (t.opened_at || 0));
  const avgHold = holdDays.length > 0 ? holdDays.reduce((s, x) => s + x, 0) / holdDays.length : 0;

  return {
    horizon: horizon.name,
    holdMax, atrTp2,
    equity_final: Number(finalEq.toFixed(2)),
    return_pct: Number(ret.toFixed(2)),
    annualized_pct: Number(((Math.pow(1 + ret / 100, 252 / BACKTEST_DAYS) - 1) * 100).toFixed(2)),
    profit_factor: Number(pf.toFixed(2)),
    max_dd_pct: Number((maxDd * 100).toFixed(2)),
    win_rate_pct: Number((wr * 100).toFixed(1)),
    trades_closed: closed.length,
    trades_per_year: Number((closed.length * 252 / BACKTEST_DAYS).toFixed(1)),
    avg_hold_days: Number(avgHold.toFixed(1)),
    avg_pnl_per_trade: closed.length > 0 ? Number((closed.reduce((s, t) => s + t.pnl_eur, 0) / closed.length).toFixed(3)) : 0,
  };
}

async function main() {
  console.log(`Fetching ${ASSETS.length} assets (${HISTORY_RANGE})...`);
  const data = {};
  for (const a of ASSETS) {
    try {
      const d = await fetchYahooHistorical(a.symbol, HISTORY_RANGE);
      data[a.label] = { ...a, prices: d.prices, volumes: d.volumes || [] };
    } catch (e) { console.warn(`SKIP ${a.label}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 130));
  }
  const minLen = Math.min(...Object.values(data).map(d => d.prices.length));
  console.log(`Min length: ${minLen}, backtest ${BACKTEST_DAYS}j ≈ ${(BACKTEST_DAYS / 252).toFixed(1)} ans\n`);

  const results = [];
  for (const h of HORIZONS) {
    console.log(`--- Running ${h.name} (holdMax=${h.holdMax}j, TP2=${h.atrTp2}×ATR) ---`);
    const r = runHorizon(data, minLen, h);
    results.push(r);
    console.log(`  → ${r.equity_final}€ (${r.return_pct >= 0 ? '+' : ''}${r.return_pct}%, ${r.annualized_pct >= 0 ? '+' : ''}${r.annualized_pct}%/an) · PF ${r.profit_factor} · DD ${r.max_dd_pct}% · ${r.trades_closed}t · WR ${r.win_rate_pct}% · hold ${r.avg_hold_days}j`);
  }

  await fs.mkdir(path.join(process.cwd(), 'data', 'sandbox'), { recursive: true });
  await fs.writeFile(path.join(process.cwd(), 'data', 'sandbox', 'backtest_horizons.json'),
    JSON.stringify({ generated: new Date().toISOString(), backtest_days: BACKTEST_DAYS, assets: Object.keys(data).length, horizons: results }, null, 2) + '\n');

  console.log('\n╔═══════════════════════════════════════════════════════════════════════╗');
  console.log(`║ MULTI-HORIZONS · 4 ans · 50 actifs · 100€ initial · sizing balanced  `);
  console.log('╠═══════════════════════════════════════════════════════════════════════╣');
  console.log('║ Horizon │ Final  │ Perf    │ /an    │ PF   │ DD    │ Trades │ WR  │ Hold ║');
  console.log('╟─────────┼────────┼─────────┼────────┼──────┼───────┼────────┼─────┼──────╢');
  for (const r of results) {
    const ret = (r.return_pct >= 0 ? '+' : '') + r.return_pct + '%';
    const ann = (r.annualized_pct >= 0 ? '+' : '') + r.annualized_pct + '%';
    console.log(`║ ${r.horizon.padEnd(7)} │ ${r.equity_final.toFixed(2).padStart(5)}€ │ ${ret.padStart(7)} │ ${ann.padStart(6)} │ ${r.profit_factor.toFixed(2).padStart(4)} │ ${r.max_dd_pct.toFixed(2).padStart(5)}%│ ${r.trades_closed.toString().padStart(6)} │ ${r.win_rate_pct.toFixed(0).padStart(2)}% │ ${r.avg_hold_days.toFixed(1).padStart(4)}j ║`);
  }
  console.log('╚═══════════════════════════════════════════════════════════════════════╝');
}

main().catch(e => { console.error(e); process.exit(1); });
