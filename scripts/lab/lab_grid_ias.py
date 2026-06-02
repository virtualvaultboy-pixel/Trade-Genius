"""
Trade Genius — Lab Grid Search 3 IAs

Grid search exhaustif des allocations pour les 3 IA :
  - IA INDICES : grid sur TQQQ%, SPY%, TLT%, GLD%, SOXL%
  - IA CRYPTO : grid sur BTC%, ETH%, SOL%, TLT%
  - IA MIXTE : grid sur TQQQ%, BTC%, ETH%, TLT%, GLD%

Pour chaque IA : test 50-100 combinaisons avec ALT filters + DD stop fixe.
Objectif : pousser chaque IA au max (return + Calmar).
"""
import sys, json, warnings, itertools
warnings.filterwarnings('ignore')

import pandas as pd
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_polished_winner import load_alt_data
from lab_3_ias import run_ia


def grid_search(name, data, alt_data, weight_grid, dd_stop=15,
                use_funding=True, use_vix=True, use_fng=True, use_yield=True,
                min_total_weight=0.95):
    """
    Test toutes les combinaisons de weights_grid.
    weight_grid : dict {ticker: [weights]}
    """
    print(f'\n{"=" * 90}')
    print(f' GRID SEARCH : {name}')
    print('=' * 90)

    tickers = list(weight_grid.keys())
    n_combos = 1
    for t in tickers:
        n_combos *= len(weight_grid[t])
    print(f'  Combos totaux : {n_combos}')

    results = []
    count_tested = 0
    count_skipped = 0

    for combo in itertools.product(*[weight_grid[t] for t in tickers]):
        weights = dict(zip(tickers, combo))
        total = sum(weights.values())
        if abs(total - 1.0) > 0.05:  # ignorer si pas ~100%
            count_skipped += 1
            continue
        try:
            r = run_ia(data, weights, alt_data, dd_stop_pct=dd_stop,
                       use_funding=use_funding, use_vix=use_vix,
                       use_fng=use_fng, use_yield=use_yield)
            r['weights'] = weights
            r['calmar'] = r['annual_return_pct'] / max(abs(r['max_dd_pct']), 1)
            results.append(r)
            count_tested += 1
            if count_tested % 25 == 0:
                print(f'  Tested {count_tested}/{n_combos - count_skipped}')
        except Exception:
            continue

    # Sort by calmar
    results.sort(key=lambda r: -r['calmar'])
    print(f'\n  TOP 5 by Calmar :')
    print(f'  {"Allocation":<60}{"Ann":>8}{"DD":>8}{"WM":>8}{"Cal":>7}')
    print('  ' + '-' * 88)
    for r in results[:5]:
        alloc = ' '.join(f'{t.replace("-USD","")[:4]}{int(w*100)}' for t, w in r['weights'].items() if w > 0)
        print(f'  {alloc[:59]:<60}{r["annual_return_pct"]:>7.1f}%{r["max_dd_pct"]:>7.1f}%{r["worst_monthly"]:>7.1f}%{r["calmar"]:>7.2f}')

    # Sort by annual_return
    print(f'\n  TOP 5 by Annual Return :')
    results.sort(key=lambda r: -r['annual_return_pct'])
    for r in results[:5]:
        alloc = ' '.join(f'{t.replace("-USD","")[:4]}{int(w*100)}' for t, w in r['weights'].items() if w > 0)
        print(f'  {alloc[:59]:<60}{r["annual_return_pct"]:>7.1f}%{r["max_dd_pct"]:>7.1f}%{r["worst_monthly"]:>7.1f}%{r["calmar"]:>7.2f}')

    return results


