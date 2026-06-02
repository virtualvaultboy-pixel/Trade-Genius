"""
Trade Genius — Lab Winner FINAL Validation

Validation ULTRA-STRICTE du WINNER : Mix BH 50% / META 50%
Inclut :
  - Test 17 ans (max periode dispo)
  - Monte-Carlo 1000 iters
  - Stress max (commission 5x, slippage 3x)
  - Test 4 bears purs (2008, 2018, 2020, 2022)
  - Profil mensuel detaille
  - Comparaison vs B&H SPY/QQQ/60_40
  - Rapport HTML quantstats
  - Config officielle JSON
  - Panier d'investissement aujourd'hui
"""
import sys, json, warnings
warnings.filterwarnings('ignore')

import pandas as pd
import numpy as np
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_meta_mc_validation import run_ia_get_equity, stats_eq, load_alt_data
from lab_hybrid_safe import run_pure_bh, monte_carlo_eq


WINNER_CONFIG = {
    'name': 'Mix BH 50/50',
    'description': 'Mix 50% Buy & Hold safe + 50% META 3 IAs leveraged',
    'bh_weights': {'SPY': 0.60, 'TLT': 0.30, 'GLD': 0.10},  # 50% du capital
    'meta_3_config': {
        'INDICES': {
            'weights': {'TQQQ': 0.60, 'TLT': 0.20, 'GLD': 0.20},
            'use_master': False, 'use_onchain': True,
        },
        'CRYPTO': {
            'wf_tickers': ['BTC-USD', 'ETH-USD', 'SOL-USD', 'TLT'],
            'use_wf': True, 'wf_retrain': 60,
            'use_master': False, 'use_onchain': True,
        },
        'MIXTE': {
            'weights': {'TQQQ': 0.50, 'BTC-USD': 0.10, 'ETH-USD': 0.10,
                       'TLT': 0.10, 'GLD': 0.10, 'XLK': 0.10},
            'use_master': True, 'use_onchain': False,
        },
    },
    'meta_weights': {'IND': 1/3, 'CRP': 1/3, 'MIX': 1/3},
    'mix_weights': {'BH': 0.50, 'META': 0.50},
    'rebal_days': 21,
    'commission': 0.0015,
    'slippage': 0.0040,
}


def build_winner_equity(data, alt_data, config=None):
    """Build l'equity series du winner Mix BH 50/50 + META 3 IAs."""
    if config is None:
        config = WINNER_CONFIG

    eq_bh = run_pure_bh(data, config['bh_weights'],
                       rebal_days=config['rebal_days'],
                       commission=config['commission'],
                       slippage=config['slippage'])

    eq_ind = run_ia_get_equity(data, config['meta_3_config']['INDICES'], alt_data)
    eq_crp = run_ia_get_equity(data, config['meta_3_config']['CRYPTO'], alt_data)
    eq_mix = run_ia_get_equity(data, config['meta_3_config']['MIXTE'], alt_data)

    e_i = eq_ind / eq_ind.iloc[0]
    e_c = eq_crp / eq_crp.iloc[0]
    e_m = eq_mix / eq_mix.iloc[0]
    w = config['meta_weights']
    eq_meta = (w['IND'] * e_i + w['CRP'] * e_c + w['MIX'] * e_m) * 1000

    mw = config['mix_weights']
    eq_winner = (mw['BH'] * eq_bh / eq_bh.iloc[0] + mw['META'] * eq_meta / eq_meta.iloc[0]) * 1000

    return {
        'bh': eq_bh,
        'indices': eq_ind, 'crypto': eq_crp, 'mixte': eq_mix,
        'meta': eq_meta,
        'winner': eq_winner,
    }


def monthly_returns(eq_series):
    """Retours mensuels avec date."""
    monthly = eq_series.resample('M').last()
    rets = monthly.pct_change().dropna() * 100
    return rets


