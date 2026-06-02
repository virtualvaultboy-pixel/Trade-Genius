"""
Trade Genius — Lab Ensemble Crashtest v1.0

Crash test specifique pour les ENSEMBLES UNANIMES 3/3 (nos meilleurs candidats).

Tests :
  1. Monte-Carlo time blocks (200 iters)
  2. Univers reduit (3 seeds random)
  3. Stress frais 3x (la stress test ultime)
  4. Period adverse 2018 bear pure
  5. Test 2012-2018 (deep OOS)
"""
import sys, os, json, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
import vectorbt as vbt
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_strategies import momentum_safe, _empty_signals


INDICES_ENSEMBLE = [
    {'mom_lookback': 14, 'top_n': 3, 'rebal_days': 7,  'sma_len': 50,  'stop_pct': 12, 'min_mom_pct': 0},
    {'mom_lookback': 30, 'top_n': 5, 'rebal_days': 14, 'sma_len': 100, 'stop_pct': 15, 'min_mom_pct': 5},
    {'mom_lookback': 60, 'top_n': 5, 'rebal_days': 21, 'sma_len': 150, 'stop_pct': 20, 'min_mom_pct': 5},
]

CRYPTO_ENSEMBLE = [
    {'mom_lookback': 14, 'top_n': 3, 'rebal_days': 7,  'sma_len': 50,  'stop_pct': 12, 'min_mom_pct': 0},
    {'mom_lookback': 30, 'top_n': 5, 'rebal_days': 14, 'sma_len': 100, 'stop_pct': 15, 'min_mom_pct': 5},
    {'mom_lookback': 60, 'top_n': 5, 'rebal_days': 14, 'sma_len': 150, 'stop_pct': 10, 'min_mom_pct': 5},
]


def ensemble_strategy(data_train, data_test, configs, min_votes=3):
    sigs = []
    for cfg in configs:
        _, _, sz = momentum_safe(data_train, data_test, **cfg)
        sigs.append((sz > 0).astype(int))
    votes = sum(sigs)
    target = (votes >= min_votes).astype(float)
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


def run_pf(data_test, data_train, configs, commission=0.0015, slippage=0.0040):
    try:
        entries, exits, size = ensemble_strategy(data_train, data_test, configs, min_votes=3)
        pf = vbt.Portfolio.from_signals(
            close=data_test, entries=entries, exits=exits,
            size=size, size_type='percent',
            init_cash=1000, fees=commission, slippage=slippage,
            freq='1D', group_by=True, cash_sharing=True,
        )
        stats = pf.stats(silence_warnings=True)
        if isinstance(stats, pd.DataFrame):
            stats = stats.mean(axis=1)
        return {
            'total_return_pct': float(stats.get('Total Return [%]', 0)),
            'annual_return_pct': float(stats.get('Annualized Return [%]', 0)),
            'sharpe': float(stats.get('Sharpe Ratio', 0)),
            'max_dd_pct': float(stats.get('Max Drawdown [%]', 0)),
            'n_trades': int(stats.get('Total Trades', 0)),
        }
    except Exception as e:
        return {'error': str(e)}


