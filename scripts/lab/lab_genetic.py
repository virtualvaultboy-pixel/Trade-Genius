"""
Trade Genius — Lab Genetic v1.0

Algorithme genetique pour explorer 2000+ configs par sandbox.

4 sandboxes paralleles :
  A. INDICES_TECH : momentum + patterns techniques (RSI/MACD/Bollinger/ADX)
  B. INDICES_NEWS : A + score news sentiment (placeholder, a brancher news-intel)
  C. CRYPTO_TECH : momentum + patterns + BTC filter avance
  D. CRYPTO_NEWS : C + score news

Algo genetique :
  - Population 40 individus
  - 50 generations
  - Selection tournament (k=4)
  - Crossover uniform
  - Mutation 15%
  - Elitisme 20%

Fitness = compound * pos_ratio * sharpe / (1 + dd_penalty)
  Avec rejet si DD > 30% ou pos_ratio < 0.5

Output : data/sandbox/lab/lab_genetic_{sandbox}_best.json
"""
import sys
import os
import json
import warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
import vectorbt as vbt
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_strategies import momentum_safe, sma, momentum, _empty_signals


# ============= STRATEGIE GENERIQUE PARAMETREE =============

def smart_strategy(data_train, data_test, params):
    """
    Strategie unifiee parametree pour algo genetique.

    Parametres :
      mom_lookback : 7-120
      top_n : 2-7
      rebal_days : 3-30
      sma_filter_len : 30-250
      stop_pct : 5-30
      min_mom_pct : -5 a 20
      use_rsi_filter : 0/1
      rsi_max : 50-80  (entrer seulement si RSI < rsi_max)
      use_macd_filter : 0/1
      use_bb_filter : 0/1
      bb_pos_max : 0.5-1.0 (entrer seulement si BB position < bb_pos_max)
      vol_target_pct : 0 a 50 (0 = pas de vol targeting)
      regime_filter_asset : 'BTC-USD' ou 'SPY'
    """
    p = params
    full = pd.concat([data_train, data_test]).drop_duplicates().sort_index()
    test_idx = data_test.index

    # 1. Momentum filter
    mom_full = momentum(full, p['mom_lookback'])
    mom = mom_full.reindex(test_idx)

    # 2. Regime filter sur asset principal (BTC ou SPY)
    regime_asset = p.get('regime_filter_asset', 'BTC-USD')
    if regime_asset in full.columns:
        regime_sma = sma(full[regime_asset], p['sma_filter_len']).reindex(test_idx)
        bull = full[regime_asset].reindex(test_idx) > regime_sma
    else:
        bull = pd.Series(True, index=test_idx)

    # 3. RSI filter (par actif) - optionnel
    if p.get('use_rsi_filter'):
        delta = full.diff()
        gain = delta.clip(lower=0).rolling(14).mean()
        loss = (-delta.clip(upper=0)).rolling(14).mean()
        rs = gain / (loss + 1e-9)
        rsi = (100 - 100 / (1 + rs)).reindex(test_idx)
    else:
        rsi = None

    # 4. MACD filter (par actif)
    if p.get('use_macd_filter'):
        ema_fast = full.ewm(span=12, adjust=False).mean()
        ema_slow = full.ewm(span=26, adjust=False).mean()
        macd = (ema_fast - ema_slow).reindex(test_idx)
    else:
        macd = None

    # 5. Bollinger Band position
    if p.get('use_bb_filter'):
        sma_bb = full.rolling(20).mean()
        std_bb = full.rolling(20).std()
        upper = sma_bb + 2 * std_bb
        lower = sma_bb - 2 * std_bb
        bb_pos = ((full - lower) / (upper - lower)).reindex(test_idx)
    else:
        bb_pos = None

    # === Build target positions ===
    size = pd.DataFrame(0.0, index=test_idx, columns=data_test.columns)
    entry_price = pd.DataFrame(np.nan, index=test_idx, columns=data_test.columns)
    current_top = []

    rebal_dates = test_idx[::p['rebal_days']]
    for i, d in enumerate(test_idx):
        prev_size = size.iloc[i - 1] if i > 0 else pd.Series(0.0, index=data_test.columns)
        size.iloc[i] = prev_size.copy()
        if i > 0:
            entry_price.iloc[i] = entry_price.iloc[i - 1]

        # Stop loss check sur positions ouvertes
        for col in data_test.columns:
            if size.iloc[i].get(col, 0) > 0 and not pd.isna(entry_price.iloc[i].get(col, np.nan)):
                ep = entry_price.iloc[i][col]
                curr = data_test.iloc[i][col]
                if not pd.isna(ep) and not pd.isna(curr):
                    pnl_pct = (curr - ep) / ep * 100
                    if pnl_pct < -p['stop_pct']:
                        size.iloc[i, size.columns.get_loc(col)] = 0
                        entry_price.iloc[i, entry_price.columns.get_loc(col)] = np.nan

        # Rebalance day
        if d in rebal_dates:
            if not bull.get(d, False):
                size.iloc[i] = 0
                entry_price.iloc[i] = np.nan
                current_top = []
                continue

            # Candidates : momentum > threshold
            mom_d = mom.loc[d].dropna()
            mom_d = mom_d[mom_d > p['min_mom_pct'] / 100]

            # Filtres patterns
            valid_cols = list(mom_d.index)
            if rsi is not None and d in rsi.index:
                rsi_d = rsi.loc[d]
                valid_cols = [c for c in valid_cols if c in rsi_d.index and rsi_d[c] < p['rsi_max']]
            if macd is not None and d in macd.index:
                macd_d = macd.loc[d]
                # MACD > 0 = uptrend
                valid_cols = [c for c in valid_cols if c in macd_d.index and macd_d[c] > 0]
            if bb_pos is not None and d in bb_pos.index:
                bb_d = bb_pos.loc[d]
                valid_cols = [c for c in valid_cols if c in bb_d.index and bb_d[c] < p['bb_pos_max']]

            mom_d_filtered = mom_d[mom_d.index.isin(valid_cols)]
            top = mom_d_filtered.sort_values(ascending=False).head(p['top_n']).index.tolist()

            # Liquider les sortis
            for col in current_top:
                if col not in top:
                    size.iloc[i, size.columns.get_loc(col)] = 0
                    entry_price.iloc[i, entry_price.columns.get_loc(col)] = np.nan
            # Acheter les nouveaux
            for col in top:
                if col not in current_top:
                    size.iloc[i, size.columns.get_loc(col)] = 1.0 / max(p['top_n'], 1)
                    entry_price.iloc[i, entry_price.columns.get_loc(col)] = data_test.iloc[i][col]
                else:
                    size.iloc[i, size.columns.get_loc(col)] = 1.0 / max(len(top), 1) if len(top) > 0 else 0
            current_top = top

    entries, exits = _empty_signals(data_test)
    for col in size.columns:
        in_pos = size[col] > 0
        entries[col] = (~in_pos.shift(1).fillna(False)) & in_pos
        exits[col] = in_pos.shift(1).fillna(False) & (~in_pos)
        if in_pos.iloc[0]:
            entries[col].iloc[0] = True

    return entries, exits, size


