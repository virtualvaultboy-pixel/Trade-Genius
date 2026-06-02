"""
Trade Genius — Lab Deep Time OOS v1.0

Test sur 2010-2017 : periode JAMAIS touchee par notre optim.
C'est le test le plus dur : si l'IA tient ici, c'est qu'elle generalise vraiment.

Note : crypto n'existait pas vraiment avant 2017, donc :
  - INDICES : test 2010-2017 (8 ans purs)
  - CRYPTO : test 2017-2019 + 2018 isole (3 ans periode immature/bear)
"""
import sys, os, json, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
import vectorbt as vbt
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_strategies import momentum_safe, momentum_topN


def run_oos(config, universe, start, end, name, regime_asset):
    eng = LabEngine(universe=universe, start=start)
    # Train on first 2 years, test the rest
    train_end = pd.Timestamp(start) + pd.Timedelta(days=365 * 2)
    test_start = train_end + pd.Timedelta(days=1)

    data_train = eng.data.loc[start:train_end]
    data_test = eng.data.loc[test_start:end]

    if len(data_test) < 30:
        print(f'  No data: train {len(data_train)} test {len(data_test)}')
        return None

    print(f'  Train period: {data_train.index.min().date()} -> {data_train.index.max().date()} ({len(data_train)} days)')
    print(f'  Test period:  {data_test.index.min().date()} -> {data_test.index.max().date()} ({len(data_test)} days)')

    def strat(dt, ds):
        if 'mom_lookback' in config:
            allowed = {'mom_lookback', 'top_n', 'rebal_days', 'sma_len', 'stop_pct', 'min_mom_pct'}
            renamed = {}
            for k, v in config.items():
                if k == 'sma_filter_len':
                    renamed['sma_len'] = v
                elif k in allowed:
                    renamed[k] = v
            return momentum_safe(dt, ds, **renamed)
        return momentum_topN(dt, ds)

    try:
        entries, exits, size = strat(data_train, data_test)
        kwargs = dict(
            close=data_test, entries=entries, exits=exits,
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

        # Benchmark
        if regime_asset in data_test.columns:
            bh = (data_test[regime_asset].iloc[-1] / data_test[regime_asset].iloc[0] - 1) * 100
        else:
            bh = 0

        result = {
            'total_return_pct': float(stats.get('Total Return [%]', 0)),
            'annual_return_pct': float(stats.get('Annualized Return [%]', 0)),
            'sharpe': float(stats.get('Sharpe Ratio', 0)),
            'max_dd_pct': float(stats.get('Max Drawdown [%]', 0)),
            'n_trades': int(stats.get('Total Trades', 0)),
            'bh_total_pct': bh,
            'excess_total_pct': float(stats.get('Total Return [%]', 0)) - bh,
        }
        print(f'  IA   : Total {result["total_return_pct"]:>7.0f}% | Annual {result["annual_return_pct"]:>5.1f}% | DD {result["max_dd_pct"]:>5.1f}% | Sharpe {result["sharpe"]:>4.2f} | {result["n_trades"]} trades')
        print(f'  B&H  : Total {bh:>7.0f}% ({regime_asset})')
        print(f'  Excess vs B&H : {result["excess_total_pct"]:+.0f}%')

        # Verdict
        if result['annual_return_pct'] > 15 and result['max_dd_pct'] > -30:
            print(f'  >>> [OK] L\'IA generalise hors training period')
        elif result['annual_return_pct'] > 0:
            print(f'  >>> [WEAK] Positif mais en-dessous des perfs in-sample')
        else:
            print(f'  >>> [FAIL] Perte sur OOS pur - probable overfit')

        return result
    except Exception as e:
        print(f'  FAILED: {e}')
        import traceback; traceback.print_exc()
        return None


def main():
    print('=== LAB DEEP OOS - Periode jamais touchee ===\n')

    # === INDICES sur 2010-2017 ===
    print('=' * 80)
    print('IA INDICES - test sur 2012-2018 (jamais utilise pour optim)')
    print('=' * 80)
    indices_cfg = {
        'mom_lookback': 30, 'top_n': 5, 'rebal_days': 7,
        'sma_filter_len': 60, 'stop_pct': 15, 'min_mom_pct': 0,
    }
    indices_univ = [
        'SPY','QQQ','IWM','DIA','EFA','VWO','IEF','TLT','GLD','SLV','DBC','USO',
        'XLK','XLE','XLF','XLV',
        'AAPL','MSFT','GOOGL','AMZN','JPM','V','WMT','UNH','JNJ','PG','KO','XOM',
    ]
    r_indices = run_oos(indices_cfg, indices_univ, '2010-01-01', '2018-12-31',
                        'INDICES_2010_2017', 'SPY')

    # === CRYPTO sur 2017-2019 ===
    print('\n' + '=' * 80)
    print('IA CRYPTO - test sur 2018-2019 (jamais utilise pour optim - vraie immaturite)')
    print('=' * 80)
    crypto_cfg = {
        'mom_lookback': 60, 'top_n': 5, 'rebal_days': 14,
        'sma_filter_len': 150, 'stop_pct': 10, 'min_mom_pct': 5,
    }
    crypto_univ = [
        'BTC-USD','ETH-USD','LTC-USD','XRP-USD','BCH-USD','XLM-USD','ADA-USD','XMR-USD',
    ]
    r_crypto = run_oos(crypto_cfg, crypto_univ, '2016-01-01', '2019-12-31',
                       'CRYPTO_2018_2019', 'BTC-USD')

    out = OUTPUT_DIR / 'lab_deep_oos.json'
    with open(out, 'w') as f:
        json.dump({'indices': r_indices, 'crypto': r_crypto}, f, indent=2, default=str)
    print(f'\nSaved: {out}')


if __name__ == '__main__':
    main()
