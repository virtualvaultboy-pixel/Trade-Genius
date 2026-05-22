#!/usr/bin/env node
/**
 * Trade Genius — Tournament des stratégies (v2.83)
 *
 * Teste systématiquement N stratégies × M fenêtres de hold sur le panier
 * d'actifs TRADITIONNELS (actions, ETF, indices, forex, métaux — pas crypto)
 * sur 10 ans d'historique, pour identifier les meilleurs combos par profil :
 *
 *   - PROFIL CONSERVATEUR (petit risque petit gain) : win rate ≥ 55%
 *   - PROFIL ÉQUILIBRÉ                              : compromis win × R/R
 *   - PROFIL AGRESSIF (gros risque gros gain)       : R/R réalisé ≥ 2.5
 *
 * Output : data/strategy-tournament.json
 *   - Top 5 stratégies par profil pour les ACTIONS classiques
 *   - Top 5 stratégies pour les CRYPTO (séparé, panier dédié)
 *   - Stats globales et par classe d'actif
 *
 * Ce script vise à servir de RÉFÉRENCE pour la sélection des 4 agents finaux.
 * Lancement : node scripts/tournament-strategies.mjs
 *             ou workflow_dispatch sur tournament.yml
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  fetchYahooHistorical, fetchCoinGeckoHistorical,
  computeAllIndicators, atrPct,
} from './indicators.mjs';

const HISTORY_RANGE = process.env.TG_TOURNAMENT_RANGE || '20y';
const OUTPUT_FILE = process.env.TG_TOURNAMENT_OUTPUT || 'data/strategy-tournament.json';
const WARMUP = 220;
const MAX_LOOK_AHEAD = 90;
const MIN_TRADES_FOR_VALID = 100; // filtre les stratégies avec trop peu de trades

// ── Panier ACTIONS (sans crypto) ─────────────────────────────────────
// Sélection liquide pour le tournament — focus actions/ETF/indices/forex/métaux
const TRAD_ASSETS = [
  // Indices monde
  { kind: 'index',  symbol: '^GSPC',     label: 'S&P 500' },
  { kind: 'index',  symbol: '^IXIC',     label: 'Nasdaq' },
  { kind: 'index',  symbol: '^DJI',      label: 'Dow Jones' },
  { kind: 'index',  symbol: '^RUT',      label: 'Russell 2000' },
  { kind: 'index',  symbol: '^FCHI',     label: 'CAC 40' },
  { kind: 'index',  symbol: '^GDAXI',    label: 'DAX' },
  { kind: 'index',  symbol: '^FTSE',     label: 'FTSE 100' },
  { kind: 'index',  symbol: '^STOXX50E', label: 'Euro Stoxx 50' },
  { kind: 'index',  symbol: '^N225',     label: 'Nikkei 225' },
  { kind: 'index',  symbol: '^HSI',      label: 'Hang Seng' },
  { kind: 'index',  symbol: '^IBEX',     label: 'IBEX 35' },
  { kind: 'index',  symbol: '^SSMI',     label: 'SMI Suisse' },
  { kind: 'index',  symbol: '^GSPTSE',   label: 'TSX Canada' },
  { kind: 'index',  symbol: '^AXJO',     label: 'ASX 200' },
  { kind: 'index',  symbol: '^BVSP',     label: 'Bovespa' },
  // Actions blue-chips US
  { kind: 'action', symbol: 'AAPL', label: 'Apple' },
  { kind: 'action', symbol: 'MSFT', label: 'Microsoft' },
  { kind: 'action', symbol: 'GOOGL', label: 'Alphabet' },
  { kind: 'action', symbol: 'AMZN', label: 'Amazon' },
  { kind: 'action', symbol: 'META', label: 'Meta' },
  { kind: 'action', symbol: 'NVDA', label: 'Nvidia' },
  { kind: 'action', symbol: 'TSLA', label: 'Tesla' },
  { kind: 'action', symbol: 'BRK-B', label: 'Berkshire' },
  { kind: 'action', symbol: 'JPM', label: 'JPMorgan' },
  { kind: 'action', symbol: 'V', label: 'Visa' },
  { kind: 'action', symbol: 'MA', label: 'Mastercard' },
  { kind: 'action', symbol: 'WMT', label: 'Walmart' },
  { kind: 'action', symbol: 'PG', label: 'Procter & G.' },
  { kind: 'action', symbol: 'JNJ', label: 'Johnson & J.' },
  { kind: 'action', symbol: 'UNH', label: 'UnitedHealth' },
  { kind: 'action', symbol: 'HD', label: 'Home Depot' },
  { kind: 'action', symbol: 'XOM', label: 'Exxon' },
  { kind: 'action', symbol: 'CVX', label: 'Chevron' },
  { kind: 'action', symbol: 'MRK', label: 'Merck' },
  { kind: 'action', symbol: 'LLY', label: 'Eli Lilly' },
  { kind: 'action', symbol: 'PFE', label: 'Pfizer' },
  { kind: 'action', symbol: 'KO', label: 'Coca-Cola' },
  { kind: 'action', symbol: 'PEP', label: 'Pepsi' },
  { kind: 'action', symbol: 'MCD', label: 'McDonalds' },
  { kind: 'action', symbol: 'NKE', label: 'Nike' },
  { kind: 'action', symbol: 'DIS', label: 'Disney' },
  { kind: 'action', symbol: 'NFLX', label: 'Netflix' },
  { kind: 'action', symbol: 'AMD', label: 'AMD' },
  { kind: 'action', symbol: 'INTC', label: 'Intel' },
  { kind: 'action', symbol: 'CSCO', label: 'Cisco' },
  { kind: 'action', symbol: 'CRM', label: 'Salesforce' },
  { kind: 'action', symbol: 'ADBE', label: 'Adobe' },
  { kind: 'action', symbol: 'IBM', label: 'IBM' },
  { kind: 'action', symbol: 'BAC', label: 'Bank of America' },
  { kind: 'action', symbol: 'C', label: 'Citigroup' },
  { kind: 'action', symbol: 'GS', label: 'Goldman Sachs' },
  // ETF principaux
  { kind: 'action', symbol: 'SPY', label: 'SPY' },
  { kind: 'action', symbol: 'QQQ', label: 'QQQ' },
  { kind: 'action', symbol: 'IWM', label: 'IWM' },
  { kind: 'action', symbol: 'VTI', label: 'VTI' },
  { kind: 'action', symbol: 'EEM', label: 'EEM (Émergents)' },
  { kind: 'action', symbol: 'GLD', label: 'GLD' },
  { kind: 'action', symbol: 'TLT', label: 'TLT (Bonds 20Y)' },
  { kind: 'action', symbol: 'XLK', label: 'XLK (Tech)' },
  { kind: 'action', symbol: 'XLF', label: 'XLF (Finance)' },
  { kind: 'action', symbol: 'XLE', label: 'XLE (Energy)' },
  { kind: 'action', symbol: 'XLV', label: 'XLV (Health)' },
  { kind: 'action', symbol: 'XLY', label: 'XLY' },
  { kind: 'action', symbol: 'XLP', label: 'XLP' },
  { kind: 'action', symbol: 'XLU', label: 'XLU' },
  { kind: 'action', symbol: 'XLI', label: 'XLI' },
  // Actions EU
  { kind: 'action', symbol: 'MC.PA', label: 'LVMH' },
  { kind: 'action', symbol: 'TTE.PA', label: 'TotalEnergies' },
  { kind: 'action', symbol: 'AIR.PA', label: 'Airbus' },
  { kind: 'action', symbol: 'ASML.AS', label: 'ASML' },
  { kind: 'action', symbol: 'SAP.DE', label: 'SAP' },
  { kind: 'action', symbol: 'NESN.SW', label: 'Nestlé' },
  { kind: 'action', symbol: 'ROG.SW', label: 'Roche' },
  // Forex majors
  { kind: 'forex', symbol: 'EURUSD=X', label: 'EUR/USD' },
  { kind: 'forex', symbol: 'GBPUSD=X', label: 'GBP/USD' },
  { kind: 'forex', symbol: 'USDJPY=X', label: 'USD/JPY' },
  { kind: 'forex', symbol: 'USDCHF=X', label: 'USD/CHF' },
  { kind: 'forex', symbol: 'AUDUSD=X', label: 'AUD/USD' },
  { kind: 'forex', symbol: 'USDCAD=X', label: 'USD/CAD' },
  // Métaux & Matières
  { kind: 'metal', symbol: 'GC=F', label: 'Or' },
  { kind: 'metal', symbol: 'SI=F', label: 'Argent' },
  { kind: 'metal', symbol: 'HG=F', label: 'Cuivre' },
  { kind: 'metal', symbol: 'CL=F', label: 'Pétrole WTI' },
  { kind: 'metal', symbol: 'BZ=F', label: 'Brent' },
  { kind: 'metal', symbol: 'NG=F', label: 'Gaz nat.' },
  { kind: 'metal', symbol: 'PL=F', label: 'Platine' },
];

// ─────────────────────────────────────────────────────────────────────
// STRATÉGIES CANDIDATES
//
// Chaque stratégie est une fonction qui retourne {entry,stop,tp1,tp2}
// ou null, à partir de (prices, ind, atrAbs, i, kind).
//
// On teste chaque stratégie × 3 fenêtres de hold : 5j (CT) / 20j (swing) / 60j (LT)
// ─────────────────────────────────────────────────────────────────────

const HOLD_WINDOWS = [
  { id: 'CT',  days: 5,  label: 'Court terme (jour-semaine)' },
  { id: 'SW',  days: 20, label: 'Swing (hebdo)' },
  { id: 'LT',  days: 60, label: 'Long terme (mensuel)' },
];

// Helper : valide les niveaux d'un trade long
function vLong(entry, stop, tp1, tp2, minRR = 1.5) {
  if (stop >= entry || tp1 <= entry || tp2 <= tp1) return null;
  const risk = entry - stop;
  if ((tp2 - entry) / risk < minRR) return null;
  return {
    entry, stop, tp1, tp2,
    rr1: (tp1 - entry) / risk,
    rr2: (tp2 - entry) / risk,
  };
}

const STRATEGIES = [
  // ── 1. RSI bounce dur (survente extrême) ────────────────────
  { id: 's01_rsi_bounce', label: 'RSI survente extrême',
    fn: (p, ind, a, i) => {
      const rsi = ind.rsi?.value;
      if (rsi == null || rsi > 25) return null;
      const ma50 = ind.maCross?.ma50;
      if (!ma50 || p[i] < ma50 * 0.8) return null; // pas trop loin sous MA50
      return vLong(p[i], p[i] - 1.5 * a, p[i] + 2 * a, p[i] + 4 * a);
    } },
  // ── 2. RSI mid + tendance ───────────────────────────────────
  { id: 's02_rsi_mid_trend', label: 'RSI 40-60 + MA bull',
    fn: (p, ind, a, i) => {
      const rsi = ind.rsi?.value;
      const ma20 = ind.ma20?.value;
      const ma50 = ind.maCross?.ma50;
      if (!rsi || !ma20 || !ma50) return null;
      if (rsi < 40 || rsi > 60) return null;
      if (ma20 <= ma50 || p[i] < ma20) return null;
      return vLong(p[i], p[i] - 1.5 * a, p[i] + 2 * a, p[i] + 3.5 * a);
    } },
  // ── 3. MACD cross zero up + RSI confirm ──────────────────────
  { id: 's03_macd_cross_zero', label: 'MACD cross zéro haussier',
    fn: (p, ind, a, i) => {
      const macd = ind.macd?.value;
      const rsi = ind.rsi?.value;
      if (macd == null || macd <= 0 || macd > 1) return null; // tout juste passé positif
      if (!rsi || rsi < 45 || rsi > 65) return null;
      return vLong(p[i], p[i] - 1.5 * a, p[i] + 2 * a, p[i] + 4 * a);
    } },
  // ── 4. Bollinger lower band bounce ──────────────────────────
  { id: 's04_boll_lower', label: 'Bollinger bande basse',
    fn: (p, ind, a, i) => {
      const boll = ind.boll?.value;
      const rsi = ind.rsi?.value;
      if (boll == null || boll > 0.15) return null;
      if (!rsi || rsi > 40) return null;
      return vLong(p[i], p[i] - 1.4 * a, p[i] + 1.5 * a, p[i] + 3 * a);
    } },
  // ── 5. Bollinger breakout up ────────────────────────────────
  { id: 's05_boll_break_up', label: 'Bollinger cassure haute',
    fn: (p, ind, a, i) => {
      const boll = ind.boll?.value;
      const adx = ind.adx?.value || 0;
      if (boll == null || boll < 0.85) return null;
      if (adx < 22) return null;
      return vLong(p[i], p[i] - 2 * a, p[i] + 2 * a, p[i] + 4.5 * a);
    } },
  // ── 6. MA20 / MA50 golden cross fresh ───────────────────────
  { id: 's06_golden_cross', label: 'Golden cross MA20-50',
    fn: (p, ind, a, i, kind, hist) => {
      const ma20 = ind.maCross?.ma20;
      const ma50 = ind.maCross?.ma50;
      if (!ma20 || !ma50 || ma20 <= ma50 || ma20 > ma50 * 1.02) return null;
      const macd = ind.macd?.value;
      if (macd == null || macd <= 0) return null;
      return vLong(p[i], p[i] - 1.8 * a, p[i] + 2.5 * a, p[i] + 5 * a);
    } },
  // ── 7. ADX strong trend follow ──────────────────────────────
  { id: 's07_adx_trend', label: 'ADX strong + tendance',
    fn: (p, ind, a, i) => {
      const adx = ind.adx?.value || 0;
      const ma20 = ind.maCross?.ma20;
      const ma50 = ind.maCross?.ma50;
      if (adx < 28) return null;
      if (!ma20 || !ma50 || ma20 <= ma50 || p[i] < ma20) return null;
      const di = ind.directional;
      if (di && di.plusDI <= di.minusDI) return null;
      return vLong(p[i], p[i] - 1.5 * a, p[i] + 2.5 * a, p[i] + 5 * a);
    } },
  // ── 8. Ichimoku above cloud + MACD ──────────────────────────
  { id: 's08_ichimoku', label: 'Ichimoku above cloud',
    fn: (p, ind, a, i) => {
      const ichi = ind.ichimoku;
      const macd = ind.macd?.value;
      if (!ichi || ichi.position !== 'above-cloud' || ichi.signal !== 'bull') return null;
      if (macd == null || macd <= 0) return null;
      const rsi = ind.rsi?.value;
      if (!rsi || rsi < 45 || rsi > 70) return null;
      return vLong(p[i], p[i] - 1.5 * a, p[i] + 2.5 * a, p[i] + 5 * a);
    } },
  // ── 9. Pullback MA50 dans tendance ──────────────────────────
  { id: 's09_pullback_ma50', label: 'Pullback MA50',
    fn: (p, ind, a, i) => {
      const ma20 = ind.maCross?.ma20;
      const ma50 = ind.maCross?.ma50;
      const rsi = ind.rsi?.value;
      if (!ma20 || !ma50 || ma20 <= ma50) return null;
      if (p[i] > ma50 * 1.015 || p[i] < ma50 * 0.985) return null;
      if (!rsi || rsi < 40 || rsi > 55) return null;
      return vLong(p[i], Math.min(p[i] - 1.5 * a, ma50 * 0.97), p[i] + 1.5 * a, p[i] + 3 * a);
    } },
  // ── 10. 20-day high breakout (Donchian) ─────────────────────
  { id: 's10_breakout_20d', label: 'Breakout 20j',
    fn: (p, ind, a, i) => {
      if (i < 21) return null;
      let max20 = -Infinity;
      for (let k = i - 20; k < i; k++) if (p[k] > max20) max20 = p[k];
      if (p[i] <= max20 * 1.002) return null; // cassure du high 20j
      const adx = ind.adx?.value || 0;
      if (adx < 20) return null;
      return vLong(p[i], p[i] - 2 * a, p[i] + 2 * a, p[i] + 4 * a);
    } },
  // ── 11. VWAP retest ─────────────────────────────────────────
  { id: 's11_vwap_retest', label: 'VWAP retest',
    fn: (p, ind, a, i) => {
      const vw = ind.vwap;
      const rsi = ind.rsi?.value;
      if (!vw || vw.distancePct < -2 || vw.distancePct > 0.5) return null;
      if (!rsi || rsi < 40 || rsi > 60) return null;
      const ma50 = ind.maCross?.ma50;
      if (!ma50 || p[i] < ma50) return null;
      return vLong(p[i], p[i] - 1.4 * a, p[i] + 2 * a, p[i] + 3.5 * a);
    } },
  // ── 12. Hull MA cross + RSI ─────────────────────────────────
  { id: 's12_hull_cross', label: 'Hull MA cross',
    fn: (p, ind, a, i) => {
      const hma = ind.hullMA?.value;
      const rsi = ind.rsi?.value;
      if (!hma || p[i] < hma * 1.002) return null;
      if (i < 4 || p[i] <= p[i - 3]) return null; // slope up
      if (!rsi || rsi < 30 || rsi > 65) return null;
      return vLong(p[i], p[i] - 1.8 * a, p[i] + 2 * a, p[i] + 4 * a);
    } },
  // ── 13. RSI Divergence bullish ──────────────────────────────
  { id: 's13_rsi_div', label: 'RSI divergence haussière',
    fn: (p, ind, a, i) => {
      const div = ind.rsiDivergence;
      if (!div || div.type !== 'bullish' || div.strength < 0.3) return null;
      const ma50 = ind.maCross?.ma50;
      if (!ma50 || p[i] < ma50 * 0.85) return null;
      return vLong(p[i], p[i] - 2 * a, p[i] + 2.5 * a, p[i] + 5 * a);
    } },
  // ── 14. MFI capitulation + Hull ─────────────────────────────
  { id: 's14_mfi_capit', label: 'MFI capitulation',
    fn: (p, ind, a, i) => {
      const mfi = ind.mfi?.value;
      const rsi = ind.rsi?.value;
      const hma = ind.hullMA?.value;
      if (mfi == null || mfi > 22) return null;
      if (!rsi || rsi > 40) return null;
      if (!hma || p[i] < hma * 0.97) return null;
      return vLong(p[i], p[i] - 2.2 * a, p[i] + 2 * a, p[i] + 5 * a);
    } },
  // ── 15. Triple MA alignment (7>20>50) ───────────────────────
  { id: 's15_triple_ma', label: 'Triple MA alignment',
    fn: (p, ind, a, i) => {
      const ma20 = ind.maCross?.ma20;
      const ma50 = ind.maCross?.ma50;
      if (!ma20 || !ma50 || ma20 <= ma50) return null;
      // MA7 approximé
      if (i < 7) return null;
      const ma7 = (p[i] + p[i-1] + p[i-2] + p[i-3] + p[i-4] + p[i-5] + p[i-6]) / 7;
      if (ma7 <= ma20) return null;
      if (p[i] < ma7) return null;
      const rsi = ind.rsi?.value;
      if (!rsi || rsi < 50 || rsi > 70) return null;
      return vLong(p[i], p[i] - 1.5 * a, p[i] + 2 * a, p[i] + 4 * a);
    } },
  // ── 16. ATR contraction breakout ────────────────────────────
  { id: 's16_atr_squeeze', label: 'ATR squeeze + breakout',
    fn: (p, ind, a, i) => {
      const atr = ind.atr?.value;
      if (!atr || atr > 2.5) return null; // volatilité basse
      const boll = ind.boll?.value;
      if (boll == null || boll < 0.7) return null;
      const adx = ind.adx?.value || 0;
      if (adx < 18) return null;
      return vLong(p[i], p[i] - 2 * a, p[i] + 2.5 * a, p[i] + 5 * a);
    } },
  // ── 17. Inside day breakout ─────────────────────────────────
  { id: 's17_inside_day', label: 'Inside day + breakout',
    fn: (p, ind, a, i) => {
      if (i < 3) return null;
      const c0 = p[i], c1 = p[i-1], c2 = p[i-2];
      // inside day approxim : c1 entre c2 et c0
      if (!(Math.min(c0, c2) < c1 && c1 < Math.max(c0, c2))) return null;
      if (c0 <= c2) return null; // breakout up
      const ma20 = ind.maCross?.ma20;
      if (!ma20 || c0 < ma20) return null;
      return vLong(c0, c0 - 1.8 * a, c0 + 2 * a, c0 + 4 * a);
    } },
  // ── 18. Mean reversion to MA20 ──────────────────────────────
  { id: 's18_mean_rev_ma20', label: 'Mean reversion MA20',
    fn: (p, ind, a, i) => {
      const ma20 = ind.maCross?.ma20;
      if (!ma20) return null;
      const distance = (p[i] - ma20) / ma20;
      if (distance > -0.06 || distance < -0.15) return null; // entre -6% et -15% de MA20
      const rsi = ind.rsi?.value;
      if (!rsi || rsi > 35) return null;
      const ma50 = ind.maCross?.ma50;
      if (!ma50 || ma20 <= ma50) return null; // tendance préservée
      return vLong(p[i], p[i] - 1.5 * a, Math.min(ma20, p[i] + 2 * a), p[i] + 3.5 * a);
    } },
  // ── 19. Volatility expansion entry ──────────────────────────
  { id: 's19_volatility_exp', label: 'Expansion volatilité',
    fn: (p, ind, a, i) => {
      const atr = ind.atr?.value;
      if (!atr || atr < 3) return null;
      if (i < 4) return null;
      const ret3 = (p[i] - p[i - 3]) / p[i - 3];
      if (ret3 < 0.03) return null; // explosion haussière 3j
      const adx = ind.adx?.value || 0;
      if (adx < 25) return null;
      return vLong(p[i], p[i] - 2.5 * a, p[i] + 2.5 * a, p[i] + 5 * a);
    } },
  // ── 20. Bollinger pos + MACD acceleration ───────────────────
  { id: 's20_boll_pos_macd', label: 'Bollinger pos + MACD',
    fn: (p, ind, a, i) => {
      const boll = ind.boll?.value;
      const macd = ind.macd?.value;
      if (boll == null || boll < 0.5 || boll > 0.75) return null;
      if (macd == null || macd <= 0.5) return null;
      const ma50 = ind.maCross?.ma50;
      if (!ma50 || p[i] < ma50) return null;
      return vLong(p[i], p[i] - 1.5 * a, p[i] + 2 * a, p[i] + 4 * a);
    } },
];

// ─────────────────────────────────────────────────────────────────────
// Backtest core
// ─────────────────────────────────────────────────────────────────────
function resolveTrade(prices, t, trade, holdDays) {
  const { entry, stop, tp1, tp2, rr1, rr2 } = trade;
  let touchedTp1 = false;
  const endIdx = Math.min(t + holdDays, prices.length - 1);
  for (let i = t + 1; i <= endIdx; i++) {
    const c = prices[i];
    if (c <= stop) {
      if (touchedTp1) return { outcome: 'PARTIAL_THEN_STOP', pnl: rr1 / 2 };
      return { outcome: 'LOSS', pnl: -1 };
    }
    if (!touchedTp1 && c >= tp1) touchedTp1 = true;
    if (c >= tp2) return { outcome: 'FULL_WIN', pnl: rr2 };
  }
  const exitClose = prices[endIdx];
  const pnl = (exitClose - entry) / (entry - stop);
  if (touchedTp1) return { outcome: 'PARTIAL_TIMEOUT', pnl: Math.max(rr1 / 2, pnl / 2) };
  return { outcome: 'TIMEOUT', pnl };
}

async function fetchAsset(a) {
  try {
    if (a.kind === 'crypto') {
      const d = await fetchCoinGeckoHistorical(a.id, 700);
      return { ...a, prices: d.prices, volumes: d.volumes };
    }
    const d = await fetchYahooHistorical(a.symbol, HISTORY_RANGE);
    return { ...a, prices: d.prices, volumes: d.volumes };
  } catch (e) {
    return null;
  }
}

// v2.83 — Process ASSET-BY-ASSET avec accumulator. Évite de stocker en RAM
// le précompute de TOUS les actifs en même temps (qui dépassait 4GB et
// crashait V8). Pour chaque asset on précompute, on lance toutes les
// (strategy × hold) en réutilisant le cache, puis on libère.
function processAssetAllCombos(asset, accumulator) {
  const { prices, volumes } = asset;
  if (!prices || prices.length < WARMUP + MAX_LOOK_AHEAD + 5) return;

  // Précompute les indicators à chaque bar UNE FOIS pour cet actif.
  // Pour économiser la RAM, on ne stocke que ce dont les stratégies ont besoin
  // (pas le subset complet — les stratégies l'utilisent via prices passés).
  const N = prices.length;
  const indCache = new Array(N).fill(null);
  const atrCache = new Array(N).fill(0);
  for (let t = WARMUP; t < N - 1; t++) {
    const subset = prices.slice(0, t + 1);
    const subVol = volumes ? volumes.slice(0, t + 1) : null;
    const ind = computeAllIndicators(subset, subVol);
    if (!ind) continue;
    const atrPctVal = atrPct(subset);
    if (!atrPctVal) continue;
    const last = subset[subset.length - 1];
    indCache[t] = ind;
    atrCache[t] = (atrPctVal / 100) * last;
  }

  // Pour chaque (strategy × hold), accumulate les trades
  for (const strat of STRATEGIES) {
    for (const hold of HOLD_WINDOWS) {
      const key = strat.id + '|' + hold.id;
      if (!accumulator[key]) accumulator[key] = [];
      for (let t = WARMUP; t < N - hold.days - 1; t++) {
        const ind = indCache[t];
        if (!ind) continue;
        const sig = strat.fn(prices, ind, atrCache[t], t, asset.kind);
        if (!sig) continue;
        const res = resolveTrade(prices, t, sig, hold.days);
        accumulator[key].push({
          asset: asset.label, kind: asset.kind,
          rr1: Number(sig.rr1.toFixed(2)),
          rr2: Number(sig.rr2.toFixed(2)),
          outcome: res.outcome,
          pnl: Number(res.pnl.toFixed(2)),
        });
      }
    }
  }
  // indCache et atrCache sont libérés à la sortie de fonction
}

function statsFor(trades) {
  if (trades.length === 0) {
    return { num_trades: 0, win_rate: 0, profit_factor: 0,
             expectancy: 0, total_pnl: 0, avg_rr_realized: 0 };
  }
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const winRate = wins.length / trades.length;
  const sumWin = wins.reduce((s, t) => s + t.pnl, 0);
  const sumLossAbs = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = sumLossAbs > 0 ? sumWin / sumLossAbs : (sumWin > 0 ? 99 : 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? sumWin / wins.length : 0;
  const avgLoss = losses.length ? sumLossAbs / losses.length : 0;
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;
  const avgRr = trades.reduce((s, t) => s + t.rr2, 0) / trades.length;
  return {
    num_trades: trades.length, num_wins: wins.length, num_losses: losses.length,
    win_rate: Number((winRate * 100).toFixed(1)),
    profit_factor: Number(profitFactor.toFixed(2)),
    expectancy: Number(expectancy.toFixed(3)),
    total_pnl: Number(totalPnl.toFixed(1)),
    avg_win: Number(avgWin.toFixed(2)),
    avg_loss: Number(avgLoss.toFixed(2)),
    avg_rr_realized: Number(avgRr.toFixed(2)),
  };
}

function classifyProfile(stats) {
  // PROFIL CONSERVATEUR  : win rate ≥ 55% ET PF ≥ 1.8
  // PROFIL ÉQUILIBRÉ    : win 48-55%, PF ≥ 1.8
  // PROFIL AGRESSIF      : avg R/R réalisé ≥ 2.5 ET expectancy > 0.4
  if (stats.num_trades < MIN_TRADES_FOR_VALID) return 'INVALID';
  if (stats.profit_factor < 1.2) return 'WEAK';
  if (stats.avg_rr_realized >= 2.5 && stats.expectancy > 0.4) return 'AGRESSIF';
  if (stats.win_rate >= 55 && stats.profit_factor >= 1.8) return 'CONSERVATEUR';
  if (stats.win_rate >= 48 && stats.profit_factor >= 1.8) return 'ÉQUILIBRÉ';
  return 'WEAK';
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[tournament] ${TRAD_ASSETS.length} actifs traditionnels, ${STRATEGIES.length} stratégies × ${HOLD_WINDOWS.length} fenêtres = ${STRATEGIES.length * HOLD_WINDOWS.length} combos`);
  console.log(`[tournament] Historique: ${HISTORY_RANGE}, fenêtres hold: ${HOLD_WINDOWS.map(h => h.days + 'j').join(' / ')}`);

  // Fetch séquentiel
  console.log('[tournament] Fetching assets...');
  const assets = [];
  for (const a of TRAD_ASSETS) {
    const r = await fetchAsset(a);
    if (r) assets.push(r);
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`\n[tournament] ${assets.length}/${TRAD_ASSETS.length} actifs OK`);

  // v2.83 — Process asset-by-asset avec accumulator (mémoire bornée)
  console.log(`[tournament] Running ${STRATEGIES.length} × ${HOLD_WINDOWS.length} = ${STRATEGIES.length * HOLD_WINDOWS.length} combos on ${assets.length} actifs...`);
  const accumulator = {}; // key "stratId|holdId" → array of trades
  const tStart = Date.now();
  let assetIdx = 0;
  for (const a of assets) {
    assetIdx++;
    const tA = Date.now();
    processAssetAllCombos(a, accumulator);
    const dt = ((Date.now() - tA) / 1000).toFixed(1);
    const tot = ((Date.now() - tStart) / 1000).toFixed(1);
    console.log(`  [${assetIdx}/${assets.length}] ${a.label.padEnd(20)} done in ${dt}s (total ${tot}s, ${a.prices.length} bars)`);
    // Hint au GC : libère subsets temporaires si possible
    if (global.gc && assetIdx % 10 === 0) global.gc();
  }

  // Aggrège chaque combo
  const results = [];
  for (const strat of STRATEGIES) {
    for (const hold of HOLD_WINDOWS) {
      const key = strat.id + '|' + hold.id;
      const allTrades = accumulator[key] || [];
      const stats = statsFor(allTrades);
      const profile = classifyProfile(stats);
      const byKind = {};
      for (const k of ['index','action','forex','metal']) {
        const tk = allTrades.filter(t => t.kind === k);
        if (tk.length > 0) byKind[k] = statsFor(tk);
      }
      results.push({
        strategy_id: strat.id, strategy_label: strat.label,
        hold_id: hold.id, hold_days: hold.days, hold_label: hold.label,
        profile, ...stats, byKind,
      });
      console.log(`  ${strat.id} × ${hold.id} (${hold.days}j) — ${stats.num_trades}t · win ${stats.win_rate}% · PF ${stats.profit_factor} · exp ${stats.expectancy} → ${profile}`);
    }
  }

  // Tri par profil
  const sorted = {
    CONSERVATEUR: [],
    'ÉQUILIBRÉ': [],
    AGRESSIF: [],
    WEAK: [],
    INVALID: [],
  };
  for (const r of results) {
    if (!sorted[r.profile]) sorted[r.profile] = [];
    sorted[r.profile].push(r);
  }
  // Sort par expectancy au sein de chaque profil
  for (const k of Object.keys(sorted)) {
    sorted[k].sort((a, b) => b.expectancy - a.expectancy);
  }

  console.log('\n\n═══════════════════════════════════════════════════════════');
  console.log('TOP STRATÉGIES PAR PROFIL');
  console.log('═══════════════════════════════════════════════════════════');
  for (const profile of ['CONSERVATEUR', 'ÉQUILIBRÉ', 'AGRESSIF']) {
    console.log(`\n▸ ${profile} :`);
    const top5 = sorted[profile].slice(0, 5);
    if (top5.length === 0) {
      console.log('  (aucune stratégie ne match)');
    } else {
      for (const c of top5) {
        console.log(`  • ${c.strategy_id} × ${c.hold_id} : ${c.num_trades}t · win ${c.win_rate}% · PF ${c.profit_factor} · exp ${c.expectancy}R · R/R ${c.avg_rr_realized}`);
      }
    }
  }

  const out = {
    generated: new Date().toISOString(),
    history_range: HISTORY_RANGE,
    num_assets: assets.length,
    assets_tested: assets.map(a => a.label),
    num_strategies: STRATEGIES.length,
    hold_windows: HOLD_WINDOWS,
    min_trades_for_valid: MIN_TRADES_FOR_VALID,
    methodology: {
      description: 'Pour chaque combinaison (stratégie × fenêtre de hold), on backteste sur tous les actifs sur 10 ans. Les trades sont classés WIN/LOSS/PARTIAL/TIMEOUT et agrégés. Chaque combo est ensuite classé en CONSERVATEUR (win>55%, PF>1.8), ÉQUILIBRÉ (win 48-55%, PF>1.8) ou AGRESSIF (R/R réalisé ≥ 2.5, expectancy>0.4).',
      caveats: [
        'Closes uniquement (pas de high/low intraday)',
        'Pas de slippage/frais simulés',
        'Pas de trailing stop',
        'Le label de profil est un GUIDE, pas un dogme — toutes les stratégies > PF 1.2 sont rentables',
      ],
    },
    all_combos: results.sort((a, b) => b.expectancy - a.expectancy),
    top_by_profile: {
      CONSERVATEUR: sorted.CONSERVATEUR.slice(0, 10),
      'ÉQUILIBRÉ': sorted['ÉQUILIBRÉ'].slice(0, 10),
      AGRESSIF: sorted.AGRESSIF.slice(0, 10),
    },
  };
  const target = path.join(process.cwd(), OUTPUT_FILE);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`\n[tournament] Wrote ${target}`);
}

main().catch(e => {
  console.error('[tournament] FAILED:', e);
  process.exit(1);
});
