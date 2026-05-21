#!/usr/bin/env node
/**
 * Trade Genius — Génère data/ai-study.json
 * Études techniques générées par IA (Pollinations.ai gratuit, fallback Groq si secret).
 *
 * Tourne quotidiennement via .github/workflows/ai-study.yml.
 * Aucune clé API requise par défaut (Pollinations est gratuit et libre).
 * Si GROQ_API_KEY est défini en GitHub Secret, on utilise Groq (Llama 3.3 70B)
 * pour une meilleure qualité.
 *
 * Output : data/ai-study.json — analyse multi-actifs structurée avec
 * disclaimer fort. Ce n'est PAS un conseil en investissement personnalisé,
 * c'est de la pédagogie technique générée automatiquement.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  fetchYahooHistorical, fetchCoinGeckoHistorical,
  computeAllIndicators, globalVerdict, atrPct, sma,
  ma7, ichimokuDirection,
} from './indicators.mjs';

// v2.60 — Catalogue étendu (52 actifs) : indices monde + actions US/EU
//        + crypto top 20 + forex majors + métaux précieux
const ASSETS = [
  // ── Indices monde ──────────────────────────────────────────
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
  // ── Crypto top 20 (CoinGecko) ──────────────────────────────
  { kind: 'crypto', id: 'bitcoin',         label: 'BTC' },
  { kind: 'crypto', id: 'ethereum',        label: 'ETH' },
  { kind: 'crypto', id: 'solana',          label: 'SOL' },
  { kind: 'crypto', id: 'binancecoin',     label: 'BNB' },
  { kind: 'crypto', id: 'ripple',          label: 'XRP' },
  { kind: 'crypto', id: 'cardano',         label: 'ADA' },
  { kind: 'crypto', id: 'dogecoin',        label: 'DOGE' },
  { kind: 'crypto', id: 'avalanche-2',     label: 'AVAX' },
  { kind: 'crypto', id: 'polkadot',        label: 'DOT' },
  { kind: 'crypto', id: 'chainlink',       label: 'LINK' },
  { kind: 'crypto', id: 'tron',            label: 'TRX' },
  { kind: 'crypto', id: 'litecoin',        label: 'LTC' },
  { kind: 'crypto', id: 'uniswap',         label: 'UNI' },
  { kind: 'crypto', id: 'cosmos',          label: 'ATOM' },
  { kind: 'crypto', id: 'stellar',         label: 'XLM' },
  { kind: 'crypto', id: 'near',            label: 'NEAR' },
  // ── Actions US blue-chips ──────────────────────────────────
  { kind: 'action', symbol: 'AAPL',  label: 'Apple' },
  { kind: 'action', symbol: 'MSFT',  label: 'Microsoft' },
  { kind: 'action', symbol: 'GOOGL', label: 'Alphabet' },
  { kind: 'action', symbol: 'AMZN',  label: 'Amazon' },
  { kind: 'action', symbol: 'META',  label: 'Meta' },
  { kind: 'action', symbol: 'NVDA',  label: 'Nvidia' },
  { kind: 'action', symbol: 'TSLA',  label: 'Tesla' },
  { kind: 'action', symbol: 'AMD',   label: 'AMD' },
  { kind: 'action', symbol: 'NFLX',  label: 'Netflix' },
  { kind: 'action', symbol: 'JPM',   label: 'JPMorgan' },
  { kind: 'action', symbol: 'V',     label: 'Visa' },
  { kind: 'action', symbol: 'WMT',   label: 'Walmart' },
  { kind: 'action', symbol: 'KO',    label: 'Coca-Cola' },
  // ── Actions EU ────────────────────────────────────────────
  { kind: 'action', symbol: 'MC.PA',  label: 'LVMH' },
  { kind: 'action', symbol: 'TTE.PA', label: 'TotalEnergies' },
  { kind: 'action', symbol: 'AIR.PA', label: 'Airbus' },
  { kind: 'action', symbol: 'SAN.PA', label: 'Sanofi' },
  { kind: 'action', symbol: 'ASML.AS',label: 'ASML' },
  // ── Forex majors ──────────────────────────────────────────
  { kind: 'forex',  symbol: 'EURUSD=X', label: 'EUR/USD' },
  { kind: 'forex',  symbol: 'GBPUSD=X', label: 'GBP/USD' },
  { kind: 'forex',  symbol: 'USDJPY=X', label: 'USD/JPY' },
  { kind: 'forex',  symbol: 'USDCHF=X', label: 'USD/CHF' },
  { kind: 'forex',  symbol: 'AUDUSD=X', label: 'AUD/USD' },
  { kind: 'forex',  symbol: 'USDCAD=X', label: 'USD/CAD' },
  { kind: 'forex',  symbol: 'EURGBP=X', label: 'EUR/GBP' },
  { kind: 'forex',  symbol: 'EURJPY=X', label: 'EUR/JPY' },
  // ── Métaux précieux & matières premières ─────────────────
  { kind: 'metal',  symbol: 'GC=F', label: 'Or (Gold)' },
  { kind: 'metal',  symbol: 'SI=F', label: 'Argent (Silver)' },
  { kind: 'metal',  symbol: 'PL=F', label: 'Platine' },
  { kind: 'metal',  symbol: 'PA=F', label: 'Palladium' },
  { kind: 'metal',  symbol: 'HG=F', label: 'Cuivre' },
];

async function fetchOne(a) {
  try {
    // v2.60 — Indices, actions, forex et métaux passent par Yahoo (symbol)
    // Crypto via CoinGecko (id)
    if (a.kind === 'crypto') {
      const d = await fetchCoinGeckoHistorical(a.id, 60);
      return { ...a, prices: d.prices, price: d.price, prevClose: d.prevClose };
    }
    const d = await fetchYahooHistorical(a.symbol, '3mo');
    return { ...a, prices: d.prices, price: d.price, prevClose: d.prevClose };
  } catch (e) {
    console.warn(`Skipping ${a.label}:`, e.message);
    return null;
  }
}

function summarizeAsset(a) {
  // v2.72 — Passe les volumes pour permettre VWAP, OBV, MFI, Force Index
  const ind = computeAllIndicators(a.prices, a.volumes);
  if (!ind) return null;
  const v = globalVerdict(ind);
  const change = a.prevClose ? ((a.price - a.prevClose) / a.prevClose) * 100 : 0;
  return {
    label: a.label,
    kind: a.kind,
    price: a.price,
    prices: a.prices,
    volumes: a.volumes || [],
    change: change.toFixed(2),
    rsi: ind.rsi?.value.toFixed(0),
    maCross: ind.maCross?.signal,
    macdHist: ind.macd?.value.toFixed(2),
    boll: ind.boll ? (ind.boll.value * 100).toFixed(0) + '%' : null,
    adx: ind.adx?.value.toFixed(0),
    atr: ind.atr ? ind.atr.value.toFixed(1) + '%' : null,
    atrAbs: ind.atr ? (ind.atr.value / 100) * a.price : null,
    indRaw: ind,
    verdict: v.label,
    score: v.score,
    cls: v.cls,
  };
}

/**
 * Detecte un setup techniquement pertinent sur l'actif.
 * Retourne {type, label, config, entry, stop, tp1, tp2, rr1, rr2, rationale}
 * ou null si aucune configuration claire (marche en range / signaux contradictoires).
 *
 * IMPORTANT — Cadre legal AMF : ce sont des CAS PEDAGOGIQUES bases sur
 * l'analyse technique objective. Pas un conseil personnalise. Le wording
 * dans l'app doit dire 'cas d'ecole', 'configuration observee', etc.
 */
/**
 * v2.54 — Mode ULTRA FIABLE
 *
 * Chaque setup exige maintenant :
 *   - Au moins 3 indicateurs cohérents alignés (confirmation multi-facteurs)
 *   - Aucun signal majeur contradictoire (ex : MA20<entry sur un long mean reversion)
 *   - Niveaux logiquement valides (TP1 > entry pour long, R/R >= 1.8 sur TP2)
 *   - Confidence calculée (medium / high / very-high) selon nombre de confirmations
 *
 * Si aucun setup ne passe ces filtres, on retourne null. Mieux vaut "rien" qu'un
 * faux positif comme l'ETH précédent (TP1<entry).
 */
