"""
Trade Genius — Lab ML Ensemble (Random Forest sur features techniques)

Apprend a predire si un actif va monter dans les N jours.
Features :
  - momentum 10, 30, 60, 90, 180 jours
  - RSI 14
  - MACD signal
  - Bollinger position
  - ATR / vol annualisee
  - Correlation BTC (60j)
  - Distance to SMA50, SMA200
  - Volume momentum

Target :
  - Return forward 21 jours (1 mois)

Modele :
  - Random Forest (n_estimators=100)
  - Train sur 70% des dates passees, predict sur 30%

Trading rule :
  - Top N predictions par jour
  - Long uniquement si prediction > 0
  - Rebalance hebdo

Validation : walk-forward strict
"""
import sys, os, json, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR

try:
    from sklearn.ensemble import RandomForestRegressor
    from sklearn.preprocessing import StandardScaler
    SKLEARN_OK = True
except ImportError:
    print('Installing scikit-learn...')
    import subprocess
    subprocess.run([sys.executable, '-m', 'pip', 'install', '--quiet', '--user', 'scikit-learn'], check=False)
    from sklearn.ensemble import RandomForestRegressor
    from sklearn.preprocessing import StandardScaler
    SKLEARN_OK = True


def compute_features(prices_full, btc_full, target_days=21):
    """Pour chaque date et actif, calcule un vecteur de features."""
    feats = {}
    assets = prices_full.columns

    # Features par actif
    for asset in assets:
        p = prices_full[asset]
        df = pd.DataFrame(index=p.index)
        # Momentum
        for n in [10, 30, 60, 90, 180]:
            df[f'mom_{n}'] = (p / p.shift(n) - 1) * 100
        # SMA distance
        for n in [50, 200]:
            sma = p.rolling(n).mean()
            df[f'dist_sma_{n}'] = (p / sma - 1) * 100
        # RSI
        delta = p.diff()
        gain = delta.clip(lower=0).rolling(14).mean()
        loss = (-delta.clip(upper=0)).rolling(14).mean()
        df['rsi'] = 100 - 100 / (1 + gain / (loss + 1e-9))
        # MACD
        ema12 = p.ewm(span=12, adjust=False).mean()
        ema26 = p.ewm(span=26, adjust=False).mean()
        df['macd'] = ema12 - ema26
        df['macd_signal_dist'] = (ema12 - ema26).ewm(span=9, adjust=False).mean()
        # Bollinger position
        sma20 = p.rolling(20).mean()
        std20 = p.rolling(20).std()
        df['bb_pos'] = (p - (sma20 - 2 * std20)) / ((sma20 + 2 * std20) - (sma20 - 2 * std20) + 1e-9)
        # Volatility
        df['vol_60'] = p.pct_change().rolling(60).std() * np.sqrt(252) * 100
        # Correlation BTC (utile crypto + risk-off detection)
        if btc_full is not None:
            df['corr_btc'] = p.pct_change().rolling(60).corr(btc_full.pct_change())
        # Target : forward return
        df['target'] = p.shift(-target_days) / p - 1

        feats[asset] = df

    return feats


def train_predict(feats_train, feats_test, asset, target_days=21):
    """
    Entraine sur feats_train[asset], predit sur feats_test[asset].
    Retourne une serie de predictions.
    """
    df_train = feats_train[asset].dropna(subset=['target']).copy()
    df_test = feats_test[asset].copy()

    feature_cols = [c for c in df_train.columns if c != 'target']
    df_train = df_train.dropna(subset=feature_cols)
    if len(df_train) < 100:
        return pd.Series(np.nan, index=df_test.index)

    X = df_train[feature_cols].values
    y = df_train['target'].values

    # Standardize
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    # RF
    rf = RandomForestRegressor(n_estimators=50, max_depth=5, min_samples_leaf=20,
                                n_jobs=-1, random_state=42)
    rf.fit(X_scaled, y)

    # Predict on test
    X_test_full = df_test[feature_cols].copy()
    X_test_clean = X_test_full.fillna(method='ffill').fillna(0).values
    X_test_scaled = scaler.transform(X_test_clean)
    preds = rf.predict(X_test_scaled)
    return pd.Series(preds, index=df_test.index)


