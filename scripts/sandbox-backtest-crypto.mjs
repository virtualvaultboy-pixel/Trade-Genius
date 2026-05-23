#!/usr/bin/env node
/**
 * Trade Genius — v5.2 Backtest CRYPTO spécialisé
 *
 * Tourne uniquement sur les 15 plus gros assets crypto (CoinGecko).
 * Compare 2 variantes :
 *   - BASELINE : mêmes filtres que les actions (paramètres v5.0 actuels)
 *   - CRYPTO   : adapté crypto (ATR ×1.5, Fear&Greed, régime BTC, cross-crypto)
 *
 * Mesure si l'IA CRYPTO peut tenir face à la volatilité du marché crypto.
 *
 * Historique CoinGecko : 365j max en daily (gratuit), donc backtest sur ~180j
 * après warmup 180j (proxy d'une moyenne mobile longue adaptée).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchYahooHistorical, computeAllIndicators, atrPct, sma, rsi } from './indicators.mjs';

const CAPITAL_INITIAL = 100;
const MAX_POSITIONS = 4;
const MIN_QUALITY = 60;
const BACKTEST_DAYS = 600;     // ~2.4 ans (Yahoo a beaucoup plus d'historique)
const WARMUP = 220;
const HISTORY_RANGE = '5y';

// 15 plus gros cryptos via Yahoo Finance (pas de rate-limit, historique riche)
const CRYPTOS = [
  { symbol: 'BTC-USD',  label: 'BTC' },
  { symbol: 'ETH-USD',  label: 'ETH' },
  { symbol: 'BNB-USD',  label: 'BNB' },
  { symbol: 'SOL-USD',  label: 'SOL' },
  { symbol: 'XRP-USD',  label: 'XRP' },
  { symbol: 'ADA-USD',  label: 'ADA' },
  { symbol: 'DOGE-USD', label: 'DOGE' },
  { symbol: 'AVAX-USD', label: 'AVAX' },
  { symbol: 'DOT-USD',  label: 'DOT' },
  { symbol: 'LINK-USD', label: 'LINK' },
  { symbol: 'TRX-USD',  label: 'TRX' },
  { symbol: 'LTC-USD',  label: 'LTC' },
  { symbol: 'UNI-USD',  label: 'UNI' },
  { symbol: 'ATOM-USD', label: 'ATOM' },
  { symbol: 'XLM-USD',  label: 'XLM' },
];

// ── Régime crypto (basé sur BTC SMA180 slope) ──────────────────
function detectCryptoRegime(btcPrices) {
  if (!btcPrices || btcPrices.length < 200) return 'unknown';
  const sma180Now = sma(btcPrices.slice(-180), 180);
  const sma180Ago = sma(btcPrices.slice(-200, -20), 180);
  if (sma180Now == null || sma180Ago == null || sma180Ago === 0) return 'unknown';
  const slope = (sma180Now - sma180Ago) / sma180Ago;
  if (slope > 0.05) return 'bull';     // BTC SMA180 +5% sur 20j → cycle haussier
  if (slope < -0.05) return 'bear';    // BTC SMA180 -5% → bear crypto
  return 'sideways';
}

// ── BTC daily change (proxy contagion alts) ────────────────────
function getBtcChangeAt(data, idx) {
  const btc = data['BTC']?.prices;
  if (!btc || idx < 1) return 0;
  return ((btc[idx] - btc[idx - 1]) / btc[idx - 1]) * 100;
}

// ── Patterns adaptés crypto (mêmes que actions mais filtres crypto) ──
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
  return { type: 'C', conf: regime === 'bull' ? 'very-high' : 'high', base: regime === 'bull' ? 75 : 55 };
}
function patternTrendFollow(ind, regime) {
  const rsi = ind.rsi?.value, adx = ind.adx?.value || 0, boll = ind.boll?.value, macdH = ind.macd?.value;
  if (rsi == null || rsi <= 35) return null;
  if (adx < 25) return null; // crypto : ADX seuil 25 (au lieu de 30) car volatilité naturellement plus forte
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
  if (ind.obv?.trend === 'up') s += 5;
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
  let sizing_pct = 1;
  if (quality >= 85) sizing_pct = 5;
  else if (quality >= 70) sizing_pct = 3;
  else if (quality >= 55) sizing_pct = 2;
  return { pattern: best.type, quality, sizing_pct, stacked: best.stacked === true };
}

// ── Fetch Fear & Greed Index historique (gratuit) ─────────────
async function fetchFearGreedHistory(limit = 250) {
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=' + limit, {
      headers: { 'user-agent': 'trade-genius-bot' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!Array.isArray(j?.data)) return null;
    // Inverse l'ordre pour avoir le plus ancien en premier (chronologique)
    return j.data.reverse().map(d => ({
      timestamp: parseInt(d.timestamp, 10) * 1000,
      value: parseInt(d.value, 10),
      classification: d.value_classification,
    }));
  } catch { return null; }
}

// ── Run UNE variante du backtest ──────────────────────────────
function runVariant(data, minLen, variantName, fngHistory) {
  // Crypto-adapted : ATR multiplier 1.5×, cross-crypto filter, F&G filter
  const isCryptoMode = variantName === 'CRYPTO';
  const atrMult = isCryptoMode ? 1.5 : 1.0;
  let cash = CAPITAL_INITIAL;
  let positions = [];
  const equityHist = [];
  const closed = [];
  const startIdx = minLen - BACKTEST_DAYS;

  for (let d = startIdx; d < minLen - 1; d++) {
    const today = d;
    const tomorrow = d + 1;
    const btcChange = getBtcChangeAt(data, today);

    // Update positions open
    positions = positions.filter(pos => {
      const asset = data[pos.asset];
      if (!asset) return false;
      const cur = asset.prices[tomorrow];
      if (cur == null) return true;
      const ageDays = d - pos.opened_at;

      // Trailing chandelier (v5.0)
      if (pos.high_since_entry == null || cur > pos.high_since_entry) pos.high_since_entry = cur;
      if (pos.touched_tp1) {
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
        closed.push({ ...pos, pnl_eur: pnl, status: pos.trailing_active ? (pos.stop > pos.entry ? 'trail_profit' : 'breakeven') : (pos.touched_tp1 ? 'partial' : 'loss'), closed_at: d });
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
      // Sortie RSI > 75 (v5.0)
      if (pos.touched_tp1 && cur > pos.entry) {
        const sliceForRsi = asset.prices.slice(0, tomorrow + 1);
        const rsiNow = rsi(sliceForRsi);
        if (rsiNow != null && rsiNow > 75) {
          const gainPct = (cur - pos.entry) / pos.entry;
          const pnl = pos.size_eur * 0.5 * pos.rr1 * pos.risk_pct + pos.size_eur * 0.5 * gainPct;
          cash += pos.size_eur + pnl;
          closed.push({ ...pos, pnl_eur: pnl, status: 'rsi_exit', closed_at: d });
          return false;
        }
      }
      // Timeout 30j (crypto bouge plus vite, 60j inutile)
      if (ageDays >= 30) {
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
      // Régime crypto basé sur BTC
      const btcPrices = data['BTC']?.prices?.slice(0, today + 1) || [];
      const cryptoRegime = detectCryptoRegime(btcPrices);

      // v5.2 — Fear & Greed mode : EXTREME_FEAR (<20) = opportunité contrarian (bonus)
      //                            EXTREME_GREED (>80) = sommet probable (downgrade)
      let fngVerdict = null;
      if (isCryptoMode && fngHistory) {
        const dayTimestamp = Date.now() - (minLen - 1 - today) * 24 * 3600 * 1000;
        const closest = fngHistory.reduce((best, p) =>
          (Math.abs(p.timestamp - dayTimestamp) < Math.abs(best.timestamp - dayTimestamp)) ? p : best,
          fngHistory[0]
        );
        if (closest && Math.abs(closest.timestamp - dayTimestamp) < 3 * 24 * 3600 * 1000) {
          fngVerdict = closest.value;
        }
      }

      for (const [label, asset] of Object.entries(data)) {
        if (opened.has(label)) continue;
        const slice = asset.prices.slice(0, today + 1);
        if (slice.length < WARMUP) continue;
        const sliceVol = asset.volumes.slice(0, today + 1);
        const ind = computeAllIndicators(slice, sliceVol);
        if (!ind) continue;
        const atrP = atrPct(slice);
        if (atrP == null) continue;
        const last = slice[slice.length - 1];
        const atrAbs = (atrP / 100) * last;
        const setup = detectSetup(ind, cryptoRegime, 5.0);
        if (!setup) continue;

        // v5.2 — Cross-crypto : si BTC dump >5% sur le jour, cap les alts
        if (isCryptoMode && label !== 'BTC' && btcChange < -5) {
          setup.quality = Math.round(setup.quality * 0.7); // -30%
        }
        // v5.2 — Fear & Greed adjustments
        if (isCryptoMode && fngVerdict != null) {
          if (fngVerdict < 20) setup.quality = Math.min(100, Math.round(setup.quality * 1.15)); // extreme fear = bonus contrarian
          else if (fngVerdict > 80) setup.quality = Math.round(setup.quality * 0.75); // extreme greed = downgrade
        }
        if (setup.quality < MIN_QUALITY) continue;

        const entry = last;
        const stop = entry - atrMult * atrAbs;
        const tp1 = entry + (5.0 * 0.5 * atrMult) * atrAbs;
        const tp2 = entry + (5.0 * atrMult) * atrAbs;
        if (stop >= entry || tp1 <= entry || tp2 <= tp1) continue;
        candidates.push({ label, kind: 'crypto', setup, entry, stop, tp1, tp2 });
      }
      candidates.sort((a, b) => b.setup.quality - a.setup.quality);
      const slots = MAX_POSITIONS - positions.length;
      // Kelly-light
      const recent5 = closed.slice(-5);
      let streakMult = 1;
      if (recent5.length >= 3) {
        const last3 = recent5.slice(-3);
        if (last3.every(t => (t.pnl_eur || 0) > 0)) streakMult = 1.2;
        else if (last3.every(t => (t.pnl_eur || 0) <= 0)) streakMult = 0.7;
      }
      for (const c of candidates.slice(0, slots)) {
        const size_eur = cash * (c.setup.sizing_pct * streakMult / 100);
        if (size_eur < 0.5) continue;
        cash -= size_eur;
        const risk_pct = (c.entry - c.stop) / c.entry;
        positions.push({
          asset: c.label, pattern: c.setup.pattern, quality: c.setup.quality,
          sizing_pct: c.setup.sizing_pct, stacked: c.setup.stacked === true,
          entry: c.entry, stop: c.stop, tp1: c.tp1, tp2: c.tp2,
          initial_stop: c.stop, high_since_entry: c.entry,
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

  return {
    variant: variantName,
    equity_final: Number(finalEq.toFixed(2)),
    return_pct: Number(ret.toFixed(2)),
    annualized_pct: Number(((Math.pow(1 + ret / 100, 252 / BACKTEST_DAYS) - 1) * 100).toFixed(2)),
    profit_factor: Number(pf.toFixed(2)),
    max_dd_pct: Number((maxDd * 100).toFixed(2)),
    win_rate_pct: Number((wr * 100).toFixed(1)),
    trades_closed: closed.length,
    avg_pnl_per_trade: closed.length > 0 ? Number((closed.reduce((s, t) => s + t.pnl_eur, 0) / closed.length).toFixed(3)) : 0,
  };
}

async function main() {
  console.log(`Fetching ${CRYPTOS.length} cryptos (Yahoo ${HISTORY_RANGE})...`);
  const data = {};
  for (const c of CRYPTOS) {
    try {
      const d = await fetchYahooHistorical(c.symbol, HISTORY_RANGE);
      data[c.label] = { ...c, prices: d.prices, volumes: d.volumes || [] };
      console.log(`  ${c.label}: ${d.prices.length} candles`);
    } catch (e) {
      console.warn(`  SKIP ${c.label}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 150));
  }

  // Fetch Fear & Greed history
  console.log('Fetching Fear & Greed Index history...');
  const fngHistory = await fetchFearGreedHistory(365);
  console.log(`  ${fngHistory ? fngHistory.length : 0} F&G data points`);

  const lengths = Object.values(data).map(d => d.prices.length);
  const minLen = Math.min(...lengths);
  console.log(`Min length: ${minLen}, backtest ${BACKTEST_DAYS}j ≈ ${(BACKTEST_DAYS / 252).toFixed(2)} ans\n`);

  const results = [
    runVariant(data, minLen, 'BASELINE', null),
    runVariant(data, minLen, 'CRYPTO', fngHistory),
  ];

  await fs.mkdir(path.join(process.cwd(), 'data', 'sandbox'), { recursive: true });
  await fs.writeFile(
    path.join(process.cwd(), 'data', 'sandbox', 'backtest_crypto.json'),
    JSON.stringify({ generated: new Date().toISOString(), backtest_days: BACKTEST_DAYS, assets: Object.keys(data).length, fng_available: fngHistory != null, variants: results }, null, 2) + '\n'
  );

  console.log('\n╔════════════════════════════════════════════════════════════════════╗');
  console.log(`║ CRYPTO ONLY · ${BACKTEST_DAYS}j · ${Object.keys(data).length} cryptos · 100€ initial          `);
  console.log('╠════════════════════════════════════════════════════════════════════╣');
  console.log('║ Variante │ Final   │ Perf    │ /an     │ PF   │ DD     │ Trades │ WR ║');
  console.log('╟──────────┼─────────┼─────────┼─────────┼──────┼────────┼────────┼────╢');
  for (const r of results) {
    const ret = (r.return_pct >= 0 ? '+' : '') + r.return_pct + '%';
    const ann = (r.annualized_pct >= 0 ? '+' : '') + r.annualized_pct + '%';
    console.log(`║ ${r.variant.padEnd(8)} │ ${r.equity_final.toFixed(2).padStart(6)}€ │ ${ret.padStart(7)} │ ${ann.padStart(7)} │ ${r.profit_factor.toFixed(2).padStart(4)} │ ${r.max_dd_pct.toFixed(2).padStart(6)}%│ ${r.trades_closed.toString().padStart(6)} │ ${r.win_rate_pct.toFixed(0).padStart(2)}%║`);
  }
  console.log('╚════════════════════════════════════════════════════════════════════╝');
}

main().catch(e => { console.error(e); process.exit(1); });
