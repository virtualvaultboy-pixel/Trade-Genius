#!/usr/bin/env node
/**
 * Trade Genius — v4.5 SANDBOX TRADING virtuelle 100€
 *
 * Mécanisme :
 *   1. Lit data/ai-study.json (généré par build-ai-study, contient les setups
 *      du jour avec quality_score, sizing_pct, trailing_after_tp1...)
 *   2. Lit data/sandbox/portfolio.json (ou crée si premier run, capital 100€)
 *   3. UPDATE positions OPEN avec prix du jour :
 *        - si current_price <= stop : close en LOSS (ou breakeven si trailing)
 *        - si current_price >= tp2  : close en WIN
 *        - si current_price >= tp1 ET trailing_after_tp1 : move stop=entry
 *        - sinon : update current_price + age
 *   4. OPEN nouvelles positions sur les meilleurs setups (max 5 simultanées,
 *      sizing_pct du capital actuel par trade, priorité quality_score)
 *   5. Calcule equity = cash + sum(position_size × (current/entry))
 *   6. Append point à equity_history, met à jour stats globales
 *   7. Sauve portfolio.json + stats.json
 *
 * L'IA "humaine discipliné" : suit STRICTEMENT les niveaux du setup, jamais
 * d'override émotionnel, jamais de "je tiens encore", jamais d'overtrade.
 *
 * Tourne via .github/workflows/sandbox-cycle.yml (1× par jour, après close US)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchYahooHistorical, fetchCoinGeckoHistorical } from './indicators.mjs';

const SANDBOX_DIR = path.join(process.cwd(), 'data', 'sandbox');
const PORTFOLIO_FILE = path.join(SANDBOX_DIR, 'portfolio.json');
const STATS_FILE = path.join(SANDBOX_DIR, 'stats.json');
const SNAPSHOTS_DIR = path.join(SANDBOX_DIR, 'snapshots');
const AI_STUDY_FILE = path.join(process.cwd(), 'data', 'ai-study.json');

const CAPITAL_INITIAL = 100; // euros virtuels
const MAX_POSITIONS = 5;
const MIN_QUALITY_TO_OPEN = 65; // refuse setups quality < 65
const MAX_HOLD_DAYS = 60; // timeout

// Map asset label → fetch source (Yahoo symbol ou CoinGecko id)
const ASSET_MAP = {
  'S&P 500': { kind: 'index', symbol: '^GSPC' },
  'Nasdaq': { kind: 'index', symbol: '^IXIC' },
  'Dow Jones': { kind: 'index', symbol: '^DJI' },
  'Russell 2000': { kind: 'index', symbol: '^RUT' },
  'CAC 40': { kind: 'index', symbol: '^FCHI' },
  'DAX': { kind: 'index', symbol: '^GDAXI' },
  'FTSE 100': { kind: 'index', symbol: '^FTSE' },
  'Euro Stoxx 50': { kind: 'index', symbol: '^STOXX50E' },
  'Nikkei 225': { kind: 'index', symbol: '^N225' },
  'Hang Seng': { kind: 'index', symbol: '^HSI' },
  'BTC': { kind: 'crypto', id: 'bitcoin' },
  'ETH': { kind: 'crypto', id: 'ethereum' },
  'SOL': { kind: 'crypto', id: 'solana' },
  'BNB': { kind: 'crypto', id: 'binancecoin' },
  'XRP': { kind: 'crypto', id: 'ripple' },
  'ADA': { kind: 'crypto', id: 'cardano' },
  'DOGE': { kind: 'crypto', id: 'dogecoin' },
  'AVAX': { kind: 'crypto', id: 'avalanche-2' },
  'DOT': { kind: 'crypto', id: 'polkadot' },
  'LINK': { kind: 'crypto', id: 'chainlink' },
  'Apple': { kind: 'action', symbol: 'AAPL' },
  'Microsoft': { kind: 'action', symbol: 'MSFT' },
  'Alphabet': { kind: 'action', symbol: 'GOOGL' },
  'Amazon': { kind: 'action', symbol: 'AMZN' },
  'Meta': { kind: 'action', symbol: 'META' },
  'Nvidia': { kind: 'action', symbol: 'NVDA' },
  'Tesla': { kind: 'action', symbol: 'TSLA' },
  'JPMorgan': { kind: 'action', symbol: 'JPM' },
  'Visa': { kind: 'action', symbol: 'V' },
  'Berkshire': { kind: 'action', symbol: 'BRK-B' },
  'Walmart': { kind: 'action', symbol: 'WMT' },
  'Johnson & J.': { kind: 'action', symbol: 'JNJ' },
  'Exxon': { kind: 'action', symbol: 'XOM' },
  'P&G': { kind: 'action', symbol: 'PG' },
  'Coca-Cola': { kind: 'action', symbol: 'KO' },
  'Netflix': { kind: 'action', symbol: 'NFLX' },
  'LVMH': { kind: 'action', symbol: 'MC.PA' },
  'ASML': { kind: 'action', symbol: 'ASML.AS' },
  'Nestlé': { kind: 'action', symbol: 'NESN.SW' },
  'EUR/USD': { kind: 'forex', symbol: 'EURUSD=X' },
  'GBP/USD': { kind: 'forex', symbol: 'GBPUSD=X' },
  'USD/JPY': { kind: 'forex', symbol: 'USDJPY=X' },
  'Or': { kind: 'metal', symbol: 'GC=F' },
  'Argent': { kind: 'metal', symbol: 'SI=F' },
  'Cuivre': { kind: 'metal', symbol: 'HG=F' },
  'Pétrole': { kind: 'metal', symbol: 'CL=F' },
};

async function fetchCurrentPrice(assetLabel) {
  const m = ASSET_MAP[assetLabel];
  if (!m) return null;
  try {
    if (m.kind === 'crypto') {
      const d = await fetchCoinGeckoHistorical(m.id, 5);
      return d.price;
    }
    const d = await fetchYahooHistorical(m.symbol, '5d');
    return d.price;
  } catch (e) {
    console.warn(`Price fetch failed ${assetLabel}: ${e.message}`);
    return null;
  }
}

async function loadOrInitPortfolio() {
  try {
    const txt = await fs.readFile(PORTFOLIO_FILE, 'utf8');
    return JSON.parse(txt);
  } catch {
    return {
      version: '4.5',
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

async function loadAiStudy() {
  const txt = await fs.readFile(AI_STUDY_FILE, 'utf8');
  return JSON.parse(txt);
}

/**
 * Update une position OPEN avec le prix courant.
 * Renvoie {action, pnl_eur} où action est 'hold', 'tp1_partial',
 * 'stop_hit', 'tp2_hit', 'timeout', 'trailing_breakeven'.
 */
