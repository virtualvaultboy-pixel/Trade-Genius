"""
Trade Genius — Manual Rebalance (vrai test honnête)

Implementation MANUELLE du rebalance mensuel sans VectorBT signals.
Calcule equity day by day en re-balancing tous les 21 jours.

Pour valider HONNETEMENT Risk Parity Crypto-tilted.
"""
import sys, json, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR


def run_rebalance(data, weights, rebal_days=21, commission_per_trade=0.0015, slippage=0.0040, initial=1000):
    """
    Simulation manuelle. Returns dict : final_value, annual_return, max_dd, daily_eq.
    """
    tickers = list(weights.keys())
    tickers = [t for t in tickers if t in data.columns]
    if not tickers:
        return {'error': 'no tickers in data'}
    w_sum = sum(weights[t] for t in tickers)
    w = {t: weights[t] / w_sum for t in tickers}  # normalize

    cash = initial
    holdings = {t: 0.0 for t in tickers}  # shares
    equity_hist = []
    peak = initial
    max_dd = 0

    rebal_indices = set(range(0, len(data), rebal_days))

    for i, date in enumerate(data.index):
        prices_today = {t: data[t].iloc[i] for t in tickers if not pd.isna(data[t].iloc[i])}
        if not prices_today:
            equity_hist.append({'date': date, 'equity': cash + sum(holdings[t] * 0 for t in tickers)})
            continue

        # Compute current portfolio value
        equity = cash + sum(holdings[t] * prices_today.get(t, 0) for t in tickers)

        # Drawdown
        if equity > peak:
            peak = equity
        dd = (equity - peak) / peak
        if dd < max_dd:
            max_dd = dd

        # Rebalance day
        if i in rebal_indices:
            for t in tickers:
                if t not in prices_today:
                    continue
                target_val = equity * w[t]
                current_val = holdings[t] * prices_today[t]
                delta = target_val - current_val

                if abs(delta) < equity * 0.01:
                    continue  # skip tiny rebalances

                # Apply commission + slippage
                if delta > 0:  # buy
                    cost = delta * (1 + slippage)
                    fee = cost * commission_per_trade
                    if cash >= cost + fee:
                        shares = (cost) / prices_today[t]
                        holdings[t] += shares
                        cash -= cost + fee
                else:  # sell
                    proceeds = -delta * (1 - slippage)
                    fee = proceeds * commission_per_trade
                    shares_to_sell = -delta / prices_today[t]
                    holdings[t] -= shares_to_sell
                    cash += proceeds - fee

        equity_hist.append({'date': date, 'equity': equity})

    # Final
    final_equity = equity_hist[-1]['equity']
    total_return_pct = (final_equity - initial) / initial * 100
    n_years = len(data) / 252
    annual_return = ((final_equity / initial) ** (1 / n_years) - 1) * 100 if n_years > 0 else 0

    return {
        'final_value': float(final_equity),
        'total_return_pct': float(total_return_pct),
        'annual_return_pct': float(annual_return),
        'max_dd_pct': float(max_dd * 100),
        'n_years': float(n_years),
        'n_trades_approx': len(rebal_indices) * len(tickers),
    }


def test_variants(variants_list, data, name_label='STRATEGIES'):
    print(f'\n{"=" * 90}')
    print(f' {name_label}')
    print('=' * 90)
    results = {}
    print(f'\n{"Variant":<35}{"Total":>10}{"Annual":>10}{"MaxDD":>10}{"Years":>8}')
    print('-' * 80)
    for v in variants_list:
        try:
            r = run_rebalance(data, v['weights'],
                              rebal_days=v.get('rebal_days', 21),
                              commission_per_trade=v.get('commission', 0.0015),
                              slippage=v.get('slippage', 0.0040))
            if 'error' not in r:
                print(f'{v["name"]:<35}{r["total_return_pct"]:>9.0f}%{r["annual_return_pct"]:>9.1f}%{r["max_dd_pct"]:>9.1f}%{r["n_years"]:>7.1f}')
                results[v['name']] = r
        except Exception as e:
            print(f'{v["name"]:<35} FAILED: {e}')
    return results


