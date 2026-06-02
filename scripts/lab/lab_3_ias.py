"""
Trade Genius — Lab 3 IA séparées (INDICES / CRYPTO / MIXTE PREMIUM+)

Architecture finale :

  IA INDICES (pure equities/bonds)
    Composants : TQQQ 40 + SPY 20 + TLT 20 + GLD 10 + sectoriels rotation 10
    Alt filters : VIX, yield curve, F&G US
    DD stop : -12% / 30j
    Objectif : 15-17%/an, DD -30 à -35%

  IA CRYPTO (pure crypto + bonds defensifs)
    Composants : BTC 40 + ETH 20 + alts rotation 20 + TLT 20 (defensive)
    Alt filters : F&G crypto, funding rate BTC/ETH, BTC dominance
    DD stop : -18% / 30j
    Objectif : 25-35%/an, DD -50%

  IA MIXTE PREMIUM+ (winner actuel)
    Composants : multi-strat agressive S1+S3+S4
    Alt filters : tous (VIX + F&G + yield + funding)
    DD stop : -15% / 30j
    Objectif : 21.4%/an, DD -42% (validé)
"""
import sys, json, warnings
warnings.filterwarnings('ignore')

import pandas as pd
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_polished_winner import load_alt_data, compute_master_signal


def run_ia(data, weights, alt_data, dd_stop_pct=15, dd_lookback=30,
           rebal_days=21, commission=0.0015, slippage=0.0040, initial=1000,
           use_fng=True, use_vix=True, use_funding=True, use_yield=True):
    """
    Run une IA avec ses propres filtres alt.
    """
    cash = initial
    holdings = {t: 0.0 for t in weights}
    peak = initial
    max_dd = 0
    eq_history = []
    monthly_eq = []
    cash_cooldown = 0

    master_sig = compute_master_signal(data.index, alt_data,
                                       use_fng=use_fng, use_vix=use_vix,
                                       use_funding=use_funding, use_yield=use_yield)

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

        # DD stop
        if dd_stop_pct and i >= dd_lookback:
            recent_peak = max(eq_history[-dd_lookback:])
            recent_dd = (equity - recent_peak) / recent_peak
            if recent_dd < -dd_stop_pct / 100 and cash_cooldown == 0:
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
            scale = float(master_sig.iloc[i]) if i < len(master_sig) else 1.0
            for t in holdings:
                if t not in data.columns or pd.isna(data[t].iloc[i]):
                    continue
                target_val = equity * weights.get(t, 0) * scale
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
    if monthly_eq:
        m_arr = np.array(monthly_eq)
        m_rets = np.diff(m_arr) / m_arr[:-1] * 100
        worst_m = float(min(m_rets)) if len(m_rets) else 0
        pos_m = float((m_rets > 0).mean() * 100) if len(m_rets) else 0
    else:
        worst_m = 0; pos_m = 0
    return {
        'annual_return_pct': float(annual),
        'total_return_pct': float((final - initial) / initial * 100),
        'max_dd_pct': float(max_dd * 100),
        'worst_monthly': worst_m,
        'positive_months_pct': pos_m,
        'final_value': float(final),
        'n_years': float(n_years),
    }


