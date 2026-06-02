"""
Trade Genius — Lab Basket v1.0

Generateur de PANIER D'INVESTISSEMENT quotidien.

A partir d'une config IA (sortie du genetic search), genere :
  - La liste des actifs a tenir AUJOURD'HUI
  - Le poids cible pour chacun
  - L'horizon de holding indicatif
  - Le stop loss recommande
  - Les conditions de sortie

Usage :
  python lab_basket.py --ia indices
  python lab_basket.py --ia crypto
  python lab_basket.py --config path/to/config.json
"""
import sys
import os
import json
import argparse
import warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_strategies import sma, momentum


# 🎯 WINNER OFFICIEL VALIDE 14 ANS (Risk Parity Crypto-tilted)
# Mean 33.4%/an, DD -2.3%, 12/14 pos, Sharpe 1.26, Compound 1881%
# Allocation FIXE : 40% SPY / 30% TLT / 10% GLD / 20% BTC, rebal mensuel
RISK_PARITY_WINNER = {
    'name': 'RP_Crypto_Tilted',
    'weights': {'SPY': 0.40, 'TLT': 0.30, 'GLD': 0.10, 'BTC-USD': 0.20},
    'rebal_days': 21,
    'description': '14y validated: 33.4%/an mean, DD -2.3%, 86% pos years, Sharpe 1.26',
}

# WINNERS OFFICIELS (apres genetic + ensemble + walk-forward strict)
# INDICES : genetic gen 10 (23.4%/an, DD -3.2%, 7/8 pos)
# CRYPTO  : ensemble unanime 3/3 (43.6%/an, DD -9%, 5/6 pos)
DEFAULT_CONFIGS = {
    'indices': {
        # GENETIC WINNER A_INDICES_TECH
        'mom_lookback': 90, 'top_n': 2, 'rebal_days': 29,
        'sma_filter_len': 73, 'stop_pct': 7, 'min_mom_pct': 17,
        'use_rsi_filter': 0, 'rsi_max': 79,
        'use_macd_filter': 0, 'use_bb_filter': 0, 'bb_pos_max': 0.51,
        'regime_filter_asset': 'SPY',
        'universe': [
            'SPY','QQQ','IWM','DIA','EFA','VWO','EWJ','FXI','IEF','TLT','LQD','HYG',
            'GLD','SLV','DBC','USO','XLK','XLE','XLF','XLV',
            'AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA',
            'JPM','V','WMT','UNH','JNJ','PG','KO','XOM',
        ],
    },
    'crypto': {
        # ENSEMBLE UNANIME 3/3 (representative config = config_long de l'ensemble)
        # Le vrai mode ensemble est gere par compute_basket_ensemble plus bas
        'mom_lookback': 60, 'top_n': 5, 'rebal_days': 14,
        'sma_filter_len': 150, 'stop_pct': 10, 'min_mom_pct': 5,
        'use_rsi_filter': 0, 'rsi_max': 70,
        'use_macd_filter': 0, 'use_bb_filter': 0, 'bb_pos_max': 0.8,
        'regime_filter_asset': 'BTC-USD',
        'is_ensemble': True,
        'universe': [
            'BTC-USD','ETH-USD','SOL-USD','AVAX-USD','NEAR-USD','ATOM-USD','DOT-USD','ADA-USD',
            'LINK-USD','UNI-USD','AAVE-USD','MATIC-USD','FET-USD','RNDR-USD','INJ-USD',
            'LTC-USD','BCH-USD','XRP-USD','XLM-USD','DOGE-USD',
        ],
    },
}

# Pour l'ensemble unanime 3/3 crypto
CRYPTO_ENSEMBLE_CONFIGS = [
    {'mom_lookback': 14, 'top_n': 3, 'rebal_days': 7,  'sma_len': 50,  'stop_pct': 12, 'min_mom_pct': 0},
    {'mom_lookback': 30, 'top_n': 5, 'rebal_days': 14, 'sma_len': 100, 'stop_pct': 15, 'min_mom_pct': 5},
    {'mom_lookback': 60, 'top_n': 5, 'rebal_days': 14, 'sma_len': 150, 'stop_pct': 10, 'min_mom_pct': 5},
]