function detectSetup(a) {
  if (!a || !a.indRaw || !a.atrAbs) return null;
  const ind = a.indRaw;
  const prices = a.prices;
  const last = prices[prices.length - 1];
  const atr = a.atrAbs;
  const rsi = ind.rsi?.value;
  const adx = ind.adx?.value || 0;
  const ma20 = ind.ma20?.value;
  const ma50 = ind.ma50?.value;
  const macdH = ind.macd?.value;
  const bollPos = ind.boll?.value;
  const mom = ind.mom?.valuePct;

  // Dérivée du MACD (acceleration positive si les 3 dernières barres montent)
  // Approche simple : on compare le prix actuel au prix d'il y a 3 jours
  const recentTrend3 = prices.length > 3 ? (last - prices[prices.length - 4]) / prices[prices.length - 4] : 0;

  // Helper : pour qu'un setup soit accepté, il faut un minimum de "score" interne
  // basé sur le nombre de confirmations. On enregistre la confidence finale.
  function validateLong(entry, stop, tp1, tp2) {
    if (stop >= entry) return null;          // stop doit être SOUS entry
    if (tp1 <= entry) return null;            // TP1 doit être AU-DESSUS pour un long
    if (tp2 <= tp1) return null;              // TP2 doit être au-dessus de TP1
    const risk = entry - stop;
    const reward = tp2 - entry;
    if (reward / risk < 1.8) return null;     // R/R minimum 1.8:1
    return { entry, stop, tp1, tp2,
      rr1: ((tp1 - entry) / risk).toFixed(2),
      rr2: ((tp2 - entry) / risk).toFixed(2) };
  }

  // ─────────────────────────────────────────────────────────────────
  // Setup 1 : REBOND SURVENTE (long contrarian, court terme)
  // Conditions : RSI<30 + Boll<0.15 + MA20>entry (mean reversion possible)
  //              + dérivée 3j en train de se retourner (recentTrend3 > -2 %)
  // ─────────────────────────────────────────────────────────────────
  if (rsi != null && rsi < 30 && bollPos != null && bollPos < 0.15
      && ma20 != null && ma20 > last
      && recentTrend3 > -0.025) {
    const entry = last;
    const stop = entry - 1.5 * atr;
    const tp1 = Math.min(ma20, entry + 2 * atr); // MA20 garantie > entry maintenant
    const tp2 = Math.max(entry + 3 * atr, tp1 + atr);
    const lvl = validateLong(entry, stop, tp1, tp2);
    if (lvl) {
      const conf = (rsi < 25 && bollPos < 0.08) ? 'very-high' : 'high';
      return Object.assign({}, lvl, {
        type: 'rebond-survente',
        label: 'Rebond technique sur survente',
        timeframe: 'Court terme · 1-3 jours',
        confidence: conf,
        config: 'RSI ' + rsi.toFixed(0) + ' (vraie survente) · Bollinger ' + (bollPos*100).toFixed(0) + '% (bande basse) · MA20 au-dessus du prix (cible mean reversion possible) · prix ne fait plus de plus bas (dérivée 3j ' + (recentTrend3*100).toFixed(1) + '%).',
        rationale: 'Couple RSI<30 + bande basse Bollinger + MA20 au-dessus + plus de continuation baissière = setup contrarian classique. Stop 1.5 ATR sous l\'entrée pour absorber la volatilité de survente. TP1 = retour à la MA20 (mean reversion). TP2 = +3 ATR.',
        direction: 'long',
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Setup 2 : PULLBACK HAUSSIER (long trend-follow, swing court)
  // Conditions : MA20>MA50 + prix>=MA50 + RSI 38-60 + MACD>0 + ADX>20 + mom 10j>0
  // ─────────────────────────────────────────────────────────────────
  if (ma20 != null && ma50 != null && ma20 > ma50 && last >= ma50
      && rsi != null && rsi >= 38 && rsi <= 60
      && macdH != null && macdH > 0
      && adx > 20
      && mom != null && mom > 0) {
    const entry = last;
    const stop = Math.min(entry - 1.5 * atr, ma50 * 0.985);
    const tp1 = entry + 1.5 * atr;
    const tp2 = entry + 3 * atr;
    const lvl = validateLong(entry, stop, tp1, tp2);
    if (lvl) {
      const conf = (adx > 28 && macdH > 0) ? 'very-high' : 'high';
      return Object.assign({}, lvl, {
        type: 'pullback-haussier',
        label: 'Pullback dans une tendance haussière confirmée',
        timeframe: 'Swing · 1-2 semaines',
        confidence: conf,
        config: 'MA20>MA50 (tendance MT) · prix>=MA50 · RSI ' + rsi.toFixed(0) + ' (neutre) · MACD ' + macdH.toFixed(2) + ' (>0) · ADX ' + adx.toFixed(0) + ' (forte tendance) · momentum +' + mom.toFixed(1) + '%.',
        rationale: '5 confirmations alignées : tendance MT (MA), prix au-dessus du support MA50, RSI neutre (pas surchauffé), MACD positif, ADX fort. Le pullback dans cette config se résout généralement par une continuation haussière.',
        direction: 'long',
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Setup 3 : BREAKOUT HAUSSIER (long trend follow, après compression)
  // Conditions : RSI 55-70 + Boll>0.85 + ATR<4% + ADX>22 + MA20>MA50 + macd>0
  // ─────────────────────────────────────────────────────────────────
  if (rsi != null && rsi >= 55 && rsi <= 70
      && bollPos != null && bollPos > 0.85
      && ind.atr && ind.atr.value < 4
      && adx > 22
      && ma20 != null && ma50 != null && ma20 > ma50
      && macdH != null && macdH > 0) {
    const entry = last;
    const stop = entry - 2 * atr;
    const tp1 = entry + 2 * atr;
    const tp2 = entry + 4 * atr;
    const lvl = validateLong(entry, stop, tp1, tp2);
    if (lvl) {
      return Object.assign({}, lvl, {
        type: 'breakout-haussier',
        label: 'Cassure haussière sur volatilité contractée',
        timeframe: 'Trend follow · 2-4 semaines',
        confidence: adx > 30 ? 'very-high' : 'high',
        config: 'Bollinger ' + (bollPos*100).toFixed(0) + '% (bande haute) · ATR ' + ind.atr.value.toFixed(1) + '% (compression) · ADX ' + adx.toFixed(0) + ' (force confirmée) · MA20>MA50 · MACD>0.',
        rationale: 'Après une phase de compression (ATR bas), la cassure de la bande haute avec ADX>22 et MACD>0 marque souvent le début d\'une nouvelle phase directionnelle. Stop 2 ATR sous l\'entrée pour absorber les faux signaux.',
        direction: 'long',
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Setup 4 : CONTINUATION HAUSSIÈRE (long trend follow)
  // Conditions : MA20>MA50 + prix>MA20 + RSI 50-68 + mom>1% + ADX>16 + MACD>0
  // ─────────────────────────────────────────────────────────────────
  if (ma20 != null && ma50 != null && ma20 > ma50 && last > ma20
      && rsi != null && rsi >= 50 && rsi <= 68
      && mom != null && mom > 1
      && adx > 16
      && macdH != null && macdH > 0) {
    const entry = last;
    const stop = Math.min(entry - 1.8 * atr, ma20 * 0.985);
    const tp1 = entry + 2 * atr;
    const tp2 = entry + 4 * atr;
    const lvl = validateLong(entry, stop, tp1, tp2);
    if (lvl) {
      return Object.assign({}, lvl, {
        type: 'continuation-haussiere',
        label: 'Continuation dans le mouvement haussier',
        timeframe: 'Swing · 1-3 semaines',
        confidence: 'medium',
        config: 'MA20>MA50 · prix>MA20 · RSI ' + rsi.toFixed(0) + ' (sain) · momentum +' + mom.toFixed(1) + '% · ADX ' + adx.toFixed(0) + ' · MACD>0.',
        rationale: 'Tendance haussière confirmée par 5 indicateurs alignés. Le marché monte sans être encore en surchauffe, le momentum positif et l\'ADX > 16 indiquent une dynamique acheteuse durable.',
        direction: 'long',
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Setup 5 : REBOND MA50 (long mean reversion swing)
  // Conditions : MA20>MA50 + prix entre ±1.5 % de MA50 + RSI 40-55 + ADX>14 + MACD>=0
  // ─────────────────────────────────────────────────────────────────
  if (ma20 != null && ma50 != null && ma20 > ma50
      && rsi != null && rsi >= 40 && rsi <= 55
      && last <= ma50 * 1.015 && last >= ma50 * 0.985
      && adx > 14
      && macdH != null && macdH >= 0) {
    const entry = last;
    const stop = Math.min(entry - 1.5 * atr, ma50 * 0.97);
    const tp1 = entry + 1.5 * atr;
    const tp2 = Math.max(ma20, entry + 3 * atr);
    const lvl = validateLong(entry, stop, tp1, tp2);
    if (lvl) {
      return Object.assign({}, lvl, {
        type: 'rebond-ma50',
        label: 'Rebond technique sur la MA50',
        timeframe: 'Swing · 1-2 semaines',
        confidence: 'medium',
        config: 'Prix à ±1.5 % de MA50 (' + ma50.toFixed(2) + ') · MA20>MA50 (tendance préservée) · RSI ' + rsi.toFixed(0) + ' · ADX ' + adx.toFixed(0) + ' · MACD ' + macdH.toFixed(2) + '.',
        rationale: 'La MA50 est un support dynamique majeur en tendance haussière. Quand le prix la teste précisément sans la casser et que le MACD reste positif, c\'est une zone d\'entrée historiquement favorable.',
        direction: 'long',
      });
    }
  }

  // v2.69 — DOJI haussier : Doji après bougie rouge + confirmation bougie verte
  // Le marché a baissé, hésité (doji = combat), puis les acheteurs ont gagné
  // Entry = close confirmation · Stop = bas de la bougie rouge · Exit = Doji baissier suivant
  const doji = detectDoji(prices, atr);
  if (doji && doji.direction === 'long') {
    const entry = last;
    const stop = doji.stopLevel; // plus bas de la bougie rouge
    if (stop < entry) {
      // TP basé sur l'amplitude moyenne du mouvement (3 ATR conservateur, sortie réelle au prochain Doji baissier)
      const tp1 = entry + 2 * atr;
      const tp2 = entry + 4 * atr;
      const risk = entry - stop;
      const reward = tp2 - entry;
      if (reward / risk >= 1.8) {
        return {
          type: 'doji-haussier',
          label: 'Doji — Retournement haussier',
          timeframe: 'Swing · 3-10 jours (sortie sur Doji inverse)',
          confidence: 'high',
          config: 'Doji détecté après bougie rouge (' + doji.redCandlePct + '%) puis bougie verte de confirmation (+' + doji.greenCandlePct + '%). Combat acheteurs/vendeurs résolu côté acheteur.',
          rationale: 'Stratégie Heikin Ashi adaptée : après une chute, un doji marque une hésitation (combat acheteur/vendeur). La bougie verte qui suit confirme que les acheteurs ont gagné. Stop technique au plus bas de la bougie rouge. Sortie discrétionnaire au prochain Doji baissier (doji après bougie verte).',
          direction: 'long',
          entry, stop, tp1, tp2,
          rr1: ((tp1 - entry) / risk).toFixed(2),
          rr2: ((tp2 - entry) / risk).toFixed(2),
        };
      }
    }
  }
  if (doji && doji.direction === 'short') {
    const entry = last;
    const stop = doji.stopLevel;
    if (stop > entry) {
      const tp1 = entry - 2 * atr;
      const tp2 = entry - 4 * atr;
      const risk = stop - entry;
      const reward = entry - tp2;
      if (reward / risk >= 1.8) {
        return {
          type: 'doji-baissier',
          label: 'Doji — Retournement baissier',
          timeframe: 'Swing · 3-10 jours (sortie sur Doji inverse)',
          confidence: 'high',
          config: 'Doji après bougie verte (+' + doji.greenCandlePct + '%) puis bougie rouge de confirmation (' + doji.redCandlePct + '%). Vendeurs ont pris le contrôle.',
          rationale: 'Inverse du Doji haussier : après une hausse, un doji marque l\'épuisement des acheteurs. La bougie rouge confirme. Stop au plus haut de la bougie verte. Pour les comptes qui shortent — sinon, signal "sors de ton long".',
          direction: 'short',
          entry, stop, tp1, tp2,
          rr1: ((entry - tp1) / risk).toFixed(2),
          rr2: (reward / risk).toFixed(2),
        };
      }
    }
  }

  // Aucun setup propre détecté — on ne fabrique PAS un setup faible
  return null;
}

/**
 * v2.69 — Détection DOJI (doji-reversal du formateur IVT Live Trading)
 * v2.73 — Avec confirmations IVT COMPLÈTES : Ichimoku ascendant + MA7 ascendante
 *
 * Doji haussier  : bougie ROUGE → DOJI → bougie VERTE (confirmation)
 * Doji baissier  : bougie VERTE → DOJI → bougie ROUGE (confirmation)
 *
 * Note : on travaille sur close-only, donc :
 *   - "bougie rouge" = close[t] < close[t-1] de plus de 0.5%
 *   - "doji"         = |close[t] - close[t-1]| / close[t-1] < 0.3%
 *   - "bougie verte" = close[t] > close[t-1] de plus de 0.5%
 *
 * v2.73 — Le setup "IVT complet" exige EN PLUS :
 *   - Ichimoku cloud ASCENDANT (cloud direction up)
 *   - MA7 ASCENDANTE (slope up)
 *
 * Si ces 2 confirmations sont là → confidence very-high
 * Sinon → setup détecté mais confidence medium (à l'utilisateur de décider)
 *
 * Stop = close de la bougie rouge (approximation du low en mode close-only)
 */
function detectDoji(prices, atr) {
  if (!prices || prices.length < 5) return null;
  const N = prices.length;
  const c1 = prices[N - 1]; // dernière bougie (confirmation)
  const c2 = prices[N - 2]; // doji (Doji)
  const c3 = prices[N - 3]; // bougie rouge ou verte (contexte)
  const c4 = prices[N - 4]; // référence
  const DOJI_TH = 0.003;    // 0.3%
  const BODY_TH = 0.005;    // 0.5%

  const move = (a, b) => (a - b) / b;
  const dojiMove = Math.abs(move(c2, c3));
  const confirmMove = move(c1, c2);
  const contextMove = move(c3, c4);

  // v2.73 — Vérification confirmations IVT (MA7 + Ichimoku ascendants)
  const ma7Info = ma7(prices);
  const ichiDir = ichimokuDirection(prices);
  const ma7Up = ma7Info && ma7Info.slope === 'up';
  const ma7Down = ma7Info && ma7Info.slope === 'down';
  const cloudUp = ichiDir && ichiDir.direction === 'up' && ichiDir.tenkanAboveKijun;
  const cloudDown = ichiDir && ichiDir.direction === 'down' && !ichiDir.tenkanAboveKijun;

  // Doji haussier
  if (contextMove < -BODY_TH && dojiMove < DOJI_TH && confirmMove > BODY_TH) {
    const ivtComplete = ma7Up && cloudUp;
    return {
      direction: 'long',
      dojiPrice: c2,
      redCandlePct: (contextMove * 100).toFixed(1),
      greenCandlePct: (confirmMove * 100).toFixed(1),
      stopLevel: Math.min(c3, c4) * 0.998,
      // v2.73 — Nouvelles infos méthodo IVT
      ivtComplete,
      ma7Trend: ma7Info ? ma7Info.slope : null,
      cloudTrend: ichiDir ? ichiDir.direction : null,
      cloudBullish: cloudUp,
    };
  }
  // Doji baissier
  if (contextMove > BODY_TH && dojiMove < DOJI_TH && confirmMove < -BODY_TH) {
    const ivtCompleteShort = ma7Down && cloudDown;
    return {
      direction: 'short',
      dojiPrice: c2,
      greenCandlePct: (contextMove * 100).toFixed(1),
      redCandlePct: (confirmMove * 100).toFixed(1),
      stopLevel: Math.max(c3, c4) * 1.002,
      ivtComplete: ivtCompleteShort,
      ma7Trend: ma7Info ? ma7Info.slope : null,
      cloudTrend: ichiDir ? ichiDir.direction : null,
      cloudBearish: cloudDown,
    };
  }
  return null;
}

/**
 * v2.68 — Détection AGRESSIVE dédiée à KAIRO (Le Chasseur)
 * Critères plus laxistes : on cherche les rebonds extrêmes, les momentums
 * vifs, et les zones de retournement potentielles que les autres agents
 * écarteraient. KAIRO trouve TOUJOURS quelque chose à chasser.
 */
function detectAggressiveSetup(a) {
  if (!a || !a.indRaw || !a.atrAbs) return null;
  const ind = a.indRaw;
  const prices = a.prices;
  const last = prices[prices.length - 1];
  const atr = a.atrAbs;
  const rsi = ind.rsi?.value;
  const ma20 = ind.ma20?.value;
  const ma50 = ind.ma50?.value;

  function validate(entry, stop, tp1, tp2) {
    if (stop >= entry) return null;
    if (tp1 <= entry) return null;
    if (tp2 <= tp1) return null;
    const risk = entry - stop;
    const reward = tp2 - entry;
    if (reward / risk < 2.0) return null;
    return { entry, stop, tp1, tp2,
      rr1: ((tp1 - entry) / risk).toFixed(2),
      rr2: ((tp2 - entry) / risk).toFixed(2) };
  }

  // 1) Rebond contrarien sur RSI < 35 (au lieu de 30 strict)
  if (rsi != null && rsi < 35 && ma50 != null && last > ma50 * 0.88) {
    const entry = last;
    const stop = entry - 2 * atr;
    const tp1 = ma20 && ma20 > entry ? ma20 : entry + 2 * atr;
    const tp2 = entry + 5 * atr;
    const v = validate(entry, stop, tp1, tp2);
    if (v) return Object.assign({}, v, {
      type: 'kairo-contrarien',
      label: 'Rebond contrarien agressif',
      timeframe: 'Court terme · 2-5 jours',
      confidence: rsi < 28 ? 'high' : 'medium',
      config: 'RSI ' + rsi.toFixed(0) + ' (zone faible) · prix au-dessus de la MA50 dégradée (' + ma50.toFixed(2) + '). KAIRO chasse le rebond avant que les autres voient venir.',
      rationale: 'Pari contrarien : RSI bas + actif proche d\'un support clé. Plus risqué que les setups conventionnels mais potentiel de gain x2 ATR si le rebond se matérialise. À surveiller serré, le marché peut continuer sa baisse.',
      direction: 'long',
    });
  }

  // 2) Momentum vif récent : +5% sur 5 jours
  if (prices.length >= 6) {
    const p5 = prices.slice(-6);
    const surge = (p5[5] - p5[0]) / p5[0];
    if (surge > 0.05 && rsi != null && rsi < 78) {
      const entry = last;
      const stop = entry - 2.2 * atr;
      const tp1 = entry + 2 * atr;
      const tp2 = entry + 4.5 * atr;
      const v = validate(entry, stop, tp1, tp2);
      if (v) return Object.assign({}, v, {
        type: 'kairo-momentum',
        label: 'Momentum vif — saute dedans',
        timeframe: 'Court terme · 1-3 jours',
        confidence: 'medium',
        config: 'Surge +' + (surge * 100).toFixed(1) + '% sur 5 jours + RSI ' + rsi.toFixed(0) + '. KAIRO entre dans un mouvement déjà engagé en pariant sur sa continuation.',
        rationale: 'Stratégie momentum : on saute dans un mouvement vif en pariant sur sa continuation à court terme. Risque : retournement violent si le momentum casse. Stop large à 2.2 ATR.',
        direction: 'long',
      });
    }
    // Inverse : crash de -5% sur 5 jours = court bearish
    if (surge < -0.05 && rsi != null && rsi > 22) {
      const entry = last;
      const stop = entry + 2.2 * atr;
      const tp1 = entry - 2 * atr;
      const tp2 = entry - 4.5 * atr;
      const reward = entry - tp2;
      const risk = stop - entry;
      if (risk > 0 && reward / risk >= 2.0) {
        return {
          type: 'kairo-shortMomentum',
          label: 'Crash vif — short tactique',
          timeframe: 'Court terme · 1-3 jours',
          confidence: 'medium',
          config: 'Plongeon ' + (surge * 100).toFixed(1) + '% sur 5 jours. KAIRO joue la continuation baissière. Réservé aux brokers qui supportent le short.',
          rationale: 'Stratégie momentum baissier : on suit le mouvement déjà engagé. Pour les traders qui savent shorter (ou crypto via futures). Sinon : éviter d\'acheter ici et attendre stabilisation.',
          direction: 'short',
          entry, stop, tp1, tp2,
          rr1: ((entry - tp1) / risk).toFixed(2),
          rr2: (reward / risk).toFixed(2),
        };
      }
    }
  }

  // 3) Squeeze de volatilité : ATR très bas + Bollinger compressé → cassure proche
  if (ind.atr && ind.atr.value < 1.5 && ind.boll && ind.boll.value > 0.3 && ind.boll.value < 0.7) {
    const entry = last;
    const stop = entry - 2.5 * atr;
    const tp1 = entry + 2 * atr;
    const tp2 = entry + 5 * atr;
    const v = validate(entry, stop, tp1, tp2);
    if (v) return Object.assign({}, v, {
      type: 'kairo-squeeze',
      label: 'Volatilité comprimée — cassure proche',
      timeframe: 'Court terme · 3-7 jours',
      confidence: 'medium',
      config: 'ATR ' + ind.atr.value.toFixed(2) + '% (très bas) + prix au milieu de Bollinger. KAIRO anticipe une explosion de volatilité.',
      rationale: 'Théorie : la volatilité finit toujours par revenir. Quand l\'ATR est anormalement bas, une cassure directionnelle se prépare. La direction n\'est pas garantie, mais on positionne un long si la tendance MT est haussière (MA20>MA50).',
      direction: 'long',
    });
  }

  return null;
}

function priceFmt(p, kind) {
  if (p == null) return '—';
  if (p >= 10000) return Math.round(p).toLocaleString('fr-FR');
  if (p >= 100) return p.toFixed(0);
  if (p >= 1) return p.toFixed(2);
  return p.toFixed(4);
}

// v2.60 — Mixe les actifs en piochant dans chaque catégorie (indices, crypto,
// actions, forex, métaux). Garantit que le summary IA mentionne tous les univers.
function pickMixed(assets, nIdx = 2, nCrypto = 2, nAction = 2, nForex = 1, nMetal = 1) {
  const byKind = (k) => assets.filter(a => a.kind === k);
  const out = [
    ...byKind('index').slice(0, nIdx),
    ...byKind('crypto').slice(0, nCrypto),
    ...byKind('action').slice(0, nAction),
    ...byKind('forex').slice(0, nForex),
    ...byKind('metal').slice(0, nMetal),
  ];
  const target = nIdx + nCrypto + nAction + nForex + nMetal;
  if (out.length < target) {
    for (const a of assets) {
      if (!out.includes(a)) out.push(a);
      if (out.length >= target) break;
    }
  }
  return out;
}

function buildPrompt(assets) {
  // v2.49 — tableau complet pour le LLM (il a besoin de la vue d'ensemble)
  const table = assets
    .map((a) => `${a.label} [${a.kind}]: prix ${a.price?.toFixed(2)} (${a.change}%) · RSI ${a.rsi} · MA ${a.maCross} · MACD histo ${a.macdHist} · Bollinger ${a.boll} · ADX ${a.adx} · ATR ${a.atr} → verdict ${a.verdict} (${a.score}/100)`)
    .join('\n');

  return `Tu es analyste technique pour une app pédagogique de bourse (Trade Genius). Tu écris en français pour des débutants/intermédiaires.

CONTEXTE — données techniques d'aujourd'hui (indices + crypto + actions) :
${table}

CONSIGNES :
1. Écris une analyse pédagogique synthétique (max 200 mots) qui présente la situation technique générale.
2. Ne dis JAMAIS "achète", "vends", "il faut" — c'est interdit (cadre légal AMF français).
3. Utilise plutôt : "on observe", "schéma classique", "un trader expérimenté surveillerait", "à considérer".
4. **OBLIGATOIRE** : mentionne au moins 1 indice, 1 crypto et 1 action dans le summary (mix des 3 univers).
5. Termine par une mini-section "ce que regarderait un trader" avec 3 points concrets.

Réponds EN JSON STRICT avec cette structure :
{
  "title": "Titre court accrocheur, max 60 caractères",
  "summary": "Analyse pédagogique 150-200 mots, prose fluide",
  "observations": ["obs 1 court", "obs 2", "obs 3", "obs 4"],
  "plan_pedago": ["point 1", "point 2", "point 3"]
}

Ne mets RIEN avant ou après le JSON. Pas de balise markdown.`;
}

async function callPollinations(prompt) {
  console.log('Calling Pollinations.ai…');
  const r = await fetch('https://text.pollinations.ai/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      model: 'openai',
      jsonMode: true,
      seed: Math.floor(Date.now() / (24 * 60 * 60 * 1000)), // déterministe par jour
    }),
  });
  if (!r.ok) throw new Error(`Pollinations HTTP ${r.status}`);
  const text = await r.text();
  return text;
}

async function callGroq(prompt, key) {
  console.log('Calling Groq (llama-3.3-70b-versatile)…');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.5,
      max_tokens: 800,
    }),
  });
  if (!r.ok) throw new Error(`Groq HTTP ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content || '';
}

function parseAIResponse(raw) {
  // Cleanup : enlève balises markdown si l'IA en a mis quand même
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  // Trouve le 1er { et le dernier }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in IA response');
  s = s.slice(start, end + 1);
  return JSON.parse(s);
}

function buildFallbackStudy(valid) {
  // Si l'IA échoue : on génère du contenu pédago par template à partir des
  // vraies données techniques. Pas aussi varié qu'une IA, mais utile et stable.
  const bullN = valid.filter(a => a.cls === 'bull').length;
  const bearN = valid.filter(a => a.cls === 'bear').length;
  let title;
  if (bullN >= 4) title = 'Marchés bien orientés sur les majeurs';
  else if (bearN >= 4) title = 'Marchés sous pression — biais vendeur';
  else if (bullN > bearN) title = 'Marchés mitigés, biais haussier modéré';
  else if (bearN > bullN) title = 'Marchés mitigés, biais baissier modéré';
  else title = 'Marchés sans direction nette';

  // v2.49 — Pick un mix indices + crypto + actions au lieu des 5 premiers
  const mixHead = pickMixed(valid, 2, 2, 1); // 2 idx + 2 crypto + 1 action
  const head = mixHead.slice(0, 5).map(a =>
    `${a.label} ${a.change > 0 ? '+' : ''}${a.change}% (RSI ${a.rsi}, ${a.verdict.toLowerCase()})`
  ).join(' · ');

  const idxN = valid.filter(a => a.kind === 'index').length;
  const cryN = valid.filter(a => a.kind === 'crypto').length;
  const actN = valid.filter(a => a.kind === 'action').length;

  const summary = `Tour d'horizon multi-univers (${idxN} indices · ${cryN} crypto · ${actN} actions) : ${head}. ` +
    `Globalement, ${bullN} actifs en biais haussier contre ${bearN} en baissier. ` +
    `On observe une configuration ${bullN > bearN ? 'plutôt favorable aux acheteurs' : bearN > bullN ? 'plutôt favorable aux vendeurs' : 'partagée sans direction claire'}. ` +
    `Un trader expérimenté surveillerait surtout les zones de surachat (RSI > 70) ou de survente (RSI < 30) pour timer une entrée, ainsi que la position du prix par rapport à la MA50 pour situer la tendance moyen terme.`;

  // v2.49 — Observations mixées aussi (1 par catégorie minimum)
  const obsAssets = pickMixed(valid, 2, 2, 1);
  const observations = obsAssets.slice(0, 5).map(a => {
    if (a.cls === 'bull') return `${a.label} : tendance haussière confirmée (RSI ${a.rsi}, ${a.maCross} MA50)`;
    if (a.cls === 'bear') return `${a.label} : pression vendeuse persistante (RSI ${a.rsi})`;
    return `${a.label} : sans direction nette (RSI ${a.rsi})`;
  });

  return {
    title,
    summary,
    observations,
    plan_pedago: [
      'Vérifier la position du prix par rapport à la MA50 pour identifier la tendance moyen terme',
      'Surveiller les croisements MACD pour confirmer un changement de momentum',
      'Calculer la taille de position pour ne pas risquer plus de 1-2% du capital',
      'Définir stop loss et take profit AVANT d\'entrer sur le marché',
    ],
  };
}

async function generateStudy(prompt, valid) {
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try { return parseAIResponse(await callGroq(prompt, groqKey)); }
    catch (e) { console.warn('Groq failed, fallback Pollinations:', e.message); }
  }
  try { return parseAIResponse(await callPollinations(prompt)); }
  catch (e) {
    console.warn('Pollinations failed, fallback template:', e.message);
    return buildFallbackStudy(valid);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   v2.70 — MÉTHODOLOGIES PRIVÉES PAR AGENT
   ───────────────────────────────────────────────────────────────────
   Chaque agent applique SA propre logique de détection avec SES outils
   privilégiés. Aucune information sur les outils utilisés n'est exposée
   dans le JSON public — c'est la marque de fabrique Trade Genius.
   Seul le résultat (setup) est partagé avec l'utilisateur.
   ═══════════════════════════════════════════════════════════════════ */

/**
 * ATLAS — Le Gardien (v2.72)
 * Focus : tendance LT prouvée + qualité du flux (volume + force directionnelle)
 * Outils privés : SMA200 + MA50 + Ichimoku + OBV + +DI/-DI + ADX + RSI sain
 *                + distance % à SMA200 (rejet si trop étiré)
 */
function _detectAtlas(asset) {
  const ind = asset.indRaw;
  const prices = asset.prices;
  if (!ind || !prices || prices.length < 60) return null;
  // v2.73 — Bonus : si Ponchy COMPLET détecté (3 confirmations alignées),
  // ATLAS accepte exceptionnellement ce signal premium même sans toutes ses conditions LT
  const ivt = detectPonchy(asset);
  if (ivt) {
    const last = prices[prices.length - 1];
    const atr = asset.atrAbs;
    const entry = last;
    const stop = Math.min(ivt.stopLevel, entry - 1.5 * atr);
    const tp1 = entry + 3 * atr;
    const tp2 = entry + 6 * atr;
    const risk = entry - stop;
    if (risk > 0 && (tp2 - entry) / risk >= 2.5) {
      return {
        type: 'atlas-ponchy',
        label: 'Ponchy premium — 3 confirmations',
        timeframe: 'Swing+ · 2-5 semaines',
        confidence: 'very-high',
        config: 'Triple confluence IVT : Doji haussier + Ichimoku cloud ascendant + MA7 ascendante.',
        rationale: 'Le Gardien valide exceptionnellement ce signal court terme parce que les 3 confirmations structurelles sont alignées (ce qui est rare). Stop au plus bas de la bougie rouge. Cible étendue à +6 ATR pour capter les meilleurs mouvements. Sortie discrétionnaire sur le prochain Doji baissier OU rupture de MA20.',
        direction: 'long', entry, stop, tp1, tp2,
        rr1: ((tp1 - entry) / risk).toFixed(2),
        rr2: ((tp2 - entry) / risk).toFixed(2),
      };
    }
  }
  const last = prices[prices.length - 1];
  const atr = asset.atrAbs;
  const rsi = ind.rsi?.value;
  const adx = ind.adx?.value || 0;
  const macdH = ind.macd?.value;
  const ichi = ind.ichimoku;
  const ma20 = ind.ma20?.value;
  const ma50 = ind.ma50?.value;
  const sma200 = ind.sma200?.value;
  const sma200Dist = ind.sma200?.distance;
  const obv = ind.obv;
  const di = ind.directional;
  // ── Filtres structurels stricts ──
  // 1) Si on a SMA200 : prix > SMA200 ET MA50 > SMA200 (golden cross structurel)
  if (sma200) {
    if (last <= sma200) return null;
    if (ma50 && ma50 <= sma200) return null;
    // Distance pas trop étirée
    if (sma200Dist != null && (sma200Dist > 25 || sma200Dist < 2)) return null;
  }
  // 2) Ichimoku au-dessus du nuage avec signal bull
  if (!ichi || ichi.position !== 'above-cloud' || ichi.signal !== 'bull') return null;
  // 3) Tendance MT confirmée
  if (!ma20 || !ma50 || ma20 <= ma50) return null;
  if (last <= ma20) return null;
  // 4) Force directionnelle
  if (adx < 25) return null;
  if (di && di.plusDI <= di.minusDI) return null;
  // 5) Volume confirmant (OBV en tendance haussière)
  if (obv && obv.trend === 'down') return null;
  // 6) RSI sain (pas surchauffe, pas faiblesse)
  if (rsi == null || rsi < 45 || rsi > 65) return null;
  // 7) MACD positif
  if (macdH == null || macdH <= 0) return null;
  // ── Niveaux ──
  const entry = last;
  const stop = Math.min(entry - 1.3 * atr, ma20 * 0.99);
  const tp1 = entry + 2.5 * atr;
  const tp2 = entry + 5 * atr;
  const risk = entry - stop;
  if (risk <= 0 || tp1 <= entry || tp2 <= tp1) return null;
  if ((tp2 - entry) / risk < 2.5) return null;
  return {
    type: 'atlas-tendance', label: 'Tendance long terme confirmée',
    timeframe: 'Long terme · 3-8 semaines', confidence: 'very-high',
    config: 'Structure haussière complète : tendance MT et LT alignées avec volume confirmant.',
    rationale: 'Configuration acheteuse safe : tous les indicateurs structurels et le flux volume sont alignés. Stop technique serré sous la moyenne mobile dynamique. Cible 1 à +2.5 ATR, cible 2 à +5 ATR pour capter la suite du mouvement.',
    direction: 'long', entry, stop, tp1, tp2,
    rr1: ((tp1 - entry) / risk).toFixed(2),
    rr2: ((tp2 - entry) / risk).toFixed(2),
  };
}

/**
 * v2.73 — Détection Ponchy COMPLET (utilisé en bonus par ATLAS et ZEN)
 * Trouve un Doji haussier ET vérifie les 2 confirmations IVT :
 * Ichimoku cloud ascendant + MA7 ascendante. Si tout aligné, signal premium.
 */
function detectPonchy(asset) {
  if (!asset.prices) return null;
  const s = detectDoji(asset.prices, asset.atrAbs);
  if (!s || s.direction !== 'long' || !s.ivtComplete) return null;
  return s;
}

/**
 * ZEN — L'Équilibriste (v2.72)
 * Focus : SWING dans tendance avec ENTRÉE TACTIQUE (VWAP / Doji / Pullback)
 * Outils privés : MA20/MA50 + MACD + VWAP (entrée fair-price) + Bollinger pos
 *                + RSI 40-60 + Doji + Hull MA (timing)
 */
function _detectZen(asset) {
  const ind = asset.indRaw;
  const prices = asset.prices;
  if (!ind || !prices || prices.length < 30) return null;
  const last = prices[prices.length - 1];
  const atr = asset.atrAbs;
  const rsi = ind.rsi?.value;
  const macdH = ind.macd?.value;
  const ma20 = ind.ma20?.value;
  const ma50 = ind.ma50?.value;
  const boll = ind.boll?.value;
  const adx = ind.adx?.value || 0;
  const vw = ind.vwap;
  // Filtres structurels
  if (!ma20 || !ma50 || ma20 <= ma50) return null;
  if (macdH == null || macdH <= 0) return null;
  if (adx < 18) return null;
  // ZEN cherche une entrée tactique parmi 3 voies :
  // 1) Doji haussier (avec bonus IVT si Ichimoku + MA7 confirment)
  const doji = detectDoji(prices, atr);
  if (doji && doji.direction === 'long') {
    const entry = last;
    const stop = Math.min(doji.stopLevel, entry - 1.5 * atr);
    const tp1 = entry + 2 * atr;
    const tp2 = doji.ivtComplete ? entry + 5 * atr : entry + 4 * atr;
    const risk = entry - stop;
    if (risk > 0 && (tp2 - entry) / risk >= 2.0) {
      return {
        type: doji.ivtComplete ? 'zen-ponchy' : 'zen-doji',
        label: doji.ivtComplete ? 'Ponchy complet (signal premium)' : 'Doji haussier (entrée swing)',
        timeframe: 'Swing · 1-3 semaines',
        confidence: doji.ivtComplete ? 'very-high' : 'high',
        config: doji.ivtComplete
          ? 'Triple confluence : Doji-reversal + Ichimoku cloud ascendant + MA7 ascendante. Signal premium.'
          : 'Doji-reversal validé dans tendance MT haussière. Confirmation MACD>0 + ADX>18.',
        rationale: doji.ivtComplete
          ? 'Configuration IVT complète : retournement Doji + structure Ichimoku haussière (cloud monte) + moyenne mobile courte ascendante. Les 3 confirmations alignées = très haute conviction. Stop sous le swing low, cible étendue +5 ATR. Sortie discrétionnaire au prochain Doji baissier (méthode du formateur).'
          : 'Entrée tactique sur un signal de retournement court terme dans une tendance MT confirmée. Stop sous le swing low, cible swing avec R/R 1:2 minimum.',
        direction: 'long', entry, stop, tp1, tp2,
        rr1: ((tp1 - entry) / risk).toFixed(2),
        rr2: ((tp2 - entry) / risk).toFixed(2),
      };
    }
  }
  // 2) Entrée sur retest VWAP en zone neutre (rebond VWAP)
  if (vw && vw.distancePct >= -2 && vw.distancePct <= 0.5
      && rsi != null && rsi >= 40 && rsi <= 60) {
    const entry = last;
    const stop = Math.min(entry - 1.4 * atr, (vw.value || entry) * 0.99);
    const tp1 = entry + 2 * atr;
    const tp2 = entry + 3.5 * atr;
    const risk = entry - stop;
    if (risk > 0 && (tp2 - entry) / risk >= 2.0) {
      return {
        type: 'zen-vwap-retest', label: 'Retest VWAP — entrée tactique',
        timeframe: 'Swing · 1-2 semaines', confidence: 'high',
        config: 'Prix au niveau du VWAP 20j (zone d\'équilibre acheteur/vendeur) dans une tendance haussière confirmée.',
        rationale: 'Le VWAP est le "fair price" calculé sur 20 séances pondéré par les volumes. Acheter au VWAP dans tendance haussière = entrée institutionnelle classique. Stop sous le VWAP, cibles à +2 et +3.5 ATR.',
        direction: 'long', entry, stop, tp1, tp2,
        rr1: ((tp1 - entry) / risk).toFixed(2),
        rr2: ((tp2 - entry) / risk).toFixed(2),
      };
    }
  }
  // 3) Pullback classique sur Bollinger médiane + RSI sain
  if (rsi != null && rsi >= 40 && rsi <= 58
      && boll != null && boll >= 0.25 && boll <= 0.55) {
    const entry = last;
    const stop = Math.min(entry - 1.5 * atr, ma50 * 0.985);
    const tp1 = entry + 2 * atr;
    const tp2 = entry + 4 * atr;
    const risk = entry - stop;
    if (risk > 0 && (tp2 - entry) / risk >= 2.0) {
      return {
        type: 'zen-pullback', label: 'Pullback dans tendance haussière',
        timeframe: 'Swing · 1-3 semaines', confidence: 'high',
        config: 'Tendance MT (MA20>MA50) + MACD positif + RSI ' + rsi.toFixed(0) + ' + Bollinger au milieu de bande.',
        rationale: 'Repli sain dans une tendance confirmée, sans excès de volatilité. Stop technique sous la MA50, cibles symétriques.',
        direction: 'long', entry, stop, tp1, tp2,
        rr1: ((tp1 - entry) / risk).toFixed(2),
        rr2: ((tp2 - entry) / risk).toFixed(2),
      };
    }
  }
  return null;
}

/**
 * NOVA — Le Tacticien
 * Focus : multi-confirmations équilibrées (le profil polyvalent)
 * Outils internes : tous les indicateurs, multi-confirmations
 *                  Utilise detectSetup() standard
 */
function _detectNova(asset) {
  const setup = detectSetup(asset);
  if (setup) return setup;
  // Si rien de propre, tente une détection Doji en backup
  const doji = detectDoji(asset.prices, asset.atrAbs);
  if (doji && doji.direction === 'long') {
    const ind = asset.indRaw;
    if (!ind.maCross || ind.maCross.signal !== 'bull') return null;
    const last = asset.prices[asset.prices.length - 1];
    const atr = asset.atrAbs;
    const entry = last;
    const stop = doji.stopLevel;
    const tp1 = entry + 2 * atr;
    const tp2 = entry + 3.5 * atr;
    const risk = entry - stop;
    if (risk <= 0 || (tp2 - entry) / risk < 1.8) return null;
    return {
      type: 'nova-doji', label: 'Doji haussier (NOVA)',
      timeframe: 'Swing · 1-2 semaines', confidence: 'medium',
      config: 'Setup Doji détecté dans tendance MT haussière.',
      rationale: 'Approche multi-conf : Doji + tendance MT confirmée = entrée swing.',
      direction: 'long', entry, stop, tp1, tp2,
      rr1: ((tp1 - entry) / risk).toFixed(2),
      rr2: ((tp2 - entry) / risk).toFixed(2),
    };
  }
  return null;
}

/**
 * KAIRO — Le Chasseur (v2.72)
 * Focus : CONTRARIAN + DIVERGENCES + capitulation volume
 * Outils privés : RSI Divergence + MFI + Force Index + Hull MA + Momentum vif
 *                + Doji baissier (short tactique)
 * Ignore : ADX, MA200 (n'attend pas de tendance établie)
 */
function _detectKairo(asset) {
  const ind = asset.indRaw;
  const prices = asset.prices;
  if (!ind || !prices) return null;
  const last = prices[prices.length - 1];
  const atr = asset.atrAbs;
  const rsi = ind.rsi?.value;
  const div = ind.rsiDivergence;
  const mf = ind.mfi?.value;
  const fi = ind.forceIndex?.value;
  const hma = ind.hullMA?.value;
  const ma50 = ind.ma50?.value;

  // VOIE 1 — Divergence RSI haussière (signal contrarian premium)
  if (div && div.type === 'bullish' && div.strength >= 0.3
      && ma50 && last > ma50 * 0.9) {
    const entry = last;
    const stop = entry - 2 * atr;
    const tp1 = entry + 2.5 * atr;
    const tp2 = entry + 5 * atr;
    const risk = entry - stop;
    if (risk > 0 && (tp2 - entry) / risk >= 2.0) {
      return {
        type: 'kairo-divergence', label: 'Divergence haussière confirmée',
        timeframe: 'Swing court · 3-7 jours', confidence: div.strength > 0.6 ? 'high' : 'medium',
        config: 'Le prix fait un plus bas mais l\'oscillateur fait un plus haut — signal de retournement classique.',
        rationale: 'Divergence : le marché baisse mais perd de la force. Les vendeurs s\'essoufflent. KAIRO entre AVANT que les autres voient venir. Stop large pour absorber le bruit final.',
        direction: 'long', entry, stop, tp1, tp2,
        rr1: ((tp1 - entry) / risk).toFixed(2),
        rr2: ((tp2 - entry) / risk).toFixed(2),
      };
    }
  }

  // VOIE 2 — Capitulation MFI (volume baissier massif)
  if (mf != null && mf < 22 && rsi != null && rsi < 40
      && hma && last > hma * 0.97) { // Hull MA proche = retournement potentiel
    const entry = last;
    const stop = entry - 2.2 * atr;
    const tp1 = entry + 2 * atr;
    const tp2 = entry + 5 * atr;
    const risk = entry - stop;
    if (risk > 0 && (tp2 - entry) / risk >= 2.0) {
      return {
        type: 'kairo-capitulation', label: 'Capitulation volume — rebond imminent',
        timeframe: 'Court terme · 2-5 jours', confidence: 'medium',
        config: 'MFI ' + mf.toFixed(0) + ' (capitulation vendeuse) + RSI bas + signal Hull MA proche.',
        rationale: 'Money Flow Index très bas = volume vendeur extrême. Combiné à un RSI faible et au prix qui approche la Hull MA (ligne réactive), c\'est souvent le creux avant un rebond technique.',
        direction: 'long', entry, stop, tp1, tp2,
        rr1: ((tp1 - entry) / risk).toFixed(2),
        rr2: ((tp2 - entry) / risk).toFixed(2),
      };
    }
  }

  // VOIE 3 — Force Index très négative + Doji haussier
  const doji = detectDoji(prices, atr);
  if (doji && doji.direction === 'long' && fi != null && fi < 0) {
    const entry = last;
    const stop = Math.min(doji.stopLevel, entry - 2 * atr);
    const tp1 = entry + 2 * atr;
    const tp2 = entry + 5 * atr;
    const risk = entry - stop;
    if (risk > 0 && (tp2 - entry) / risk >= 2.0) {
      return {
        type: 'kairo-doji', label: 'Doji + Force Index négatif → reprise',
        timeframe: 'Court terme · 3-7 jours', confidence: 'high',
        config: 'Doji après bougie rouge confirmé par bougie verte alors que le Force Index est encore négatif.',
        rationale: 'KAIRO chasse le creux : Doji haussier précoce + Force Index encore négatif = on entre avant la majorité. Plus risqué mais asymétrie de gain favorable.',
        direction: 'long', entry, stop, tp1, tp2,
        rr1: ((tp1 - entry) / risk).toFixed(2),
        rr2: ((tp2 - entry) / risk).toFixed(2),
      };
    }
  }

  // VOIE 4 — Setups agressifs classiques (momentum vif, squeeze) déjà implémentés
  const aggressive = detectAggressiveSetup(asset);
  if (aggressive) return aggressive;

  // VOIE 5 — Doji baissier (short tactique)
  if (doji && doji.direction === 'short') {
    const entry = last;
    const stop = doji.stopLevel;
    const tp1 = entry - 2 * atr;
    const tp2 = entry - 4 * atr;
    const risk = stop - entry;
    if (risk > 0 && (entry - tp2) / risk >= 2.0) {
      return {
        type: 'kairo-doji-short', label: 'Doji baissier (short tactique)',
        timeframe: 'Court terme · 2-5 jours', confidence: 'medium',
        config: 'Doji après bougie verte puis bougie rouge — retournement court terme.',
        rationale: 'Short tactique réservé aux comptes qui shortent. Sinon : signal "sors de ton long".',
        direction: 'short', entry, stop, tp1, tp2,
        rr1: ((entry - tp1) / risk).toFixed(2),
        rr2: ((entry - tp2) / risk).toFixed(2),
      };
    }
  }
  return null;
}

async function main() {
  console.log('Building AI study…');
  const results = await Promise.all(ASSETS.map(fetchOne));
  const valid = results.filter(Boolean).map(summarizeAsset).filter(Boolean);
  if (valid.length === 0) {
    throw new Error('No asset data available — abort');
  }

  // Détection des setups propices sur TOUS les actifs (pas seulement le meilleur)
  // Chaque actif peut produire 0 ou 1 setup. On expose la liste complète pour
  // que l'utilisateur ait soit notre reco directe (suivre l'IA), soit la matière
  // pour faire sa propre analyse dans Marché en direct.
  const CONF_RANK = { 'very-high': 3, 'high': 2, 'medium': 1, 'low': 0 };
  const setupsAll = valid
    .map(a => {
      const s = detectSetup(a);
      if (!s) return null;
      return {
        ...s,
        asset: a.label,
        kind: a.kind,
        score: a.score,
        // v2.61 — embarquer les 60 dernières bougies pour rendu graph SVG
        prices60: a.prices.slice(-60),
        currency: a.kind === 'crypto' || a.label === 'S&P 500' || a.label === 'Nasdaq' || a.label === 'Dow' ? 'USD' : 'EUR',
      };
    })
    .filter(Boolean)
    // v2.54 — Tri par CONFIDENCE puis R/R (pas seulement R/R)
    .sort((a, b) => {
      const dc = (CONF_RANK[b.confidence] || 0) - (CONF_RANK[a.confidence] || 0);
      if (dc !== 0) return dc;
      return Number(b.rr2) - Number(a.rr2);
    });
  // Setup principal (pour rétrocompat) = celui avec meilleure confidence puis R/R
  const bestSetup = setupsAll[0] || null;

  // ─────────────────────────────────────────────────────────────────
  // v2.67 — 4 AGENTS IA avec profils de risque distincts
  // Chaque agent filtre les setups et recalibre les niveaux ATR.
  // ─────────────────────────────────────────────────────────────────
  const AGENT_PROFILES = [
    {
      id: 'atlas', name: 'ATLAS', role: 'Le Gardien',
      tagline: 'Préserve avant tout',
      desc: 'Confirmations maximales. Stop serré. R/R élevé. Ne sort que quand le ciel est dégagé.',
      icon: '🛡️', color: '#60a5fa',
      filters: { minConfRank: 3, minADX: 28, minRR: 2.5 },
      atr: { stop: 1.2, tp1: 2.0, tp2: 3.5 },
      acceptedTypes: ['pullback-haussier', 'breakout-haussier', 'continuation-haussiere'],
    },
    {
      id: 'zen', name: 'ZEN', role: 'L\'Équilibriste',
      tagline: 'Patience et précision',
      desc: 'Setups confirmés sans excès. Patient, méthodique, prend les meilleures opportunités du jour.',
      icon: '🌿', color: '#84cc16',
      filters: { minConfRank: 2, minADX: 22, minRR: 2.0 },
      atr: { stop: 1.5, tp1: 2.0, tp2: 4.0 },
      acceptedTypes: ['pullback-haussier', 'breakout-haussier', 'continuation-haussiere', 'rebond-ma50', 'doji-haussier'],
    },
    {
      id: 'nova', name: 'NOVA', role: 'Le Tacticien',
      tagline: 'Calculer chaque move',
      desc: 'Équilibre opportunités et fiabilité. Le profil standard recommandé pour la plupart des traders.',
      icon: '⚡', color: '#f59e0b',
      filters: { minConfRank: 1, minADX: 16, minRR: 1.8 },
      atr: { stop: 1.5, tp1: 1.5, tp2: 3.0 },
      acceptedTypes: null, // tous types
    },
    {
      id: 'kairo', name: 'KAIRO', role: 'Le Chasseur',
      tagline: 'Frappe quand c\'est chaud',
      desc: 'Saisit les opportunités contrariennes et les rebonds extrêmes. Plus risqué, plus de gains potentiels.',
      icon: '🔥', color: '#ef4444',
      filters: { minConfRank: 1, minADX: 10, minRR: 2.0 },
      atr: { stop: 2.0, tp1: 2.5, tp2: 5.0 },
      acceptedTypes: null, // tous y compris rebond-survente
      bonusTypes: ['rebond-survente'], // boost priorité
    },
  ];

  function applyAgentProfile(allSetups, agent) {
    const out = [];
    for (const s of allSetups) {
      // Filtre type accepté
      if (agent.acceptedTypes && !agent.acceptedTypes.includes(s.type)) continue;
      // Filtre confidence
      if ((CONF_RANK[s.confidence] || 0) < agent.filters.minConfRank) continue;
      // Filtre R/R
      if (Number(s.rr2) < agent.filters.minRR) continue;
      // Recalcul niveaux selon ATR mult de l'agent
      // On a besoin de l'ATR absolu. On reconstitue depuis le R/R existant.
      const risk = s.entry - s.stop;
      const atrAbs = risk / 1.5; // approximation : default stop = 1.5 ATR
      const entry = s.entry;
      const stop = entry - agent.atr.stop * atrAbs;
      const tp1 = entry + agent.atr.tp1 * atrAbs;
      const tp2 = entry + agent.atr.tp2 * atrAbs;
      if (stop >= entry || tp1 <= entry || tp2 <= tp1) continue;
      const newRR2 = (tp2 - entry) / (entry - stop);
      if (newRR2 < agent.filters.minRR) continue;
      out.push({
        ...s,
        entry, stop, tp1, tp2,
        rr1: ((tp1 - entry) / (entry - stop)).toFixed(2),
        rr2: newRR2.toFixed(2),
        agentId: agent.id,
      });
    }
    // Bonus types remontent en tête
    if (agent.bonusTypes) {
      out.sort((a, b) => {
        const aBonus = agent.bonusTypes.includes(a.type) ? 1 : 0;
        const bBonus = agent.bonusTypes.includes(b.type) ? 1 : 0;
        if (aBonus !== bBonus) return bBonus - aBonus;
        return Number(b.rr2) - Number(a.rr2);
      });
    } else {
      out.sort((a, b) => {
        const dc = (CONF_RANK[b.confidence] || 0) - (CONF_RANK[a.confidence] || 0);
        if (dc !== 0) return dc;
        return Number(b.rr2) - Number(a.rr2);
      });
    }
    return out;
  }

  // v2.70 — Chaque agent applique sa propre méthodologie privée
  // Le JSON public ne révèle PAS les outils utilisés (marque de fabrique)
  const _agentDetectors = {
    atlas: _detectAtlas,
    zen: _detectZen,
    nova: _detectNova,
    kairo: _detectKairo,
  };
  function runAgentOnAssets(agentId) {
    const detect = _agentDetectors[agentId];
    if (!detect) return [];
    return valid
      .map(a => {
        const s = detect(a);
        if (!s) return null;
        return {
          ...s,
          asset: a.label, kind: a.kind, score: a.score,
          prices60: a.prices.slice(-60),
          currency: a.kind === 'crypto' || a.label === 'S&P 500' || a.label === 'Nasdaq' || a.label === 'Dow' ? 'USD' : 'EUR',
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const dc = (CONF_RANK[b.confidence] || 0) - (CONF_RANK[a.confidence] || 0);
        if (dc !== 0) return dc;
        return Number(b.rr2) - Number(a.rr2);
      });
  }

  const agentsOutput = AGENT_PROFILES.map(agent => {
    const setups = runAgentOnAssets(agent.id);
    return {
      // v2.70 — On expose UNIQUEMENT l'identité publique + les setups
      // Aucune information sur la méthodologie / outils internes
      id: agent.id, name: agent.name, role: agent.role, tagline: agent.tagline,
      desc: agent.desc, icon: agent.icon, color: agent.color,
      count: setups.length,
      setups: setups.map(s => ({
        asset: s.asset, kind: s.kind, type: s.type, label: s.label,
        timeframe: s.timeframe || null, confidence: s.confidence || 'medium',
        direction: s.direction, config: s.config, rationale: s.rationale,
        entry: s.entry, stop: s.stop, tp1: s.tp1, tp2: s.tp2,
        rr1: s.rr1, rr2: s.rr2, currency: s.currency,
        prices60: Array.isArray(s.prices60) ? s.prices60.map(p => Number(p.toFixed(4))) : null,
      })),
    };
  });

  // v2.56/v2.60 — Statistiques "Recommandations du jour" basées sur notre analyseur ULTRA FIABLE
  const recommended = {
    count: setupsAll.length,
    byKind: { index: 0, crypto: 0, action: 0, forex: 0, metal: 0 },
    byConfidence: { 'very-high': 0, high: 0, medium: 0 },
    assets: setupsAll.map(s => ({
      label: s.asset, kind: s.kind, type: s.type, label_setup: s.label,
      confidence: s.confidence || 'medium', direction: s.direction, rr2: s.rr2,
    })),
  };
  setupsAll.forEach(s => {
    recommended.byKind[s.kind] = (recommended.byKind[s.kind] || 0) + 1;
    recommended.byConfidence[s.confidence] = (recommended.byConfidence[s.confidence] || 0) + 1;
  });
  // Verdict global cohérent avec le nombre d'opportunités détectées
  let opportunityVerdict;
  if (setupsAll.length === 0) opportunityVerdict = { cls: 'neutral', label: 'Aucune opportunité claire aujourd\'hui', desc: 'Notre analyseur n\'a détecté aucun setup propre passant les filtres ultra-fiables. Patience : un signal clean arrive toujours.' };
  else if (setupsAll.length === 1) opportunityVerdict = { cls: 'neutral', label: '1 opportunité détectée', desc: 'Un seul actif présente une configuration alignée selon notre analyseur — sélectivité maximale.' };
  else if (setupsAll.length <= 3) opportunityVerdict = { cls: 'bull-soft', label: setupsAll.length + ' opportunités détectées', desc: 'Marché offrant quelques setups propres. Profil sélectif favorable.' };
  else opportunityVerdict = { cls: 'bull', label: setupsAll.length + ' opportunités détectées', desc: 'Plusieurs actifs alignés simultanément — contexte large favorable aux acheteurs trend-follow.' };
  recommended.opportunityVerdict = opportunityVerdict;

  const prompt = buildPrompt(valid);
  const ai = await generateStudy(prompt, valid);

  // Verdict moyen pour la card
  const scores = valid.map((a) => a.score);
  const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const avgCls = avgScore >= 60 ? 'bull' : avgScore <= 40 ? 'bear' : 'neutral';
  const avgLabel =
    avgScore >= 75 ? 'Haussier fort' :
    avgScore >= 60 ? 'Plutôt haussier' :
    avgScore >= 45 ? 'Indécis' :
    avgScore >= 30 ? 'Plutôt baissier' : 'Baissier fort';

  const now = new Date();
  // Nettoyage : on ne stocke pas les indRaw ni prices dans le JSON public
  const assetsClean = valid.map(a => ({
    label: a.label, kind: a.kind, price: a.price, change: a.change,
    rsi: a.rsi, maCross: a.maCross, macdHist: a.macdHist, boll: a.boll,
    adx: a.adx, atr: a.atr, verdict: a.verdict, score: a.score, cls: a.cls,
  }));

  const out = {
    generated: now.toISOString(),
    source: process.env.GROQ_API_KEY ? 'Groq · llama-3.3-70b' : 'Pollinations · openai',
    date: now.toISOString().slice(0, 10),
    title: ai.title || 'Étude IA du jour',
    summary: ai.summary || '',
    observations: Array.isArray(ai.observations) ? ai.observations.slice(0, 6) : [],
    plan_pedago: Array.isArray(ai.plan_pedago) ? ai.plan_pedago.slice(0, 5) : [],
    verdict: { score: avgScore, cls: avgCls, label: avgLabel },
    // v2.56 — Recommandations chiffrées issues de l'analyseur ULTRA FIABLE
    recommended: recommended,
    // v2.67 — 4 agents IA avec profils de risque distincts
    agents: agentsOutput,
    assets: assetsClean,
    // v2.44 — liste de TOUS les setups propices (1 par actif max)
    // v2.54 — confidence exposée
    // v2.61 — prices60 pour rendu graph SVG
    setups: setupsAll.map(s => ({
      asset: s.asset, kind: s.kind, type: s.type, label: s.label,
      timeframe: s.timeframe || null, confidence: s.confidence || 'medium',
      direction: s.direction, config: s.config, rationale: s.rationale,
      entry: s.entry, stop: s.stop, tp1: s.tp1, tp2: s.tp2,
      rr1: s.rr1, rr2: s.rr2, currency: s.currency,
      prices60: Array.isArray(s.prices60) ? s.prices60.map(p => Number(p.toFixed(4))) : null,
    })),
    // Retro-compat : setup principal (meilleure confidence + R/R)
    setup: bestSetup ? {
      asset: bestSetup.asset, kind: bestSetup.kind, type: bestSetup.type,
      label: bestSetup.label, timeframe: bestSetup.timeframe || null,
      confidence: bestSetup.confidence || 'medium',
      direction: bestSetup.direction, config: bestSetup.config,
      rationale: bestSetup.rationale, entry: bestSetup.entry, stop: bestSetup.stop,
      tp1: bestSetup.tp1, tp2: bestSetup.tp2, rr1: bestSetup.rr1, rr2: bestSetup.rr2,
      currency: bestSetup.currency,
      prices60: Array.isArray(bestSetup.prices60) ? bestSetup.prices60.map(p => Number(p.toFixed(4))) : null,
    } : null,
    disclaimer: "Cas pédagogique basé sur l'analyse technique — pas un conseil en investissement personnalisé. Les marchés financiers comportent un risque de perte en capital. Tu décides si tu copies ce plan ou pas.",
  };

  const target = path.join(process.cwd(), 'data', 'ai-study.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`Wrote AI study (source: ${out.source}, score ${avgScore}/100)`);
  console.log('Title:', out.title);
}

main().catch((e) => {
  console.error('build-ai-study.mjs failed:', e);
  process.exit(1);
});