def ml_strategy(data_train, data_test, params):
    """ML ensemble strategy : entraine RF par actif, top N selon predictions."""
    p = params
    top_n = p.get('top_n', 5)
    rebal_days = p.get('rebal_days', 7)
    target_days = p.get('target_days', 21)
    btc_filter = p.get('btc_filter', True)
    sma_regime_len = p.get('sma_regime_len', 100)
    regime_asset = p.get('regime_asset', 'SPY')

    from lab_strategies import sma, _empty_signals

    full = pd.concat([data_train, data_test]).drop_duplicates().sort_index()

    # Compute features sur train (pour entrainer) et sur test (pour predire)
    btc_full = full['BTC-USD'] if 'BTC-USD' in full.columns else None
    feats_train = compute_features(data_train, btc_full.loc[data_train.index] if btc_full is not None else None, target_days)
    feats_test = compute_features(data_test, btc_full.loc[data_test.index] if btc_full is not None else None, target_days)

    # Predict for each asset
    predictions = pd.DataFrame(np.nan, index=data_test.index, columns=data_test.columns)
    for asset in data_test.columns:
        try:
            preds = train_predict(feats_train, feats_test, asset, target_days)
            predictions[asset] = preds
        except Exception as e:
            continue

    # Regime filter
    if regime_asset in full.columns and btc_filter:
        regime_sma = sma(full[regime_asset], sma_regime_len).reindex(data_test.index)
        bull = full[regime_asset].reindex(data_test.index) > regime_sma
    else:
        bull = pd.Series(True, index=data_test.index)

    # Trading : top N predictions par rebal day
    size = pd.DataFrame(0.0, index=data_test.index, columns=data_test.columns)
    rebal_dates = data_test.index[::rebal_days]
    for d in rebal_dates:
        if not bull.get(d, False):
            continue
        if d not in predictions.index:
            continue
        preds_d = predictions.loc[d].dropna()
        preds_d = preds_d[preds_d > 0].sort_values(ascending=False)
        top = preds_d.head(top_n).index.tolist()
        for asset in top:
            size.loc[d, asset] = 1.0 / max(top_n, 1)

    # Forward fill
    size = size.where(size > 0).fillna(method='ffill').fillna(0)
    size.loc[~bull] = 0

    entries, exits = _empty_signals(data_test)
    for col in size.columns:
        in_pos = size[col] > 0
        entries[col] = (~in_pos.shift(1).fillna(False)) & in_pos
        exits[col] = in_pos.shift(1).fillna(False) & (~in_pos)
        if in_pos.iloc[0]:
            entries[col].iloc[0] = True

    return entries, exits, size


def run_variant(name, universe, params, years, bench_ticker='SPY', eng_start='2014-01-01'):
    print(f'\n--- {name} ---')
    eng = LabEngine(universe=universe, start=eng_start)

    def strat(dt, ds):
        return ml_strategy(dt, ds, params)

    results = eng.walk_forward_strict(strat, years=years)
    if not results:
        return None

    rets = [m['total_return_pct'] for m in results.values()]
    dds = [m['max_dd_pct'] for m in results.values()]
    n_pos = sum(1 for r in rets if r > 0)
    compound = (np.prod([1 + r / 100 for r in rets]) - 1) * 100
    mean = float(np.mean(rets))
    median = float(np.median(rets))
    wdd = float(min(dds))
    sharpes = [m['sharpe'] for m in results.values() if np.isfinite(m['sharpe'])]
    avg_sharpe = float(np.mean(sharpes)) if sharpes else 0

    bench_rets = []
    for y in years:
        if bench_ticker in eng.data.columns:
            sub = eng.data[bench_ticker].loc[f'{y}-01-01':f'{y + 1}-01-01']
            if len(sub) > 30:
                bench_rets.append((sub.iloc[-1] / sub.iloc[0] - 1) * 100)
    bench_mean = float(np.mean(bench_rets)) if bench_rets else 0

    print(f'  Mean {mean:.1f}%/an | Med {median:.1f}% | Comp {compound:.0f}% | wDD {wdd:.1f}% | {n_pos}/{len(rets)} pos | Sharpe {avg_sharpe:.2f}')
    print(f'  vs {bench_ticker} : Excess {mean - bench_mean:+.1f}%/an')

    return {
        'config': params, 'name': name, 'rets': rets,
        'mean': mean, 'median': median, 'compound': float(compound),
        'worst_dd': wdd, 'n_pos': int(n_pos), 'n_total': len(rets),
        'mean_sharpe': avg_sharpe, 'bench_mean': bench_mean,
        'excess_mean': float(mean - bench_mean),
    }


