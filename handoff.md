# Trade Genius — HANDOFF v2.64

> **Studio :** Deponchy Studio · **Dev solo :** Aurélien
> **Version :** v2.64 (~115 commits depuis v1.49)
> **Date :** 2026-05-21
> **Prod :** https://virtualvaultboy-pixel.github.io/Trade-Genius/
> **Repo :** https://github.com/virtualvaultboy-pixel/Trade-Genius
> **Local :** `C:\Users\qfichet\Desktop\Document IA\Trade Genius\files\`

## 🆕 Récap v2.16 → v2.64

- **v2.17-v2.22** Pivot architectural : bottom nav 5 onglets · feed daté · XP/niveaux Duolingo
- **v2.26-v2.35** Live data : Watchlist · 10 indicateurs client-side · Indices Yahoo · Actus auto
- **v2.36-v2.48** Workflows GH Actions illimités : news/daily/decryptages/ai-study auto-générés. IA via Pollinations + setup pédago + affiliation broker + cron 15 min
- **v2.50-v2.64** Pattern detector (9 patterns) · analyseur ULTRA FIABLE · FAB Analyste 🤖 · sélecteur devise · mini-graph SVG · backtest client-side · cas rejouable · badges Duolingo · notifs · catalogue 52 actifs (indices/crypto/actions/forex/métaux)

---

## 🎯 TG Winner (post v8.4, pas encore intégré index.html)

Stratégie META validée scientifiquement par lab Python (`scripts/lab/lab_winner_final.py`) :
**Mix 50% B&H safe (SPY 60 / TLT 30 / GLD 10) + 50% META 3 IAs leveraged**.

Backtest 2016-09 → 2026-01 :
- **23.1%/an**, Max DD -33.2%, Calmar 0.69
- MC 500 iters : P(profit) 100%, P(annual ≥ 15%) 83%
- Survives stress 5× frais/slippage : 23.0%

### Fichiers livrés

| Fichier | Rôle |
|---|---|
| `scripts/build-tg-winner.mjs` | Pull prices Yahoo + FX frankfurter → génère JSON |
| `scripts/test-tg-winner.mjs` | Smoke tests (somme poids, allocations, FX) — `node scripts/test-tg-winner.mjs` |
| `.github/workflows/tg-winner.yml` | Cron mensuel `0 6 1 * *` + dispatch + push trigger |
| `data/tg-winner.json` | Snapshot live (prices + alloc 1k/10k EUR) |
| `data/tg-winner-history/YYYY-MM.json` | Historique mensuel des snapshots |
| `tg-winner.js` | Module PWA : `window.TGWinner.{load, renderBasket, computeUserPnL, ...}` |
| `tg-winner-demo.html` | Page demo standalone (servir via http, pas file://) |

### Intégration dans l'app — STATUS

**NON ENCORE INTÉGRÉ** dans `index.html`. La demo standalone valide visuellement
avant d'attaquer les 4500 lignes du hub. 3 options possibles :
- (A) Nouvelle scene dédiée → liée depuis Premium
- (B) Carte dans le feed Accueil + bouton voir tout → scene dédiée
- (C) Remplace les 5 IAs actuelles (BASTION/PHENIX/RAFALE/NEXUS/VOLT) — breaking

### Pièges connus TG Winner

1. **FX** : `tg-winner.js` lit `window.TG.fxRates.EUR_USD` (warm-up async tg-common.js v2.57). Fallback chain : TG.fxRates → snapshot JSON → static 1.087.
2. **Rebalance** : `nextRebalanceDate()` cible TOUJOURS le 1er du mois suivant (que le run soit le 1er ou le 28).
3. **History** : 1 fichier par mois calendaire, overwrite sur runs multiples du même mois.
4. **Tests** : `node scripts/test-tg-winner.mjs` (34 tests, exit 1 si fail).
5. **Demo** : ouvrir via `python -m http.server` (file:// = CORS fetch bloqué).
6. **Strategy.version vs app version** : indépendant volontaire. `tg-winner.json:strategy.version` = "1.0.0" pour la stratégie, sw.js version = app.
7. **Risque AMF** : "23%/an attendu" peut être interprété comme promesse rendement. Formuler "performance backtest historique" avant publi.
8. **ETF leveraged TQQQ x3** : produit PRIIPs, vérifier dispo Trade Republic FR / BoursoBank avant publi.

---

## ⚡ Reprise rapide nouvelle session

1. Lire ce fichier
2. Lire `C:\Users\qfichet\.claude\projects\C--Users-qfichet\memory\project_trade_genius.md`
3. Vérifier état : `git log --oneline -10` dans le dossier `files/`
4. User préfère **français concis, code-first, pas de hype**
5. Permission mode = `bypassPermissions` (auto-validé)
6. **Pas de dépense d'argent** en infra ou API (Claude 100€/mois déjà payé suffisant)

---

## Fichiers racine (27)

| Fichier | Rôle |
|---|---|
| `index.html` | Hub, welcome/modules/accueil, burger menu, codes test, premium-fab |
| `tg-common.js` | Module ES6 partagé (window.TG), glossaire, daily, recap, quiz, _isPremiumSafe |
| `scene-01.html` | Module 0 — Monnaie (7 ch, FREE) |
| `scene-02.html` | Module 1 — Marché (7 ch, FREE) |
| `scene-03.html` | Module 2 — Chart (7 ch, FREE — gating retiré v2.01) |
| `scene-04.html` | Module 3 — Psycho (7 ch, FREE — gating retiré v2.01) |
| `scene-05.html` | Simulateur broker-like (6800+ lignes) |
| `scene-06.html` | Bibliothèque 26 fiches |
| `scene-07.html` | Module 4 — Étude des courbes (7 ch, ch.1-3 FREE / ch.4-7 PREMIUM) |
| `scene-08.html` | **Patterns Lab Premium** (12 patterns détaillés, vue list+detail) |
| `scene-09.html` | **Historiques Premium** (4 krachs détaillés) |
| `scene-10.html` | **Marché live Premium** (Crypto/Actions/ETF, 6 indicateurs) |
| `scene-11.html` | **Module 5 — Fiscalité française (7 ch, 100% FREE)** |
| `glossary.html` | Page glossaire dédiée |
| `privacy.html` | Politique RGPD |
| `sw.js` | Service Worker (cache 11 scenes + tg-common + assets) |
| `manifest.json` | PWA + TWA-ready |
| `icon.svg` | Monogramme T-chandelier acid |
| `icon-192.png` / `icon-512.png` | Icônes PWA |
| `og-image.png` | 1200×630 partage social |
| `bump.sh` | Bump version (loop 01-11) |
| `final-audit.cjs` | Script audit Node |
| `.well-known/assetlinks.json` | Template TWA Play Store |
| `PLAYSTORE.md` | Guide TWA + Bubblewrap |
| `APP_LISTING.md` | Textes store |
| `NOTIFICATIONS.md` | Roadmap notif (3 niveaux) |
| `FREEMIUM.md` | Modèle freemium v2.01 (réécrit) |
| `MODULE-4.md` | Specs Module 4 (livré v2.00) |
| `HUB-REDESIGN.md` | Plan refonte hub (livré v1.96) |

---

## Évolution majeure v1.95 → v2.16 (21 versions)

### Refonte design hub (v1.96-1.99)
- **v1.96** : Header sticky avec avatar + greeting + streak grand · Hero REPRENDRE prioritaire · stats avec icônes · premium pulse acid · hover-lift tools · animations restructurées
- **v1.97** : Aurora background (2 calques mouvants) · hero shine sweep · avatar float · flame flicker · tools tilt 3D · count-up overshoot
- **v1.98** : **Canvas trading chart bg** signature fintech · glassmorphism cards · sparklines stats · SVG flame animée · text scramble greeting · magnetic touch tools
- **v1.99** : Cleanup hub (retire header-bar, parcours-progress, tool Analyse) · Apprendre → Modules · winrate non-clickable · auto-tuto désactivé

### Module 4 (v2.00, v2.02, v2.10, v2.12, v2.13)
- **v2.00** : Création scene-07.html (Module 4 — Étude des courbes) · 7 chapitres × 4 slides · Canvas demos (patterns/RSI/MACD/Fibo) · quiz fin module 8Q
- **v2.02** : Ch.1 patterns chandeliers ultra-visuel · 6 slides au lieu de 4 · canvas dédiés (anatomie/hammer/doji/engulfing/morning star/récap) · `chapterSize(n)` dynamique
- **v2.10** : M4 ch.4-7 Premium enrichis (4 → 7 slides détaillées par chapitre, ~150-250 mots/slide, exemples Goldman/Citadel/BNP/Lehman/BTC)
- **v2.12** : Canvas pédagogiques ch.4-7 (Dow phases, Volume Profile, Order book ladder, Equity curve)
- **v2.13** : Fix RSI/MACD clarté débutant + CSS .slide overflow fix (flex-start + scroll touch)

### Freemium (v2.01, v2.04, v2.05)
- **v2.01** : Refonte philosophique — M2/M3 100% gratuits (gating ch.4-7 retiré). Premium = mode expert + accompagnement, pas paywall pédago. FREEMIUM.md réécrit
- **v2.04** : Module 4 free montre seulement ch.1-3 + carte teaser premium (plus de pill premium sur ch.4-7 visibles) · bouton `#premium-fab` permanent fixed top-right
- **v2.05** : Structure finale — accueil free voit 4 tools verrouillés (cadenas), bandeau Premium full-width accrocheur · accueil premium distinct avec widget Marché Live mock + tools débloqués + section Vidéos

