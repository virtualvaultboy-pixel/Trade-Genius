#!/usr/bin/env node
/**
 * Trade Genius — Build TG Winner monthly basket
 *
 * Strategie validee (cf scripts/lab/lab_winner_final.py) :
 *   Mix 50% Buy & Hold safe (SPY 60 / TLT 30 / GLD 10)
 * + 50% META 3 IAs (INDICES + CRYPTO + MIXTE) leveraged
 *
 * Backtest 2016-09 -> 2026-01 :
 *   - Annual return 23.1%, Max DD -33.2%, Calmar 0.69
 *   - MC 500 iters : P(profit) 100%, P(annual >= 15%) 83%
 *   - Survives stress 5x (commission 0.75% + slippage 1.2%) : 23.0%
 *
 * Le panier est FIXE (poids effectifs decoulant du Mix BH 50/50 + META 50/50
 * deroules). Le seul travail mensuel = refresh prices et recalculer les
 * quantites pour 1k EUR et 10k EUR de reference.
 *
 * Output : data/tg-winner.json
 *
 * Tourne via .github/workflows/tg-winner.yml :
 *   - Cron mensuel le 1er du mois 06:00 UTC
 *   - workflow_dispatch manuel
 *   - push sur ce fichier
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchYahooHistorical } from './indicators.mjs';

// -- Strategy config (synchronise avec lab_winner_final.py WINNER_CONFIG) --
const STRATEGY = {
  name: 'TG Winner',
  version: '1.0.0',
  description: 'Mix 50% Buy & Hold safe + 50% META 3 IAs leveraged. Rebalance mensuel.',
  rebalanceFrequency: 'monthly',
  expectedPerf: {
    annualReturnPct: 23.1,
    maxDrawdownPct: -33.2,
    calmar: 0.69,
    worstMonthPct: -13.34,
    bestMonthPct: 27.5,
    mcProbProfit: 1.0,
    mcProbAnnual15plus: 0.83,
    backtestPeriod: '2016-09 -> 2026-01',
    backtestYears: 9.2,
  },
  disclaimer: "Performance passee ne prejuge pas du futur. Pas de conseil d'investissement.",
};

// -- Basket effective weights (poids deroules apres mix Mix-BH 50/50 + META 50/50) --
// Source : WINNER_BASKET_TODAY.json produit par lab_winner_final.py
const BASKET = [
  { ticker: 'SPY',  yahoo: 'SPY',     name: 'SPDR S&P 500 ETF',                       kind: 'etf',           weightPct: 30.0, role: 'Base US large cap (volet B&H safe)' },
  { ticker: 'TLT',  yahoo: 'TLT',     name: 'iShares 20+ Year Treasury Bond ETF',     kind: 'etf',           weightPct: 25.0, role: 'Hedge taux (volet B&H + META)' },
  { ticker: 'TQQQ', yahoo: 'TQQQ',    name: 'ProShares UltraPro QQQ (3x Nasdaq)',     kind: 'etf-leveraged', weightPct: 18.3, role: 'Moteur leveraged tech (volet META)' },
  { ticker: 'GLD',  yahoo: 'GLD',     name: 'SPDR Gold Shares',                       kind: 'etf',           weightPct: 10.0, role: 'Hedge or (volet B&H + META)' },
  { ticker: 'BTC',  yahoo: 'BTC-USD', name: 'Bitcoin',                                kind: 'crypto',        weightPct:  6.7, role: 'Crypto majeure (volet META)' },
  { ticker: 'ETH',  yahoo: 'ETH-USD', name: 'Ethereum',                               kind: 'crypto',        weightPct:  5.0, role: 'Crypto majeure (volet META)' },
  { ticker: 'SOL',  yahoo: 'SOL-USD', name: 'Solana',                                 kind: 'crypto',        weightPct:  3.3, role: 'Crypto satellite (volet META)' },
  { ticker: 'XLK',  yahoo: 'XLK',     name: 'Technology Select Sector SPDR',          kind: 'etf',           weightPct:  1.7, role: 'Sector tech (volet META MIXTE)' },
];

const BROKER_HINTS = [
  { broker: 'Trade Republic', availability: 'SPY/TLT/TQQQ/GLD/XLK ETF + BTC/ETH/SOL crypto. Fractions OK.' },
  { broker: 'BoursoBank',     availability: 'ETF US via CTO. Crypto via integration tiers.' },
  { broker: 'Binance',        availability: 'BTC/ETH/SOL natifs. Pas d ETF action.' },
];

const REFERENCE_CAPITALS_EUR = [1000, 10000];

/**
 * Recupere le taux EUR -> USD via frankfurter.app (BCE, gratuit, sans cle).
 * Fallback : 1 EUR = 1.087 USD (moyenne approx 2025-2026).
 */