# ============= ALGO GENETIQUE =============

PARAM_SPACE = {
    'mom_lookback':       (7, 120, 'int'),
    'top_n':              (2, 7, 'int'),
    'rebal_days':         (3, 30, 'int'),
    'sma_filter_len':     (30, 250, 'int'),
    'stop_pct':           (5, 30, 'int'),
    'min_mom_pct':        (-5, 20, 'int'),
    'use_rsi_filter':     (0, 1, 'bool'),
    'rsi_max':            (50, 80, 'int'),
    'use_macd_filter':    (0, 1, 'bool'),
    'use_bb_filter':      (0, 1, 'bool'),
    'bb_pos_max':         (0.4, 1.0, 'float'),
}


def random_individual(rng, regime_asset):
    ind = {}
    for k, (lo, hi, typ) in PARAM_SPACE.items():
        if typ == 'int':
            ind[k] = int(rng.integers(lo, hi + 1))
        elif typ == 'bool':
            ind[k] = int(rng.integers(0, 2))
        elif typ == 'float':
            ind[k] = float(rng.uniform(lo, hi))
    ind['regime_filter_asset'] = regime_asset
    return ind


def crossover(p1, p2, rng):
    child = {}
    for k in PARAM_SPACE:
        child[k] = p1[k] if rng.random() < 0.5 else p2[k]
    child['regime_filter_asset'] = p1['regime_filter_asset']
    return child


