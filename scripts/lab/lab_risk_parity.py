"""
Trade Genius — Lab Risk Parity (All Weather Bridgewater + variations)

Strategie inspiree de Ray Dalio / Bridgewater All Weather portfolio.
Reference long terme : ~7-9%/an, Sharpe ~1.2, DD <15%, 70%+ annees pos.

Variantes :
  1. Classic 4-asset : 30% stocks / 40% LT bonds / 15% gold / 15% commodities
  2. Adaptive : poids inverse a la volatilite (vol-targeting)
  3. With momentum overlay : si actif < SMA200, reduit a 50%
  4. Aggressive : 50% stocks / 30% bonds / 10% gold / 10% crypto
  5. Crypto-tilted : 40% stocks / 30% bonds / 10% gold / 20% BTC
"""
import sys, os, json, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
import vectorbt as vbt
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR


def risk_parity_strategy(data_train, data_test, params):
    """
    Allocation fixe ou vol-targeted, rebalance mensuel.

    params :
      - weights : dict {ticker: weight}
      - rebal_days : default 21
      - vol_target : si True, ajuste poids = inverse_vol / sum(inverse_vol)
      - momentum_overlay : si True, reduit a 50% si actif < SMA200
    """
    p = params
    weights = p['weights']
    rebal_days = p.get('rebal_days', 21)
    vol_target = p.get('vol_target', False)
    momentum_overlay = p.get('momentum_overlay', False)

    from lab_strategies import sma, _empty_signals

    full = pd.concat([data_train, data_test]).drop_duplicates().sort_index()
    size = pd.DataFrame(0.0, index=data_test.index, columns=data_test.columns)
    rebal_dates = data_test.index[::rebal_days]

    for d in rebal_dates:
        target = dict(weights)

        # Momentum overlay
        if momentum_overlay:
            for asset in list(target.keys()):
                if asset in full.columns:
                    asset_sma = sma(full[asset], 200).loc[:d].iloc[-1] if d in full[asset].index else None
                    if asset_sma is not None:
                        price = full[asset].loc[:d].iloc[-1]
                        if price < asset_sma:
                            target[asset] *= 0.5  # reduit a 50%

        # Vol targeting : poids inversement proportionnel a la vol
        if vol_target:
            vols = {}
            for asset in target.keys():
                if asset in full.columns:
                    rets = full[asset].loc[:d].pct_change().tail(60)
                    v = rets.std() * np.sqrt(252)
                    if v > 0:
                        vols[asset] = v
            if vols:
                inv_vols = {a: 1 / v for a, v in vols.items()}
                total = sum(inv_vols.values())
                target = {a: inv_vols[a] / total for a in inv_vols}

        # Normaliser (au cas ou)
        s = sum(target.values())
        if s > 0:
            for asset, w in target.items():
                if asset in data_test.columns:
                    size.loc[d, asset] = w / s * 0.98  # 2% cash buffer

    # Forward fill
    size = size.where(size > 0).fillna(method='ffill').fillna(0)

    entries, exits = _empty_signals(data_test)
    for col in size.columns:
        in_pos = size[col] > 0
        entries[col] = (~in_pos.shift(1).fillna(False)) & in_pos
        exits[col] = in_pos.shift(1).fillna(False) & (~in_pos)
        if in_pos.iloc[0]:
            entries[col].iloc[0] = True

    return entries, exits, size


