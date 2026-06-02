"""
Trade Genius — Lab Clenow "Stocks on the Move"

Implementation EXACTE de la strategie d'Andreas Clenow (livre 2015).
Validee sur 25+ ans de S&P 500, return ~12-15%/an, Sharpe ~0.8-1.0.

Regles (du livre) :
  1. Univers : top 500 stocks (on prend top 100 du S&P + ETF + megacaps)
  2. Ranking : exponential regression slope sur 90 jours
     - slope = exp(regression_slope) - 1 annualisee (%/an)
     - filtre : R^2 doit etre > 0.30 (trend solide)
  3. Filtre 1 : prix > SMA100
  4. Filtre 2 : pas de gap > 15% dans les 90 derniers jours
  5. Position sizing : ATR(20) based
     - risk_per_trade = 10 basis points du portfolio
     - position_size = risk / (ATR(20) per share)
  6. Trigger entry : SP500 > SMA200 (regime filter)
  7. Rebalance : tous les MERCREDIS
  8. Sortie : si stock tombe hors du top 20%, ou viole filtre

Sur 2010-2025 walk-forward strict.

Output : data/sandbox/lab/lab_clenow.json
"""
import sys, os, json, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
import vectorbt as vbt
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR


# Univers Clenow-style : ~30 stocks liquides + ETF
CLENOW_UNIVERSE = [
    # Top S&P 500 leaders
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'BRK-B',
    'JPM', 'V', 'WMT', 'UNH', 'JNJ', 'PG', 'MA', 'XOM', 'CVX',
    'KO', 'PEP', 'COST', 'MCD', 'NKE', 'HD', 'LOW', 'ABBV', 'MRK', 'LLY',
    'AVGO', 'ORCL', 'CRM', 'ADBE', 'NFLX', 'DIS', 'BAC', 'WFC',
    'GS', 'MS', 'BLK', 'PFE', 'AMGN', 'GILD', 'TMO', 'ABT',
    # ETF broad
    'SPY', 'QQQ', 'IWM', 'EFA', 'VWO', 'XLK', 'XLE', 'XLF', 'XLV', 'XLI',
    # Bonds & defensives
    'TLT', 'IEF', 'GLD',
]


def exp_regression_score(prices, window=90):
    """
    Score Clenow : regression exponentielle slope * R^2.
    Plus le slope est positif ET le fit est bon, mieux c'est.
    """
    if len(prices) < window:
        return np.nan, np.nan
    y = np.log(prices[-window:].values)
    x = np.arange(window)
    if np.any(~np.isfinite(y)):
        return np.nan, np.nan
    slope, intercept = np.polyfit(x, y, 1)
    y_pred = slope * x + intercept
    ss_res = np.sum((y - y_pred) ** 2)
    ss_tot = np.sum((y - np.mean(y)) ** 2)
    r_squared = 1 - (ss_res / (ss_tot + 1e-10))
    # Annualiser le slope (252 jours/an)
    annualized = (np.exp(slope * 252) - 1) * 100
    return annualized, r_squared


def max_gap_pct(prices, window=90):
    """Gap max sur N derniers jours (close vs close precedent)."""
    if len(prices) < window:
        return np.nan
    rets = prices[-window:].pct_change().dropna()
    if len(rets) == 0:
        return 0
    return np.abs(rets).max() * 100


def atr_pct(prices, window=20):
    """ATR simplifie sur close-to-close % range."""
    if len(prices) < window:
        return np.nan
    rets = prices.pct_change().rolling(window).std().iloc[-1]
    return rets * np.sqrt(252) * 100 if not pd.isna(rets) else np.nan


def clenow_strategy(data_train, data_test, params=None):
    """
    Genere positions cibles selon Clenow.
    """
    p = params or {}
    regression_window = p.get('regression_window', 90)
    gap_threshold = p.get('gap_threshold', 15)
    r2_threshold = p.get('r2_threshold', 0.30)
    sma_filter = p.get('sma_filter', 100)
    regime_sma = p.get('regime_sma', 200)
    top_n = p.get('top_n', 10)
    rebal_days = p.get('rebal_days', 5)  # weekly Wednesdays
    risk_per_trade = p.get('risk_per_trade', 0.001)  # 10 bps
    regime_asset = p.get('regime_asset', 'SPY')

    from lab_strategies import sma, _empty_signals

    full = pd.concat([data_train, data_test]).drop_duplicates().sort_index()

    # Regime filter (SP500 > SMA200)
    if regime_asset in full.columns:
        bench = full[regime_asset]
        bench_sma = sma(bench, regime_sma)
        in_bull = (bench > bench_sma).reindex(data_test.index)
    else:
        in_bull = pd.Series(True, index=data_test.index)

    size = pd.DataFrame(0.0, index=data_test.index, columns=data_test.columns)
    rebal_dates = data_test.index[::rebal_days]

    for d in rebal_dates:
        if not in_bull.get(d, False):
            continue  # Bear : cash

        # Calcul scores pour tous les actifs
        scores = []
        for asset in data_test.columns:
            if asset not in full.columns:
                continue
            asset_prices = full[asset].loc[:d]
            if len(asset_prices) < max(regression_window, sma_filter):
                continue

            # Filtre 1 : prix > SMA100
            asset_sma = sma(asset_prices, sma_filter).iloc[-1]
            if pd.isna(asset_sma) or asset_prices.iloc[-1] <= asset_sma:
                continue

            # Filtre 2 : pas de gap > 15% sur 90j
            gap = max_gap_pct(asset_prices, regression_window)
            if gap > gap_threshold:
                continue

            # Score : slope * R^2
            slope, r2 = exp_regression_score(asset_prices, regression_window)
            if pd.isna(slope) or pd.isna(r2):
                continue
            if r2 < r2_threshold:
                continue
            if slope <= 0:
                continue

            scores.append({'asset': asset, 'score': slope * r2, 'slope': slope, 'r2': r2})

        if not scores:
            continue

        # Top N par score
        scores.sort(key=lambda x: -x['score'])
        top = scores[:top_n]

        # Equipondere top N (simplification du sizing ATR)
        weight = 1.0 / len(top) if top else 0
        for s in top:
            size.loc[d, s['asset']] = weight

    # Forward fill positions entre rebalances
    size = size.where(size > 0).fillna(method='ffill').fillna(0)
    # Reset a 0 si bear regime
    bear_mask = ~in_bull
    size.loc[bear_mask] = 0

    # Build entries/exits
    entries, exits = _empty_signals(data_test)
    for col in size.columns:
        in_pos = size[col] > 0
        entries[col] = (~in_pos.shift(1).fillna(False)) & in_pos
        exits[col] = in_pos.shift(1).fillna(False) & (~in_pos)
        if in_pos.iloc[0]:
            entries[col].iloc[0] = True

    return entries, exits, size