### Premium pages (v2.03, v2.06, v2.08, v2.09)
- **v2.03** : Création scene-08 Patterns Lab (6 patterns) + scene-09 Historiques (4 krachs) · body.premium-mode transformation · refreshPremiumMode()
- **v2.06** : Titre TRADE GENIUS en haut du hub · widget Marché Live câblé CoinGecko free API · scene-10.html (Analyse Marché 6 cryptos + RSI calc côté JS + verdict)
- **v2.08** : scene-10 multi-tab Crypto/Actions/ETF · Yahoo Finance via corsproxy.io · 6 indicateurs côté JS (RSI, MA20, MA50, MACD, Bollinger, Momentum) · verdict combiné
- **v2.09** : Patterns Lab vue détail par pattern (definition/anatomy/psycho/trade/pitfall/historic) + Krachs vue détail (contexte/chronologie/causes/conséquences/signes/prémunir/leçons)

### v2.07 (fix premium + tutos)
- Fix bug code `premium` (tg-common.js module ES async + import Three.js unpkg → window.TG.setPremium peut être undefined → silent fail)
- Fallback localStorage direct dans codes burger et helper `_isPremiumSafe()`
- Tutos adaptés : ACCUEIL_TUTO_STEPS_FREE (7 steps) + PREMIUM_TUTO_STEPS (4 steps) déclenchés selon mode
- Bouton burger "Revoir le tuto" (`replayTuto()`)