def run_variant(name, universe, params, years, bench_ticker='SPY'):
    print(f'\n--- {name} ---')
    eng = LabEngine(universe=universe, start='2008-01-01')

    def strat(dt, ds):
        return risk_parity_strategy(dt, ds, params)

    results = eng.walk_forward_strict(strat, years=years)
    if not results:
        return None

    rets = [m['total_return_pct'] for m in results.values()]
    dds = [m['max_dd_pct'] for m in results.values()]
    n_pos = sum(1 for r in rets if r > 0)
    compound = (np.prod([1 + r / 100 for r in rets]) - 1) * 100
    mean = np.mean(rets)
    median = np.median(rets)
    wdd = min(dds)
    sharpes = [m['sharpe'] for m in results.values() if np.isfinite(m['sharpe'])]
    avg_sharpe = float(np.mean(sharpes)) if sharpes else 0

    bench_rets = []
    for y in years:
        if bench_ticker in eng.data.columns:
            sub = eng.data[bench_ticker].loc[f'{y}-01-01':f'{y + 1}-01-01']
            if len(sub) > 30:
                bench_rets.append((sub.iloc[-1] / sub.iloc[0] - 1) * 100)
    bench_mean = float(np.mean(bench_rets)) if bench_rets else 0

    print(f'  Mean {mean:.1f}%/an | Med {median:.1f}% | Comp {compound:.0f}% | wDD {wdd:.1f}% | {n_pos}/{len(rets)} pos | Sharpe {avg_sharpe:.2f}')
    print(f'  vs {bench_ticker} : Excess {mean - bench_mean:+.1f}%/an')

    return {
        'config': params, 'name': name, 'rets': rets,
        'mean': float(mean), 'median': float(median), 'compound': float(compound),
        'worst_dd': float(wdd), 'n_pos': int(n_pos), 'n_total': len(rets),
        'mean_sharpe': avg_sharpe, 'bench_mean': bench_mean,
        'excess_mean': float(mean - bench_mean),
    }


def main():
    print('=== LAB RISK PARITY ===\n')
    years = list(range(2012, 2026))

    universe_base = ['SPY', 'QQQ', 'EFA', 'TLT', 'IEF', 'GLD', 'DBC', 'BTC-USD']

    variants = [
        {
            'name': 'AllWeather_classic',
            'universe': universe_base,
            'params': {'weights': {'SPY': 0.30, 'TLT': 0.40, 'GLD': 0.15, 'DBC': 0.15}},
        },
        {
            'name': 'AllWeather_voltarget',
            'universe': universe_base,
            'params': {'weights': {'SPY': 0.25, 'TLT': 0.25, 'GLD': 0.25, 'DBC': 0.25},
                       'vol_target': True},
        },
        {
            'name': 'AllWeather_momentum_overlay',
            'universe': universe_base,
            'params': {'weights': {'SPY': 0.30, 'TLT': 0.40, 'GLD': 0.15, 'DBC': 0.15},
                       'momentum_overlay': True},
        },
        {
            'name': 'Aggressive_5050',
            'universe': universe_base,
            'params': {'weights': {'SPY': 0.40, 'QQQ': 0.10, 'TLT': 0.30, 'GLD': 0.10, 'DBC': 0.10}},
        },
        {
            'name': 'Crypto_tilted_20pct',
            'universe': universe_base,
            'params': {'weights': {'SPY': 0.40, 'TLT': 0.30, 'GLD': 0.10, 'BTC-USD': 0.20}},
        },
        {
            'name': 'Crypto_tilted_momentum',
            'universe': universe_base,
            'params': {'weights': {'SPY': 0.40, 'TLT': 0.30, 'GLD': 0.10, 'BTC-USD': 0.20},
                       'momentum_overlay': True},
        },
        {
            'name': '60_40_classic',
            'universe': universe_base,
            'params': {'weights': {'SPY': 0.60, 'TLT': 0.40}},
        },
    ]

    all_results = {}
    for v in variants:
        try:
            r = run_variant(v['name'], v['universe'], v['params'], years, 'SPY')
            if r:
                all_results[v['name']] = r
        except Exception as e:
            print(f'  FAILED: {e}')

    out = OUTPUT_DIR / 'lab_risk_parity.json'
    with open(out, 'w') as f:
        json.dump({'results': all_results}, f, indent=2, default=str)
    print(f'\nSaved: {out}')

    print('\n=== RECAP RISK PARITY ===')
    print(f'{"Name":<30}{"Mean":>8}{"DD":>8}{"+pos":>9}{"Sharpe":>8}{"Excess":>9}')
    print('-' * 75)
    for name, r in sorted(all_results.items(), key=lambda kv: -kv[1]['mean']):
        print(f'{name:<30}{r["mean"]:>7.1f}%{r["worst_dd"]:>7.1f}%{r["n_pos"]:>4}/{r["n_total"]}{r["mean_sharpe"]:>8.2f}{r["excess_mean"]:>+8.1f}%')


if __name__ == '__main__':
    main()