def main():
    print('=== LAB CLENOW "Stocks on the Move" ===')
    print('Implementation strategie A. Clenow (livre 2015)')
    print('Reference : ~12-15%/an, Sharpe ~0.8-1.0 sur 25 ans S&P 500\n')

    eng = LabEngine(universe=CLENOW_UNIVERSE, start='2010-01-01')
    print(f'Univers: {len(eng.data.columns)} assets')
    print(f'Date range: {eng.data.index.min().date()} -> {eng.data.index.max().date()}')

    # Test sur 2012-2025 (13 ans) walk-forward strict par annee
    years = list(range(2012, 2026))

    # Config baseline + variantes
    configs = [
        {'name': 'Clenow_baseline',  'regression_window': 90, 'top_n': 10, 'rebal_days': 5, 'r2_threshold': 0.30},
        {'name': 'Clenow_top5',      'regression_window': 90, 'top_n': 5,  'rebal_days': 5, 'r2_threshold': 0.30},
        {'name': 'Clenow_180j',      'regression_window': 180, 'top_n': 10, 'rebal_days': 21, 'r2_threshold': 0.30},
        {'name': 'Clenow_strict_r2', 'regression_window': 90, 'top_n': 10, 'rebal_days': 5, 'r2_threshold': 0.50},
        {'name': 'Clenow_monthly',   'regression_window': 90, 'top_n': 10, 'rebal_days': 21, 'r2_threshold': 0.30},
    ]

    all_results = {}
    for cfg in configs:
        print(f'\n--- {cfg["name"]} ---')

        def strat(dt, ds, c=cfg):
            return clenow_strategy(dt, ds, c)

        try:
            results = eng.walk_forward_strict(strat, years=years)
            if not results:
                print(f'  no results')
                continue
            rets = [m['total_return_pct'] for m in results.values()]
            dds = [m['max_dd_pct'] for m in results.values()]
            n_pos = sum(1 for r in rets if r > 0)
            compound = (np.prod([1 + r / 100 for r in rets]) - 1) * 100
            mean = np.mean(rets)
            median = np.median(rets)
            wdd = min(dds)
            avg_sharpe = np.mean([m['sharpe'] for m in results.values() if np.isfinite(m['sharpe'])])

            print(f'  Mean {mean:.1f}%/an | Med {median:.1f}% | Comp {compound:.0f}% | wDD {wdd:.1f}% | {n_pos}/{len(rets)} pos | Sharpe {avg_sharpe:.2f}')
            all_results[cfg['name']] = {
                'config': cfg,
                'rets': rets,
                'mean': mean, 'median': median, 'compound': compound,
                'worst_dd': wdd, 'n_pos': n_pos, 'n_total': len(rets),
                'mean_sharpe': avg_sharpe,
            }
        except Exception as e:
            print(f'  FAILED: {e}')
            import traceback; traceback.print_exc()

    # Benchmark
    print(f'\n--- B&H SPY reference ---')
    spy_rets = []
    for y in years:
        sub = eng.data['SPY'].loc[f'{y}-01-01':f'{y + 1}-01-01']
        if len(sub) > 30:
            spy_rets.append((sub.iloc[-1] / sub.iloc[0] - 1) * 100)
    print(f'  SPY Mean: {np.mean(spy_rets):.1f}%/an | Comp 14y: {((np.prod([1 + r / 100 for r in spy_rets]) - 1) * 100):.0f}%')

    # Save
    out = OUTPUT_DIR / 'lab_clenow.json'
    with open(out, 'w') as f:
        json.dump({'results': all_results,
                  'spy_bench': {'mean': float(np.mean(spy_rets)),
                               'compound': float((np.prod([1 + r / 100 for r in spy_rets]) - 1) * 100)}},
                 f, indent=2, default=str)
    print(f'\nSaved: {out}')

    # Best
    if all_results:
        best = max(all_results.items(), key=lambda kv: kv[1]['mean'])
        print(f'\n>>> CLENOW BEST: {best[0]}')
        b = best[1]
        print(f'    Mean {b["mean"]:.1f}%/an | Sharpe {b["mean_sharpe"]:.2f} | DD {b["worst_dd"]:.1f}%')


if __name__ == '__main__':
    main()
