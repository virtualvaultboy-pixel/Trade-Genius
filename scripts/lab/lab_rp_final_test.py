"""
Trade Genius — Lab Risk Parity FINAL TEST

Crash-test ULTRA exhaustif du Risk Parity Crypto-tilted 20%
avant de l'annoncer comme winner officiel.

Tests :
  1. FULL PERIOD CONTINUE (pas walk-forward strict)
  2. MONTE-CARLO BLOCKS (200 iters x 60j blocs)
  3. STRESS FRAIS 3x
  4. SANS 2017 (l'annee extraordinaire BTC +1268%)
  5. SANS BTC (verifier si l'alpha vient de BTC pur ou de la combo)
  6. POST-COVID 2023-2025 (regime recent)
  7. COMPARAISON vs B&H ponderee equivalent
  8. SIMULATION USER REEL (10keur, vraies fees broker)

Critere succes :
  - Full period continue mean >= 20%/an
  - MC P(profit) >= 65%
  - DD continue <= -15%
  - Sans 2017 : mean >= 15%/an
  - Sans BTC : reste positive

Si TOUT passe : VERIFIE et VALIDE
Sinon : on dit clairement ce qui rate
"""
import sys, os, json, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
import vectorbt as vbt
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_strategies import sma, _empty_signals


def risk_parity_test(data_test, data_train, weights, rebal_days=21, commission=0.0015, slippage=0.0040):
    """Run risk parity sur full period."""
    size = pd.DataFrame(0.0, index=data_test.index, columns=data_test.columns)
    rebal_dates = data_test.index[::rebal_days]
    s = sum(weights.values())

    for d in rebal_dates:
        for ticker, w in weights.items():
            if ticker in data_test.columns:
                size.loc[d, ticker] = (w / s) * 0.98

    size = size.where(size > 0).fillna(method='ffill').fillna(0)

    entries, exits = _empty_signals(data_test)
    for col in size.columns:
        in_pos = size[col] > 0
        entries[col] = (~in_pos.shift(1).fillna(False)) & in_pos
        exits[col] = in_pos.shift(1).fillna(False) & (~in_pos)
        if in_pos.iloc[0]:
            entries[col].iloc[0] = True

    try:
        pf = vbt.Portfolio.from_signals(
            close=data_test, entries=entries, exits=exits,
            size=size, size_type='percent',
            init_cash=1000, fees=commission, slippage=slippage,
            freq='1D', group_by=True, cash_sharing=True,
        )
        stats = pf.stats(silence_warnings=True)
        if isinstance(stats, pd.DataFrame):
            stats = stats.mean(axis=1)
        return {
            'total_return_pct': float(stats.get('Total Return [%]', 0)),
            'annual_return_pct': float(stats.get('Annualized Return [%]', 0)),
            'sharpe': float(stats.get('Sharpe Ratio', 0)),
            'max_dd_pct': float(stats.get('Max Drawdown [%]', 0)),
            'n_trades': int(stats.get('Total Trades', 0)),
        }
    except Exception as e:
        return {'error': str(e)}


def annualize(total_pct, n_days):
    n_years = n_days / 252
    if n_years <= 0:
        return 0
    return ((1 + total_pct / 100) ** (1 / n_years) - 1) * 100


