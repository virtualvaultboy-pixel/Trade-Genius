"""
Trade Genius — Lab Long-Term v1.0

REPONSE A L'OVERFIT DEMASQUE par lab_deep_oos :
  - momentum_topN sur 30j + rebal 7j = adapte a la volatilite 2020-25 SEULEMENT
  - Echec sur 2012-2018 bull continu (-21% vs SPY +126%)

NOUVELLE APPROCHE : configs LONG-TERM qui doivent generaliser :
  - mom_lookback 90-180j
  - rebal mensuel (21j) ou trimestriel (63j)
  - SMA longue (150-250j) pour eviter faux signaux
  - top_n bas (3-4) pour concentration

Test sur 13 ans (2012-2025) WALK-FORWARD STRICT par annee.
"""
import sys, os, json, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_strategies import momentum_safe


# Configs LONG-TERME a tester
LONGTERM_CONFIGS_INDICES = [
    {'name': 'LT_90_3_monthly',   'mom_lookback': 90,  'top_n': 3, 'rebal_days': 21, 'sma_len': 200, 'stop_pct': 20, 'min_mom_pct': 5},
    {'name': 'LT_120_3_monthly',  'mom_lookback': 120, 'top_n': 3, 'rebal_days': 21, 'sma_len': 200, 'stop_pct': 25, 'min_mom_pct': 5},
    {'name': 'LT_180_3_monthly',  'mom_lookback': 180, 'top_n': 3, 'rebal_days': 21, 'sma_len': 200, 'stop_pct': 25, 'min_mom_pct': 5},
    {'name': 'LT_120_5_monthly',  'mom_lookback': 120, 'top_n': 5, 'rebal_days': 21, 'sma_len': 200, 'stop_pct': 20, 'min_mom_pct': 5},
    {'name': 'LT_180_5_quarterly','mom_lookback': 180, 'top_n': 5, 'rebal_days': 63, 'sma_len': 250, 'stop_pct': 30, 'min_mom_pct': 5},
    {'name': 'LT_60_3_monthly',   'mom_lookback': 60,  'top_n': 3, 'rebal_days': 21, 'sma_len': 200, 'stop_pct': 20, 'min_mom_pct': 5},
    {'name': 'LT_90_5_monthly',   'mom_lookback': 90,  'top_n': 5, 'rebal_days': 21, 'sma_len': 150, 'stop_pct': 20, 'min_mom_pct': 0},
    {'name': 'LT_120_3_biweekly', 'mom_lookback': 120, 'top_n': 3, 'rebal_days': 14, 'sma_len': 150, 'stop_pct': 20, 'min_mom_pct': 5},
]

LONGTERM_CONFIGS_CRYPTO = [
    {'name': 'LT_30_3_biweekly',  'mom_lookback': 30, 'top_n': 3, 'rebal_days': 14, 'sma_len': 100, 'stop_pct': 15, 'min_mom_pct': 5},
    {'name': 'LT_60_3_biweekly',  'mom_lookback': 60, 'top_n': 3, 'rebal_days': 14, 'sma_len': 150, 'stop_pct': 15, 'min_mom_pct': 5},
    {'name': 'LT_90_3_monthly',   'mom_lookback': 90, 'top_n': 3, 'rebal_days': 21, 'sma_len': 200, 'stop_pct': 20, 'min_mom_pct': 5},
    {'name': 'LT_60_5_biweekly',  'mom_lookback': 60, 'top_n': 5, 'rebal_days': 14, 'sma_len': 150, 'stop_pct': 15, 'min_mom_pct': 5},
    {'name': 'LT_120_3_monthly',  'mom_lookback': 120,'top_n': 3, 'rebal_days': 21, 'sma_len': 200, 'stop_pct': 20, 'min_mom_pct': 10},
]


def test_config_full_period(eng, cfg, start_year, end_year, bench_ticker):
    """Walk-forward strict sur full period."""
    def fn(dt, ds):
        clean = {k: v for k, v in cfg.items() if k != 'name'}
        return momentum_safe(dt, ds, **clean)

    years = list(range(start_year, end_year + 1))
    results = eng.walk_forward_strict(fn, years=years)
    if not results:
        return None
    rets = [m['total_return_pct'] for m in results.values()]
    dds = [m['max_dd_pct'] for m in results.values()]
    n_pos = sum(1 for r in rets if r > 0)
    compound = (np.prod([1 + r / 100 for r in rets]) - 1) * 100

    # Benchmark
    bench_rets = []
    for y in years:
        if bench_ticker not in eng.data.columns:
            continue
        sub = eng.data[bench_ticker].loc[f'{y}-01-01':f'{y + 1}-01-01']
        if len(sub) < 30:
            continue
        bench_rets.append((sub.iloc[-1] / sub.iloc[0] - 1) * 100)
    bench_compound = (np.prod([1 + r / 100 for r in bench_rets]) - 1) * 100 if bench_rets else 0
    bench_mean = np.mean(bench_rets) if bench_rets else 0

    return {
        'config': cfg,
        'rets': rets,
        'mean': float(np.mean(rets)),
        'median': float(np.median(rets)),
        'compound': float(compound),
        'worst_dd': float(min(dds)),
        'n_pos': int(n_pos),
        'n_total': len(rets),
        'bench_compound': float(bench_compound),
        'bench_mean': float(bench_mean),
        'excess_mean': float(np.mean(rets) - bench_mean),
        'years': years,
    }


