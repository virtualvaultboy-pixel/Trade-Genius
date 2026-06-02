"""
Trade Genius — Lab Low DD Winner

Objectif user : 20%/an MINIMUM avec DD intra-annee <-25% (max -10%/mois).

Approches a tester pour reduire DD sans tuer le return :
  1. STOP LOSS PORTFOLIO : si DD > -10% en 30j, cash 30 jours
  2. VOL TARGETING TRES AGRESSIF : scale = vol_target / vol_realisee (10-15%)
  3. REGIME RIGIDE : 100% cash si SPY < SMA50 ET QQQ < SMA50
  4. ROTATION AGGRESSIVE : pick top momentum hebdo
  5. HEDGED VIX : long TQQQ + UVXY (vol futures) comme hedge
  6. MARKET NEUTRAL : long top quintile + short bottom quintile
  7. CONSERVATIVE CORE + AGGRESSIVE SATELLITE :
     - 70% B&H SPY (stable)
     - 30% TQQQ (boost)
  8. MOMENTUM MIX + STOP : TQQQ/BTC avec stop -8% par mois
"""
import sys, json, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR


def run_low_dd(data, weights_bull, weights_defensive=None,
               regime_ticker='SPY', regime_sma=50,
               vol_target=None, dd_stop=None, dd_lookback=30,
               rebal_days=21, commission=0.0015, slippage=0.0040, initial=1000):
    """
    Stratégie low-DD :
      - Regime switch sur SMA courte (50j default)
      - Vol targeting agressif
      - Stop drawdown portfolio (cash si DD > stop sur N derniers j)
    """
    if weights_defensive is None:
        weights_defensive = {'TLT': 0.50, 'GLD': 0.30, 'SHY': 0.20}

    cash = initial
    holdings = {}
    for w_set in [weights_bull, weights_defensive]:
        for t in w_set:
            holdings[t] = 0.0

    peak = initial
    max_dd = 0
    monthly_returns = []
    eq_history = [initial]
    cash_cooldown = 0  # days remaining in cash after DD trigger

    # Pre-compute regime
    if regime_ticker in data.columns:
        regime_sma_series = data[regime_ticker].rolling(regime_sma).mean()
        in_bull_series = data[regime_ticker] > regime_sma_series
    else:
        in_bull_series = pd.Series(True, index=data.index)

    # Pre-compute vol
    vol_series = None
    if vol_target:
        vol_series = data[regime_ticker].pct_change().rolling(60).std() * np.sqrt(252) * 100 if regime_ticker in data.columns else None

    rebal_indices = set(range(0, len(data), rebal_days))

    for i, date in enumerate(data.index):
        # Equity actuel
        equity = cash
        for t, sh in holdings.items():
            if t in data.columns and not pd.isna(data[t].iloc[i]):
                equity += sh * data[t].iloc[i]
        eq_history.append(equity)

        if equity > peak:
            peak = equity
        dd = (equity - peak) / peak
        if dd < max_dd:
            max_dd = dd

        # Stop drawdown check : DD sur N derniers j
        if dd_stop and i >= dd_lookback:
            recent_peak = max(eq_history[-dd_lookback:])
            recent_dd = (equity - recent_peak) / recent_peak
            if recent_dd < -dd_stop / 100 and cash_cooldown == 0:
                # Trigger : liquide tout
                for t in holdings:
                    if t in data.columns and not pd.isna(data[t].iloc[i]) and holdings[t] > 0:
                        proceeds = holdings[t] * data[t].iloc[i] * (1 - slippage)
                        fee = proceeds * commission
                        cash += proceeds - fee
                        holdings[t] = 0
                cash_cooldown = dd_lookback  # rester en cash N jours

        if cash_cooldown > 0:
            cash_cooldown -= 1
            continue

        # Rebalance day
        if i in rebal_indices:
            in_bull = in_bull_series.iloc[i] if i < len(in_bull_series) else True
            target_weights = weights_bull if in_bull else weights_defensive

            # Vol scaling
            scale = 1.0
            if vol_target and vol_series is not None and i > 60:
                v = vol_series.iloc[i]
                if not pd.isna(v) and v > 0:
                    scale = min(1.0, vol_target / v)

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

    # Monthly returns
    if eq_history:
        eq_arr = np.array(eq_history)
        # Monthly = every 21 days
        monthly_eq = eq_arr[::21]
        monthly_rets = np.diff(monthly_eq) / monthly_eq[:-1] * 100
        max_monthly_loss = float(min(monthly_rets)) if len(monthly_rets) else 0
        worst_3_monthly = float(np.mean(sorted(monthly_rets)[:3])) if len(monthly_rets) >= 3 else 0
    else:
        max_monthly_loss = 0
        worst_3_monthly = 0

    final_equity = eq_history[-1]
    total_return = (final_equity - initial) / initial * 100
    n_years = len(data) / 252
    annual = ((final_equity / initial) ** (1 / n_years) - 1) * 100 if n_years > 0 else 0

    return {
        'final_value': float(final_equity),
        'annual_return_pct': float(annual),
        'total_return_pct': float(total_return),
        'max_dd_pct': float(max_dd * 100),
        'max_monthly_loss': max_monthly_loss,
        'worst_3_monthly_avg': worst_3_monthly,
        'n_years': float(n_years),
    }