function updatePosition(pos, currentPrice, dayOfCycle) {
  const ageDays = dayOfCycle - (pos.opened_at_cycle || dayOfCycle);
  pos.current_price = currentPrice;
  pos.age_days = ageDays;

  // v5.0 — Track high_since_entry pour trailing chandelier
  if (pos.high_since_entry == null || currentPrice > pos.high_since_entry) {
    pos.high_since_entry = currentPrice;
  }

  // v5.0 — TRAILING CHANDELIER : après TP1 touché, le stop trail à
  // (high_since_entry - 1×risk_initial) au lieu de rester à breakeven fixe.
  // Capture plus de gain quand la tendance se prolonge longtemps.
  if (pos.touched_tp1 && pos.trailing_after_tp1) {
    const initialRisk = pos.entry - (pos.initial_stop || pos.entry * (1 - (pos.risk_pct || 0)));
    const chandStop = pos.high_since_entry - initialRisk;
    // Jamais reculer le stop (monotone), jamais sous l'entry
    if (chandStop > pos.stop) pos.stop = chandStop;
  }

  // Stop touché
  if (currentPrice <= pos.stop) {
    pos.status = pos.touched_tp1 ? 'partial_then_stop' : (pos.trailing_active ? 'partial_then_breakeven' : 'loss');
    pos.closed_at = new Date().toISOString();
    pos.closed_at_cycle = dayOfCycle;
    pos.exit_price = pos.stop; // approximation conservatrice
    // PnL eur : on a alloué size_eur au trade. Le pnl_pct est calculé selon
    // qu'on ait scratché la 2e moitié ou tout perdu.
    if (pos.trailing_active && pos.touched_tp1) {
      // 1ère moitié vendue à TP1 (gain = rr1 * 0.5 * risk_pct), 2e moitié scratchée à entry (0)
      const gain_pct = pos.rr1 * 0.5 * (pos.risk_pct || 0); // proportion du size
      pos.pnl_eur = pos.size_eur * gain_pct;
    } else if (pos.touched_tp1) {
      // 1ère moitié vendue à TP1, 2e moitié perdue au stop original
      const gain_pct = (pos.rr1 * 0.5 - 0.5) * (pos.risk_pct || 0);
      pos.pnl_eur = pos.size_eur * gain_pct;
    } else {
      // Stop full = perte = -risk_pct du size
      pos.pnl_eur = -pos.size_eur * (pos.risk_pct || 0);
    }
    return { action: pos.status, pnl_eur: pos.pnl_eur };
  }

  // TP2 touché
  if (currentPrice >= pos.tp2) {
    pos.status = 'win';
    pos.closed_at = new Date().toISOString();
    pos.closed_at_cycle = dayOfCycle;
    pos.exit_price = pos.tp2;
    pos.pnl_eur = pos.size_eur * pos.rr2 * (pos.risk_pct || 0);
    return { action: 'tp2_hit', pnl_eur: pos.pnl_eur };
  }

  // TP1 touché — trailing stop si activé
  if (!pos.touched_tp1 && currentPrice >= pos.tp1) {
    pos.touched_tp1 = true;
    if (pos.trailing_after_tp1) {
      pos.stop = pos.entry; // move to breakeven
      pos.trailing_active = true;
      return { action: 'tp1_partial_breakeven', pnl_eur: 0 };
    }
    return { action: 'tp1_partial', pnl_eur: 0 };
  }

  // Timeout
  if (ageDays >= MAX_HOLD_DAYS) {
    pos.status = 'timeout';
    pos.closed_at = new Date().toISOString();
    pos.closed_at_cycle = dayOfCycle;
    pos.exit_price = currentPrice;
    const pnl_pct = (currentPrice - pos.entry) / pos.entry;
    pos.pnl_eur = pos.size_eur * pnl_pct; // pnl proportionnel au mouvement
    return { action: 'timeout', pnl_eur: pos.pnl_eur };
  }

  return { action: 'hold', pnl_eur: 0 };
}

