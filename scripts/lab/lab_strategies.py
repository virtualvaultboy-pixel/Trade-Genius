"""
Trade Genius — Lab Strategies v1.0

Zoo de stratégies réutilisables pour le lab.
Chaque stratégie est une fonction `strategy_fn(data_train, data_test) -> (entries, exits, size)`.

Conventions :
- `entries` et `exits` : DataFrames booléens (index=dates, columns=tickers)
- `size` : DataFrame de poids cible (None pour size par défaut)
- `data_train` : utilisé pour calibrer paramètres (optionnel, peut être ignoré pour params fixes)
- `data_test` : données sur lesquelles générer les signaux

Stratégies implémentées :
  - bh_btc : Buy & Hold BTC (benchmark)
  - bh_equal : Buy & Hold équipondéré tout l'univers
  - sma200_btc : BTC long si > SMA200, cash sinon (V1)
  - rotation_btc_eth : BTC/ETH rotation selon momentum (V5-rotation-90d)
  - momentum_topN : Top N momentum 30j, rebalance hebdo
  - donchian_breakout : Long si nouveau high 20j
  - dual_momentum : Best momentum entre BTC/ETH/CASH
  - ensemble_3 : Vote majoritaire SMA200 + Donchian + Momentum
"""
import numpy as np
import pandas as pd


# ---------- Helpers ----------

def sma(series, n):
    return series.rolling(n).mean()

def momentum(series, n):
    return series / series.shift(n) - 1


def _empty_signals(data):
    entries = pd.DataFrame(False, index=data.index, columns=data.columns)
    exits = pd.DataFrame(False, index=data.index, columns=data.columns)
    return entries, exits


# ---------- Stratégies ----------

def bh_btc(data_train, data_test):
    """Buy & Hold BTC pur. Benchmark crypto."""
    entries, exits = _empty_signals(data_test)
    if 'BTC-USD' in data_test.columns:
        entries.loc[data_test.index[0], 'BTC-USD'] = True
    size = pd.DataFrame(0.0, index=data_test.index, columns=data_test.columns)
    if 'BTC-USD' in data_test.columns:
        size['BTC-USD'] = 1.0
    return entries, exits, size


def bh_equal(data_train, data_test):
    """Buy & Hold équipondéré tout univers."""
    entries, exits = _empty_signals(data_test)
    entries.iloc[0, :] = True
    n = len(data_test.columns)
    size = pd.DataFrame(1.0 / n, index=data_test.index, columns=data_test.columns)
    return entries, exits, size


def sma200_btc(data_train, data_test, sma_len=200, check_days=7):
    """
    V1 simple : BTC long si > SMA200, cash sinon.
    Concatène train+test pour calculer SMA sans look-ahead (SMA(t) ne dépend que de t-N..t).
    """
    if 'BTC-USD' not in data_test.columns:
        return _empty_signals(data_test) + (None,)

    btc_full = pd.concat([data_train['BTC-USD'], data_test['BTC-USD']]).drop_duplicates()
    sma_full = sma(btc_full, sma_len)
    in_bull_full = btc_full > sma_full
    # Restrict to test period
    in_bull = in_bull_full.reindex(data_test.index).fillna(False)

    # Check seulement tous les check_days (réduit frottements)
    if check_days > 1:
        keep = pd.Series(False, index=in_bull.index)
        keep.iloc[::check_days] = True
        # Régime tenu entre checks
        in_bull_checked = in_bull.where(keep).ffill().fillna(False)
    else:
        in_bull_checked = in_bull

    entries, exits = _empty_signals(data_test)
    # Entry quand on passe False -> True
    entries['BTC-USD'] = (~in_bull_checked.shift(1).fillna(False)) & in_bull_checked
    exits['BTC-USD'] = in_bull_checked.shift(1).fillna(False) & (~in_bull_checked)
    # First true entry
    if in_bull_checked.iloc[0]:
        entries['BTC-USD'].iloc[0] = True

    size = pd.DataFrame(0.0, index=data_test.index, columns=data_test.columns)
    size['BTC-USD'] = in_bull_checked.astype(float)
    return entries, exits, size


