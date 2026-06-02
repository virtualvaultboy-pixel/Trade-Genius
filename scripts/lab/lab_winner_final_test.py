"""
Trade Genius — Lab Winner Final Test

Crash-test ULTIME du candidat TQQQ 30 + TLT 40 + GLD 10 + BTC 20.
Si tout passe : winner officiel a 20%+/an honnête.
"""
import sys, json, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_manual_rebalance import run_rebalance


WINNER = {'TQQQ': 0.30, 'TLT': 0.40, 'GLD': 0.10, 'BTC-USD': 0.20}


def annualize(total_pct, n_days):
    n_years = n_days / 252
    if n_years <= 0:
        return 0
    return ((1 + total_pct / 100) ** (1 / n_years) - 1) * 100


def main():
    print('=' * 90)
    print(' WINNER FINAL TEST : TQQQ 30 + TLT 40 + GLD 10 + BTC 20')
    print('=' * 90)

    eng = LabEngine(universe=list(WINNER.keys()), start='2010-01-01')
    print(f'\nData : {eng.data.shape}')

    score = 0
    max_score = 0
    failures = []
    results = {}

    # === TEST 1 : Reproduction baseline 2012-2025 ===
    print('\n--- TEST 1 : Baseline 2012-2025 (reproduction) ---')
    data = eng.data.loc['2012-01-01':'2026-01-01']
    r = run_rebalance(data, WINNER, rebal_days=21)
    print(f'  Annualized : {r["annual_return_pct"]:.1f}%/an | DD : {r["max_dd_pct"]:.1f}%')
    results['baseline'] = r
    max_score += 1
    if r['annual_return_pct'] >= 20:
        score += 1
        print(f'  [OK] >= 20%/an confirme')
    else:
        failures.append(f'Baseline {r["annual_return_pct"]:.1f}% < 20%')

    # === TEST 2 : SANS 2020-2021 (mega-pump COVID + crypto) ===
    print('\n--- TEST 2 : SANS 2020-2021 (mega-pump exclus) ---')
    data_no20_21 = pd.concat([
        eng.data.loc['2012-01-01':'2019-12-31'],
        eng.data.loc['2022-01-01':'2026-01-01'],
    ])
    r = run_rebalance(data_no20_21, WINNER, rebal_days=21)
    print(f'  Annualized SANS 2020-2021 : {r["annual_return_pct"]:.1f}%/an | DD : {r["max_dd_pct"]:.1f}%')
    results['no_2020_2021'] = r
    max_score += 1
    if r['annual_return_pct'] >= 15:
        score += 1
        print(f'  [OK] >= 15%/an sans mega-pump (alpha solide)')
    else:
        failures.append(f'Sans 2020-2021 {r["annual_return_pct"]:.1f}% < 15%')

    # === TEST 3 : POST-COVID 2022-2025 ===
    print('\n--- TEST 3 : POST-COVID 2022-2025 (regime recent) ---')
    data_recent = eng.data.loc['2022-01-01':'2026-01-01']
    r = run_rebalance(data_recent, WINNER, rebal_days=21)
    print(f'  Annualized 2022-2025 : {r["annual_return_pct"]:.1f}%/an | DD : {r["max_dd_pct"]:.1f}%')
    results['post_covid'] = r
    max_score += 1
    if r['annual_return_pct'] >= 10:
        score += 1
        print(f'  [OK] Tient sur regime recent')
    else:
        failures.append(f'Post-COVID {r["annual_return_pct"]:.1f}% < 10%')

    # === TEST 4 : FRAIS 3x ===
    print('\n--- TEST 4 : FRAIS 3x ---')
    r = run_rebalance(data, WINNER, rebal_days=21,
                      commission_per_trade=0.0045, slippage=0.012)
    print(f'  Annualized frais 3x : {r["annual_return_pct"]:.1f}%/an')
    results['frais_3x'] = r
    max_score += 1
    if r['annual_return_pct'] >= 15:
        score += 1
        print(f'  [OK] Tient les frais 3x')
    else:
        failures.append(f'Frais 3x {r["annual_return_pct"]:.1f}% < 15%')

    # === TEST 5 : MONTE-CARLO BLOCKS ===
    print('\n--- TEST 5 : MONTE-CARLO BLOCKS (100 iters, blocs 60j) ---')
    n_iters = 100
    block_len = 60
    rng = np.random.default_rng(42)
    mc_rets = []
    n_dates = len(data)
    for i in range(n_iters):
        n_blocks_total = n_dates // block_len
        block_starts = rng.integers(0, n_dates - block_len, size=n_blocks_total)
        new_idx = np.concatenate([np.arange(s, s + block_len) for s in block_starts])
        new_idx = new_idx[:n_dates]
        shuffled = data.iloc[new_idx].reset_index(drop=True)
        shuffled.index = data.index[:len(shuffled)]
        r = run_rebalance(shuffled, WINNER, rebal_days=21)
        mc_rets.append(r['annual_return_pct'])
    median = float(np.median(mc_rets))
    p5 = float(np.percentile(mc_rets, 5))
    p_profit = float((np.array(mc_rets) > 0).mean())
    p_above_15 = float((np.array(mc_rets) >= 15).mean())
    p_above_20 = float((np.array(mc_rets) >= 20).mean())
    results['monte_carlo'] = {
        'median': median, 'p5': p5, 'p_profit': p_profit,
        'p_above_15': p_above_15, 'p_above_20': p_above_20,
    }
    print(f'  Median annual : {median:.1f}%')
    print(f'  P5 annual : {p5:.1f}%')
    print(f'  P(profit) : {p_profit * 100:.0f}%')
    print(f'  P(annual >= 15%) : {p_above_15 * 100:.0f}%')
    print(f'  P(annual >= 20%) : {p_above_20 * 100:.0f}%')
    max_score += 1
    if p_profit >= 0.85:
        score += 1
        print(f'  [OK] P(profit) >= 85% (robuste a l ordre)')
    else:
        failures.append(f'MC P(profit) {p_profit * 100:.0f}% < 85%')

    # === TEST 6 : 2 PERIODES DECENNALES (cohérence) ===
    print('\n--- TEST 6 : 2012-2018 vs 2019-2025 (cohérence) ---')
    data_a = eng.data.loc['2012-01-01':'2019-01-01']
    data_b = eng.data.loc['2019-01-01':'2026-01-01']
    r_a = run_rebalance(data_a, WINNER, rebal_days=21)
    r_b = run_rebalance(data_b, WINNER, rebal_days=21)
    print(f'  2012-2018 : {r_a["annual_return_pct"]:.1f}%/an | DD {r_a["max_dd_pct"]:.1f}%')
    print(f'  2019-2025 : {r_b["annual_return_pct"]:.1f}%/an | DD {r_b["max_dd_pct"]:.1f}%')
    results['decade_a'] = r_a
    results['decade_b'] = r_b
    max_score += 1
    if r_a['annual_return_pct'] >= 15 and r_b['annual_return_pct'] >= 15:
        score += 1
        print(f'  [OK] Coherent sur les 2 decennies')
    else:
        failures.append(f'Decade A {r_a["annual_return_pct"]:.1f}% / Decade B {r_b["annual_return_pct"]:.1f}%')

    # === TEST 7 : SIMULATION USER REEL ===
    print('\n--- TEST 7 : SIMULATION USER REEL 10keur, frais Trade Republic ---')
    r = run_rebalance(data, WINNER, rebal_days=21,
                      commission_per_trade=0.0010,  # 0.10% commission TR
                      slippage=0.0020,  # slip realiste mid-cap ETF
                      initial=10000)
    print(f'  10000eur -> {r["final_value"]:.0f}eur en {r["n_years"]:.1f} ans')
    print(f'  Annualized : {r["annual_return_pct"]:.1f}%/an | DD : {r["max_dd_pct"]:.1f}%')
    results['user_real'] = r
    max_score += 1
    if r['annual_return_pct'] >= 18:
        score += 1
        print(f'  [OK] User reel >= 18%/an net frais')
    else:
        failures.append(f'User reel {r["annual_return_pct"]:.1f}% < 18%')

    # === VERDICT FINAL ===
    print('\n\n' + '=' * 90)
    print(' VERDICT FINAL : TQQQ 30 + TLT 40 + GLD 10 + BTC 20')
    print('=' * 90)
    print(f'\n  SCORE : {score}/{max_score}')
    if score == max_score:
        verdict = 'WINNER VALIDE - DEPLOYABLE'
    elif score >= max_score * 0.75:
        verdict = 'CANDIDAT FORT - usage prudent'
    elif score >= max_score * 0.5:
        verdict = 'OK avec disclaimer drawdown'
    else:
        verdict = 'FRAGILE - ne pas deployer'
    print(f'  VERDICT : {verdict}')

    if failures:
        print(f'\n  ECHECS :')
        for f in failures:
            print(f'    - {f}')

    out = OUTPUT_DIR / 'lab_winner_final.json'
    with open(out, 'w') as f:
        json.dump({
            'config': WINNER, 'score': score, 'max_score': max_score,
            'verdict': verdict, 'failures': failures, 'results': results,
        }, f, indent=2, default=str)
    print(f'\nSaved : {out}')


if __name__ == '__main__':
    main()