def main():
    print('=' * 90)
    print(' LAB MANUAL REBALANCE - vrai test honnête')
    print('=' * 90)

    # Univers complet : actions + bonds + gold + crypto + leveraged
    universe = ['SPY', 'QQQ', 'TLT', 'IEF', 'GLD', 'DBC',
                'BTC-USD', 'ETH-USD',
                'TQQQ', 'SPXL', 'SOXL', 'UPRO',  # leveraged
                'SHY']  # cash-like
    eng = LabEngine(universe=universe, start='2011-01-01')
    print(f'Data : {eng.data.shape}')

    # Test sur la full period
    data = eng.data.loc['2012-01-01':'2026-01-01']
    print(f'Period: {data.index.min().date()} -> {data.index.max().date()} ({len(data) / 252:.1f} ans)')

    # === BENCHMARKS ===
    print('\n\n=== BENCHMARKS B&H SIMPLE ===')
    benchmarks = [
        {'name': 'B&H SPY 100%', 'weights': {'SPY': 1.0}, 'rebal_days': 9999},
        {'name': 'B&H QQQ 100%', 'weights': {'QQQ': 1.0}, 'rebal_days': 9999},
        {'name': 'B&H 60/40 fix (no rebal)', 'weights': {'SPY': 0.60, 'TLT': 0.40}, 'rebal_days': 9999},
        {'name': 'B&H 4-asset Crypto-tilted (no rebal)', 'weights': {'SPY': 0.40, 'TLT': 0.30, 'GLD': 0.10, 'BTC-USD': 0.20}, 'rebal_days': 9999},
    ]
    bench_results = test_variants(benchmarks, data, 'BENCHMARKS')

    # === RISK PARITY VARIATIONS ===
    print('\n\n=== RISK PARITY AVEC VRAI REBALANCE ===')
    rp_variants = [
        {'name': 'RP Crypto-tilted 20% MONTHLY', 'weights': {'SPY': 0.40, 'TLT': 0.30, 'GLD': 0.10, 'BTC-USD': 0.20}, 'rebal_days': 21},
        {'name': 'RP Crypto-tilted 20% QUARTERLY', 'weights': {'SPY': 0.40, 'TLT': 0.30, 'GLD': 0.10, 'BTC-USD': 0.20}, 'rebal_days': 63},
        {'name': 'RP Crypto-tilted 30%', 'weights': {'SPY': 0.30, 'TLT': 0.30, 'GLD': 0.10, 'BTC-USD': 0.30}, 'rebal_days': 21},
        {'name': 'RP Crypto-tilted 40%', 'weights': {'SPY': 0.30, 'TLT': 0.20, 'GLD': 0.10, 'BTC-USD': 0.40}, 'rebal_days': 21},
        {'name': 'RP 60/40 monthly', 'weights': {'SPY': 0.60, 'TLT': 0.40}, 'rebal_days': 21},
        {'name': 'RP AllWeather classic', 'weights': {'SPY': 0.30, 'TLT': 0.40, 'GLD': 0.15, 'DBC': 0.15}, 'rebal_days': 21},
    ]
    rp_results = test_variants(rp_variants, data, 'RISK PARITY')

    # === LEVERAGED ===
    print('\n\n=== LEVERAGED ETF (data dispo depuis 2010-2012) ===')
    # Note: TQQQ, SPXL existent depuis 2010; SOXL depuis 2010
    lev_variants = [
        {'name': 'B&H TQQQ 100%', 'weights': {'TQQQ': 1.0}, 'rebal_days': 9999},
        {'name': 'B&H SPXL 100%', 'weights': {'SPXL': 1.0}, 'rebal_days': 9999},
        {'name': 'Hedged TQQQ/TLT 50/50', 'weights': {'TQQQ': 0.50, 'TLT': 0.50}, 'rebal_days': 21},
        {'name': 'Hedged TQQQ/TLT 60/40', 'weights': {'TQQQ': 0.60, 'TLT': 0.40}, 'rebal_days': 21},
        {'name': 'Hedged TQQQ/TLT 40/60', 'weights': {'TQQQ': 0.40, 'TLT': 0.60}, 'rebal_days': 21},
        {'name': 'TQQQ 30 + TLT 40 + GLD 10 + BTC 20', 'weights': {'TQQQ': 0.30, 'TLT': 0.40, 'GLD': 0.10, 'BTC-USD': 0.20}, 'rebal_days': 21},
        {'name': 'TQQQ 40 + TLT 30 + GLD 10 + BTC 20', 'weights': {'TQQQ': 0.40, 'TLT': 0.30, 'GLD': 0.10, 'BTC-USD': 0.20}, 'rebal_days': 21},
        {'name': 'SPXL 40 + TLT 30 + GLD 10 + BTC 20', 'weights': {'SPXL': 0.40, 'TLT': 0.30, 'GLD': 0.10, 'BTC-USD': 0.20}, 'rebal_days': 21},
        {'name': 'TQQQ 50 + TLT 30 + BTC 20', 'weights': {'TQQQ': 0.50, 'TLT': 0.30, 'BTC-USD': 0.20}, 'rebal_days': 21},
        {'name': 'TQQQ 60 + TLT 40', 'weights': {'TQQQ': 0.60, 'TLT': 0.40}, 'rebal_days': 21},
        {'name': 'TQQQ 30 + SPXL 30 + TLT 30 + BTC 10', 'weights': {'TQQQ': 0.30, 'SPXL': 0.30, 'TLT': 0.30, 'BTC-USD': 0.10}, 'rebal_days': 21},
    ]
    lev_results = test_variants(lev_variants, data, 'LEVERAGED ETF MIX')

    # === SAVE + VERDICT ===
    all_results = {**bench_results, **rp_results, **lev_results}
    out = OUTPUT_DIR / 'lab_manual_rebalance.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved: {out}')

    # Verdict : qui atteint >= 20%/an annualise ?
    print('\n\n' + '=' * 90)
    print(' VERDICT - QUI ATTEINT >= 20%/AN ANNUALISE EN VRAI VIE CONTINUE ?')
    print('=' * 90)
    print(f'\n{"Strategy":<45}{"Annual":>10}{"MaxDD":>10}{"Status":>15}')
    print('-' * 80)
    sorted_results = sorted(all_results.items(), key=lambda kv: -kv[1].get('annual_return_pct', 0))
    for name, r in sorted_results:
        ann = r.get('annual_return_pct', 0)
        dd = r.get('max_dd_pct', 0)
        status = 'WINNER' if ann >= 20 and dd >= -40 else ('OK' if ann >= 15 else 'FAIL')
        print(f'{name:<45}{ann:>9.1f}%{dd:>9.1f}%{status:>14}')


if __name__ == '__main__':
    main()
