"""
Trade Genius — Lab Exotic Test

Tester si les nouveaux signaux exotiques apportent de la valeur :
  1. HY Spread (BAMLH0A0HYM2) : > 5% = stress credit = reduce expo
  2. Google Trends bitcoin : extreme = retail euphoria = reduce
  3. USD Index strong : > 110 = anti-crypto/risk-on

Sur winner Mix BH 50/50.
"""
import sys, json, warnings
warnings.filterwarnings('ignore')

import pandas as pd
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_polished_winner import load_alt_data, compute_master_signal
from lab_onchain_signals import compute_onchain_signal
from lab_meta_mc_validation import run_ia_get_equity, stats_eq
from lab_hybrid_safe import run_pure_bh, monte_carlo_eq


def compute_exotic_signal(date_index, alt_data, use_hy=True, use_gt=True, use_usd=True):
    """Signal exotique combiné [0.5 - 1.2]."""
    sig = pd.Series(1.0, index=date_index)

    # HY spread (>5% = stress credit, >7% = panique)
    if use_hy and 'fred_BAMLH0A0HYM2' in alt_data:
        hy = alt_data['fred_BAMLH0A0HYM2']['BAMLH0A0HYM2'].reindex(date_index, method='ffill')
        adj = pd.Series(1.0, index=date_index)
        adj[hy > 5] = 0.85
        adj[hy > 7] = 0.65
        adj[hy > 10] = 0.40  # GFC-level
        adj[hy < 3.5] = 1.05  # credit healthy
        sig = sig * adj

    # Google Trends bitcoin (>=90 = euphoria retail = bearish)
    if use_gt and 'google_trends_btc' in alt_data:
        gt = alt_data['google_trends_btc']['bitcoin'].reindex(date_index, method='ffill')
        adj = pd.Series(1.0, index=date_index)
        adj[gt > 70] = 0.85  # forte attention
        adj[gt > 90] = 0.65  # euphoria
        adj[gt < 20] = 1.1   # capitulation attention
        sig = sig * adj

    # USD Index strong
    if use_usd and 'fred_DTWEXBGS' in alt_data:
        usd = alt_data['fred_DTWEXBGS']['DTWEXBGS'].reindex(date_index, method='ffill')
        usd_sma = usd.rolling(60).mean()
        adj = pd.Series(1.0, index=date_index)
        adj[usd > usd_sma * 1.05] = 0.9  # USD strong = risk-off
        adj[usd > usd_sma * 1.10] = 0.75
        sig = sig * adj

    return sig.clip(0.4, 1.2)


def run_winner_with_exotic(data, alt_data, use_hy=False, use_gt=False, use_usd=False, name=''):
    """Run Mix BH 50/50 + optionnel exotic signals overlay."""
    # B&H safe
    eq_bh = run_pure_bh(data, {'SPY': 0.60, 'TLT': 0.30, 'GLD': 0.10})

    # META leveraged
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

    e_i = eq_ind / eq_ind.iloc[0]
    e_c = eq_crp / eq_crp.iloc[0]
    e_m = eq_mix / eq_mix.iloc[0]
    eq_meta = (1/3 * e_i + 1/3 * e_c + 1/3 * e_m) * 1000

    # Mix 50/50
    eq_mix50 = (0.5 * (eq_bh / eq_bh.iloc[0]) + 0.5 * (eq_meta / eq_meta.iloc[0])) * 1000

    # Apply exotic overlay : reduce equity en fonction du signal
    if use_hy or use_gt or use_usd:
        exotic_sig = compute_exotic_signal(data.index, alt_data, use_hy, use_gt, use_usd)
        # On applique le signal aux returns daily
        rets = eq_mix50.pct_change().dropna()
        # Scale les returns par le signal precedent (lag 1 pour eviter look-ahead)
        sig_shifted = exotic_sig.shift(1).reindex(rets.index, method='ffill').fillna(1.0)
        # Reduce position size = reduce returns proportionnellement
        # MAIS le reste va en cash (qui rend 0)
        new_rets = sig_shifted * rets  # ex: si signal 0.7, on a 70% expo, donc 70% du return
        new_eq = (1 + new_rets).cumprod() * 1000
        new_eq = pd.concat([pd.Series([1000.0], index=[data.index[0]]), new_eq]).iloc[:len(data)]
        new_eq.index = data.index[:len(new_eq)]
        eq_mix50 = new_eq

    return eq_mix50


