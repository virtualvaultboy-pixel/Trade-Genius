"""
Trade Genius — Lab Multi-Strategy Ensemble

Principe mathématique :
  Si on a N strategies INDEPENDANTES avec mean=m et DD~d,
  l'ensemble equipondéré a mean ~m mais DD reduit de sqrt(N) si correlations ~0.

Strategies decorrelees a combiner :
  S1 : Aggressive Growth (TQQQ + BTC) → bull beta
  S2 : Defensive (TLT + GLD) → bear beta
  S3 : Sector rotation (XLK/XLE/XLF momentum) → diversification sectorielle
  S4 : Crypto rotation (BTC/ETH/SOL momentum) → crypto pure
  S5 : Antonacci-like (best of SPY/EFA/IEF) → trend follow classique
  S6 : Vol carry (TLT + GLD inversed vol) → vol parity
  S7 : Pairs (long XLK short XLU = tech vs utilities) → market neutral

L'ENSEMBLE alloue equipondere chaque mois sur les 7.
"""
import sys, json, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR


def strat_aggressive_growth(data, i):
    """S1 : 50% TQQQ + 30% BTC + 20% TLT."""
    return {'TQQQ': 0.50, 'BTC-USD': 0.30, 'TLT': 0.20}


def strat_defensive(data, i):
    """S2 : 40% TLT + 30% GLD + 30% SHY."""
    return {'TLT': 0.40, 'GLD': 0.30, 'SHY': 0.30}