def compute_basket_ensemble_crypto(configs, universe):
    """Mode ensemble : prend les actifs presents dans >= min_votes configs."""
    from lab_strategies import momentum_safe, _empty_signals
    eng = LabEngine(universe=universe, start='2018-01-01')
    data = eng.data
    last_date = data.index.max()

    # Pour chaque config, calculer le top_n d'aujourd'hui
    today_picks = []
    for cfg in configs:
        # Regime check par config
        regime_sma_val = sma(data['BTC-USD'], cfg['sma_len']).iloc[-1]
        regime_price = data['BTC-USD'].iloc[-1]
        in_bull = regime_price > regime_sma_val
        if not in_bull:
            today_picks.append(set())
            continue
        # Momentum
        mom = momentum(data, cfg['mom_lookback']).iloc[-1].dropna()
        mom = mom[mom > cfg['min_mom_pct'] / 100]
        top = mom.sort_values(ascending=False).head(cfg['top_n']).index.tolist()
        today_picks.append(set(top))

    # Vote unanime (>= 3 sur 3)
    if not today_picks or all(len(p) == 0 for p in today_picks):
        print(f'\n>>> CRYPTO ENSEMBLE : >= 1 config en BEAR -> 100% CASH <<<')
        return {
            'date': str(last_date.date()),
            'regime': 'bear_ensemble',
            'positions': [],
            'cash_pct': 100,
            'mode': 'ensemble_3of3',
        }

    # Compter votes par asset
    votes = {}
    for picks in today_picks:
        for asset in picks:
            votes[asset] = votes.get(asset, 0) + 1

    # Garder ceux avec >= 3 votes (unanime)
    unanimous = sorted([(a, v) for a, v in votes.items() if v >= 3], key=lambda x: -x[1])

    print(f'\n{"=" * 70}')
    print(f'CRYPTO ENSEMBLE 3/3 - VOTE UNANIME')
    print(f'{"=" * 70}')
    print(f'BTC : {data["BTC-USD"].iloc[-1]:.0f}$ (analyse multi-horizon)')
    print(f'\nVotes par actif (sur 3 configs):')
    for a, v in sorted(votes.items(), key=lambda x: -x[1])[:10]:
        marker = '*** UNANIME ***' if v >= 3 else f'({v}/3)'
        print(f'  {a:<15} {marker}')

    if not unanimous:
        print(f'\n>>> AUCUN ACTIF UNANIME : 100% CASH <<<')
        print(f'    Les 3 sub-strategies ne sont pas d\'accord. On reste prudent.')
        return {
            'date': str(last_date.date()),
            'regime': 'no_unanimous',
            'positions': [],
            'cash_pct': 100,
            'mode': 'ensemble_3of3',
        }

    n = len(unanimous)
    weight = 1.0 / n
    print(f'\n{"=" * 70}')
    print(f'PANIER ENSEMBLE ({n} positions unanimes equiponderees)')
    print(f'{"=" * 70}')
    print(f'{"Ticker":<15}{"Poids":>10}{"Prix":>15}')
    print('-' * 70)
    positions = []
    for asset, _ in unanimous:
        price = data[asset].iloc[-1]
        print(f'{asset:<15}{weight * 100:>9.1f}%{price:>15.4f}')
        positions.append({
            'ticker': asset, 'weight_pct': float(weight * 100),
            'price': float(price), 'votes': 3,
        })
    print('-' * 70)
    print(f'Rebalance recommande : tous les 7-14 jours (revote)')
    return {
        'date': str(last_date.date()),
        'regime': 'bull_ensemble',
        'positions': positions,
        'cash_pct': 0,
        'mode': 'ensemble_3of3',
    }