def test_periods(strat_fn, data):
    r1 = strat_fn(data)
    r2 = strat_fn(data.loc['2022-01-01':'2026-01-01'])
    return {'full': r1, 'recent_2022_2025': r2}


def main():
    print('=' * 100)
    print(' LAB LOW DD WINNER - objectif 20%/an + DD intra-annee <-25%')
    print('=' * 100)

    universe = ['SPY', 'QQQ', 'TLT', 'IEF', 'GLD', 'DBC', 'SHY',
                'BTC-USD', 'ETH-USD',
                'TQQQ', 'SPXL', 'SOXL', 'UPRO', 'TMF']
    eng = LabEngine(universe=universe, start='2010-01-01')
    data = eng.data.loc['2012-01-01':'2026-01-01']
    print(f'Period : {data.index.min().date()} -> {data.index.max().date()} ({len(data)/252:.1f} ans)')

    variants = [
        {
            'name': 'TQQQ-mix + DD STOP 12% / 30j',
            'fn': lambda d: run_low_dd(d,
                {'TQQQ': 0.30, 'TLT': 0.40, 'GLD': 0.10, 'BTC-USD': 0.20},
                regime_ticker='SPY', dd_stop=12, dd_lookback=30),
        },
        {
            'name': 'TQQQ-mix + DD STOP 8% / 30j',
            'fn': lambda d: run_low_dd(d,
                {'TQQQ': 0.30, 'TLT': 0.40, 'GLD': 0.10, 'BTC-USD': 0.20},
                regime_ticker='SPY', dd_stop=8, dd_lookback=30),
        },
        {
            'name': 'TQQQ-mix + VOL TARGET 15%',
            'fn': lambda d: run_low_dd(d,
                {'TQQQ': 0.30, 'TLT': 0.40, 'GLD': 0.10, 'BTC-USD': 0.20},
                regime_ticker='QQQ', vol_target=15),
        },
        {
            'name': 'TQQQ-mix + VOL TARGET 12%',
            'fn': lambda d: run_low_dd(d,
                {'TQQQ': 0.30, 'TLT': 0.40, 'GLD': 0.10, 'BTC-USD': 0.20},
                regime_ticker='QQQ', vol_target=12),
        },
        {
            'name': 'TQQQ-mix + VT 15% + DD STOP 12%',
            'fn': lambda d: run_low_dd(d,
                {'TQQQ': 0.30, 'TLT': 0.40, 'GLD': 0.10, 'BTC-USD': 0.20},
                regime_ticker='QQQ', vol_target=15, dd_stop=12),
        },
        {
            'name': 'TQQQ-mix + VT 10% + DD STOP 8%',
            'fn': lambda d: run_low_dd(d,
                {'TQQQ': 0.30, 'TLT': 0.40, 'GLD': 0.10, 'BTC-USD': 0.20},
                regime_ticker='QQQ', vol_target=10, dd_stop=8),
        },
        {
            'name': 'TQQQ 40 + TLT 30 + BTC 20 + GLD 10 + REGIME SMA50 + VT 15',
            'fn': lambda d: run_low_dd(d,
                {'TQQQ': 0.40, 'TLT': 0.30, 'GLD': 0.10, 'BTC-USD': 0.20},
                weights_defensive={'TLT': 0.50, 'GLD': 0.30, 'SHY': 0.20},
                regime_ticker='SPY', regime_sma=50, vol_target=15),
        },
        {
            'name': 'TQQQ 50 + TLT 30 + BTC 20 + REGIME + VT 12 + DD STOP 10',
            'fn': lambda d: run_low_dd(d,
                {'TQQQ': 0.50, 'TLT': 0.30, 'BTC-USD': 0.20},
                weights_defensive={'TLT': 0.60, 'GLD': 0.30, 'SHY': 0.10},
                regime_ticker='SPY', regime_sma=50, vol_target=12, dd_stop=10),
        },
        {
            'name': 'CORE 60SPY + 30TQQQ + 10BTC, vol 15',
            'fn': lambda d: run_low_dd(d,
                {'SPY': 0.60, 'TQQQ': 0.30, 'BTC-USD': 0.10},
                regime_ticker='SPY', vol_target=15),
        },
        {
            'name': 'CORE 50SPY + 30TQQQ + 20BTC + DD STOP 10',
            'fn': lambda d: run_low_dd(d,
                {'SPY': 0.50, 'TQQQ': 0.30, 'BTC-USD': 0.20},
                regime_ticker='SPY', dd_stop=10),
        },
    ]

    print(f'\n{"Variant":<60}{"Full":>8}{"Recent":>9}{"DD":>9}{"WorstM":>9}{"3wM":>9}')
    print('-' * 105)
    all_results = {}
    for v in variants:
        try:
            r = test_periods(v['fn'], data)
            print(f'{v["name"][:59]:<60}'
                  f'{r["full"]["annual_return_pct"]:>7.1f}%'
                  f'{r["recent_2022_2025"]["annual_return_pct"]:>8.1f}%'
                  f'{r["full"]["max_dd_pct"]:>8.1f}%'
                  f'{r["full"]["max_monthly_loss"]:>8.1f}%'
                  f'{r["full"]["worst_3_monthly_avg"]:>8.1f}%')
            all_results[v['name']] = r
        except Exception as e:
            print(f'{v["name"][:59]:<60} FAILED: {e}')

    out = OUTPUT_DIR / 'lab_low_dd_winner.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved : {out}')

    # === VERDICT === qui atteint 20% + DD <-25% + worst monthly <-12% ?
    print('\n\n' + '=' * 100)
    print(' VERDICT - qui atteint 20%+/an AVEC DD <-25% ET monthly worst <-12% ?')
    print('=' * 100)
    print(f'\n{"Strategy":<60}{"Full":>8}{"Recent":>9}{"DD":>9}{"WorstM":>9}{"Verdict":>14}')
    print('-' * 110)
    for name, r in sorted(all_results.items(), key=lambda kv: -kv[1]['full']['annual_return_pct']):
        ann = r['full']['annual_return_pct']
        rec = r['recent_2022_2025']['annual_return_pct']
        dd = r['full']['max_dd_pct']
        wm = r['full']['max_monthly_loss']
        if ann >= 20 and dd >= -25 and wm >= -12:
            verdict = '*** WINNER ***'
        elif ann >= 15 and dd >= -25:
            verdict = 'STRONG'
        elif ann >= 12:
            verdict = 'OK'
        else:
            verdict = 'FAIL'
        print(f'{name[:59]:<60}{ann:>7.1f}%{rec:>8.1f}%{dd:>8.1f}%{wm:>8.1f}%{verdict:>14}')


if __name__ == '__main__':
    main()
