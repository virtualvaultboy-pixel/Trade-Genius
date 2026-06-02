"""
Trade Genius — Lab Crypto Extended

Combiner :
  1. WF retrain 60j momentum (déjà winner)
  2. On-chain BTC signal
  3. Univers crypto étendu : ajouter LINK, AVAX, INJ, NEAR, DOT, ATOM
  4. Pondération vol-targeted par actif

Objectif : pousser CRYPTO de 40%/an DD -50% vers 45%+/an DD -45%.
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
from lab_walkforward_retrain import compute_adaptive_weights


def run_crypto_extended(data, tickers, alt_data,
                         retrain_days=60, lookback=126, method='momentum_only',
                         dd_stop_pct=15, dd_lookback=30,
                         rebal_days=21, commission=0.0015, slippage=0.0040,
                         initial=1000, use_master=False, use_onchain=True,
                         top_n_filter=None):
    """
    CRYPTO étendu avec :
      - WF retrain mensuel
      - On-chain BTC signal
      - top_n_filter : limite aux top N actifs par momentum (None = tous)
    """
    cash = initial
    holdings = {t: 0.0 for t in tickers if t in data.columns}
    peak = initial; max_dd = 0
    eq_history = []; monthly_eq = []
    cash_cooldown = 0
    current_weights = {t: 1.0 / len(tickers) for t in tickers}

    master_sig = compute_master_signal(data.index, alt_data) if use_master else pd.Series(1.0, index=data.index)
    onchain_sig = compute_onchain_signal(data.index, alt_data) if use_onchain else pd.Series(1.0, index=data.index)
    combined_sig = (master_sig * onchain_sig).clip(0, 1.5)

    retrain_indices = set(range(0, len(data), retrain_days))
    rebal_indices = set(range(0, len(data), rebal_days))

    for i, date in enumerate(data.index):
        equity = cash
        for t, sh in holdings.items():
            if t in data.columns and not pd.isna(data[t].iloc[i]):
                equity += sh * data[t].iloc[i]
        eq_history.append(equity)
        if i % 21 == 0:
            monthly_eq.append(equity)
        if equity > peak:
            peak = equity
        dd = (equity - peak) / peak
        if dd < max_dd:
            max_dd = dd

        if i >= dd_lookback:
            recent_peak = max(eq_history[-dd_lookback:])
            recent_dd = (equity - recent_peak) / recent_peak
            if recent_dd < -dd_stop_pct / 100 and cash_cooldown == 0:
                for t in list(holdings.keys()):
                    if t in data.columns and not pd.isna(data[t].iloc[i]) and holdings[t] > 0:
                        proceeds = holdings[t] * data[t].iloc[i] * (1 - slippage)
                        fee = proceeds * commission
                        cash += proceeds - fee
                        holdings[t] = 0
                cash_cooldown = dd_lookback

        if cash_cooldown > 0:
            cash_cooldown -= 1
            continue

        # Retrain
        if i in retrain_indices and i >= lookback:
            current_weights = compute_adaptive_weights(data, i, tickers, lookback, method)
            # Top N filter
            if top_n_filter and len(current_weights) > top_n_filter:
                sorted_w = sorted(current_weights.items(), key=lambda kv: -kv[1])
                top = dict(sorted_w[:top_n_filter])
                # Add TLT defensive if not already
                if 'TLT' in tickers and 'TLT' not in top:
                    top['TLT'] = max(0.1, min(top.values()))
                tot = sum(top.values())
                current_weights = {t: w / tot for t, w in top.items()}

        if i in rebal_indices:
            scale = float(combined_sig.iloc[i]) if i < len(combined_sig) else 1.0
            for t in holdings:
                if t not in data.columns or pd.isna(data[t].iloc[i]):
                    continue
                target_val = equity * current_weights.get(t, 0) * scale
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

    final = eq_history[-1]
    n_years = len(data) / 252
    annual = ((final / initial) ** (1 / n_years) - 1) * 100 if n_years > 0 else 0
    if monthly_eq:
        m_arr = np.array(monthly_eq)
        m_rets = np.diff(m_arr) / m_arr[:-1] * 100
        worst_m = float(min(m_rets)) if len(m_rets) else 0
    else:
        worst_m = 0
    return {
        'annual_return_pct': float(annual),
        'max_dd_pct': float(max_dd * 100),
        'worst_monthly': worst_m,
        'final_value': float(final),
        'calmar': float(annual / max(abs(max_dd * 100), 1)),
    }


def main():
    print('=' * 95)
    print(' LAB CRYPTO EXTENDED - univers etendu + WF + on-chain + master')
    print('=' * 95)

    alt_data = load_alt_data()
    universe = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'TLT',
                'LINK-USD', 'AVAX-USD', 'INJ-USD', 'NEAR-USD',
                'DOT-USD', 'ATOM-USD', 'MATIC-USD', 'ADA-USD']
    eng = LabEngine(universe=universe, start='2018-01-01')
    data = eng.data.loc['2019-09-01':'2026-01-01']
    print(f'Period : {data.index.min().date()} -> {data.index.max().date()}')
    print(f'Univers : {len(data.columns)} actifs disponibles')

    variants = [
        # Baseline reference
        ('REF: 4 actifs (BTC40+ETH20+SOL20+TLT20)',
         ['BTC-USD', 'ETH-USD', 'SOL-USD', 'TLT'], 60, 'momentum_only', False, True, None),

        # Univers etendu
        ('EXT 8 actifs equipondere',
         ['BTC-USD', 'ETH-USD', 'SOL-USD', 'LINK-USD', 'AVAX-USD', 'INJ-USD', 'NEAR-USD', 'TLT'],
         60, 'momentum_only', False, True, None),

        ('EXT 8 actifs + top 4',
         ['BTC-USD', 'ETH-USD', 'SOL-USD', 'LINK-USD', 'AVAX-USD', 'INJ-USD', 'NEAR-USD', 'TLT'],
         60, 'momentum_only', False, True, 4),

        ('EXT 12 actifs + top 4',
         ['BTC-USD', 'ETH-USD', 'SOL-USD', 'LINK-USD', 'AVAX-USD', 'INJ-USD',
          'NEAR-USD', 'DOT-USD', 'ATOM-USD', 'MATIC-USD', 'ADA-USD', 'TLT'],
         60, 'momentum_only', False, True, 4),

        ('EXT 12 actifs + top 5',
         ['BTC-USD', 'ETH-USD', 'SOL-USD', 'LINK-USD', 'AVAX-USD', 'INJ-USD',
          'NEAR-USD', 'DOT-USD', 'ATOM-USD', 'MATIC-USD', 'ADA-USD', 'TLT'],
         60, 'momentum_only', False, True, 5),

        ('EXT 12 actifs + top 6',
         ['BTC-USD', 'ETH-USD', 'SOL-USD', 'LINK-USD', 'AVAX-USD', 'INJ-USD',
          'NEAR-USD', 'DOT-USD', 'ATOM-USD', 'MATIC-USD', 'ADA-USD', 'TLT'],
         60, 'momentum_only', False, True, 6),

        # Master + onchain combo
        ('REF 4 + MASTER + ON-CHAIN',
         ['BTC-USD', 'ETH-USD', 'SOL-USD', 'TLT'], 60, 'momentum_only', True, True, None),

        ('EXT 12 + top 4 + MASTER + ON-CHAIN',
         ['BTC-USD', 'ETH-USD', 'SOL-USD', 'LINK-USD', 'AVAX-USD', 'INJ-USD',
          'NEAR-USD', 'DOT-USD', 'ATOM-USD', 'MATIC-USD', 'ADA-USD', 'TLT'],
         60, 'momentum_only', True, True, 4),

        # Inverse-vol + WF
        ('EXT 12 + top 5 + inverse_vol_momentum + ON-CHAIN',
         ['BTC-USD', 'ETH-USD', 'SOL-USD', 'LINK-USD', 'AVAX-USD', 'INJ-USD',
          'NEAR-USD', 'DOT-USD', 'ATOM-USD', 'MATIC-USD', 'ADA-USD', 'TLT'],
         60, 'inverse_vol_momentum', False, True, 5),

        # Retrain plus fréquent
        ('EXT 12 + top 5 + retrain 30j',
         ['BTC-USD', 'ETH-USD', 'SOL-USD', 'LINK-USD', 'AVAX-USD', 'INJ-USD',
          'NEAR-USD', 'DOT-USD', 'ATOM-USD', 'MATIC-USD', 'ADA-USD', 'TLT'],
         30, 'momentum_only', False, True, 5),
    ]

    print(f'\n{"Variant":<60}{"Annual":>8}{"DD":>8}{"WorstM":>8}{"Calmar":>8}')
    print('-' * 100)
    all_results = {}
    for name, tickers, retrain, method, use_master, use_onchain, top_n in variants:
        try:
            r = run_crypto_extended(data, tickers, alt_data,
                                     retrain_days=retrain, method=method,
                                     use_master=use_master, use_onchain=use_onchain,
                                     top_n_filter=top_n)
            print(f'{name[:59]:<60}{r["annual_return_pct"]:>7.1f}%{r["max_dd_pct"]:>7.1f}%{r["worst_monthly"]:>7.1f}%{r["calmar"]:>8.2f}')
            all_results[name] = r
        except Exception as e:
            print(f'{name[:59]:<60} FAILED: {e}')

    out = OUTPUT_DIR / 'lab_crypto_extended.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved : {out}')

    # VERDICT
    print('\n\n' + '=' * 95)
    print(' VERDICT : meilleure variante CRYPTO etendu')
    print('=' * 95)
    sorted_r = sorted(all_results.items(), key=lambda kv: -kv[1]['calmar'])
    print(f'{"Variant":<60}{"Ann":>8}{"DD":>8}{"Calmar":>8}')
    print('-' * 90)
    for name, r in sorted_r:
        print(f'  {name[:58]:<60}{r["annual_return_pct"]:>7.1f}%{r["max_dd_pct"]:>7.1f}%{r["calmar"]:>8.2f}')


if __name__ == '__main__':
    main()