### v2.11 (fixes UX) — IMPORTANT
- Fix positionTutoBubble (index + scene-05) : ne plus chevaucher la cible (bug bulle Vendre simu)
- `max-height: 80vh` + `overflow-y: auto` sur .tuto-bubble
- Pensée du jour (#hero-daily) RETIRÉE de l'accueil (allégement)
- Burger enrichi : 5 sections (Navigation · Apprendre · Mode Expert · Tes stats · À propos avec popup détaillé)
- `refreshBurgerInfos()` sync auto à chaque openBurger()

### v2.12 (Patterns Lab étendu)
- **6 → 12 patterns** : ajout Cup & Handle, Rising/Falling Wedge, Pennant, Rectangle, Rounding Bottom
- Chacun avec drawer canvas + fiche détaillée + exemples historiques datés

### v2.14 (Welcome refondue)
- 6 sections scrollables : Hero · Stats hero · Modules preview · Parcours · Promesses · CTA
- #view-welcome overflow-y: auto (était fixed sans scroll)

### v2.15 (Module 5 Fiscalité FR) — NOUVEAU
- **scene-11.html créée** — 28 slides détaillées, 100% gratuit
- 7 chapitres : PEA vs CTO · Flat tax 30% · Abattements · Crypto · Dividendes · ETF UCITS · Plan optimal
- Tableaux comparatifs, callouts colorés, exemples chiffrés
- Storage `tradegenius_m5`, bookmark m5_bookmark
- module-card 5 (vert), MODULES array, CHAPTER_TITLES, burger

### v2.16 (Cleanup)
- ~175 lignes CSS/JS retirées (`.hello`, `.hero-daily`, `.parcours-progress`, `.streak-badge` morts)
- Fonction `updateParcoursProgress()` retirée + appel
- Timeline anime.js compactée

---

## Design tokens

```css
--bg: #0a0a0f
--surface: #13131c
--acid: #bef264
--purple: #a78bfa
--blue: #60a5fa
--gold: #f59e0b   /* Premium */
--green: #22c55e  /* Fiscalité, Module 5 */
--red: #ef4444
--card-radius: 16-18px
--gap-major: 16px
```

Fonts : Manrope (body) + JetBrains Mono (data).

---

## Storage keys (localStorage)

```
tradegenius_v1     → progression M0 (Monnaie)
tradegenius_m1     → M1 (Marché)
tradegenius_m2     → M2 (Chart)
tradegenius_m3     → M3 (Psycho)
tradegenius_m4     → M4 (Étude des courbes)
tradegenius_m5     → M5 (Fiscalité FR) — NEW v2.15
tradegenius_m4_journal → journal simu (différent de _m4 module !)
tradegenius_m5_viewed  → biblio fiches lues (collision conceptuelle mais clé différente)
tg_bookmark            → {moduleId, chapterId, slideIdx}
tg_premium             → boolean (lu via _isPremiumSafe)
tg_glossary_seen       → array slugs
tg_daily_state         → {date, done, qid, correct}
tg_streak              → {count, lastDay}
tg_notif_state         → {permission, lastReminder}
tg_consent             → boolean
tradegenius_accueil_tuto    → '1' si vu
tradegenius_premium_tuto    → '1' si vu (nouveau v2.07)
```

---

## window.TG API (tg-common.js)

```js
TG.shareCard, TG.addGlossaryTerm, TG.getGlossary
TG.isPremium, TG.setPremium  // utiliser _isPremiumSafe() côté index.html
TG.recordVisit, TG.resetConsent
TG.showRecap, TG.launchConfetti
TG.getNotifState, TG.requestNotifPermission, TG.disableNotifs, TG.checkStreakDangerNotify
TG.getDailyChallenge, TG.getDailyState, TG.showDailyChallenge
TG.showModuleQuiz   // moduleId 0-4 supportés (8 questions chacun)
TG.TG_VERSION
```

---

## Helpers critiques index.html

```js
_isPremiumSafe()      // fallback localStorage direct (TG_VERSION pas tjs prêt)
refreshPremiumMode()  // toggle body.premium-mode + UI dynamique
refreshBurgerInfos()  // sync burger stats/progression
replayTuto()          // déclenche bon tuto selon mode
positionTutoBubble()  // v2.11 fix chevauchement target
```

---

## Codes test (burger menu ☰)

| Code | Action |
|---|---|
| `resetall` | Reset complet (localStorage clear + reload) |
| `resetmodules` | Reset M0-M3 modules |
| `resetsimu` / `resettrain` | Reset simulateur |
| `resetbiblio` | Reset biblio |
| `resetstreak` | Reset streak |
| `resettuto` | Reset accueil_tuto + premium_tuto |
| `premium` / `unpremium` | Toggle premium (fix v2.07 : fallback localStorage) |
| `streak10` / `streak50` | Set streak |
| `alldone` | Marque M0-M3 done (M4 et M5 séparés) |
| `confetti` | Test animation |
| `about` | Version + studio |
| `help` | Liste codes |

---

## Pièges connus (à NE PAS reproduire)

1. **`sw.js` cache buster** : `bump.sh` couvre 01-11 (étendu à 11 en v2.15)
2. **Slides débordants** : v2.13 a fixé via `justify-content: flex-start` + `overflow-y: auto` sur .slide. Si re-débordement, vérifier le scroll touch.
3. **Logo "TG" interdit** : « TG » = « ta gueule » en SMS Gen Z FR → monogramme T-chandelier
4. **Apostrophes ’** : escape double `\\u2019` dans template literals injectés
5. **Tutoriels bulles hors écran** : v2.11 a fixé via `positionTutoBubble` qui ne chevauche plus la cible. Resize utilise `_tutoActiveSteps` (free/premium switch).
6. **tg-common.js async + import Three.js unpkg** : `window.TG.setPremium/isPremium` peut être `undefined` à l'init → utiliser `_isPremiumSafe()` partout côté index.html
7. **`.claude/.mcp.json` protégé** : auto-mode refuse Self-Modification → user lance `claude mcp add` lui-même
8. **Push direct sur main** : workflow normal du projet, auto-classifier peut bloquer la 1ère fois (l'user a déjà autorisé)
9. **MODULES[4].advanced: true** : M4 exclu du déblocage simu (M0-M3 suffisent)
10. **3 modules ont des chapitres avec gating premium** : seulement M4 (ch.4-7). M2/M3 sont FREE depuis v2.01 (oubli en v1.95 corrigé).

---

## Architecture freemium (v2.05+)

### 🆓 Free (apprentissage complet)
- M0 Monnaie · M1 Marché · M2 Chart · M3 Psycho · **M5 Fiscalité FR** (tous 7 chapitres)
- M4 Étude des courbes ch.1-3 (patterns, RSI, MACD/Bollinger = bases AT)
- Simu illimité, biblio 26 fiches, glossaire, défi du jour, streak

### ✦ Premium (mode expert + accompagnement)
- M4 ch.4-7 (Dow+Fibo, Volume Profile, Order book, Backtesting)
- Patterns Lab (scene-08) — 12 patterns détaillés
- Krachs historiques (scene-09) — 4 krachs analyse complète
- Marché Live (scene-10) — Crypto/Actions/ETF + 6 indicateurs
- Vidéos placeholder (Q3 2026)
- Coach IA placeholder (consommerait Claude API, attente rentabilité)

---

## Sources data live (gratuit, 0€)

- **Crypto** : CoinGecko free API (30 req/min, sans clé, CORS OK)
- **Actions/ETF** : Yahoo Finance via `corsproxy.io` (public proxy gratuit)
- **Calculs indicateurs** : 100% côté JS (RSI Wilder, MA, EMA, MACD, Bollinger, ROC)
- **Hébergement** : GitHub Pages (free)
- **Total coût** : 0€/mois

---

## Commandes dev

```bash
# Bump version (depuis dossier files/)
bash bump.sh 2.17

# Audit Node (si dispo)
node final-audit.cjs

# Commit + push
git add -A && git commit -m "vX.YZ — message" && git push
```

---

## Roadmap restante

### Court terme (à valider après test Samsung v2.16)
- [ ] Test sur Samsung que tout marche (tuto bulles, MACD/RSI clairs, slides scroll, premium toggle)
- [ ] Bug ? Reporter en `bug.md` ou directement message Claude
- [ ] **Canvas Module 5** (visuels PEA vs CTO croissance composée, flat tax décomposition, etc. — comme M4 v2.12)
- [ ] **+5 scénarios simu historiques** : krach 1987, 1929, Lehman 2008, COVID 2020, FTX 2022

### Moyen terme
- [ ] Recherche dans Glossaire + Biblio (26 termes/fiches scroll fatigant)
- [ ] +6 fiches biblio courtiers FR (TR, Bourso, BoursoBank, Fortuneo, Degiro, eToro)
- [ ] Onboarding 3 écrans avant welcome (niveau · objectif · temps/semaine)
- [ ] Badges/Achievements Duolingo
- [ ] Three.js local au lieu d'unpkg (~600KB gain)
- [ ] Lighthouse audit + optims

### Long terme
- [ ] Play Store submission (TWA-ready)
- [ ] SEO sitemap.xml + schema.org
- [ ] Coach IA réel (Claude API) **quand rentable**
- [ ] Newsletter perso, vidéos, watchlist live (idem, quand rentable)

---

## Workflow déploiement

1. Modifier fichiers dans `C:\Users\qfichet\Desktop\Document IA\Trade Genius\files\`
2. `bash bump.sh X.YZ`
3. Vérifier `index.html` (`#bd-version` + `#hbb-tag`), `sw.js` (const VERSION), `tg-common.js` (TG_VERSION)
4. `git add -A && git commit -m "vX.YZ — ..." && git push`
5. GitHub Pages déploie auto en ~30s
6. Tester sur Samsung (cible primaire)

**Note bump.sh** : remplace `?v=` dans index + toutes les scenes 01-11 + sw.js. Le `bd-version` et `hbb-tag` doivent être édités manuellement (pas dans le sed).

---

## Règles communication user (Aurélien)

- **Français** uniquement
- **Concis** : pas de blabla, pas de hype, code-first
- **Tokens** : éviter de répéter inutilement, pas de récap si pas demandé
- **Tout en auto** : ne pas demander pour des actions évidentes (bypassPermissions actif)
- **Pas de dépense d'argent** : Claude 100€/mois déjà suffisant, infra gratuite obligatoire
- **Test user-side** : Aurélien teste sur Samsung réel, retours type "ça fait brouillon", "bulle sur Vendre" → traiter sérieusement
- **Pousser sur main** : autorisé (workflow normal, pas de PR)

---

## Sécurité

⚠️ **API key Magic MCP exposée** dans 2 chats précédents (`21st_sk_148bb...` et `c31c45f4...`) → **révoquer + régénérer** avant utilisation 21st.dev Magic.

---

## Stats sessions v1.95 → v2.16

- **21 versions** poussées (v1.96 → v2.16)
- **+3 scenes créées** : scene-07 (M4), scene-08 (Patterns Lab), scene-09 (Historiques), scene-10 (Marché Live), scene-11 (M5 Fiscalité) = **+5 scenes en réalité** (10 → 11)
- **+1 module** : Module 5 Fiscalité FR
- **+6 patterns** dans Patterns Lab (6 → 12)
- **+8 questions M4** dans le pool quiz
- **~3000+ lignes ajoutées** au total
- **~175 lignes mortes retirées** (v2.16 cleanup)
- **Coût infra** : maintenu à 0€

---

## Points entrée nouvelle session

**Pour reprendre direct :**
```
Lis HANDOFF.md et project_trade_genius.md, on est en v2.16, on continue.
```

**Pour tester :**
```
J'ai testé sur Samsung v2.16 et : [bugs observés]. Fix prioritaire.
```

**Pour Canvas M5 (visuels fiscalité) :**
```
Ajoute des canvas visuels au Module 5 comme M4 v2.12 : PEA vs CTO croissance composée, etc.
```

**Pour scenarios simu :**
```
Ajoute 5 scenarios simu historiques dans scene-05.html : 1987 Black Monday, 1929, Lehman 2008, COVID 2020, FTX 2022.
```

**Pour bug fix :**
```
Bug : [description]. Repro : [étapes]. Fichier suspect : [scene-X.html].
```
