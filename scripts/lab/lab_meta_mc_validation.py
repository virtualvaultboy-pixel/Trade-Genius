"""
Trade Genius — Lab Meta Monte-Carlo Validation

Valide les META winners par Monte-Carlo blocks (200 iters, blocs 60j).

Pour chaque META candidate :
  - Shuffle 200 fois les ordres des blocs de 60 jours
  - Recompute les stats
  - Mesure P(profit), P(annual >= 15%), P(DD > -50%)

Si P(profit) > 70% ET P(annual >= 15%) > 50% → solide.
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


def stats_eq(eq_series, n_days):
    initial = eq_series.iloc[0]
    final = eq_series.iloc[-1]
    n_years = n_days / 252
    annual = ((final / initial) ** (1 / n_years) - 1) * 100 if n_years > 0 else 0
    peak_series = eq_series.cummax()
    dd_series = (eq_series - peak_series) / peak_series
    max_dd = dd_series.min() * 100
    return {
        'annual_return_pct': float(annual),
        'max_dd_pct': float(max_dd),
        'final_value': float(final),
    }


def shuffle_data_blocks(data, block_len=60, seed=42):
    """Permute blocs de 60j (preserve correlations intra-bloc, shuffle inter-bloc)."""
    rng = np.random.default_rng(seed)
    n = len(data)
    n_blocks = n // block_len
    starts = rng.integers(0, n - block_len, size=n_blocks)
    new_idx = np.concatenate([np.arange(s, s + block_len) for s in starts])[:n]
    shuffled = data.iloc[new_idx].reset_index(drop=True)
    shuffled.index = data.index[:len(shuffled)]
    return shuffled


def monte_carlo_meta(eq_ind, eq_crp, eq_mix, meta_weights, n_iters=200, block_len=60):
    """
    Monte-Carlo blocks sur META.
    Re-shuffle les 3 series equity en bloc, calc META combinaison, mesure stats.
    """
    rng = np.random.default_rng(42)
    n = len(eq_ind)
    results = []
    for it in range(n_iters):
        # Shuffle each series independently
        s_ind = rng.integers(0, n - block_len, size=n // block_len)
        s_crp = rng.integers(0, n - block_len, size=n // block_len)
        s_mix = rng.integers(0, n - block_len, size=n // block_len)
        idx_ind = np.concatenate([np.arange(s, s + block_len) for s in s_ind])[:n]
        idx_crp = np.concatenate([np.arange(s, s + block_len) for s in s_crp])[:n]
        idx_mix = np.concatenate([np.arange(s, s + block_len) for s in s_mix])[:n]
        eq_i = eq_ind.iloc[idx_ind].reset_index(drop=True)
        eq_c = eq_crp.iloc[idx_crp].reset_index(drop=True)
        eq_m = eq_mix.iloc[idx_mix].reset_index(drop=True)

        # Normalize
        eq_i = eq_i / eq_i.iloc[0]
        eq_c = eq_c / eq_c.iloc[0]
        eq_m = eq_m / eq_m.iloc[0]
        meta = (meta_weights['IND'] * eq_i + meta_weights['CRP'] * eq_c + meta_weights['MIX'] * eq_m) * 1000
        meta.index = eq_ind.index[:len(meta)]
        s = stats_eq(meta, len(meta))
        results.append(s)

    df = pd.DataFrame(results)
    return {
        'n_iters': len(df),
        'annual_median': float(df['annual_return_pct'].median()),
        'annual_mean': float(df['annual_return_pct'].mean()),
        'annual_p5': float(df['annual_return_pct'].quantile(0.05)),
        'annual_p95': float(df['annual_return_pct'].quantile(0.95)),
        'p_profit': float((df['annual_return_pct'] > 0).mean()),
        'p_above_15': float((df['annual_return_pct'] >= 15).mean()),
        'p_above_20': float((df['annual_return_pct'] >= 20).mean()),
        'dd_median': float(df['max_dd_pct'].median()),
        'dd_worst': float(df['max_dd_pct'].min()),
        'dd_p5': float(df['max_dd_pct'].quantile(0.05)),
    }


def main():
    print('=' * 95)
    print(' LAB META MONTE-CARLO VALIDATION (200 iters x 60j blocks)')
    print('=' * 95)

    alt_data = load_alt_data()
    universe = ['SPY', 'QQQ', 'TLT', 'IEF', 'GLD', 'XLK', 'BTC-USD', 'ETH-USD', 'SOL-USD', 'TQQQ']
    eng = LabEngine(universe=universe, start='2014-01-01')
    data = eng.data.loc['2019-09-01':'2026-01-01']  # 6.3 ans
    print(f'Period : {data.index.min().date()} -> {data.index.max().date()} ({len(data)/252:.1f} ans)')

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

    print('\nRun 3 IAs...')
    eq_ind = run_ia_get_equity(data, ia_cfg['INDICES'], alt_data)
    eq_crp = run_ia_get_equity(data, ia_cfg['CRYPTO'], alt_data)
    eq_mix = run_ia_get_equity(data, ia_cfg['MIXTE'], alt_data)

    s_ind = stats_eq(eq_ind, len(data))
    s_crp = stats_eq(eq_crp, len(data))
    s_mix = stats_eq(eq_mix, len(data))
    print(f'  IND: {s_ind["annual_return_pct"]:.1f}% / DD {s_ind["max_dd_pct"]:.1f}%')
    print(f'  CRP: {s_crp["annual_return_pct"]:.1f}% / DD {s_crp["max_dd_pct"]:.1f}%')
    print(f'  MIX: {s_mix["annual_return_pct"]:.1f}% / DD {s_mix["max_dd_pct"]:.1f}%')

    # Monte-Carlo for each META
    metas = [
        ('META equipondere', {'IND': 1/3, 'CRP': 1/3, 'MIX': 1/3}),
        ('META indices-heavy (50/25/25)', {'IND': 0.50, 'CRP': 0.25, 'MIX': 0.25}),
        ('META crypto-heavy (20/50/30)', {'IND': 0.20, 'CRP': 0.50, 'MIX': 0.30}),
        ('META mixte-heavy (25/25/50)', {'IND': 0.25, 'CRP': 0.25, 'MIX': 0.50}),
    ]

    all_results = {}
    for name, w in metas:
        print(f'\n--- {name} ---')
        # First baseline (no shuffle)
        e_i = eq_ind / eq_ind.iloc[0]
        e_c = eq_crp / eq_crp.iloc[0]
        e_m = eq_mix / eq_mix.iloc[0]
        meta_eq = (w['IND'] * e_i + w['CRP'] * e_c + w['MIX'] * e_m) * 1000
        baseline = stats_eq(meta_eq, len(meta_eq))
        print(f'  Baseline (no shuffle) : Annual {baseline["annual_return_pct"]:.1f}% / DD {baseline["max_dd_pct"]:.1f}%')

        # MC
        mc = monte_carlo_meta(eq_ind, eq_crp, eq_mix, w, n_iters=200, block_len=60)
        print(f'  MC ({mc["n_iters"]} iters) :')
        print(f'    Annual median : {mc["annual_median"]:.1f}%')
        print(f'    Annual P5-P95 : [{mc["annual_p5"]:.1f}% ; {mc["annual_p95"]:.1f}%]')
        print(f'    P(profit) : {mc["p_profit"]*100:.0f}%')
        print(f'    P(>= 15%) : {mc["p_above_15"]*100:.0f}%')
        print(f'    P(>= 20%) : {mc["p_above_20"]*100:.0f}%')
        print(f'    DD median : {mc["dd_median"]:.1f}%')
        print(f'    DD worst : {mc["dd_worst"]:.1f}%')

        verdict = ''
        if mc['p_profit'] >= 0.85 and mc['p_above_15'] >= 0.65 and mc['dd_worst'] >= -60:
            verdict = '*** ROBUSTE ***'
        elif mc['p_profit'] >= 0.7 and mc['p_above_15'] >= 0.5:
            verdict = 'OK'
        else:
            verdict = 'FRAGILE'
        print(f'    Verdict : {verdict}')
        all_results[name] = {'baseline': baseline, 'monte_carlo': mc, 'verdict': verdict}

    out = OUTPUT_DIR / 'lab_meta_mc_validation.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved : {out}')

    # SYNTHESE
    print('\n\n' + '=' * 95)
    print(' VERDICT MC : robustesse META')
    print('=' * 95)
    print(f'{"META":<35}{"AnMed":>8}{"AnP5":>8}{"P(prof)":>10}{"P(>=15)":>10}{"DDworst":>10}{"Verdict":>18}')
    print('-' * 100)
    for name, r in all_results.items():
        mc = r['monte_carlo']
        print(f'  {name:<33}{mc["annual_median"]:>7.1f}%{mc["annual_p5"]:>7.1f}%'
              f'{mc["p_profit"]*100:>9.0f}%{mc["p_above_15"]*100:>9.0f}%'
              f'{mc["dd_worst"]:>9.1f}%{r["verdict"]:>18}')


if __name__ == '__main__':
    main()
