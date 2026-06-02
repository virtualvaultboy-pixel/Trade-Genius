"""
Trade Genius — Lab Ensemble v1.0

Combine N configs en VOTE MAJORITAIRE pour reduire variance.

Hypothese : 3 configs avec params differents ont des erreurs decorelees.
Le vote majoritaire (>=2/3 d'accord) filtre les faux signaux.

Output : ensemble plus stable que solo, meme si return brut plus bas.
"""
import sys, os, json, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
import vectorbt as vbt
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_strategies import momentum_safe, sma, momentum, _empty_signals


# 3 configs aux profils tres differents (decorelees)
INDICES_ENSEMBLE = [
    {'name': 'momentum_short', 'mom_lookback': 14, 'top_n': 3, 'rebal_days': 7,
     'sma_len': 50, 'stop_pct': 12, 'min_mom_pct': 0},
    {'name': 'momentum_mid',   'mom_lookback': 30, 'top_n': 5, 'rebal_days': 14,
     'sma_len': 100, 'stop_pct': 15, 'min_mom_pct': 5},
    {'name': 'momentum_long',  'mom_lookback': 60, 'top_n': 5, 'rebal_days': 21,
     'sma_len': 150, 'stop_pct': 20, 'min_mom_pct': 5},
]

CRYPTO_ENSEMBLE = [
    {'name': 'crypto_short',   'mom_lookback': 14, 'top_n': 3, 'rebal_days': 7,
     'sma_len': 50, 'stop_pct': 12, 'min_mom_pct': 0},
    {'name': 'crypto_mid',     'mom_lookback': 30, 'top_n': 5, 'rebal_days': 14,
     'sma_len': 100, 'stop_pct': 15, 'min_mom_pct': 5},
    {'name': 'crypto_long',    'mom_lookback': 60, 'top_n': 5, 'rebal_days': 14,
     'sma_len': 150, 'stop_pct': 10, 'min_mom_pct': 5},
]


def ensemble_strategy(data_train, data_test, configs, min_votes=2):
    """Vote majoritaire entre N configs. Long un actif si >= min_votes l'ont selectionne."""
    sigs = []
    for cfg in configs:
        clean = {k: v for k, v in cfg.items() if k != 'name'}
        _, _, sz = momentum_safe(data_train, data_test, **clean)
        sigs.append((sz > 0).astype(int))

    votes = sum(sigs)
    target = (votes >= min_votes).astype(float)

    # Normaliser a 100% du capital
    row_sum = target.sum(axis=1)
    size = target.div(row_sum.replace(0, 1), axis=0)

    entries, exits = _empty_signals(data_test)
    for col in size.columns:
        in_pos = size[col] > 0
        entries[col] = (~in_pos.shift(1).fillna(False)) & in_pos
        exits[col] = in_pos.shift(1).fillna(False) & (~in_pos)
        if in_pos.iloc[0]:
            entries[col].iloc[0] = True

    return entries, exits, size


