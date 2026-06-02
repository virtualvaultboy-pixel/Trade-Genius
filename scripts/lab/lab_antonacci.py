"""
Trade Genius — Lab Antonacci Dual Momentum

Strategie EXACTE de Gary Antonacci (livre 2014, papier academique).
Validee sur 40 ans (1974-2013), return ~17%/an, Sharpe ~1.2.

Regles :
  1. Univers : 3 actifs principaux + 1 refuge
     - SPY (US stocks)
     - VEU (Intl stocks ex-US) [proxy : EFA]
     - AGG (Bonds) [proxy : IEF]
     - SHV (T-bills) [proxy : SHY]
  2. Calcul momentum 12 mois sur les 3 risk assets
  3. Absolute momentum : si meilleur risk asset > T-bills return,
     achete-le 100%. Sinon achete 100% bonds.
  4. Relative momentum : entre les risk assets, prends le plus fort.
  5. Rebalance mensuel (1er jour du mois)
  6. ZERO leverage, ZERO short

Variantes testees :
  - Classic 3-asset (SPY/EFA/IEF)
  - 5-asset (SPY/QQQ/EFA/VWO/IEF) - plus de choix
  - Crypto adaptation (BTC/ETH/SHY)
"""
import sys, os, json, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
import vectorbt as vbt
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR


def momentum_12m(prices, t_idx):
    """Return total 12 mois (252 jours) - 1."""
    if t_idx < 252:
        return np.nan
    return prices.iloc[t_idx] / prices.iloc[t_idx - 252] - 1


def antonacci_strategy(data_train, data_test, params):
    """
    Antonacci Dual Momentum.

    params :
      - risk_assets : list of tickers (ex ['SPY','EFA'])
      - safe_asset : ticker refuge bonds
      - tbill_asset : ticker pour t-bill threshold
      - lookback_days : default 252 (12 mois)
      - rebal_days : default 21 (mensuel)
    """
    p = params
    risk_assets = p['risk_assets']
    safe_asset = p['safe_asset']
    tbill_asset = p.get('tbill_asset', safe_asset)
    lookback = p.get('lookback_days', 252)
    rebal_days = p.get('rebal_days', 21)

    from lab_strategies import _empty_signals

    full = pd.concat([data_train, data_test]).drop_duplicates().sort_index()

    size = pd.DataFrame(0.0, index=data_test.index, columns=data_test.columns)
    rebal_dates = data_test.index[::rebal_days]

    for d in rebal_dates:
        # Need at least lookback days in full
        if d not in full.index:
            continue
        t_idx = full.index.get_loc(d)
        if t_idx < lookback:
            continue

        # T-bill / safe return reference
        if tbill_asset and tbill_asset in full.columns:
            tbill_ret = momentum_12m(full[tbill_asset], t_idx)
        else:
            tbill_ret = 0.0  # zero rate

        # Calculer momentum 12m pour chaque risk asset
        mom_scores = {}
        for asset in risk_assets:
            if asset not in full.columns:
                continue
            mom = momentum_12m(full[asset], t_idx)
            if not pd.isna(mom):
                mom_scores[asset] = mom

        if not mom_scores:
            # Tous NaN, garde refuge
            if safe_asset in data_test.columns:
                size.loc[d, safe_asset] = 1.0
            continue

        # Best risk asset
        best = max(mom_scores.items(), key=lambda kv: kv[1])
        best_asset, best_mom = best

        # Absolute momentum : best_mom doit > t-bill
        if best_mom > tbill_ret:
            # Long le best risk asset 100%
            if best_asset in data_test.columns:
                size.loc[d, best_asset] = 1.0
        else:
            # Refuge bonds
            if safe_asset in data_test.columns:
                size.loc[d, safe_asset] = 1.0

    # Forward fill positions entre rebalances
    size_ffill = size.copy()
    for i in range(1, len(size_ffill)):
        if size_ffill.iloc[i].sum() == 0:
            size_ffill.iloc[i] = size_ffill.iloc[i - 1]
    size = size_ffill

    # Build entries/exits
    entries, exits = _empty_signals(data_test)
    for col in size.columns:
        in_pos = size[col] > 0
        entries[col] = (~in_pos.shift(1).fillna(False)) & in_pos
        exits[col] = in_pos.shift(1).fillna(False) & (~in_pos)
        if in_pos.iloc[0]:
            entries[col].iloc[0] = True

    return entries, exits, size


