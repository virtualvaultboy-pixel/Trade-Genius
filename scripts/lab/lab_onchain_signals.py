"""
Trade Genius — Lab On-Chain BTC Signals

Exploite les data on-chain BTC dejà collectées (gratuit blockchain.info) :
  - hash-rate : conviction des mineurs
  - n-unique-addresses : adoption reelle
  - estimated-transaction-volume-usd : activite economique
  - market-cap : capitalisation globale

Construit des signaux :
  S_OC1 : hash rate 30j > 90j → confiance mineurs (bullish)
  S_OC2 : addresses 30j > 90j → adoption croissante (bullish)
  S_OC3 : tx volume 7j > 30j → activite explosive (bullish court terme)
  S_OC4 : NVT ratio (Network Value / Transaction volume) → valorisation

Ajoute ces signaux au master signal et re-teste les 3 IA.
"""
import sys, json, warnings
warnings.filterwarnings('ignore')

import pandas as pd
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import LabEngine, OUTPUT_DIR
from lab_polished_winner import load_alt_data, compute_master_signal
from lab_3_ias import run_ia

ALT_DATA_DIR = OUTPUT_DIR / 'alt_data'


def compute_onchain_signal(date_index, alt_data):
    """
    Combine 4 signaux on-chain en un multiplicateur [0.6 - 1.3].
    """
    sig = pd.Series(1.0, index=date_index)

    # S_OC1 : hash rate momentum
    if 'btc_hash-rate' in alt_data:
        hr = alt_data['btc_hash-rate']['hash-rate'].reindex(date_index, method='ffill')
        hr_30 = hr.rolling(30).mean()
        hr_90 = hr.rolling(90).mean()
        # hash up trend = bullish
        adj = pd.Series(1.0, index=date_index)
        adj[(hr_30 > hr_90 * 1.05)] = 1.1   # croissance hash > 5%
        adj[(hr_30 < hr_90 * 0.95)] = 0.85  # hash décline = bear
        adj[(hr_30 < hr_90 * 0.85)] = 0.7   # capitulation mineurs
        sig = sig * adj

    # S_OC2 : addresses uniques
    if 'btc_n-unique-addresses' in alt_data:
        addr = alt_data['btc_n-unique-addresses']['n-unique-addresses'].reindex(date_index, method='ffill')
        addr_30 = addr.rolling(30).mean()
        addr_90 = addr.rolling(90).mean()
        adj = pd.Series(1.0, index=date_index)
        adj[(addr_30 > addr_90 * 1.10)] = 1.1
        adj[(addr_30 < addr_90 * 0.90)] = 0.9
        sig = sig * adj

    # S_OC3 : tx volume momentum (signal court terme)
    if 'btc_estimated-transaction-volume-usd' in alt_data:
        tx = alt_data['btc_estimated-transaction-volume-usd']['estimated-transaction-volume-usd'].reindex(date_index, method='ffill')
        tx_7 = tx.rolling(7).mean()
        tx_30 = tx.rolling(30).mean()
        adj = pd.Series(1.0, index=date_index)
        adj[(tx_7 > tx_30 * 1.30)] = 1.1   # activite explosive
        adj[(tx_7 < tx_30 * 0.70)] = 0.95  # baisse activite
        sig = sig * adj

    # S_OC4 : NVT (Network Value / Transaction)
    if 'btc_market-cap' in alt_data and 'btc_estimated-transaction-volume-usd' in alt_data:
        mc = alt_data['btc_market-cap']['market-cap'].reindex(date_index, method='ffill')
        tx = alt_data['btc_estimated-transaction-volume-usd']['estimated-transaction-volume-usd'].reindex(date_index, method='ffill')
        nvt = mc / (tx + 1e-9)
        nvt_ma = nvt.rolling(90).mean()
        adj = pd.Series(1.0, index=date_index)
        # NVT eleve = surevaluation (bearish), bas = sous-evaluation (bullish)
        adj[(nvt > nvt_ma * 1.5)] = 0.85  # overvalued
        adj[(nvt < nvt_ma * 0.6)] = 1.1   # undervalued
        sig = sig * adj

    return sig.clip(0.5, 1.3)


def run_ia_with_onchain(data, weights, alt_data, dd_stop_pct=15, dd_lookback=30,
                        rebal_days=21, commission=0.0015, slippage=0.0040, initial=1000,
                        use_alt_master=True, use_onchain=True):
    """Run IA avec MASTER signal + ONCHAIN signal combine."""
    cash = initial
    holdings = {t: 0.0 for t in weights}
    peak = initial; max_dd = 0
    eq_history = []; monthly_eq = []
    cash_cooldown = 0

    # Signals
    master_sig = compute_master_signal(data.index, alt_data) if use_alt_master else pd.Series(1.0, index=data.index)
    onchain_sig = compute_onchain_signal(data.index, alt_data) if use_onchain else pd.Series(1.0, index=data.index)
    combined_sig = (master_sig * onchain_sig).clip(0, 1.5)

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

        if dd_stop_pct and i >= dd_lookback:
            recent_peak = max(eq_history[-dd_lookback:])
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

        if i in rebal_indices:
            scale = float(combined_sig.iloc[i]) if i < len(combined_sig) else 1.0
            for t in holdings:
                if t not in data.columns or pd.isna(data[t].iloc[i]):
                    continue
                target_val = equity * weights.get(t, 0) * scale
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

    final = eq_history[-1]
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
        'max_dd_pct': float(max_dd * 100),
        'worst_monthly': worst_m,
        'final_value': float(final),
        'calmar': float(annual / max(abs(max_dd * 100), 1)),
    }


