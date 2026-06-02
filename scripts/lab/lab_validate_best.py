"""
Trade Genius — Lab Validate Best v1.0

Validation finale des top configs du grid search :
1. Monte-Carlo trade shuffling (1000 iters) - intervalle confiance 95%
2. Monte-Carlo time bootstrap (200 fenêtres random 2-3 ans)
3. Rapport QuantStats HTML complet
4. Test sur univers ALTERNATIF (crypto_10 plus stable) pour out-of-sample univers
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
from lab_engine import LabEngine, OUTPUT_DIR, COMMISSION, SLIPPAGE, INITIAL_CAPITAL
from lab_strategies import momentum_safe
from lab_montecarlo import monte_carlo_trade_shuffle, monte_carlo_time_bootstrap


CANDIDATES = {
    'MAX_COMPOUND': dict(mom_lookback=60, top_n=5, rebal_days=21, sma_len=60, stop_pct=25, min_mom_pct=5),
    'MIN_DD':       dict(mom_lookback=60, top_n=5, rebal_days=14, sma_len=150, stop_pct=10, min_mom_pct=5),
    'MAX_STABILITY':dict(mom_lookback=14, top_n=3, rebal_days=21, sma_len=60, stop_pct=15, min_mom_pct=0),
}


def make_strategy(cfg):
    def fn(data_train, data_test):
        return momentum_safe(data_train, data_test, **cfg)
    return fn


def full_period_pf(eng, strategy_fn, start='2018-01-01'):
    """Run la strategy sur la full période en une fois."""
    train_end = pd.Timestamp(start) - pd.Timedelta(days=1)
    data_train = eng.data.loc[:train_end]
    data_test = eng.data.loc[start:]
    entries, exits, size = strategy_fn(data_train, data_test)
    kwargs = dict(
        close=data_test, entries=entries, exits=exits,
        init_cash=eng.initial, fees=eng.commission, slippage=eng.slippage,
        freq='1D', group_by=True, cash_sharing=True,
    )
    if size is not None:
        kwargs['size'] = size
        kwargs['size_type'] = 'percent'
    return vbt.Portfolio.from_signals(**kwargs)


def gen_quantstats_report(pf, name, output_dir):
    """Génère un rapport HTML QuantStats."""
    try:
        import quantstats as qs
        returns = pf.returns()
        if isinstance(returns, pd.DataFrame):
            returns = returns.iloc[:, 0] if returns.shape[1] == 1 else returns.mean(axis=1)
        # benchmark BTC
        btc_returns = None
        # Trouver dans eng les data BTC
        out_file = output_dir / f'report_{name}.html'
        qs.reports.html(returns, title=f'{name} - Trade Genius Lab', output=str(out_file))
        print(f'  HTML report saved: {out_file}')
        return out_file
    except Exception as e:
        print(f'  HTML report failed: {e}')
        return None


def detailed_stats(pf, label):
    """Print stats détaillées."""
    stats = pf.stats(silence_warnings=True)
    if isinstance(stats, pd.DataFrame):
        stats = stats.mean(axis=1)
    print(f'\n--- {label} stats ---')
    keys = ['Total Return [%]', 'Annualized Return [%]', 'Sharpe Ratio', 'Sortino Ratio',
            'Calmar Ratio', 'Max Drawdown [%]', 'Win Rate [%]', 'Profit Factor', 'Total Trades',
            'Best Trade [%]', 'Worst Trade [%]', 'Avg Trade [%]', 'Expectancy']
    for k in keys:
        if k in stats.index:
            v = stats[k]
            try:
                print(f'  {k:.<30s} {float(v):>12.2f}')
            except:
                print(f'  {k:.<30s} {v!s:>12s}')


def main():
    print('=== VALIDATE BEST CONFIGS ===\n')
    eng = LabEngine(universe='crypto_20', start='2016-01-01')
    print(f'Data: {eng.data.shape}')

    all_validation = {}
    for name, cfg in CANDIDATES.items():
        print(f'\n{"=" * 80}')
        print(f'CANDIDATE: {name}')
        print(f'Config: {cfg}')
        print(f'{"=" * 80}')

        strat = make_strategy(cfg)

        # Full period backtest
        pf = full_period_pf(eng, strat, start='2018-01-01')
        detailed_stats(pf, name)

        # MC trade shuffling
        print(f'\nMonte-Carlo trade shuffling (1000 iters)...')
        mc_shuffle = monte_carlo_trade_shuffle(pf, n_iters=1000)
        if mc_shuffle:
            print(f'  Final median: {mc_shuffle["final_median"]:.0f}E (start 1000E)')
            print(f'  Final P5-P95: [{mc_shuffle["final_p5"]:.0f}E ; {mc_shuffle["final_p95"]:.0f}E]')
            print(f'  P(profit): {mc_shuffle["p_profit"] * 100:.1f}%')
            print(f'  DD P5: {mc_shuffle["dd_p5"]:.1f}% | DD worst: {mc_shuffle["dd_worst"]:.1f}%')

        # MC time bootstrap
        print(f'\nMonte-Carlo time bootstrap (200 iters, 2 ans fenetre)...')
        mc_time = monte_carlo_time_bootstrap(eng, strat, n_iters=200, window_years=2)
        if mc_time:
            print(f'  Return median (2 ans): {mc_time["return_median"]:.1f}%')
            print(f'  Return P5-P95: [{mc_time["return_p5"]:.1f}% ; {mc_time["return_p95"]:.1f}%]')
            print(f'  P(profit 2 ans): {mc_time["p_profit"] * 100:.1f}%')
            print(f'  DD worst: {mc_time["dd_worst"]:.1f}%')

        # Test sur crypto_10 (OOS univers)
        print(f'\n--- OOS univers crypto_10 ---')
        eng_oos = LabEngine(universe='crypto_10', start='2016-01-01')
        pf_oos = full_period_pf(eng_oos, strat, start='2018-01-01')
        stats_oos = pf_oos.stats(silence_warnings=True)
        if isinstance(stats_oos, pd.DataFrame):
            stats_oos = stats_oos.mean(axis=1)
        print(f'  Total Return: {float(stats_oos.get("Total Return [%]", 0)):.0f}%')
        print(f'  Annual Return: {float(stats_oos.get("Annualized Return [%]", 0)):.1f}%')
        print(f'  Sharpe: {float(stats_oos.get("Sharpe Ratio", 0)):.2f}')
        print(f'  Max DD: {float(stats_oos.get("Max Drawdown [%]", 0)):.1f}%')

        # QuantStats report
        report_file = gen_quantstats_report(pf, name, OUTPUT_DIR)

        all_validation[name] = {
            'config': cfg,
            'mc_shuffle': mc_shuffle,
            'mc_time': mc_time,
            'oos_universe_annual_pct': float(stats_oos.get('Annualized Return [%]', 0)),
            'oos_universe_dd_pct': float(stats_oos.get('Max Drawdown [%]', 0)),
            'report_html': str(report_file) if report_file else None,
        }

    # Save summary
    out = OUTPUT_DIR / 'lab_validate_best.json'
    with open(out, 'w') as f:
        json.dump(all_validation, f, indent=2, default=str)
    print(f'\n\nSaved {out}')

    # Final comparison
    print('\n\n' + '=' * 100)
    print('FINAL COMPARISON (MC trade shuffle stats)')
    print('=' * 100)
    print(f'{"Candidate":<18}{"FinalMed":>12}{"FinalP5":>12}{"P(profit)":>12}{"DDp5":>10}{"OOS univ":>12}')
    print('-' * 100)
    for name, v in all_validation.items():
        if v['mc_shuffle']:
            mc = v['mc_shuffle']
            oos_ann = v.get('oos_universe_annual_pct', 0)
            print(f'{name:<18}{mc["final_median"]:>11.0f}E'
                  f'{mc["final_p5"]:>11.0f}E'
                  f'{mc["p_profit"] * 100:>11.1f}%'
                  f'{mc["dd_p5"]:>9.1f}%'
                  f'{oos_ann:>11.1f}%')
    print('=' * 100)


if __name__ == '__main__':
    main()
