"""
Trade Genius — Lab Verdict v1.0

Consolide TOUS les resultats du lab pour produire le verdict final.

Sources :
  - data/sandbox/lab/lab_ensemble.json (ensemble vote 3 configs)
  - data/sandbox/lab/lab_genetic_*_best.json (algo genetique top configs)
  - data/sandbox/lab/lab_crashtest.json (7 stress tests)
  - data/sandbox/lab/lab_deep_oos.json (test sur periode jamais touchee)
  - data/sandbox/lab/lab_validate_best.json (Monte-Carlo + HTML)

Output : data/sandbox/lab/VERDICT_FINAL.json + fiche claire en console
"""
import sys, json, warnings
from pathlib import Path

warnings.filterwarnings('ignore')
sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import OUTPUT_DIR


def load_json(name):
    p = OUTPUT_DIR / name
    if not p.exists():
        return None
    try:
        with open(p) as f:
            return json.load(f)
    except Exception as e:
        print(f'Failed to load {p}: {e}')
        return None


def grade(value, thresholds):
    """Renvoie 'A' / 'B' / 'C' / 'D' selon les seuils."""
    if value >= thresholds[0]:
        return 'A'
    elif value >= thresholds[1]:
        return 'B'
    elif value >= thresholds[2]:
        return 'C'
    else:
        return 'D'


def section(title):
    print('\n' + '=' * 90)
    print(f' {title}')
    print('=' * 90)


def synthesize_ia(name, ensemble_data, genetic_data, crashtest_data, oos_data):
    section(f'IA {name.upper()}')

    candidates = {}

    # 1. Baseline (depuis lab_ensemble.json solos)
    if ensemble_data and 'solo' in ensemble_data:
        for solo_name, m in ensemble_data['solo'].items():
            candidates[f'solo_{solo_name}'] = m

    # 2. Ensembles
    if ensemble_data:
        for k in ['ensemble_2_of_3', 'ensemble_3_of_3']:
            if k in ensemble_data:
                candidates[k] = ensemble_data[k]

    # 3. Genetic best
    if genetic_data and 'top5' in genetic_data:
        for i, item in enumerate(genetic_data['top5'][:3]):
            m = item.get('meta') or {}
            candidates[f'genetic_top{i + 1}'] = m

    # Tableau comparatif
    print(f'\n  {"Strategy":<28}{"Mean":>8}{"Median":>8}{"Compound":>10}{"WorstDD":>10}{"+pos":>8}')
    print('  ' + '-' * 80)
    ranked = []
    for label, m in candidates.items():
        if not m or 'mean' not in m:
            continue
        mean = m.get('mean', 0)
        median = m.get('median', 0)
        compound = m.get('compound', 0)
        wdd = m.get('worst_dd', 0)
        n_pos = m.get('n_pos', m.get('n_positive', 0))
        n_total = m.get('n_total', 8)
        pos_str = f'{n_pos}/{n_total}'
        print(f'  {label:<28}{mean:>7.1f}%{median:>7.1f}%{compound:>9.0f}%{wdd:>9.1f}%{pos_str:>8}')
        # Score : prioritise stability (pos_ratio) + return
        pos_ratio = n_pos / max(n_total, 1)
        score = mean * pos_ratio / (1 + abs(wdd) / 30)
        ranked.append((label, m, score))

    ranked.sort(key=lambda x: -x[2])

    # Best
    if ranked:
        best_label, best_meta, best_score = ranked[0]
        print(f'\n  >>> WINNER : {best_label}')
        print(f'      Mean: {best_meta.get("mean", 0):.1f}%/an')
        print(f'      Median: {best_meta.get("median", 0):.1f}%/an')
        print(f'      Compound: {best_meta.get("compound", 0):.0f}%')
        print(f'      Worst DD: {best_meta.get("worst_dd", 0):.1f}%')
        n_pos = best_meta.get('n_pos', best_meta.get('n_positive', 0))
        n_total = best_meta.get('n_total', 8)
        print(f'      Annees positives: {n_pos}/{n_total} ({n_pos * 100 // max(n_total, 1)}%)')

    # 4. Crashtest
    if crashtest_data:
        key = name.lower()
        if key in crashtest_data:
            ct = crashtest_data[key]
            print(f'\n  --- CRASH TEST ROBUSTESSE ---')
            print(f'      Verdict: {ct.get("verdict", "N/A")}')
            print(f'      Score: {ct.get("score", 0)}/{ct.get("max_score", 0)}')
            if 'stress_fees_2x' in ct:
                print(f'      Stress frais 2x: {ct["stress_fees_2x"]["annual_return_pct"]:.1f}%/an')
            if 'bear_2022' in ct:
                print(f'      Bear 2022: {ct["bear_2022"]["annual_return_pct"]:.1f}% (vs notre IA baseline)')
            if 'mc_blocks_p_profit' in ct:
                print(f'      P(profit Monte-Carlo blocks): {ct["mc_blocks_p_profit"] * 100:.1f}%')

    # 5. Deep OOS
    if oos_data:
        key = name.lower()
        if key in oos_data and oos_data[key]:
            o = oos_data[key]
            print(f'\n  --- DEEP OOS (periode jamais touchee) ---')
            print(f'      Annual: {o.get("annual_return_pct", 0):.1f}%/an')
            print(f'      DD: {o.get("max_dd_pct", 0):.1f}%')
            print(f'      Sharpe: {o.get("sharpe", 0):.2f}')
            print(f'      Excess vs B&H: {o.get("excess_total_pct", 0):+.0f}%')

    return {'candidates': candidates, 'winner': ranked[0] if ranked else None}