def rotation_btc_eth(data_train, data_test, sma_len=200, mom_lookback=90, check_days=7, mom_threshold=0.05):
    """
    V5-rotation-90d : BTC/ETH selon momentum, cash si bear BTC.
    """
    if 'BTC-USD' not in data_test.columns or 'ETH-USD' not in data_test.columns:
        return _empty_signals(data_test) + (None,)

    btc_full = pd.concat([data_train['BTC-USD'], data_test['BTC-USD']]).drop_duplicates().sort_index()
    eth_full = pd.concat([data_train['ETH-USD'], data_test['ETH-USD']]).drop_duplicates().sort_index()

    btc_sma = sma(btc_full, sma_len)
    btc_mom = momentum(btc_full, mom_lookback)
    eth_mom = momentum(eth_full, mom_lookback)

    in_bull_full = btc_full > btc_sma
    # Asset cible : 'BTC' ou 'ETH' selon momentum (besoin écart > threshold pour switcher)
    eth_better = (eth_mom - btc_mom) > mom_threshold
    target_full = pd.Series('CASH', index=btc_full.index)
    target_full[in_bull_full & eth_better] = 'ETH-USD'
    target_full[in_bull_full & ~eth_better] = 'BTC-USD'

    target = target_full.reindex(data_test.index).fillna(method='ffill').fillna('CASH')

    # Check seulement tous les check_days
    if check_days > 1:
        keep_mask = pd.Series(False, index=target.index)
        keep_mask.iloc[::check_days] = True
        target = target.where(keep_mask).fillna(method='ffill').fillna('CASH')

    # Construire entries/exits/size
    entries, exits = _empty_signals(data_test)
    size = pd.DataFrame(0.0, index=data_test.index, columns=data_test.columns)
    for asset in ['BTC-USD', 'ETH-USD']:
        is_target = (target == asset)
        size[asset] = is_target.astype(float)
        # Entry : transition False -> True
        entries[asset] = (~is_target.shift(1).fillna(False)) & is_target
        if is_target.iloc[0]:
            entries[asset].iloc[0] = True
        exits[asset] = is_target.shift(1).fillna(False) & (~is_target)

    return entries, exits, size


def momentum_topN(data_train, data_test, mom_lookback=30, top_n=3, rebal_days=7, btc_filter=True, sma_len=60):
    """
    Top N actifs par momentum N jours, rebalance hebdo.
    Avec filtre BTC : si BTC < SMA60, on reste cash.
    """
    full = pd.concat([data_train, data_test]).drop_duplicates().sort_index()
    mom = momentum(full, mom_lookback).reindex(data_test.index)

    # BTC filter
    if btc_filter and 'BTC-USD' in full.columns:
        btc_sma = sma(full['BTC-USD'], sma_len).reindex(data_test.index)
        bull = full['BTC-USD'].reindex(data_test.index) > btc_sma
    else:
        bull = pd.Series(True, index=data_test.index)

    # Pour chaque date, top N par momentum
    size = pd.DataFrame(0.0, index=data_test.index, columns=data_test.columns)
    # Rebalance days
    rebal_dates = data_test.index[::rebal_days]
    for d in rebal_dates:
        if not bull.get(d, False):
            continue
        mom_d = mom.loc[d].dropna().sort_values(ascending=False)
        top = mom_d.head(top_n).index.tolist()
        for asset in top:
            size.loc[d, asset] = 1.0 / top_n
    # Forward fill positions between rebalances
    size = size.where(size > 0).fillna(method='ffill').fillna(0)
    # Reset à 0 hors bull
    size.loc[~bull, :] = 0

    entries, exits = _empty_signals(data_test)
    for col in size.columns:
        in_pos = size[col] > 0
        entries[col] = (~in_pos.shift(1).fillna(False)) & in_pos
        exits[col] = in_pos.shift(1).fillna(False) & (~in_pos)
        if in_pos.iloc[0]:
            entries[col].iloc[0] = True

    return entries, exits, size


