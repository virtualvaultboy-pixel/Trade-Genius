"""
Trade Genius — Lab Meta 4 IAs

Ajouter une 4eme IA (Antonacci Dual Momentum classique) au META pour
augmenter la decorrelation.

Strategie Antonacci pur :
  - Tous les mois, choisir best momentum 12m entre SPY/EFA/IEF
  - Si best < cash return : 100% IEF
  - Sinon : 100% best
  - DD historique ~-25%, return ~10-12%/an

On l'ajoute au META :
  META 4 = 25% INDICES + 25% CRYPTO + 25% MIXTE + 25% ANTONACCI
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


def run_antonacci_pure(data, rebal_days=21, commission=0.0015, slippage=0.0040, initial=1000):
    """
    Antonacci pur : pick best momentum 12m entre SPY/EFA/IEF.
    Si max < 0 : full IEF.
    """
    universe = ['SPY', 'EFA', 'IEF']
    cash = initial
    holdings = {t: 0.0 for t in universe if t in data.columns}
    peak = initial; max_dd = 0
    eq_series = pd.Series(initial, index=data.index, dtype=float)
    current_target = None
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

        if i in rebal_indices and i >= 252:
            # Compute 12m momentum
            moms = {}
            for t in universe:
                if t in data.columns and not pd.isna(data[t].iloc[i]) and not pd.isna(data[t].iloc[i - 252]):
                    moms[t] = data[t].iloc[i] / data[t].iloc[i - 252] - 1
            if not moms:
                continue
            # Best
            best = max(moms.items(), key=lambda kv: kv[1])
            if best[1] < 0 and 'IEF' in moms:
                target = 'IEF'
            else:
                target = best[0]

            if current_target != target:
                # Sell all
                for t in list(holdings.keys()):
                    if t in data.columns and not pd.isna(data[t].iloc[i]) and holdings[t] > 0:
                        proceeds = holdings[t] * data[t].iloc[i] * (1 - slippage)
                        fee = proceeds * commission
                        cash += proceeds - fee
                        holdings[t] = 0
                # Buy target
                if target in data.columns:
                    cost = cash * 0.99
                    fee = cost * commission
                    price = data[target].iloc[i] * (1 + slippage)
                    shares = (cost - fee) / price
                    holdings[target] = shares
                    cash = cash - cost
                current_target = target

    return eq_series


def main():
    print('=' * 95)
    print(' LAB META 4 IAs - ajouter Antonacci pour decorrelation')
    print('=' * 95)

    alt_data = load_alt_data()
    universe = ['SPY', 'QQQ', 'EFA', 'TLT', 'IEF', 'GLD', 'XLK',
                'BTC-USD', 'ETH-USD', 'SOL-USD', 'TQQQ']
    eng = LabEngine(universe=universe, start='2014-01-01')
    data = eng.data.loc['2019-09-01':'2026-01-01']
    print(f'Period : {data.index.min().date()} -> {data.index.max().date()}')

    # Run 4 IAs
    print('\n--- Run 4 IAs separately ---')
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
    eq_ant = run_antonacci_pure(data)

    for name, eq in [('INDICES', eq_ind), ('CRYPTO', eq_crp), ('MIXTE', eq_mix), ('ANTONACCI', eq_ant)]:
        s = stats_eq(eq, len(data))
        print(f'  {name:<12} : {s["annual_return_pct"]:.1f}% / DD {s["max_dd_pct"]:.1f}%')

    # Correlations
    print('\n--- Correlations daily returns ---')
    r_i = eq_ind.pct_change().dropna()
    r_c = eq_crp.pct_change().dropna()
    r_m = eq_mix.pct_change().dropna()
    r_a = eq_ant.pct_change().dropna()
    print(f'  IND vs CRP : {r_i.corr(r_c):.2f}')
    print(f'  IND vs MIX : {r_i.corr(r_m):.2f}')
    print(f'  IND vs ANT : {r_i.corr(r_a):.2f}')
    print(f'  CRP vs MIX : {r_c.corr(r_m):.2f}')
    print(f'  CRP vs ANT : {r_c.corr(r_a):.2f}')
    print(f'  MIX vs ANT : {r_m.corr(r_a):.2f}')

    # META 3 IAs vs META 4 IAs
    print('\n\n--- META 3 vs META 4 ---')
    eq_meta3 = (1/3 * eq_ind / eq_ind.iloc[0] +
                1/3 * eq_crp / eq_crp.iloc[0] +
                1/3 * eq_mix / eq_mix.iloc[0]) * 1000
    eq_meta4 = (0.25 * eq_ind / eq_ind.iloc[0] +
                0.25 * eq_crp / eq_crp.iloc[0] +
                0.25 * eq_mix / eq_mix.iloc[0] +
                0.25 * eq_ant / eq_ant.iloc[0]) * 1000
    eq_meta4_low_ant = (0.30 * eq_ind / eq_ind.iloc[0] +
                        0.30 * eq_crp / eq_crp.iloc[0] +
                        0.30 * eq_mix / eq_mix.iloc[0] +
                        0.10 * eq_ant / eq_ant.iloc[0]) * 1000

    # Test full periods
    eq_bh = run_pure_bh(data, {'SPY': 0.60, 'TLT': 0.30, 'GLD': 0.10})
    mix50_meta3 = (0.5 * eq_bh / eq_bh.iloc[0] + 0.5 * eq_meta3 / eq_meta3.iloc[0]) * 1000
    mix50_meta4 = (0.5 * eq_bh / eq_bh.iloc[0] + 0.5 * eq_meta4 / eq_meta4.iloc[0]) * 1000
    mix50_meta4_low = (0.5 * eq_bh / eq_bh.iloc[0] + 0.5 * eq_meta4_low_ant / eq_meta4_low_ant.iloc[0]) * 1000

    candidates = [
        ('META 3 (current winner)', eq_meta3, mix50_meta3),
        ('META 4 (25 each)', eq_meta4, mix50_meta4),
        ('META 4 (30/30/30/10)', eq_meta4_low_ant, mix50_meta4_low),
    ]

    print(f'\n{"Strategy":<35}{"Annual":>9}{"DD":>9}{"WorstM":>9}{"Calmar":>9}{"MC P(prof)":>12}')
    print('-' * 90)
    all_results = {}
    for name, eq_meta, eq_mix50 in candidates:
        s_meta = stats_eq(eq_meta, len(data))
        s_mix = stats_eq(eq_mix50, len(data))
        mc_mix = monte_carlo_eq(eq_mix50, n_iters=100)
        cal_meta = s_meta['annual_return_pct'] / max(abs(s_meta['max_dd_pct']), 1)
        cal_mix = s_mix['annual_return_pct'] / max(abs(s_mix['max_dd_pct']), 1)
        print(f'  META {name:<25}{s_meta["annual_return_pct"]:>8.1f}%{s_meta["max_dd_pct"]:>8.1f}%{s_meta["worst_monthly"]:>8.1f}%{cal_meta:>8.2f}')
        print(f'  +BH50/50    -> {name:<22}{s_mix["annual_return_pct"]:>8.1f}%{s_mix["max_dd_pct"]:>8.1f}%{s_mix["worst_monthly"]:>8.1f}%{cal_mix:>8.2f}{mc_mix["p_profit"]*100:>11.0f}%')
        all_results[name] = {
            'meta': s_meta, 'mix50': s_mix, 'mc': mc_mix,
        }

    out = OUTPUT_DIR / 'lab_meta_4ias.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved : {out}')


if __name__ == '__main__':
    main()