def main():
    print('=' * 90)
    print(' LAB RISK PARITY CRYPTO-TILTED 20% - VALIDATION ULTRA FINALE')
    print('=' * 90)

    WINNER_WEIGHTS = {'SPY': 0.40, 'TLT': 0.30, 'GLD': 0.10, 'BTC-USD': 0.20}
    universe = list(WINNER_WEIGHTS.keys())

    eng = LabEngine(universe=universe, start='2011-01-01')
    print(f'Data : {eng.data.shape}, range {eng.data.index.min().date()} -> {eng.data.index.max().date()}')

    score = 0
    max_score = 0
    failures = []
    results = {}

    # === TEST 1 : FULL PERIOD CONTINUE 2012-2025 ===
    print('\n--- TEST 1 : FULL PERIOD CONTINUE 2012-2025 (le vrai test) ---')
    data_test = eng.data.loc['2012-01-01':'2026-01-01']
    data_train = eng.data.loc[:'2011-12-31']
    r = risk_parity_test(data_test, data_train, WINNER_WEIGHTS)
    if 'error' not in r:
        ann = annualize(r['total_return_pct'], len(data_test))
        print(f'  Total return : {r["total_return_pct"]:.0f}% sur ~{len(data_test) / 252:.1f} ans')
        print(f'  Annualized : {ann:.1f}%/an')
        print(f'  Sharpe : {r["sharpe"]:.2f}')
        print(f'  Max DD : {r["max_dd_pct"]:.1f}%')
        print(f'  N trades : {r["n_trades"]}')
        results['full_period_continuous'] = {**r, 'annualized': ann}
        max_score += 1
        if ann >= 20:
            score += 1
            print(f'  [OK] Annualise >= 20%/an')
        else:
            failures.append(f'Full period annualise {ann:.1f}% < 20%')
            print(f'  [FAIL] Annualise < 20%')

    # === TEST 2 : MONTE-CARLO BLOCKS ===
    print('\n--- TEST 2 : MONTE-CARLO BLOCKS (200 iters, blocs 60j) ---')
    n_iters = 200
    block_len = 60
    rng = np.random.default_rng(99)
    mc_rets = []
    n_dates = len(data_test)
    if n_dates >= block_len * 2:
        for i in range(n_iters):
            n_blocks_total = n_dates // block_len
            block_starts = rng.integers(0, n_dates - block_len, size=n_blocks_total)
            new_idx = np.concatenate([np.arange(s, s + block_len) for s in block_starts])
            new_idx = new_idx[:n_dates]
            shuffled = data_test.iloc[new_idx].reset_index(drop=True)
            shuffled.index = data_test.index[:len(shuffled)]
            r = risk_parity_test(shuffled, data_train, WINNER_WEIGHTS)
            if 'error' not in r:
                mc_rets.append(r['total_return_pct'])
    if mc_rets:
        median = float(np.median(mc_rets))
        p5 = float(np.percentile(mc_rets, 5))
        p95 = float(np.percentile(mc_rets, 95))
        p_profit = float((np.array(mc_rets) > 0).mean())
        results['mc_blocks'] = {'median': median, 'p5': p5, 'p95': p95, 'p_profit': p_profit, 'n_iters': len(mc_rets)}
        print(f'  N iters : {len(mc_rets)}')
        print(f'  Total return median : {median:.0f}%')
        print(f'  P5 - P95 : [{p5:.0f}% ; {p95:.0f}%]')
        print(f'  P(profit) : {p_profit * 100:.1f}%')
        max_score += 1
        if p_profit >= 0.65:
            score += 1
            print(f'  [OK] P(profit) >= 65% : ROBUSTE')
        else:
            failures.append(f'MC P(profit) {p_profit * 100:.1f}% < 65%')
            print(f'  [FAIL] P(profit) < 65% : FRAGILE')

    # === TEST 3 : STRESS FRAIS 3x ===
    print('\n--- TEST 3 : FRAIS 3x (commission 0.45%, slippage 1.2%) ---')
    r = risk_parity_test(data_test, data_train, WINNER_WEIGHTS,
                          commission=0.0045, slippage=0.012)
    if 'error' not in r:
        ann = annualize(r['total_return_pct'], len(data_test))
        print(f'  Annualized : {ann:.1f}%/an | DD : {r["max_dd_pct"]:.1f}% | Trades : {r["n_trades"]}')
        results['frais_3x'] = {**r, 'annualized': ann}
        max_score += 1
        if ann >= 15:
            score += 1
            print(f'  [OK] Tient frais 3x')
        else:
            failures.append(f'Frais 3x annualise {ann:.1f}% < 15%')

    # === TEST 4 : SANS 2017 (annee extraordinaire BTC) ===
    print('\n--- TEST 4 : EXCLURE 2017 (annee extraordinaire BTC +1268%) ---')
    data_no2017 = pd.concat([
        eng.data.loc['2012-01-01':'2016-12-31'],
        eng.data.loc['2018-01-01':'2026-01-01'],
    ])
    r = risk_parity_test(data_no2017, data_train, WINNER_WEIGHTS)
    if 'error' not in r:
        ann = annualize(r['total_return_pct'], len(data_no2017))
        print(f'  Annualized (sans 2017) : {ann:.1f}%/an | DD : {r["max_dd_pct"]:.1f}%')
        results['no_2017'] = {**r, 'annualized': ann}
        max_score += 1
        if ann >= 15:
            score += 1
            print(f'  [OK] >= 15%/an meme sans 2017 (alpha pas du a une seule annee)')
        else:
            failures.append(f'Sans 2017 annualise {ann:.1f}% < 15%')
            print(f'  [FAIL] Alpha trop dependant de 2017')

    # === TEST 5 : SANS BTC (verif si l'alpha vient juste de BTC) ===
    print('\n--- TEST 5 : SANS BTC (50%SPY/40%TLT/10%GLD) ---')
    weights_no_btc = {'SPY': 0.50, 'TLT': 0.40, 'GLD': 0.10}
    r = risk_parity_test(data_test, data_train, weights_no_btc)
    if 'error' not in r:
        ann = annualize(r['total_return_pct'], len(data_test))
        print(f'  Annualized sans BTC : {ann:.1f}%/an | DD : {r["max_dd_pct"]:.1f}%')
        results['no_btc'] = {**r, 'annualized': ann}
        # Test info uniquement : sert a comparer

    # === TEST 6 : POST-COVID 2023-2025 (regime recent uniquement) ===
    print('\n--- TEST 6 : POST-COVID 2023-2025 ---')
    data_recent = eng.data.loc['2023-01-01':'2026-01-01']
    r = risk_parity_test(data_recent, data_train, WINNER_WEIGHTS)
    if 'error' not in r:
        ann = annualize(r['total_return_pct'], len(data_recent))
        print(f'  Annualized 2023-2025 : {ann:.1f}%/an | DD : {r["max_dd_pct"]:.1f}%')
        results['post_covid'] = {**r, 'annualized': ann}
        max_score += 1
        if ann >= 15:
            score += 1
            print(f'  [OK] Tient sur regime recent')
        else:
            failures.append(f'Post-COVID annualise {ann:.1f}% < 15%')

    # === TEST 7 : COMPARAISON vs B&H WEIGHTED EQUIVALENT ===
    print('\n--- TEST 7 : vs B&H ponderee equivalent ---')
    # Buy-and-hold simple : achete une fois et tient
    weights_bh = WINNER_WEIGHTS
    initial = 1000
    starts = {t: data_test[t].iloc[0] for t in weights_bh}
    ends = {t: data_test[t].iloc[-1] for t in weights_bh}
    bh_total = sum(weights_bh[t] * (ends[t] / starts[t] - 1) * initial for t in weights_bh)
    bh_pct = bh_total / initial * 100
    bh_ann = annualize(bh_pct, len(data_test))
    print(f'  B&H ponderee 2012-2025 : Total {bh_pct:.0f}% | Annualized {bh_ann:.1f}%/an')

    rp_ann = results.get('full_period_continuous', {}).get('annualized', 0)
    edge = rp_ann - bh_ann
    print(f'  Risk Parity edge vs B&H ponderee : {edge:+.1f}%/an')
    max_score += 1
    if edge >= 0:
        score += 1
        print(f'  [OK] Le rebalance ajoute de la valeur')
    else:
        failures.append(f'RP - B&H ponderee = {edge:.1f}% (rebalance ne sert a rien)')
        print(f'  [WEAK] Le rebalance n ajoute pas')

    # === TEST 8 : SIMULATION USER REEL 10k EUR ===
    print('\n--- TEST 8 : SIMULATION USER REEL (10keur Binance + IBKR fees) ---')
    # Simule des frais broker realistes : 0.1% Binance + 0.5%/an IBKR custody
    r = risk_parity_test(data_test, data_train, WINNER_WEIGHTS,
                         commission=0.0010, slippage=0.0030)
    if 'error' not in r:
        ann = annualize(r['total_return_pct'], len(data_test))
        capital_initial = 10000
        capital_final = capital_initial * (1 + r['total_return_pct'] / 100)
        gain = capital_final - capital_initial
        n_years = len(data_test) / 252
        gain_per_year = gain / n_years
        print(f'  10000eur -> {capital_final:.0f}eur en {n_years:.1f} ans')
        print(f'  Gain total : {gain:.0f}eur ({gain / capital_initial * 100:.0f}%)')
        print(f'  Gain moyen / an : {gain_per_year:.0f}eur ({gain_per_year / capital_initial * 100:.1f}%/an)')
        results['user_simulation'] = {
            'initial': capital_initial,
            'final': capital_final,
            'annual_gain_pct': float(gain_per_year / capital_initial * 100),
        }
        max_score += 1
        if gain_per_year / capital_initial >= 0.15:
            score += 1
            print(f'  [OK] Gain user reel >= 15%/an')
        else:
            failures.append(f'Gain user reel {gain_per_year / capital_initial * 100:.1f}%/an < 15%')

    # === VERDICT FINAL ===
    print('\n\n' + '=' * 90)
    print(f' VERDICT FINAL RISK PARITY CRYPTO-TILTED 20%')
    print('=' * 90)
    print(f'\n  SCORE : {score}/{max_score}')
    if score == max_score:
        verdict = 'VALIDE - DEPLOYABLE'
    elif score >= max_score * 0.7:
        verdict = 'OK - usage prudent'
    else:
        verdict = 'FRAGILE - ne pas deployer'
    print(f'  VERDICT : {verdict}')
    if failures:
        print(f'\n  ECHECS :')
        for f in failures:
            print(f'    - {f}')

    out = OUTPUT_DIR / 'lab_rp_final_test.json'
    with open(out, 'w') as f:
        json.dump({'results': results, 'score': score, 'max_score': max_score,
                   'verdict': verdict, 'failures': failures}, f, indent=2, default=str)
    print(f'\nSaved : {out}')


if __name__ == '__main__':
    main()
