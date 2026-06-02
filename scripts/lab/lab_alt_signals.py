"""
Trade Genius — Lab Alt Signals (transformation alt data -> signaux trading)

Prend les donnees alt collectees + les transforme en signaux exploitables :

  1. FUNDING SIGNAL : long si funding < -0.01% (capitulation), short bias si > 0.05% (surchauffe)
  2. F&G SIGNAL : long si F&G < 25 (extreme fear, contrarian), reduce expo si > 75 (extreme greed)
  3. VIX SIGNAL : reduce expo si VIX > 25 (panique), full expo si VIX < 15 (calme)
  4. YIELD CURVE : reduce expo si T10Y2Y < 0 (inversion = recession signal)
  5. ON-CHAIN BTC : long boost si hash rate ATH (mineurs confiants)

Ensuite teste une strat HYBRIDE :
  - Base : TQQQ-mix 30/40/10/20
  - Multiplicateur d'expo basé sur signaux alt
"""
import sys, os, json, warnings
warnings.filterwarnings('ignore')

import pandas as pd
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR

ALT_DATA_DIR = OUTPUT_DIR / 'alt_data'


def load_alt_data():
    """Charge tous les fichiers alt data dispos."""
    data = {}
    files = list(ALT_DATA_DIR.glob('*.csv'))
    for f in files:
        try:
            df = pd.read_csv(f, parse_dates=['date'], index_col='date')
            data[f.stem] = df
            print(f'  Loaded {f.name} : {len(df)} rows, cols {list(df.columns)}')
        except Exception as e:
            print(f'  FAILED {f.name}: {e}')
    return data


def build_alt_signal(data_test, alt_data):
    """
    Construit un signal global [0..1] indiquant si on doit etre exposé.
      1.0 = full bullish, 0.0 = full defensive.
    Combine plusieurs signaux alt.
    """
    sig = pd.Series(1.0, index=data_test.index)

    # 1. F&G crypto : contrarian
    if 'fear_greed_crypto' in alt_data:
        fng = alt_data['fear_greed_crypto']['fng_value'].reindex(data_test.index, method='ffill')
        # F&G < 25 = extreme fear = contrarian long => boost expo
        # F&G > 75 = extreme greed = reduce expo
        fng_signal = pd.Series(1.0, index=data_test.index)
        fng_signal[fng < 25] = 1.2  # boost en extreme fear
        fng_signal[fng > 75] = 0.7  # reduce en extreme greed
        fng_signal[fng > 85] = 0.5  # gros reduce en euphorie
        sig = sig * fng_signal

    # 2. VIX : reduce si vol US elevee
    if 'fred_VIXCLS' in alt_data:
        vix = alt_data['fred_VIXCLS']['VIXCLS'].reindex(data_test.index, method='ffill')
        vix_signal = pd.Series(1.0, index=data_test.index)
        vix_signal[vix > 25] = 0.7
        vix_signal[vix > 35] = 0.4
        vix_signal[vix < 15] = 1.1
        sig = sig * vix_signal

    # 3. Yield curve : inversion = recession warning
    if 'fred_T10Y2Y' in alt_data:
        yc = alt_data['fred_T10Y2Y']['T10Y2Y'].reindex(data_test.index, method='ffill')
        yc_signal = pd.Series(1.0, index=data_test.index)
        yc_signal[yc < 0] = 0.8  # inversion = reduce
        sig = sig * yc_signal

    # 4. Funding BTC : contrarian
    if 'funding_btcusdt' in alt_data:
        fr = alt_data['funding_btcusdt']['funding_rate'].reindex(data_test.index, method='ffill')
        # Rolling 21d sum (cumulated funding over 3 weeks = surchauffe ou capitulation)
        fr_cum = fr.rolling(21 * 3).sum()  # 3 fundings/jour
        fr_signal = pd.Series(1.0, index=data_test.index)
        fr_signal[fr_cum > 0.01] = 0.8  # surchauffe accumulee
        fr_signal[fr_cum > 0.02] = 0.6
        fr_signal[fr_cum < -0.005] = 1.15  # capitulation
        sig = sig * fr_signal

    return sig.clip(0, 1.5)  # cap a 1.5x


