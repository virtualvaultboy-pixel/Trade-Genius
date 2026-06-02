"""
Trade Genius — Lab Alt Data Collector (TOUT GRATUIT)

Agregateur de donnees alternatives FREE :
  1. Funding rates Binance futures (BTC, ETH)
  2. Fear & Greed Index crypto (alternative.me)
  3. VIX + yield curve (FRED St-Louis Fed)
  4. On-chain BTC (blockchain.info)
  5. SEC EDGAR insider trades (Form 4 scraping)
  6. Reddit sentiment crypto (snscrape ou json public)

Toutes ces APIs sont 100% gratuites.

Output : data/sandbox/lab/alt_data/*.csv
"""
import sys, os, json, warnings
warnings.filterwarnings('ignore')

import requests
import pandas as pd
import numpy as np
from pathlib import Path
from datetime import datetime, timedelta
import time

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import OUTPUT_DIR

ALT_DATA_DIR = OUTPUT_DIR / 'alt_data'
ALT_DATA_DIR.mkdir(parents=True, exist_ok=True)


def fetch_binance_funding(symbol='BTCUSDT', start='2019-01-01'):
    """
    Funding rates Binance futures (historique).
    API : https://fapi.binance.com/fapi/v1/fundingRate
    Limit : 1000 records par requete. Free, no auth.
    """
    print(f'\n--- Binance funding rates {symbol} ---')
    url = 'https://fapi.binance.com/fapi/v1/fundingRate'
    all_data = []
    start_ms = int(pd.Timestamp(start).timestamp() * 1000)
    end_ms = int(datetime.now().timestamp() * 1000)

    while start_ms < end_ms:
        params = {
            'symbol': symbol,
            'startTime': start_ms,
            'limit': 1000,
        }
        try:
            r = requests.get(url, params=params, timeout=15)
            data = r.json()
            if not data or 'msg' in str(data):
                print(f'  ERR: {data}')
                break
            for d in data:
                all_data.append({
                    'date': pd.Timestamp(d['fundingTime'], unit='ms'),
                    'funding_rate': float(d['fundingRate']),
                    'symbol': symbol,
                })
            if len(data) < 1000:
                break
            last_time = data[-1]['fundingTime']
            start_ms = last_time + 1
            time.sleep(0.5)  # rate limit
        except Exception as e:
            print(f'  Exception: {e}')
            break

    if all_data:
        df = pd.DataFrame(all_data)
        df = df.set_index('date').sort_index()
        out = ALT_DATA_DIR / f'funding_{symbol.lower()}.csv'
        df.to_csv(out)
        print(f'  Saved {len(df)} records to {out}')
        print(f'  Stats : mean {df["funding_rate"].mean() * 100:.3f}% | max {df["funding_rate"].max() * 100:.3f}% | min {df["funding_rate"].min() * 100:.3f}%')
        return df
    return None


def fetch_fear_greed_crypto():
    """
    Fear & Greed Index crypto (alternative.me).
    API : https://api.alternative.me/fng/?limit=0
    Free, no auth.
    """
    print('\n--- Fear & Greed crypto ---')
    url = 'https://api.alternative.me/fng/'
    params = {'limit': 0}  # all history
    try:
        r = requests.get(url, params=params, timeout=15)
        j = r.json()
        if 'data' not in j:
            print(f'  No data: {j}')
            return None
        records = []
        for d in j['data']:
            records.append({
                'date': pd.Timestamp(int(d['timestamp']), unit='s'),
                'fng_value': int(d['value']),
                'fng_classification': d['value_classification'],
            })
        df = pd.DataFrame(records).set_index('date').sort_index()
        out = ALT_DATA_DIR / 'fear_greed_crypto.csv'
        df.to_csv(out)
        print(f'  Saved {len(df)} records to {out}')
        print(f'  Latest : {df["fng_value"].iloc[-1]} ({df["fng_classification"].iloc[-1]})')
        print(f'  Mean : {df["fng_value"].mean():.1f}')
        return df
    except Exception as e:
        print(f'  Exception: {e}')
        return None


def fetch_fred(series_id, start='2010-01-01'):
    """
    FRED St-Louis Fed API (gratuit, pas d'auth).
    Series populaires :
      - VIXCLS : VIX
      - DGS10 : 10-year treasury yield
      - DGS2 : 2-year treasury yield
      - T10Y2Y : 10y - 2y (yield curve inversion)
      - DCOILWTICO : WTI oil
      - DEXUSEU : EUR/USD
      - WALCL : Fed balance sheet
    """
    print(f'\n--- FRED {series_id} ---')
    url = f'https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}&cosd={start}'
    try:
        r = requests.get(url, timeout=15)
        if r.status_code != 200:
            print(f'  HTTP {r.status_code}')
            return None
        from io import StringIO
        df = pd.read_csv(StringIO(r.text))
        # Normalize columns
        df.columns = ['date', series_id]
        df['date'] = pd.to_datetime(df['date'])
        df = df.set_index('date')
        df[series_id] = pd.to_numeric(df[series_id], errors='coerce')
        df = df.dropna()
        out = ALT_DATA_DIR / f'fred_{series_id}.csv'
        df.to_csv(out)
        print(f'  Saved {len(df)} records to {out}')
        print(f'  Latest {series_id} : {df[series_id].iloc[-1]:.2f}')
        return df
    except Exception as e:
        print(f'  Exception: {e}')
        return None


