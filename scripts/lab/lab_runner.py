"""
Trade Genius — Lab Runner v1.0

Entry point unique pour tester toutes les stratégies × univers × walk-forward.

Usage :
    python scripts/lab/lab_runner.py
    python scripts/lab/lab_runner.py --strategy rotation_btc_eth --years 2019-2025
    python scripts/lab/lab_runner.py --all
"""
import sys
import os
import argparse
import json
import warnings
warnings.filterwarnings('ignore')

# Force UTF-8 stdout for Windows cp1252
if sys.platform == 'win32':
    os.environ['PYTHONIOENCODING'] = 'utf-8'

import numpy as np
import pandas as pd
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_strategies import STRATEGIES


def run_strategy(eng, strat_name, years):
    """Run walk-forward strict pour une stratégie."""
    print(f'\n=== {strat_name} on {eng.universe_name} ===')
    strat_fn = STRATEGIES[strat_name]
    results = eng.walk_forward_strict(strat_fn, years=years)
    summary = eng.summary(results, label=strat_name)
    return results, summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--strategy', '-s', default=None, help='Stratégie unique à tester')
    parser.add_argument('--universe', '-u', default='crypto_10', help='Univers (crypto_10, crypto_20, etc.)')
    parser.add_argument('--years', default='2019-2025', help='Plage années ex 2019-2025')
    parser.add_argument('--start', default='2017-01-01', help='Date début data train')
    parser.add_argument('--all', action='store_true', help='Tester toutes les stratégies')
    args = parser.parse_args()

    # Parse années
    y_parts = args.years.split('-')
    if len(y_parts) == 2:
        years = list(range(int(y_parts[0]), int(y_parts[1]) + 1))
    else:
        years = [int(y_parts[0])]

    # Init engine
    print(f'[lab_runner] universe={args.universe} years={years} start={args.start}')
    eng = LabEngine(universe=args.universe, start=args.start)
    print(f'[lab_runner] data shape: {eng.data.shape} ({eng.data.index.min().date()} to {eng.data.index.max().date()})')

    # Stratégies à tester
    if args.all:
        strats_to_run = list(STRATEGIES.keys())
    elif args.strategy:
        if args.strategy not in STRATEGIES:
            print(f'ERROR: unknown strategy {args.strategy}. Available: {list(STRATEGIES.keys())}')
            return
        strats_to_run = [args.strategy]
    else:
        # Par défaut : test V5-rotation + benchmark
        strats_to_run = ['bh_btc', 'sma200_btc', 'rotation_btc_eth', 'momentum_topN', 'dual_momentum']

    all_summaries = {}
    all_results = {}
    for s in strats_to_run:
        try:
            res, summ = run_strategy(eng, s, years)
            all_summaries[s] = summ
            all_results[s] = res
        except Exception as e:
            print(f'  STRATEGY {s} FAILED: {e}')
            import traceback
            traceback.print_exc()

    # Tableau récap
    print('\n\n' + '=' * 100)
    print('SYNTHESE COMPARATIVE (walk-forward strict, stress max)')
    print('=' * 100)
    print(f'{"Strategy":<22}{"Mean":>8}{"Median":>8}{"Compound":>10}{"Sharpe":>8}{"WorstDD":>9}{"+pos":>6}{">B&H":>6}')
    print('-' * 100)
    for s, summ in all_summaries.items():
        if summ is None:
            continue
        print(f'{s:<22}'
              f'{summ["mean_return"]:>7.1f}%'
              f'{summ["median_return"]:>7.1f}%'
              f'{summ["compound_total_pct"]:>9.0f}%'
              f'{summ["mean_sharpe"]:>8.2f}'
              f'{summ["worst_dd"]:>8.1f}%'
              f'{summ["n_positive"]:>3}/{summ["n_years"]}'
              f'{summ["n_beat_bh"]:>3}/{summ["n_years"]}')
    print('=' * 100)

    # Détection du best (par Sharpe ajusté)
    if all_summaries:
        valid = {k: v for k, v in all_summaries.items() if v is not None}
        if valid:
            best = max(valid.items(), key=lambda kv: kv[1]['mean_sharpe'] * (1 if kv[1]['mean_return'] > 0 else -1))
            print(f'\n>>> BEST BY SHARPE: {best[0]} (Sharpe {best[1]["mean_sharpe"]:.2f}, Mean {best[1]["mean_return"]:.1f}%/an)')
            best_ret = max(valid.items(), key=lambda kv: kv[1]['mean_return'])
            print(f'>>> BEST BY RETURN: {best_ret[0]} (Mean {best_ret[1]["mean_return"]:.1f}%/an, Sharpe {best_ret[1]["mean_sharpe"]:.2f})')

    # Save JSON
    out_file = OUTPUT_DIR / f'lab_runner_{args.universe}_{args.years}.json'
    serializable = {
        'universe': args.universe,
        'years': years,
        'summaries': {k: v for k, v in all_summaries.items() if v is not None},
        'detail': {k: {str(yr): vv for yr, vv in v.items()} for k, v in all_results.items()},
    }
    with open(out_file, 'w') as f:
        json.dump(serializable, f, indent=2, default=str)
    print(f'\nSaved: {out_file}')


if __name__ == '__main__':
    main()