def strat_sector_rotation(data, i, lookback=60):
    """S3 : top 2 sectoriels par momentum 60j."""
    sectors = ['XLK', 'XLE', 'XLF', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB']
    if i < lookback:
        return {}
    moms = {}
    for s in sectors:
        if s in data.columns and not pd.isna(data[s].iloc[i]) and not pd.isna(data[s].iloc[i - lookback]):
            moms[s] = data[s].iloc[i] / data[s].iloc[i - lookback] - 1
    if not moms:
        return {}
    sorted_s = sorted(moms.items(), key=lambda kv: -kv[1])
    top2 = sorted_s[:2]
    return {s: 0.50 for s, _ in top2}


def strat_crypto_rotation(data, i, lookback=30):
    """S4 : top 2 crypto par momentum 30j."""
    cryptos = ['BTC-USD', 'ETH-USD', 'SOL-USD']
    if i < lookback:
        return {}
    moms = {}
    for c in cryptos:
        if c in data.columns and not pd.isna(data[c].iloc[i]) and not pd.isna(data[c].iloc[i - lookback]):
            moms[c] = data[c].iloc[i] / data[c].iloc[i - lookback] - 1
    if not moms:
        return {}
    # Si tous negatifs : cash via SHY
    if all(m < 0 for m in moms.values()):
        return {'SHY': 1.0} if 'SHY' in data.columns else {}
    sorted_c = sorted(moms.items(), key=lambda kv: -kv[1])
    top2 = sorted_c[:2]
    return {c: 0.50 for c, _ in top2 if c in data.columns}


def strat_antonacci(data, i, lookback=252):
    """S5 : best of SPY/QQQ/EFA momentum 12m, refuge IEF si tous nuls."""
    if i < lookback:
        return {}
    candidates = ['SPY', 'QQQ', 'EFA']
    moms = {}
    for c in candidates:
        if c in data.columns and not pd.isna(data[c].iloc[i]) and not pd.isna(data[c].iloc[i - lookback]):
            moms[c] = data[c].iloc[i] / data[c].iloc[i - lookback] - 1
    if not moms or all(m < 0 for m in moms.values()):
        return {'IEF': 1.0} if 'IEF' in data.columns else {}
    best = max(moms.items(), key=lambda kv: kv[1])
    return {best[0]: 1.0}


def strat_vol_parity(data, i, lookback=60):
    """S6 : inverse-vol weights TLT + GLD + SPY."""
    if i < lookback:
        return {}
    candidates = ['SPY', 'TLT', 'GLD']
    vols = {}
    for c in candidates:
        if c in data.columns:
            rets = data[c].iloc[i - lookback:i].pct_change().dropna()
            v = rets.std() * np.sqrt(252)
            if v > 0:
                vols[c] = v
    if not vols:
        return {}
    inv_vols = {c: 1 / v for c, v in vols.items()}
    total = sum(inv_vols.values())
    return {c: inv_vols[c] / total for c in inv_vols}


def strat_pairs_tech_vs_util(data, i, lookback=60):
    """S7 : long XLK si XLK > XLU (en momentum), sinon court tech."""
    if i < lookback:
        return {}
    if 'XLK' not in data.columns or 'XLU' not in data.columns:
        return {}
    if pd.isna(data['XLK'].iloc[i - lookback]) or pd.isna(data['XLU'].iloc[i - lookback]):
        return {}
    xlk_mom = data['XLK'].iloc[i] / data['XLK'].iloc[i - lookback] - 1
    xlu_mom = data['XLU'].iloc[i] / data['XLU'].iloc[i - lookback] - 1
    if xlk_mom > xlu_mom:
        return {'XLK': 1.0}
    else:
        return {'XLU': 1.0}


STRATEGIES = {
    'S1_aggressive': strat_aggressive_growth,
    'S2_defensive': strat_defensive,
    'S3_sector_rot': strat_sector_rotation,
    'S4_crypto_rot': strat_crypto_rotation,
    'S5_antonacci': strat_antonacci,
    'S6_vol_parity': strat_vol_parity,
    'S7_pairs_tech': strat_pairs_tech_vs_util,
}


def run_ensemble(data, strategies, weights_per_strat=None, rebal_days=21,
                 commission=0.0015, slippage=0.0040, initial=1000):
    """
    Pour chaque strat, calcule l'allocation puis combine equipondere.
    """
    if weights_per_strat is None:
        weights_per_strat = {k: 1.0 / len(strategies) for k in strategies}

    cash = initial
    all_tickers = set(data.columns)
    holdings = {t: 0.0 for t in all_tickers}
    peak = initial
    max_dd = 0
    eq_history = []
    monthly_eq = []
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

        if i in rebal_indices:
            # Compute aggregated target weights
            agg_target = {}
            for name, fn in strategies.items():
                w_strat = weights_per_strat.get(name, 0)
                if w_strat <= 0:
                    continue
                try:
                    alloc = fn(data, i)
                    for t, w in alloc.items():
                        agg_target[t] = agg_target.get(t, 0) + w_strat * w
                except Exception:
                    continue

            # Normalize to 95%
            s = sum(agg_target.values())
            if s > 0:
                agg_target = {t: (w / s) * 0.95 for t, w in agg_target.items()}

            # Rebalance
            for t in holdings:
                if t not in data.columns or pd.isna(data[t].iloc[i]):
                    continue
                target_val = equity * agg_target.get(t, 0)
                current_val = holdings[t] * data[t].iloc[i]
                delta = target_val - current_val
                if abs(delta) < equity * 0.005:
                    continue
                price = data[t].iloc[i]
                if delta > 0:
                    cost = delta * (1 + slippage)
                    fee = cost * commission
                    if cash >= cost + fee:
                        shares = cost / price
                        holdings[t] += shares
                        cash -= cost + fee
                else:
                    proceeds = -delta * (1 - slippage)
                    fee = proceeds * commission
                    shares_to_sell = -delta / price
                    if holdings[t] >= shares_to_sell:
                        holdings[t] -= shares_to_sell
                        cash += proceeds - fee

    final = eq_history[-1]
    total = (final - initial) / initial * 100
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
        'total_return_pct': float(total),
        'max_dd_pct': float(max_dd * 100),
        'worst_monthly': worst_m,
        'final_value': float(final),
    }


