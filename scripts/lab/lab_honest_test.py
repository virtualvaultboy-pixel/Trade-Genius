"""
Trade Genius — Lab Honest Test v1.0

Test HONNETE : 2 IA separees, benchmark fixe = B&H du marche dominant.

IA INDICES : SPY + QQQ + EFA + VWO + IEF + TLT + GLD + DBC + 15 actions megacap
  Benchmark : B&H SPY
  Critere : excess >= +5%/an + Sharpe > Sharpe(SPY)

IA CRYPTO : BTC + ETH + 18 altcoins
  Benchmark : B&H BTC (PAS equiponderee !)
  Critere : excess >= +5%/an risk-adjusted + ratio Sharpe meilleur

Toutes les stratégies sont testées sur chaque univers.
Pas de cherry-pick. Resultats bruts.
"""
import sys
import os
import warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
import vectorbt as vbt
from pathlib import Path
import json

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_strategies import (
    bh_btc, bh_equal, sma200_btc, rotation_btc_eth,
    momentum_topN, momentum_safe, donchian_breakout, dual_momentum, ensemble_majority,
    sma, momentum, _empty_signals,
)


# Univers honnetes
UNIVERSE_INDICES = [
    # Actions broad ETF
    'SPY', 'QQQ', 'IWM', 'DIA',
    # International
    'EFA', 'VWO', 'EWJ', 'FXI',
    # Bonds
    'IEF', 'TLT', 'LQD', 'HYG',
    # Matieres premieres + commodities
    'GLD', 'SLV', 'DBC', 'USO',
    # Sector ETF
    'XLK', 'XLE', 'XLF', 'XLV',
    # Actions megacap (les leaders)
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA',
    'JPM', 'V', 'WMT', 'UNH', 'JNJ', 'PG', 'KO', 'XOM',
]

UNIVERSE_CRYPTO = [
    # Majors
    'BTC-USD', 'ETH-USD',
    # L1
    'SOL-USD', 'AVAX-USD', 'NEAR-USD', 'ATOM-USD', 'DOT-USD', 'ADA-USD',
    # DeFi
    'LINK-USD', 'UNI-USD', 'AAVE-USD',
    # Layer 2 / scaling
    'MATIC-USD',
    # AI / narratives
    'FET-USD', 'RNDR-USD', 'INJ-USD',
    # OG
    'LTC-USD', 'BCH-USD', 'XRP-USD', 'XLM-USD',
    # Memecoin
    'DOGE-USD',
]


def bh_single(ticker):
    """Factory : Buy & Hold un seul actif."""
    def fn(data_train, data_test):
        entries, exits = _empty_signals(data_test)
        if ticker in data_test.columns:
            entries.loc[data_test.index[0], ticker] = True
        size = pd.DataFrame(0.0, index=data_test.index, columns=data_test.columns)
        if ticker in data_test.columns:
            size[ticker] = 1.0
        return entries, exits, size
    fn.__name__ = f'bh_{ticker}'
    return fn


def momentum_safe_v(cfg):
    def fn(data_train, data_test):
        return momentum_safe(data_train, data_test, **cfg)
    return fn


def test_universe(name, tickers, benchmark_ticker, years, strategies):
    """Test toutes les stratégies sur un univers vs benchmark unique."""
    print(f'\n{"=" * 90}')
    print(f'UNIVERSE: {name} ({len(tickers)} actifs)')
    print(f'BENCHMARK: B&H {benchmark_ticker}')
    print(f'{"=" * 90}')

    eng = LabEngine(universe=tickers, start='2016-01-01')
    print(f'Data: {eng.data.shape} ({eng.data.index.min().date()} -> {eng.data.index.max().date()})')

    # Benchmark
    if benchmark_ticker not in eng.data.columns:
        print(f'BENCHMARK {benchmark_ticker} NOT in data, abort')
        return None

    bench_prices = eng.data[benchmark_ticker]
    bench_rets_yearly = []
    bench_dd_yearly = []
    for year in years:
        s = pd.Timestamp(f'{year}-01-01')
        e = pd.Timestamp(f'{year + 1}-01-01')
        slice_ = bench_prices.loc[s:e]
        if len(slice_) < 30:
            continue
        ret = (slice_.iloc[-1] / slice_.iloc[0] - 1) * 100
        rolling = slice_.cummax()
        dd = ((slice_ - rolling) / rolling).min() * 100
        bench_rets_yearly.append(ret)
        bench_dd_yearly.append(dd)
    bench_mean = np.mean(bench_rets_yearly)
    bench_compound = (np.prod([1 + r / 100 for r in bench_rets_yearly]) - 1) * 100
    bench_worst_dd = min(bench_dd_yearly)
    # Sharpe sur returns annuels (approximation)
    bench_sharpe = (np.mean(bench_rets_yearly) / 100) / (np.std(bench_rets_yearly) / 100 + 1e-9)

    print(f'\nB&H {benchmark_ticker} reference:')
    print(f'  Mean: {bench_mean:.1f}%/an | Compound 8y: {bench_compound:.0f}% | Worst DD: {bench_worst_dd:.1f}% | Sharpe: {bench_sharpe:.2f}')

    # Run all strategies
    all_results = {}
    for label, strat_fn in strategies.items():
        print(f'\n--- {label} ---')
        try:
            results = eng.walk_forward_strict(strat_fn, years=years)
            if not results:
                continue
            rets = [m['total_return_pct'] for m in results.values()]
            dds = [m['max_dd_pct'] for m in results.values()]
            compound = (np.prod([1 + r / 100 for r in rets]) - 1) * 100
            mean_r = np.mean(rets)
            sharpe = mean_r / 100 / (np.std(rets) / 100 + 1e-9)
            n_pos = sum(1 for r in rets if r > 0)
            n_beat = sum(1 for r, b in zip(rets, bench_rets_yearly) if r > b)
            excess = mean_r - bench_mean
            all_results[label] = {
                'mean': mean_r,
                'compound': compound,
                'worst_dd': min(dds),
                'sharpe': sharpe,
                'n_positive': n_pos,
                'n_total': len(rets),
                'n_beat_bench': n_beat,
                'excess_vs_bench': excess,
                'yearly_returns': rets,
            }
            print(f'  Mean {mean_r:.1f}%/an | Compound {compound:.0f}% | DD worst {min(dds):.1f}% | Sharpe {sharpe:.2f}')
            print(f'  {n_pos}/{len(rets)} pos | {n_beat}/{len(rets)} beat bench | Excess {excess:+.1f}%/an')
        except Exception as e:
            print(f'  FAILED: {e}')
            import traceback
            traceback.print_exc()

    return {
        'universe': name,
        'tickers': tickers,
        'benchmark_ticker': benchmark_ticker,
        'benchmark': {
            'mean': bench_mean, 'compound': bench_compound,
            'worst_dd': bench_worst_dd, 'sharpe': bench_sharpe,
        },
        'strategies': all_results,
    }