/**
 * Choisit les setups à ouvrir parmi ceux de ai-study.
 * Critères : quality_score >= MIN_QUALITY, sizing_pct disponible,
 * pas déjà une position sur ce même asset (évite duplications).
 */
function selectSetupsToOpen(aiStudy, portfolio) {
  const setups = [];
  if (Array.isArray(aiStudy.agents)) {
    aiStudy.agents.forEach(agent => {
      if (Array.isArray(agent.setups)) {
        agent.setups.forEach(s => setups.push({ ...s, agent_id: agent.id }));
      }
    });
  }
  // Dédoublonne par asset (garde le meilleur quality_score)
  const byAsset = {};
  setups.forEach(s => {
    if (!byAsset[s.asset] || (s.quality_score || 0) > (byAsset[s.asset].quality_score || 0)) {
      byAsset[s.asset] = s;
    }
  });
  // Filtre : quality >= seuil, pas déjà open
  const openedAssets = new Set(portfolio.positions.filter(p => p.status === 'open').map(p => p.asset));
  return Object.values(byAsset)
    .filter(s => (s.quality_score || 0) >= MIN_QUALITY_TO_OPEN)
    .filter(s => !openedAssets.has(s.asset))
    .filter(s => ASSET_MAP[s.asset]) // doit être dans notre map
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
  const equityHist = portfolio.equity_history || [];
  let maxEquity = CAPITAL_INITIAL;
  let maxDd = 0;
  equityHist.forEach(p => {
    if (p.equity > maxEquity) maxEquity = p.equity;
    const dd = (p.equity - maxEquity) / maxEquity;
    if (dd < maxDd) maxDd = dd;
  });
  const currentEquity = equityHist.length ? equityHist[equityHist.length - 1].equity : CAPITAL_INITIAL;
  const totalReturn = (currentEquity - CAPITAL_INITIAL) / CAPITAL_INITIAL;
  return {
    trades_closed: closed.length,
    trades_open: portfolio.positions.filter(p => p.status === 'open').length,
    win_rate: Number(winRate.toFixed(3)),
    profit_factor: Number(pf.toFixed(2)),
    total_return_pct: Number((totalReturn * 100).toFixed(2)),
    max_drawdown_pct: Number((maxDd * 100).toFixed(2)),
    equity_current: Number(currentEquity.toFixed(2)),
    equity_high: Number(maxEquity.toFixed(2)),
    cash: Number(portfolio.cash.toFixed(2)),
  };
}

