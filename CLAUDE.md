# Trade Genius — Contexte projet

> **Version courante : v2.16** · PWA pédago bourse · 6 modules + simu + biblio + 3 scenes Premium · Infra 0€

## 🎯 Avant tout

1. **Lis `HANDOFF.md`** (228 lignes) — récap complet v1.95→v2.16, architecture, pièges connus, roadmap
2. **Lis `~/.claude/projects/C--Users-qfichet/memory/project_trade_genius.md`** — résumé synthétique

## ⚙️ Règles de communication (Aurélien, dev solo)

- **Français** uniquement
- **Concis** : code-first, pas de hype, pas de blabla
- **Tokens** : pas de récap inutile, pas de redite
- **Auto-mode** : ne demande pas l'autorisation pour les actions évidentes (bypassPermissions actif)
- **Tests** : Aurélien teste sur Samsung réel — ses retours brefs sont sérieux

## 💸 Contrainte économique critique

**Aucune dépense d'infra** (Claude 100€/mois déjà suffisant). Tout doit rester **gratuit** :
- APIs : CoinGecko free + Yahoo Finance via `corsproxy.io`
- Hébergement : GitHub Pages
- Calculs : 100% client-side
- Pas de backend, pas de service payant

Coach IA réel (Claude API) en placeholder tant que l'app n'est pas rentable.

## 📁 Architecture rapide

- `index.html` : hub principal (welcome + modules + accueil) — gros fichier ~4500 lignes
- `tg-common.js` : module ES6 partagé — `window.TG.*` + Three.js (billet 3D)
- `scene-01` à `scene-04` : Modules M0-M3 (FREE)
- `scene-05` : Simulateur (9434 lignes — énorme)
- `scene-06` : Bibliothèque
- `scene-07` : Module 4 (ch.1-3 FREE / ch.4-7 PREMIUM)
- `scene-08` : Patterns Lab Premium (12 patterns)
- `scene-09` : Krachs historiques Premium (4 krachs détaillés)
- `scene-10` : Marché Live Premium (Crypto/Actions/ETF + 6 indicateurs)
- `scene-11` : Module 5 Fiscalité FR (FREE, NEW v2.15)

## 🚀 Workflow déploiement

```bash
bash bump.sh X.YZ   # bump version dans tous les fichiers (boucle 01-11)
# /!\ Édite manuellement #bd-version et #hbb-tag dans index.html
git add -A && git commit -m "vX.YZ — message" && git push
# GH Pages déploie auto ~30s
```

## ⚠️ Pièges classiques (cf. HANDOFF.md pour la liste complète)

1. `tg-common.js` est un **module ES async** + import Three.js depuis unpkg → `window.TG.isPremium` peut être `undefined` à l'init. **Toujours utiliser `_isPremiumSafe()`** côté index.html
2. **Slides débordants** : `justify-content: flex-start` + `overflow-y: auto` sur `.slide` (fix v2.13)
3. **Tutos bulles** : utiliser `_tutoActiveSteps` (pas l'ancien `ACCUEIL_TUTO_STEPS`) — v2.07/v2.11
4. **MODULES[4].advanced: true** → exclu du déblocage simu (M0-M3 suffisent)
5. **M2/M3 sont 100% FREE** depuis v2.01 (gating ch.4-7 retiré)
6. **bump.sh** boucle 01-11 + édite tg-common.js + sw.js (mais PAS `#bd-version`/`#hbb-tag` dans index.html — manuel)
7. **Filesystem Windows case-insensitive** : `HANDOFF.md` est tracké en `handoff.md` par Git
8. Push direct sur main autorisé (workflow normal, pas de PR)

## 🎓 Freemium philosophie

**FREE = apprentissage complet** : M0-M3 + M5 + M4 ch.1-3 + simu illimité + biblio + glossaire + défi du jour
**PREMIUM = mode expert** : M4 ch.4-7 + Patterns Lab + Krachs + Marché Live + futurs Coach IA / vidéos / newsletter

Pas de paywall sur les bases — c'est non négociable.

## 🛣️ Roadmap priorité immédiate

1. Test Samsung v2.16 → reporter bugs
2. Canvas visuels Module 5 (PEA vs CTO croissance composée, comme M4 v2.12)
3. +5 scenarios simu historiques (1987, 1929, Lehman 2008, COVID 2020, FTX 2022)

Pour le détail complet, voir HANDOFF.md section "Roadmap restante".