def main():
    print('=' * 90)
    print(' TRADE GENIUS LAB - VERDICT FINAL CONSOLIDE')
    print('=' * 90)

    ensemble = load_json('lab_ensemble.json') or {}
    crashtest = load_json('lab_crashtest.json') or {}
    oos = load_json('lab_deep_oos.json') or {}

    # Genetic per universe
    gen_a = load_json('lab_genetic_A_INDICES_TECH_best.json')
    gen_c = load_json('lab_genetic_C_CRYPTO_TECH_best.json')

    r_ind = synthesize_ia('INDICES',
                          ensemble.get('indices'),
                          gen_a,
                          crashtest,
                          oos)

    r_crp = synthesize_ia('CRYPTO',
                          ensemble.get('crypto'),
                          gen_c,
                          crashtest,
                          oos)

    # Save final
    out = OUTPUT_DIR / 'VERDICT_FINAL.json'
    with open(out, 'w') as f:
        json.dump({'indices': r_ind, 'crypto': r_crp}, f, indent=2, default=str)
    print(f'\nSaved : {out}')

    # FINAL RECAP
    section('RECAP EXECUTIF')
    for name, r in [('INDICES', r_ind), ('CRYPTO', r_crp)]:
        if r.get('winner'):
            label, meta, score = r['winner']
            print(f'\nIA {name} :')
            print(f'  Configuration choisie : {label}')
            print(f'  Performance moyenne : {meta.get("mean", 0):.1f}%/an')
            print(f'  Performance mediane : {meta.get("median", 0):.1f}%/an')
            print(f'  Drawdown max : {meta.get("worst_dd", 0):.1f}%')
            n_pos = meta.get('n_pos', meta.get('n_positive', 0))
            n_total = meta.get('n_total', 8)
            print(f'  Annees positives : {n_pos}/{n_total}')

            # Check objectif 20-30%
            mean = meta.get('mean', 0)
            if mean >= 25:
                print(f'  OBJECTIF 20-30%/AN : DEPASSE')
            elif mean >= 20:
                print(f'  OBJECTIF 20-30%/AN : ATTEINT')
            elif mean >= 10:
                print(f'  OBJECTIF 20-30%/AN : SOUS LE SEUIL (need more work)')
            else:
                print(f'  OBJECTIF 20-30%/AN : FAIL')


if __name__ == '__main__':
    main()