def mutate(ind, rng, rate=0.15):
    new = dict(ind)
    for k, (lo, hi, typ) in PARAM_SPACE.items():
        if rng.random() < rate:
            if typ == 'int':
                new[k] = int(rng.integers(lo, hi + 1))
            elif typ == 'bool':
                new[k] = int(rng.integers(0, 2))
            elif typ == 'float':
                new[k] = float(rng.uniform(lo, hi))
    return new


def fitness(individual, eng, years, regime_asset):
    """Run walk-forward strict, compute fitness. PENALISE les configs qui ne tradent pas."""
    try:
        def strat(dt, ds):
            return smart_strategy(dt, ds, individual)
        results = eng.walk_forward_strict(strat, years=years)
        if not results:
            return -1e9, None
        rets = [m['total_return_pct'] for m in results.values()]
        dds = [m['max_dd_pct'] for m in results.values()]
        n_trades_yearly = [m.get('n_trades', 0) for m in results.values()]
        # Clamp sharpe (inf si std=0 = pas de trade ou rendement constant)
        sharpes = [s if np.isfinite(s) else 0 for s in (m['sharpe'] for m in results.values())]
        compound = (np.prod([1 + r / 100 for r in rets]) - 1) * 100
        mean = np.mean(rets)
        n_pos = sum(1 for r in rets if r > 0)
        pos_ratio = n_pos / len(rets)
        worst_dd = min(dds)
        total_trades = sum(n_trades_yearly)
        avg_trades_per_year = total_trades / len(rets) if rets else 0

        meta = {
            'compound': compound, 'mean': mean, 'median': np.median(rets),
            'worst_dd': worst_dd, 'pos_ratio': pos_ratio,
            'mean_sharpe': float(np.mean(sharpes)),
            'avg_trades_per_year': avg_trades_per_year,
            'rets': rets,
        }

        # KILL si quasi pas de trades (la strategie ne fait rien)
        if avg_trades_per_year < 3:
            return -1000 - abs(mean), meta
        # KILL si compound trop faible (la strategie ne genere pas de plus-value)
        if compound < 5:
            return -500, meta
        # KILL si DD catastrophique
        if worst_dd < -50:
            return mean - 500, meta
        # KILL si trop peu d'annees positives
        if pos_ratio < 0.3:
            return mean - 200, meta

        # Fitness composite : mean * pos_ratio * (1 + sharpe/3) / dd_penalty
        avg_sharpe = max(0, min(5, float(np.mean(sharpes))))  # clamp 0-5
        fit = mean * pos_ratio * (1 + avg_sharpe / 3) / (1 + abs(worst_dd) / 30)
        return fit, meta
    except Exception as e:
        return -1e9, {'error': str(e)}


