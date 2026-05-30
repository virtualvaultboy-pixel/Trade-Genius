#!/usr/bin/env node
/**
 * Trade Genius — v6.0/v7.11 SANDBOX MULTI · 5 portefeuilles 1000€ par IA
 *
 * Chaque IA reçoit son propre portefeuille virtuel de 1000€ et n'ouvre
 * QUE les setups de son propre backend (atlas/nova/kairo/multi-crypto/volt).
 * Permet de comparer en direct la performance réelle isolée de chaque IA.
 *
 * Outputs :
 *   data/sandbox/portfolio_bastion.json + stats_bastion.json
 *   data/sandbox/portfolio_phenix.json  + stats_phenix.json
 *   data/sandbox/portfolio_rafale.json  + stats_rafale.json
 *   data/sandbox/portfolio_nexus.json   + stats_nexus.json
 *   data/sandbox/portfolio_volt.json    + stats_volt.json   (v7.11 — haute conviction)
 *
 * Workflow : sandbox-cycle.yml (cron quotidien 23h UTC ouvré)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchYahooHistorical, fetchCoinGeckoHistorical } from './indicators.mjs';

const SANDBOX_DIR = path.join(process.cwd(), 'data', 'sandbox');
const SNAPSHOTS_DIR = path.join(SANDBOX_DIR, 'snapshots');
const AI_STUDY_FILE = path.join(process.cwd(), 'data', 'ai-study.json');

const CAPITAL_INITIAL = 1000; // 1000€ virtuels par sandbox
const MAX_POSITIONS = 5;
const MIN_QUALITY_TO_OPEN = 65;
const MAX_HOLD_DAYS = 60;

// v9.3 — Configs BOOST issues du grid-search massive (1440 backtests sur 4 ans)
// Gain validé : BASTION +12.3pts/an, PHÉNIX +6.9, RAFALE +10.3 (Calmar 3.5-4.75)
// sizingPct = % du cash alloué par trade (override sizing_pct du setup)
// pyramiding = % ajouté à la position quand TP1 touché (0 = off)
// trailing = breakeven SL quand TP1 touché (déjà existant via trailing_after_tp1)
const SANDBOXES = [
  // BASTION : 22%/an · DD -4.98% · PF 2.32 · Calmar 4.41
  { id: 'bastion', backendId: 'atlas',  name: 'BASTION', icon: '🗿', holdMax: 45,
    sizingPct: 10, minQuality: 50, maxPositions: 5, pyramiding: 50, trailing: true },
  // PHÉNIX : 16.23%/an · DD -4.54% · PF 1.90 · Calmar 3.57
  { id: 'phenix',  backendId: 'nova',   name: 'PHÉNIX',  icon: '🔥', holdMax: 30,
    sizingPct: 10, minQuality: 50, maxPositions: 5, pyramiding: 50, trailing: true },
  // RAFALE : 19.95%/an · DD -4.20% · PF 2.50 · Calmar 4.75
  { id: 'rafale',  backendId: 'kairo',  name: 'RAFALE',  icon: '⚡', holdMax: 18,
    sizingPct: 10, minQuality: 65, maxPositions: 3, pyramiding: 50, trailing: true },
  // NEXUS : config v9.2 conservée (grid-search rate-limité par CoinGecko, données insuffisantes)
  { id: 'nexus',   backendId: 'multi',  name: 'NEXUS',   icon: '₿', holdMax: 15,
    sizingPct: 7, minQuality: 60, maxPositions: 5, pyramiding: 30, trailing: true },
  // VOLT : config Premium haute conviction conservée (kill switch + small size)
  { id: 'volt',    backendId: 'volt',   name: 'VOLT',    icon: '⚡', holdMax: 15,
    sizingPct: 5, minQuality: 75, maxPositions: 3, pyramiding: 0, trailing: true,
    killSwitchDd: -0.05, killSwitchPauseDays: 7 },
];

const ASSET_MAP = {
  // v6.9 — Map étendue 130+ actifs (synchro avec build-ai-study.mjs ASSETS)
  // Indices monde (24)
  'S&P 500': { kind: 'index', symbol: '^GSPC' }, 'Nasdaq': { kind: 'index', symbol: '^IXIC' },
  'Dow Jones': { kind: 'index', symbol: '^DJI' }, 'Russell 2000': { kind: 'index', symbol: '^RUT' },
  'CAC 40': { kind: 'index', symbol: '^FCHI' }, 'DAX': { kind: 'index', symbol: '^GDAXI' },
  'FTSE 100': { kind: 'index', symbol: '^FTSE' }, 'Euro Stoxx 50': { kind: 'index', symbol: '^STOXX50E' },
  'Nikkei 225': { kind: 'index', symbol: '^N225' }, 'Hang Seng': { kind: 'index', symbol: '^HSI' },
  'IBEX 35': { kind: 'index', symbol: '^IBEX' }, 'AEX Amsterdam': { kind: 'index', symbol: '^AEX' },
  'SMI Swiss': { kind: 'index', symbol: '^SSMI' }, 'OMX Stockholm': { kind: 'index', symbol: '^OMX' },
  'Sensex India': { kind: 'index', symbol: '^BSESN' }, 'KOSPI Corée': { kind: 'index', symbol: '^KS11' },
  'ASX 200 Australie': { kind: 'index', symbol: '^AXJO' }, 'Bovespa Brésil': { kind: 'index', symbol: '^BVSP' },
  'Taiwan': { kind: 'index', symbol: '^TWII' }, 'Mexico IPC': { kind: 'index', symbol: '^MXX' },
  'Shanghai': { kind: 'index', symbol: '000001.SS' }, 'Singapore STI': { kind: 'index', symbol: '^STI' },
  'Nifty 50 India': { kind: 'index', symbol: '^NSEI' }, 'JSE Top 40 Afrique du Sud': { kind: 'index', symbol: '^JN0U.JO' },
  // Crypto (28)
  'BTC': { kind: 'crypto', id: 'bitcoin' }, 'ETH': { kind: 'crypto', id: 'ethereum' },
  'SOL': { kind: 'crypto', id: 'solana' }, 'BNB': { kind: 'crypto', id: 'binancecoin' },
  'XRP': { kind: 'crypto', id: 'ripple' }, 'ADA': { kind: 'crypto', id: 'cardano' },
  'DOGE': { kind: 'crypto', id: 'dogecoin' }, 'AVAX': { kind: 'crypto', id: 'avalanche-2' },
  'DOT': { kind: 'crypto', id: 'polkadot' }, 'LINK': { kind: 'crypto', id: 'chainlink' },
  'TRX': { kind: 'crypto', id: 'tron' }, 'LTC': { kind: 'crypto', id: 'litecoin' },
  'UNI': { kind: 'crypto', id: 'uniswap' }, 'ATOM': { kind: 'crypto', id: 'cosmos' },
  'XLM': { kind: 'crypto', id: 'stellar' }, 'NEAR': { kind: 'crypto', id: 'near' },
  'BCH': { kind: 'crypto', id: 'bitcoin-cash' }, 'SHIB': { kind: 'crypto', id: 'shiba-inu' },
  'MATIC': { kind: 'crypto', id: 'matic-network' }, 'ARB': { kind: 'crypto', id: 'arbitrum' },
  'OP': { kind: 'crypto', id: 'optimism' }, 'APT': { kind: 'crypto', id: 'aptos' },
  'ICP': { kind: 'crypto', id: 'internet-computer' }, 'INJ': { kind: 'crypto', id: 'injective-protocol' },
  'RNDR': { kind: 'crypto', id: 'render-token' }, 'SUI': { kind: 'crypto', id: 'sui' },
  'PEPE': { kind: 'crypto', id: 'pepe' }, 'KAS': { kind: 'crypto', id: 'kaspa' },
  // Actions US tech & growth (20)
  'Apple': { kind: 'action', symbol: 'AAPL' }, 'Microsoft': { kind: 'action', symbol: 'MSFT' },
  'Alphabet': { kind: 'action', symbol: 'GOOGL' }, 'Amazon': { kind: 'action', symbol: 'AMZN' },
  'Meta': { kind: 'action', symbol: 'META' }, 'Nvidia': { kind: 'action', symbol: 'NVDA' },
  'Tesla': { kind: 'action', symbol: 'TSLA' }, 'AMD': { kind: 'action', symbol: 'AMD' },
  'Netflix': { kind: 'action', symbol: 'NFLX' }, 'Intel': { kind: 'action', symbol: 'INTC' },
  'Salesforce': { kind: 'action', symbol: 'CRM' }, 'Oracle': { kind: 'action', symbol: 'ORCL' },
  'IBM': { kind: 'action', symbol: 'IBM' }, 'Broadcom': { kind: 'action', symbol: 'AVGO' },
  'Qualcomm': { kind: 'action', symbol: 'QCOM' }, 'Adobe': { kind: 'action', symbol: 'ADBE' },
  'PayPal': { kind: 'action', symbol: 'PYPL' }, 'Uber': { kind: 'action', symbol: 'UBER' },
  'Shopify': { kind: 'action', symbol: 'SHOP' }, 'Palantir': { kind: 'action', symbol: 'PLTR' },
  // Actions US blue-chips & financières (12)
  'JPMorgan': { kind: 'action', symbol: 'JPM' }, 'Bank of America': { kind: 'action', symbol: 'BAC' },
  'Wells Fargo': { kind: 'action', symbol: 'WFC' }, 'Goldman Sachs': { kind: 'action', symbol: 'GS' },
  'Morgan Stanley': { kind: 'action', symbol: 'MS' }, 'BlackRock': { kind: 'action', symbol: 'BLK' },
  'Visa': { kind: 'action', symbol: 'V' }, 'Mastercard': { kind: 'action', symbol: 'MA' },
  'Berkshire': { kind: 'action', symbol: 'BRK-B' }, 'Walmart': { kind: 'action', symbol: 'WMT' },
  'Coca-Cola': { kind: 'action', symbol: 'KO' }, 'P&G': { kind: 'action', symbol: 'PG' },
  // Actions US consommation/santé/énergie (10)
  "McDonald's": { kind: 'action', symbol: 'MCD' }, 'Starbucks': { kind: 'action', symbol: 'SBUX' },
  'Costco': { kind: 'action', symbol: 'COST' }, 'Home Depot': { kind: 'action', symbol: 'HD' },
  'Nike': { kind: 'action', symbol: 'NKE' }, 'Disney': { kind: 'action', symbol: 'DIS' },
  'Johnson & J.': { kind: 'action', symbol: 'JNJ' }, 'Pfizer': { kind: 'action', symbol: 'PFE' },
  'Exxon': { kind: 'action', symbol: 'XOM' }, 'Chevron': { kind: 'action', symbol: 'CVX' },
  // Actions EU (10)
  'LVMH': { kind: 'action', symbol: 'MC.PA' }, 'TotalEnergies': { kind: 'action', symbol: 'TTE.PA' },
  'Airbus': { kind: 'action', symbol: 'AIR.PA' }, 'Sanofi': { kind: 'action', symbol: 'SAN.PA' },
  'BNP Paribas': { kind: 'action', symbol: 'BNP.PA' }, "L'Oréal": { kind: 'action', symbol: 'OR.PA' },
  'ASML': { kind: 'action', symbol: 'ASML.AS' }, 'SAP': { kind: 'action', symbol: 'SAP' },
  'Nestlé': { kind: 'action', symbol: 'NESN.SW' }, 'Novo Nordisk': { kind: 'action', symbol: 'NOVO-B.CO' },
  // ETF référence (10)
  'SPY (S&P 500 ETF)': { kind: 'action', symbol: 'SPY' }, 'QQQ (Nasdaq 100)': { kind: 'action', symbol: 'QQQ' },
  'IWM (Russell 2000)': { kind: 'action', symbol: 'IWM' }, 'VTI (Total US Market)': { kind: 'action', symbol: 'VTI' },
  'VEA (Developed ex-US)': { kind: 'action', symbol: 'VEA' }, 'VWO (Emerging Markets)': { kind: 'action', symbol: 'VWO' },
  'XLK Tech': { kind: 'action', symbol: 'XLK' }, 'XLF Finance': { kind: 'action', symbol: 'XLF' },
  'XLE Energy': { kind: 'action', symbol: 'XLE' }, 'GLD (Gold ETF)': { kind: 'action', symbol: 'GLD' },
  // Forex (10)
  'EUR/USD': { kind: 'forex', symbol: 'EURUSD=X' }, 'GBP/USD': { kind: 'forex', symbol: 'GBPUSD=X' },
  'USD/JPY': { kind: 'forex', symbol: 'USDJPY=X' }, 'USD/CHF': { kind: 'forex', symbol: 'USDCHF=X' },
  'AUD/USD': { kind: 'forex', symbol: 'AUDUSD=X' }, 'USD/CAD': { kind: 'forex', symbol: 'USDCAD=X' },
  'NZD/USD': { kind: 'forex', symbol: 'NZDUSD=X' }, 'EUR/GBP': { kind: 'forex', symbol: 'EURGBP=X' },
  'EUR/JPY': { kind: 'forex', symbol: 'EURJPY=X' }, 'USD/MXN': { kind: 'forex', symbol: 'USDMXN=X' },
  // Métaux & matières premières (10)
  'Or (Gold)': { kind: 'metal', symbol: 'GC=F' }, 'Argent (Silver)': { kind: 'metal', symbol: 'SI=F' },
  'Platine': { kind: 'metal', symbol: 'PL=F' }, 'Palladium': { kind: 'metal', symbol: 'PA=F' },
  'Cuivre': { kind: 'metal', symbol: 'HG=F' }, 'Pétrole WTI': { kind: 'metal', symbol: 'CL=F' },
  'Brent': { kind: 'metal', symbol: 'BZ=F' }, 'Gaz naturel': { kind: 'metal', symbol: 'NG=F' },
  'Blé': { kind: 'metal', symbol: 'ZW=F' }, 'Café': { kind: 'metal', symbol: 'KC=F' },
};

const _priceCache = new Map();
async function fetchCurrentPrice(assetLabel) {
  if (_priceCache.has(assetLabel)) return _priceCache.get(assetLabel);
  const m = ASSET_MAP[assetLabel];
  if (!m) { _priceCache.set(assetLabel, null); return null; }
  try {
    let p;
    if (m.kind === 'crypto') {
      const d = await fetchCoinGeckoHistorical(m.id, 5);
      p = d.price;
    } else {
      const d = await fetchYahooHistorical(m.symbol, '5d');
      p = d.price;
    }
    _priceCache.set(assetLabel, p);
    return p;
  } catch (e) {
    console.warn(`Price fetch failed ${assetLabel}: ${e.message}`);
    _priceCache.set(assetLabel, null);
    return null;
  }
}

async function loadOrInitPortfolio(filePath, sbConfig) {
  try {
    const txt = await fs.readFile(filePath, 'utf8');
    return JSON.parse(txt);
  } catch {
    return {
      version: '6.0',
      sandbox_id: sbConfig.id,
      backend_id: sbConfig.backendId,
      ia_name: sbConfig.name,
      icon: sbConfig.icon,
      created_at: new Date().toISOString(),
      capital_initial: CAPITAL_INITIAL,
      cash: CAPITAL_INITIAL,
      positions: [],
      closed_trades: [],
      equity_history: [],
      last_cycle: null,
    };
  }
}

function updatePosition(pos, currentPrice, dayOfCycle, holdMaxOverride) {
  const ageDays = dayOfCycle - (pos.opened_at_cycle || dayOfCycle);
  // v7.16 — timeout override par IA si défini (sinon MAX_HOLD_DAYS=60)
  const maxHold = holdMaxOverride != null ? holdMaxOverride : MAX_HOLD_DAYS;
  pos.current_price = currentPrice;
  pos.age_days = ageDays;
  // Trailing chandelier (v5.0)
  if (pos.high_since_entry == null || currentPrice > pos.high_since_entry) {
    pos.high_since_entry = currentPrice;
  }
  if (pos.touched_tp1 && pos.trailing_after_tp1) {
    const initialRisk = pos.entry - (pos.initial_stop || pos.entry * (1 - (pos.risk_pct || 0)));
    const chandStop = pos.high_since_entry - initialRisk;
    if (chandStop > pos.stop) pos.stop = chandStop;
  }
  if (currentPrice <= pos.stop) {
    let pnl;
    if (pos.trailing_active && pos.stop > pos.entry) {
      const gainSecondHalf = ((pos.stop - pos.entry) / pos.entry) * pos.size_eur * 0.5;
      pnl = pos.size_eur * pos.rr1 * 0.5 * pos.risk_pct + gainSecondHalf;
      pos.status = 'trail_profit';
    } else if (pos.touched_tp1) {
      pnl = pos.trailing_active
        ? pos.size_eur * pos.rr1 * 0.5 * pos.risk_pct
        : pos.size_eur * (pos.rr1 * 0.5 - 0.5) * pos.risk_pct;
      pos.status = pos.trailing_active ? 'partial_then_breakeven' : 'partial_then_stop';
    } else {
      pnl = -pos.size_eur * pos.risk_pct;
      pos.status = 'loss';
    }
    pos.closed_at = new Date().toISOString();
    pos.closed_at_cycle = dayOfCycle;
    pos.exit_price = pos.stop;
    pos.pnl_eur = pnl;
    return { action: pos.status, pnl_eur: pnl };
  }
  if (currentPrice >= pos.tp2) {
    pos.status = 'win';
    pos.closed_at = new Date().toISOString();
    pos.closed_at_cycle = dayOfCycle;
    pos.exit_price = pos.tp2;
    pos.pnl_eur = pos.size_eur * pos.rr2 * pos.risk_pct;
    return { action: 'tp2_hit', pnl_eur: pos.pnl_eur };
  }
  if (!pos.touched_tp1 && currentPrice >= pos.tp1) {
    pos.touched_tp1 = true;
    if (pos.trailing_after_tp1) {
      pos.stop = pos.entry;
      pos.trailing_active = true;
    }
    // v9.3 — Pyramiding : ajoute % à la position quand TP1 touché
    // (le cash additionnel sera prélevé du portfolio par le caller, ici on flag juste)
    if (pos.pyramiding_pct > 0 && !pos.pyramided) {
      pos.pyramided = true;
      pos.size_eur_added = pos.size_eur * (pos.pyramiding_pct / 100);
      // size_eur reste celui d'origine ; size_eur_added est cumulé en parallèle
      // (le caller portfolio.cash doit être décrémenté de size_eur_added)
    }
    return { action: pos.trailing_after_tp1 ? 'tp1_partial_breakeven' : 'tp1_partial', pnl_eur: 0 };
  }
  if (ageDays >= maxHold) {
    pos.status = 'timeout';
    pos.closed_at = new Date().toISOString();
    pos.closed_at_cycle = dayOfCycle;
    pos.exit_price = currentPrice;
    const pnl_pct = (currentPrice - pos.entry) / pos.entry;
    pos.pnl_eur = pos.size_eur * pnl_pct;
    return { action: 'timeout', pnl_eur: pos.pnl_eur };
  }
  return { action: 'hold', pnl_eur: 0 };
}

function selectSetupsFor(aiStudy, portfolio, backendId, minQualityOverride) {
  const setups = [];
  if (Array.isArray(aiStudy.agents)) {
    aiStudy.agents.forEach(agent => {
      // Pour NEXUS (backendId='multi'), on prend les setups de tous les agents
      // mais SEULEMENT sur les actifs crypto
      if (backendId === 'multi') {
        if (Array.isArray(agent.setups)) {
          agent.setups
            .filter(s => s.kind === 'crypto')
            .forEach(s => setups.push({ ...s, agent_id: agent.id }));
        }
        return;
      }
      // Pour BASTION/PHÉNIX/RAFALE/VOLT : que les setups de l'agent backend correspondant
      if (agent.id !== backendId) return;
      if (Array.isArray(agent.setups)) {
        agent.setups.forEach(s => setups.push({ ...s, agent_id: agent.id }));
      }
    });
  }
  // Dédoublonne par actif (garde best quality)
  const byAsset = {};
  setups.forEach(s => {
    if (!byAsset[s.asset] || (s.quality_score || 0) > (byAsset[s.asset].quality_score || 0)) {
      byAsset[s.asset] = s;
    }
  });
  const minQ = minQualityOverride != null ? minQualityOverride : MIN_QUALITY_TO_OPEN;
  const openedAssets = new Set(portfolio.positions.filter(p => p.status === 'open').map(p => p.asset));
  return Object.values(byAsset)
    .filter(s => (s.quality_score || 0) >= minQ)
    .filter(s => !openedAssets.has(s.asset))
    .filter(s => ASSET_MAP[s.asset])
    .sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0));
}

function computeStats(portfolio) {
  const closed = portfolio.closed_trades || [];
  const wins = closed.filter(t => (t.pnl_eur || 0) > 0);
  const losses = closed.filter(t => (t.pnl_eur || 0) <= 0);
  const totalProfit = wins.reduce((s, t) => s + t.pnl_eur, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl_eur, 0));
  const pf = totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? 999 : 0);
  const winRate = closed.length > 0 ? wins.length / closed.length : 0;
  const eq = portfolio.equity_history || [];
  let maxEq = CAPITAL_INITIAL, maxDd = 0;
  eq.forEach(p => {
    if (p.equity > maxEq) maxEq = p.equity;
    const dd = (p.equity - maxEq) / maxEq;
    if (dd < maxDd) maxDd = dd;
  });
  const currentEquity = eq.length ? eq[eq.length - 1].equity : CAPITAL_INITIAL;
  return {
    sandbox_id: portfolio.sandbox_id,
    ia_name: portfolio.ia_name,
    trades_closed: closed.length,
    trades_open: portfolio.positions.filter(p => p.status === 'open').length,
    win_rate: Number(winRate.toFixed(3)),
    profit_factor: Number(pf.toFixed(2)),
    total_return_pct: Number(((currentEquity - CAPITAL_INITIAL) / CAPITAL_INITIAL * 100).toFixed(2)),
    max_drawdown_pct: Number((maxDd * 100).toFixed(2)),
    equity_current: Number(currentEquity.toFixed(2)),
    equity_high: Number(maxEq.toFixed(2)),
    cash: Number(portfolio.cash.toFixed(2)),
  };
}

async function runOneSandbox(sbConfig, aiStudy, today, dayOfCycle) {
  const portFile = path.join(SANDBOX_DIR, `portfolio_${sbConfig.id}.json`);
  const statsFile = path.join(SANDBOX_DIR, `stats_${sbConfig.id}.json`);
  const portfolio = await loadOrInitPortfolio(portFile, sbConfig);

  console.log(`\n=== ${sbConfig.icon} ${sbConfig.name} (cycle ${dayOfCycle}) ===`);

  // 1) UPDATE positions OPEN
  const openPositions = portfolio.positions.filter(p => p.status === 'open');
  for (const pos of openPositions) {
    const cur = await fetchCurrentPrice(pos.asset);
    if (cur == null) { console.log(`  ${pos.asset}: price unavailable`); continue; }
    const wasPyramided = pos.pyramided === true;
    const r = updatePosition(pos, cur, dayOfCycle, sbConfig.holdMax);
    // v9.3 — Pyramiding : si la position vient d'être pyramidée (size_eur_added set), prélève le cash
    if (!wasPyramided && pos.pyramided && pos.size_eur_added > 0) {
      const addedCash = Math.min(pos.size_eur_added, portfolio.cash * 0.95);
      portfolio.cash -= addedCash;
      pos.size_eur += addedCash; // taille totale réelle = entry + pyramiding
      console.log(`  ${pos.asset}: PYRAMIDED +${addedCash.toFixed(2)}€ (total size ${pos.size_eur.toFixed(2)}€)`);
    }
    console.log(`  ${pos.asset}: ${r.action} (cur=${cur.toFixed(2)} entry=${pos.entry.toFixed(2)} pnl=${(r.pnl_eur || 0).toFixed(2)}€)`);
    if (pos.status !== 'open') {
      portfolio.cash += pos.size_eur + (r.pnl_eur || 0);
      portfolio.closed_trades.push(pos);
    }
  }
  portfolio.positions = portfolio.positions.filter(p => p.status === 'open');

  // 2) Kelly-light streak (v5.0)
  const recent5 = (portfolio.closed_trades || []).slice(-5);
  let streakMult = 1;
  if (recent5.length >= 3) {
    const last3 = recent5.slice(-3);
    if (last3.every(t => (t.pnl_eur || 0) > 0)) streakMult = 1.2;
    else if (last3.every(t => (t.pnl_eur || 0) <= 0)) streakMult = 0.7;
  }

  // 3) OPEN nouvelles positions
  // v7.11 — override maxPositions/minQuality si la sandbox le définit (VOLT : 3 max, Q≥75)
  const maxPosForSb = sbConfig.maxPositions != null ? sbConfig.maxPositions : MAX_POSITIONS;
  const slotsAvailable = maxPosForSb - portfolio.positions.length;

  // v7.14 — KILL SWITCH VOLT : si DD intra-fold récent ≤ -5%, pause 7j (skip nouveaux trades)
  let killSwitchActive = false;
  if (sbConfig.killSwitchDd != null && Array.isArray(portfolio.equity_history) && portfolio.equity_history.length >= 2) {
    const recentHist = portfolio.equity_history.slice(-30);  // 30 derniers cycles
    const maxRecent = Math.max(...recentHist.map(p => p.equity));
    const lastEq = recentHist[recentHist.length - 1].equity;
    const ddCurrent = (lastEq - maxRecent) / maxRecent;
    if (ddCurrent <= sbConfig.killSwitchDd) {
      // Vérifie si la pause est encore active
      const pauseDays = sbConfig.killSwitchPauseDays || 7;
      const triggerCycle = recentHist.findIndex(p => (p.equity - maxRecent) / maxRecent <= sbConfig.killSwitchDd);
      if (triggerCycle >= 0) {
        const cyclesSinceTrigger = recentHist.length - 1 - triggerCycle;
        if (cyclesSinceTrigger < pauseDays) {
          killSwitchActive = true;
          console.log(`  ⛔ KILL SWITCH actif (DD ${(ddCurrent*100).toFixed(1)}% ≤ -5%) — pause ${pauseDays - cyclesSinceTrigger}j restants, skip nouveaux trades`);
        }
      }
    }
  }

  if (!killSwitchActive && slotsAvailable > 0 && portfolio.cash > 1) {
    const candidates = selectSetupsFor(aiStudy, portfolio, sbConfig.backendId, sbConfig.minQuality);
    console.log(`  ${candidates.length} candidates, ${slotsAvailable} slots, cash=${portfolio.cash.toFixed(2)}€ · Kelly=${streakMult}`);
    for (const s of candidates.slice(0, slotsAvailable)) {
      // v9.3 — sizingPct override par sandbox (grid-search winner)
      const sizingPctFinal = sbConfig.sizingPct != null ? sbConfig.sizingPct : (s.sizing_pct || 1);
      const sizing_pct = (sizingPctFinal * streakMult) / 100;
      const size_eur = portfolio.cash * sizing_pct;
      if (size_eur < 1) continue;
      const risk_pct = Math.abs(s.entry - s.stop) / s.entry;
      portfolio.cash -= size_eur;
      portfolio.positions.push({
        id: 'pos-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        asset: s.asset, kind: s.kind, agent: s.agent_id, type: s.type,
        entry: s.entry, stop: s.stop, tp1: s.tp1, tp2: s.tp2,
        initial_stop: s.stop, high_since_entry: s.entry,
        rr1: Number(s.rr1) || 0, rr2: Number(s.rr2) || 0,
        risk_pct, size_eur,
        quality_score: s.quality_score || null,
        sizing_pct: sizingPctFinal,
        // v9.3 — trailing forcé par sandbox config (override setup)
        trailing_after_tp1: sbConfig.trailing === true || s.trailing_after_tp1 === true,
        trailing_active: false,
        // v9.3 — pyramiding : % ajouté quand TP1 touché (0 = off)
        pyramiding_pct: sbConfig.pyramiding || 0,
        pyramided: false,
        stacked: s.stacked === true,
        opened_at: new Date().toISOString(),
        opened_at_cycle: dayOfCycle,
        opened_at_date: today,
        status: 'open',
        touched_tp1: false,
        closed_at: null, pnl_eur: null,
      });
      console.log(`  OPEN ${s.asset} ${s.type} size=${size_eur.toFixed(2)}€ Q=${s.quality_score}`);
    }
  }

  // 4) Compute equity
  let equity = portfolio.cash;
  for (const p of portfolio.positions) {
    const cur = p.current_price || p.entry;
    equity += p.size_eur * (cur / p.entry);
  }
  portfolio.equity_history.push({
    date: today, cycle: dayOfCycle,
    equity: Number(equity.toFixed(2)),
    cash: Number(portfolio.cash.toFixed(2)),
    positions_count: portfolio.positions.length,
  });
  portfolio.last_cycle = today;

  // 5) Save
  await fs.writeFile(portFile, JSON.stringify(portfolio, null, 2) + '\n');
  const stats = computeStats(portfolio);
  await fs.writeFile(statsFile, JSON.stringify({
    generated: new Date().toISOString(),
    date: today,
    ...stats,
  }, null, 2) + '\n');

  console.log(`  → Equity ${stats.equity_current}€ (${stats.total_return_pct >= 0 ? '+' : ''}${stats.total_return_pct}%) · ${stats.trades_closed} clos · ${stats.trades_open} open · DD ${stats.max_drawdown_pct}%`);
  return stats;
}

async function main() {
  console.log('=== Sandbox MULTI v7.11 · 5×1000€ (+ VOLT haute conviction) ===');
  await fs.mkdir(SANDBOX_DIR, { recursive: true });
  await fs.mkdir(SNAPSHOTS_DIR, { recursive: true });

  const aiStudy = JSON.parse(await fs.readFile(AI_STUDY_FILE, 'utf8'));
  const today = new Date().toISOString().slice(0, 10);
  // dayOfCycle = max equity_history length parmi les 4 portfolios + 1
  let maxCycle = 0;
  for (const sb of SANDBOXES) {
    try {
      const p = JSON.parse(await fs.readFile(path.join(SANDBOX_DIR, `portfolio_${sb.id}.json`), 'utf8'));
      maxCycle = Math.max(maxCycle, p.equity_history?.length || 0);
    } catch {}
  }
  const dayOfCycle = maxCycle + 1;

  // Snapshot du jour
  const snapshotFile = path.join(SNAPSHOTS_DIR, today + '.json');
  await fs.writeFile(snapshotFile, JSON.stringify({
    date: today, cycle: dayOfCycle,
    ai_study_generated: aiStudy.generated,
    macro: aiStudy.macro || null,
    setups_count: (aiStudy.agents || []).reduce((s, a) => s + (a.count || 0), 0),
  }, null, 2));

  const allStats = [];
  for (const sb of SANDBOXES) {
    const s = await runOneSandbox(sb, aiStudy, today, dayOfCycle);
    allStats.push(s);
  }

  // Récap final
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║ RÉCAP MULTI-SANDBOX · 4 IA × 1000€');
  console.log('╠═══════════════════════════════════════════════════════════════╣');
  console.log('║ IA       │ Equity    │ Return  │ PF   │ DD     │ Open │ Clos ║');
  console.log('╟──────────┼───────────┼─────────┼──────┼────────┼──────┼──────╢');
  for (const s of allStats) {
    const ret = (s.total_return_pct >= 0 ? '+' : '') + s.total_return_pct + '%';
    console.log(`║ ${s.ia_name.padEnd(8)} │ ${s.equity_current.toFixed(2).padStart(8)}€ │ ${ret.padStart(7)} │ ${s.profit_factor.toFixed(2).padStart(4)} │ ${s.max_drawdown_pct.toFixed(2).padStart(6)}%│ ${s.trades_open.toString().padStart(4)} │ ${s.trades_closed.toString().padStart(4)} ║`);
  }
  console.log('╚═══════════════════════════════════════════════════════════════╝');

  // Aggregate global stats
  const total = allStats.reduce((acc, s) => ({
    equity_total: (acc.equity_total || 0) + s.equity_current,
    trades_total: (acc.trades_total || 0) + s.trades_closed,
    trades_open: (acc.trades_open || 0) + s.trades_open,
  }), {});
  await fs.writeFile(path.join(SANDBOX_DIR, 'multi_summary.json'), JSON.stringify({
    generated: new Date().toISOString(),
    date: today,
    capital_initial_per_sandbox: CAPITAL_INITIAL,
    sandboxes: allStats,
    aggregate: total,
  }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
