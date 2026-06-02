"""
Trade Genius — Lab Hybrid Safe

Test compromis hybride :
  X% capital en B&H SPY/TLT/GLD (robuste)
  Y% capital en META leveraged (risque)

Trouve le sweet spot X/Y qui maximise return tout en restant Monte-Carlo robust.
"""
import sys, json, warnings
warnings.filterwarnings('ignore')

import pandas as pd
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_meta_mc_validation import (
    run_ia_get_equity, stats_eq, load_alt_data,
)


def run_pure_bh(data, weights, rebal_days=21, commission=0.0015, slippage=0.0040, initial=1000):
    """B&H simple multi-asset avec rebalance."""
    cash = initial
    holdings = {t: 0.0 for t in weights}
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
                target_val = equity * weights.get(t, 0)
                current_val = holdings[t] * data[t].iloc[i]
                delta = target_val - current_val
                if abs(delta) < equity * 0.01:
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


def monte_carlo_eq(eq_series, n_iters=100, block_len=60):
    """MC blocks sur une serie equity arbitraire."""
    rng = np.random.default_rng(42)
    n = len(eq_series)
    results = []
    initial = eq_series.iloc[0]
    for _ in range(n_iters):
        n_blocks = n // block_len
        starts = rng.integers(0, n - block_len, size=n_blocks)
        idx = np.concatenate([np.arange(s, s + block_len) for s in starts])[:n]
        # On shuffle les returns daily (pas l'equity directement)
        rets = eq_series.pct_change().dropna()
        shuffled_rets = rets.iloc[idx[:len(rets)]].reset_index(drop=True)
        new_eq = (1 + shuffled_rets).cumprod() * initial
        peak = new_eq.cummax()
        dd = ((new_eq - peak) / peak).min() * 100
        n_years = n / 252
        final = new_eq.iloc[-1]
        annual = ((final / initial) ** (1 / n_years) - 1) * 100 if n_years > 0 else 0
        results.append({'annual': annual, 'dd': dd})
    df = pd.DataFrame(results)
    return {
        'annual_median': float(df['annual'].median()),
        'annual_p5': float(df['annual'].quantile(0.05)),
        'p_profit': float((df['annual'] > 0).mean()),
        'p_above_15': float((df['annual'] >= 15).mean()),
        'p_above_10': float((df['annual'] >= 10).mean()),
        'dd_worst': float(df['dd'].min()),
        'dd_median': float(df['dd'].median()),
    }


def main():
    print('=' * 95)
    print(' LAB HYBRID SAFE - mix B&H + META leveraged')
    print('=' * 95)

    alt_data = load_alt_data()
    universe = ['SPY', 'QQQ', 'TLT', 'IEF', 'GLD', 'XLK', 'BTC-USD', 'ETH-USD', 'SOL-USD', 'TQQQ']
    eng = LabEngine(universe=universe, start='2014-01-01')
    data = eng.data.loc['2019-09-01':'2026-01-01']
    print(f'Period : {data.index.min().date()} -> {data.index.max().date()}')

    # 1) Build pure B&H safe
    print('\n--- B&H Safe (60% SPY + 30% TLT + 10% GLD) ---')
    bh_weights = {'SPY': 0.60, 'TLT': 0.30, 'GLD': 0.10}
    eq_bh = run_pure_bh(data, bh_weights)
    s_bh = stats_eq(eq_bh, len(data))
    print(f'  Baseline : {s_bh["annual_return_pct"]:.1f}% / DD {s_bh["max_dd_pct"]:.1f}%')
    mc_bh = monte_carlo_eq(eq_bh)
    print(f'  MC : median {mc_bh["annual_median"]:.1f}% | P(profit) {mc_bh["p_profit"]*100:.0f}% | P(>=10%) {mc_bh["p_above_10"]*100:.0f}% | DDworst {mc_bh["dd_worst"]:.1f}%')

    # 2) Build META leveraged (winner)
    print('\n--- META leveraged (current winner) ---')
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
    # META equipondere
    e_i = eq_ind / eq_ind.iloc[0]
    e_c = eq_crp / eq_crp.iloc[0]
    e_m = eq_mix / eq_mix.iloc[0]
    eq_meta = (1/3 * e_i + 1/3 * e_c + 1/3 * e_m) * 1000
    s_meta = stats_eq(eq_meta, len(data))
    print(f'  Baseline : {s_meta["annual_return_pct"]:.1f}% / DD {s_meta["max_dd_pct"]:.1f}%')
    mc_meta = monte_carlo_eq(eq_meta)
    print(f'  MC : median {mc_meta["annual_median"]:.1f}% | P(profit) {mc_meta["p_profit"]*100:.0f}% | P(>=15%) {mc_meta["p_above_15"]*100:.0f}% | DDworst {mc_meta["dd_worst"]:.1f}%')

    # 3) HYBRIDS : X% B&H + (1-X)% META
    print('\n--- HYBRIDES (mix B&H + META) ---')
    print(f'{"BH %":<8}{"Baseline":<22}{"MC median":<12}{"P(profit)":<11}{"P(>=10%)":<10}{"P(>=15%)":<10}{"DDworst":<10}{"Calmar":<8}')
    print('-' * 100)

    all_results = {}
    for bh_pct in [100, 80, 70, 60, 50, 40, 30, 20, 0]:
        meta_pct = 100 - bh_pct
        # Combine eq series
        eq_combined = (bh_pct / 100 * (eq_bh / eq_bh.iloc[0]) +
                       meta_pct / 100 * (eq_meta / eq_meta.iloc[0])) * 1000
        s = stats_eq(eq_combined, len(data))
        mc = monte_carlo_eq(eq_combined)
        cal = s['annual_return_pct'] / max(abs(s['max_dd_pct']), 1)
        print(f'{bh_pct}%/{meta_pct}%   '
              f'{s["annual_return_pct"]:>5.1f}% / DD {s["max_dd_pct"]:>5.1f}%   '
              f'{mc["annual_median"]:>5.1f}%   '
              f'{mc["p_profit"]*100:>4.0f}%      '
              f'{mc["p_above_10"]*100:>4.0f}%      '
              f'{mc["p_above_15"]*100:>4.0f}%      '
              f'{mc["dd_worst"]:>5.1f}%   {cal:.2f}')
        all_results[f'BH_{bh_pct}_META_{meta_pct}'] = {
            'bh_pct': bh_pct, 'meta_pct': meta_pct,
            'baseline': s, 'monte_carlo': mc, 'calmar': cal,
        }

    out = OUTPUT_DIR / 'lab_hybrid_safe.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved : {out}')

    # FINAL VERDICT
    print('\n\n' + '=' * 95)
    print(' VERDICT HYBRID - sweet spot return vs robustesse MC')
    print('=' * 95)
    for k, r in all_results.items():
        b = r['baseline']
        mc = r['monte_carlo']
        # Verdict robust si MC median >= 0 ET P(profit) >= 70 ET DDworst >= -70
        if mc['annual_median'] >= 5 and mc['p_profit'] >= 0.7 and mc['dd_worst'] >= -70:
            v = '*** ROBUST ***'
        elif mc['p_profit'] >= 0.6:
            v = 'OK'
        else:
            v = 'fragile'
        print(f'  BH {r["bh_pct"]}% / META {r["meta_pct"]}% : Baseline {b["annual_return_pct"]:.1f}%/DD {b["max_dd_pct"]:.1f}% | MC median {mc["annual_median"]:.1f}%/P(prof) {mc["p_profit"]*100:.0f}%/DDw {mc["dd_worst"]:.1f}%  ->  {v}')


if __name__ == '__main__':
    main()
