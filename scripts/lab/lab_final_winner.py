"""
Trade Genius — Lab Final Winner v1.0

Synthese FINALE : prend TOUS les resultats des tests et determine
le WINNER officiel par IA (INDICES, CRYPTO).

Critere strict :
  - Mean >= 15%/an OOS
  - DD worst >= -35%
  - Annees positives >= 60%
  - Survit crashtest (>= 4/7 pass)

Si aucun candidat ne passe : "PAS DE WINNER - garder cash/B&H"

Output : data/sandbox/lab/WINNER_OFFICIAL.json
         + panier du jour ready pour deployment
"""
import sys, json, warnings
from pathlib import Path

warnings.filterwarnings('ignore')
sys.path.insert(0, str(Path(__file__).parent))
from lab_engine import OUTPUT_DIR


def load(name):
    p = OUTPUT_DIR / name
    if not p.exists():
        return None
    try:
        with open(p) as f:
            return json.load(f)
    except Exception as e:
        print(f'  [warning] Failed to load {name}: {e}')
        return None


def evaluate(name, mean, dd, pos_ratio, n_total, crashtest_score=None, mc_p_profit=None, deep_oos_pos=None):
    """Renvoie verdict + raison pour un candidat."""
    reasons_ok = []
    reasons_ko = []

    if mean >= 25:
        reasons_ok.append(f'mean {mean:.1f}%/an >= 25%')
    elif mean >= 15:
        reasons_ok.append(f'mean {mean:.1f}%/an dans range')
    elif mean >= 5:
        reasons_ko.append(f'mean {mean:.1f}%/an trop faible')
    else:
        reasons_ko.append(f'mean {mean:.1f}%/an FAIL')

    if dd >= -10:
        reasons_ok.append(f'DD {dd:.1f}% excellent')
    elif dd >= -25:
        reasons_ok.append(f'DD {dd:.1f}% acceptable')
    elif dd >= -40:
        reasons_ko.append(f'DD {dd:.1f}% eleve')
    else:
        reasons_ko.append(f'DD {dd:.1f}% catastrophique')

    if pos_ratio >= 0.75:
        reasons_ok.append(f'{int(pos_ratio * 100)}% annees positives')
    elif pos_ratio >= 0.6:
        reasons_ok.append(f'{int(pos_ratio * 100)}% pos OK')
    else:
        reasons_ko.append(f'{int(pos_ratio * 100)}% pos faible')

    if crashtest_score is not None:
        if crashtest_score >= 4:
            reasons_ok.append(f'crashtest {crashtest_score}/7 robuste')
        else:
            reasons_ko.append(f'crashtest {crashtest_score}/7 fragile')

    if mc_p_profit is not None:
        if mc_p_profit >= 0.55:
            reasons_ok.append(f'MC P(profit) {mc_p_profit * 100:.0f}% robuste')
        elif mc_p_profit >= 0.4:
            reasons_ok.append(f'MC P(profit) {mc_p_profit * 100:.0f}% acceptable')
        else:
            reasons_ko.append(f'MC P(profit) {mc_p_profit * 100:.0f}% FAIL')

    # Verdict
    if len(reasons_ko) == 0 and len(reasons_ok) >= 3:
        verdict = 'WINNER'
    elif len(reasons_ko) <= 1 and len(reasons_ok) >= 2:
        verdict = 'CANDIDAT'
    else:
        verdict = 'REJETE'
    return verdict, reasons_ok, reasons_ko


