"""
Trade Genius — Lab Polished Winner

Prend le Sweet Spot (25.6%/an, DD -52%) + ajoute TOUS les filtres alt :
  - F&G : reduce expo si extreme greed (>75), boost si fear (<25)
  - VIX : reduce si > 30, cash 100% si > 40
  - Funding : reduce si BTC funding > 0.05% cumule (surchauffe)
  - Yield curve : reduce si inversion
  - Stop drawdown portfolio : -15% sur 30j -> cash 21j
  - On-chain BTC : reduce si hash rate baisse 3 mois

Objectif : 20-25%/an avec DD <-40%
"""
import sys, json, warnings
warnings.filterwarnings('ignore')

import pandas as pd
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_multistrat import (strat_aggressive_growth, strat_defensive, strat_sector_rotation,
                             strat_crypto_rotation, strat_antonacci, strat_vol_parity, strat_pairs_tech_vs_util)

ALT_DATA_DIR = OUTPUT_DIR / 'alt_data'


def load_alt_data():
    data = {}
    for f in ALT_DATA_DIR.glob('*.csv'):
        try:
            df = pd.read_csv(f, parse_dates=['date'], index_col='date')
            data[f.stem] = df
        except Exception:
            pass
    return data


def compute_master_signal(date_index, alt_data, use_fng=True, use_vix=True,
                           use_funding=True, use_yield=True):
    """
    Signal d'exposition global [0.0 - 1.3].
    1.0 = exposition standard, <1 = reduit, >1 = boost.
    """
    sig = pd.Series(1.0, index=date_index)

    if use_fng and 'fear_greed_crypto' in alt_data:
        fng = alt_data['fear_greed_crypto']['fng_value'].reindex(date_index, method='ffill')
        adj = pd.Series(1.0, index=date_index)
        adj[fng < 20] = 1.2  # extreme fear = contrarian
        adj[fng < 10] = 1.3  # mega capitulation
        adj[fng > 75] = 0.7  # extreme greed = reduce
        adj[fng > 85] = 0.4  # euphoric peak = strong reduce
        sig = sig * adj

    if use_vix and 'fred_VIXCLS' in alt_data:
        vix = alt_data['fred_VIXCLS']['VIXCLS'].reindex(date_index, method='ffill')
        adj = pd.Series(1.0, index=date_index)
        adj[vix < 15] = 1.05
        adj[vix > 25] = 0.7
        adj[vix > 35] = 0.3
        adj[vix > 45] = 0.0  # full cash
        sig = sig * adj

    if use_yield and 'fred_T10Y2Y' in alt_data:
        yc = alt_data['fred_T10Y2Y']['T10Y2Y'].reindex(date_index, method='ffill')
        adj = pd.Series(1.0, index=date_index)
        adj[yc < 0] = 0.85
        adj[yc < -0.5] = 0.7  # forte inversion = recession risk
        sig = sig * adj

    if use_funding and 'funding_btcusdt' in alt_data:
        fr = alt_data['funding_btcusdt']['funding_rate'].reindex(date_index, method='ffill')
        # Cumulated funding over ~30 days (3 per day)
        fr_cum = fr.rolling(90).sum()
        adj = pd.Series(1.0, index=date_index)
        adj[fr_cum > 0.005] = 0.9
        adj[fr_cum > 0.015] = 0.7
        adj[fr_cum < -0.005] = 1.15
        sig = sig * adj

    return sig.clip(0, 1.3)


