# Trade Genius — HANDOFF v1.95

> **Studio :** Deponchy Studio · **Dev solo :** Aurélien
> **Version :** v1.95 (50 commits depuis v1.49)
> **Date :** 2026-05-19
> **Prod :** https://qf06.github.io/Trade-Genius/
> **Repo :** https://github.com/qf06/Trade-Genius
> **Local :** `C:\Users\qfichet\Desktop\Document IA\Trade Genius\files\`

---

## ⚡ Reprise rapide nouvelle session

1. Lire ce fichier
2. Lire `C:\Users\qfichet\.claude\projects\C--Users-qfichet\memory\project_trade_genius.md`
3. Vérifier état : `git log --oneline -10` dans le dossier `files/`
4. User préfère **français concis, code-first, pas de hype**
5. Permission mode = `bypassPermissions` (auto-validé)

---

## Fichiers racine (24)

| Fichier | Rôle |
|---|---|
| `index.html` | Hub, views welcome/modules/accueil, burger menu, codes test |
| `tg-common.js` | Module ES6 partagé (window.TG), glossaire, daily, recap, quiz |
| `scene-01.html` | Module 0 — Bases (free) |
| `scene-02.html` | Module 1 — Marché (free) |
| `scene-03.html` | Module 2 — Bougies (ch1-3 free, ch4-7 premium) |
| `scene-04.html` | Module 3 — Patterns (ch1-3 free, ch4-7 premium) |
| `scene-05.html` | Simulateur broker-like (6800+ lignes) |
| `scene-06.html` | Bibliothèque 26 fiches |
| `glossary.html` | Page glossaire dédiée |
| `privacy.html` | Politique RGPD |
| `sw.js` | Service Worker (network-first HTML, cache-first assets) |
| `manifest.json` | PWA + TWA-ready |
| `icon.svg` | Monogramme T-chandelier acid (drop TG ambigu) |
| `icon-192.png` / `icon-512.png` | Icônes PWA |
| `og-image.png` | 1200×630 partage social |
| `bump.sh` | Bump version (Bash) |
| `final-audit.cjs` | Script audit Node |
| `.well-known/assetlinks.json` | Template TWA Play Store |
| `PLAYSTORE.md` | Guide TWA + Bubblewrap |
| `APP_LISTING.md` | Textes store |
| `NOTIFICATIONS.md` | Roadmap notif (3 niveaux) |
| `FREEMIUM.md` | Modèle 3€/mois ou 25€/an |
| `MODULE-4.md` | Roadmap Analyse avancée (50 slides à rédiger) |
| `HUB-REDESIGN.md` | Plan refonte hub |

---

## Design tokens

```css
--bg: #0a0a0f
--surface: #13131c
--acid: #00ff88
--purple: #a855f7
--card-radius: 16px
--gap-major: 16px
--header-height: 64px
```

Fonts : Manrope (body) + JetBrains Mono (data).

---

## Features livrées (v1.49 → v1.95)

**Pédago**
- 4 modules (M0-M3), récap fin de chapitre encadré
- Quiz fin de module + confettis (Ch7)
- Tooltips `?` réécrits intuitifs
- M0 Ch6 (Bitcoin) refonte : contexte 2008 + Satoshi

**Engagement**
- Streak avec danger notif (<24h restantes)
- Défi du jour (18 questions, m:0-3)
- Citation du jour
- Bookmark "reprendre"
- Récap fin de chapitre visuel
- Confetti fin de module

**Simulateur**
- Bottom sheet trade panel
- Sticky toolbar [Vendre][Avancer][Acheter]
- Slider % capital
- Lignes chart : entry ⊕, stop 🛡, take-profit 🎯
- Tuto 7 étapes fluide (transitions CSS)
- Coach hint contextuel (side + position + change5)
- Panel cash + jours restants toujours visible (fix espace mort)

**Freemium**
- M0/M1 = 100% free
- M2/M3 ch1-3 = free, ch4-7 = premium (verrou via `isPremium()`)
- Premium card hub (gradient acid+purple)
- 3€/mois ou 25€/an (futur Play Billing)

**UX/Hub**
- Hero "Reprendre" gradient acid+purple style Duolingo
- Tools-grid 2x2 (Apprendre/Entraîner/Bibliothèque/Analyse🔒)
- Burger menu drawer ☰ + modal codes test
- Anime.js : animateAccueilEntrance, animateModulesEntrance, animateCount

**Tech**
- PWA install prompt
- Service Worker network-first HTML, cache-first assets
- Web Share API + canvas 2D fallback
- Umami Analytics (cookieless RGPD) — ID `4789a3ad-b04e-4766-abee-91b1f1b41a0c`
- TWA-ready (assetlinks template)
- og-image généré via sharp

---

## Storage keys (localStorage)

```
tradegenius_v1     → progression M0 (état globalLevel, completed, streak, lastVisit, quizzes)
tradegenius_m1     → M1
tradegenius_m2     → M2
tradegenius_m3     → M3
tg_bookmark        → {moduleId, chapterId, slideIdx}
tg_premium         → boolean
tg_glossary_seen   → array slugs
tg_daily_state     → {date, done, qid, correct}
tg_streak          → {count, lastDay}
tg_notif_state     → {permission, lastReminder}
tg_consent         → boolean
```

---

## window.TG API (depuis tg-common.js)

```js
TG.shareCard({title, text, url})
TG.addGlossaryTerm(slug)
TG.getGlossary()
TG.isPremium()
TG.setPremium(bool)
TG.recordVisit()
TG.resetConsent()
TG.showRecap(moduleId, chapterId, opts)
TG.launchConfetti()
TG.getNotifState()
TG.requestNotifPermission()
TG.disableNotifs()
TG.checkStreakDangerNotify()
TG.getDailyChallenge()
TG.getDailyState()
TG.showDailyChallenge()
TG.showModuleQuiz(moduleId)
TG.TG_VERSION
```

---

## Codes test (burger menu ☰)

| Code | Action |
|---|---|
| `resetall` | Reset complet (localStorage clear + reload) |
| `resettrain` | Reset simulateur uniquement |
| `resetstreak` | Reset streak |
| `resetdaily` | Reset défi du jour |
| `premium` | Toggle premium ON |
| `unpremium` | Toggle premium OFF |
| `m0done` / `m1done` / `m2done` / `m3done` | Marque module complet |
| `unlockall` | Tout déverrouille |
| `confetti` | Test animation |
| `dailydone` | Marque défi fait |

---

## Pièges connus (à NE PAS reproduire)

1. **`sw.js` cache buster** : `bump.sh` doit toucher `tg-common.js?v=X` ET la `const VERSION = 'tg-v...'` du SW
2. **Slides débordants** : NE PAS mettre `overflow-y: auto`. Raccourcir le contenu.
3. **Logo TG ambigu** : « TG » = « ta gueule » en SMS Gen Z FR. → monogramme T-chandelier
4. **Apostrophes ’** : escape double `\\u2019` quand string dans template literal injecté
5. **Onclick='finish()'** : fonction inexistante scene-01 → utiliser `next()`
6. **Animations slide-in qui ressautent** : préférer CSS `transition: top, left .42s cubic-bezier`
7. **Targets tuto cachés** : `.sim-qty-row` masqué depuis refonte bottom sheet → utiliser `.tb-buy/.tb-sell/.tb-advance`
8. **Path SVG sur texte** : vérifier y des paths rouges ne traversent pas y du texte
9. **Faux positif audit** : `onclick="if(event.target===this)..."` détecté comme fonction manquante
10. **`.claude/.mcp.json` protégé** : auto-mode refuse Self-Modification → user doit lancer `claude mcp add ...` lui-même

---

## Commandes dev

```bash
# Bump version (depuis dossier files/)
bash bump.sh 1.96