def main():
    print('=== LAB ML ENSEMBLE (Random Forest) ===')
    print('Features : momentum + RSI + MACD + Bollinger + ATR + correlations + SMA distances\n')

    years_indices = list(range(2018, 2026))
    years_crypto = list(range(2020, 2026))

    indices_univ = [
        'SPY','QQQ','IWM','DIA','EFA','VWO','IEF','TLT','GLD','SLV','DBC','USO',
        'XLK','XLE','XLF','XLV','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA',
        'JPM','V','WMT','UNH','JNJ','PG','KO','XOM',
    ]
    crypto_univ = [
        'BTC-USD','ETH-USD','SOL-USD','AVAX-USD','NEAR-USD','ATOM-USD','DOT-USD','ADA-USD',
        'LINK-USD','UNI-USD','AAVE-USD','MATIC-USD','FET-USD','RNDR-USD','INJ-USD',
        'LTC-USD','BCH-USD','XRP-USD','XLM-USD','DOGE-USD',
    ]

    variants = [
        {
            'name': 'ML_INDICES_top5_weekly',
            'universe': indices_univ,
            'params': {'top_n': 5, 'rebal_days': 7, 'target_days': 21, 'btc_filter': True,
                       'sma_regime_len': 100, 'regime_asset': 'SPY'},
            'years': years_indices, 'bench': 'SPY',
        },
        {
            'name': 'ML_INDICES_top3_monthly',
            'universe': indices_univ,
            'params': {'top_n': 3, 'rebal_days': 21, 'target_days': 21,
                       'sma_regime_len': 200, 'regime_asset': 'SPY'},
            'years': years_indices, 'bench': 'SPY',
        },
        {
            'name': 'ML_CRYPTO_top5_weekly',
            'universe': crypto_univ,
            'params': {'top_n': 5, 'rebal_days': 7, 'target_days': 14,
                       'sma_regime_len': 100, 'regime_asset': 'BTC-USD'},
            'years': years_crypto, 'bench': 'BTC-USD',
        },
        {
            'name': 'ML_CRYPTO_top3_biweekly',
            'universe': crypto_univ,
            'params': {'top_n': 3, 'rebal_days': 14, 'target_days': 14,
                       'sma_regime_len': 150, 'regime_asset': 'BTC-USD'},
            'years': years_crypto, 'bench': 'BTC-USD',
        },
    ]

    all_results = {}
    for v in variants:
        try:
            r = run_variant(v['name'], v['universe'], v['params'], v['years'], v['bench'])
            if r:
                all_results[v['name']] = r
        except Exception as e:
            print(f'  FAILED: {e}')
            import traceback; traceback.print_exc()

    out = OUTPUT_DIR / 'lab_ml_ensemble.json'
    with open(out, 'w') as f:
        json.dump({'results': all_results}, f, indent=2, default=str)
    print(f'\nSaved: {out}')

    print('\n=== RECAP ML ENSEMBLE ===')
    print(f'{"Name":<30}{"Mean":>8}{"DD":>8}{"+pos":>9}{"Sharpe":>8}{"Excess":>9}')
    print('-' * 75)
    for name, r in sorted(all_results.items(), key=lambda kv: -kv[1]['mean']):
        print(f'{name:<30}{r["mean"]:>7.1f}%{r["worst_dd"]:>7.1f}%{r["n_pos"]:>4}/{r["n_total"]}{r["mean_sharpe"]:>8.2f}{r["excess_mean"]:>+8.1f}%')


if __name__ == '__main__':
    main()