def main():
    print('=' * 95)
    print(' LAB MULTI-STRATEGY ENSEMBLE - decorrelation pour reduire DD')
    print('=' * 95)

    universe = ['SPY', 'QQQ', 'IWM', 'EFA', 'IEF', 'TLT', 'GLD', 'SHY',
                'XLK', 'XLE', 'XLF', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB',
                'BTC-USD', 'ETH-USD', 'SOL-USD',
                'TQQQ', 'SPXL']
    eng = LabEngine(universe=universe, start='2010-01-01')
    data = eng.data.loc['2014-01-01':'2026-01-01']  # 12 ans (SOL apparait en 2020 mais ok via ffill)
    print(f'Period : {data.index.min().date()} -> {data.index.max().date()} ({len(data)/252:.1f} ans)')
    print(f'Univers : {len(data.columns)} actifs')

    variants = [
        {
            'name': 'ENSEMBLE 7 strats equipondere',
            'weights': None,  # equiponderation
        },
        {
            'name': 'ENSEMBLE 7 strats - boost aggressive (2x)',
            'weights': {'S1_aggressive': 2.0, 'S2_defensive': 1.0, 'S3_sector_rot': 1.0,
                       'S4_crypto_rot': 1.0, 'S5_antonacci': 1.0, 'S6_vol_parity': 1.0,
                       'S7_pairs_tech': 1.0},
        },
        {
            'name': 'ENSEMBLE 5 (no S6 vol parity, no S7 pairs)',
            'weights': {'S1_aggressive': 1.0, 'S2_defensive': 1.0, 'S3_sector_rot': 1.0,
                       'S4_crypto_rot': 1.0, 'S5_antonacci': 1.0,
                       'S6_vol_parity': 0, 'S7_pairs_tech': 0},
        },
        {
            'name': 'ENSEMBLE risk-on 3 (S1+S3+S4)',
            'weights': {'S1_aggressive': 1.0, 'S3_sector_rot': 1.0, 'S4_crypto_rot': 1.0,
                       'S2_defensive': 0, 'S5_antonacci': 0, 'S6_vol_parity': 0, 'S7_pairs_tech': 0},
        },
        {
            'name': 'ENSEMBLE risk-on agressive (S1 3x + S4 2x + S3)',
            'weights': {'S1_aggressive': 3.0, 'S3_sector_rot': 1.0, 'S4_crypto_rot': 2.0,
                       'S2_defensive': 0, 'S5_antonacci': 0, 'S6_vol_parity': 0, 'S7_pairs_tech': 0},
        },
        {
            'name': 'ENSEMBLE balanced (S1 2x + S2 + S4 + S5)',
            'weights': {'S1_aggressive': 2.0, 'S2_defensive': 1.0, 'S4_crypto_rot': 1.0,
                       'S5_antonacci': 1.0, 'S3_sector_rot': 0, 'S6_vol_parity': 0, 'S7_pairs_tech': 0},
        },
        {
            'name': 'ENSEMBLE 3 strats hi-mom (S1 + S4 + S3)',
            'weights': {'S1_aggressive': 1.0, 'S4_crypto_rot': 1.0, 'S3_sector_rot': 1.0,
                       'S2_defensive': 0, 'S5_antonacci': 0, 'S6_vol_parity': 0, 'S7_pairs_tech': 0},
        },
    ]

    print(f'\n{"Variant":<55}{"Annual":>9}{"DD":>9}{"WorstM":>10}')
    print('-' * 85)
    all_results = {}
    for v in variants:
        try:
            r = run_ensemble(data, STRATEGIES, weights_per_strat=v['weights'])
            print(f'{v["name"][:54]:<55}{r["annual_return_pct"]:>8.1f}%{r["max_dd_pct"]:>8.1f}%{r["worst_monthly"]:>9.1f}%')
            all_results[v['name']] = r
        except Exception as e:
            print(f'{v["name"][:54]:<55} FAILED: {e}')
            import traceback; traceback.print_exc()

    # Test individuelle de chaque strat (pour voir leur perf brute)
    print(f'\n--- PERF INDIVIDUELLE de chaque strat ---')
    for name, fn in STRATEGIES.items():
        try:
            r = run_ensemble(data, {name: fn})
            print(f'  {name:<35}{r["annual_return_pct"]:>8.1f}% | DD {r["max_dd_pct"]:.1f}% | WorstM {r["worst_monthly"]:.1f}%')
        except Exception as e:
            print(f'  {name} FAILED: {e}')

    out = OUTPUT_DIR / 'lab_multistrat.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved : {out}')

    # === VERDICT ===
    print('\n\n' + '=' * 95)
    print(' VERDICT - qui atteint 20%+ AVEC DD <-30% ?')
    print('=' * 95)
    for name, r in sorted(all_results.items(), key=lambda kv: -kv[1]['annual_return_pct']):
        ann = r['annual_return_pct']
        dd = r['max_dd_pct']
        wm = r['worst_monthly']
        if ann >= 20 and dd >= -30:
            verdict = '*** WINNER ***'
        elif ann >= 18 and dd >= -35:
            verdict = 'STRONG'
        elif ann >= 15:
            verdict = 'OK'
        else:
            verdict = 'FAIL'
        print(f'  {name:<55} {ann:>5.1f}% / DD {dd:>5.1f}% / WM {wm:>5.1f}%  {verdict}')


if __name__ == '__main__':
    main()