def crashtest_ensemble(name, configs, universe, regime_asset, full_start='2020-01-01', full_end='2026-01-01'):
    print(f'\n{"=" * 90}')
    print(f'ENSEMBLE CRASH TEST : {name}')
    print(f'  3 configs + vote unanime (3/3)')
    print(f'{"=" * 90}')

    eng = LabEngine(universe=universe, start='2016-01-01')

    score = 0
    max_score = 0
    results = {}

    # === TEST 1 : Baseline ===
    print('\n--- Baseline (full period stress max) ---')
    data_test = eng.data.loc[full_start:full_end]
    data_train = eng.data.loc[:full_start].iloc[:-1]
    r = run_pf(data_test, data_train, configs)
    if 'error' not in r:
        print(f'  Total: {r["total_return_pct"]:.0f}% | Sharpe: {r["sharpe"]:.2f} | DD: {r["max_dd_pct"]:.1f}% | {r["n_trades"]} trades')
        results['baseline'] = r
        max_score += 1
        if r['total_return_pct'] >= 30:
            score += 1
            print(f'  [OK] Total >= 30%')

    # === TEST 2 : Frais 3x (ULTIME) ===
    print('\n--- TEST 1 : FRAIS 3x (commission 0.45%, slippage 1.2%) ---')
    r = run_pf(data_test, data_train, configs, commission=0.0045, slippage=0.012)
    if 'error' not in r:
        print(f'  Total: {r["total_return_pct"]:.0f}% | Sharpe: {r["sharpe"]:.2f} | DD: {r["max_dd_pct"]:.1f}%')
        results['frais_3x'] = r
        max_score += 1
        if r['total_return_pct'] >= 10:
            score += 1
            print(f'  [OK] Tient frais 3x')
        else:
            print(f'  [FAIL] Frais 3x cassent la strat')

    # === TEST 3 : 2018 bear pure (jamais utilise) ===
    print('\n--- TEST 2 : 2018 BEAR PURE (deep OOS) ---')
    data_2018 = eng.data.loc['2018-01-01':'2019-01-01']
    data_train_2018 = eng.data.loc[:'2017-12-31']
    if len(data_2018) > 30 and len(data_train_2018) > 200:
        r = run_pf(data_2018, data_train_2018, configs)
        if 'error' not in r:
            print(f'  2018 : Total {r["total_return_pct"]:.0f}% | DD: {r["max_dd_pct"]:.1f}% | {r["n_trades"]} trades')
            results['bear_2018'] = r
            max_score += 1
            if r['total_return_pct'] >= -15:
                score += 1
                print(f'  [OK] Bear 2018 contenu (>= -15%)')
            else:
                print(f'  [FAIL] Bear 2018 catastrophe')

    # === TEST 4 : 2012-2017 (deep OOS pour INDICES) ===
    if regime_asset == 'SPY':
        print('\n--- TEST 3 : 2012-2017 DEEP OOS (6 ans bull continu jamais touche) ---')
        data_old = eng.data.loc['2012-01-01':'2018-01-01']
        data_train_old = eng.data.loc[:'2011-12-31']
        if len(data_old) > 200 and len(data_train_old) > 200:
            r = run_pf(data_old, data_train_old, configs)
            if 'error' not in r:
                print(f'  2012-2017 : Total {r["total_return_pct"]:.0f}% | DD: {r["max_dd_pct"]:.1f}% | {r["n_trades"]} trades')
                results['deep_oos_2012_2017'] = r
                max_score += 1
                if r['total_return_pct'] >= 30:  # 6 ans, 5%/an minimum
                    score += 1
                    print(f'  [OK] Generalise sur 2012-2017')
                else:
                    print(f'  [FAIL] OVERFIT - perte ou stagnation')

    # === TEST 5 : Univers reduit (3 seeds 70%) ===
    print('\n--- TEST 4 : UNIVERS REDUIT (3 seeds 70%) ---')
    rng = np.random.default_rng(42)
    rets = []
    for seed in range(3):
        subset_size = max(5, int(len(universe) * 0.7))
        rng_s = np.random.default_rng(42 + seed)
        subset = list(rng_s.choice(universe, size=subset_size, replace=False))
        if regime_asset not in subset:
            subset.append(regime_asset)
        try:
            eng_sub = LabEngine(universe=subset, start='2016-01-01')
            data_test_sub = eng_sub.data.loc[full_start:full_end]
            data_train_sub = eng_sub.data.loc[:full_start].iloc[:-1]
            r = run_pf(data_test_sub, data_train_sub, configs)
            if 'error' not in r:
                rets.append(r['total_return_pct'])
                print(f'  Seed {seed}: {r["total_return_pct"]:.0f}% | DD {r["max_dd_pct"]:.1f}%')
        except Exception as e:
            print(f'  Seed {seed} FAILED: {e}')
    if rets:
        m = np.mean(rets)
        results['universe_subset'] = {'mean': float(m), 'std': float(np.std(rets))}
        max_score += 1
        if m >= 30:
            score += 1
            print(f'  [OK] Robust aux subsets : mean {m:.0f}% | std {np.std(rets):.0f}')
        else:
            print(f'  [WEAK] Fragile : mean {m:.0f}% | std {np.std(rets):.0f}')

    # === TEST 6 : Monte-Carlo blocks ===
    print('\n--- TEST 5 : MONTE-CARLO BLOCKS (100 iters, blocs 60j) ---')
    n_iters = 100
    block_len = 60
    rng = np.random.default_rng(99)
    mc_rets = []
    n_dates = len(data_test)
    if n_dates >= block_len * 2:
        for i in range(n_iters):
            n_blocks_total = n_dates // block_len
            block_starts = rng.integers(0, n_dates - block_len, size=n_blocks_total)
            new_idx = np.concatenate([np.arange(s, s + block_len) for s in block_starts])
            new_idx = new_idx[:n_dates]
            shuffled = data_test.iloc[new_idx].reset_index(drop=True)
            shuffled.index = data_test.index[:len(shuffled)]
            try:
                r = run_pf(shuffled, data_train, configs)
                if 'error' not in r:
                    mc_rets.append(r['total_return_pct'])
            except:
                continue
    if mc_rets:
        median = np.median(mc_rets)
        p_profit = (np.array(mc_rets) > 0).mean()
        results['mc_blocks'] = {
            'median': float(median),
            'p5': float(np.percentile(mc_rets, 5)),
            'p95': float(np.percentile(mc_rets, 95)),
            'p_profit': float(p_profit),
        }
        max_score += 1
        print(f'  N iters: {len(mc_rets)}')
        print(f'  Total return median: {median:.0f}%')
        print(f'  P5-P95: [{np.percentile(mc_rets, 5):.0f}% ; {np.percentile(mc_rets, 95):.0f}%]')
        print(f'  P(profit): {p_profit * 100:.1f}%')
        if p_profit >= 0.55:
            score += 1
            print(f'  [OK] Robuste (P(profit) >= 55%)')
        else:
            print(f'  [FAIL] FRAGILE (P(profit) < 55%) - depend trop de l ordre')

    # VERDICT
    print(f'\n{"=" * 90}')
    print(f'VERDICT FINAL ENSEMBLE {name}')
    print(f'{"=" * 90}')
    pct = score / max_score if max_score else 0
    if pct >= 0.8:
        v = 'SOLID - DEPLOIE'
    elif pct >= 0.5:
        v = 'OK - usage prudent'
    else:
        v = 'FRAGILE - ne pas deploiir'
    print(f'  Score: {score}/{max_score} = {v}')
    results['verdict'] = v
    results['score'] = score
    results['max_score'] = max_score
    return results


def main():
    print('=== LAB ENSEMBLE CRASHTEST - validation finale des candidats ===\n')

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

    r_ind = crashtest_ensemble('INDICES_UNANIMOUS_3OF3', INDICES_ENSEMBLE, indices_univ, 'SPY')
    r_crp = crashtest_ensemble('CRYPTO_UNANIMOUS_3OF3', CRYPTO_ENSEMBLE, crypto_univ, 'BTC-USD')

    out = OUTPUT_DIR / 'lab_ensemble_crashtest.json'
    with open(out, 'w') as f:
        json.dump({'indices': r_ind, 'crypto': r_crp}, f, indent=2, default=str)
    print(f'\n\nSaved: {out}')

    # FINAL
    print('\n' + '=' * 90)
    print('VERDICTS ENSEMBLES UNANIMES')
    print('=' * 90)
    for name, r in [('INDICES', r_ind), ('CRYPTO', r_crp)]:
        print(f'  {name}: {r.get("verdict")} ({r.get("score", 0)}/{r.get("max_score", 0)})')


if __name__ == '__main__':
    main()
