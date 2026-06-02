"""
Trade Genius — Lab META Aggressive

Tester l'ajout de single-stock leveraged ETF a la 4eme position :
  - NVDL : Nvidia 2x
  - FNGU : MicroSectors FANG 3x (Meta, Apple, Amazon, Netflix, Google + Nvidia, Tesla, Microsoft)
  - SOXL : Semiconductor 3x

Comparer META 3 IAs vs META 4 IAs avec stock leverage.
"""
import sys, json, warnings
warnings.filterwarnings('ignore')

import pandas as pd
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_meta_mc_validation import run_ia_get_equity, stats_eq, load_alt_data
from lab_hybrid_safe import run_pure_bh, monte_carlo_eq


def run_single_lev_strat(data, ticker, hedge_pct=0.30, rebal_days=21,
                          commission=0.0015, slippage=0.0040, initial=1000):
    """
    Single leveraged stock + hedge bonds.
    - (1-hedge)% du ticker leveraged
    - hedge% TLT
    """
    if ticker not in data.columns:
        return pd.Series(initial, index=data.index, dtype=float)

    weights = {ticker: 1 - hedge_pct, 'TLT': hedge_pct}
    cash = initial
    holdings = {t: 0.0 for t in weights if t in data.columns}
    peak = initial; max_dd = 0
    eq_series = pd.Series(initial, index=data.index, dtype=float)
    rebal_indices = set(range(0, len(data), rebal_days))

    for i, date in enumerate(data.index):
        equity = cash
        for t, sh in holdings.items():
            if t in data.columns and not pd.isna(data[t].iloc[i]):
                equity += sh * data[t].iloc[i]
        eq_series.iloc[i] = equity
        if equity > peak:
            peak = equity
        dd = (equity - peak) / peak
        if dd < max_dd:
            max_dd = dd

        if i in rebal_indices:
            for t in holdings:
                if t not in data.columns or pd.isna(data[t].iloc[i]):
                    continue
                target_val = equity * weights[t]
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

    return eq_series