def main():
    print('=== LAB HONEST TEST ===')
    print('2 IA separees, benchmark fixe. Pas de biais.\n')

    years = list(range(2018, 2026))

    # Stratégies a tester
    strategies = {
        'momentum_topN_default':  momentum_topN,
        'momentum_safe_default':  momentum_safe,
        'momentum_safe_MIN_DD':   momentum_safe_v(dict(mom_lookback=60, top_n=5, rebal_days=14, sma_len=150, stop_pct=10, min_mom_pct=5)),
        'momentum_safe_MAX_COMP': momentum_safe_v(dict(mom_lookback=60, top_n=5, rebal_days=21, sma_len=60, stop_pct=25, min_mom_pct=5)),
        'momentum_safe_STABLE':   momentum_safe_v(dict(mom_lookback=14, top_n=3, rebal_days=21, sma_len=60, stop_pct=15, min_mom_pct=0)),
        'donchian_breakout':      donchian_breakout,
        'dual_momentum':          dual_momentum,
    }

    # === Test 1 : IA INDICES ===
    r_indices = test_universe(
        'INDICES_ACTIONS_MATIERES', UNIVERSE_INDICES, 'SPY', years, strategies,
    )

    # === Test 2 : IA CRYPTO ===
    r_crypto = test_universe(
        'CRYPTO_PUR', UNIVERSE_CRYPTO, 'BTC-USD', years, strategies,
    )

    # === SYNTHESE FINALE ===
    print('\n\n' + '=' * 110)
    print('SYNTHESE FINALE - VERITE BRUTE')
    print('=' * 110)

    for r in [r_indices, r_crypto]:
        if not r:
            continue
        print(f'\n--- {r["universe"]} (benchmark: B&H {r["benchmark_ticker"]}) ---')
        b = r['benchmark']
        print(f'  BENCHMARK:  Mean {b["mean"]:.1f}%/an | Compound 8y {b["compound"]:.0f}% | DD {b["worst_dd"]:.1f}% | Sharpe {b["sharpe"]:.2f}')
        print()
        # Header
        print(f'  {"Strategy":<28}{"Mean":>8}{"Comp":>9}{"DDw":>8}{"Sharpe":>8}{"+pos":>7}{">bh":>6}{"Excess":>9}{"VERDICT":>16}')
        print(f'  {"-" * 100}')
        # Sort by excess
        sorted_strats = sorted(r['strategies'].items(), key=lambda kv: -kv[1]['excess_vs_bench'])
        for label, s in sorted_strats:
            # Verdict honnete : excess >= 5% ET sharpe >= benchmark sharpe
            beats = s['excess_vs_bench'] >= 5 and s['sharpe'] >= b['sharpe']
            verdict = '*** WIN ***' if beats else 'fail'
            print(f'  {label:<28}{s["mean"]:>7.1f}%{s["compound"]:>8.0f}%{s["worst_dd"]:>7.1f}%{s["sharpe"]:>8.2f}'
                  f'{s["n_positive"]:>3}/{s["n_total"]}{s["n_beat_bench"]:>3}/{s["n_total"]}{s["excess_vs_bench"]:>+7.1f}%   {verdict}')

    # Save
    out = OUTPUT_DIR / 'lab_honest_test.json'
    with open(out, 'w') as f:
        json.dump({'indices': r_indices, 'crypto': r_crypto}, f, indent=2, default=str)
    print(f'\nSaved {out}')


if __name__ == '__main__':
    main()
