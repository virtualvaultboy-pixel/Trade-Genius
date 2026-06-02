"""
Trade Genius — Lab New Angles

Tester 3 nouvelles approches pour 4eme IA potentielle :
  1. Sector rotation pro : top 3 sectoriels US par momentum 60j
  2. CTA replication : trend following long-only (asset > SMA200 = long)
  3. Gold miners : GDX + NUGT (GDX x2) avec trend filter
"""
import sys, json, warnings
warnings.filterwarnings('ignore')

import pandas as pd
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_meta_mc_validation import run_ia_get_equity, stats_eq, load_alt_data
from lab_hybrid_safe import run_pure_bh, monte_carlo_eq


def run_sector_rotation_pro(data, sectors=None, top_n=3, lookback=60, rebal_days=21,
                              commission=0.0015, slippage=0.0040, initial=1000):
    """Top N sectoriels SPDR par momentum lookback."""
    if sectors is None:
        sectors = ['XLK', 'XLE', 'XLF', 'XLV', 'XLI', 'XLP', 'XLU', 'XLB', 'XLY']
    available = [s for s in sectors if s in data.columns]
    cash = initial
    holdings = {t: 0.0 for t in available}
    peak = initial; max_dd = 0
    eq_series = pd.Series(initial, index=data.index, dtype=float)
    current_top = []
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

        if i in rebal_indices and i >= lookback:
            moms = {}
            for s in available:
                if not pd.isna(data[s].iloc[i]) and not pd.isna(data[s].iloc[i - lookback]):
                    moms[s] = data[s].iloc[i] / data[s].iloc[i - lookback] - 1
            sorted_s = sorted(moms.items(), key=lambda kv: -kv[1])
            top = [s for s, _ in sorted_s[:top_n]]
            weight = 1.0 / max(top_n, 1)

            # Sell removed
            for t in list(holdings.keys()):
                if t in current_top and t not in top:
                    if t in data.columns and not pd.isna(data[t].iloc[i]) and holdings[t] > 0:
                        proceeds = holdings[t] * data[t].iloc[i] * (1 - slippage)
                        fee = proceeds * commission
                        cash += proceeds - fee
                        holdings[t] = 0
            # Buy/adjust top
            for t in top:
                if t not in data.columns or pd.isna(data[t].iloc[i]):
                    continue
                target_val = equity * weight
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
            current_top = top

    return eq_series


def run_cta_replication(data, assets=None, sma_len=200, rebal_days=21,
                         commission=0.0015, slippage=0.0040, initial=1000):
    """CTA-style trend following : long if > SMA200, cash sinon."""
    if assets is None:
        assets = ['SPY', 'EFA', 'TLT', 'GLD', 'DBC']
    available = [a for a in assets if a in data.columns]
    cash = initial
    holdings = {t: 0.0 for t in available}
    peak = initial; max_dd = 0
    eq_series = pd.Series(initial, index=data.index, dtype=float)
    rebal_indices = set(range(0, len(data), rebal_days))

    # Precompute SMA
    sma_dict = {a: data[a].rolling(sma_len).mean() for a in available}

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

        if i in rebal_indices and i >= sma_len:
            # For each asset : long if > SMA200
            in_trend = []
            for a in available:
                if not pd.isna(sma_dict[a].iloc[i]) and not pd.isna(data[a].iloc[i]):
                    if data[a].iloc[i] > sma_dict[a].iloc[i]:
                        in_trend.append(a)
            if not in_trend:
                # All cash : sell everything
                for t in list(holdings.keys()):
                    if t in data.columns and not pd.isna(data[t].iloc[i]) and holdings[t] > 0:
                        proceeds = holdings[t] * data[t].iloc[i] * (1 - slippage)
                        fee = proceeds * commission
                        cash += proceeds - fee
                        holdings[t] = 0
                continue

            weight = 1.0 / len(in_trend)
            # Sell non-trend
            for t in list(holdings.keys()):
                if t not in in_trend and holdings[t] > 0:
                    if t in data.columns and not pd.isna(data[t].iloc[i]):
                        proceeds = holdings[t] * data[t].iloc[i] * (1 - slippage)
                        fee = proceeds * commission
                        cash += proceeds - fee
                        holdings[t] = 0
            # Buy/adjust in-trend
            for t in in_trend:
                if t not in data.columns or pd.isna(data[t].iloc[i]):
                    continue
                target_val = equity * weight
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


