#!/usr/bin/env node
/**
 * Trade Genius — Backtest des 4 agents IA sur historique long terme
 *
 * Pour chaque actif du panier, on rejoue jour par jour les 18 derniers mois :
 *   - on calcule les indicateurs avec les données disponibles jusqu'à ce jour
 *   - on demande à chaque agent (ATLAS/ZEN/NOVA/KAIRO) s'il prend position
 *   - si oui, on observe les 30 jours suivants (look-ahead) pour trancher :
 *       • close descend sous stop avant TP1  → LOSS (-1 unité de risque)
 *       • close monte au-dessus de TP2 avant Stop → FULL_WIN (+rr2)
 *       • close monte au-dessus de TP1 puis stop touché → PARTIAL_WIN (+rr1/2)
 *       • aucun des 3 touché en 30 jours → TIMEOUT (sortie au close J+30)
 *
 * Output : data/agent-performance.json
 *   - global : win_rate, profit_factor, R/R moyen, num_trades, equity_curve
 *   - par agent et par classe d'actif
 *   - top wins / pires trades
 *
 * IMPORTANT — La logique des 4 agents est une SIMPLIFICATION fidèle des
 * méthodologies privées de scripts/build-ai-study.mjs. Si tu modifies un
 * agent dans build-ai-study, sync également ici. Le backtest n'a pas
 * besoin des champs cosmétiques (label, rationale, config) — juste les
 * filtres logiques et les niveaux entry/stop/tp1/tp2.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  fetchYahooHistorical, fetchCoinGeckoHistorical,
  computeAllIndicators, atrPct,
} from './indicators.mjs';

// ── Panier d'actifs pour le backtest (sélection liquide) ─────────────
// On limite à ~25 pour que le backtest tienne dans le temps imparti du
// workflow GitHub Actions. Mix indices / crypto / actions / forex / métaux.
const ASSETS = [
  // Indices
  { kind: 'index',  symbol: '^GSPC',     label: 'S&P 500' },
  { kind: 'index',  symbol: '^IXIC',     label: 'Nasdaq' },
  { kind: 'index',  symbol: '^DJI',      label: 'Dow Jones' },
  { kind: 'index',  symbol: '^FCHI',     label: 'CAC 40' },
  { kind: 'index',  symbol: '^GDAXI',    label: 'DAX' },
  { kind: 'index',  symbol: '^N225',     label: 'Nikkei 225' },
  // Crypto
  { kind: 'crypto', id: 'bitcoin',       label: 'BTC' },
  { kind: 'crypto', id: 'ethereum',      label: 'ETH' },
  { kind: 'crypto', id: 'solana',        label: 'SOL' },
  { kind: 'crypto', id: 'binancecoin',   label: 'BNB' },
  { kind: 'crypto', id: 'ripple',        label: 'XRP' },
  { kind: 'crypto', id: 'cardano',       label: 'ADA' },
  // Actions
  { kind: 'action', symbol: 'AAPL',      label: 'Apple' },
  { kind: 'action', symbol: 'MSFT',      label: 'Microsoft' },
  { kind: 'action', symbol: 'GOOGL',     label: 'Alphabet' },
  { kind: 'action', symbol: 'NVDA',      label: 'Nvidia' },
  { kind: 'action', symbol: 'TSLA',      label: 'Tesla' },
  { kind: 'action', symbol: 'META',      label: 'Meta' },
  // Forex
  { kind: 'forex',  symbol: 'EURUSD=X',  label: 'EUR/USD' },
  { kind: 'forex',  symbol: 'GBPUSD=X',  label: 'GBP/USD' },
  { kind: 'forex',  symbol: 'USDJPY=X',  label: 'USD/JPY' },
  // Métaux
  { kind: 'metal',  symbol: 'GC=F',      label: 'Or' },
  { kind: 'metal',  symbol: 'SI=F',      label: 'Argent' },
];

const LOOK_AHEAD = 30;   // bars de look-ahead pour résoudre un trade
const WARMUP = 220;      // bars d'historique minimum (SMA200 + 20j buffer)
const RISK_PER_TRADE = 1; // unité normalisée (les R/R sont multiples de ça)

// ─────────────────────────────────────────────────────────────────────
// Détecteurs simplifiés des 4 agents
// (sync avec build-ai-study.mjs : ATLAS/ZEN/NOVA/KAIRO)
// ─────────────────────────────────────────────────────────────────────

// Doji simplifié : la dernière bougie est un doji haussier ssi
//   - bougie t-1 baissière forte (close < open d'au moins 0.5 ATR%)
//   - bougie t avec open ~= close (corps < 0.3 * range total)
//   - bougie t+1 ou tendance immédiate haussière (récent close > t close)
// On travaille avec closes seulement → approximation : on regarde si
// le close à t est entre les 2 closes précédents (range serré).
function isDoji(prices, i, atrAbs) {
  if (i < 3) return false;
  const c0 = prices[i];
  const c1 = prices[i - 1];
  const c2 = prices[i - 2];
  // bougie précédente baissière franche
  if (c1 >= c2) return false;
  const drop = c2 - c1;
  if (drop < atrAbs * 0.6) return false;
  // bougie actuelle ~ stable (doji proxy)
  const stab = Math.abs(c0 - c1);
  if (stab > atrAbs * 0.4) return false;
  return { stopLevel: Math.min(c1, c0) - atrAbs * 0.2 };
}

// Ponchy : Doji haussier + Ichimoku ascendant + MA7 ascendante (3 confirmations)
function isPonchy(prices, ind, i, atrAbs) {
  const dj = isDoji(prices, i, atrAbs);
  if (!dj) return null;
  const ichi = ind.ichimoku;
  if (!ichi || ichi.position !== 'above-cloud' || ichi.signal !== 'bull') return null;
  // MA7 ascendante : approximation = sma7 > sma7 d'il y a 3 jours
  if (prices.length < 11) return null;
  const ma7_now = (prices[i] + prices[i-1] + prices[i-2] + prices[i-3] + prices[i-4] + prices[i-5] + prices[i-6]) / 7;
  const ma7_3ago = (prices[i-3] + prices[i-4] + prices[i-5] + prices[i-6] + prices[i-7] + prices[i-8] + prices[i-9]) / 7;
  if (ma7_now <= ma7_3ago) return null;
  return dj;
}

// ─── ATLAS — Le Gardien (LT, structure complète) ──────────────────────
function detectAtlas(prices, ind, atrAbs, i) {
  if (prices.length < 60) return null;
  const last = prices[i];
  // Bonus Ponchy
  const pon = isPonchy(prices, ind, i, atrAbs);
  if (pon) {
    const entry = last;
    const stop = Math.min(pon.stopLevel, entry - 1.5 * atrAbs);
    const tp1 = entry + 3 * atrAbs;
    const tp2 = entry + 6 * atrAbs;
    if (stop < entry && tp1 > entry && tp2 > tp1 && (tp2 - entry) / (entry - stop) >= 2.5) {
      return { agent: 'atlas', type: 'ponchy', entry, stop, tp1, tp2,
               rr1: (tp1 - entry) / (entry - stop),
               rr2: (tp2 - entry) / (entry - stop) };
    }
  }
  const rsi = ind.rsi?.value;
  const adx = ind.adx?.value || 0;
  const macdH = ind.macd?.value;
  const ichi = ind.ichimoku;
  const ma20 = ind.ma20?.value;
  const ma50 = ind.maCross?.ma50;
  const s200 = ind.sma200?.value;
  const s200d = ind.sma200?.distance;
  const obv = ind.obv;
  const di = ind.directional;
  if (s200) {
    if (last <= s200) return null;
    if (ma50 && ma50 <= s200) return null;
    if (s200d != null && (s200d > 25 || s200d < 2)) return null;
  }
  if (!ichi || ichi.position !== 'above-cloud' || ichi.signal !== 'bull') return null;
  if (!ma20 || !ma50 || ma20 <= ma50) return null;
  if (last <= ma20) return null;
  if (adx < 25) return null;
  if (di && di.plusDI <= di.minusDI) return null;
  if (obv && obv.trend === 'down') return null;
  if (rsi == null || rsi < 45 || rsi > 65) return null;
  if (macdH == null || macdH <= 0) return null;
  const entry = last;
  const stop = Math.min(entry - 1.3 * atrAbs, ma20 * 0.99);
  const tp1 = entry + 2.5 * atrAbs;
  const tp2 = entry + 5 * atrAbs;
  if (stop >= entry || tp1 <= entry || tp2 <= tp1) return null;
  if ((tp2 - entry) / (entry - stop) < 2.5) return null;
  return { agent: 'atlas', type: 'tendance-lt', entry, stop, tp1, tp2,
           rr1: (tp1 - entry) / (entry - stop),
           rr2: (tp2 - entry) / (entry - stop) };
}

// ─── ZEN — L'Équilibriste (3 voies tactiques) ──────────────────────────
function detectZen(prices, ind, atrAbs, i) {
  if (prices.length < 30) return null;
  const last = prices[i];
  const rsi = ind.rsi?.value;
  const macdH = ind.macd?.value;
  const ma20 = ind.ma20?.value;
  const ma50 = ind.maCross?.ma50;
  const boll = ind.boll?.value;
  const adx = ind.adx?.value || 0;
  const vw = ind.vwap;
  if (!ma20 || !ma50 || ma20 <= ma50) return null;
  if (macdH == null || macdH <= 0) return null;
  if (adx < 18) return null;
  // Voie 1 : Doji haussier
  const dj = isDoji(prices, i, atrAbs);
  if (dj) {
    const entry = last;
    const stop = Math.min(dj.stopLevel, entry - 1.5 * atrAbs);
    const tp1 = entry + 2 * atrAbs;
    const tp2 = entry + 4 * atrAbs;
    if (stop < entry && tp1 > entry && tp2 > tp1 && (tp2 - entry) / (entry - stop) >= 2.0) {
      return { agent: 'zen', type: 'doji', entry, stop, tp1, tp2,
               rr1: (tp1 - entry) / (entry - stop),
               rr2: (tp2 - entry) / (entry - stop) };
    }
  }
  // Voie 2 : retest VWAP
  if (vw && vw.distancePct >= -2 && vw.distancePct <= 0.5
      && rsi != null && rsi >= 40 && rsi <= 60) {
    const entry = last;
    const stop = Math.min(entry - 1.4 * atrAbs, (vw.value || entry) * 0.99);
    const tp1 = entry + 2 * atrAbs;
    const tp2 = entry + 3.5 * atrAbs;
    if (stop < entry && tp1 > entry && tp2 > tp1 && (tp2 - entry) / (entry - stop) >= 2.0) {
      return { agent: 'zen', type: 'vwap-retest', entry, stop, tp1, tp2,
               rr1: (tp1 - entry) / (entry - stop),
               rr2: (tp2 - entry) / (entry - stop) };
    }
  }
  // Voie 3 : pullback Bollinger
  if (rsi != null && rsi >= 40 && rsi <= 58
      && boll != null && boll >= 0.25 && boll <= 0.55) {
    const entry = last;
    const stop = Math.min(entry - 1.5 * atrAbs, ma50 * 0.985);
    const tp1 = entry + 2 * atrAbs;
    const tp2 = entry + 4 * atrAbs;
    if (stop < entry && tp1 > entry && tp2 > tp1 && (tp2 - entry) / (entry - stop) >= 2.0) {
      return { agent: 'zen', type: 'pullback', entry, stop, tp1, tp2,
               rr1: (tp1 - entry) / (entry - stop),
               rr2: (tp2 - entry) / (entry - stop) };
    }
  }
  return null;
}

// ─── NOVA — Le Tacticien (multi-confirmations équilibrées) ─────────────
// Reproduit detectSetup() simplifié + fallback Doji
function detectNova(prices, ind, atrAbs, i) {
  if (prices.length < 30) return null;
  const last = prices[i];
  const rsi = ind.rsi?.value;
  const adx = ind.adx?.value || 0;
  const macdH = ind.macd?.value;
  const ma20 = ind.ma20?.value;
  const ma50 = ind.maCross?.ma50;
  const boll = ind.boll?.value;
  const mom = ind.mom?.valuePct;
  const recentTrend3 = i > 3 ? (last - prices[i - 4]) / prices[i - 4] : 0;
  const validate = (entry, stop, tp1, tp2) => {
    if (stop >= entry || tp1 <= entry || tp2 <= tp1) return null;
    if ((tp2 - entry) / (entry - stop) < 1.8) return null;
    return { agent: 'nova', entry, stop, tp1, tp2,
             rr1: (tp1 - entry) / (entry - stop),
             rr2: (tp2 - entry) / (entry - stop) };
  };
  // Setup 1 : rebond survente
  if (rsi != null && rsi < 30 && boll != null && boll < 0.15
      && ma20 != null && ma20 > last && recentTrend3 > -0.025) {
    const entry = last;
    const stop = entry - 1.5 * atrAbs;
    const tp1 = Math.min(ma20, entry + 2 * atrAbs);
    const tp2 = Math.max(entry + 3 * atrAbs, tp1 + atrAbs);
    const r = validate(entry, stop, tp1, tp2);
    if (r) return Object.assign(r, { type: 'rebond-survente' });
  }
  // Setup 2 : pullback haussier
  if (ma20 && ma50 && ma20 > ma50 && last >= ma50
      && rsi != null && rsi >= 38 && rsi <= 60
      && macdH != null && macdH > 0 && adx > 20
      && mom != null && mom > 0) {
    const entry = last;
    const stop = Math.min(entry - 1.5 * atrAbs, ma50 * 0.985);
    const tp1 = entry + 1.5 * atrAbs;
    const tp2 = entry + 3 * atrAbs;
    const r = validate(entry, stop, tp1, tp2);
    if (r) return Object.assign(r, { type: 'pullback-haussier' });
  }
  // Setup 3 : breakout
  if (rsi != null && rsi >= 55 && rsi <= 70
      && boll != null && boll > 0.85
      && ind.atr && ind.atr.value < 4 && adx > 22
      && ma20 && ma50 && ma20 > ma50
      && macdH != null && macdH > 0) {
    const entry = last;
    const stop = entry - 2 * atrAbs;
    const tp1 = entry + 2 * atrAbs;
    const tp2 = entry + 4 * atrAbs;
    const r = validate(entry, stop, tp1, tp2);
    if (r) return Object.assign(r, { type: 'breakout' });
  }
  // Setup 4 : continuation
  if (ma20 && ma50 && ma20 > ma50 && last > ma20
      && rsi != null && rsi >= 50 && rsi <= 68
      && mom != null && mom > 1 && adx > 16
      && macdH != null && macdH > 0) {
    const entry = last;
    const stop = Math.min(entry - 1.8 * atrAbs, ma20 * 0.985);
    const tp1 = entry + 2 * atrAbs;
    const tp2 = entry + 4 * atrAbs;
    const r = validate(entry, stop, tp1, tp2);
    if (r) return Object.assign(r, { type: 'continuation' });
  }
  // Setup 5 : rebond MA50
  if (ma20 && ma50 && ma20 > ma50
      && rsi != null && rsi >= 40 && rsi <= 55
      && last <= ma50 * 1.015 && last >= ma50 * 0.985
      && adx > 14 && macdH != null && macdH >= 0) {
    const entry = last;
    const stop = Math.min(entry - 1.5 * atrAbs, ma50 * 0.97);
    const tp1 = entry + 1.5 * atrAbs;
    const tp2 = Math.max(ma20, entry + 3 * atrAbs);
    const r = validate(entry, stop, tp1, tp2);
    if (r) return Object.assign(r, { type: 'rebond-ma50' });
  }
  return null;
}

// ─── KAIRO — Le Chasseur (contrarian) ──────────────────────────────────
function detectKairo(prices, ind, atrAbs, i) {
  if (prices.length < 30) return null;
  const last = prices[i];
  const rsi = ind.rsi?.value;
  const div = ind.rsiDivergence;
  const mf = ind.mfi?.value;
  const hma = ind.hullMA?.value;
  const ma50 = ind.maCross?.ma50;
  // Voie 1 : divergence RSI bullish
  if (div && div.type === 'bullish' && div.strength >= 0.3
      && ma50 && last > ma50 * 0.9) {
    const entry = last;
    const stop = entry - 2 * atrAbs;
    const tp1 = entry + 2.5 * atrAbs;
    const tp2 = entry + 5 * atrAbs;
    if (stop < entry && tp1 > entry && tp2 > tp1 && (tp2 - entry) / (entry - stop) >= 2.0) {
      return { agent: 'kairo', type: 'divergence', entry, stop, tp1, tp2,
               rr1: (tp1 - entry) / (entry - stop),
               rr2: (tp2 - entry) / (entry - stop) };
    }
  }
  // Voie 2 : capitulation MFI
  if (mf != null && mf < 22 && rsi != null && rsi < 40
      && hma && last > hma * 0.97) {
    const entry = last;
    const stop = entry - 2.2 * atrAbs;
    const tp1 = entry + 2 * atrAbs;
    const tp2 = entry + 5 * atrAbs;
    if (stop < entry && tp1 > entry && tp2 > tp1 && (tp2 - entry) / (entry - stop) >= 2.0) {
      return { agent: 'kairo', type: 'capitulation', entry, stop, tp1, tp2,
               rr1: (tp1 - entry) / (entry - stop),
               rr2: (tp2 - entry) / (entry - stop) };
    }
  }
  return null;
}

const AGENTS = [
  { id: 'atlas', name: 'ATLAS', icon: '🛡️', detect: detectAtlas },
  { id: 'zen',   name: 'ZEN',   icon: '🌿', detect: detectZen },
  { id: 'nova',  name: 'NOVA',  icon: '⚡', detect: detectNova },
  { id: 'kairo', name: 'KAIRO', icon: '🔥', detect: detectKairo },
];

// ─────────────────────────────────────────────────────────────────────
// Résolution du trade : on regarde les LOOK_AHEAD closes suivants
// ─────────────────────────────────────────────────────────────────────
function resolveTrade(prices, t, trade) {
  const { entry, stop, tp1, tp2, rr1, rr2 } = trade;
  let touchedTp1 = false;
  for (let i = t + 1; i <= Math.min(t + LOOK_AHEAD, prices.length - 1); i++) {
    const c = prices[i];
    // Stop touché en premier (avant tp1)
    if (c <= stop) {
      if (touchedTp1) {
        // On a déjà touché tp1, on encaisse rr1/2 puis stop annule la moitié
        // Simplification : on compte +rr1/2 (le risque résiduel est nul)
        return { outcome: 'PARTIAL_THEN_STOP', exit_bar: i - t, pnl: rr1 / 2 };
      }
      return { outcome: 'LOSS', exit_bar: i - t, pnl: -1 };
    }
    // TP1 touché
    if (!touchedTp1 && c >= tp1) {
      touchedTp1 = true;
    }
    // TP2 touché
    if (c >= tp2) {
      return { outcome: 'FULL_WIN', exit_bar: i - t, pnl: rr2 };
    }
  }
  // Timeout : sortie au close J+LOOK_AHEAD
  const exitIdx = Math.min(t + LOOK_AHEAD, prices.length - 1);
  const exitClose = prices[exitIdx];
  const pnl = (exitClose - entry) / (entry - stop);
  if (touchedTp1) {
    // On avait touché tp1 → on garde au moins rr1/2
    return { outcome: 'PARTIAL_TIMEOUT', exit_bar: exitIdx - t, pnl: Math.max(rr1 / 2, pnl / 2) };
  }
  return { outcome: 'TIMEOUT', exit_bar: exitIdx - t, pnl: pnl };
}

// ─────────────────────────────────────────────────────────────────────
// Fetch des données : 2 ans Yahoo / CoinGecko
// ─────────────────────────────────────────────────────────────────────
async function fetchAsset(a) {
  try {
    if (a.kind === 'crypto') {
      const d = await fetchCoinGeckoHistorical(a.id, 700);
      return { ...a, prices: d.prices, volumes: d.volumes };
    }
    const d = await fetchYahooHistorical(a.symbol, '2y');
    return { ...a, prices: d.prices, volumes: d.volumes };
  } catch (e) {
    console.warn(`Skip ${a.label}: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Backtest d'un actif : itère jour par jour et collecte les trades
// ─────────────────────────────────────────────────────────────────────
function backtestAsset(asset) {
  const { prices, volumes } = asset;
  if (!prices || prices.length < WARMUP + LOOK_AHEAD + 5) {
    return { asset: asset.label, kind: asset.kind, trades: [], skipped: true,
             reason: `not enough data (${prices?.length || 0})` };
  }
  const trades = [];
  const N = prices.length;
  // On stoppe à N-LOOK_AHEAD pour avoir de la marge de résolution
  for (let t = WARMUP; t < N - LOOK_AHEAD; t++) {
    const subset = prices.slice(0, t + 1);
    const subVol = volumes ? volumes.slice(0, t + 1) : null;
    const ind = computeAllIndicators(subset, subVol);
    if (!ind) continue;
    const atrPctVal = atrPct(subset);
    if (!atrPctVal) continue;
    const last = subset[subset.length - 1];
    const atrAbs = (atrPctVal / 100) * last;
    for (const ag of AGENTS) {
      const sig = ag.detect(subset, ind, atrAbs, t);
      if (!sig) continue;
      const res = resolveTrade(prices, t, sig);
      trades.push({
        bar: t,
        agent: ag.id,
        type: sig.type,
        entry: sig.entry,
        stop: sig.stop,
        tp1: sig.tp1,
        tp2: sig.tp2,
        rr1: Number(sig.rr1.toFixed(2)),
        rr2: Number(sig.rr2.toFixed(2)),
        outcome: res.outcome,
        exit_bar: res.exit_bar,
        pnl: Number(res.pnl.toFixed(2)),
      });
    }
  }
  return { asset: asset.label, kind: asset.kind, bars: N, trades };
}

// ─────────────────────────────────────────────────────────────────────
// Agrégation des statistiques
// ─────────────────────────────────────────────────────────────────────
function aggregate(allResults) {
  // Flatten : tous les trades avec asset/kind attachés
  const allTrades = [];
  for (const r of allResults) {
    if (r.skipped) continue;
    for (const t of r.trades) {
      allTrades.push({ ...t, asset: r.asset, kind: r.kind });
    }
  }
  function statsFor(trades) {
    if (trades.length === 0) {
      return { num_trades: 0, win_rate: 0, profit_factor: 0,
               avg_pnl: 0, total_pnl: 0, expectancy: 0 };
    }
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    const winRate = wins.length / trades.length;
    const sumWin = wins.reduce((s, t) => s + t.pnl, 0);
    const sumLossAbs = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = sumLossAbs > 0 ? sumWin / sumLossAbs : (sumWin > 0 ? Infinity : 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgPnl = totalPnl / trades.length;
    const avgWin = wins.length ? sumWin / wins.length : 0;
    const avgLoss = losses.length ? sumLossAbs / losses.length : 0;
    // Expectancy = winRate * avgWin - lossRate * avgLoss
    const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;
    return {
      num_trades: trades.length,
      num_wins: wins.length,
      num_losses: losses.length,
      win_rate: Number((winRate * 100).toFixed(1)),
      profit_factor: isFinite(profitFactor) ? Number(profitFactor.toFixed(2)) : null,
      avg_pnl: Number(avgPnl.toFixed(3)),
      total_pnl: Number(totalPnl.toFixed(2)),
      expectancy: Number(expectancy.toFixed(3)),
      avg_win: Number(avgWin.toFixed(2)),
      avg_loss: Number(avgLoss.toFixed(2)),
    };
  }
  const byAgent = {};
  for (const ag of AGENTS) {
    const trades = allTrades.filter(t => t.agent === ag.id);
    byAgent[ag.id] = {
      id: ag.id, name: ag.name, icon: ag.icon,
      ...statsFor(trades),
      byKind: ['index', 'crypto', 'action', 'forex', 'metal'].reduce((acc, k) => {
        acc[k] = statsFor(trades.filter(t => t.kind === k));
        return acc;
      }, {}),
      best_trades: trades.filter(t => t.pnl > 0)
        .sort((a, b) => b.pnl - a.pnl).slice(0, 5)
        .map(t => ({ asset: t.asset, type: t.type, pnl: t.pnl, outcome: t.outcome })),
      worst_trades: trades.filter(t => t.pnl < 0)
        .sort((a, b) => a.pnl - b.pnl).slice(0, 5)
        .map(t => ({ asset: t.asset, type: t.type, pnl: t.pnl })),
      // Equity curve = cumul des pnl par ordre chronologique (bar index)
      equity_curve: (() => {
        const sorted = [...trades].sort((a, b) => a.bar - b.bar);
        let cum = 0;
        return sorted.map(t => {
          cum += t.pnl;
          return Number(cum.toFixed(2));
        });
      })(),
    };
  }
  return { global: statsFor(allTrades), by_agent: byAgent };
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[backtest] ${ASSETS.length} actifs, look-ahead ${LOOK_AHEAD}j, warm-up ${WARMUP}j`);
  // Fetch séquentiel pour ne pas DDOS CoinGecko (rate limit free)
  const fetched = [];
  for (const a of ASSETS) {
    const r = await fetchAsset(a);
    if (r) fetched.push(r);
    await new Promise(r => setTimeout(r, 600)); // rate-limit polite
  }
  console.log(`[backtest] ${fetched.length}/${ASSETS.length} actifs récupérés`);
  const results = fetched.map(backtestAsset);
  for (const r of results) {
    if (r.skipped) {
      console.log(`  ${r.asset}: SKIP (${r.reason})`);
    } else {
      console.log(`  ${r.asset}: ${r.trades.length} trades sur ${r.bars} bars`);
    }
  }
  const agg = aggregate(results);
  const out = {
    generated: new Date().toISOString(),
    look_ahead_days: LOOK_AHEAD,
    warmup_days: WARMUP,
    num_assets: fetched.length,
    assets_tested: fetched.map(a => a.label),
    period_bars: fetched.length > 0 ? Math.min(...fetched.map(a => a.prices.length)) : 0,
    methodology: {
      description: 'Backtest jour par jour : à chaque close, on demande aux 4 agents s\'ils prennent position. Si oui, on suit les 30 closes suivants et on classe le trade (LOSS si stop touché en premier, FULL_WIN si TP2, PARTIAL si TP1 puis stop, TIMEOUT sinon).',
      caveats: [
        'Résolution sur closes uniquement (pas de high/low intraday) — légèrement conservateur sur les wins',
        'Pas de slippage ni de frais simulés — surestime légèrement le PnL réel',
        'Les niveaux entry/stop/tp sont fixés à la barre de signal et ne sont pas ajustés ensuite (pas de trailing stop)',
        'Indicateurs recalculés sur les données disponibles à chaque barre — pas de lookahead bias',
      ],
    },
    global: agg.global,
    by_agent: agg.by_agent,
    disclaimer: "Performances passées ne préjugent pas des performances futures. Cas pédagogique strictement.",
  };
  const target = path.join(process.cwd(), 'data', 'agent-performance.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`[backtest] Wrote ${target}`);
  console.log('[backtest] Global:', JSON.stringify(agg.global));
  for (const ag of AGENTS) {
    const s = agg.by_agent[ag.id];
    console.log(`  ${ag.name}: ${s.num_trades} trades, win ${s.win_rate}%, PF ${s.profit_factor}, expectancy ${s.expectancy}`);
  }
}

main().catch(e => {
  console.error('[backtest] FAILED:', e);
  process.exit(1);
});
