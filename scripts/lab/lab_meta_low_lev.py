"""
Trade Genius — Lab META Low Leverage

Tester plusieurs niveaux de leverage (TQQQ) :
  - 0% TQQQ (full non-leveraged) : QQQ + SPY + TLT + GLD + BTC
  - 15% TQQQ
  - 25% TQQQ
  - 35% TQQQ
  - 50% TQQQ (baseline current)

Pour chaque, mesurer baseline + MC blocks 200 iters.
Identifier le sweet spot leverage/robustesse.

Critere : MC P(profit) >= 75% ET MC median annual >= 12%
"""
import sys, json, warnings
warnings.filterwarnings('ignore')

import pandas as pd
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_meta_mc_validation import (
    run_ia_get_equity, stats_eq, monte_carlo_meta, load_alt_data,
    compute_master_signal, compute_onchain_signal, compute_adaptive_weights
)


def test_leverage_level(data, alt_data, tqqq_pct, name_suffix=''):
    """
    Build 3 IAs avec TQQQ reduit.
    Reste = QQQ (vrai equiv sans leverage).
    """
    qqq_pct = (60 - tqqq_pct) / 60 * 60  # garde proportion équiv : si TQQQ baisse, QQQ remplace
    # Plus simple : TQQQ + QQQ totalisent 60%
    qqq_share = 60 - tqqq_pct

    # IA INDICES : TQQQ X% + QQQ Y% + TLT 20 + GLD 20
    ia_indices = {
        'weights': {'TQQQ': tqqq_pct / 100, 'QQQ': qqq_share / 100, 'TLT': 0.20, 'GLD': 0.20},
        'use_master': False, 'use_onchain': True,
    }
    # IA CRYPTO : reste similaire (utilise BTC, pas TQQQ)
    ia_crypto = {
        'wf_tickers': ['BTC-USD', 'ETH-USD', 'SOL-USD', 'TLT'],
        'use_wf': True, 'wf_retrain': 60,
        'use_master': False, 'use_onchain': True,
    }
    # IA MIXTE : TQQQ X% + QQQ Y% + BTC 10 + ETH 10 + TLT 10 + GLD 10 + XLK 10
    # Reste 50% pour TQQQ+QQQ
    mix_tqqq_pct = tqqq_pct / 60 * 50  # proportionnel à 50% de poche TQQQ
    mix_qqq_pct = 50 - mix_tqqq_pct
    ia_mixte = {
        'weights': {'TQQQ': mix_tqqq_pct / 100, 'QQQ': mix_qqq_pct / 100,
                   'BTC-USD': 0.10, 'ETH-USD': 0.10,
                   'TLT': 0.10, 'GLD': 0.10, 'XLK': 0.10},
        'use_master': True, 'use_onchain': False,
    }

    eq_ind = run_ia_get_equity(data, ia_indices, alt_data)
    eq_crp = run_ia_get_equity(data, ia_crypto, alt_data)
    eq_mix = run_ia_get_equity(data, ia_mixte, alt_data)

    return eq_ind, eq_crp, eq_mix


def main():
    print('=' * 95)
    print(' LAB META LOW LEVERAGE - find robust sweet spot')
    print('=' * 95)

    alt_data = load_alt_data()
    universe = ['SPY', 'QQQ', 'TLT', 'IEF', 'GLD', 'XLK', 'BTC-USD', 'ETH-USD', 'SOL-USD', 'TQQQ']
    eng = LabEngine(universe=universe, start='2014-01-01')
    data = eng.data.loc['2019-09-01':'2026-01-01']
    print(f'Period : {data.index.min().date()} -> {data.index.max().date()}')

    leverage_levels = [0, 15, 25, 35, 50]
    meta_weights = {'IND': 1/3, 'CRP': 1/3, 'MIX': 1/3}  # equipondere fixe

    print(f'\n{"TQQQ %":<10}{"Baseline":<15}{"MC median":<12}{"MC P5":<10}{"MC P(profit)":<14}{"MC P(>=15%)":<12}{"DD worst":<10}')
    print('-' * 90)

    all_results = {}
    for tqqq_pct in leverage_levels:
        print(f'\n--- TEST TQQQ {tqqq_pct}% ---')
        try:
            eq_ind, eq_crp, eq_mix = test_leverage_level(data, alt_data, tqqq_pct)
            s_ind = stats_eq(eq_ind, len(data))
            s_crp = stats_eq(eq_crp, len(data))
            s_mix = stats_eq(eq_mix, len(data))
            print(f'  IND: {s_ind["annual_return_pct"]:.1f}% / DD {s_ind["max_dd_pct"]:.1f}%')
            print(f'  CRP: {s_crp["annual_return_pct"]:.1f}% / DD {s_crp["max_dd_pct"]:.1f}%')
            print(f'  MIX: {s_mix["annual_return_pct"]:.1f}% / DD {s_mix["max_dd_pct"]:.1f}%')

            # Build META equipondere
            e_i = eq_ind / eq_ind.iloc[0]
            e_c = eq_crp / eq_crp.iloc[0]
            e_m = eq_mix / eq_mix.iloc[0]
            meta_eq = (1/3 * e_i + 1/3 * e_c + 1/3 * e_m) * 1000
            baseline = stats_eq(meta_eq, len(data))
            print(f'  META baseline : {baseline["annual_return_pct"]:.1f}% / DD {baseline["max_dd_pct"]:.1f}%')

            # MC
            print(f'  Running MC 100 iters...')
            mc = monte_carlo_meta(eq_ind, eq_crp, eq_mix, meta_weights, n_iters=100)
            print(f'  MC : median {mc["annual_median"]:.1f}% | P5 {mc["annual_p5"]:.1f}% | P(profit) {mc["p_profit"]*100:.0f}% | P(>=15%) {mc["p_above_15"]*100:.0f}% | DD worst {mc["dd_worst"]:.1f}%')

            verdict = ''
            if mc['p_profit'] >= 0.75 and mc['p_above_15'] >= 0.5 and mc['dd_worst'] >= -70:
                verdict = '*** ROBUST ***'
            elif mc['p_profit'] >= 0.65 and mc['p_above_15'] >= 0.35:
                verdict = 'OK'
            else:
                verdict = 'FRAGILE'

            all_results[f'TQQQ_{tqqq_pct}%'] = {
                'tqqq_pct': tqqq_pct,
                'baseline': baseline,
                'monte_carlo': mc,
                'verdict': verdict,
            }
            print(f'  Verdict : {verdict}')
        except Exception as e:
            print(f'  FAILED: {e}')
            import traceback; traceback.print_exc()

    out = OUTPUT_DIR / 'lab_meta_low_lev.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved : {out}')

    # FINAL VERDICT
    print('\n\n' + '=' * 95)
    print(' VERDICT FINAL - leverage sweet spot')
    print('=' * 95)
    print(f'{"TQQQ %":<10}{"Baseline":<18}{"MC median":<12}{"P(profit)":<11}{"P(>=15%)":<11}{"DDworst":<10}{"Verdict":<18}')
    print('-' * 100)
    for k, r in all_results.items():
        b = r['baseline']
        mc = r['monte_carlo']
        print(f'  {r["tqqq_pct"]}%       {b["annual_return_pct"]:>5.1f}% / DD {b["max_dd_pct"]:>5.1f}%  '
              f'{mc["annual_median"]:>5.1f}%  {mc["p_profit"]*100:>4.0f}%  {mc["p_above_15"]*100:>5.0f}%  '
              f'{mc["dd_worst"]:>5.1f}%   {r["verdict"]}')


if __name__ == '__main__':
    main()