def run_with_alt(data, weights, alt_data, rebal_days=21,
                 commission=0.0015, slippage=0.0040, initial=1000):
    """
    Run rebalance avec multiplicateur alt sur l'exposure.
    """
    cash = initial
    holdings = {t: 0.0 for t in weights}
    peak = initial
    max_dd = 0
    eq_history = []
    monthly_eq = []

    # Build alt signal
    alt_signal = build_alt_signal(data, alt_data)

    rebal_indices = set(range(0, len(data), rebal_days))

    for i, date in enumerate(data.index):
        equity = cash
        for t, sh in holdings.items():
            if t in data.columns and not pd.isna(data[t].iloc[i]):
                equity += sh * data[t].iloc[i]
        eq_history.append(equity)
        if i % 21 == 0:
            monthly_eq.append(equity)

        if equity > peak:
            peak = equity
        dd = (equity - peak) / peak
        if dd < max_dd:
            max_dd = dd

        if i in rebal_indices:
            scale = float(alt_signal.iloc[i]) if i < len(alt_signal) else 1.0
            for t in holdings:
                if t not in data.columns or pd.isna(data[t].iloc[i]):
                    continue
                target_val = equity * weights[t] * scale
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

    final = eq_history[-1]
    total = (final - initial) / initial * 100
    n_years = len(data) / 252
    annual = ((final / initial) ** (1 / n_years) - 1) * 100 if n_years > 0 else 0

    if monthly_eq:
        m_arr = np.array(monthly_eq)
        m_rets = np.diff(m_arr) / m_arr[:-1] * 100
        worst_month = float(min(m_rets)) if len(m_rets) else 0
    else:
        worst_month = 0

    return {
        'annual_return_pct': float(annual),
        'total_return_pct': float(total),
        'max_dd_pct': float(max_dd * 100),
        'worst_monthly': worst_month,
        'final_value': float(final),
    }


def main():
    print('=' * 90)
    print(' LAB ALT SIGNALS - tester strategy avec features alt data')
    print('=' * 90)

    # Load alt data
    print('\nLoading alt data...')
    alt_data = load_alt_data()
    print(f'Loaded {len(alt_data)} datasets')

    # Charger prix
    universe = ['SPY', 'QQQ', 'TLT', 'IEF', 'GLD', 'BTC-USD', 'TQQQ', 'SPXL']
    eng = LabEngine(universe=universe, start='2010-01-01')
    data = eng.data.loc['2019-09-01':'2026-01-01']  # restreint a la dispo funding
    print(f'\nPeriod : {data.index.min().date()} -> {data.index.max().date()} ({len(data)/252:.1f} ans)')

    # Test variantes
    variants = [
        {'name': 'TQQQ-mix BASELINE (sans alt)',
         'weights': {'TQQQ': 0.30, 'TLT': 0.40, 'GLD': 0.10, 'BTC-USD': 0.20}, 'use_alt': False},
        {'name': 'TQQQ-mix + ALT SIGNALS',
         'weights': {'TQQQ': 0.30, 'TLT': 0.40, 'GLD': 0.10, 'BTC-USD': 0.20}, 'use_alt': True},
        {'name': 'TQQQ-50 + ALT',
         'weights': {'TQQQ': 0.50, 'TLT': 0.30, 'BTC-USD': 0.20}, 'use_alt': True},
        {'name': 'TQQQ-40 + GLD + ALT',
         'weights': {'TQQQ': 0.40, 'TLT': 0.30, 'GLD': 0.10, 'BTC-USD': 0.20}, 'use_alt': True},
        {'name': 'SPY-30 TQQQ-40 BTC-20 TLT-10 + ALT',
         'weights': {'SPY': 0.30, 'TQQQ': 0.40, 'BTC-USD': 0.20, 'TLT': 0.10}, 'use_alt': True},
    ]

    print(f'\n{"Variant":<55}{"Annual":>9}{"DD":>9}{"WorstM":>10}')
    print('-' * 85)
    all_results = {}
    for v in variants:
        try:
            ad = alt_data if v['use_alt'] else {}
            r = run_with_alt(data, v['weights'], ad)
            print(f'{v["name"][:54]:<55}{r["annual_return_pct"]:>8.1f}%{r["max_dd_pct"]:>8.1f}%{r["worst_monthly"]:>9.1f}%')
            all_results[v['name']] = r
        except Exception as e:
            print(f'{v["name"][:54]:<55} FAILED: {e}')
            import traceback; traceback.print_exc()

    out = OUTPUT_DIR / 'lab_alt_signals.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved: {out}')


if __name__ == '__main__':
    main()