def run_crypto_rotation_strat(data, alt_data, dd_stop_pct=18, rebal_days=21,
                              commission=0.0015, slippage=0.0040, initial=1000):
    """
    IA CRYPTO dedie : BTC 40 + ETH 20 + alt-rotation top2 20 + TLT 20.
    Rotation altcoin renouvelle mensuellement (top momentum 30j sur SOL/AVAX/NEAR/LINK).
    """
    cash = initial
    base_weights = {'BTC-USD': 0.40, 'ETH-USD': 0.20, 'TLT': 0.20}
    alt_universe = ['SOL-USD', 'AVAX-USD', 'NEAR-USD', 'LINK-USD', 'ATOM-USD', 'DOT-USD']

    all_tickers = set(base_weights.keys()) | set(alt_universe)
    holdings = {t: 0.0 for t in all_tickers if t in data.columns}
    peak = initial; max_dd = 0
    eq_history = []; monthly_eq = []
    cash_cooldown = 0
    current_alts = []

    master_sig = compute_master_signal(data.index, alt_data,
                                       use_fng=True, use_vix=False,
                                       use_funding=True, use_yield=False)

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

        if dd_stop_pct and i >= 30:
            recent_peak = max(eq_history[-30:])
            recent_dd = (equity - recent_peak) / recent_peak
            if recent_dd < -dd_stop_pct / 100 and cash_cooldown == 0:
                for t in list(holdings.keys()):
                    if t in data.columns and not pd.isna(data[t].iloc[i]) and holdings[t] > 0:
                        proceeds = holdings[t] * data[t].iloc[i] * (1 - slippage)
                        fee = proceeds * commission
                        cash += proceeds - fee
                        holdings[t] = 0
                cash_cooldown = 30

        if cash_cooldown > 0:
            cash_cooldown -= 1
            continue

        if i in rebal_indices:
            # Compute alt rotation top 2
            mom_lookback = 30
            mom_alts = {}
            if i >= mom_lookback:
                for a in alt_universe:
                    if a in data.columns and not pd.isna(data[a].iloc[i]) and not pd.isna(data[a].iloc[i - mom_lookback]):
                        mom_alts[a] = data[a].iloc[i] / data[a].iloc[i - mom_lookback] - 1
            top2_alts = sorted(mom_alts.items(), key=lambda kv: -kv[1])[:2] if mom_alts else []

            scale = float(master_sig.iloc[i]) if i < len(master_sig) else 1.0
            target_weights = dict(base_weights)
            for a, _ in top2_alts:
                target_weights[a] = 0.10

            for t in holdings:
                if t not in data.columns or pd.isna(data[t].iloc[i]):
                    continue
                target_val = equity * target_weights.get(t, 0) * scale
                current_val = holdings[t] * data[t].iloc[i]
                delta = target_val - current_val
                if abs(delta) < equity * 0.005:
                    continue
                price = data[t].iloc[i]
                if delta > 0:
                    cost = delta * (1 + slippage); fee = cost * commission
                    if cash >= cost + fee:
                        shares = cost / price
                        holdings[t] += shares; cash -= cost + fee
                else:
                    proceeds = -delta * (1 - slippage); fee = proceeds * commission
                    shares_to_sell = -delta / price
                    if holdings[t] >= shares_to_sell:
                        holdings[t] -= shares_to_sell; cash += proceeds - fee

    final = eq_history[-1]
    n_years = len(data) / 252
    annual = ((final / initial) ** (1 / n_years) - 1) * 100 if n_years > 0 else 0
    if monthly_eq:
        m_arr = np.array(monthly_eq)
        m_rets = np.diff(m_arr) / m_arr[:-1] * 100
        worst_m = float(min(m_rets)) if len(m_rets) else 0
        pos_m = float((m_rets > 0).mean() * 100) if len(m_rets) else 0
    else:
        worst_m = 0; pos_m = 0
    return {
        'annual_return_pct': float(annual),
        'total_return_pct': float((final - initial) / initial * 100),
        'max_dd_pct': float(max_dd * 100),
        'worst_monthly': worst_m,
        'positive_months_pct': pos_m,
        'final_value': float(final),
        'n_years': float(n_years),
    }


