# Trade Genius — Contexte projet

> **Version courante : v7.19** · PWA pédago bourse · 6 modules + simu + biblio + 3 scenes Premium + 5 IA (BASTION/PHÉNIX/RAFALE/NEXUS + VOLT Premium) validées walk-forward IS/OOS + Pattern Detector · Infra 0€

## 🎯 Avant tout

1. **Lis `HANDOFF.md`** — récap complet, architecture, pièges connus, roadmap
2. **Lis `~/.claude/projects/C--Users-qfichet/memory/project_trade_genius.md`** — résumé synthétique

## ⚡ Nouveautés majeures depuis v2.16

- **v2.18-v2.22** : pivot architectural complet (bottom nav 5 onglets, feed daté, XP/niveaux Duolingo-style)
- **v2.26-v2.27** : Watchlist + 10 indicateurs techniques calculés client-side
- **v2.33-v2.35** : Indices live (Yahoo) + actus live (CryptoCompare + Yahoo RSS)
- **v2.36-v2.38** : Workflows GitHub Actions pour news + daily + décryptages hebdo (illimité gratuit)
- **v2.39-v2.48** : Onglet IA · études techniques via Pollinations/Groq + setups pédago + affiliation brokers (Binance, Trade Republic)
- **v2.50** : Pattern detector chartiste (double top/bottom, triangles, tendances HH/HL) + poll quotidien "Devine demain"
- **v2.51-v2.53** : FAB Analyste IA universel (popup analyse en temps réel d'un actif)
- **v2.54** : Analyseur ULTRA FIABLE (validateLong, multi-confirmations, TP1>entry, R/R≥1.8 obligatoires)
- **v2.55** : Cron 15 min + bouton refresh manuel
- **v2.56** : Carte "Recommandations du jour" issue de l'analyseur
- **v2.57-v2.58** : Sélecteur de devise global (USD/EUR/Native) + fix taux FX obsolète

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
9. **Pattern detector** : `detectPatterns()` côté index.html **et** tg-analyst.js — toujours synchroniser les 2. Le `_filterContradictoryPatterns` élimine les bullish+bearish coexistants.
10. **Setup detection** ULTRA FIABLE (v2.54) : `validateLong()` refuse stop>=entry, TP1<=entry, R/R<1.8. Ne pas relâcher.
11. **FAB Analyste** (tg-analyst.js) : visible UNIQUEMENT dans view-resultats (MutationObserver sur .active). Pas sur les autres pages.
12. **Conversion devise** : taux FX via frankfurter.app (BCE) avec fallback Yahoo EURUSD=X. **Jamais de fallback hardcoded** (cf bug v2.57→v2.58 où 0.92 obsolète donnait +7%).
13. **Workflow ai-study** : cron 15 min (`*/15 * * * *`). Cache local 5 min pour cohérence.

## 🎓 Freemium philosophie

**FREE = apprentissage complet** : M0-M3 + M5 + M4 ch.1-3 + simu illimité + biblio + glossaire + défi du jour
**PREMIUM = mode expert** : M4 ch.4-7 + Patterns Lab + Krachs + Marché Live + futurs Coach IA / vidéos / newsletter

Pas de paywall sur les bases — c'est non négociable.

## 🛣️ Roadmap priorité immédiate

1. **Test Samsung v2.58** → reporter bugs (sélecteur devise, refresh IA, FAB analyste, pattern detector)
2. **Onboarding 3 écrans** pour nouveaux users (pédagogie + valeur Premium + add-to-home)
3. **Badges XP** Duolingo-style ("1er trade tracké", "10 patterns analysés", "Streak 7 jours")
4. **Multi-timeframe** sur le pattern detector (1h / 4h / 1j pour contextualisation)
5. **Mini-graph SVG** dans le popup IA (60 dernières bougies + lignes neckline/target/stop)
6. **Notifs push web** quand un pattern apparaît sur la watchlist (Web Push API, sans backend)
7. **TWA Play Store** soumission (TWA-ready, sans surcouche native)
8. **Lighthouse audit** + Three.js local (gain ~600 KB initial load)

## 🚀 Projet long terme (NATIF, hors PWA)

Aurélien envisage une **surcouche d'analyse de graph par-dessus une autre app** (Binance, TradingView mobile).
**Impossible en PWA pure** : nécessite Android natif (Kotlin/Capacitor) +
SYSTEM_ALERT_WINDOW + MediaProjection + ML Kit Vision. ~2-3 mois solo. Projet séparé.

Pour le détail complet historique, voir HANDOFF.md.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
