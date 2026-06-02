"""
Trade Genius — Lab Walk-Forward Retrain

Tester si re-optimiser les ALLOCATIONS chaque trimestre (vs allocation fixe)
ameliore les perfs en s'adaptant aux regimes (bull/bear/sideways).

Strategie :
  - Tous les 90 jours : recalculer les poids optimaux based on last 6 months
  - Methode : inverse-vol weighting + boost momentum
  - Compare a baseline fixe pour chaque IA

Test : impact de l'adaptation sur les 3 IAs.
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


def compute_adaptive_weights(data, i, tickers, lookback=126, method='inverse_vol_momentum'):
    """
    Recalcule les weights base sur les N derniers jours.
    Methods :
      - 'inverse_vol' : poids proportionnel a 1/vol
      - 'inverse_vol_momentum' : 1/vol * (1 + momentum)
      - 'momentum_only' : poids selon momentum positif
    """
    if i < lookback:
        return {t: 1.0 / len(tickers) for t in tickers}

    metrics = {}
    for t in tickers:
        if t not in data.columns:
            continue
        prices = data[t].iloc[i - lookback:i + 1].dropna()
        if len(prices) < lookback // 2:
            continue
        rets = prices.pct_change().dropna()
        if len(rets) < 30:
            continue
        vol = rets.std() * np.sqrt(252)
        mom = (prices.iloc[-1] / prices.iloc[0] - 1) if len(prices) > 1 else 0
        metrics[t] = {'vol': vol, 'mom': mom}

    if not metrics:
        return {t: 1.0 / len(tickers) for t in tickers}

    weights = {}
    if method == 'inverse_vol':
        for t, m in metrics.items():
            weights[t] = 1.0 / max(m['vol'], 0.01)
    elif method == 'inverse_vol_momentum':
        for t, m in metrics.items():
            # Si momentum négatif, réduit beaucoup le poids
            mom_factor = max(0.1, 1 + m['mom'])
            weights[t] = mom_factor / max(m['vol'], 0.01)
    elif method == 'momentum_only':
        for t, m in metrics.items():
            weights[t] = max(0.01, m['mom'])

    # Normalize
    total = sum(weights.values())
    if total > 0:
        weights = {t: w / total for t, w in weights.items()}
    return weights


def run_walkforward(data, tickers, alt_data, retrain_days=90, lookback=126,
                    method='inverse_vol_momentum', dd_stop_pct=15, dd_lookback=30,
                    rebal_days=21, commission=0.0015, slippage=0.0040, initial=1000,
                    use_master=True, use_onchain=False):
    """Run IA avec poids ré-optimisés tous les N jours."""
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

        # DD stop
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

        # Retrain weights
        if i in retrain_indices and i >= lookback:
            current_weights = compute_adaptive_weights(data, i, tickers, lookback, method)

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
    print(' LAB WALK-FORWARD RETRAIN - adaptation regimes')
    print('=' * 95)

    alt_data = load_alt_data()
    universe = ['SPY', 'QQQ', 'TLT', 'IEF', 'GLD', 'XLK', 'BTC-USD', 'ETH-USD', 'SOL-USD', 'TQQQ']
    eng = LabEngine(universe=universe, start='2014-01-01')
    data = eng.data.loc['2019-09-01':'2026-01-01']

    ia_configs = {
        'IA INDICES': {
            'tickers': ['TQQQ', 'TLT', 'GLD'],
            'use_master': False, 'use_onchain': True,
            'baseline_weights': {'TQQQ': 0.60, 'TLT': 0.20, 'GLD': 0.20},
        },
        'IA CRYPTO': {
            'tickers': ['BTC-USD', 'ETH-USD', 'SOL-USD', 'TLT'],
            'use_master': False, 'use_onchain': True,
            'baseline_weights': {'BTC-USD': 0.40, 'ETH-USD': 0.20, 'SOL-USD': 0.20, 'TLT': 0.20},
        },
        'IA MIXTE': {
            'tickers': ['TQQQ', 'BTC-USD', 'ETH-USD', 'TLT', 'GLD', 'XLK'],
            'use_master': True, 'use_onchain': False,
            'baseline_weights': {'TQQQ': 0.50, 'BTC-USD': 0.10, 'ETH-USD': 0.10,
                                  'TLT': 0.10, 'GLD': 0.10, 'XLK': 0.10},
        },
    }

    methods = ['inverse_vol', 'inverse_vol_momentum', 'momentum_only']
    retrain_periods = [60, 90, 180]

    all_results = {}
    for ia_name, cfg in ia_configs.items():
        print(f'\n--- {ia_name} ---')
        print(f'{"Mode":<45}{"Annual":>8}{"DD":>8}{"WorstM":>8}{"Calmar":>8}')
        print('-' * 80)

        # Baseline fixe
        from lab_onchain_signals import run_ia_with_onchain
        r_base = run_ia_with_onchain(data, cfg['baseline_weights'], alt_data,
                                       use_alt_master=cfg['use_master'],
                                       use_onchain=cfg['use_onchain'])
        print(f'{"baseline FIXED weights":<45}{r_base["annual_return_pct"]:>7.1f}%{r_base["max_dd_pct"]:>7.1f}%{r_base["worst_monthly"]:>7.1f}%{r_base["calmar"]:>8.2f}')
        all_results[f'{ia_name} | baseline'] = r_base

        # Walk-forward variants
        for method in methods:
            for retrain in retrain_periods:
                name = f'WF retrain_{retrain}j method={method}'
                try:
                    r = run_walkforward(data, cfg['tickers'], alt_data,
                                         retrain_days=retrain, method=method,
                                         use_master=cfg['use_master'],
                                         use_onchain=cfg['use_onchain'])
                    print(f'{name:<45}{r["annual_return_pct"]:>7.1f}%{r["max_dd_pct"]:>7.1f}%{r["worst_monthly"]:>7.1f}%{r["calmar"]:>8.2f}')
                    all_results[f'{ia_name} | {name}'] = r
                except Exception as e:
                    print(f'{name:<45} FAILED: {e}')

    out = OUTPUT_DIR / 'lab_walkforward_retrain.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved : {out}')

    # VERDICT
    print('\n\n' + '=' * 95)
    print(' VERDICT : walk-forward retrain ameliore-t-il ?')
    print('=' * 95)
    for ia_name in ia_configs:
        results = [(k, v) for k, v in all_results.items() if k.startswith(ia_name)]
        results.sort(key=lambda kv: -kv[1]['calmar'])
        print(f'\n{ia_name} (top 3 par Calmar) :')
        for k, r in results[:3]:
            mode = k.split(' | ')[1]
            print(f'  {mode:<45} {r["annual_return_pct"]:>5.1f}% / DD {r["max_dd_pct"]:>5.1f}% / Cal {r["calmar"]:>4.2f}')


if __name__ == '__main__':
    main()