async function main() {
  console.log('=== Sandbox cycle v4.5 ===');
  await fs.mkdir(SANDBOX_DIR, { recursive: true });
  await fs.mkdir(SNAPSHOTS_DIR, { recursive: true });

  const portfolio = await loadOrInitPortfolio();
  const aiStudy = await loadAiStudy();
  const today = new Date().toISOString().slice(0, 10);
  const dayOfCycle = (portfolio.equity_history?.length || 0) + 1;

  // Snapshot du jour (lecture seule, on archive le state)
  const snapshotFile = path.join(SNAPSHOTS_DIR, today + '.json');
  await fs.writeFile(snapshotFile, JSON.stringify({
    date: today,
    cycle: dayOfCycle,
    ai_study_generated: aiStudy.generated,
    macro: aiStudy.macro || null,
    setups_count: (aiStudy.agents || []).reduce((s, a) => s + (a.count || 0), 0),
  }, null, 2));

  // ── 1) UPDATE positions OPEN ────────────────────────────────
  const openPositions = portfolio.positions.filter(p => p.status === 'open');
  console.log(`Updating ${openPositions.length} open positions...`);
  for (const pos of openPositions) {
    const cur = await fetchCurrentPrice(pos.asset);
    if (cur == null) {
      console.log(`  ${pos.asset}: price unavailable, skip`);
      continue;
    }
    const r = updatePosition(pos, cur, dayOfCycle);
    console.log(`  ${pos.asset}: ${r.action} (cur=${cur.toFixed(2)} entry=${pos.entry.toFixed(2)} pnl=${r.pnl_eur.toFixed(2)}€)`);
    // Si position fermée → déplace dans closed_trades + libère le cash
    if (pos.status !== 'open') {
      portfolio.cash += pos.size_eur + (r.pnl_eur || 0);
      portfolio.closed_trades.push(pos);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  // Filtre les positions still open
  portfolio.positions = portfolio.positions.filter(p => p.status === 'open');

  // ── 2) OPEN nouvelles positions ─────────────────────────────
  // v5.0 — Kelly-light : adapte le sizing selon les performances récentes
  // (5 derniers trades). Boost +20% après 3 wins consécutifs, réduit -30%
  // après 3 losses consécutifs. Préserve le capital quand on est dans une
  // mauvaise passe statistique.
  const recent5 = (portfolio.closed_trades || []).slice(-5);
  let streakMult = 1;
  if (recent5.length >= 3) {
    const last3 = recent5.slice(-3);
    const allWins = last3.every(t => (t.pnl_eur || 0) > 0);
    const allLosses = last3.every(t => (t.pnl_eur || 0) <= 0);
    if (allWins) streakMult = 1.2;
    else if (allLosses) streakMult = 0.7;
  }

  const slotsAvailable = MAX_POSITIONS - portfolio.positions.length;
  if (slotsAvailable > 0 && portfolio.cash > 1) {
    const candidates = selectSetupsToOpen(aiStudy, portfolio);
    console.log(`${candidates.length} candidates, ${slotsAvailable} slots, cash=${portfolio.cash.toFixed(2)}€ · Kelly mult=${streakMult}`);
    for (const s of candidates.slice(0, slotsAvailable)) {
      const sizing_pct = ((s.sizing_pct || 1) * streakMult) / 100; // v5.0 Kelly adapté
      const size_eur = portfolio.cash * sizing_pct;
      if (size_eur < 1) continue; // trop petit
      const risk_pct = Math.abs(s.entry - s.stop) / s.entry;
      portfolio.cash -= size_eur;
      portfolio.positions.push({
        id: 'pos-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        asset: s.asset, kind: s.kind, agent: s.agent_id, type: s.type,
        entry: s.entry, stop: s.stop, tp1: s.tp1, tp2: s.tp2,
        // v5.0 — initial_stop conservé pour calculer le trailing chandelier
        initial_stop: s.stop,
        high_since_entry: s.entry,
        rr1: Number(s.rr1) || 0, rr2: Number(s.rr2) || 0,
        risk_pct, size_eur,
        quality_score: s.quality_score || null,
        sizing_pct: s.sizing_pct,
        trailing_after_tp1: s.trailing_after_tp1 === true,
        trailing_active: false,
        stacked: s.stacked === true,
        opened_at: new Date().toISOString(),
        opened_at_cycle: dayOfCycle,
        opened_at_date: today,
        status: 'open',
        touched_tp1: false,
        closed_at: null,
        pnl_eur: null,
      });
      console.log(`  OPEN ${s.asset} ${s.type} size=${size_eur.toFixed(2)}€ Q=${s.quality_score}`);
    }
  }

  // ── 3) Compute equity ───────────────────────────────────────
  let equity = portfolio.cash;
  for (const p of portfolio.positions) {
    const cur = p.current_price || p.entry;
    equity += p.size_eur * (cur / p.entry);
  }
  portfolio.equity_history.push({
    date: today,
    cycle: dayOfCycle,
    equity: Number(equity.toFixed(2)),
    cash: Number(portfolio.cash.toFixed(2)),
    positions_count: portfolio.positions.length,
  });

  portfolio.last_cycle = today;

  // ── 4) Save ────────────────────────────────────────────────
  await fs.writeFile(PORTFOLIO_FILE, JSON.stringify(portfolio, null, 2) + '\n');
  const stats = computeStats(portfolio);
  await fs.writeFile(STATS_FILE, JSON.stringify({
    generated: new Date().toISOString(),
    date: today,
    ...stats,
  }, null, 2) + '\n');

  console.log('\n=== Stats ===');
  console.log(JSON.stringify(stats, null, 2));
}

main().catch(e => {
  console.error('sandbox-cycle failed:', e);
  process.exit(1);
});
