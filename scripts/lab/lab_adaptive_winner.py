"""
Trade Genius — Lab Adaptive Winner

Cherche LA combinaison qui livre 20%/an AVEC DD reduit (-25 a -35%).

Strategies a tester :
  1. TQQQ-mix + trend filter (sortie TQQQ si QQQ < SMA200)
  2. TQQQ-mix + vol targeting (reduit poids si vol > seuil)
  3. Regime switching aggressive/defensive
  4. Risk parity inverse-vol
  5. Triple-leveraged crossover : TQQQ + UPRO + TMF (bonds leveraged)
  6. SPXL/TLT mix avec hedge dynamique
  7. Conservative leveraged : 20% TQQQ + 50% TLT + 15% GLD + 15% BTC
  8. SPY 50/TQQQ 20/TLT 20/BTC 10 (less leverage)
"""
import sys, json, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR


def run_adaptive(data, weights_bull, weights_bear=None, regime_ticker='QQQ', sma_len=200,
                 vol_target=None, rebal_days=21, commission=0.0015, slippage=0.0040, initial=1000):
    """
    Run rebalance avec :
      - regime switch (bull/bear) selon ticker vs SMA
      - vol targeting optionnel (reduit exposure si vol > target)
    """
    if weights_bear is None:
        # Bear par defaut = cash + bonds
        weights_bear = {'TLT': 0.50, 'GLD': 0.30, 'SHY': 0.20}

    cash = initial
    holdings = {}
    for w_set in [weights_bull, weights_bear]:
        for t in w_set:
            holdings[t] = 0.0

    peak = initial
    max_dd = 0
    equity_hist = []

    # Pre-compute SMA regime
    if regime_ticker in data.columns:
        regime_sma = data[regime_ticker].rolling(sma_len).mean()
        in_bull_series = data[regime_ticker] > regime_sma
    else:
        in_bull_series = pd.Series(True, index=data.index)

    # Pre-compute vol if vol_target
    vol_series = None
    if vol_target:
        vol_series = data[regime_ticker].pct_change().rolling(60).std() * np.sqrt(252) * 100 if regime_ticker in data.columns else None

    rebal_indices = set(range(0, len(data), rebal_days))

    for i, date in enumerate(data.index):
        # Equity current
        equity = cash
        for t, sh in holdings.items():
            if t in data.columns and not pd.isna(data[t].iloc[i]):
                equity += sh * data[t].iloc[i]

        if equity > peak:
            peak = equity
        dd = (equity - peak) / peak
        if dd < max_dd:
            max_dd = dd

        # Rebalance day
        if i in rebal_indices:
            in_bull = in_bull_series.iloc[i] if i < len(in_bull_series) else True
            target_weights = weights_bull if in_bull else weights_bear

            # Vol scaling
            scale = 1.0
            if vol_target and vol_series is not None and i > 60:
                v = vol_series.iloc[i]
                if not pd.isna(v) and v > 0:
                    scale = min(1.0, vol_target / v)

            # Apply weights with scale (rest in cash)
            for t in holdings:
                if t not in data.columns or pd.isna(data[t].iloc[i]):
                    continue
                target_val = equity * target_weights.get(t, 0) * scale
                current_val = holdings[t] * data[t].iloc[i]
                delta = target_val - current_val
                if abs(delta) < equity * 0.01:
                    continue
                price = data[t].iloc[i]
                if delta > 0:
                    cost = delta * (1 + slippage)
                    fee = cost * commission
                    if cash >= cost + fee:
                        shares = cost / price
                        holdings[t] += shares
                        cash -= cost + fee
                else:
                    proceeds = -delta * (1 - slippage)
                    fee = proceeds * commission
                    shares_to_sell = -delta / price
                    holdings[t] -= shares_to_sell
                    cash += proceeds - fee

        equity_hist.append({'date': date, 'equity': equity})

    final_equity = equity_hist[-1]['equity']
    total_return = (final_equity - initial) / initial * 100
    n_years = len(data) / 252
    annual = ((final_equity / initial) ** (1 / n_years) - 1) * 100 if n_years > 0 else 0

    return {
        'final_value': float(final_equity),
        'annual_return_pct': float(annual),
        'total_return_pct': float(total_return),
        'max_dd_pct': float(max_dd * 100),
        'n_years': float(n_years),
    }


