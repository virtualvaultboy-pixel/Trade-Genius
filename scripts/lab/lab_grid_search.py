"""
Trade Genius — Lab Grid Search v1.0

Optimisation grid + Bayesian-light sur momentum_safe pour trouver
les meilleurs hyperparams en walk-forward strict.

Toutes les configs testées sur walk-forward strict 2018-2025.
Sélection finale par compound + Sharpe ajusté + worst DD.
"""
import sys
import os
import warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
from pathlib import Path
from itertools import product
import json

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_strategies import momentum_safe, sma, momentum, _empty_signals


def make_momentum_safe_variant(mom_lookback, top_n, rebal_days, sma_len, stop_pct, min_mom_pct):
    """Factory : closure qui appelle momentum_safe avec params fixés."""
    def variant(data_train, data_test):
        return momentum_safe(
            data_train, data_test,
            mom_lookback=mom_lookback, top_n=top_n, rebal_days=rebal_days,
            sma_len=sma_len, stop_pct=stop_pct, min_mom_pct=min_mom_pct,
        )
    return variant


def main():
    print('=== GRID SEARCH momentum_safe ===\n')

    eng = LabEngine(universe='crypto_20', start='2016-01-01')
    print(f'Data: {eng.data.shape}')

    # Grid
    grid = {
        'mom_lookback': [14, 30, 60],
        'top_n': [2, 3, 5],
        'rebal_days': [7, 14, 21],
        'sma_len': [60, 100, 150],
        'stop_pct': [10, 15, 25],
        'min_mom_pct': [0, 5, 10],
    }

    # Full grid = 3^6 = 729 → trop. On sample 50 random + Bayesian autour des bons.
    np.random.seed(42)

    # Phase 1 : random search 60 configs
    print('\n--- Phase 1 : Random 60 configs ---')
    sampled = set()
    configs = []
    while len(configs) < 60:
        c = {k: int(np.random.choice(v)) for k, v in grid.items()}
        k = tuple(c.items())
        if k in sampled:
            continue
        sampled.add(k)
        configs.append(c)

    years = list(range(2018, 2026))
    all_results = []

    for i, cfg in enumerate(configs):
        print(f'  [{i + 1}/{len(configs)}] {cfg}', end=' ... ', flush=True)
        try:
            strat = make_momentum_safe_variant(**cfg)
            results = eng.walk_forward_strict(strat, years=years)
            rets = [m['total_return_pct'] for m in results.values()]
            dds = [m['max_dd_pct'] for m in results.values()]
            if not rets:
                print('SKIP (no data)')
                continue
            compound = (np.prod([1 + r / 100 for r in rets]) - 1) * 100
            mean_ret = np.mean(rets)
            median_ret = np.median(rets)
            worst_dd = min(dds)
            n_pos = sum(1 for r in rets if r > 0)
            # Score : compound pondéré par worst_dd + n_pos
            score = compound / (1 + abs(worst_dd) / 30) * (n_pos / len(rets))
            all_results.append({
                'config': cfg,
                'mean': mean_ret,
                'median': median_ret,
                'compound': compound,
                'worst_dd': worst_dd,
                'n_positive': n_pos,
                'n_total': len(rets),
                'score': score,
            })
            print(f'comp {compound:.0f}% med {median_ret:.0f}% wDD {worst_dd:.0f}% pos {n_pos}/{len(rets)} sc {score:.0f}')
        except Exception as e:
            print(f'FAIL: {e}')

    # Phase 2 : Bayesian autour des top 5
    print('\n--- Phase 2 : Bayesian autour top 5 ---')
    all_results.sort(key=lambda x: -x['score'])
    top5 = all_results[:5]
    print('Top 5 phase 1:')
    for r in top5:
        print(f"  score {r['score']:.0f} | comp {r['compound']:.0f}% | {r['config']}")

    bayesian_configs = []
    for base_r in top5:
        base = base_r['config']
        for _ in range(8):
            c = {}
            for k, vals in grid.items():
                if np.random.random() < 0.4:
                    # Mutate
                    c[k] = int(np.random.choice(vals))
                else:
                    c[k] = base[k]
            if tuple(c.items()) in sampled:
                continue
            sampled.add(tuple(c.items()))
            bayesian_configs.append(c)

    print(f'\nGenerated {len(bayesian_configs)} Bayesian configs')
    for i, cfg in enumerate(bayesian_configs):
        print(f'  [{i + 1}/{len(bayesian_configs)}] {cfg}', end=' ... ', flush=True)
        try:
            strat = make_momentum_safe_variant(**cfg)
            results = eng.walk_forward_strict(strat, years=years)
            rets = [m['total_return_pct'] for m in results.values()]
            dds = [m['max_dd_pct'] for m in results.values()]
            if not rets:
                print('SKIP')
                continue
            compound = (np.prod([1 + r / 100 for r in rets]) - 1) * 100
            mean_ret = np.mean(rets)
            median_ret = np.median(rets)
            worst_dd = min(dds)
            n_pos = sum(1 for r in rets if r > 0)
            score = compound / (1 + abs(worst_dd) / 30) * (n_pos / len(rets))
            all_results.append({
                'config': cfg,
                'mean': mean_ret,
                'median': median_ret,
                'compound': compound,
                'worst_dd': worst_dd,
                'n_positive': n_pos,
                'n_total': len(rets),
                'score': score,
            })
            print(f'comp {compound:.0f}% wDD {worst_dd:.0f}% pos {n_pos}/{len(rets)} sc {score:.0f}')
        except Exception as e:
            print(f'FAIL: {e}')

    # Final ranking
    all_results.sort(key=lambda x: -x['score'])
    print('\n\n' + '=' * 100)
    print('TOP 10 CONFIGS BY SCORE (compound * pos_ratio / dd_penalty)')
    print('=' * 100)
    print(f'{"rank":<5}{"score":>8}{"comp":>10}{"mean":>8}{"med":>8}{"wDD":>7}{"pos":>6}  config')
    print('-' * 100)
    for i, r in enumerate(all_results[:15]):
        cfg_str = ' '.join(f'{k}={v}' for k, v in r['config'].items())
        print(f'{i + 1:<5}{r["score"]:>7.0f}{r["compound"]:>9.0f}%'
              f'{r["mean"]:>7.0f}%{r["median"]:>7.0f}%{r["worst_dd"]:>6.0f}%'
              f'{r["n_positive"]:>3}/{r["n_total"]}  {cfg_str}')

    # Save
    out_file = OUTPUT_DIR / 'lab_grid_search_momentum_safe.json'
    with open(out_file, 'w') as f:
        json.dump({
            'top15': all_results[:15],
            'all_results': all_results,
            'n_total_configs': len(all_results),
        }, f, indent=2, default=str)
    print(f'\nSaved: {out_file}')

    # Detail best
    print('\n' + '=' * 100)
    print('DETAIL BEST CONFIG')
    print('=' * 100)
    best = all_results[0]
    print(f'Config: {best["config"]}')
    print(f'Compound: {best["compound"]:.0f}%')
    print(f'Mean/yr: {best["mean"]:.1f}%')
    print(f'Median/yr: {best["median"]:.1f}%')
    print(f'Worst DD: {best["worst_dd"]:.1f}%')
    print(f'Positive years: {best["n_positive"]}/{best["n_total"]}')

    return best


if __name__ == '__main__':
    main()