def main():
    print('=' * 95)
    print(' LAB 3 IAs FINAL - Indices / Crypto / Mixte Premium+')
    print('=' * 95)

    print('\nLoading alt data...')
    alt_data = load_alt_data()
    print(f'  {len(alt_data)} datasets loaded')

    universe = ['SPY', 'QQQ', 'IWM', 'EFA', 'IEF', 'TLT', 'GLD', 'SHY',
                'XLK', 'XLE', 'XLF', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB',
                'BTC-USD', 'ETH-USD', 'SOL-USD', 'AVAX-USD', 'NEAR-USD',
                'LINK-USD', 'ATOM-USD', 'DOT-USD',
                'TQQQ', 'SPXL', 'SOXL']
    eng = LabEngine(universe=universe, start='2014-01-01')
    data = eng.data.loc['2019-09-01':'2026-01-01']
    print(f'\nPeriod : {data.index.min().date()} -> {data.index.max().date()} ({len(data)/252:.1f} ans)')

    results = {}

    # ============ IA INDICES ============
    print('\n' + '=' * 95)
    print(' IA INDICES (sans crypto)')
    print('=' * 95)
    indices_variants = [
        {
            'name': 'INDICES baseline (TQQQ 40 + SPY 20 + TLT 30 + GLD 10)',
            'weights': {'TQQQ': 0.40, 'SPY': 0.20, 'TLT': 0.30, 'GLD': 0.10},
            'dd_stop': None, 'use_funding': False, 'use_fng': False,
        },
        {
            'name': 'INDICES + ALT (VIX + yield) + DD 12%',
            'weights': {'TQQQ': 0.40, 'SPY': 0.20, 'TLT': 0.30, 'GLD': 0.10},
            'dd_stop': 12, 'use_funding': False, 'use_fng': False,
        },
        {
            'name': 'INDICES + ALT + DD 15%',
            'weights': {'TQQQ': 0.40, 'SPY': 0.20, 'TLT': 0.30, 'GLD': 0.10},
            'dd_stop': 15, 'use_funding': False, 'use_fng': False,
        },
        {
            'name': 'INDICES aggressive TQQQ 60 + TLT 30 + GLD 10 + ALT + DD 15',
            'weights': {'TQQQ': 0.60, 'TLT': 0.30, 'GLD': 0.10},
            'dd_stop': 15, 'use_funding': False, 'use_fng': False,
        },
        {
            'name': 'INDICES conserv TQQQ 30 + SPY 30 + TLT 30 + GLD 10 + ALT + DD 10',
            'weights': {'TQQQ': 0.30, 'SPY': 0.30, 'TLT': 0.30, 'GLD': 0.10},
            'dd_stop': 10, 'use_funding': False, 'use_fng': False,
        },
        {
            'name': 'INDICES TQQQ 50 + SOXL 10 + TLT 30 + GLD 10 + ALT + DD 15',
            'weights': {'TQQQ': 0.50, 'SOXL': 0.10, 'TLT': 0.30, 'GLD': 0.10},
            'dd_stop': 15, 'use_funding': False, 'use_fng': False,
        },
    ]
    print(f'\n{"Variant":<70}{"Annual":>9}{"DD":>9}{"WorstM":>9}')
    print('-' * 100)
    for v in indices_variants:
        try:
            r = run_ia(data, v['weights'], alt_data, dd_stop_pct=v['dd_stop'],
                      use_funding=v['use_funding'], use_fng=v['use_fng'])
            print(f'{v["name"][:69]:<70}{r["annual_return_pct"]:>8.1f}%{r["max_dd_pct"]:>8.1f}%{r["worst_monthly"]:>8.1f}%')
            results[f'INDICES_{v["name"]}'] = r
        except Exception as e:
            print(f'{v["name"][:69]:<70} FAILED: {e}')

    # ============ IA CRYPTO ============
    print('\n' + '=' * 95)
    print(' IA CRYPTO (pure crypto + bonds defensifs)')
    print('=' * 95)
    crypto_variants = [
        {
            'name': 'CRYPTO baseline BTC 40 + ETH 20 + TLT 20 + alt-rot',
            'fn': lambda d: run_crypto_rotation_strat(d, alt_data, dd_stop_pct=None),
        },
        {
            'name': 'CRYPTO + ALT + DD 18',
            'fn': lambda d: run_crypto_rotation_strat(d, alt_data, dd_stop_pct=18),
        },
        {
            'name': 'CRYPTO + ALT + DD 15',
            'fn': lambda d: run_crypto_rotation_strat(d, alt_data, dd_stop_pct=15),
        },
        {
            'name': 'CRYPTO + ALT + DD 25 (lache)',
            'fn': lambda d: run_crypto_rotation_strat(d, alt_data, dd_stop_pct=25),
        },
        # Variants alternatives
        {
            'name': 'CRYPTO BTC 60 + ETH 30 + TLT 10 (concentré BTC) + ALT + DD 20',
            'fn': lambda d: run_ia(d, {'BTC-USD': 0.60, 'ETH-USD': 0.30, 'TLT': 0.10}, alt_data,
                                   dd_stop_pct=20, use_vix=False, use_yield=False),
        },
        {
            'name': 'CRYPTO BTC 50 + ETH 30 + SOL 10 + TLT 10 + ALT + DD 18',
            'fn': lambda d: run_ia(d, {'BTC-USD': 0.50, 'ETH-USD': 0.30, 'SOL-USD': 0.10, 'TLT': 0.10}, alt_data,
                                   dd_stop_pct=18, use_vix=False, use_yield=False),
        },
    ]
    print(f'\n{"Variant":<70}{"Annual":>9}{"DD":>9}{"WorstM":>9}')
    print('-' * 100)
    for v in crypto_variants:
        try:
            r = v['fn'](data)
            print(f'{v["name"][:69]:<70}{r["annual_return_pct"]:>8.1f}%{r["max_dd_pct"]:>8.1f}%{r["worst_monthly"]:>8.1f}%')
            results[f'CRYPTO_{v["name"]}'] = r
        except Exception as e:
            print(f'{v["name"][:69]:<70} FAILED: {e}')

    # ============ IA MIXTE PREMIUM+ ============
    print('\n' + '=' * 95)
    print(' IA MIXTE PREMIUM+ (multi-strat S1+S3+S4 + all ALT + DD 15)')
    print('=' * 95)
    mixte_variants = [
        {
            'name': 'MIXTE Premium+ baseline (winner actuel)',
            'weights': {'TQQQ': 0.30, 'SPY': 0.10, 'BTC-USD': 0.20, 'ETH-USD': 0.10,
                       'TLT': 0.20, 'XLK': 0.10},
            'dd_stop': 15,
        },
        {
            'name': 'MIXTE aggressive TQQQ 40 + BTC 20 + ETH 10 + TLT 20 + XLK 10',
            'weights': {'TQQQ': 0.40, 'BTC-USD': 0.20, 'ETH-USD': 0.10,
                       'TLT': 0.20, 'XLK': 0.10},
            'dd_stop': 15,
        },
        {
            'name': 'MIXTE TQQQ 30 + BTC 30 + TLT 30 + GLD 10',
            'weights': {'TQQQ': 0.30, 'BTC-USD': 0.30, 'TLT': 0.30, 'GLD': 0.10},
            'dd_stop': 15,
        },
        {
            'name': 'MIXTE Premium+ DD 12 (plus strict)',
            'weights': {'TQQQ': 0.30, 'SPY': 0.10, 'BTC-USD': 0.20, 'ETH-USD': 0.10,
                       'TLT': 0.20, 'XLK': 0.10},
            'dd_stop': 12,
        },
    ]
    print(f'\n{"Variant":<70}{"Annual":>9}{"DD":>9}{"WorstM":>9}')
    print('-' * 100)
    for v in mixte_variants:
        try:
            r = run_ia(data, v['weights'], alt_data, dd_stop_pct=v['dd_stop'])
            print(f'{v["name"][:69]:<70}{r["annual_return_pct"]:>8.1f}%{r["max_dd_pct"]:>8.1f}%{r["worst_monthly"]:>8.1f}%')
            results[f'MIXTE_{v["name"]}'] = r
        except Exception as e:
            print(f'{v["name"][:69]:<70} FAILED: {e}')

    # Save
    out = OUTPUT_DIR / 'lab_3_ias.json'
    with open(out, 'w') as f:
        json.dump(results, f, indent=2, default=str)
    print(f'\nSaved : {out}')

    # === FINAL VERDICT par categorie ===
    print('\n\n' + '=' * 95)
    print(' VERDICT FINAL PAR IA')
    print('=' * 95)
    for prefix in ['INDICES', 'CRYPTO', 'MIXTE']:
        print(f'\n--- {prefix} ---')
        cat = [(k, v) for k, v in results.items() if k.startswith(prefix)]
        cat.sort(key=lambda kv: -kv[1]['annual_return_pct'] / max(abs(kv[1]['max_dd_pct']) / 30, 1))
        for k, r in cat[:3]:
            print(f'  {k.replace(prefix + "_", "")[:65]:<65}  {r["annual_return_pct"]:>5.1f}% / DD {r["max_dd_pct"]:>5.1f}% / WM {r["worst_monthly"]:>5.1f}%')


if __name__ == '__main__':
    main()
