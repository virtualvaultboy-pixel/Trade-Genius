"""
Trade Genius — Lab META + Hedge

Tester si ajouter une poche de HEDGE (inverse ETF) reduit le DD du META.

Hedges testes :
  - PSQ : -1x QQQ (anti-tech) - utilise pour periode bearmkt sectoriel
  - SH  : -1x SPY (anti-S&P)
  - VIXY : VIX futures (anti-vol explosive, mais vol decay enorme)
  - UVXY : -2x VIX (very risky)

Pondération : 0%, 3%, 5%, 8%, 10% du META.

Aussi test : 2018 pur (bear continu) - valider que les META tiennent.
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


def run_ia_get_equity(data, ia_config, alt_data, dd_stop_pct=15, dd_lookback=30,
                      rebal_days=21, commission=0.0015, slippage=0.0040, initial=1000,
                      hedge_ticker=None, hedge_pct=0):
    """Run une IA et retourne sa serie equity. Optionnel : poche hedge fixe."""
    weights = ia_config.get('weights')
    use_master = ia_config.get('use_master', False)
    use_onchain = ia_config.get('use_onchain', False)
    use_wf = ia_config.get('use_wf', False)
    wf_tickers = ia_config.get('wf_tickers')
    wf_retrain = ia_config.get('wf_retrain', 60)

    # Re-scale weights if hedge present
    if hedge_ticker and hedge_pct > 0:
        scale_main = 1.0 - hedge_pct / 100
        if use_wf and wf_tickers:
            tickers_all = list(wf_tickers) + [hedge_ticker]
        else:
            tickers_all = list(weights.keys()) + [hedge_ticker]
    else:
        scale_main = 1.0
        if use_wf and wf_tickers:
            tickers_all = list(wf_tickers)
        else:
            tickers_all = list(weights.keys())

    cash = initial
    holdings = {t: 0.0 for t in set(tickers_all) if t in data.columns}
    if use_wf and wf_tickers:
        current_weights = {t: 1.0 / len(wf_tickers) for t in wf_tickers}
    else:
        current_weights = dict(weights)

    peak = initial; max_dd = 0
    eq_series = pd.Series(initial, index=data.index, dtype=float)
    cash_cooldown = 0

    master_sig = compute_master_signal(data.index, alt_data) if use_master else pd.Series(1.0, index=data.index)
    onchain_sig = compute_onchain_signal(data.index, alt_data) if use_onchain else pd.Series(1.0, index=data.index)
    combined_sig = (master_sig * onchain_sig).clip(0, 1.5)

    retrain_indices = set(range(0, len(data), wf_retrain)) if use_wf else set()
    rebal_indices = set(range(0, len(data), rebal_days))

    for i, date in enumerate(data.index):
        equity = cash
        for t, sh in holdings.items():
            if t in data.columns and not pd.isna(data[t].iloc[i]):
                equity += sh * data[t].iloc[i]
        eq_series.iloc[i] = equity
        if equity > peak:
            peak = equity
        dd = (equity - peak) / peak
        if dd < max_dd:
            max_dd = dd

        if i >= dd_lookback:
            recent_peak = eq_series.iloc[max(0, i - dd_lookback):i + 1].max()
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

        if use_wf and i in retrain_indices and i >= 126:
            current_weights = compute_adaptive_weights(data, i, wf_tickers, 126, 'momentum_only')

        if i in rebal_indices:
            scale = float(combined_sig.iloc[i]) if i < len(combined_sig) else 1.0
            for t in holdings:
                if t not in data.columns or pd.isna(data[t].iloc[i]):
                    continue
                if t == hedge_ticker:
                    target_val = equity * (hedge_pct / 100)
                else:
                    target_val = equity * current_weights.get(t, 0) * scale * scale_main
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

    return eq_series


def stats(eq_series, n_days):
    initial = eq_series.iloc[0]
    final = eq_series.iloc[-1]
    n_years = n_days / 252
    annual = ((final / initial) ** (1 / n_years) - 1) * 100 if n_years > 0 else 0
    peak_series = eq_series.cummax()
    dd_series = (eq_series - peak_series) / peak_series
    max_dd = dd_series.min() * 100
    monthly_eq = eq_series.iloc[::21]
    m_rets = monthly_eq.pct_change().dropna() * 100
    worst_m = m_rets.min() if len(m_rets) else 0
    return {
        'annual_return_pct': float(annual),
        'max_dd_pct': float(max_dd),
        'worst_monthly': float(worst_m),
        'calmar': float(annual / max(abs(max_dd), 1)),
    }


def build_meta(eq_ind, eq_crp, eq_mix, weights):
    """Combine 3 series en META selon weights (somme = 1)."""
    e_ind = eq_ind / eq_ind.iloc[0]
    e_crp = eq_crp / eq_crp.iloc[0]
    e_mix = eq_mix / eq_mix.iloc[0]
    return (weights['IND'] * e_ind + weights['CRP'] * e_crp + weights['MIX'] * e_mix) * 1000


def main():
    print('=' * 95)
    print(' LAB META + HEDGE - test hedge & test 2018 bear')
    print('=' * 95)

    alt_data = load_alt_data()
    universe = ['SPY', 'QQQ', 'TLT', 'IEF', 'GLD', 'XLK', 'BTC-USD', 'ETH-USD', 'SOL-USD',
                'TQQQ', 'PSQ', 'SH', 'VIXY', 'UVXY']
    eng = LabEngine(universe=universe, start='2014-01-01')

    # =========== TEST 1 : Periode normale 2020-2025 ===========
    print('\n' + '=' * 95)
    print(' TEST 1 : Periode 2020-2025 (apres COVID) avec HEDGE')
    print('=' * 95)
    data = eng.data.loc['2020-01-01':'2026-01-01']
    print(f'Period: {data.index.min().date()} -> {data.index.max().date()}')

    # 3 IAs config
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

    print('\nRun 3 IAs sans hedge...')
    eq_ind = run_ia_get_equity(data, ia_cfg['INDICES'], alt_data)
    eq_crp = run_ia_get_equity(data, ia_cfg['CRYPTO'], alt_data)
    eq_mix = run_ia_get_equity(data, ia_cfg['MIXTE'], alt_data)
    print(f'  IND: {stats(eq_ind, len(data))["annual_return_pct"]:.1f}%/DD {stats(eq_ind, len(data))["max_dd_pct"]:.1f}%')
    print(f'  CRP: {stats(eq_crp, len(data))["annual_return_pct"]:.1f}%/DD {stats(eq_crp, len(data))["max_dd_pct"]:.1f}%')
    print(f'  MIX: {stats(eq_mix, len(data))["annual_return_pct"]:.1f}%/DD {stats(eq_mix, len(data))["max_dd_pct"]:.1f}%')

    all_results = {}

    # METAs sans hedge
    metas_configs = [
        ('META equipondere', {'IND': 1/3, 'CRP': 1/3, 'MIX': 1/3}),
        ('META indices-heavy', {'IND': 0.50, 'CRP': 0.25, 'MIX': 0.25}),
        ('META crypto-heavy', {'IND': 0.20, 'CRP': 0.50, 'MIX': 0.30}),
        ('META mixte-heavy', {'IND': 0.25, 'CRP': 0.25, 'MIX': 0.50}),
    ]

    print(f'\n{"META (no hedge)":<35}{"Annual":>9}{"DD":>9}{"WorstM":>9}{"Calmar":>9}')
    print('-' * 75)
    for name, w in metas_configs:
        eq = build_meta(eq_ind, eq_crp, eq_mix, w)
        r = stats(eq, len(data))
        print(f'{name:<35}{r["annual_return_pct"]:>8.1f}%{r["max_dd_pct"]:>8.1f}%{r["worst_monthly"]:>8.1f}%{r["calmar"]:>8.2f}')
        all_results[name] = r

    # =========== Tester avec hedge sur le META equipondere ===========
    print(f'\n--- HEDGE TEST sur META equipondere ---')
    print(f'{"Hedge":<35}{"Annual":>9}{"DD":>9}{"WorstM":>9}{"Calmar":>9}')
    print('-' * 75)
    base_meta_eq = build_meta(eq_ind, eq_crp, eq_mix, {'IND': 1/3, 'CRP': 1/3, 'MIX': 1/3})
    base_r = stats(base_meta_eq, len(data))
    print(f'{"baseline (0% hedge)":<35}{base_r["annual_return_pct"]:>8.1f}%{base_r["max_dd_pct"]:>8.1f}%{base_r["worst_monthly"]:>8.1f}%{base_r["calmar"]:>8.2f}')

    # Hedge = ajouter une poche de PSQ/SH/UVXY au META
    for hedge in ['PSQ', 'SH', 'VIXY', 'UVXY']:
        if hedge not in data.columns:
            continue
        for pct in [3, 5, 8, 10]:
            try:
                # Compute hedge equity
                hedge_eq = data[hedge] / data[hedge].iloc[0]
                meta_norm = base_meta_eq / base_meta_eq.iloc[0]
                combined = (1 - pct / 100) * meta_norm + (pct / 100) * hedge_eq
                combined_eq = combined * 1000
                r = stats(combined_eq, len(data))
                name = f'META eq + {pct}% {hedge}'
                print(f'{name:<35}{r["annual_return_pct"]:>8.1f}%{r["max_dd_pct"]:>8.1f}%{r["worst_monthly"]:>8.1f}%{r["calmar"]:>8.2f}')
                all_results[name] = r
            except Exception as e:
                pass

    # =========== TEST 2 : 2018 BEAR PURE ===========
    print('\n\n' + '=' * 95)
    print(' TEST 2 : 2018 bear PURE (deep OOS) - VALIDATION')
    print('=' * 95)
    data_2018 = eng.data.loc['2017-06-01':'2019-01-01']  # 18 mois autour 2018
    print(f'Period: {data_2018.index.min().date()} -> {data_2018.index.max().date()}')

    # 2018 = pas de funding crypto (avant 2019 Q4), donc faut adapter
    # On test seulement IA INDICES (qui marche sans funding)
    try:
        eq_ind_18 = run_ia_get_equity(data_2018, ia_cfg['INDICES'], alt_data)
        r_18 = stats(eq_ind_18, len(data_2018))
        print(f'IA INDICES 2018 : {r_18["annual_return_pct"]:.1f}% / DD {r_18["max_dd_pct"]:.1f}% / Cal {r_18["calmar"]:.2f}')

        # SPY benchmark sur meme periode
        if 'SPY' in eng.data.columns:
            spy_2018 = eng.data['SPY'].loc['2018-01-01':'2019-01-01']
            spy_ret = (spy_2018.iloc[-1] / spy_2018.iloc[0] - 1) * 100
            print(f'SPY 2018         : {spy_ret:.1f}% (B&H)')
    except Exception as e:
        print(f'  FAILED: {e}')

    # Save
    out = OUTPUT_DIR / 'lab_meta_hedge.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved : {out}')

    # VERDICT
    print('\n\n' + '=' * 95)
    print(' VERDICT META + HEDGE')
    print('=' * 95)
    sorted_r = sorted(all_results.items(), key=lambda kv: -kv[1]['calmar'])
    for name, r in sorted_r[:10]:
        print(f'  {name:<40} {r["annual_return_pct"]:>6.1f}% / DD {r["max_dd_pct"]:>5.1f}% / WM {r["worst_monthly"]:>5.1f}% / Cal {r["calmar"]:>4.2f}')


if __name__ == '__main__':
    main()