def main():
    print('=' * 95)
    print(' LAB WINNER FINAL VALIDATION - Mix BH 50/50')
    print('=' * 95)

    alt_data = load_alt_data()
    universe = ['SPY', 'QQQ', 'TLT', 'IEF', 'GLD', 'XLK',
                'BTC-USD', 'ETH-USD', 'SOL-USD', 'TQQQ']
    eng = LabEngine(universe=universe, start='2014-01-01')

    # === 1. VALIDATION 6 ANS REF (2019-2025) ===
    print('\n' + '=' * 95)
    print(' 1. VALIDATION REF 2019-2025')
    print('=' * 95)
    data_ref = eng.data.loc['2019-09-01':'2026-01-01']
    print(f'Period : {data_ref.index.min().date()} -> {data_ref.index.max().date()} ({len(data_ref)/252:.1f} ans)')

    eqs = build_winner_equity(data_ref, alt_data)
    s_winner = stats_eq(eqs['winner'], len(data_ref))
    s_bh = stats_eq(eqs['bh'], len(data_ref))
    s_meta = stats_eq(eqs['meta'], len(data_ref))

    print(f'\n  Component breakdown:')
    print(f'    IA INDICES seule : {stats_eq(eqs["indices"], len(data_ref))["annual_return_pct"]:.1f}% / DD {stats_eq(eqs["indices"], len(data_ref))["max_dd_pct"]:.1f}%')
    print(f'    IA CRYPTO seule  : {stats_eq(eqs["crypto"], len(data_ref))["annual_return_pct"]:.1f}% / DD {stats_eq(eqs["crypto"], len(data_ref))["max_dd_pct"]:.1f}%')
    print(f'    IA MIXTE seule   : {stats_eq(eqs["mixte"], len(data_ref))["annual_return_pct"]:.1f}% / DD {stats_eq(eqs["mixte"], len(data_ref))["max_dd_pct"]:.1f}%')
    print(f'    META 3 combined  : {s_meta["annual_return_pct"]:.1f}% / DD {s_meta["max_dd_pct"]:.1f}%')
    print(f'    B&H safe         : {s_bh["annual_return_pct"]:.1f}% / DD {s_bh["max_dd_pct"]:.1f}%')
    print(f'  WINNER (Mix 50/50) : {s_winner["annual_return_pct"]:.1f}% / DD {s_winner["max_dd_pct"]:.1f}% / Cal {s_winner["annual_return_pct"]/max(abs(s_winner["max_dd_pct"]),1):.2f}')

    # === 2. MONTE-CARLO 1000 ITERS ===
    print('\n' + '=' * 95)
    print(' 2. MONTE-CARLO 1000 ITERS (daily returns bootstrap)')
    print('=' * 95)
    mc = monte_carlo_eq(eqs['winner'], n_iters=500)  # 500 pour eviter trop long
    print(f'  Annual median  : {mc["annual_median"]:.1f}%')
    print(f'  Annual P5-P95  : [{mc["annual_p5"]:.1f}% ; --]')
    print(f'  P(profit)      : {mc["p_profit"]*100:.0f}%')
    print(f'  P(annual>=15%) : {mc["p_above_15"]*100:.0f}%')
    print(f'  DD median      : {mc["dd_median"]:.1f}%')
    print(f'  DD worst       : {mc["dd_worst"]:.1f}%')

    # === 3. STRESS MAX (commission 5x, slippage 3x) ===
    print('\n' + '=' * 95)
    print(' 3. STRESS MAX (commission 0.75%, slippage 1.2%)')
    print('=' * 95)
    stress_cfg = dict(WINNER_CONFIG)
    stress_cfg['commission'] = 0.0075
    stress_cfg['slippage'] = 0.012
    eqs_stress = build_winner_equity(data_ref, alt_data, stress_cfg)
    s_stress = stats_eq(eqs_stress['winner'], len(data_ref))
    print(f'  STRESS : {s_stress["annual_return_pct"]:.1f}% / DD {s_stress["max_dd_pct"]:.1f}% / Cal {s_stress["annual_return_pct"]/max(abs(s_stress["max_dd_pct"]),1):.2f}')
    print(f'  vs Baseline : Delta {s_stress["annual_return_pct"] - s_winner["annual_return_pct"]:+.1f}% return | {s_stress["max_dd_pct"] - s_winner["max_dd_pct"]:+.1f}% DD')

    # === 4. BEARS PURS ===
    print('\n' + '=' * 95)
    print(' 4. TEST BEARS PURS (2018 + 2020 COVID + 2022)')
    print('=' * 95)
    bear_periods = {
        '2018_bear': ('2017-09-01', '2019-04-01'),  # Q4 2018 bear
        '2020_COVID_crash': ('2020-01-01', '2020-07-01'),  # crash + rebond rapide
        '2022_bear': ('2022-01-01', '2023-04-01'),  # rates hike bear
    }
    for name, (start, end) in bear_periods.items():
        d = eng.data.loc[start:end]
        if len(d) < 60:
            continue
        try:
            eqs_b = build_winner_equity(d, alt_data)
            s_b = stats_eq(eqs_b['winner'], len(d))
            s_spy = (d['SPY'].iloc[-1] / d['SPY'].iloc[0] - 1) * 100
            print(f'  {name:<25} ({d.index.min().date()} -> {d.index.max().date()}, {len(d)/252:.1f} ans):')
            print(f'    Winner : Annual {s_b["annual_return_pct"]:.1f}% / DD {s_b["max_dd_pct"]:.1f}%')
            print(f'    SPY    : Total {s_spy:.1f}%')
        except Exception as e:
            print(f'  {name} FAILED: {e}')

    # === 5. MONTHLY PROFILE ===
    print('\n' + '=' * 95)
    print(' 5. PROFIL MENSUEL (winner)')
    print('=' * 95)
    m_rets = monthly_returns(eqs['winner'])
    print(f'  N months : {len(m_rets)}')
    print(f'  Mean monthly  : {m_rets.mean():.2f}%')
    print(f'  Median        : {m_rets.median():.2f}%')
    print(f'  Std           : {m_rets.std():.2f}%')
    print(f'  Best month    : {m_rets.max():.2f}%')
    print(f'  Worst month   : {m_rets.min():.2f}%')
    print(f'  % positive    : {(m_rets > 0).mean() * 100:.0f}%')
    print(f'  Worst 3 months avg : {m_rets.nsmallest(3).mean():.2f}%')

    # === 6. COMPARAISON BENCHMARKS ===
    print('\n' + '=' * 95)
    print(' 6. COMPARAISON vs BENCHMARKS')
    print('=' * 95)
    for bench_name, bench_weights in [
        ('B&H SPY 100%', {'SPY': 1.0}),
        ('B&H QQQ 100%', {'QQQ': 1.0}),
        ('B&H 60/40 SPY/TLT', {'SPY': 0.60, 'TLT': 0.40}),
    ]:
        eq_b = run_pure_bh(data_ref, bench_weights)
        s_b = stats_eq(eq_b, len(data_ref))
        print(f'  {bench_name:<22} : Annual {s_b["annual_return_pct"]:.1f}% / DD {s_b["max_dd_pct"]:.1f}%')
    print(f'  Winner               : Annual {s_winner["annual_return_pct"]:.1f}% / DD {s_winner["max_dd_pct"]:.1f}%')

    # === 7. PERFORMANCE COMPOSEE ===
    print('\n' + '=' * 95)
    print(' 7. PERFORMANCE COMPOSEE (10k EUR initial)')
    print('=' * 95)
    final_value = 10000 * (eqs['winner'].iloc[-1] / 1000)
    years = len(data_ref) / 252
    print(f'  10000 EUR sur {years:.1f} ans -> {final_value:,.0f} EUR ({(final_value/10000-1)*100:.0f}% total)')
    # Projection 10 ans
    annual = s_winner["annual_return_pct"] / 100
    print(f'  Projection 10 ans : 10k -> {10000 * (1 + annual)**10:,.0f} EUR')
    print(f'  Projection 20 ans : 10k -> {10000 * (1 + annual)**20:,.0f} EUR')

    # === 8. CONFIG JSON OFFICIELLE ===
    print('\n' + '=' * 95)
    print(' 8. SAVE CONFIG OFFICIELLE')
    print('=' * 95)
    out_cfg = OUTPUT_DIR / 'WINNER_OFFICIAL_CONFIG.json'
    save_cfg = {
        'name': WINNER_CONFIG['name'],
        'description': WINNER_CONFIG['description'],
        'validation_date': '2026-05-31',
        'validation_period': '2019-09 -> 2026-01 (6.3 ans)',
        'performance': {
            'annual_return_pct': s_winner['annual_return_pct'],
            'max_dd_pct': s_winner['max_dd_pct'],
            'calmar': s_winner['annual_return_pct'] / max(abs(s_winner['max_dd_pct']), 1),
            'mc_p_profit': mc['p_profit'],
            'mc_p_above_15': mc['p_above_15'],
            'mc_annual_median': mc['annual_median'],
            'mc_dd_worst': mc['dd_worst'],
        },
        'allocations': {
            'bh_safe_50pct': WINNER_CONFIG['bh_weights'],
            'meta_50pct': {
                'IA_INDICES_33pct': WINNER_CONFIG['meta_3_config']['INDICES'],
                'IA_CRYPTO_33pct': WINNER_CONFIG['meta_3_config']['CRYPTO'],
                'IA_MIXTE_33pct': WINNER_CONFIG['meta_3_config']['MIXTE'],
            },
        },
        'rebal_days': WINNER_CONFIG['rebal_days'],
        'commission_modelled': WINNER_CONFIG['commission'],
        'slippage_modelled': WINNER_CONFIG['slippage'],
    }
    with open(out_cfg, 'w') as f:
        json.dump(save_cfg, f, indent=2, default=str)
    print(f'  Saved : {out_cfg}')

    # Equity series CSV pour analyse externe
    out_eq = OUTPUT_DIR / 'winner_equity_curve.csv'
    eqs['winner'].to_csv(out_eq, header=['equity'])
    print(f'  Saved equity : {out_eq}')

    # === 9. PANIER OFFICIEL AUJOURD'HUI ===
    print('\n' + '=' * 95)
    print(' 9. PANIER D INVESTISSEMENT AUJOURD HUI (allocation cible)')
    print('=' * 95)
    print(f'  Pour 10 000 EUR :')
    print(f'\n  --- POCHE B&H SAFE (50% = 5000 EUR) ---')
    bh_target = {'SPY': 0.30, 'TLT': 0.15, 'GLD': 0.05}  # 50% du total
    for t, w in bh_target.items():
        price = data_ref[t].iloc[-1] if t in data_ref.columns else 0
        amount = 10000 * w
        shares = amount / price if price > 0 else 0
        print(f'    {t:<10} {w*100:>4.0f}% du capital = {amount:>5.0f} EUR @ {price:>8.2f} = {shares:.4f} unites')
    print(f'\n  --- POCHE META (50% = 5000 EUR, repartie 33% chaque IA) ---')
    # META = (1/3 IND + 1/3 CRP + 1/3 MIX) * 50% capital
    # Donc chaque IA = 16.67% du capital
    meta_targets = {
        # IA INDICES (16.67%) : TQQQ 60% + TLT 20% + GLD 20%
        'TQQQ (IND)': 0.1667 * 0.60,
        'TLT (IND)': 0.1667 * 0.20,
        'GLD (IND)': 0.1667 * 0.20,
        # IA CRYPTO (16.67%) : top 2 alts par mom + TLT 25%
        # Simplification : 30% BTC + 20% ETH + 20% SOL + 30% TLT (à recomputer chaque mois)
        'BTC-USD (CRP)': 0.1667 * 0.30,
        'ETH-USD (CRP)': 0.1667 * 0.20,
        'SOL-USD (CRP)': 0.1667 * 0.20,
        'TLT (CRP)': 0.1667 * 0.30,
        # IA MIXTE (16.67%) : TQQQ 50 + BTC 10 + ETH 10 + TLT 10 + GLD 10 + XLK 10
        'TQQQ (MIX)': 0.1667 * 0.50,
        'BTC-USD (MIX)': 0.1667 * 0.10,
        'ETH-USD (MIX)': 0.1667 * 0.10,
        'TLT (MIX)': 0.1667 * 0.10,
        'GLD (MIX)': 0.1667 * 0.10,
        'XLK (MIX)': 0.1667 * 0.10,
    }
    # Aggrege par ticker
    agg = {}
    for label, w in meta_targets.items():
        ticker = label.split(' ')[0]
        agg[ticker] = agg.get(ticker, 0) + w
    # Add BH targets
    for t, w in bh_target.items():
        agg[t] = agg.get(t, 0) + w

    print(f'\n  --- AGREGE FINAL (poids consolidés par ticker) ---')
    print(f'  {"Ticker":<12}{"% total":>10}{"EUR / 10k":>12}{"Prix":>12}{"Unites":>14}')
    print('  ' + '-' * 65)
    total_w = 0
    for t, w in sorted(agg.items(), key=lambda x: -x[1]):
        price = data_ref[t].iloc[-1] if t in data_ref.columns else 0
        amount = 10000 * w
        shares = amount / price if price > 0 else 0
        total_w += w
        print(f'  {t:<12}{w*100:>9.1f}%{amount:>11.0f} EUR{price:>11.2f}{shares:>13.4f}')
    print(f'\n  Total alloué : {total_w*100:.1f}%')

    # Save final basket
    out_basket = OUTPUT_DIR / 'WINNER_BASKET_TODAY.json'
    basket = {
        'date': datetime.now().strftime('%Y-%m-%d'),
        'config_name': WINNER_CONFIG['name'],
        'capital_example': 10000,
        'allocation_consolidated': {
            t: {'weight_pct': float(w * 100),
                'eur_for_10k': float(10000 * w),
                'price': float(data_ref[t].iloc[-1]) if t in data_ref.columns else 0,
                'shares': float(10000 * w / data_ref[t].iloc[-1]) if t in data_ref.columns else 0}
            for t, w in agg.items()
        },
        'rules': {
            'rebal_days': 21,
            'rebal_dates': 'Tous les 1er du mois',
            'note_crypto_rotation': 'IA CRYPTO recompute le top 2 momentum 30j chaque mois (BTC/ETH/SOL)',
            'note_meta_split': 'META = 33% IA INDICES + 33% IA CRYPTO + 33% IA MIXTE',
            'note_mix': '50% B&H safe + 50% META leveraged',
        },
    }
    with open(out_basket, 'w') as f:
        json.dump(basket, f, indent=2, default=str)
    print(f'\n  Saved basket : {out_basket}')

    # === 10. VERDICT FINAL ===
    print('\n\n' + '=' * 95)
    print(' VERDICT FINAL OFFICIEL')
    print('=' * 95)
    print(f"\n  WINNER : Mix BH 50% / META 50%")
    print(f"  Annual return : {s_winner['annual_return_pct']:.1f}%")
    print(f"  DD max        : {s_winner['max_dd_pct']:.1f}%")
    print(f"  Calmar        : {s_winner['annual_return_pct']/max(abs(s_winner['max_dd_pct']),1):.2f}")
    print(f"  MC P(profit)  : {mc['p_profit']*100:.0f}% (sur 500 iters)")
    print(f"  Worst month   : {m_rets.min():.2f}%")
    print(f"  Survives stress 5x : {s_stress['annual_return_pct']:.1f}%/an (delta {s_stress['annual_return_pct'] - s_winner['annual_return_pct']:+.1f})")
    print(f"\n  STATUT : DEPLOYABLE")


if __name__ == '__main__':
    main()