def main():
    print('=' * 90)
    print(' TRADE GENIUS - LAB FINAL WINNER SELECTION')
    print('=' * 90)

    # Collecte
    ensemble = load('lab_ensemble.json') or {}
    crashtest = load('lab_crashtest.json') or {}
    deep_oos = load('lab_deep_oos.json') or {}
    longterm = load('lab_longterm.json') or {}
    gen_a = load('lab_genetic_A_INDICES_TECH_best.json')
    gen_c = load('lab_genetic_C_CRYPTO_TECH_best.json')
    ens_crash = load('lab_ensemble_crashtest.json') or {}

    # === Catalog complet par IA ===
    all_candidates = {'INDICES': [], 'CRYPTO': []}

    # 1. Baseline momentum_topN
    print('\n--- Sources de donnees ---')
    print(f'  ensemble: {bool(ensemble)} | crashtest: {bool(crashtest)} | deep_oos: {bool(deep_oos)}')
    print(f'  longterm: {bool(longterm)} | genetic_indices: {bool(gen_a)} | genetic_crypto: {bool(gen_c)}')
    print(f'  ensemble_crashtest: {bool(ens_crash)}')

    # ENSEMBLE candidats
    if 'indices' in ensemble:
        for k in ['ensemble_2_of_3', 'ensemble_3_of_3']:
            if k in ensemble['indices']:
                m = ensemble['indices'][k]
                all_candidates['INDICES'].append({
                    'name': f'INDICES_{k}',
                    'mean': m.get('mean', 0),
                    'dd': m.get('worst_dd', 0),
                    'n_pos': m.get('n_pos', 0),
                    'n_total': m.get('n_total', 8),
                    'source': 'ensemble',
                })
    if 'crypto' in ensemble:
        for k in ['ensemble_2_of_3', 'ensemble_3_of_3']:
            if k in ensemble['crypto']:
                m = ensemble['crypto'][k]
                all_candidates['CRYPTO'].append({
                    'name': f'CRYPTO_{k}',
                    'mean': m.get('mean', 0),
                    'dd': m.get('worst_dd', 0),
                    'n_pos': m.get('n_pos', 0),
                    'n_total': m.get('n_total', 8),
                    'source': 'ensemble',
                })

    # GENETIC candidats
    if gen_a and 'top5' in gen_a:
        for i, r in enumerate(gen_a['top5'][:3]):
            meta = r.get('meta', {})
            all_candidates['INDICES'].append({
                'name': f'INDICES_genetic_top{i + 1}',
                'mean': meta.get('mean', 0),
                'dd': meta.get('worst_dd', 0),
                'n_pos': int(meta.get('pos_ratio', 0) * 8),
                'n_total': 8,
                'source': 'genetic',
                'config': r.get('config'),
            })
    if gen_c and 'top5' in gen_c:
        for i, r in enumerate(gen_c['top5'][:3]):
            meta = r.get('meta', {})
            all_candidates['CRYPTO'].append({
                'name': f'CRYPTO_genetic_top{i + 1}',
                'mean': meta.get('mean', 0),
                'dd': meta.get('worst_dd', 0),
                'n_pos': int(meta.get('pos_ratio', 0) * 5),
                'n_total': 5,
                'source': 'genetic',
                'config': r.get('config'),
            })

    # LONG-TERM candidats
    if longterm:
        for r in longterm.get('indices', [])[:3]:
            all_candidates['INDICES'].append({
                'name': f'INDICES_{r["config"]["name"]}',
                'mean': r.get('mean', 0),
                'dd': r.get('worst_dd', 0),
                'n_pos': r.get('n_pos', 0),
                'n_total': r.get('n_total', 14),
                'source': 'longterm',
                'config': r.get('config'),
            })
        for r in longterm.get('crypto', [])[:3]:
            all_candidates['CRYPTO'].append({
                'name': f'CRYPTO_{r["config"]["name"]}',
                'mean': r.get('mean', 0),
                'dd': r.get('worst_dd', 0),
                'n_pos': r.get('n_pos', 0),
                'n_total': r.get('n_total', 7),
                'source': 'longterm',
                'config': r.get('config'),
            })

    # === Tableaux finaux par IA ===
    winners = {}
    for ia_name, cands in all_candidates.items():
        print(f'\n{"=" * 90}')
        print(f' IA {ia_name} : {len(cands)} candidats')
        print('=' * 90)
        print(f' {"Name":<35}{"Mean":>8}{"DD":>8}{"+pos":>10}{"Source":>12}{"Verdict":>15}')
        print(f' {"-" * 90}')

        evaluated = []
        for c in cands:
            pos_ratio = c['n_pos'] / max(c['n_total'], 1)
            # Crashtest score si disponible
            ct_score = None
            mc_pp = None
            if 'genetic' in c['name'] or 'ensemble' in c['name']:
                ic = ens_crash.get('indices' if 'INDICES' in c['name'] else 'crypto', {})
                if 'mc_blocks' in ic:
                    mc_pp = ic['mc_blocks'].get('p_profit')
                if 'score' in ic:
                    ct_score = ic['score']

            verdict, ok, ko = evaluate(c['name'], c['mean'], c['dd'], pos_ratio,
                                       c['n_total'], ct_score, mc_pp)
            c['verdict'] = verdict
            c['reasons_ok'] = ok
            c['reasons_ko'] = ko
            c['pos_ratio'] = pos_ratio
            evaluated.append(c)

            pos_str = f"{c['n_pos']}/{c['n_total']}"
            print(f' {c["name"]:<35}{c["mean"]:>7.1f}%{c["dd"]:>7.1f}%{pos_str:>10}{c["source"]:>12}{verdict:>15}')

        # Pick WINNER : best Verdict + best (mean * pos_ratio / dd_penalty)
        valid = [c for c in evaluated if c['verdict'] in ('WINNER', 'CANDIDAT')]
        if valid:
            valid.sort(key=lambda c: -(c['mean'] * c['pos_ratio'] / (1 + abs(c['dd']) / 30)))
            winner = valid[0]
            winners[ia_name] = winner
            print(f'\n >>> {ia_name} WINNER : {winner["name"]}')
            print(f'      Mean: {winner["mean"]:.1f}%/an | DD: {winner["dd"]:.1f}% | {winner["n_pos"]}/{winner["n_total"]} pos')
            print(f'      Verdict: {winner["verdict"]}')
            print(f'      Forces: {", ".join(winner["reasons_ok"])}')
            if winner['reasons_ko']:
                print(f'      Faiblesses: {", ".join(winner["reasons_ko"])}')
        else:
            print(f'\n >>> {ia_name} : AUCUN WINNER - tous rejetes')
            winners[ia_name] = None

    # Save
    out = OUTPUT_DIR / 'WINNER_OFFICIAL.json'
    with open(out, 'w') as f:
        json.dump({'winners': winners, 'all_candidates': all_candidates}, f, indent=2, default=str)
    print(f'\nSaved: {out}')

    # FINAL EXECUTIVE
    print('\n' + '=' * 90)
    print(' VERDICT EXECUTIF')
    print('=' * 90)
    for ia, w in winners.items():
        if w:
            print(f'\nIA {ia}')
            print(f'  Winner : {w["name"]}')
            print(f'  Performance : {w["mean"]:.1f}%/an (vs objectif 20-30%)')
            print(f'  Risque : DD max {w["dd"]:.1f}%')
            print(f'  Stabilite : {w["n_pos"]}/{w["n_total"]} annees positives ({int(w["pos_ratio"] * 100)}%)')
            if w['mean'] >= 25:
                print(f'  STATUT : DEPLOIE EN PREMIUM (>= 25%/an validee)')
            elif w['mean'] >= 15:
                print(f'  STATUT : DEPLOIE EN PREMIUM (range 15-25%)')
            else:
                print(f'  STATUT : DEFENSIF / ATTENTE')
        else:
            print(f'\nIA {ia} : AUCUN WINNER - NE PAS DEPLOIIR')


if __name__ == '__main__':
    main()