def main():
    print('=== LAB LONG-TERM - generalisation 13 ans ===\n')

    # === INDICES sur 2012-2025 ===
    print('=' * 90)
    print('IA INDICES - test sur 2012-2025 (13 ans, multi-regimes)')
    print('=' * 90)
    indices_univ = [
        'SPY','QQQ','IWM','DIA','EFA','VWO','IEF','TLT','GLD','SLV','DBC','USO',
        'XLK','XLE','XLF','XLV',
        'AAPL','MSFT','GOOGL','AMZN','JPM','V','WMT','UNH','JNJ','PG','KO','XOM',
    ]
    eng = LabEngine(universe=indices_univ, start='2010-01-01')

    results_indices = []
    for cfg in LONGTERM_CONFIGS_INDICES:
        print(f'\n--- {cfg["name"]} ---')
        r = test_config_full_period(eng, cfg, 2012, 2025, 'SPY')
        if r:
            print(f'  Mean {r["mean"]:>6.1f}% | Med {r["median"]:>5.1f}% | Comp {r["compound"]:>6.0f}% | wDD {r["worst_dd"]:>5.1f}% | {r["n_pos"]}/{r["n_total"]} pos | excess vs SPY {r["excess_mean"]:+.1f}%/an')
            results_indices.append(r)

    # Best
    print('\n\n--- TOP 3 INDICES (sorted by mean) ---')
    results_indices.sort(key=lambda x: -x['mean'])
    for i, r in enumerate(results_indices[:3]):
        print(f'  {i+1}. {r["config"]["name"]:<25} Mean {r["mean"]:.1f}% | DD {r["worst_dd"]:.1f}% | {r["n_pos"]}/{r["n_total"]} pos | excess {r["excess_mean"]:+.1f}%')

    # SPY ref
    bench_rets_ind = []
    for y in range(2012, 2026):
        sub = eng.data['SPY'].loc[f'{y}-01-01':f'{y + 1}-01-01']
        if len(sub) < 30:
            continue
        bench_rets_ind.append((sub.iloc[-1] / sub.iloc[0] - 1) * 100)
    print(f'\nSPY B&H ref : mean {np.mean(bench_rets_ind):.1f}%/an | compound {((np.prod([1 + r / 100 for r in bench_rets_ind]) - 1) * 100):.0f}%')

    # === CRYPTO sur 2019-2025 ===
    print('\n' + '=' * 90)
    print('IA CRYPTO - test sur 2019-2025 (7 ans, depuis maturation)')
    print('=' * 90)
    crypto_univ = [
        'BTC-USD','ETH-USD','LTC-USD','XRP-USD','BCH-USD','XLM-USD','ADA-USD',
        # Ajoutes en 2017+
        'SOL-USD','AVAX-USD','LINK-USD','MATIC-USD','ATOM-USD','UNI-USD','DOT-USD','AAVE-USD',
    ]
    eng_c = LabEngine(universe=crypto_univ, start='2016-01-01')

    results_crypto = []
    for cfg in LONGTERM_CONFIGS_CRYPTO:
        print(f'\n--- {cfg["name"]} ---')
        r = test_config_full_period(eng_c, cfg, 2019, 2025, 'BTC-USD')
        if r:
            print(f'  Mean {r["mean"]:>6.1f}% | Med {r["median"]:>5.1f}% | Comp {r["compound"]:>6.0f}% | wDD {r["worst_dd"]:>5.1f}% | {r["n_pos"]}/{r["n_total"]} pos | excess vs BTC {r["excess_mean"]:+.1f}%/an')
            results_crypto.append(r)

    print('\n\n--- TOP 3 CRYPTO ---')
    results_crypto.sort(key=lambda x: -x['mean'])
    for i, r in enumerate(results_crypto[:3]):
        print(f'  {i+1}. {r["config"]["name"]:<25} Mean {r["mean"]:.1f}% | DD {r["worst_dd"]:.1f}% | {r["n_pos"]}/{r["n_total"]} pos | excess {r["excess_mean"]:+.1f}%')

    bench_rets_c = []
    for y in range(2019, 2026):
        sub = eng_c.data['BTC-USD'].loc[f'{y}-01-01':f'{y + 1}-01-01']
        if len(sub) < 30:
            continue
        bench_rets_c.append((sub.iloc[-1] / sub.iloc[0] - 1) * 100)
    print(f'\nBTC B&H ref : mean {np.mean(bench_rets_c):.1f}%/an | compound {((np.prod([1 + r / 100 for r in bench_rets_c]) - 1) * 100):.0f}%')

    # Save
    out = OUTPUT_DIR / 'lab_longterm.json'
    with open(out, 'w') as f:
        json.dump({'indices': results_indices, 'crypto': results_crypto,
                  'bench_indices_mean': float(np.mean(bench_rets_ind)),
                  'bench_crypto_mean': float(np.mean(bench_rets_c))}, f, indent=2, default=str)
    print(f'\nSaved: {out}')


if __name__ == '__main__':
    main()
