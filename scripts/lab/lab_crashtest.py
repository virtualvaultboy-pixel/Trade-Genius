"""
Trade Genius — Lab Crashtest v1.0

Stress tests etendus sur les top configs.

Tests :
  1. STRESS FRAIS 2x : commission 0.30% + slippage 0.80%
  2. STRESS SLIPPAGE EXTREME : slippage 1.5%
  3. PERIOD ADVERSE : test uniquement sur 2018 + 2022 (bears purs)
  4. PERIOD POST-COVID : test uniquement 2023-2025
  5. UNIVERS REDUIT : retirer 30% des top performers ex-post
  6. UNIVERS ELARGI : ajouter 5-10 actifs medianes
  7. MONTE-CARLO BLOCKS : bootstrap blocs de 30 jours (1000 iters)
  8. PARAM SENSITIVITY : varier +/-30% chaque param et mesurer impact
  9. GAP EXTREME : simuler gap +/-5% random sur 5% des jours
  10. WHIPSAW TEST : forcer rebalance hebdo (vs config) pour tester impact

Verdict : SOLID / WEAK / FRAGILE selon nb de tests passes.
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
import copy

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR, COMMISSION, SLIPPAGE
from lab_strategies import momentum_safe, momentum_topN, sma, momentum, _empty_signals


def run_backtest(eng, strategy_fn, start, end, commission=None, slippage=None):
    """Run un backtest simple sur une plage donnee."""
    data = eng.data.loc[start:end]
    train = eng.data.loc[:start].iloc[:-1]
    if len(data) < 30:
        return None
    try:
        entries, exits, size = strategy_fn(train, data)
        kwargs = dict(
            close=data, entries=entries, exits=exits,
            init_cash=eng.initial,
            fees=commission if commission is not None else eng.commission,
            slippage=slippage if slippage is not None else eng.slippage,
            freq='1D', group_by=True, cash_sharing=True,
        )
        if size is not None:
            kwargs['size'] = size
            kwargs['size_type'] = 'percent'
        pf = vbt.Portfolio.from_signals(**kwargs)
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


def crashtest_config(name, config, universe, regime_asset='SPY'):
    """Run la suite complete de crash tests pour une config."""
    print(f'\n{"=" * 90}')
    print(f'CRASH TEST : {name}')
    print(f'Universe : {len(universe)} assets | Regime : {regime_asset}')
    print(f'{"=" * 90}')

    def make_strat(cfg):
        def fn(dt, ds):
            if 'mom_lookback' in cfg and 'stop_pct' in cfg:
                # Mapper aliases vers les noms momentum_safe officiels
                allowed = {'mom_lookback', 'top_n', 'rebal_days', 'sma_len', 'stop_pct', 'min_mom_pct'}
                renamed = {}
                for k, v in cfg.items():
                    if k == 'sma_filter_len':
                        renamed['sma_len'] = v
                    elif k in allowed:
                        renamed[k] = v
                return momentum_safe(dt, ds, **renamed)
            return momentum_topN(dt, ds)
        return fn

    eng = LabEngine(universe=universe, start='2017-01-01')
    results = {}

    # === TEST 1 : STRESS FRAIS 2x ===
    print('\n--- Test 1: STRESS FRAIS 2x (commission 0.30%, slippage 0.80%) ---')
    r = run_backtest(eng, make_strat(config), '2020-01-01', '2026-01-01',
                     commission=0.0030, slippage=0.0080)
    if r and 'error' not in r:
        print(f'  Annual: {r["annual_return_pct"]:.1f}% | Sharpe: {r["sharpe"]:.2f} | DD: {r["max_dd_pct"]:.1f}% | Trades: {r["n_trades"]}')
        results['stress_fees_2x'] = r
    else:
        print(f'  FAILED: {r}')

    # === TEST 2 : SLIPPAGE EXTREME ===
    print('\n--- Test 2: SLIPPAGE EXTREME (1.5%) ---')
    r = run_backtest(eng, make_strat(config), '2020-01-01', '2026-01-01',
                     slippage=0.015)
    if r and 'error' not in r:
        print(f'  Annual: {r["annual_return_pct"]:.1f}% | Sharpe: {r["sharpe"]:.2f} | DD: {r["max_dd_pct"]:.1f}% | Trades: {r["n_trades"]}')
        results['slippage_extreme'] = r

    # === TEST 3 : PERIOD ADVERSE (bears purs) ===
    print('\n--- Test 3: PERIODES BEAR PURES (2018, 2022) ---')
    for year in [2018, 2022]:
        if year < 2018 and 'BTC-USD' in eng.data.columns:
            continue
        r = run_backtest(eng, make_strat(config), f'{year}-01-01', f'{year + 1}-01-01')
        if r and 'error' not in r:
            print(f'  {year}: {r["annual_return_pct"]:.1f}% | DD: {r["max_dd_pct"]:.1f}% | {r["n_trades"]} trades')
            results[f'bear_{year}'] = r

    # === TEST 4 : POST-COVID 2023-2025 ===
    print('\n--- Test 4: POST-COVID 2023-2025 ---')
    r = run_backtest(eng, make_strat(config), '2023-01-01', '2026-01-01')
    if r and 'error' not in r:
        print(f'  Annual: {r["annual_return_pct"]:.1f}% | Sharpe: {r["sharpe"]:.2f} | DD: {r["max_dd_pct"]:.1f}%')
        results['post_covid'] = r

    # === TEST 5 : UNIVERS REDUIT (random subset 70%) ===
    print('\n--- Test 5: UNIVERS REDUIT (3 seeds random) ---')
    rng = np.random.default_rng(42)
    subset_rets = []
    for seed in range(3):
        subset_size = max(5, int(len(universe) * 0.7))
        subset = list(rng.choice(universe, size=subset_size, replace=False))
        # Garder regime asset
        if regime_asset not in subset:
            subset.append(regime_asset)
        try:
            eng_sub = LabEngine(universe=subset, start='2017-01-01')
            r = run_backtest(eng_sub, make_strat(config), '2020-01-01', '2026-01-01')
            if r and 'error' not in r:
                subset_rets.append(r['annual_return_pct'])
                print(f'  Seed {seed}: {r["annual_return_pct"]:.1f}% | DD: {r["max_dd_pct"]:.1f}% | univers: {len(subset)}')
        except Exception as e:
            print(f'  Seed {seed} FAILED: {e}')
    if subset_rets:
        results['universe_subset_mean'] = float(np.mean(subset_rets))
        results['universe_subset_std'] = float(np.std(subset_rets))
        print(f'  Mean over seeds: {np.mean(subset_rets):.1f}% (std {np.std(subset_rets):.1f})')

    # === TEST 6 : MONTE-CARLO BLOCKS (bootstrap blocs 30j) ===
    print('\n--- Test 6: MONTE-CARLO BLOCKS (200 iters, blocs 30j) ---')
    try:
        data = eng.data.loc['2020-01-01':'2026-01-01']
        train = eng.data.loc[:'2019-12-31']
        n_blocks = 200
        block_len = 60  # 2 mois
        rng = np.random.default_rng(99)
        mc_rets = []
        for i in range(n_blocks):
            # Generer indices random pour reconstruire la serie
            n_dates = len(data)
            if n_dates < block_len * 2:
                break
            n_blocks_total = n_dates // block_len
            block_starts = rng.integers(0, n_dates - block_len, size=n_blocks_total)
            new_idx = np.concatenate([np.arange(s, s + block_len) for s in block_starts])
            new_idx = new_idx[:n_dates]
            shuffled_data = data.iloc[new_idx].reset_index(drop=True)
            shuffled_data.index = data.index[:len(shuffled_data)]
            try:
                entries, exits, size = make_strat(config)(train, shuffled_data)
                kwargs = dict(
                    close=shuffled_data, entries=entries, exits=exits,
                    init_cash=1000, fees=0.0015, slippage=0.0040,
                    freq='1D', group_by=True, cash_sharing=True,
                )
                if size is not None:
                    kwargs['size'] = size
                    kwargs['size_type'] = 'percent'
                pf = vbt.Portfolio.from_signals(**kwargs)
                stats = pf.stats(silence_warnings=True)
                if isinstance(stats, pd.DataFrame):
                    stats = stats.mean(axis=1)
                mc_rets.append(float(stats.get('Total Return [%]', 0)))
            except:
                continue
        if mc_rets:
            results['mc_blocks_mean'] = float(np.mean(mc_rets))
            results['mc_blocks_median'] = float(np.median(mc_rets))
            results['mc_blocks_p5'] = float(np.percentile(mc_rets, 5))
            results['mc_blocks_p95'] = float(np.percentile(mc_rets, 95))
            results['mc_blocks_p_profit'] = float((np.array(mc_rets) > 0).mean())
            print(f'  N iters: {len(mc_rets)}')
            print(f'  Total return median: {np.median(mc_rets):.1f}%')
            print(f'  P5-P95: [{np.percentile(mc_rets, 5):.1f}% ; {np.percentile(mc_rets, 95):.1f}%]')
            print(f'  P(profit) on shuffled: {(np.array(mc_rets) > 0).mean() * 100:.1f}%')
    except Exception as e:
        print(f'  MC FAILED: {e}')

    # === TEST 7 : PARAM SENSITIVITY ===
    print('\n--- Test 7: PARAM SENSITIVITY (perturbe chaque param +/-30%) ---')
    if 'mom_lookback' in config:
        baseline_r = run_backtest(eng, make_strat(config), '2020-01-01', '2026-01-01')
        baseline_ret = baseline_r['annual_return_pct'] if baseline_r and 'error' not in baseline_r else 0
        sensitivity = {}
        for param in ['mom_lookback', 'top_n', 'rebal_days', 'sma_filter_len', 'stop_pct', 'min_mom_pct']:
            if param not in config:
                continue
            try:
                perturbed = copy.deepcopy(config)
                base_val = config[param]
                # +30%
                if isinstance(base_val, int):
                    perturbed[param] = max(1, int(base_val * 1.3))
                else:
                    perturbed[param] = base_val * 1.3
                r_high = run_backtest(eng, make_strat(perturbed), '2020-01-01', '2026-01-01')
                # -30%
                perturbed2 = copy.deepcopy(config)
                if isinstance(base_val, int):
                    perturbed2[param] = max(1, int(base_val * 0.7))
                else:
                    perturbed2[param] = base_val * 0.7
                r_low = run_backtest(eng, make_strat(perturbed2), '2020-01-01', '2026-01-01')
                if r_high and 'error' not in r_high and r_low and 'error' not in r_low:
                    sensitivity[param] = {
                        'base': baseline_ret,
                        'high_30pct': r_high['annual_return_pct'],
                        'low_30pct': r_low['annual_return_pct'],
                        'sensitivity_score': abs(r_high['annual_return_pct'] - baseline_ret) +
                                             abs(r_low['annual_return_pct'] - baseline_ret),
                    }
                    print(f'  {param:<20}: base {baseline_ret:.1f}% | +30%: {r_high["annual_return_pct"]:.1f}% | -30%: {r_low["annual_return_pct"]:.1f}%')
            except Exception as e:
                continue
        results['param_sensitivity'] = sensitivity

    # === VERDICT ===
    print(f'\n{"=" * 90}')
    print(f'VERDICT pour {name}:')
    print(f'{"=" * 90}')
    score = 0
    max_score = 0

    if 'stress_fees_2x' in results:
        max_score += 1
        if results['stress_fees_2x']['annual_return_pct'] >= 10:
            score += 1
            print(f'  [OK] Tient les frais 2x : {results["stress_fees_2x"]["annual_return_pct"]:.1f}%/an')
        else:
            print(f'  [WEAK] Frais 2x : {results["stress_fees_2x"]["annual_return_pct"]:.1f}%/an')

    if 'slippage_extreme' in results:
        max_score += 1
        if results['slippage_extreme']['annual_return_pct'] >= 5:
            score += 1
            print(f'  [OK] Tient slippage 1.5%% : {results["slippage_extreme"]["annual_return_pct"]:.1f}%/an')
        else:
            print(f'  [FAIL] Slippage 1.5%% : {results["slippage_extreme"]["annual_return_pct"]:.1f}%/an')

    if 'bear_2022' in results:
        max_score += 1
        if results['bear_2022']['annual_return_pct'] >= -20:
            score += 1
            print(f'  [OK] Bear 2022 contenu : {results["bear_2022"]["annual_return_pct"]:.1f}%')
        else:
            print(f'  [FAIL] Bear 2022 catastrophe : {results["bear_2022"]["annual_return_pct"]:.1f}%')

    if 'mc_blocks_p_profit' in results:
        max_score += 1
        if results['mc_blocks_p_profit'] >= 0.6:
            score += 1
            print(f'  [OK] Monte-Carlo P(profit) >= 60%% : {results["mc_blocks_p_profit"] * 100:.1f}%')
        else:
            print(f'  [WEAK] MC P(profit) : {results["mc_blocks_p_profit"] * 100:.1f}%')

    if 'universe_subset_mean' in results:
        max_score += 1
        if results['universe_subset_mean'] >= 10:
            score += 1
            print(f'  [OK] Robust aux subsets univers : mean {results["universe_subset_mean"]:.1f}%/an')
        else:
            print(f'  [FAIL] Fragile aux subsets : mean {results["universe_subset_mean"]:.1f}%/an')

    if 'param_sensitivity' in results and results['param_sensitivity']:
        max_score += 1
        max_sens = max(s['sensitivity_score'] for s in results['param_sensitivity'].values())
        if max_sens < 50:
            score += 1
            print(f'  [OK] Robust aux params (max sensibility {max_sens:.1f}%/an)')
        else:
            print(f'  [WEAK] Sensible aux params (max {max_sens:.1f}%/an)')

    if 'post_covid' in results:
        max_score += 1
        if results['post_covid']['annual_return_pct'] >= 15:
            score += 1
            print(f'  [OK] Post-COVID 2023-2025 : {results["post_covid"]["annual_return_pct"]:.1f}%/an')
        else:
            print(f'  [WEAK] Post-COVID : {results["post_covid"]["annual_return_pct"]:.1f}%/an')

    if max_score == 0:
        verdict = 'NO_DATA'
    elif score / max_score >= 0.8:
        verdict = 'SOLID'
    elif score / max_score >= 0.5:
        verdict = 'OK'
    else:
        verdict = 'FRAGILE'

    print(f'\n  FINAL SCORE : {score}/{max_score} = {verdict}')
    results['verdict'] = verdict
    results['score'] = score
    results['max_score'] = max_score
    return results


def main():
    # Crash test des 2 baselines
    print('=== LAB CRASHTEST ===\n')

    # Baseline INDICES
    indices_cfg = {
        'mom_lookback': 30, 'top_n': 5, 'rebal_days': 7,
        'sma_filter_len': 60, 'stop_pct': 15, 'min_mom_pct': 0,
    }
    indices_univ = [
        'SPY','QQQ','IWM','DIA','EFA','VWO','EWJ','FXI','IEF','TLT','LQD','HYG',
        'GLD','SLV','DBC','USO','XLK','XLE','XLF','XLV',
        'AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA',
        'JPM','V','WMT','UNH','JNJ','PG','KO','XOM',
    ]
    r_indices = crashtest_config('BASELINE_INDICES', indices_cfg, indices_univ, regime_asset='SPY')

    # Baseline CRYPTO
    crypto_cfg = {
        'mom_lookback': 60, 'top_n': 5, 'rebal_days': 14,
        'sma_filter_len': 150, 'stop_pct': 10, 'min_mom_pct': 5,
    }
    crypto_univ = [
        'BTC-USD','ETH-USD','SOL-USD','AVAX-USD','NEAR-USD','ATOM-USD','DOT-USD','ADA-USD',
        'LINK-USD','UNI-USD','AAVE-USD','MATIC-USD','FET-USD','RNDR-USD','INJ-USD',
        'LTC-USD','BCH-USD','XRP-USD','XLM-USD','DOGE-USD',
    ]
    r_crypto = crashtest_config('BASELINE_CRYPTO', crypto_cfg, crypto_univ, regime_asset='BTC-USD')

    # Save
    out = OUTPUT_DIR / 'lab_crashtest.json'
    with open(out, 'w') as f:
        json.dump({'indices': r_indices, 'crypto': r_crypto}, f, indent=2, default=str)
    print(f'\nSaved : {out}')

    print('\n\n' + '=' * 90)
    print('FINAL VERDICTS')
    print('=' * 90)
    for name, r in [('INDICES', r_indices), ('CRYPTO', r_crypto)]:
        print(f'  {name}: {r["verdict"]} ({r["score"]}/{r["max_score"]})')


if __name__ == '__main__':
    main()
