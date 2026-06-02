"""
Trade Genius — Lab Take Profit Test

Tester differents mecanismes de prise de benefices :

  1. Baseline : rebalance mensuel cible 50/50 (current)
  2. TP threshold : si mois > +10%, deplacer 25% META vers BH (sécuriser)
  3. TP threshold +15% : seuil plus eleve
  4. TP threshold +5% : seuil plus bas (plus actif)
  5. Trailing peak : si DD < 5% depuis peak, lock 30% gains
  6. Scaling out : 1/3 vendu a +10%, +20%, +30% cumul depuis last peak
  7. Mois positif streak : apres 3 mois positifs consec, secure 20%

Question : prise de benefices = mieux ou pire que rebalance simple ?
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


def apply_take_profit(eq_meta, eq_bh, mode='baseline', tp_threshold=10,
                       initial=1000, rebal_days=21):
    """
    Combine META + BH avec un mecanisme de take profit.
    Different modes : baseline / tp_threshold / trailing_peak / scaling / streak

    Retourne la serie equity finale (eq simulee).
    """
    # Returns daily de chaque component
    rets_meta = eq_meta.pct_change().fillna(0)
    rets_bh = eq_bh.pct_change().fillna(0)
    n = len(rets_meta)

    capital = initial
    weight_meta = 0.50
    weight_bh = 0.50
    peak = initial
    pos_streak = 0
    eq_series = pd.Series(initial, index=eq_meta.index, dtype=float)
    last_month_eq = initial
    tp_locked = 0  # cumulated TP locked

    for i in range(n):
        # Daily PnL
        meta_pnl = weight_meta * rets_meta.iloc[i]
        bh_pnl = weight_bh * rets_bh.iloc[i]
        capital *= (1 + meta_pnl + bh_pnl)
        eq_series.iloc[i] = capital
        if capital > peak:
            peak = capital

        # Monthly rebalance (every 21 days)
        if i > 0 and i % rebal_days == 0:
            # Compute monthly return
            month_ret = (capital / last_month_eq - 1) * 100

            if mode == 'baseline':
                # Standard rebalance to 50/50
                weight_meta = 0.50
                weight_bh = 0.50

            elif mode == 'tp_threshold':
                if month_ret > tp_threshold:
                    # Move 25% of META to BH
                    weight_meta = 0.50 * 0.75  # 37.5%
                    weight_bh = 0.50 + 0.50 * 0.25  # 62.5%
                else:
                    weight_meta = 0.50
                    weight_bh = 0.50

            elif mode == 'trailing_peak':
                # Si on est a 95% du peak ou plus, lock 30% gains
                dd_from_peak = (capital - peak) / peak
                if dd_from_peak > -0.05 and capital > initial * 1.30:
                    # Lock 30% of gains over initial in BH
                    excess = (capital - initial) / capital
                    tp_extra = excess * 0.30
                    weight_meta = 0.50 - tp_extra * 0.5
                    weight_bh = 0.50 + tp_extra * 0.5
                else:
                    weight_meta = 0.50
                    weight_bh = 0.50

            elif mode == 'scaling':
                # Si capital > 110%, 120%, 130% du initial : reduce META expo
                ratio = capital / initial
                if ratio > 1.30:
                    weight_meta = 0.30
                    weight_bh = 0.70
                elif ratio > 1.20:
                    weight_meta = 0.38
                    weight_bh = 0.62
                elif ratio > 1.10:
                    weight_meta = 0.44
                    weight_bh = 0.56
                else:
                    weight_meta = 0.50
                    weight_bh = 0.50

            elif mode == 'streak':
                # Apres 3 mois positifs consec, secure 20%
                if month_ret > 0:
                    pos_streak += 1
                else:
                    pos_streak = 0
                if pos_streak >= 3:
                    weight_meta = 0.40
                    weight_bh = 0.60
                    pos_streak = 0  # reset
                else:
                    weight_meta = 0.50
                    weight_bh = 0.50

            last_month_eq = capital

    return eq_series


def main():
    print('=' * 95)
    print(' LAB TAKE PROFIT - tester mecanismes de prise de benefices')
    print('=' * 95)

    alt_data = load_alt_data()
    universe = ['SPY', 'QQQ', 'TLT', 'IEF', 'GLD', 'XLK',
                'BTC-USD', 'ETH-USD', 'SOL-USD', 'TQQQ']
    eng = LabEngine(universe=universe, start='2014-01-01')
    data = eng.data.loc['2019-09-01':'2026-01-01']
    print(f'Period : {data.index.min().date()} -> {data.index.max().date()}')

    # Build META 3 + BH safe (composants)
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
    eq_meta = ((eq_ind / eq_ind.iloc[0] + eq_crp / eq_crp.iloc[0] + eq_mix / eq_mix.iloc[0]) / 3) * 1000
    eq_bh = run_pure_bh(data, {'SPY': 0.60, 'TLT': 0.30, 'GLD': 0.10})

    variants = [
        ('Baseline (rebal 50/50 simple)', 'baseline', 10),
        ('TP threshold +5% / mois', 'tp_threshold', 5),
        ('TP threshold +10% / mois', 'tp_threshold', 10),
        ('TP threshold +15% / mois', 'tp_threshold', 15),
        ('Trailing peak (lock 30% au peak)', 'trailing_peak', 0),
        ('Scaling out (110/120/130%)', 'scaling', 0),
        ('Streak 3 mois +', 'streak', 0),
    ]

    print(f'\n{"Variant":<45}{"Annual":>9}{"DD":>9}{"WorstM":>9}{"BestM":>9}{"PosM%":>8}{"Calmar":>9}')
    print('-' * 100)

    all_results = {}
    for name, mode, threshold in variants:
        try:
            eq = apply_take_profit(eq_meta, eq_bh, mode=mode, tp_threshold=threshold)
            s = stats_eq(eq, len(data))
            monthly = eq.resample('M').last().pct_change().dropna() * 100
            best_m = monthly.max()
            worst_m = monthly.min()
            pos_pct = (monthly > 0).mean() * 100
            cal = s['annual_return_pct'] / max(abs(s['max_dd_pct']), 1)
            print(f'  {name:<43}{s["annual_return_pct"]:>7.1f}%{s["max_dd_pct"]:>8.1f}%'
                  f'{worst_m:>8.1f}%{best_m:>8.1f}%{pos_pct:>7.0f}%{cal:>8.2f}')
            all_results[name] = {
                'annual_return_pct': s['annual_return_pct'],
                'max_dd_pct': s['max_dd_pct'],
                'best_month': float(best_m),
                'worst_month': float(worst_m),
                'pos_months_pct': float(pos_pct),
                'calmar': cal,
            }
        except Exception as e:
            print(f'  {name:<43} FAILED: {e}')
            import traceback; traceback.print_exc()

    out = OUTPUT_DIR / 'lab_take_profit.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved : {out}')

    # Verdict
    print('\n\n' + '=' * 95)
    print(' VERDICT TAKE PROFIT')
    print('=' * 95)
    baseline = all_results.get('Baseline (rebal 50/50 simple)', {})
    base_ann = baseline.get('annual_return_pct', 0)
    base_dd = baseline.get('max_dd_pct', 0)
    base_cal = baseline.get('calmar', 0)
    print(f'\n  Baseline : {base_ann:.1f}%/an / DD {base_dd:.1f}% / Cal {base_cal:.2f}')
    print(f'\n  {"Variant":<45}{"DeltaAnn":<12}{"DeltaDD":<12}{"DeltaCal":<12}{"Mieux ?":<10}')
    for name, r in all_results.items():
        if 'Baseline' in name:
            continue
        d_ann = r['annual_return_pct'] - base_ann
        d_dd = r['max_dd_pct'] - base_dd
        d_cal = r['calmar'] - base_cal
        verdict = 'OUI' if d_cal > 0.02 else ('NEUTRE' if abs(d_cal) <= 0.02 else 'PIRE')
        print(f'  {name:<45} {d_ann:+5.1f}%       {d_dd:+5.1f}%        {d_cal:+0.2f}        {verdict}')


if __name__ == '__main__':
    main()