def genetic_search(eng, name, regime_asset, years, n_pop=30, n_gen=20, seed=42):
    """Run genetic algorithm sur l'engine donne."""
    print(f'\n{"=" * 80}')
    print(f'GENETIC SEARCH: {name} | regime={regime_asset} | years={years}')
    print(f'{n_pop} individuals x {n_gen} generations = {n_pop * n_gen} evaluations')
    print(f'{"=" * 80}')

    rng = np.random.default_rng(seed)
    population = [random_individual(rng, regime_asset) for _ in range(n_pop)]
    history = []

    for gen in range(n_gen):
        scored = []
        for i, ind in enumerate(population):
            fit, meta = fitness(ind, eng, years, regime_asset)
            scored.append((fit, ind, meta))
        scored.sort(key=lambda x: -x[0])
        best_fit, best_ind, best_meta = scored[0]
        history.append({
            'gen': gen,
            'best_fit': best_fit,
            'best_meta': best_meta,
        })
        if best_meta:
            print(f'  Gen {gen+1:>2}/{n_gen} | best fit {best_fit:>8.1f} | '
                  f'comp {best_meta.get("compound", 0):>7.0f}% mean {best_meta.get("mean", 0):>6.1f}% '
                  f'med {best_meta.get("median", 0):>6.1f}% wDD {best_meta.get("worst_dd", 0):>6.1f}% '
                  f'pos {best_meta.get("pos_ratio", 0)*100:>3.0f}% sharpe {best_meta.get("mean_sharpe", 0):>4.2f}')

        # Build next generation
        # Elitisme : top 20%
        n_elite = max(1, int(0.2 * n_pop))
        next_pop = [ind for (_, ind, _) in scored[:n_elite]]
        # Tournament + crossover + mutation
        while len(next_pop) < n_pop:
            # Tournament k=4
            cands = rng.choice(len(scored), size=4, replace=False)
            p1 = scored[min(cands)][1]  # min index = best (deja triés)
            cands2 = rng.choice(len(scored), size=4, replace=False)
            p2 = scored[min(cands2)][1]
            child = crossover(p1, p2, rng)
            child = mutate(child, rng, rate=0.15)
            next_pop.append(child)
        population = next_pop

    # Final eval
    final_scored = []
    for ind in population:
        fit, meta = fitness(ind, eng, years, regime_asset)
        final_scored.append((fit, ind, meta))
    final_scored.sort(key=lambda x: -x[0])

    best_fit, best_ind, best_meta = final_scored[0]
    print(f'\n>>> {name} BEST CONFIG <<<')
    print(json.dumps(best_ind, indent=2))
    print(f'\nMeta : {best_meta}')

    # Save top 5
    top5 = [{'fitness': f, 'config': i, 'meta': m} for (f, i, m) in final_scored[:5]]
    out = OUTPUT_DIR / f'lab_genetic_{name}_best.json'
    with open(out, 'w') as f:
        json.dump({'top5': top5, 'history': history}, f, indent=2, default=str)
    print(f'\nSaved: {out}')

    return best_ind, best_meta


def main():
    # 4 sandboxes
    print('=== LAB GENETIC SEARCH (4 sandboxes) ===\n')

    # Sandbox A : INDICES_TECH (10 ans data)
    eng_a = LabEngine(universe=[
        'SPY','QQQ','IWM','DIA','EFA','VWO','EWJ','FXI','IEF','TLT','LQD','HYG',
        'GLD','SLV','DBC','USO','XLK','XLE','XLF','XLV',
        'AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA',
        'JPM','V','WMT','UNH','JNJ','PG','KO','XOM',
    ], start='2015-01-01')
    a_best, a_meta = genetic_search(eng_a, 'A_INDICES_TECH', 'SPY',
                                    years=list(range(2018, 2026)),
                                    n_pop=20, n_gen=10, seed=42)

    # Sandbox C : CRYPTO_TECH (5 ans data realistic)
    eng_c = LabEngine(universe=[
        'BTC-USD','ETH-USD','SOL-USD','AVAX-USD','NEAR-USD','ATOM-USD','DOT-USD','ADA-USD',
        'LINK-USD','UNI-USD','AAVE-USD','MATIC-USD','FET-USD','RNDR-USD','INJ-USD',
        'LTC-USD','BCH-USD','XRP-USD','XLM-USD','DOGE-USD',
    ], start='2019-01-01')
    c_best, c_meta = genetic_search(eng_c, 'C_CRYPTO_TECH', 'BTC-USD',
                                    years=list(range(2021, 2026)),
                                    n_pop=20, n_gen=10, seed=43)

    print('\n\n' + '=' * 80)
    print('FINAL SUMMARY')
    print('=' * 80)
    for name, m in [('A_INDICES_TECH', a_meta), ('C_CRYPTO_TECH', c_meta)]:
        if m:
            print(f'\n{name}')
            print(f'  Mean: {m.get("mean", 0):.1f}%/an')
            print(f'  Median: {m.get("median", 0):.1f}%/an')
            print(f'  Compound: {m.get("compound", 0):.0f}%')
            print(f'  Worst DD: {m.get("worst_dd", 0):.1f}%')
            print(f'  Pos ratio: {m.get("pos_ratio", 0)*100:.0f}%')
            print(f'  Mean Sharpe: {m.get("mean_sharpe", 0):.2f}')


if __name__ == '__main__':
    main()