def run_variant(name, universe, params, years, bench_ticker, eng_start='2008-01-01'):
    """Run + walk-forward strict."""
    print(f'\n--- {name} ---')
    eng = LabEngine(universe=universe, start=eng_start)

    def strat(dt, ds):
        return antonacci_strategy(dt, ds, params)

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

    # Benchmark
    bench_rets = []
    for y in years:
        if bench_ticker in eng.data.columns:
            sub = eng.data[bench_ticker].loc[f'{y}-01-01':f'{y + 1}-01-01']
            if len(sub) > 30:
                bench_rets.append((sub.iloc[-1] / sub.iloc[0] - 1) * 100)
    bench_mean = np.mean(bench_rets) if bench_rets else 0

    print(f'  Mean {mean:.1f}%/an | Med {median:.1f}% | Comp {compound:.0f}% | wDD {wdd:.1f}% | {n_pos}/{len(rets)} pos | Sharpe {avg_sharpe:.2f}')
    print(f'  Bench {bench_ticker} : Mean {bench_mean:.1f}%/an | Excess {mean - bench_mean:+.1f}%/an')

    return {
        'config': params, 'name': name, 'rets': rets,
        'mean': float(mean), 'median': float(median), 'compound': float(compound),
        'worst_dd': float(wdd), 'n_pos': int(n_pos), 'n_total': len(rets),
        'mean_sharpe': avg_sharpe, 'bench_mean': float(bench_mean),
        'excess_mean': float(mean - bench_mean),
    }


def main():
    print('=== LAB ANTONACCI DUAL MOMENTUM ===')
    print('Gary Antonacci (livre 2014). Reference : ~17%/an Sharpe 1.2 sur 40 ans\n')

    years = list(range(2012, 2026))

    variants = [
        {
            'name': 'Classic_SPY_EFA_IEF',
            'universe': ['SPY', 'EFA', 'IEF', 'SHY', 'AGG', 'BIL'],
            'params': {'risk_assets': ['SPY', 'EFA'], 'safe_asset': 'IEF', 'tbill_asset': 'BIL'},
            'bench': 'SPY',
        },
        {
            'name': 'Extended_5asset',
            'universe': ['SPY', 'QQQ', 'EFA', 'VWO', 'IEF', 'TLT', 'GLD', 'SHY', 'BIL'],
            'params': {'risk_assets': ['SPY', 'QQQ', 'EFA', 'VWO'], 'safe_asset': 'IEF', 'tbill_asset': 'BIL'},
            'bench': 'SPY',
        },
        {
            'name': 'WithGold_TLT',
            'universe': ['SPY', 'QQQ', 'EFA', 'VWO', 'GLD', 'TLT', 'IEF', 'SHY', 'BIL'],
            'params': {'risk_assets': ['SPY', 'QQQ', 'EFA', 'GLD'], 'safe_asset': 'TLT', 'tbill_asset': 'BIL'},
            'bench': 'SPY',
        },
        {
            'name': 'Lookback_6m',
            'universe': ['SPY', 'QQQ', 'EFA', 'VWO', 'IEF', 'SHY', 'BIL'],
            'params': {'risk_assets': ['SPY', 'QQQ', 'EFA', 'VWO'], 'safe_asset': 'IEF', 'tbill_asset': 'BIL', 'lookback_days': 126},
            'bench': 'SPY',
        },
        {
            'name': 'Lookback_3m',
            'universe': ['SPY', 'QQQ', 'EFA', 'VWO', 'IEF', 'SHY', 'BIL'],
            'params': {'risk_assets': ['SPY', 'QQQ', 'EFA', 'VWO'], 'safe_asset': 'IEF', 'tbill_asset': 'BIL', 'lookback_days': 63},
            'bench': 'SPY',
        },
        {
            'name': 'CryptoAdaptation_BTC_ETH',
            'universe': ['BTC-USD', 'ETH-USD', 'IEF', 'SHY', 'BIL'],
            'params': {'risk_assets': ['BTC-USD', 'ETH-USD'], 'safe_asset': 'IEF', 'tbill_asset': 'BIL'},
            'bench': 'BTC-USD',
        },
    ]

    all_results = {}
    for v in variants:
        try:
            r = run_variant(v['name'], v['universe'], v['params'],
                           years if 'Crypto' not in v['name'] else list(range(2019, 2026)),
                           v['bench'])
            if r:
                all_results[v['name']] = r
        except Exception as e:
            print(f'  FAILED: {e}')
            import traceback; traceback.print_exc()

    # Save
    out = OUTPUT_DIR / 'lab_antonacci.json'
    with open(out, 'w') as f:
        json.dump({'results': all_results}, f, indent=2, default=str)
    print(f'\nSaved: {out}')

    # Best
    print('\n=== RECAP ANTONACCI ===')
    print(f'{"Name":<30}{"Mean":>8}{"DD":>8}{"+pos":>9}{"Excess":>9}')
    print('-' * 70)
    for name, r in sorted(all_results.items(), key=lambda kv: -kv[1]['mean']):
        print(f'{name:<30}{r["mean"]:>7.1f}%{r["worst_dd"]:>7.1f}%{r["n_pos"]:>4}/{r["n_total"]}{r["excess_mean"]:>+8.1f}%')


if __name__ == '__main__':
    main()