def main():
    print('=' * 95)
    print(' LAB ON-CHAIN BTC SIGNALS - tester sur 3 IA')
    print('=' * 95)

    alt_data = load_alt_data()
    print(f'Alt data : {len(alt_data)} datasets')

    universe = ['SPY', 'QQQ', 'TLT', 'IEF', 'GLD',
                'XLK', 'BTC-USD', 'ETH-USD', 'SOL-USD',
                'TQQQ']
    eng = LabEngine(universe=universe, start='2014-01-01')
    data = eng.data.loc['2019-09-01':'2026-01-01']
    print(f'Period : {data.index.min().date()} -> {data.index.max().date()}')

    winners = {
        'IA INDICES (TQQQ60+TLT20+GLD20)':
            {'TQQQ': 0.60, 'TLT': 0.20, 'GLD': 0.20},
        'IA CRYPTO (BTC40+ETH20+SOL20+TLT20)':
            {'BTC-USD': 0.40, 'ETH-USD': 0.20, 'SOL-USD': 0.20, 'TLT': 0.20},
        'IA MIXTE Premium+ best Calmar':
            {'TQQQ': 0.50, 'BTC-USD': 0.10, 'ETH-USD': 0.10, 'TLT': 0.10, 'GLD': 0.10, 'XLK': 0.10},
        'IA MIXTE Premium+ best Return':
            {'TQQQ': 0.50, 'BTC-USD': 0.10, 'ETH-USD': 0.20, 'TLT': 0.10, 'XLK': 0.10},
    }

    print(f'\n{"Variant":<55}{"Mode":<22}{"Ann":>7}{"DD":>7}{"WM":>7}{"Cal":>6}')
    print('-' * 105)

    all_results = {}
    for name, weights in winners.items():
        for mode_name, use_master, use_oc in [
            ('1. baseline (no alt)', False, False),
            ('2. master alt only', True, False),
            ('3. onchain only', False, True),
            ('4. MASTER + ONCHAIN', True, True),
        ]:
            try:
                r = run_ia_with_onchain(data, weights, alt_data, dd_stop_pct=15,
                                         use_alt_master=use_master, use_onchain=use_oc)
                print(f'{name[:54]:<55}{mode_name[:21]:<22}{r["annual_return_pct"]:>6.1f}%{r["max_dd_pct"]:>6.1f}%{r["worst_monthly"]:>6.1f}%{r["calmar"]:>6.2f}')
                all_results[f'{name} | {mode_name}'] = r
            except Exception as e:
                print(f'{name[:54]:<55}{mode_name[:21]:<22} FAILED: {e}')
        print('-' * 105)

    out = OUTPUT_DIR / 'lab_onchain_signals.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f'\nSaved : {out}')

    # FINAL VERDICT : pour chaque IA, lequel des 4 modes est meilleur ?
    print('\n\n' + '=' * 95)
    print(' VERDICT : impact des signaux on-chain')
    print('=' * 95)
    for ia_name in winners.keys():
        modes = {k: v for k, v in all_results.items() if k.startswith(ia_name)}
        print(f'\n--- {ia_name} ---')
        baseline = modes.get(f'{ia_name} | 1. baseline (no alt)')
        master = modes.get(f'{ia_name} | 2. master alt only')
        onchain = modes.get(f'{ia_name} | 3. onchain only')
        combined = modes.get(f'{ia_name} | 4. MASTER + ONCHAIN')
        if baseline:
            print(f'  baseline  : {baseline["annual_return_pct"]:>5.1f}% / DD {baseline["max_dd_pct"]:>5.1f}% / Cal {baseline["calmar"]:>4.2f}')
        if master:
            print(f'  +master   : {master["annual_return_pct"]:>5.1f}% / DD {master["max_dd_pct"]:>5.1f}% / Cal {master["calmar"]:>4.2f}')
        if onchain:
            print(f'  +onchain  : {onchain["annual_return_pct"]:>5.1f}% / DD {onchain["max_dd_pct"]:>5.1f}% / Cal {onchain["calmar"]:>4.2f}')
        if combined:
            print(f'  COMBINED  : {combined["annual_return_pct"]:>5.1f}% / DD {combined["max_dd_pct"]:>5.1f}% / Cal {combined["calmar"]:>4.2f}')


if __name__ == '__main__':
    main()