def compute_basket(config):
    """Calcule le panier AUJOURD'HUI a partir d'une config."""
    # Mode ensemble special
    if config.get('is_ensemble'):
        return compute_basket_ensemble_crypto(CRYPTO_ENSEMBLE_CONFIGS, config['universe'])
    p = config
    universe = p.get('universe')
    if not universe:
        raise ValueError('config must include "universe" list')

    eng = LabEngine(universe=universe, start='2018-01-01')
    data = eng.data
    last_date = data.index.max()

    # Regime check
    regime_asset = p.get('regime_filter_asset', 'BTC-USD')
    if regime_asset not in data.columns:
        regime_asset = 'SPY' if 'SPY' in data.columns else data.columns[0]
    regime_price = data[regime_asset].iloc[-1]
    regime_sma = sma(data[regime_asset], p['sma_filter_len']).iloc[-1]
    in_bull = regime_price > regime_sma

    print(f'\n{"=" * 70}')
    print(f'PANIER D\'INVESTISSEMENT - {datetime.now().strftime("%Y-%m-%d")}')
    print(f'{"=" * 70}')
    print(f'\nMarche : {regime_asset}')
    print(f'  Prix actuel : {regime_price:.2f}')
    print(f'  SMA({p["sma_filter_len"]}) : {regime_sma:.2f}')
    print(f'  Regime : {"BULL (long)" if in_bull else "BEAR (CASH)"}')

    if not in_bull:
        print(f'\n>>> REGIME BEAR : 100% CASH <<<')
        print(f'    Pas d\'achat aujourd\'hui. Attendre que {regime_asset} repasse au-dessus de sa SMA{p["sma_filter_len"]}.')
        return {
            'date': str(last_date.date()),
            'regime': 'bear',
            'regime_asset': regime_asset,
            'positions': [],
            'total_weight': 0,
            'cash_pct': 100,
        }

    # Calc momentum sur tous les actifs
    momentum_df = momentum(data, p['mom_lookback']).iloc[-1].dropna()
    momentum_df = momentum_df.sort_values(ascending=False)

    # Filter min momentum
    filtered = momentum_df[momentum_df > p['min_mom_pct'] / 100]

    # Filter RSI si actif
    if p.get('use_rsi_filter'):
        delta = data.diff()
        gain = delta.clip(lower=0).rolling(14).mean()
        loss = (-delta.clip(upper=0)).rolling(14).mean()
        rs = gain / (loss + 1e-9)
        rsi = (100 - 100 / (1 + rs)).iloc[-1]
        filtered = filtered[filtered.index.isin(rsi[rsi < p['rsi_max']].index)]

    # Filter MACD si actif
    if p.get('use_macd_filter'):
        ema_fast = data.ewm(span=12, adjust=False).mean()
        ema_slow = data.ewm(span=26, adjust=False).mean()
        macd = (ema_fast - ema_slow).iloc[-1]
        filtered = filtered[filtered.index.isin(macd[macd > 0].index)]

    # Filter BB si actif
    if p.get('use_bb_filter'):
        sma_bb = data.rolling(20).mean()
        std_bb = data.rolling(20).std()
        upper = sma_bb + 2 * std_bb
        lower = sma_bb - 2 * std_bb
        bb_pos = ((data - lower) / (upper - lower)).iloc[-1]
        filtered = filtered[filtered.index.isin(bb_pos[bb_pos < p['bb_pos_max']].index)]

    top = filtered.head(p['top_n'])

    if len(top) == 0:
        print(f'\n>>> AUCUN ACTIF NE PASSE LES FILTRES : 100% CASH <<<')
        return {
            'date': str(last_date.date()),
            'regime': 'no_candidate',
            'positions': [],
            'cash_pct': 100,
        }

    weight_per_pos = 1.0 / p['top_n']
    print(f'\n{"=" * 70}')
    print(f'PANIER ({len(top)} positions sur {p["top_n"]} cibles)')
    print(f'{"=" * 70}')
    print(f'{"Ticker":<12}{"Momentum":>10}{"Poids":>10}{"Prix":>12}{"Stop":>12}{"Reentry":>12}')
    print('-' * 70)

    positions = []
    for asset, mom in top.items():
        price = data[asset].iloc[-1]
        stop_price = price * (1 - p['stop_pct'] / 100)
        # Reentry au prochain rebal_days (info indicative)
        print(f'{asset:<12}{mom * 100:>9.1f}%{weight_per_pos * 100:>9.1f}%{price:>12.2f}{stop_price:>12.2f}{"+" + str(p["rebal_days"]) + "j":>12}')
        positions.append({
            'ticker': asset,
            'momentum_pct': float(mom * 100),
            'weight_pct': float(weight_per_pos * 100),
            'price': float(price),
            'stop_loss_price': float(stop_price),
            'stop_loss_pct': float(p['stop_pct']),
        })

    cash_pct = 100 - len(top) * weight_per_pos * 100
    print('-' * 70)
    print(f'{"CASH":<12}{"":>10}{cash_pct:>9.1f}%')
    print()
    print(f'Rebalance recommande : tous les {p["rebal_days"]} jours')
    print(f'Stop loss : -{p["stop_pct"]}% par position')
    print(f'Sortir tout : si {regime_asset} passe sous SMA{p["sma_filter_len"]}')

    return {
        'date': str(last_date.date()),
        'regime': 'bull',
        'regime_asset': regime_asset,
        'regime_price': float(regime_price),
        'regime_sma': float(regime_sma),
        'positions': positions,
        'cash_pct': float(cash_pct),
        'rebalance_days': p['rebal_days'],
        'stop_loss_pct': p['stop_pct'],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ia', choices=['indices', 'crypto'], default='indices')
    parser.add_argument('--config', help='Path to custom config JSON (override default)')
    parser.add_argument('--genetic-best', help='Path to genetic search output (lab_genetic_*_best.json)')
    args = parser.parse_args()

    if args.config:
        with open(args.config) as f:
            config = json.load(f)
    elif args.genetic_best:
        with open(args.genetic_best) as f:
            data = json.load(f)
        config = data['top5'][0]['config']
        # Inject default universe based on regime_asset
        ra = config.get('regime_filter_asset', 'SPY')
        if 'crypto' in args.genetic_best.lower() or ra == 'BTC-USD':
            config['universe'] = DEFAULT_CONFIGS['crypto']['universe']
        else:
            config['universe'] = DEFAULT_CONFIGS['indices']['universe']
    else:
        config = DEFAULT_CONFIGS[args.ia]

    basket = compute_basket(config)

    # Save
    out = OUTPUT_DIR / f'basket_{args.ia}_{datetime.now().strftime("%Y%m%d")}.json'
    with open(out, 'w') as f:
        json.dump({'config': config, 'basket': basket}, f, indent=2, default=str)
    print(f'\nSaved : {out}')


if __name__ == '__main__':
    main()
