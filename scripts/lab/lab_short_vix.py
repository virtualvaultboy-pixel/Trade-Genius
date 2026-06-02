"""
Trade Genius — Lab Short VIX

Volatility Risk Premium = vendre VIX = gain structurel 10-15%/an
MAIS DD enorme (-80% en 2020, -50% en 2018).

Tester :
  1. SVXY (-0.5x VIX) en B&H
  2. SVXY avec trend filter (long si VIX < 20)
  3. SVXY 5% comme 4eme IA META
  4. Comparer META 4 (SVXY) vs META 3 baseline
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


def run_short_vix_strat(data, alt_data, vix_threshold=22, rebal_days=21,
                         commission=0.0015, slippage=0.0040, initial=1000,
                         hedge_pct=0.5):
    """
    SVXY (1-hedge_pct)% + TLT hedge_pct% avec trend filter (long si VIX < threshold).
    """
    if 'SVXY' not in data.columns:
        return pd.Series(initial, index=data.index, dtype=float)

    cash = initial
    holdings = {'SVXY': 0.0, 'TLT': 0.0}
    peak = initial; max_dd = 0
    eq_series = pd.Series(initial, index=data.index, dtype=float)
    rebal_indices = set(range(0, len(data), rebal_days))

    vix = alt_data.get('fred_VIXCLS', pd.DataFrame())
    if not vix.empty:
        vix_s = vix['VIXCLS'].reindex(data.index, method='ffill')
    else:
        vix_s = pd.Series(20, index=data.index)

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
            in_calm = vix_s.iloc[i] < vix_threshold if i < len(vix_s) else True
            target_svxy = (1 - hedge_pct) if in_calm else 0
            target_tlt = hedge_pct if in_calm else 0.95
            targets = {'SVXY': target_svxy, 'TLT': target_tlt}

            for t in holdings:
                if t not in data.columns or pd.isna(data[t].iloc[i]):
                    continue
                target_val = equity * targets[t]
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
    print(' LAB SHORT VIX - test SVXY comme strategie ou 4eme IA')
    print('=' * 95)

    alt_data = load_alt_data()
    universe = ['SPY', 'QQQ', 'TLT', 'IEF', 'GLD', 'XLK',
                'BTC-USD', 'ETH-USD', 'SOL-USD', 'TQQQ', 'SVXY', 'VIXY']
    eng = LabEngine(universe=universe, start='2014-01-01')
    data = eng.data.loc['2019-09-01':'2026-01-01']
    print(f'Period : {data.index.min().date()} -> {data.index.max().date()}')

    # Verif dispo SVXY
    if 'SVXY' not in data.columns:
        print('  SVXY pas dispo, abort.')
        return
    cov = data['SVXY'].notna().sum() / len(data)
    print(f'  SVXY coverage : {cov*100:.0f}%')

    # 1. SVXY pur (B&H sans filter)
    eq_svxy_pure = pd.Series(1000.0, index=data.index)
    svxy_norm = data['SVXY'] / data['SVXY'].iloc[0]
    eq_svxy_pure = svxy_norm * 1000
    s = stats_eq(eq_svxy_pure, len(data))
    print(f'\n--- SVXY B&H pur ---')
    print(f'  Annual {s["annual_return_pct"]:.1f}% / DD {s["max_dd_pct"]:.1f}% / Calmar {s["annual_return_pct"]/max(abs(s["max_dd_pct"]),1):.2f}')

    # 2. SVXY avec trend filter VIX
    print(f'\n--- SVXY 50% + TLT 50% avec trend filter VIX ---')
    for vt in [18, 22, 28]:
        eq = run_short_vix_strat(data, alt_data, vix_threshold=vt, hedge_pct=0.5)
        s = stats_eq(eq, len(data))
        print(f'  VIX < {vt} : Annual {s["annual_return_pct"]:.1f}% / DD {s["max_dd_pct"]:.1f}% / Calmar {s["annual_return_pct"]/max(abs(s["max_dd_pct"]),1):.2f}')

    # 3. SVXY 30% + TLT 70% (plus conservateur)
    eq_svxy_safe = run_short_vix_strat(data, alt_data, vix_threshold=22, hedge_pct=0.7)
    s = stats_eq(eq_svxy_safe, len(data))
    print(f'\n--- SVXY 30% + TLT 70% + filter VIX 22 ---')
    print(f'  Annual {s["annual_return_pct"]:.1f}% / DD {s["max_dd_pct"]:.1f}% / Calmar {s["annual_return_pct"]/max(abs(s["max_dd_pct"]),1):.2f}')

    # 4. META 4 IAs (ajouter SVXY)
    print(f'\n--- META 4 IAs avec SVXY ---')
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
    eq_bh = run_pure_bh(data, {'SPY': 0.60, 'TLT': 0.30, 'GLD': 0.10})

    # Baseline
    eq_meta3 = (1/3 * eq_ind / eq_ind.iloc[0] +
                1/3 * eq_crp / eq_crp.iloc[0] +
                1/3 * eq_mix / eq_mix.iloc[0]) * 1000
    eq_mix3 = (0.5 * eq_bh / eq_bh.iloc[0] + 0.5 * eq_meta3 / eq_meta3.iloc[0]) * 1000
    s3 = stats_eq(eq_mix3, len(data))
    mc3 = monte_carlo_eq(eq_mix3, n_iters=100)

    print(f'\n{"Strategy":<55}{"Annual":>9}{"DD":>9}{"Calmar":>9}{"MC P(prof)":>12}')
    print('-' * 95)
    cal3 = s3["annual_return_pct"] / max(abs(s3["max_dd_pct"]), 1)
    print(f'  META 3 + BH 50/50 (baseline)        {s3["annual_return_pct"]:>7.1f}%{s3["max_dd_pct"]:>8.1f}%{cal3:>8.2f}{mc3["p_profit"]*100:>11.0f}%')

    # Test META 4 avec SVXY config differente
    for svxy_strat_name, eq_svxy in [
        ('SVXY 50/50 VIX22', run_short_vix_strat(data, alt_data, 22, hedge_pct=0.5)),
        ('SVXY 30/70 VIX22', run_short_vix_strat(data, alt_data, 22, hedge_pct=0.7)),
    ]:
        eq_meta4 = (0.25 * eq_ind / eq_ind.iloc[0] +
                    0.25 * eq_crp / eq_crp.iloc[0] +
                    0.25 * eq_mix / eq_mix.iloc[0] +
                    0.25 * eq_svxy / eq_svxy.iloc[0]) * 1000
        eq_mix4 = (0.5 * eq_bh / eq_bh.iloc[0] + 0.5 * eq_meta4 / eq_meta4.iloc[0]) * 1000
        s4 = stats_eq(eq_mix4, len(data))
        mc4 = monte_carlo_eq(eq_mix4, n_iters=100)
        cal4 = s4["annual_return_pct"] / max(abs(s4["max_dd_pct"]), 1)
        print(f'  META 4 ({svxy_strat_name}) + BH 50/50  {s4["annual_return_pct"]:>5.1f}%{s4["max_dd_pct"]:>8.1f}%{cal4:>8.2f}{mc4["p_profit"]*100:>11.0f}%')

    # Test SVXY petite poche 10% directement dans winner
    print(f'\n--- ADD SVXY direct au winner (5-10% hedge) ---')
    for svxy_pct in [5, 10, 15]:
        # Apply : (1-svxy%) * Mix50 + svxy% * SVXY strategy
        svxy_eq = run_short_vix_strat(data, alt_data, 22, hedge_pct=0.5)
        combined = ((1 - svxy_pct/100) * eq_mix3 / eq_mix3.iloc[0] +
                    svxy_pct/100 * svxy_eq / svxy_eq.iloc[0]) * 1000
        s = stats_eq(combined, len(data))
        mc = monte_carlo_eq(combined, n_iters=100)
        cal = s["annual_return_pct"] / max(abs(s["max_dd_pct"]), 1)
        print(f'  Winner + {svxy_pct}% SVXY-strat       {s["annual_return_pct"]:>5.1f}%{s["max_dd_pct"]:>8.1f}%{cal:>8.2f}{mc["p_profit"]*100:>11.0f}%')


if __name__ == '__main__':
    main()