def fetch_blockchain_info_metric(metric='market-cap', start='2010-01-01'):
    """
    blockchain.info API (gratuit, no auth).
    Metrics dispos :
      - market-cap : Bitcoin total market cap
      - hash-rate : BTC network hash rate
      - n-transactions : transactions per day
      - n-unique-addresses : unique addresses per day
      - mempool-size : mempool size
      - mempool-count : mempool tx count
      - total-bitcoins : circulating supply
      - estimated-transaction-volume-usd : tx volume USD
    """
    print(f'\n--- blockchain.info {metric} ---')
    url = f'https://api.blockchain.info/charts/{metric}'
    params = {
        'timespan': 'all',
        'format': 'json',
        'cors': 'true',
    }
    try:
        r = requests.get(url, params=params, timeout=15)
        if r.status_code != 200:
            print(f'  HTTP {r.status_code}')
            return None
        j = r.json()
        values = j.get('values', [])
        if not values:
            print(f'  no data')
            return None
        df = pd.DataFrame(values)
        df['date'] = pd.to_datetime(df['x'], unit='s')
        df[metric] = df['y']
        df = df.set_index('date')[[metric]]
        out = ALT_DATA_DIR / f'btc_{metric}.csv'
        df.to_csv(out)
        print(f'  Saved {len(df)} records to {out}')
        print(f'  Latest {metric} : {df[metric].iloc[-1]:.2e}')
        return df
    except Exception as e:
        print(f'  Exception: {e}')
        return None


def fetch_coingecko_btc_dominance():
    """
    BTC dominance via CoinGecko (free, no auth).
    Indicateur quand BTC.D monte = altcoins faibles (et inverse).
    """
    print(f'\n--- CoinGecko BTC dominance ---')
    url = 'https://api.coingecko.com/api/v3/global'
    try:
        r = requests.get(url, timeout=15)
        j = r.json()
        if 'data' in j:
            mc_pct = j['data'].get('market_cap_percentage', {})
            btc_d = mc_pct.get('btc', 0)
            print(f'  Current BTC dominance : {btc_d:.1f}%')
            return btc_d
    except Exception as e:
        print(f'  Exception: {e}')
    return None


def fetch_sec_form4_recent(ticker='AAPL', days=90):
    """
    Form 4 SEC EDGAR (insider trades) via scraping.
    Pas d'historique long mais info recent insider buys.
    """
    print(f'\n--- SEC Form 4 insider trades {ticker} (last {days}j) ---')
    url = f'https://www.sec.gov/cgi-bin/browse-edgar'
    params = {
        'action': 'getcompany',
        'CIK': ticker,
        'type': '4',
        'dateb': '',
        'owner': 'include',
        'count': '40',
    }
    headers = {'User-Agent': 'Trade Genius Lab research@tradegenius.local'}
    try:
        r = requests.get(url, params=params, headers=headers, timeout=15)
        # Parsing simple : compter occurrences "Form 4"
        if r.status_code == 200:
            content = r.text
            n_form4 = content.count('Form 4')
            print(f'  {n_form4} Form 4 references in latest filings')
            return n_form4
        else:
            print(f'  HTTP {r.status_code}')
    except Exception as e:
        print(f'  Exception: {e}')
    return None


def main():
    print('=' * 90)
    print(' LAB ALT DATA COLLECTOR - 100% GRATUIT')
    print('=' * 90)

    # 1. Funding rates (BTC, ETH)
    fetch_binance_funding('BTCUSDT', start='2019-09-01')
    fetch_binance_funding('ETHUSDT', start='2019-12-01')

    # 2. Fear & Greed
    fetch_fear_greed_crypto()

    # 3. FRED macro
    fetch_fred('VIXCLS')  # VIX
    fetch_fred('DGS10')   # 10y treasury
    fetch_fred('DGS2')    # 2y treasury
    fetch_fred('T10Y2Y')  # yield curve
    fetch_fred('DCOILWTICO')  # WTI oil
    fetch_fred('WALCL')   # Fed balance sheet

    # 4. On-chain BTC
    fetch_blockchain_info_metric('market-cap')
    fetch_blockchain_info_metric('hash-rate')
    fetch_blockchain_info_metric('n-unique-addresses')
    fetch_blockchain_info_metric('estimated-transaction-volume-usd')

    # 5. CoinGecko BTC dominance (snapshot)
    fetch_coingecko_btc_dominance()

    # 6. SEC Form 4 (snapshot pour quelques tickers majeurs)
    fetch_sec_form4_recent('AAPL')
    fetch_sec_form4_recent('MSFT')
    fetch_sec_form4_recent('NVDA')

    # Resume des fichiers crees
    print('\n\n' + '=' * 90)
    print(' RESUME FICHIERS COLLECTES')
    print('=' * 90)
    files = sorted(ALT_DATA_DIR.glob('*.csv'))
    for f in files:
        size_kb = f.stat().st_size / 1024
        print(f'  {f.name:<40} {size_kb:>8.1f} KB')

    print(f'\nTotal : {len(files)} fichiers de donnees alternatives gratuites')
    print(f'Dossier : {ALT_DATA_DIR}')


if __name__ == '__main__':
    main()
