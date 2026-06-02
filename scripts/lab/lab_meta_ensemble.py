"""
Trade Genius — Lab Meta-Ensemble

Combiner nos 3 IA winners en META-portefeuille.

Approches :
  - META equipondere : 33% INDICES + 33% CRYPTO + 33% MIXTE
  - META vol-weighted : inverse vol
  - META conviction : boost l'IA dont la performance recent (60j) est meilleure
  - META rotation : tient seulement la meilleure IA des 3 derniers mois
  - META CRYPTO-heavy : 20% INDICES + 50% CRYPTO + 30% MIXTE (parce que CRYPTO best Calmar)

Vraie question : meta-portfolio peut-il avoir un meilleur Calmar que les 3 indiv ?
Théorie : OUI si décorrélation. Pratique : a voir.
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
                      rebal_days=21, commission=0.0015, slippage=0.0040, initial=1000):
    """Run une IA et retourne sa serie equity quotidienne."""
    weights = ia_config.get('weights')
    use_master = ia_config.get('use_master', False)
    use_onchain = ia_config.get('use_onchain', False)
    use_wf = ia_config.get('use_wf', False)
    wf_tickers = ia_config.get('wf_tickers')
    wf_retrain = ia_config.get('wf_retrain', 60)

    cash = initial
    if use_wf and wf_tickers:
        holdings = {t: 0.0 for t in wf_tickers if t in data.columns}
        current_weights = {t: 1.0 / len(wf_tickers) for t in wf_tickers}
    else:
        holdings = {t: 0.0 for t in weights if t in data.columns}
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

    return eq_series


def stats(eq_series, n_days):
    """Stats from equity series."""
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
        'final_value': float(final),
        'calmar': float(annual / max(abs(max_dd), 1)),
    }


def main():
    print('=' * 95)
    print(' LAB META-ENSEMBLE - combiner les 3 IAs winners')
    print('=' * 95)

    alt_data = load_alt_data()
    universe = ['SPY', 'QQQ', 'TLT', 'IEF', 'GLD', 'XLK', 'BTC-USD', 'ETH-USD', 'SOL-USD', 'TQQQ']
    eng = LabEngine(universe=universe, start='2014-01-01')
    data = eng.data.loc['2019-09-01':'2026-01-01']

    # Run les 3 IAs separement, recolte les series equity
    print('\nRun IA INDICES...')
    eq_indices = run_ia_get_equity(data, {
        'weights': {'TQQQ': 0.60, 'TLT': 0.20, 'GLD': 0.20},
        'use_master': False, 'use_onchain': True,
    }, alt_data)
    r_indices = stats(eq_indices, len(data))
    print(f'  IA INDICES : {r_indices["annual_return_pct"]:.1f}% / DD {r_indices["max_dd_pct"]:.1f}% / Cal {r_indices["calmar"]:.2f}')

    print('\nRun IA CRYPTO...')
    eq_crypto = run_ia_get_equity(data, {
        'wf_tickers': ['BTC-USD', 'ETH-USD', 'SOL-USD', 'TLT'],
        'use_wf': True, 'wf_retrain': 60,
        'use_master': False, 'use_onchain': True,
    }, alt_data)
    r_crypto = stats(eq_crypto, len(data))
    print(f'  IA CRYPTO  : {r_crypto["annual_return_pct"]:.1f}% / DD {r_crypto["max_dd_pct"]:.1f}% / Cal {r_crypto["calmar"]:.2f}')

    print('\nRun IA MIXTE...')
    eq_mixte = run_ia_get_equity(data, {
        'weights': {'TQQQ': 0.50, 'BTC-USD': 0.10, 'ETH-USD': 0.10,
                   'TLT': 0.10, 'GLD': 0.10, 'XLK': 0.10},
        'use_master': True, 'use_onchain': False,
    }, alt_data)
    r_mixte = stats(eq_mixte, len(data))
    print(f'  IA MIXTE   : {r_mixte["annual_return_pct"]:.1f}% / DD {r_mixte["max_dd_pct"]:.1f}% / Cal {r_mixte["calmar"]:.2f}')

    # Correlations entre les 3
    rets_ind = eq_indices.pct_change().dropna()
    rets_crp = eq_crypto.pct_change().dropna()
    rets_mix = eq_mixte.pct_change().dropna()
    corr_ic = rets_ind.corr(rets_crp)
    corr_im = rets_ind.corr(rets_mix)
    corr_cm = rets_crp.corr(rets_mix)
    print(f'\n--- Correlations daily returns ---')
    print(f'  INDICES vs CRYPTO : {corr_ic:.2f}')
    print(f'  INDICES vs MIXTE  : {corr_im:.2f}')
    print(f'  CRYPTO  vs MIXTE  : {corr_cm:.2f}')

    # META-ENSEMBLES
    print('\n\n' + '=' * 95)
    print(' META-ENSEMBLES')
    print('=' * 95)
    print(f'\n{"Ensemble":<55}{"Annual":>8}{"DD":>8}{"WorstM":>8}{"Calmar":>8}')
    print('-' * 90)

    all_results = {}

    # 1. Equipondéré 33/33/33
    eq_avg = (eq_indices / eq_indices.iloc[0] + eq_crypto / eq_crypto.iloc[0] + eq_mixte / eq_mixte.iloc[0]) / 3 * 1000
    r = stats(eq_avg, len(data))
    print(f'{"META Equipondere (33/33/33)":<55}{r["annual_return_pct"]:>7.1f}%{r["max_dd_pct"]:>7.1f}%{r["worst_monthly"]:>7.1f}%{r["calmar"]:>8.2f}')
    all_results['META_equiponderé'] = r

    # 2. CRYPTO-heavy 20/50/30
    eq_cryh = (0.20 * eq_indices / eq_indices.iloc[0] + 0.50 * eq_crypto / eq_crypto.iloc[0] +
               0.30 * eq_mixte / eq_mixte.iloc[0]) * 1000
    r = stats(eq_cryh, len(data))
    print(f'{"META CRYPTO-heavy (20/50/30)":<55}{r["annual_return_pct"]:>7.1f}%{r["max_dd_pct"]:>7.1f}%{r["worst_monthly"]:>7.1f}%{r["calmar"]:>8.2f}')
    all_results['META_crypto_heavy'] = r

    # 3. MIXTE-heavy 25/25/50
    eq_mxh = (0.25 * eq_indices / eq_indices.iloc[0] + 0.25 * eq_crypto / eq_crypto.iloc[0] +
              0.50 * eq_mixte / eq_mixte.iloc[0]) * 1000
    r = stats(eq_mxh, len(data))
    print(f'{"META MIXTE-heavy (25/25/50)":<55}{r["annual_return_pct"]:>7.1f}%{r["max_dd_pct"]:>7.1f}%{r["worst_monthly"]:>7.1f}%{r["calmar"]:>8.2f}')
    all_results['META_mixte_heavy'] = r

    # 4. INDICES-heavy 50/25/25
    eq_ixh = (0.50 * eq_indices / eq_indices.iloc[0] + 0.25 * eq_crypto / eq_crypto.iloc[0] +
              0.25 * eq_mixte / eq_mixte.iloc[0]) * 1000
    r = stats(eq_ixh, len(data))
    print(f'{"META INDICES-heavy (50/25/25)":<55}{r["annual_return_pct"]:>7.1f}%{r["max_dd_pct"]:>7.1f}%{r["worst_monthly"]:>7.1f}%{r["calmar"]:>8.2f}')
    all_results['META_indices_heavy'] = r

    # 5. Adaptive : weight monthly by past Sharpe (60d)
    print('\n--- Adaptive : weight monthly by trailing Sharpe 60d ---')
    eq_adp = pd.Series(1000.0, index=data.index, dtype=float)
    holdings_pct = {'IND': 1/3, 'CRP': 1/3, 'MIX': 1/3}
    rebal_dates = data.index[::30]  # monthly
    last_eq = 1000
    for i, date in enumerate(data.index):
        if i == 0:
            eq_adp.iloc[i] = 1000
            continue
        # Daily return per IA
        if i > 0:
            r_i = eq_indices.iloc[i] / eq_indices.iloc[i-1] - 1
            r_c = eq_crypto.iloc[i] / eq_crypto.iloc[i-1] - 1
            r_m = eq_mixte.iloc[i] / eq_mixte.iloc[i-1] - 1
            combined_ret = (holdings_pct['IND'] * r_i + holdings_pct['CRP'] * r_c + holdings_pct['MIX'] * r_m)
            last_eq = last_eq * (1 + combined_ret)
            eq_adp.iloc[i] = last_eq

        # Rebalance monthly based on Sharpe past 60d
        if date in rebal_dates and i >= 60:
            ret_ind = eq_indices.iloc[i-60:i].pct_change().dropna()
            ret_crp = eq_crypto.iloc[i-60:i].pct_change().dropna()
            ret_mix = eq_mixte.iloc[i-60:i].pct_change().dropna()
            s_i = (ret_ind.mean() / (ret_ind.std() + 1e-9))
            s_c = (ret_crp.mean() / (ret_crp.std() + 1e-9))
            s_m = (ret_mix.mean() / (ret_mix.std() + 1e-9))
            # Use max(0, sharpe)
            s_i = max(0, s_i); s_c = max(0, s_c); s_m = max(0, s_m)
            tot = s_i + s_c + s_m
            if tot > 0:
                holdings_pct = {'IND': s_i / tot, 'CRP': s_c / tot, 'MIX': s_m / tot}
    r = stats(eq_adp, len(data))
    print(f'{"META Adaptive Sharpe-weighted":<55}{r["annual_return_pct"]:>7.1f}%{r["max_dd_pct"]:>7.1f}%{r["worst_monthly"]:>7.1f}%{r["calmar"]:>8.2f}')
    all_results['META_adaptive_sharpe'] = r

    # Save
    out = OUTPUT_DIR / 'lab_meta_ensemble.json'
    with open(out, 'w') as f:
        json.dump({
            'individual': {'INDICES': r_indices, 'CRYPTO': r_crypto, 'MIXTE': r_mixte},
            'correlations': {'IND_CRP': float(corr_ic), 'IND_MIX': float(corr_im), 'CRP_MIX': float(corr_cm)},
            'meta_ensembles': all_results,
        }, f, indent=2, default=str)
    print(f'\nSaved : {out}')

    # VERDICT
    print('\n\n' + '=' * 95)
    print(' VERDICT META-ENSEMBLE')
    print('=' * 95)
    # All including individuals
    candidates = {
        'IA INDICES seule': r_indices,
        'IA CRYPTO seule': r_crypto,
        'IA MIXTE seule': r_mixte,
        **all_results,
    }
    sorted_c = sorted(candidates.items(), key=lambda kv: -kv[1]['calmar'])
    print(f'{"Candidate":<55}{"Annual":>8}{"DD":>8}{"Calmar":>8}')
    print('-' * 85)
    for k, r in sorted_c:
        print(f'  {k:<53}{r["annual_return_pct"]:>7.1f}%{r["max_dd_pct"]:>7.1f}%{r["calmar"]:>8.2f}')


if __name__ == '__main__':
    main()