def donchian_breakout(data_train, data_test, lookback=20, trail_pct=15, max_hold=30, top_n=3):
    """
    Turtle Traders : long sur nouveau high N jours.
    """
    full = pd.concat([data_train, data_test]).drop_duplicates().sort_index()
    high_n = full.rolling(lookback).max().shift(1)  # high antérieur (pas look-ahead)
    high_n = high_n.reindex(data_test.index)

    breakout = data_test > high_n

    size = pd.DataFrame(0.0, index=data_test.index, columns=data_test.columns)
    # Pour chaque date : prendre les top_n breakouts, équipondérés
    for d in data_test.index:
        bo = breakout.loc[d]
        signals = bo[bo].index.tolist()[:top_n]
        for asset in signals:
            size.loc[d, asset] = 1.0 / top_n
    # Hold positions jusqu'à trailing stop ou max_hold
    # Approximation : forward fill avec décroissance après max_hold
    size_held = size.copy()
    for col in size.columns:
        last_entry = -np.inf
        for i, d in enumerate(data_test.index):
            if size.loc[d, col] > 0:
                last_entry = i
                size_held.loc[d, col] = size.loc[d, col]
            elif i - last_entry <= max_hold:
                size_held.loc[d, col] = size_held.iloc[i - 1][col] if i > 0 else 0
            else:
                size_held.loc[d, col] = 0
    size = size_held

    # Trailing stop simple : si prix < high peak * (1 - trail_pct/100) depuis entry, sortir
    # (approx — vectorbt gère mieux nativement mais on garde simple ici)
    entries, exits = _empty_signals(data_test)
    for col in size.columns:
        in_pos = size[col] > 0
        entries[col] = (~in_pos.shift(1).fillna(False)) & in_pos
        exits[col] = in_pos.shift(1).fillna(False) & (~in_pos)
        if in_pos.iloc[0]:
            entries[col].iloc[0] = True

    return entries, exits, size


def dual_momentum(data_train, data_test, mom_lookback=90, check_days=7):
    """
    Antonacci Dual Momentum simplifié : prendre l'actif avec le meilleur momentum,
    SI son momentum > 0 (sinon cash).
    """
    full = pd.concat([data_train, data_test]).drop_duplicates().sort_index()
    mom = momentum(full, mom_lookback).reindex(data_test.index)

    size = pd.DataFrame(0.0, index=data_test.index, columns=data_test.columns)
    for i, d in enumerate(data_test.index):
        if i % check_days != 0 and i != 0:
            # Hold last
            if i > 0:
                size.iloc[i] = size.iloc[i - 1]
            continue
        mom_d = mom.loc[d]
        best = mom_d.idxmax() if mom_d.max() > 0 else None
        if best is not None:
            size.loc[d, best] = 1.0

    entries, exits = _empty_signals(data_test)
    for col in size.columns:
        in_pos = size[col] > 0
        entries[col] = (~in_pos.shift(1).fillna(False)) & in_pos
        exits[col] = in_pos.shift(1).fillna(False) & (~in_pos)
        if in_pos.iloc[0]:
            entries[col].iloc[0] = True

    return entries, exits, size


