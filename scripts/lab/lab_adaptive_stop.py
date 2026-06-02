"""
Trade Genius — Lab Adaptive Stop Loss

Teste differents mecanismes de stop loss/sortie :
  - Stop fixe (baseline) : -15% sur 30j
  - Stop adaptatif vol : stop = -2*ATR (volatility-scaled)
  - Stop trailing : trailing stop sur high récent
  - Stop ATR multiple : sortie si DD > N x ATR(60j)
  - Stop régime : sortie si régime bear confirmé

Sur les 3 IA avec leur signal optimal.
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


def run_ia_adaptive_stop(data, weights, alt_data, stop_mode='fixed',
                         stop_param=15, dd_lookback=30, rebal_days=21,
                         commission=0.0015, slippage=0.0040, initial=1000,
                         use_master=True, use_onchain=False):
    """
    Variantes stop_mode :
      - 'fixed' : DD > stop_param%  (le baseline)
      - 'vol_scaled' : stop = stop_param x vol annualisée (ex 1.5x)
      - 'trailing_atr' : trailing N x ATR(20)
      - 'regime' : exit si TQQQ < SMA50 ET DD > 8%
      - 'cascade' : 2 niveaux (reduce 50% si DD>10%, full cash si DD>20%)
    """
    cash = initial
    holdings = {t: 0.0 for t in weights}
    peak = initial; max_dd = 0
    eq_history = []; monthly_eq = []
    cash_cooldown = 0
    reduce_mode = False  # pour cascade

    # Signals
    master_sig = compute_master_signal(data.index, alt_data) if use_master else pd.Series(1.0, index=data.index)
    onchain_sig = compute_onchain_signal(data.index, alt_data) if use_onchain else pd.Series(1.0, index=data.index)
    combined_sig = (master_sig * onchain_sig).clip(0, 1.5)

    # Pre-compute vol pour vol_scaled
    if stop_mode in ('vol_scaled', 'trailing_atr'):
        # Use SPY or first ticker
        ref_ticker = 'SPY' if 'SPY' in data.columns else list(weights.keys())[0]
        if ref_ticker in data.columns:
            ref_vol = data[ref_ticker].pct_change().rolling(60).std() * np.sqrt(252) * 100
        else:
            ref_vol = pd.Series(20, index=data.index)
    else:
        ref_vol = None

    # Pre-compute regime
    if stop_mode == 'regime' and 'TQQQ' in data.columns:
        tqqq_sma = data['TQQQ'].rolling(50).mean()
        in_bear = data['TQQQ'] < tqqq_sma
    else:
        in_bear = pd.Series(False, index=data.index)

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
            reduce_mode = False  # reset cascade
        dd = (equity - peak) / peak
        if dd < max_dd:
            max_dd = dd

        # Stop logic
        triggered = False
        if i >= dd_lookback:
            recent_peak = max(eq_history[-dd_lookback:])
            recent_dd = (equity - recent_peak) / recent_peak

            if stop_mode == 'fixed':
                if recent_dd < -stop_param / 100 and cash_cooldown == 0:
                    triggered = True
            elif stop_mode == 'vol_scaled':
                v = ref_vol.iloc[i] if i < len(ref_vol) and not pd.isna(ref_vol.iloc[i]) else 20
                dynamic_threshold = (v / 100) * stop_param / 4  # ex vol=20% → seuil = 5% si stop_param=1
                if recent_dd < -dynamic_threshold and cash_cooldown == 0:
                    triggered = True
            elif stop_mode == 'trailing_atr':
                v = ref_vol.iloc[i] if i < len(ref_vol) and not pd.isna(ref_vol.iloc[i]) else 20
                atr_threshold = stop_param * v / 100 / np.sqrt(252) * np.sqrt(30)  # ATR-equiv sur 30j
                if recent_dd < -atr_threshold and cash_cooldown == 0:
                    triggered = True
            elif stop_mode == 'regime':
                if in_bear.iloc[i] and recent_dd < -8 / 100 and cash_cooldown == 0:
                    triggered = True
            elif stop_mode == 'cascade':
                # Reduce mode si DD > 10%
                if recent_dd < -0.10 and not reduce_mode:
                    reduce_mode = True
                if recent_dd < -0.20 and cash_cooldown == 0:
                    triggered = True

        if triggered:
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

        if i in rebal_indices:
            scale = float(combined_sig.iloc[i]) if i < len(combined_sig) else 1.0
            # Reduce mode = 0.5x
            if reduce_mode and stop_mode == 'cascade':
                scale *= 0.5

            for t in holdings:
                if t not in data.columns or pd.isna(data[t].iloc[i]):
                    continue
                target_val = equity * weights.get(t, 0) * scale
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
    print(' LAB ADAPTIVE STOP - tester differents stops sur les 3 IAs')
    print('=' * 95)

    alt_data = load_alt_data()
    universe = ['SPY', 'QQQ', 'TLT', 'IEF', 'GLD', 'XLK', 'BTC-USD', 'ETH-USD', 'SOL-USD', 'TQQQ']
    eng = LabEngine(universe=universe, start='2014-01-01')
    data = eng.data.loc['2019-09-01':'2026-01-01']

    winners = {
        'IA INDICES': {
            'weights': {'TQQQ': 0.60, 'TLT': 0.20, 'GLD': 0.20},
            'use_master': False, 'use_onchain': True,  # best mode
        },
        'IA CRYPTO': {
            'weights': {'BTC-USD': 0.40, 'ETH-USD': 0.20, 'SOL-USD': 0.20, 'TLT': 0.20},
            'use_master': False, 'use_onchain': True,
        },
        'IA MIXTE Calmar': {
            'weights': {'TQQQ': 0.50, 'BTC-USD': 0.10, 'ETH-USD': 0.10, 'TLT': 0.10, 'GLD': 0.10, 'XLK': 0.10},
            'use_master': True, 'use_onchain': False,
        },
    }

    stop_modes = [
        ('fixed_10', 'fixed', 10),
        ('fixed_15', 'fixed', 15),
        ('fixed_20', 'fixed', 20),
        ('fixed_25', 'fixed', 25),
        ('vol_scaled_1', 'vol_scaled', 1),
        ('vol_scaled_1.5', 'vol_scaled', 1.5),
        ('vol_scaled_2', 'vol_scaled', 2),
        ('trailing_atr_2', 'trailing_atr', 2),
        ('trailing_atr_3', 'trailing_atr', 3),
        ('regime', 'regime', 0),
        ('cascade', 'cascade', 0),
    ]

    all_results = {}
    for ia_name, cfg in winners.items():
        print(f'\n--- {ia_name} ---')
        print(f'{"Stop Mode":<25}{"Annual":>9}{"DD":>9}{"WorstM":>9}{"Calmar":>9}')
        print('-' * 65)
        for stop_name, mode, param in stop_modes:
            try:
                r = run_ia_adaptive_stop(data, cfg['weights'], alt_data,
                                          stop_mode=mode, stop_param=param,
                                          use_master=cfg['use_master'],
                                          use_onchain=cfg['use_onchain'])
                print(f'{stop_name:<25}{r["annual_return_pct"]:>8.1f}%{r["max_dd_pct"]:>8.1f}%{r["worst_monthly"]:>8.1f}%{r["calmar"]:>8.2f}')
                all_results[f'{ia_name} | {stop_name}'] = r
            except Exception as e:
                print(f'{stop_name:<25} FAILED: {e}')

    out = OUTPUT_DIR / 'lab_adaptive_stop.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved : {out}')

    # VERDICT : best stop par IA
    print('\n\n' + '=' * 95)
    print(' VERDICT : meilleur stop par IA (par Calmar)')
    print('=' * 95)
    for ia_name in winners:
        results = [(k, v) for k, v in all_results.items() if k.startswith(ia_name)]
        results.sort(key=lambda kv: -kv[1]['calmar'])
        print(f'\n{ia_name} (top 3 par Calmar):')
        for k, r in results[:3]:
            stop = k.split(' | ')[1]
            print(f'  {stop:<25} {r["annual_return_pct"]:>5.1f}% / DD {r["max_dd_pct"]:>5.1f}% / Cal {r["calmar"]:>4.2f}')


if __name__ == '__main__':
    main()