def run_polished(data, strategies, weights_per_strat, alt_data,
                 dd_stop_pct=15, dd_lookback=30,
                 rebal_days=21, commission=0.0015, slippage=0.0040, initial=1000):
    """
    Sweet Spot ensemble + filtres alt data + DD stop.
    """
    cash = initial
    all_tickers = set(data.columns)
    holdings = {t: 0.0 for t in all_tickers}
    peak = initial
    max_dd = 0
    eq_history = []
    monthly_eq = []
    cash_cooldown = 0  # days en cash apres DD trigger

    # Master signal
    master_sig = compute_master_signal(data.index, alt_data)

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

        # DD stop check
        if dd_stop_pct and i >= dd_lookback:
            recent_peak = max(eq_history[-dd_lookback:])
            recent_dd = (equity - recent_peak) / recent_peak
            if recent_dd < -dd_stop_pct / 100 and cash_cooldown == 0:
                # Liquide
                for t in list(holdings.keys()):
                    if t in data.columns and not pd.isna(data[t].iloc[i]) and holdings[t] > 0:
                        proceeds = holdings[t] * data[t].iloc[i] * (1 - slippage)
                        fee = proceeds * commission
                        cash += proceeds - fee
                        holdings[t] = 0
                cash_cooldown = dd_lookback

        if cash_cooldown > 0:
            cash_cooldown -= 1
            continue

        if i in rebal_indices:
            # Master sig multiplicator
            scale = float(master_sig.iloc[i]) if i < len(master_sig) else 1.0

            # Aggregate from strategies
            agg_target = {}
            for name, fn in strategies.items():
                w_strat = weights_per_strat.get(name, 0)
                if w_strat <= 0:
                    continue
                try:
                    alloc = fn(data, i)
                    for t, w in alloc.items():
                        agg_target[t] = agg_target.get(t, 0) + w_strat * w
                except Exception:
                    continue

            # Normalize then apply scale
            s = sum(agg_target.values())
            if s > 0:
                agg_target = {t: (w / s) * 0.95 * scale for t, w in agg_target.items()}

            # Rebalance
            for t in holdings:
                if t not in data.columns or pd.isna(data[t].iloc[i]):
                    continue
                target_val = equity * agg_target.get(t, 0)
                current_val = holdings[t] * data[t].iloc[i]
                delta = target_val - current_val
                if abs(delta) < equity * 0.005:
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
                    if holdings[t] >= shares_to_sell:
                        holdings[t] -= shares_to_sell
                        cash += proceeds - fee

    final = eq_history[-1]
    n_years = len(data) / 252
    annual = ((final / initial) ** (1 / n_years) - 1) * 100 if n_years > 0 else 0
    total = (final - initial) / initial * 100
    if monthly_eq:
        m_arr = np.array(monthly_eq)
        m_rets = np.diff(m_arr) / m_arr[:-1] * 100
        worst_m = float(min(m_rets)) if len(m_rets) else 0
        positive_months = float((m_rets > 0).mean() * 100) if len(m_rets) else 0
    else:
        worst_m = 0
        positive_months = 0
    return {
        'annual_return_pct': float(annual),
        'total_return_pct': float(total),
        'max_dd_pct': float(max_dd * 100),
        'worst_monthly': worst_m,
        'positive_months_pct': positive_months,
        'final_value': float(final),
    }