def main():
    print('=' * 95)
    print(' LAB GRID SEARCH 3 IAs - exhaustive allocation search')
    print('=' * 95)

    alt_data = load_alt_data()
    print(f'Alt data : {len(alt_data)} datasets')

    universe = ['SPY', 'QQQ', 'TLT', 'IEF', 'GLD', 'SHY',
                'XLK', 'XLE', 'XLF', 'XLV', 'XLI', 'XLY',
                'BTC-USD', 'ETH-USD', 'SOL-USD',
                'TQQQ', 'SPXL', 'SOXL']
    eng = LabEngine(universe=universe, start='2014-01-01')
    data = eng.data.loc['2019-09-01':'2026-01-01']
    print(f'Period : {data.index.min().date()} -> {data.index.max().date()}')

    all_results = {}

    # ============ IA INDICES grid ============
    grid_indices = {
        'TQQQ': [0.30, 0.40, 0.50, 0.60],
        'SPY': [0.00, 0.10, 0.20],
        'TLT': [0.20, 0.30, 0.40],
        'GLD': [0.00, 0.10, 0.20],
    }
    r_indices = grid_search('IA INDICES (TQQQ/SPY/TLT/GLD)', data, alt_data,
                            grid_indices, dd_stop=15,
                            use_funding=False, use_fng=False)
    all_results['INDICES'] = r_indices

    # ============ IA CRYPTO grid ============
    grid_crypto = {
        'BTC-USD': [0.30, 0.40, 0.50, 0.60],
        'ETH-USD': [0.10, 0.20, 0.30],
        'SOL-USD': [0.00, 0.10, 0.20],
        'TLT': [0.10, 0.20, 0.30],
    }
    r_crypto = grid_search('IA CRYPTO (BTC/ETH/SOL/TLT)', data, alt_data,
                           grid_crypto, dd_stop=18,
                           use_vix=False, use_yield=False)
    all_results['CRYPTO'] = r_crypto

    # ============ IA MIXTE grid ============
    grid_mixte = {
        'TQQQ': [0.20, 0.30, 0.40, 0.50],
        'BTC-USD': [0.10, 0.20, 0.30],
        'ETH-USD': [0.00, 0.10, 0.20],
        'TLT': [0.10, 0.20, 0.30],
        'GLD': [0.00, 0.10],
        'XLK': [0.00, 0.10],
    }
    r_mixte = grid_search('IA MIXTE (TQQQ/BTC/ETH/TLT/GLD/XLK)', data, alt_data,
                          grid_mixte, dd_stop=15)
    all_results['MIXTE'] = r_mixte

    # Save
    out = OUTPUT_DIR / 'lab_grid_ias.json'
    serializable = {k: v[:20] for k, v in all_results.items()}  # top 20 each
    with open(out, 'w') as f:
        json.dump(serializable, f, indent=2, default=str)
    print(f'\nSaved : {out}')

    # FINAL VERDICT
    print('\n\n' + '=' * 95)
    print(' VERDICT GRID SEARCH')
    print('=' * 95)
    for ia, results in all_results.items():
        print(f'\n--- {ia} ---')
        # Best by Calmar
        by_calmar = sorted(results, key=lambda r: -r['calmar'])[:3]
        print(f'  TOP 3 by CALMAR :')
        for r in by_calmar:
            alloc = ' '.join(f'{t.replace("-USD","")[:4]}{int(w*100)}' for t, w in r['weights'].items() if w > 0)
            print(f'    {alloc[:55]:<55} {r["annual_return_pct"]:>5.1f}% / DD {r["max_dd_pct"]:>5.1f}% / Cal {r["calmar"]:>4.2f}')
        # Best by return
        by_ret = sorted(results, key=lambda r: -r['annual_return_pct'])[:3]
        print(f'  TOP 3 by RETURN :')
        for r in by_ret:
            alloc = ' '.join(f'{t.replace("-USD","")[:4]}{int(w*100)}' for t, w in r['weights'].items() if w > 0)
            print(f'    {alloc[:55]:<55} {r["annual_return_pct"]:>5.1f}% / DD {r["max_dd_pct"]:>5.1f}% / Cal {r["calmar"]:>4.2f}')


if __name__ == '__main__':
    main()