def run_gold_miners_lev(data, hedge_pct=0.30, rebal_days=21,
                          commission=0.0015, slippage=0.0040, initial=1000):
    """Gold miners leveraged : NUGT (GDX x2) avec hedge TLT."""
    ticker = 'NUGT' if 'NUGT' in data.columns else 'GDX'
    if ticker not in data.columns:
        return pd.Series(initial, index=data.index, dtype=float)

    weights = {ticker: 1 - hedge_pct, 'TLT': hedge_pct}
    cash = initial
    holdings = {t: 0.0 for t in weights if t in data.columns}
    peak = initial; max_dd = 0
    eq_series = pd.Series(initial, index=data.index, dtype=float)
    rebal_indices = set(range(0, len(data), rebal_days))

    # Trend filter : sortir si GDX < SMA100
    sma = data[ticker].rolling(100).mean()

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

        if i in rebal_indices and i >= 100:
            in_trend = data[ticker].iloc[i] > sma.iloc[i]
            for t in holdings:
                if t not in data.columns or pd.isna(data[t].iloc[i]):
                    continue
                if t == ticker:
                    target_val = equity * weights[ticker] if in_trend else 0
                else:
                    target_val = equity * (weights['TLT'] if in_trend else 0.95)  # full bonds en bear
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


def main():
    print('=' * 95)
    print(' LAB NEW ANGLES - sector rotation pro / CTA replication / gold miners lev')
    print('=' * 95)

    alt_data = load_alt_data()
    universe = ['SPY', 'QQQ', 'IWM', 'EFA', 'VWO', 'TLT', 'IEF', 'GLD', 'DBC', 'XLK',
                'XLE', 'XLF', 'XLV', 'XLI', 'XLP', 'XLU', 'XLB', 'XLY', 'XLRE', 'XLC',
                'BTC-USD', 'ETH-USD', 'SOL-USD', 'TQQQ', 'GDX', 'NUGT']
    eng = LabEngine(universe=universe, start='2014-01-01')
    data = eng.data.loc['2019-09-01':'2026-01-01']
    print(f'Period : {data.index.min().date()} -> {data.index.max().date()}')

    # Test 3 nouvelles strats individuellement
    print('\n--- Test individuel des 3 nouvelles strategies ---')

    print(f'\n{"Strategy":<55}{"Annual":>9}{"DD":>9}{"Calmar":>9}')
    print('-' * 80)

    # Sector rotation top 3 60j
    eq_sec3 = run_sector_rotation_pro(data, top_n=3, lookback=60)
    s = stats_eq(eq_sec3, len(data))
    print(f'  Sector rotation top 3 (60j)        {s["annual_return_pct"]:>7.1f}%{s["max_dd_pct"]:>8.1f}%{s["annual_return_pct"]/max(abs(s["max_dd_pct"]),1):>8.2f}')

    # Sector rotation top 2 90j
    eq_sec2 = run_sector_rotation_pro(data, top_n=2, lookback=90)
    s = stats_eq(eq_sec2, len(data))
    print(f'  Sector rotation top 2 (90j)        {s["annual_return_pct"]:>7.1f}%{s["max_dd_pct"]:>8.1f}%{s["annual_return_pct"]/max(abs(s["max_dd_pct"]),1):>8.2f}')

    # Sector rotation top 4 30j
    eq_sec4 = run_sector_rotation_pro(data, top_n=4, lookback=30)
    s = stats_eq(eq_sec4, len(data))
    print(f'  Sector rotation top 4 (30j)        {s["annual_return_pct"]:>7.1f}%{s["max_dd_pct"]:>8.1f}%{s["annual_return_pct"]/max(abs(s["max_dd_pct"]),1):>8.2f}')

    # CTA replication classic (5 assets)
    eq_cta5 = run_cta_replication(data, assets=['SPY', 'EFA', 'TLT', 'GLD', 'DBC'])
    s = stats_eq(eq_cta5, len(data))
    print(f'  CTA replication 5 assets           {s["annual_return_pct"]:>7.1f}%{s["max_dd_pct"]:>8.1f}%{s["annual_return_pct"]/max(abs(s["max_dd_pct"]),1):>8.2f}')

    # CTA replication 7 assets
    eq_cta7 = run_cta_replication(data, assets=['SPY', 'QQQ', 'IWM', 'EFA', 'TLT', 'GLD', 'DBC'])
    s = stats_eq(eq_cta7, len(data))
    print(f'  CTA replication 7 assets           {s["annual_return_pct"]:>7.1f}%{s["max_dd_pct"]:>8.1f}%{s["annual_return_pct"]/max(abs(s["max_dd_pct"]),1):>8.2f}')

    # CTA with TQQQ
    eq_cta_lev = run_cta_replication(data, assets=['TQQQ', 'EFA', 'TLT', 'GLD', 'DBC'])
    s = stats_eq(eq_cta_lev, len(data))
    print(f'  CTA replication +TQQQ              {s["annual_return_pct"]:>7.1f}%{s["max_dd_pct"]:>8.1f}%{s["annual_return_pct"]/max(abs(s["max_dd_pct"]),1):>8.2f}')

    # Gold miners
    if 'NUGT' in data.columns:
        eq_gold = run_gold_miners_lev(data, hedge_pct=0.30)
        s = stats_eq(eq_gold, len(data))
        print(f'  Gold miners NUGT 70/30 + trend     {s["annual_return_pct"]:>7.1f}%{s["max_dd_pct"]:>8.1f}%{s["annual_return_pct"]/max(abs(s["max_dd_pct"]),1):>8.2f}')

    if 'GDX' in data.columns:
        eq_gdx = run_gold_miners_lev(data.copy(), hedge_pct=0.20)
        s = stats_eq(eq_gdx, len(data))
        print(f'  Gold miners GDX 80/20 + trend      {s["annual_return_pct"]:>7.1f}%{s["max_dd_pct"]:>8.1f}%{s["annual_return_pct"]/max(abs(s["max_dd_pct"]),1):>8.2f}')

    # Test META 4 IAs avec meilleure des nouvelles
    print('\n\n--- Test META 4 IAs (ajouter meilleure nouvelle strat) ---')
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
    eq_ind = run_ia_get_equity(data, ia_cfg['INDICES'], alt_data)
    eq_crp = run_ia_get_equity(data, ia_cfg['CRYPTO'], alt_data)
    eq_mix = run_ia_get_equity(data, ia_cfg['MIXTE'], alt_data)
    eq_bh = run_pure_bh(data, {'SPY': 0.60, 'TLT': 0.30, 'GLD': 0.10})

    # META 3 baseline (mix 50/50)
    eq_meta3 = (1/3 * eq_ind / eq_ind.iloc[0] +
                1/3 * eq_crp / eq_crp.iloc[0] +
                1/3 * eq_mix / eq_mix.iloc[0]) * 1000
    eq_mix3 = (0.5 * eq_bh / eq_bh.iloc[0] + 0.5 * eq_meta3 / eq_meta3.iloc[0]) * 1000
    s3 = stats_eq(eq_mix3, len(data))
    mc3 = monte_carlo_eq(eq_mix3, n_iters=100)

    print(f'\n{"Strategy":<55}{"Annual":>9}{"DD":>9}{"Calmar":>9}{"MC P(prof)":>12}')
    print('-' * 95)
    print(f'  META 3 + BH 50/50 (baseline current) {s3["annual_return_pct"]:>5.1f}%{s3["max_dd_pct"]:>8.1f}%{s3["annual_return_pct"]/max(abs(s3["max_dd_pct"]),1):>8.2f}{mc3["p_profit"]*100:>11.0f}%')

    # Test META 4 avec sector rotation top 3
    candidates = [
        ('sector_top3_60j', eq_sec3),
        ('sector_top2_90j', eq_sec2),
        ('CTA_5assets', eq_cta5),
        ('CTA_7assets', eq_cta7),
        ('CTA+TQQQ', eq_cta_lev),
    ]
    if 'NUGT' in data.columns:
        candidates.append(('GoldMinerNUGT', eq_gold))

    all_results = {'META3_baseline': {'mix50': s3, 'mc': mc3}}
    for name, eq_4th in candidates:
        eq_meta4 = (0.25 * eq_ind / eq_ind.iloc[0] +
                    0.25 * eq_crp / eq_crp.iloc[0] +
                    0.25 * eq_mix / eq_mix.iloc[0] +
                    0.25 * eq_4th / eq_4th.iloc[0]) * 1000
        eq_mix4 = (0.5 * eq_bh / eq_bh.iloc[0] + 0.5 * eq_meta4 / eq_meta4.iloc[0]) * 1000
        s4 = stats_eq(eq_mix4, len(data))
        mc4 = monte_carlo_eq(eq_mix4, n_iters=100)
        print(f'  META 4 ({name}) + BH 50/50          {s4["annual_return_pct"]:>5.1f}%{s4["max_dd_pct"]:>8.1f}%{s4["annual_return_pct"]/max(abs(s4["max_dd_pct"]),1):>8.2f}{mc4["p_profit"]*100:>11.0f}%')
        all_results[f'META4_{name}'] = {'mix50': s4, 'mc': mc4}

    out = OUTPUT_DIR / 'lab_new_angles.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved : {out}')


if __name__ == '__main__':
    main()
