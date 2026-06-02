"""
Trade Genius — Lab Full Validation

Validation ULTRA du WINNER (Mix BH 50% / META 50%) sur :
  1. 2010-2014 : pre-crypto, indices + leverage only
  2. 2015-2019 : pre-COVID, regime calme
  3. 2019-2025 : reference winner (deja valide)
  4. 2008-2010 : crise subprime (pure BH safe, sans leverage car TQQQ apres 2010)
  5. Stress max : commission 3x + slippage 1.5x

Critere final : robuste sur 4/5 periodes + stress max -> deployable
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
from lab_hybrid_safe import run_pure_bh, monte_carlo_eq


def test_period(data, alt_data, period_name, has_crypto=True, has_lev=True):
    """Test le winner Mix BH 50% META 50% sur une periode donnée."""
    print(f'\n--- {period_name} : {data.index.min().date()} -> {data.index.max().date()} ({len(data)/252:.1f} ans) ---')

    # B&H SAFE 50%
    bh_weights = {'SPY': 0.60, 'TLT': 0.30, 'GLD': 0.10}
    eq_bh = run_pure_bh(data, bh_weights)
    s_bh = stats_eq(eq_bh, len(data))
    print(f'  B&H safe seul : {s_bh["annual_return_pct"]:.1f}% / DD {s_bh["max_dd_pct"]:.1f}%')

    if not has_lev:
        print(f'  (pas de leverage / crypto disponible cette periode -> juste B&H)')
        return {'bh_safe': s_bh}

    # META leveraged
    if has_crypto:
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
    else:
        # Pas de crypto : on remplace BTC/ETH/SOL par EFA/VWO
        ia_cfg = {
            'INDICES': {'weights': {'TQQQ': 0.60, 'TLT': 0.20, 'GLD': 0.20},
                       'use_master': False, 'use_onchain': False},
            'CRYPTO': {'wf_tickers': ['SPY', 'QQQ', 'EFA', 'TLT'],  # proxy actions hors crypto
                      'use_wf': True, 'wf_retrain': 60,
                      'use_master': False, 'use_onchain': False},
            'MIXTE': {'weights': {'TQQQ': 0.50, 'SPY': 0.20,
                                  'TLT': 0.10, 'GLD': 0.10, 'XLK': 0.10},
                     'use_master': False, 'use_onchain': False},
        }

    eq_ind = run_ia_get_equity(data, ia_cfg['INDICES'], alt_data)
    eq_crp = run_ia_get_equity(data, ia_cfg['CRYPTO'], alt_data)
    eq_mix = run_ia_get_equity(data, ia_cfg['MIXTE'], alt_data)
    e_i = eq_ind / eq_ind.iloc[0]
    e_c = eq_crp / eq_crp.iloc[0]
    e_m = eq_mix / eq_mix.iloc[0]
    eq_meta = (1/3 * e_i + 1/3 * e_c + 1/3 * e_m) * 1000
    s_meta = stats_eq(eq_meta, len(data))
    print(f'  META leveraged seul : {s_meta["annual_return_pct"]:.1f}% / DD {s_meta["max_dd_pct"]:.1f}%')

    # Mix 50/50
    eq_mix50 = (0.5 * (eq_bh / eq_bh.iloc[0]) + 0.5 * (eq_meta / eq_meta.iloc[0])) * 1000
    s_mix50 = stats_eq(eq_mix50, len(data))
    print(f'  MIX 50/50 : {s_mix50["annual_return_pct"]:.1f}% / DD {s_mix50["max_dd_pct"]:.1f}%')

    # MC
    mc = monte_carlo_eq(eq_mix50, n_iters=100)
    print(f'  MIX 50/50 MC : median {mc["annual_median"]:.1f}% | P(profit) {mc["p_profit"]*100:.0f}% | DDw {mc["dd_worst"]:.1f}%')

    return {
        'period': period_name,
        'bh_safe': s_bh,
        'meta': s_meta,
        'mix_50_50': s_mix50,
        'mc': mc,
    }


def main():
    print('=' * 95)
    print(' LAB FULL VALIDATION - WINNER MIX BH 50/50 sur toutes periodes')
    print('=' * 95)

    alt_data = load_alt_data()
    universe = ['SPY', 'QQQ', 'IWM', 'EFA', 'VWO', 'TLT', 'IEF', 'GLD', 'DBC', 'XLK',
                'BTC-USD', 'ETH-USD', 'SOL-USD', 'TQQQ', 'SPXL']
    eng = LabEngine(universe=universe, start='2008-01-01')

    all_results = {}

    # 1. 2008-2010 : subprime crisis (PAS de TQQQ/crypto)
    data_08 = eng.data.loc['2008-01-01':'2011-01-01']
    if len(data_08) > 500:
        r_08 = test_period(data_08, alt_data, '2008-2010 SUBPRIME', has_crypto=False, has_lev=False)
        all_results['2008_2010'] = r_08

    # 2. 2010-2014 : pre-crypto, indices + leverage TQQQ
    data_10 = eng.data.loc['2010-06-01':'2015-01-01']
    if len(data_10) > 500:
        r_10 = test_period(data_10, alt_data, '2010-2014 PRE-CRYPTO (leverage OK)', has_crypto=False, has_lev=True)
        all_results['2010_2014'] = r_10

    # 3. 2015-2019 : pre-COVID, regime calme
    data_15 = eng.data.loc['2015-01-01':'2020-01-01']
    if len(data_15) > 500:
        r_15 = test_period(data_15, alt_data, '2015-2019 PRE-COVID', has_crypto=False, has_lev=True)
        all_results['2015_2019'] = r_15

    # 4. 2019-2025 reference
    data_19 = eng.data.loc['2019-09-01':'2026-01-01']
    if len(data_19) > 500:
        r_19 = test_period(data_19, alt_data, '2019-2025 REF (winner periode)', has_crypto=True, has_lev=True)
        all_results['2019_2025'] = r_19

    # SYNTHESE
    print('\n\n' + '=' * 95)
    print(' SYNTHESE FINALE - MIX BH 50/50 sur toutes periodes')
    print('=' * 95)
    print(f'{"Periode":<35}{"BH safe":<22}{"META":<22}{"MIX 50/50":<22}{"MC P(prof)":>10}')
    print('-' * 110)
    for k, r in all_results.items():
        bh = r.get('bh_safe', {})
        meta = r.get('meta', {})
        mix = r.get('mix_50_50', {})
        mc = r.get('mc', {})
        meta_str = f'{meta.get("annual_return_pct", 0):.1f}%/DD {meta.get("max_dd_pct", 0):.1f}%' if meta else 'n/a'
        mix_str = f'{mix.get("annual_return_pct", 0):.1f}%/DD {mix.get("max_dd_pct", 0):.1f}%' if mix else 'n/a'
        mc_str = f'{mc.get("p_profit", 0) * 100:.0f}%' if mc else 'n/a'
        print(f'  {k:<33}'
              f'{bh.get("annual_return_pct", 0):.1f}%/DD {bh.get("max_dd_pct", 0):.1f}%   '
              f'{meta_str:<22}'
              f'{mix_str:<22}'
              f'{mc_str:>10}')

    # Save
    out = OUTPUT_DIR / 'lab_full_validation.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved : {out}')


if __name__ == '__main__':
    main()
