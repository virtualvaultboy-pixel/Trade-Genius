"""
Trade Genius — Lab Monte Carlo v1.0

Validation Monte-Carlo robustesse :
1. Trade shuffling (bootstrap des PnL) : intervalle confiance 95% sur returns/DD
2. Time bootstrap (random window subsets) : robustesse vs régime
3. Param perturbation : sensibilité aux hyperparams

Usage :
    from lab_montecarlo import monte_carlo_validate
    mc = monte_carlo_validate(eng, strategy_fn, n_iters=1000)
"""
import sys
import os
import warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
import vectorbt as vbt
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, COMMISSION, SLIPPAGE, INITIAL_CAPITAL, OUTPUT_DIR


def monte_carlo_trade_shuffle(pf, n_iters=1000, initial=INITIAL_CAPITAL):
    """
    Trade shuffling : resample avec remise des PnL trades pour estimer
    distribution finale.
    """
    try:
        trades = pf.trades.records_readable
        if len(trades) == 0:
            return None
        # Convertir en returns par trade (relatif à entry price)
        pnl_pct = trades['Return [%]'].values / 100.0
        n_trades = len(pnl_pct)

        results = []
        rng = np.random.default_rng(42)
        for _ in range(n_iters):
            sampled = rng.choice(pnl_pct, size=n_trades, replace=True)
            # Compound (assume sequential trades fully invested)
            equity_factor = np.cumprod(1 + sampled)
            final = initial * equity_factor[-1]
            peak = np.maximum.accumulate(equity_factor)
            dd = ((equity_factor - peak) / peak).min() * 100
            results.append({'final': final, 'dd': dd})
        df = pd.DataFrame(results)
        return {
            'n_iters': n_iters,
            'n_trades': n_trades,
            'final_mean': df['final'].mean(),
            'final_median': df['final'].median(),
            'final_p5': df['final'].quantile(0.05),
            'final_p95': df['final'].quantile(0.95),
            'p_profit': (df['final'] > initial).mean(),
            'dd_mean': df['dd'].mean(),
            'dd_p5': df['dd'].quantile(0.05),
            'dd_worst': df['dd'].min(),
        }
    except Exception as e:
        print(f'MC trade shuffle failed: {e}')
        return None


def monte_carlo_time_bootstrap(eng, strategy_fn, n_iters=200, window_years=2, train_start='2017-01-01'):
    """
    Time bootstrap : 200 fenêtres random de N années dans [2018, 2025].
    Pour chaque, run strategy et collecter stats.
    """
    rng = np.random.default_rng(43)
    available_years = list(range(2018, 2026 - window_years + 1))
    results = []

    for i in range(n_iters):
        start_year = rng.choice(available_years)
        end_year = start_year + window_years
        start_dt = f'{start_year}-01-01'
        end_dt = f'{end_year}-01-01'
        data_test = eng.data.loc[start_dt:end_dt]
        if len(data_test) < 200:
            continue
        # Train = tout le data antérieur
        train_end = pd.Timestamp(start_dt) - pd.Timedelta(days=1)
        data_train = eng.data.loc[train_start:train_end]
        if len(data_train) < 250:
            continue
        try:
            entries, exits, size = strategy_fn(data_train, data_test)
            pf_kwargs = dict(
                close=data_test, entries=entries, exits=exits,
                init_cash=eng.initial, fees=eng.commission, slippage=eng.slippage,
                freq='1D', group_by=True, cash_sharing=True,
            )
            if size is not None:
                pf_kwargs['size'] = size
                pf_kwargs['size_type'] = 'percent'
            pf = vbt.Portfolio.from_signals(**pf_kwargs)
            stats = pf.stats(silence_warnings=True)
            if isinstance(stats, pd.DataFrame):
                stats = stats.mean(axis=1)
            results.append({
                'start_year': start_year,
                'end_year': end_year,
                'return_pct': float(stats.get('Total Return [%]', 0)),
                'dd_pct': float(stats.get('Max Drawdown [%]', 0)),
            })
        except Exception:
            continue

    if not results:
        return None
    df = pd.DataFrame(results)
    return {
        'n_iters': len(results),
        'window_years': window_years,
        'return_mean': df['return_pct'].mean(),
        'return_median': df['return_pct'].median(),
        'return_p5': df['return_pct'].quantile(0.05),
        'return_p95': df['return_pct'].quantile(0.95),
        'p_profit': (df['return_pct'] > 0).mean(),
        'dd_mean': df['dd_pct'].mean(),
        'dd_worst': df['dd_pct'].min(),
        'dd_p5': df['dd_pct'].quantile(0.05),
    }


def print_mc_report(mc_shuffle, mc_time, strategy_name='strategy'):
    print('\n' + '=' * 80)
    print(f'MONTE-CARLO VALIDATION : {strategy_name}')
    print('=' * 80)
    if mc_shuffle:
        print('\nTrade shuffling (resample des PnL):')
        print(f'  n trades : {mc_shuffle["n_trades"]} | n iters : {mc_shuffle["n_iters"]}')
        print(f'  Final capital median : {mc_shuffle["final_median"]:.0f}E (start 1000E)')
        print(f'  Final P5-P95 : [{mc_shuffle["final_p5"]:.0f}E ; {mc_shuffle["final_p95"]:.0f}E]')
        print(f'  P(profit) : {mc_shuffle["p_profit"] * 100:.1f}%')
        print(f'  DD worst (P5) : {mc_shuffle["dd_p5"]:.1f}% | DD min absolu : {mc_shuffle["dd_worst"]:.1f}%')
    if mc_time:
        print(f'\nTime bootstrap ({mc_time["window_years"]} ans, {mc_time["n_iters"]} fenetres):')
        print(f'  Return median : {mc_time["return_median"]:.1f}% sur la fenetre')
        print(f'  Return P5-P95 : [{mc_time["return_p5"]:.1f}% ; {mc_time["return_p95"]:.1f}%]')
        print(f'  P(profit) : {mc_time["p_profit"] * 100:.1f}%')
        print(f'  DD median : {mc_time["dd_mean"]:.1f}% | DD worst : {mc_time["dd_worst"]:.1f}%')
    print('=' * 80)


def validate(eng, strategy_fn, n_shuffle=1000, n_time=200, label='strategy'):
    """One-stop validation."""
    # 1. Run la strategy sur tout le test period
    test_data = eng.data.loc['2018-01-01':]
    train_data = eng.data.loc[:'2017-12-31']
    try:
        entries, exits, size = strategy_fn(train_data, test_data)
        pf_kwargs = dict(
            close=test_data, entries=entries, exits=exits,
            init_cash=eng.initial, fees=eng.commission, slippage=eng.slippage,
            freq='1D', group_by=True, cash_sharing=True,
        )
        if size is not None:
            pf_kwargs['size'] = size
            pf_kwargs['size_type'] = 'percent'
        pf = vbt.Portfolio.from_signals(**pf_kwargs)
    except Exception as e:
        print(f'validate failed: {e}')
        return None

    mc_shuffle = monte_carlo_trade_shuffle(pf, n_iters=n_shuffle)
    mc_time = monte_carlo_time_bootstrap(eng, strategy_fn, n_iters=n_time)
    print_mc_report(mc_shuffle, mc_time, strategy_name=label)
    return {'shuffle': mc_shuffle, 'time': mc_time}


if __name__ == '__main__':
    # Test
    from lab_strategies import momentum_safe
    eng = LabEngine(universe='crypto_20', start='2016-01-01')
    validate(eng, momentum_safe, n_shuffle=500, n_time=100, label='momentum_safe_default')
