/**
 * tg-winner.js — v1.0
 *
 * TG Winner : panier mensuel rebalance auto (data/tg-winner.json).
 *
 * Genere par scripts/build-tg-winner.mjs + workflow tg-winner.yml :
 *   - Cron mensuel le 1er a 06:00 UTC
 *   - Refresh prices Yahoo + FX EUR/USD frankfurter
 *   - Recalcul exempleAllocations 1k EUR / 10k EUR
 *
 * Strategie validee :
 *   Mix 50% B&H safe (SPY 60 / TLT 30 / GLD 10)
 * + 50% META 3 IAs leveraged
 *
 * Backtest 2016-09 -> 2026-01 :
 *   23.1%/an, DD -33.2%, Calmar 0.69, MC P(profit) 100%
 *
 * Expose : window.TGWinner.{ load, render, getStatus, formatBasket }
 *
 * Pas de dependance. Lecture localStorage pour tracker user.
 */
(function () {
  'use strict';

  const DATA_URL = 'data/tg-winner.json';
  const LS_KEY_HOLDINGS = 'tg.winner.holdings.v1';
  const LS_KEY_CAPITAL = 'tg.winner.capital.v1';
  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

  let _cache = null;
  let _cacheTs = 0;
  let _inflight = null;

  // ────────────────────────────────────────────────────────────────────
  // Loader
  // ────────────────────────────────────────────────────────────────────
  /**
   * Fetch le JSON winner. Cache memoire 5 min pour eviter spam reseau.
   * Retourne null si echec total (pas de panic UI).
   */
  async function load({ force = false } = {}) {
    const now = Date.now();
    if (!force && _cache && now - _cacheTs < CACHE_TTL_MS) return _cache;
    if (_inflight) return _inflight;
    _inflight = (async () => {
      try {
        const r = await fetch(DATA_URL + '?t=' + now, { cache: 'no-cache' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (!j || !Array.isArray(j.basket)) throw new Error('payload invalide');
        _cache = j;
        _cacheTs = now;
        return j;
      } catch (e) {
        console.warn('[TGWinner] load failed:', e.message);
        return null;
      } finally {
        _inflight = null;
      }
    })();
    return _inflight;
  }

  // ────────────────────────────────────────────────────────────────────
  // FX helpers
  // ────────────────────────────────────────────────────────────────────
  /**
   * Recupere taux EUR->USD :
   *   1) window.TG.fxRates.EUR_USD (cf tg-common.js v2.57, warm-up FX global)
   *   2) winner.fx.eurToUsd (snapshot du dernier build GH Actions)
   *   3) fallback 1.087 (moyenne approx 2025-2026)
   *
   * window.TG.fxRates est rempli par tg-common.js apres warm-up async ; pas
   * garanti d etre dispo a l init de tg-winner.js. On retombe alors sur le
   * snapshot, qui est deja a jour (<24h en moyenne).
   */
  function getEurUsdRate(winner) {
    try {
      const r = window?.TG?.fxRates;
      if (r && !r.fallback && typeof r.EUR_USD === 'number' && r.EUR_USD > 0.5 && r.EUR_USD < 2) {
        return r.EUR_USD;
      }
    } catch { /* ignore */ }
    if (winner?.fx?.eurToUsd) return Number(winner.fx.eurToUsd);
    return 1.087;
  }

  /**
   * Ecoute le warm-up FX de tg-common.js pour invalider le cache memoire
   * (force un re-render si TGWinner.load() etait deja appele avant que le
   * taux live arrive).
   */
  if (typeof window !== 'undefined') {
    window.addEventListener('tg-fx-ready', () => { _cacheTs = 0; });
  }

  // ────────────────────────────────────────────────────────────────────
  // Allocation calculus
  // ────────────────────────────────────────────────────────────────────
  /**
   * Calcule les unites a acheter pour un capital EUR donne.
   * Renvoie : [{ ticker, name, weightPct, amountEur, amountUsd, unitsApprox, priceUsd, role }]
   */
  function computeAllocation(winner, capitalEur) {
    if (!winner || !Array.isArray(winner.basket)) return [];
    const rate = getEurUsdRate(winner);
    return winner.basket.map(line => {
      const amountEur = +(capitalEur * line.weightPct / 100).toFixed(2);
      const amountUsd = +(amountEur * rate).toFixed(2);
      const unitsApprox = line.priceUsd ? +(amountUsd / line.priceUsd).toFixed(6) : null;
      return {
        ticker: line.ticker,
        yahoo: line.yahoo,
        name: line.name,
        kind: line.kind,
        weightPct: line.weightPct,
        priceUsd: line.priceUsd,
        amountEur,
        amountUsd,
        unitsApprox,
        role: line.role,
      };
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // Tracker user (localStorage)
  // ────────────────────────────────────────────────────────────────────
  /**
   * Holdings user : { ticker: { units, avgPriceUsd, lastUpdated } }
   */
  function getUserHoldings() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY_HOLDINGS) || '{}') || {};
    } catch { return {}; }
  }

  function setUserHoldings(h) {
    try { localStorage.setItem(LS_KEY_HOLDINGS, JSON.stringify(h)); } catch { /* ignore */ }
  }

  function updateHolding(ticker, units, avgPriceUsd) {
    const h = getUserHoldings();
    h[ticker] = {
      units: Number(units) || 0,
      avgPriceUsd: Number(avgPriceUsd) || 0,
      lastUpdated: new Date().toISOString(),
    };
    setUserHoldings(h);
  }

  function removeHolding(ticker) {
    const h = getUserHoldings();
    delete h[ticker];
    setUserHoldings(h);
  }

  function getUserCapital() {
    const v = parseFloat(localStorage.getItem(LS_KEY_CAPITAL));
    return Number.isFinite(v) && v > 0 ? v : 1000;
  }

  function setUserCapital(eur) {
    const v = Number(eur);
    if (!Number.isFinite(v) || v <= 0) return;
    try { localStorage.setItem(LS_KEY_CAPITAL, String(v)); } catch { /* ignore */ }
  }

  // ────────────────────────────────────────────────────────────────────
  // P&L calculus
  // ────────────────────────────────────────────────────────────────────
  /**
   * P&L user vs prix actuels du basket.
   * Renvoie : { totalEur, totalUsd, totalCostUsd, pnlUsd, pnlPct, lines: [{ ticker, units, currentUsd, costUsd, pnlUsd, pnlPct }] }
   */
  function computeUserPnL(winner) {
    if (!winner) return null;
    const holdings = getUserHoldings();
    const rate = getEurUsdRate(winner);
    const lines = [];
    let totalUsd = 0, totalCostUsd = 0;
    for (const ticker in holdings) {
      const h = holdings[ticker];
      const basketLine = winner.basket.find(b => b.ticker === ticker);
      const priceUsd = basketLine?.priceUsd;
      if (!priceUsd || !h.units) continue;
      const currentUsd = h.units * priceUsd;
      const costUsd = h.units * (h.avgPriceUsd || 0);
      const pnlUsd = currentUsd - costUsd;
      const pnlPct = costUsd > 0 ? (pnlUsd / costUsd) * 100 : 0;
      lines.push({ ticker, units: h.units, priceUsd, currentUsd, costUsd, pnlUsd, pnlPct });
      totalUsd += currentUsd;
      totalCostUsd += costUsd;
    }
    const pnlUsd = totalUsd - totalCostUsd;
    const pnlPct = totalCostUsd > 0 ? (pnlUsd / totalCostUsd) * 100 : 0;
    return {
      totalUsd, totalEur: totalUsd / rate,
      totalCostUsd, totalCostEur: totalCostUsd / rate,
      pnlUsd, pnlEur: pnlUsd / rate, pnlPct,
      lines,
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // Status / rebalance hints
  // ────────────────────────────────────────────────────────────────────
  /**
   * Renvoie l etat actuel de la strategie pour bandeau resume :
   *   - daysUntilRebalance, isRebalanceDue, lastUpdated
   */
  function getStatus(winner) {
    if (!winner) return { isRebalanceDue: false, daysUntilRebalance: null };
    const next = winner.strategy?.nextRebalance;
    if (!next) return { isRebalanceDue: false, daysUntilRebalance: null };
    const nextTs = Date.parse(next + 'T06:00:00Z');
    const nowTs = Date.now();
    const daysUntilRebalance = Math.floor((nextTs - nowTs) / 86400000);
    return {
      nextRebalanceDate: next,
      daysUntilRebalance,
      isRebalanceDue: daysUntilRebalance <= 0,
      isRebalanceSoon: daysUntilRebalance >= 0 && daysUntilRebalance <= 3,
      generatedAt: winner.generatedAt,
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // Rendering helpers (HTML strings, dependency-free)
  // ────────────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtEur(n) {
    if (n == null || !Number.isFinite(n)) return '–';
    return n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  }

  function fmtPct(n, signed = false) {
    if (n == null || !Number.isFinite(n)) return '–';
    const s = (signed && n > 0 ? '+' : '') + n.toFixed(1) + '%';
    return s;
  }

  function fmtUnits(n) {
    if (n == null || !Number.isFinite(n)) return '–';
    if (n >= 100) return n.toFixed(1);
    if (n >= 10) return n.toFixed(2);
    if (n >= 1) return n.toFixed(3);
    if (n >= 0.01) return n.toFixed(4);
    return n.toFixed(6);
  }

  /**
   * Render carte resume strategie pour le feed.
   * Renvoie un string HTML insertable.
   */
  function renderSummaryCard(winner) {
    if (!winner) return '<div class="tgw-card tgw-card--empty">TG Winner : donnees indispo.</div>';
    const p = winner.strategy?.expectedPerf || {};
    const status = getStatus(winner);
    const rebalLabel = status.isRebalanceDue
      ? '<span class="tgw-badge tgw-badge--due">REBALANCE</span>'
      : (status.isRebalanceSoon
          ? '<span class="tgw-badge tgw-badge--soon">J-' + status.daysUntilRebalance + '</span>'
          : '<span class="tgw-badge">J-' + (status.daysUntilRebalance ?? '–') + '</span>');
    return `
      <div class="tgw-card">
        <div class="tgw-card-head">
          <span class="tgw-title">TG Winner</span>
          ${rebalLabel}
        </div>
        <div class="tgw-card-perf">
          <div><b>${fmtPct(p.annualReturnPct)}</b><span>/ an attendu</span></div>
          <div><b>${fmtPct(p.maxDrawdownPct)}</b><span>DD max historique</span></div>
          <div><b>${(p.mcProbProfit * 100 || 0).toFixed(0)}%</b><span>P(profit) MC 500</span></div>
        </div>
        <div class="tgw-card-foot">
          ${escapeHtml(winner.strategy?.description || '')}
        </div>
      </div>
    `;
  }

  /**
   * Render le panier en cards avec lignes ticker / poids / unites.
   */
  function renderBasket(winner, capitalEur) {
    if (!winner) return '';
    const cap = capitalEur || getUserCapital();
    const alloc = computeAllocation(winner, cap);
    const rows = alloc.map(a => `
      <li class="tgw-row" data-ticker="${escapeHtml(a.ticker)}">
        <div class="tgw-row-head">
          <span class="tgw-tick">${escapeHtml(a.ticker)}</span>
          <span class="tgw-weight">${a.weightPct.toFixed(1)}%</span>
        </div>
        <div class="tgw-row-name">${escapeHtml(a.name)}</div>
        <div class="tgw-row-meta">
          <span>${fmtEur(a.amountEur)}</span>
          <span>${fmtUnits(a.unitsApprox)} unites</span>
          <span>@ ${a.priceUsd ? '$' + a.priceUsd : 'n/d'}</span>
        </div>
        <div class="tgw-row-role">${escapeHtml(a.role || '')}</div>
      </li>
    `).join('');
    return `
      <div class="tgw-basket">
        <div class="tgw-basket-head">
          <span>Panier pour <b>${fmtEur(cap)}</b></span>
          <button class="tgw-edit-capital" type="button">Modifier</button>
        </div>
        <ul class="tgw-rows">${rows}</ul>
      </div>
    `;
  }

  /**
   * Format texte copiable broker (utile sur mobile).
   */
  function formatBasketForCopy(winner, capitalEur) {
    if (!winner) return '';
    const cap = capitalEur || getUserCapital();
    const alloc = computeAllocation(winner, cap);
    const date = (winner.generatedAt || '').slice(0, 10);
    let txt = `TG Winner — Panier ${date} — Capital ${cap} EUR\n`;
    txt += `Strategie : ${winner.strategy?.description || ''}\n`;
    txt += '─────────────────────────────────\n';
    for (const a of alloc) {
      txt += `${a.ticker.padEnd(6)} ${String(a.weightPct.toFixed(1) + '%').padStart(6)}  `;
      txt += `${a.amountEur} EUR  `;
      txt += `~ ${fmtUnits(a.unitsApprox)} unites @ $${a.priceUsd ?? 'n/d'}\n`;
    }
    txt += '─────────────────────────────────\n';
    txt += 'Rebalance mensuel (1er du mois). Performance passee ne prejuge pas du futur.';
    return txt;
  }

  // ────────────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────────────
  window.TGWinner = {
    // data
    load,
    // pure
    computeAllocation,
    computeUserPnL,
    getStatus,
    getEurUsdRate,
    // user state
    getUserHoldings, updateHolding, removeHolding,
    getUserCapital, setUserCapital,
    // rendering
    renderSummaryCard,
    renderBasket,
    formatBasketForCopy,
    // const
    LS_KEY_HOLDINGS, LS_KEY_CAPITAL,
  };
})();