def main():
    print('=' * 95)
    print(' LAB META AGGRESSIVE - test NVDL/FNGU/SOXL comme 4eme IA')
    print('=' * 95)

    alt_data = load_alt_data()
    # Test diverse leveraged stocks
    universe = ['SPY', 'QQQ', 'TLT', 'IEF', 'GLD', 'XLK',
                'BTC-USD', 'ETH-USD', 'SOL-USD',
                'TQQQ', 'SOXL', 'NVDL', 'FNGU', 'TNA', 'TECL']
    eng = LabEngine(universe=universe, start='2014-01-01')
    data = eng.data.loc['2019-09-01':'2026-01-01']
    print(f'Period : {data.index.min().date()} -> {data.index.max().date()}')

    # Quels tickers leveraged sont dispos ?
    print('\n--- Disponibilite leveraged ETFs ---')
    avail = []
    for t in ['NVDL', 'FNGU', 'SOXL', 'TNA', 'TECL']:
        if t in data.columns:
            first_valid = data[t].first_valid_index()
            ratio = data[t].notna().sum() / len(data)
            print(f'  {t} : first valid {first_valid.date() if first_valid else "N/A"}, coverage {ratio*100:.0f}%')
            if ratio > 0.8:
                avail.append(t)
    print(f'  Available avec >80% coverage : {avail}')

    # Run 3 IAs baseline
    print('\n--- 3 IAs baseline ---')
    ia_cfg = {
        'INDICES': {'weights': {'TQQQ': 0.60, 'TLT': 0.20, 'GLD': 0.20},
                   'use_master': False, 'use_onchain': True},
        'CRYPTO': {'wf_tickers': ['BTC-USD', 'ETH-USD', 'SOL-USD', 'TLT'],
                  'use_wf': True, 'wf_retrain': 60,
                  'use_master': False, 'use_onchain': True},
        'MIXTE': {'weights': {'TQQQ': 0.50, 'BTC-USD': 0.10, 'ETH-USD': 0.10,
                              'TLT': 0.10, 'GLD': 0.10, 'XLK': 0.10},
                 'use_master': True, 'use_onchain': False},
    }
    eq_ind = run_ia_get_equity(data, ia_cfg['INDICES'], alt_data)
    eq_crp = run_ia_get_equity(data, ia_cfg['CRYPTO'], alt_data)
    eq_mix = run_ia_get_equity(data, ia_cfg['MIXTE'], alt_data)
    for name, eq in [('INDICES', eq_ind), ('CRYPTO', eq_crp), ('MIXTE', eq_mix)]:
        s = stats_eq(eq, len(data))
        print(f'  {name:<10} : {s["annual_return_pct"]:.1f}% / DD {s["max_dd_pct"]:.1f}%')

    # Test chaque leveraged en single + hedge
    print('\n--- Test single leveraged stock (70%/30% hedge TLT) ---')
    single_results = {}
    for tk in avail:
        eq = run_single_lev_strat(data, tk, hedge_pct=0.30)
        s = stats_eq(eq, len(data))
        print(f'  {tk:<10} 70%/30% TLT : {s["annual_return_pct"]:.1f}% / DD {s["max_dd_pct"]:.1f}%')
        single_results[tk] = {'equity': eq, 'stats': s}

    # Build META 4 IAs avec chaque leveraged stock
    print('\n--- META 4 IAs (25/25/25/25) + BH 50/50 mix ---')
    eq_bh = run_pure_bh(data, {'SPY': 0.60, 'TLT': 0.30, 'GLD': 0.10})
    s_bh = stats_eq(eq_bh, len(data))
    print(f'  B&H safe : {s_bh["annual_return_pct"]:.1f}% / DD {s_bh["max_dd_pct"]:.1f}%')

    # META 3 baseline
    eq_meta3 = (1/3 * eq_ind / eq_ind.iloc[0] +
                1/3 * eq_crp / eq_crp.iloc[0] +
                1/3 * eq_mix / eq_mix.iloc[0]) * 1000
    eq_mix50_3 = (0.5 * eq_bh / eq_bh.iloc[0] + 0.5 * eq_meta3 / eq_meta3.iloc[0]) * 1000
    s_meta3 = stats_eq(eq_meta3, len(data))
    s_mix3 = stats_eq(eq_mix50_3, len(data))
    mc3 = monte_carlo_eq(eq_mix50_3, n_iters=100)
    print(f'\n{"Strategy":<35}{"Annual":>9}{"DD":>9}{"Calmar":>9}{"MC P(prof)":>12}')
    print('-' * 75)
    cal3 = s_mix3["annual_return_pct"] / max(abs(s_mix3["max_dd_pct"]), 1)
    print(f'  META 3 + BH 50/50 (current) {s_mix3["annual_return_pct"]:>7.1f}%{s_mix3["max_dd_pct"]:>8.1f}%{cal3:>8.2f}{mc3["p_profit"]*100:>11.0f}%')

    all_results = {'META3_baseline': {'mix50': s_mix3, 'mc': mc3}}

    # Pour chaque leveraged dispo : META 4
    for tk in avail:
        eq_4th = single_results[tk]['equity']
        eq_meta4 = (0.25 * eq_ind / eq_ind.iloc[0] +
                    0.25 * eq_crp / eq_crp.iloc[0] +
                    0.25 * eq_mix / eq_mix.iloc[0] +
                    0.25 * eq_4th / eq_4th.iloc[0]) * 1000
        eq_mix50_4 = (0.5 * eq_bh / eq_bh.iloc[0] + 0.5 * eq_meta4 / eq_meta4.iloc[0]) * 1000
        s_mix4 = stats_eq(eq_mix50_4, len(data))
        mc4 = monte_carlo_eq(eq_mix50_4, n_iters=100)
        cal4 = s_mix4["annual_return_pct"] / max(abs(s_mix4["max_dd_pct"]), 1)
        print(f'  META 4 ({tk}) + BH 50/50  {s_mix4["annual_return_pct"]:>7.1f}%{s_mix4["max_dd_pct"]:>8.1f}%{cal4:>8.2f}{mc4["p_profit"]*100:>11.0f}%')
        all_results[f'META4_{tk}'] = {'mix50': s_mix4, 'mc': mc4}

    # Test META 5 IAs avec NVDL + FNGU (les 2 plus prometteurs)
    if 'NVDL' in avail and 'FNGU' in avail:
        eq_nv = single_results['NVDL']['equity']
        eq_fng = single_results['FNGU']['equity']
        eq_meta5 = (0.20 * eq_ind / eq_ind.iloc[0] +
                    0.20 * eq_crp / eq_crp.iloc[0] +
                    0.20 * eq_mix / eq_mix.iloc[0] +
                    0.20 * eq_nv / eq_nv.iloc[0] +
                    0.20 * eq_fng / eq_fng.iloc[0]) * 1000
        eq_mix50_5 = (0.5 * eq_bh / eq_bh.iloc[0] + 0.5 * eq_meta5 / eq_meta5.iloc[0]) * 1000
        s_mix5 = stats_eq(eq_mix50_5, len(data))
        mc5 = monte_carlo_eq(eq_mix50_5, n_iters=100)
        cal5 = s_mix5["annual_return_pct"] / max(abs(s_mix5["max_dd_pct"]), 1)
        print(f'  META 5 (NVDL+FNGU) + BH 50/50 {s_mix5["annual_return_pct"]:>4.1f}%{s_mix5["max_dd_pct"]:>8.1f}%{cal5:>8.2f}{mc5["p_profit"]*100:>11.0f}%')
        all_results['META5_NVDL_FNGU'] = {'mix50': s_mix5, 'mc': mc5}

    out = OUTPUT_DIR / 'lab_meta_aggressive.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved : {out}')


if __name__ == '__main__':
    main()