def momentum_safe(data_train, data_test, mom_lookback=30, top_n=3, rebal_days=14,
                  sma_len=100, stop_pct=15, min_mom_pct=5):
    """
    momentum_topN SAFE : BTC filter SMA100 + min momentum + stop loss + rebal moins fréquent.
    Objectif : réduire la variance, limiter pertes en bears.
    """
    full = pd.concat([data_train, data_test]).drop_duplicates().sort_index()
    mom = momentum(full, mom_lookback).reindex(data_test.index)

    # BTC filter
    if 'BTC-USD' in full.columns:
        btc_sma = sma(full['BTC-USD'], sma_len).reindex(data_test.index)
        bull = full['BTC-USD'].reindex(data_test.index) > btc_sma
    else:
        bull = pd.Series(True, index=data_test.index)

    # Stop loss tracking : reset à chaque entry
    size = pd.DataFrame(0.0, index=data_test.index, columns=data_test.columns)
    entry_price = pd.DataFrame(np.nan, index=data_test.index, columns=data_test.columns)
    current_top = []

    rebal_dates = data_test.index[::rebal_days]
    for i, d in enumerate(data_test.index):
        prev_size = size.iloc[i - 1] if i > 0 else pd.Series(0.0, index=data_test.columns)
        # Carry positions
        size.iloc[i] = prev_size.copy()
        entry_price.iloc[i] = entry_price.iloc[i - 1] if i > 0 else entry_price.iloc[i]

        # Check stop loss sur positions ouvertes
        for col in data_test.columns:
            if size.iloc[i].get(col, 0) > 0 and not pd.isna(entry_price.iloc[i].get(col, np.nan)):
                ep = entry_price.iloc[i][col]
                curr = data_test.iloc[i][col]
                if not pd.isna(ep) and not pd.isna(curr):
                    pnl_pct = (curr - ep) / ep * 100
                    if pnl_pct < -stop_pct:
                        # Stop hit
                        size.iloc[i, size.columns.get_loc(col)] = 0
                        entry_price.iloc[i, entry_price.columns.get_loc(col)] = np.nan

        # Rebalance day ?
        if d in rebal_dates:
            if not bull.get(d, False):
                # Bear : tout vendre
                size.iloc[i] = 0
                entry_price.iloc[i] = np.nan
                current_top = []
            else:
                mom_d = mom.loc[d].dropna()
                mom_d = mom_d[mom_d > min_mom_pct / 100]  # min momentum threshold
                top = mom_d.sort_values(ascending=False).head(top_n).index.tolist()
                # Vendre les sortis
                for col in current_top:
                    if col not in top:
                        size.iloc[i, size.columns.get_loc(col)] = 0
                        entry_price.iloc[i, entry_price.columns.get_loc(col)] = np.nan
                # Acheter les nouveaux
                for col in top:
                    if col not in current_top:
                        size.iloc[i, size.columns.get_loc(col)] = 1.0 / max(top_n, 1)
                        entry_price.iloc[i, entry_price.columns.get_loc(col)] = data_test.iloc[i][col]
                    else:
                        # Normalize size si nb varie
                        size.iloc[i, size.columns.get_loc(col)] = 1.0 / max(len(top), 1)
                current_top = top

    entries, exits = _empty_signals(data_test)
    for col in size.columns:
        in_pos = size[col] > 0
        entries[col] = (~in_pos.shift(1).fillna(False)) & in_pos
        exits[col] = in_pos.shift(1).fillna(False) & (~in_pos)
        if in_pos.iloc[0]:
            entries[col].iloc[0] = True

    return entries, exits, size


def ensemble_majority(data_train, data_test):
    """
    Ensemble : vote majoritaire entre sma200_btc, momentum_safe (top3), dual_momentum.
    Long un actif si >= 2 stratégies le détiennent.
    """
    sigs = []
    for fn in [lambda dt, ds: sma200_btc(dt, ds),
               lambda dt, ds: momentum_safe(dt, ds),
               lambda dt, ds: dual_momentum(dt, ds, mom_lookback=60, check_days=7)]:
        _, _, sz = fn(data_train, data_test)
        sigs.append((sz > 0).astype(int))

    votes = sum(sigs)
    target = (votes >= 2).astype(float)

    # Normaliser à 100% du capital
    row_sum = target.sum(axis=1)
    size = target.div(row_sum.replace(0, 1), axis=0)

    entries, exits = _empty_signals(data_test)
    for col in size.columns:
        in_pos = size[col] > 0
        entries[col] = (~in_pos.shift(1).fillna(False)) & in_pos
        exits[col] = in_pos.shift(1).fillna(False) & (~in_pos)
        if in_pos.iloc[0]:
            entries[col].iloc[0] = True

    return entries, exits, size


# Registry
STRATEGIES = {
    'bh_btc': bh_btc,
    'bh_equal': bh_equal,
    'sma200_btc': sma200_btc,
    'rotation_btc_eth': rotation_btc_eth,
    'momentum_topN': momentum_topN,
    'momentum_safe': momentum_safe,
    'donchian_breakout': donchian_breakout,
    'dual_momentum': dual_momentum,
    'ensemble_majority': ensemble_majority,
}