def test_period(strat_fn, data, label):
    """Test strat sur 3 periodes : full, recent, no-2020-21."""
    r1 = strat_fn(data)
    data_recent = data.loc['2022-01-01':'2026-01-01']
    r2 = strat_fn(data_recent)
    data_no = pd.concat([data.loc['2012-01-01':'2019-12-31'], data.loc['2022-01-01':'2026-01-01']])
    r3 = strat_fn(data_no)
    return {'full': r1, 'recent_2022_2025': r2, 'no_2020_2021': r3}


def main():
    print('=' * 90)
    print(' LAB ADAPTIVE WINNER - cherche 20%/an avec DD <-35%')
    print('=' * 90)

    universe = ['SPY', 'QQQ', 'TLT', 'IEF', 'GLD', 'DBC', 'SHY',
                'BTC-USD', 'ETH-USD',
                'TQQQ', 'SPXL', 'SOXL', 'UPRO', 'TMF', 'TBT']
    eng = LabEngine(universe=universe, start='2010-01-01')
    data = eng.data.loc['2012-01-01':'2026-01-01']

    print(f'Period : {data.index.min().date()} -> {data.index.max().date()} ({len(data)/252:.1f} ans)')

    variants = [
        {
            'name': 'TQQQ-mix BASELINE (sans filtre)',
            'fn': lambda d: run_adaptive(d, {'TQQQ': 0.30, 'TLT': 0.40, 'GLD': 0.10, 'BTC-USD': 0.20}),
        },
        {
            'name': 'TQQQ-mix + TREND FILTER QQQ>SMA200',
            'fn': lambda d: run_adaptive(d,
                {'TQQQ': 0.30, 'TLT': 0.40, 'GLD': 0.10, 'BTC-USD': 0.20},
                weights_bear={'TLT': 0.50, 'GLD': 0.30, 'SHY': 0.20},
                regime_ticker='QQQ', sma_len=200),
        },
        {
            'name': 'TQQQ-mix + TREND SMA150',
            'fn': lambda d: run_adaptive(d,
                {'TQQQ': 0.30, 'TLT': 0.40, 'GLD': 0.10, 'BTC-USD': 0.20},
                weights_bear={'TLT': 0.50, 'GLD': 0.30, 'SHY': 0.20},
                regime_ticker='QQQ', sma_len=150),
        },
        {
            'name': 'TQQQ-mix + VOL TARGET 25%',
            'fn': lambda d: run_adaptive(d,
                {'TQQQ': 0.30, 'TLT': 0.40, 'GLD': 0.10, 'BTC-USD': 0.20},
                vol_target=25),
        },
        {
            'name': 'TQQQ-mix + VOL TARGET 20%',
            'fn': lambda d: run_adaptive(d,
                {'TQQQ': 0.30, 'TLT': 0.40, 'GLD': 0.10, 'BTC-USD': 0.20},
                vol_target=20),
        },
        {
            'name': 'TQQQ-mix + TREND + VOL TARGET 25%',
            'fn': lambda d: run_adaptive(d,
                {'TQQQ': 0.30, 'TLT': 0.40, 'GLD': 0.10, 'BTC-USD': 0.20},
                weights_bear={'TLT': 0.50, 'GLD': 0.30, 'SHY': 0.20},
                regime_ticker='QQQ', sma_len=200, vol_target=25),
        },
        {
            'name': 'TQQQ 20 + TLT 50 + GLD 15 + BTC 15 (conserv)',
            'fn': lambda d: run_adaptive(d, {'TQQQ': 0.20, 'TLT': 0.50, 'GLD': 0.15, 'BTC-USD': 0.15}),
        },
        {
            'name': 'TQQQ 25 + TLT 50 + GLD 10 + BTC 15',
            'fn': lambda d: run_adaptive(d, {'TQQQ': 0.25, 'TLT': 0.50, 'GLD': 0.10, 'BTC-USD': 0.15}),
        },
        {
            'name': 'SPY 30 + TQQQ 20 + TLT 30 + BTC 20',
            'fn': lambda d: run_adaptive(d, {'SPY': 0.30, 'TQQQ': 0.20, 'TLT': 0.30, 'BTC-USD': 0.20}),
        },
        {
            'name': 'Triple Leveraged TQQQ+UPRO+TMF',
            'fn': lambda d: run_adaptive(d, {'TQQQ': 0.20, 'UPRO': 0.20, 'TMF': 0.40, 'GLD': 0.10, 'BTC-USD': 0.10}),
        },
        {
            'name': 'Triple Lev + TREND',
            'fn': lambda d: run_adaptive(d,
                {'TQQQ': 0.20, 'UPRO': 0.20, 'TMF': 0.40, 'GLD': 0.10, 'BTC-USD': 0.10},
                weights_bear={'TLT': 0.60, 'GLD': 0.30, 'SHY': 0.10},
                regime_ticker='QQQ', sma_len=200),
        },
        {
            'name': 'SOXL 30 + TLT 40 + GLD 10 + BTC 20',
            'fn': lambda d: run_adaptive(d, {'SOXL': 0.30, 'TLT': 0.40, 'GLD': 0.10, 'BTC-USD': 0.20}),
        },
        {
            'name': 'TQQQ 40 + TLT 30 + GLD 10 + BTC 20 + TREND',
            'fn': lambda d: run_adaptive(d,
                {'TQQQ': 0.40, 'TLT': 0.30, 'GLD': 0.10, 'BTC-USD': 0.20},
                weights_bear={'TLT': 0.60, 'GLD': 0.30, 'SHY': 0.10},
                regime_ticker='QQQ', sma_len=200),
        },
        {
            'name': 'TQQQ 50 + TLT 30 + BTC 20 + TREND',
            'fn': lambda d: run_adaptive(d,
                {'TQQQ': 0.50, 'TLT': 0.30, 'BTC-USD': 0.20},
                weights_bear={'TLT': 0.60, 'GLD': 0.30, 'SHY': 0.10},
                regime_ticker='QQQ', sma_len=200),
        },
    ]

    print(f'\n{"Variant":<55}{"Full":>8}{"Recent":>9}{"No20/21":>9}{"DDfull":>9}')
    print('-' * 92)
    all_results = {}
    for v in variants:
        try:
            r = test_period(v['fn'], data, v['name'])
            print(f'{v["name"][:54]:<55}'
                  f'{r["full"]["annual_return_pct"]:>7.1f}%'
                  f'{r["recent_2022_2025"]["annual_return_pct"]:>8.1f}%'
                  f'{r["no_2020_2021"]["annual_return_pct"]:>8.1f}%'
                  f'{r["full"]["max_dd_pct"]:>8.1f}%')
            all_results[v['name']] = r
        except Exception as e:
            print(f'{v["name"][:54]:<55} FAILED: {e}')

    out = OUTPUT_DIR / 'lab_adaptive_winner.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved : {out}')

    # === VERDICT === qui atteint 20%+ avec DD acceptable ?
    print('\n\n' + '=' * 92)
    print(' VERDICT - qui atteint 20%+ AVEC DD < -40% ET recent >= 10% ?')
    print('=' * 92)
    print(f'\n{"Strategy":<55}{"Full":>8}{"Recent":>9}{"DD":>8}{"Verdict":>15}')
    print('-' * 92)
    for name, r in sorted(all_results.items(), key=lambda kv: -kv[1]['full']['annual_return_pct']):
        ann = r['full']['annual_return_pct']
        rec = r['recent_2022_2025']['annual_return_pct']
        dd = r['full']['max_dd_pct']
        if ann >= 20 and dd >= -40 and rec >= 10:
            verdict = '*** WINNER ***'
        elif ann >= 20 and dd >= -50:
            verdict = 'STRONG'
        elif ann >= 15:
            verdict = 'OK'
        else:
            verdict = 'FAIL'
        print(f'{name[:54]:<55}{ann:>7.1f}%{rec:>8.1f}%{dd:>7.1f}%{verdict:>14}')


if __name__ == '__main__':
    main()