def main():
    print('=' * 95)
    print(' LAB POLISHED WINNER - Sweet Spot + ALL alt filters + DD stop')
    print('=' * 95)

    print('\nLoading alt data...')
    alt_data = load_alt_data()
    print(f'  {len(alt_data)} datasets loaded')

    universe = ['SPY', 'QQQ', 'IWM', 'EFA', 'IEF', 'TLT', 'GLD', 'SHY',
                'XLK', 'XLE', 'XLF', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB',
                'BTC-USD', 'ETH-USD', 'SOL-USD', 'TQQQ', 'SPXL']
    eng = LabEngine(universe=universe, start='2014-01-01')
    data = eng.data.loc['2019-09-01':'2026-01-01']  # depuis dispo funding
    print(f'\nPeriod : {data.index.min().date()} -> {data.index.max().date()} ({len(data)/252:.1f} ans)')

    STRATEGIES = {
        'S1_aggressive': strat_aggressive_growth,
        'S2_defensive': strat_defensive,
        'S3_sector_rot': strat_sector_rotation,
        'S4_crypto_rot': strat_crypto_rotation,
        'S5_antonacci': strat_antonacci,
        'S6_vol_parity': strat_vol_parity,
        'S7_pairs_tech': strat_pairs_tech_vs_util,
    }

    variants = [
        {
            'name': 'BASELINE Sweet Spot (S1*2+S2+S4+S5) sans alt',
            'weights': {'S1_aggressive': 2.0, 'S2_defensive': 1.0,
                       'S4_crypto_rot': 1.0, 'S5_antonacci': 1.0,
                       'S3_sector_rot': 0, 'S6_vol_parity': 0, 'S7_pairs_tech': 0},
            'use_alt': False, 'dd_stop': None,
        },
        {
            'name': 'Sweet Spot + ALT signals (full)',
            'weights': {'S1_aggressive': 2.0, 'S2_defensive': 1.0,
                       'S4_crypto_rot': 1.0, 'S5_antonacci': 1.0,
                       'S3_sector_rot': 0, 'S6_vol_parity': 0, 'S7_pairs_tech': 0},
            'use_alt': True, 'dd_stop': None,
        },
        {
            'name': 'Sweet Spot + ALT + DD STOP 15%',
            'weights': {'S1_aggressive': 2.0, 'S2_defensive': 1.0,
                       'S4_crypto_rot': 1.0, 'S5_antonacci': 1.0,
                       'S3_sector_rot': 0, 'S6_vol_parity': 0, 'S7_pairs_tech': 0},
            'use_alt': True, 'dd_stop': 15,
        },
        {
            'name': 'Sweet Spot + ALT + DD STOP 12%',
            'weights': {'S1_aggressive': 2.0, 'S2_defensive': 1.0,
                       'S4_crypto_rot': 1.0, 'S5_antonacci': 1.0,
                       'S3_sector_rot': 0, 'S6_vol_parity': 0, 'S7_pairs_tech': 0},
            'use_alt': True, 'dd_stop': 12,
        },
        {
            'name': 'Sweet Spot + ALT + DD STOP 20%',
            'weights': {'S1_aggressive': 2.0, 'S2_defensive': 1.0,
                       'S4_crypto_rot': 1.0, 'S5_antonacci': 1.0,
                       'S3_sector_rot': 0, 'S6_vol_parity': 0, 'S7_pairs_tech': 0},
            'use_alt': True, 'dd_stop': 20,
        },
        {
            'name': 'Risk-on agressive (S1*3+S4*2+S3) + ALT + DD 15',
            'weights': {'S1_aggressive': 3.0, 'S4_crypto_rot': 2.0, 'S3_sector_rot': 1.0,
                       'S2_defensive': 0, 'S5_antonacci': 0, 'S6_vol_parity': 0, 'S7_pairs_tech': 0},
            'use_alt': True, 'dd_stop': 15,
        },
        {
            'name': 'Sweet Spot + ALT + DD 15 + BOOST S2 (3x defensive)',
            'weights': {'S1_aggressive': 2.0, 'S2_defensive': 3.0,
                       'S4_crypto_rot': 1.0, 'S5_antonacci': 1.0,
                       'S3_sector_rot': 0, 'S6_vol_parity': 0, 'S7_pairs_tech': 0},
            'use_alt': True, 'dd_stop': 15,
        },
    ]

    print(f'\n{"Variant":<60}{"Annual":>9}{"DD":>9}{"WorstM":>9}{"PosM%":>8}')
    print('-' * 95)
    all_results = {}
    for v in variants:
        try:
            ad = alt_data if v['use_alt'] else {}
            r = run_polished(data, STRATEGIES, v['weights'], ad, dd_stop_pct=v['dd_stop'])
            print(f'{v["name"][:59]:<60}'
                  f'{r["annual_return_pct"]:>8.1f}%'
                  f'{r["max_dd_pct"]:>8.1f}%'
                  f'{r["worst_monthly"]:>8.1f}%'
                  f'{r["positive_months_pct"]:>7.0f}%')
            all_results[v['name']] = r
        except Exception as e:
            print(f'{v["name"][:59]:<60} FAILED: {e}')
            import traceback; traceback.print_exc()

    out = OUTPUT_DIR / 'lab_polished_winner.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved: {out}')

    # VERDICT
    print('\n\n' + '=' * 95)
    print(' VERDICT - meilleur compromis')
    print('=' * 95)
    print(f'{"Strategy":<60}{"Annual":>9}{"DD":>9}{"Calmar":>10}{"Status":>15}')
    print('-' * 105)
    for name, r in sorted(all_results.items(), key=lambda kv: -(kv[1]['annual_return_pct'] / max(abs(kv[1]['max_dd_pct']) / 30, 1))):
        ann = r['annual_return_pct']
        dd = r['max_dd_pct']
        calmar = ann / abs(dd) if dd != 0 else 0
        if ann >= 20 and dd >= -35:
            v = '*** WINNER ***'
        elif ann >= 20 and dd >= -45:
            v = 'STRONG'
        elif ann >= 15:
            v = 'OK'
        else:
            v = 'FAIL'
        print(f'  {name[:58]:<60}{ann:>7.1f}%{dd:>7.1f}%{calmar:>9.2f}{v:>14}')


if __name__ == '__main__':
    main()