# Audit complet
node final-audit.cjs

# Commit + push (auto-mode autorise)
git add -A && git commit -m "v1.96 — message" && git push
```

---

## Roadmap

**Court terme**
- [ ] Module 4 (Analyse avancée, 7 ch, ~50 slides) — cf. MODULE-4.md
- [ ] Vérifier icon-192/512.png reflètent T-chandelier
- [ ] Screenshots Samsung Play Store (4-7 captures)
- [ ] Refonte header avatar+streak grand — cf. HUB-REDESIGN.md

**Moyen terme**
- [ ] Verrous freemium fins (simu scenarios 4+, biblio fiches 6+)
- [ ] Plus de scenarios simu (10 → 20)
- [ ] Push notifications FCM (niveau 3 NOTIFICATIONS.md)

**Long terme**
- [ ] Vrai paiement Play Billing
- [ ] Tuteur IA Claude API
- [ ] Données marché live (Binance)

---

## Workflow déploiement

1. Modifier fichiers dans `C:\Users\qfichet\Desktop\Document IA\Trade Genius\files\`
2. `bash bump.sh X.YZ`
3. Vérifier `index.html` (badge version), `sw.js` (const VERSION), `tg-common.js` (TG_VERSION)
4. `git add -A && git commit -m "vX.YZ — ..." && git push`
5. GitHub Pages déploie auto en ~30s
6. Tester sur Samsung (cible primaire)

---

## Règles communication user (Aurélien)

- **Français** uniquement
- **Concis** : pas de blabla, pas de hype, code-first
- **Tokens** : éviter de répéter inutilement, pas de récap si pas demandé
- **Tout en auto** : ne pas demander pour des actions évidentes (bypassPermissions actif)
- **Audit final** demandé après gros chantier
- **Test user-side** : Aurélien teste sur Samsung réel, retours type "ça fait brouillon", "trait rouge sur le texte" → traiter sérieusement

---

## Sécurité — À FAIRE côté user

⚠️ **L'API key Magic MCP `c31c45f411d09e2989476c...` a été collée en clair dans le chat précédent.**
→ Aurélien doit **révoquer cette clé** et en générer une nouvelle avant utilisation.

---

## Stats session précédente

- 50 commits (v1.49 → v1.95)
- 24 fichiers racine
- ~12000 lignes JS/HTML/CSS modifiées
- 4 bugs Samsung corrigés
- 1 logo refait
- Audit Node complet passé (1 faux positif identifié)

---

## Points entrée nouvelle session

**Pour reprendre direct :**
```
"Lis HANDOFF.md et project_trade_genius.md, on est en v1.95, on continue."
```

**Pour Module 4 :**
```
"Lis MODULE-4.md, rédige le chapitre 1 (~7 slides)."
```

**Pour refonte hub :**
```
"Lis HUB-REDESIGN.md, applique étapes 1-3."
```

**Pour bug fix :**
```
"Bug : [description]. Repro : [étapes]. Fichier suspect : [scene-X.html]."
```