def main():
    print('=' * 95)
    print(' LAB EXOTIC TEST - signaux nouveaux sur winner Mix BH 50/50')
    print('=' * 95)

    alt_data = load_alt_data()
    universe = ['SPY', 'QQQ', 'TLT', 'IEF', 'GLD', 'XLK', 'BTC-USD', 'ETH-USD', 'SOL-USD', 'TQQQ']
    eng = LabEngine(universe=universe, start='2014-01-01')
    data = eng.data.loc['2019-09-01':'2026-01-01']
    print(f'Period : {data.index.min().date()} -> {data.index.max().date()}')

    variants = [
        ('BASELINE Mix 50/50 (current winner)', False, False, False),
        ('+ HY Spread overlay', True, False, False),
        ('+ Google Trends overlay', False, True, False),
        ('+ USD Index overlay', False, False, True),
        ('+ HY + GT', True, True, False),
        ('+ HY + GT + USD (all 3 exotic)', True, True, True),
    ]

    print(f'\n{"Variant":<55}{"Annual":>9}{"DD":>9}{"WorstM":>9}{"Calmar":>9}{"MC P(prof)":>12}')
    print('-' * 110)

    all_results = {}
    for name, hy, gt, usd in variants:
        try:
            eq = run_winner_with_exotic(data, alt_data, hy, gt, usd, name)
            s = stats_eq(eq, len(data))
            mc = monte_carlo_eq(eq, n_iters=100)
            print(f'{name[:54]:<55}{s["annual_return_pct"]:>8.1f}%{s["max_dd_pct"]:>8.1f}%{s.get("worst_monthly", 0):>8.1f}%'
                  f'{s["annual_return_pct"]/max(abs(s["max_dd_pct"]),1):>8.2f}{mc["p_profit"]*100:>11.0f}%')
            all_results[name] = {'baseline': s, 'mc': mc}
        except Exception as e:
            print(f'{name[:54]:<55} FAILED: {e}')
            import traceback; traceback.print_exc()

    out = OUTPUT_DIR / 'lab_exotic_test.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved : {out}')

    # VERDICT
    print('\n\n' + '=' * 95)
    print(' VERDICT : les exotic signals ajoutent-ils de la valeur ?')
    print('=' * 95)
    baseline = all_results.get('BASELINE Mix 50/50 (current winner)', {}).get('baseline', {})
    base_ann = baseline.get('annual_return_pct', 0)
    base_dd = baseline.get('max_dd_pct', 0)
    base_cal = base_ann / max(abs(base_dd), 1)
    print(f'  Baseline       : {base_ann:.1f}% / DD {base_dd:.1f}% / Cal {base_cal:.2f}')
    print(f'  {"":<5}{"Variant":<35}{"DeltaAnn":<12}{"DeltaDD":<12}{"DeltaCal":<12}')
    for name, r in all_results.items():
        if 'BASELINE' in name:
            continue
        s = r['baseline']
        cal = s['annual_return_pct'] / max(abs(s['max_dd_pct']), 1)
        d_ann = s['annual_return_pct'] - base_ann
        d_dd = s['max_dd_pct'] - base_dd
        d_cal = cal - base_cal
        marker = '+' if d_cal > 0.02 else ('-' if d_cal < -0.02 else '~')
        print(f'  {marker} {name.replace("+ ", ""):<32}  {d_ann:+5.1f}%  {d_dd:+5.1f} pts  {d_cal:+0.2f}')


if __name__ == '__main__':
    main()
