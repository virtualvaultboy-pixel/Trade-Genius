"""
Trade Genius — Lab Exotic Signals (confins du web)

Tester des signaux exotiques GRATUITS :
  1. VIX term structure : contango (VIX9D < VIX) = greed, backward = fear
  2. Stablecoin supply growth (USDT/USDC) via CoinGecko
  3. Google Trends "bitcoin" search (proxy attention retail)
  4. Crypto Fear & Greed combined with US VIX (croisement)
  5. Yield curve 3m10y vs 2y10y (recession indicators)
"""
import sys, json, warnings, time
warnings.filterwarnings('ignore')

import pandas as pd
import numpy as np
import requests
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR

ALT_DATA_DIR = OUTPUT_DIR / 'alt_data'


def fetch_vix_short_term():
    """VIX 9-jour (VIX9D) vs VIX 30-jour. Term structure = signal."""
    print('\n--- VIX 9D (short term volatility) ---')
    # Yahoo Finance free: ^VIX9D
    try:
        import yfinance as yf
        vix9 = yf.download('^VIX9D', start='2011-01-01', progress=False, auto_adjust=True)['Close']
        if len(vix9) > 100:
            df = pd.DataFrame({'VIX9D': vix9.values}, index=vix9.index)
            out = ALT_DATA_DIR / 'vix_9d.csv'
            df.to_csv(out)
            print(f'  Saved {len(df)} rows to {out}')
            return df
    except Exception as e:
        print(f'  Failed: {e}')
    return None


def fetch_stablecoin_supply():
    """Supply USDT + USDC via CoinGecko (free, 50 calls/min)."""
    print('\n--- Stablecoin supply (USDT + USDC) ---')
    out_file = ALT_DATA_DIR / 'stablecoin_supply.csv'
    try:
        # CoinGecko market_chart for USDT
        records = []
        for coin in ['tether', 'usd-coin']:
            url = f'https://api.coingecko.com/api/v3/coins/{coin}/market_chart'
            params = {'vs_currency': 'usd', 'days': 'max', 'interval': 'daily'}
            r = requests.get(url, params=params, timeout=20)
            if r.status_code != 200:
                print(f'  HTTP {r.status_code} for {coin}: {r.text[:200]}')
                continue
            j = r.json()
            mc = j.get('market_caps', [])
            for ts, val in mc:
                records.append({'date': pd.Timestamp(ts, unit='ms'), 'coin': coin, 'market_cap': val})
            time.sleep(2)  # rate limit
        if records:
            df = pd.DataFrame(records)
            pivoted = df.pivot_table(index='date', columns='coin', values='market_cap', aggfunc='first')
            pivoted['total_stablecoin'] = pivoted.sum(axis=1)
            pivoted.to_csv(out_file)
            print(f'  Saved {len(pivoted)} rows to {out_file}')
            print(f'  Latest total stablecoin : {pivoted["total_stablecoin"].iloc[-1]:.2e}')
            return pivoted
    except Exception as e:
        print(f'  Failed: {e}')
        import traceback; traceback.print_exc()
    return None


def fetch_google_trends_bitcoin():
    """Google Trends 'bitcoin' search via pytrends (free, peut etre rate-limite)."""
    print('\n--- Google Trends "bitcoin" ---')
    try:
        from pytrends.request import TrendReq
        pytrends = TrendReq(hl='en-US', tz=360)
        pytrends.build_payload(kw_list=['bitcoin'], timeframe='today 5-y', geo='')
        df = pytrends.interest_over_time()
        if len(df) > 0:
            out = ALT_DATA_DIR / 'google_trends_btc.csv'
            df[['bitcoin']].to_csv(out)
            print(f'  Saved {len(df)} weekly rows')
            return df
    except ImportError:
        print('  pytrends not installed (pip install pytrends)')
        import subprocess
        subprocess.run([sys.executable, '-m', 'pip', 'install', '--quiet', '--user', 'pytrends'], check=False)
        try:
            from pytrends.request import TrendReq
            pytrends = TrendReq(hl='en-US', tz=360)
            pytrends.build_payload(kw_list=['bitcoin'], timeframe='today 5-y')
            df = pytrends.interest_over_time()
            if len(df) > 0:
                out = ALT_DATA_DIR / 'google_trends_btc.csv'
                df[['bitcoin']].to_csv(out)
                print(f'  Saved {len(df)} rows')
                return df
        except Exception as e:
            print(f'  Failed even after install: {e}')
    except Exception as e:
        print(f'  Failed: {e}')
    return None


def fetch_fred_extra():
    """Series FRED supplementaires."""
    extras = [
        'T10Y3M',  # 10y-3m spread (autre recession indicator)
        'BAMLH0A0HYM2',  # ICE BofA US High Yield spread
        'DEXUSEU',  # USD/EUR
        'DTWEXBGS',  # USD trade-weighted
    ]
    print(f'\n--- FRED extra series ---')
    from lab_alt_data import fetch_fred
    for s in extras:
        fetch_fred(s, start='2014-01-01')
        time.sleep(0.5)


def fetch_btc_dominance_history():
    """BTC.D via CoinGecko."""
    print('\n--- BTC dominance history (CoinGecko global) ---')
    try:
        url = 'https://api.coingecko.com/api/v3/global'
        r = requests.get(url, timeout=15)
        # Snapshot only available, no history free
        if r.status_code == 200:
            print(f'  Snapshot only (CoinGecko free pas d\'history dominance)')
    except Exception as e:
        print(f'  Failed: {e}')


def main():
    print('=' * 95)
    print(' LAB EXOTIC SIGNALS - confins du web gratuit')
    print('=' * 95)

    # Collecte
    fetch_vix_short_term()
    fetch_stablecoin_supply()
    fetch_google_trends_bitcoin()
    fetch_fred_extra()
    fetch_btc_dominance_history()

    # Liste files
    print('\n\n--- Files dispo ---')
    for f in sorted(ALT_DATA_DIR.glob('*.csv')):
        size = f.stat().st_size / 1024
        print(f'  {f.name:<45} {size:>8.1f} KB')


if __name__ == '__main__':
    main()