def test_ensemble(name, universe, configs, years, regime_asset):
    print(f'\n{"=" * 80}')
    print(f'ENSEMBLE TEST : {name}')
    print(f'  Configs : {[c["name"] for c in configs]}')
    print(f'{"=" * 80}')

    eng = LabEngine(universe=universe, start='2017-01-01')

    # 1. Solo : chaque config individuellement
    solo_results = {}
    for cfg in configs:
        clean = {k: v for k, v in cfg.items() if k != 'name'}
        def fn(dt, ds, c=clean):
            return momentum_safe(dt, ds, **c)
        res = eng.walk_forward_strict(fn, years=years)
        if res:
            rets = [m['total_return_pct'] for m in res.values()]
            compound = (np.prod([1 + r / 100 for r in rets]) - 1) * 100
            solo_results[cfg['name']] = {
                'mean': np.mean(rets),
                'median': np.median(rets),
                'compound': compound,
                'worst_dd': min(m['max_dd_pct'] for m in res.values()),
                'n_pos': sum(1 for r in rets if r > 0),
                'n_total': len(rets),
                'rets': rets,
            }
            print(f'  Solo {cfg["name"]:<20}: mean {np.mean(rets):>6.1f}% | comp {compound:>6.0f}% | DDw {min(m["max_dd_pct"] for m in res.values()):>5.1f}% | {sum(1 for r in rets if r > 0)}/{len(rets)} pos')

    # 2. Ensemble vote majoritaire (>=2/3)
    print(f'\n  --- Ensemble vote majoritaire (>=2/3) ---')
    def ens_fn(dt, ds):
        return ensemble_strategy(dt, ds, configs, min_votes=2)
    res_ens = eng.walk_forward_strict(ens_fn, years=years)
    if res_ens:
        rets = [m['total_return_pct'] for m in res_ens.values()]
        compound = (np.prod([1 + r / 100 for r in rets]) - 1) * 100
        ens_2 = {
            'mean': np.mean(rets),
            'median': np.median(rets),
            'compound': compound,
            'worst_dd': min(m['max_dd_pct'] for m in res_ens.values()),
            'n_pos': sum(1 for r in rets if r > 0),
            'n_total': len(rets),
            'rets': rets,
        }
        print(f'  ENSEMBLE 2/3        : mean {np.mean(rets):>6.1f}% | comp {compound:>6.0f}% | DDw {ens_2["worst_dd"]:>5.1f}% | {ens_2["n_pos"]}/{ens_2["n_total"]} pos')

    # 3. Ensemble unanimite (3/3)
    print(f'\n  --- Ensemble unanime (3/3) ---')
    def ens_fn3(dt, ds):
        return ensemble_strategy(dt, ds, configs, min_votes=3)
    res_ens3 = eng.walk_forward_strict(ens_fn3, years=years)
    if res_ens3:
        rets = [m['total_return_pct'] for m in res_ens3.values()]
        compound = (np.prod([1 + r / 100 for r in rets]) - 1) * 100
        ens_3 = {
            'mean': np.mean(rets),
            'median': np.median(rets),
            'compound': compound,
            'worst_dd': min(m['max_dd_pct'] for m in res_ens3.values()),
            'n_pos': sum(1 for r in rets if r > 0),
            'n_total': len(rets),
            'rets': rets,
        }
        print(f'  ENSEMBLE 3/3        : mean {np.mean(rets):>6.1f}% | comp {compound:>6.0f}% | DDw {ens_3["worst_dd"]:>5.1f}% | {ens_3["n_pos"]}/{ens_3["n_total"]} pos')

    return {'solo': solo_results, 'ensemble_2_of_3': ens_2, 'ensemble_3_of_3': ens_3}


def main():
    print('=== LAB ENSEMBLE - Vote majoritaire 3 configs ===\n')

    indices_univ = [
        'SPY','QQQ','IWM','DIA','EFA','VWO','EWJ','FXI','IEF','TLT','LQD','HYG',
        'GLD','SLV','DBC','USO','XLK','XLE','XLF','XLV',
        'AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA',
        'JPM','V','WMT','UNH','JNJ','PG','KO','XOM',
    ]
    crypto_univ = [
        'BTC-USD','ETH-USD','SOL-USD','AVAX-USD','NEAR-USD','ATOM-USD','DOT-USD','ADA-USD',
        'LINK-USD','UNI-USD','AAVE-USD','MATIC-USD','FET-USD','RNDR-USD','INJ-USD',
        'LTC-USD','BCH-USD','XRP-USD','XLM-USD','DOGE-USD',
    ]

    r_ind = test_ensemble('INDICES', indices_univ, INDICES_ENSEMBLE,
                          years=list(range(2020, 2026)), regime_asset='SPY')
    r_crp = test_ensemble('CRYPTO', crypto_univ, CRYPTO_ENSEMBLE,
                          years=list(range(2020, 2026)), regime_asset='BTC-USD')

    out = OUTPUT_DIR / 'lab_ensemble.json'
    with open(out, 'w') as f:
        json.dump({'indices': r_ind, 'crypto': r_crp}, f, indent=2, default=str)
    print(f'\nSaved: {out}')


if __name__ == '__main__':
    main()