async function fetchEurUsdRate() {
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=EUR&to=USD', {
      headers: { 'user-agent': 'trade-genius-bot' },
    });
    if (!r.ok) throw new Error(`Frankfurter HTTP ${r.status}`);
    const j = await r.json();
    const rate = j?.rates?.USD;
    if (!rate || rate < 0.5 || rate > 2) throw new Error(`Frankfurter rate hors borne : ${rate}`);
    return { rate, source: 'frankfurter.app', fetchedAt: j.date };
  } catch (e) {
    console.warn(`FX fallback : ${e.message}`);
    return { rate: 1.087, source: 'fallback-static', fetchedAt: null };
  }
}

/**
 * Fetch le dernier prix USD pour chaque ligne du basket via Yahoo.
 * En cas d echec, on garde priceUsd = null et l UI affichera "indispo".
 */
async function fetchBasketPrices(basket) {
  const results = await Promise.all(basket.map(async (line) => {
    try {
      const d = await fetchYahooHistorical(line.yahoo, '5d');
      const price = d.price ?? d.prices?.[d.prices.length - 1] ?? null;
      if (price == null || price <= 0) throw new Error('price null');
      return { ...line, priceUsd: Number(price.toFixed(4)), currency: d.currency || 'USD', priceSource: 'yahoo' };
    } catch (e) {
      console.warn(`Skipping price ${line.yahoo}: ${e.message}`);
      return { ...line, priceUsd: null, currency: 'USD', priceSource: 'unavailable', priceError: e.message };
    }
  }));
  return results;
}

/**
 * Calcule les unites approximatives a acheter pour un capital donne.
 */
function buildExampleAllocation(capitalEur, basket, eurUsdRate) {
  const lines = basket.map((line) => {
    const amountEur = +(capitalEur * line.weightPct / 100).toFixed(2);
    const amountUsd = +(amountEur * eurUsdRate).toFixed(2);
    const unitsApprox = line.priceUsd ? +(amountUsd / line.priceUsd).toFixed(6) : null;
    return {
      ticker: line.ticker,
      weightPct: line.weightPct,
      amountEur,
      amountUsd,
      unitsApprox,
    };
  });
  return { capitalEur, lines };
}

/**
 * Calcule la prochaine date de rebalance (1er du mois prochain).
 * Que l on soit le 1er ou le 28 du mois, on cible TOUJOURS le 1er du mois
 * suivant. Le rebalance "du jour" (cas du 1er) est celui qu on est en train
 * de generer — pas le prochain.
 */
function nextRebalanceDate(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const target = new Date(Date.UTC(y, m + 1, 1));
  return target.toISOString().slice(0, 10);
}

async function main() {
  console.log('Building TG Winner monthly basket...');
  const generatedAt = new Date().toISOString();

  const [{ rate: eurUsdRate, source: fxSource, fetchedAt: fxDate }, pricedBasket] = await Promise.all([
    fetchEurUsdRate(),
    fetchBasketPrices(BASKET),
  ]);

  console.log(`FX EUR->USD : ${eurUsdRate} (${fxSource}${fxDate ? ' @ ' + fxDate : ''})`);
  const okCount = pricedBasket.filter(l => l.priceUsd != null).length;
  console.log(`Prices OK : ${okCount}/${pricedBasket.length}`);

  const exampleAllocations = REFERENCE_CAPITALS_EUR.map(c => buildExampleAllocation(c, pricedBasket, eurUsdRate));

  const out = {
    schemaVersion: 1,
    generatedAt,
    source: 'gh-actions-cron',
    strategy: {
      ...STRATEGY,
      nextRebalance: nextRebalanceDate(),
    },
    fx: {
      eurToUsd: eurUsdRate,
      source: fxSource,
      fetchedAt: fxDate,
    },
    basket: pricedBasket,
    exampleAllocations,
    brokerHints: BROKER_HINTS,
  };

  const outPath = path.join('data', 'tg-winner.json');
  await fs.writeFile(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${outPath}`);

  // Snapshot historique mensuel (overwrite par mois calendaire pour ne pas
  // exploser le repo sur des runs multiples du meme mois — workflow_dispatch
  // ou push). 1 fichier par mois, traçable.
  const histDir = path.join('data', 'tg-winner-history');
  const histKey = generatedAt.slice(0, 7); // YYYY-MM
  const histPath = path.join(histDir, `${histKey}.json`);
  try {
    await fs.mkdir(histDir, { recursive: true });
    await fs.writeFile(histPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log(`Wrote history ${histPath}`);
  } catch (e) {
    console.warn(`History snapshot skipped: ${e.message}`);
  }
}

main().catch((e) => {
  console.error('Build failed:', e);
  process.exit(1);
});
