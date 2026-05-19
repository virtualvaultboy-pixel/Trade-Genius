# 💰 Trade Genius — Modèle Freemium v2.01

> **Philosophie** : tout l'apprentissage est gratuit. Le Premium = mode expert + accompagnement quasi-personnalisé. Ne jamais frustrer un utilisateur qui veut apprendre les bases.

---

## 🆓 Gratuit (tout pour devenir autonome)

### Pédagogie complète
- ✅ **Module 0 — Monnaie** (7 chapitres complets)
- ✅ **Module 1 — Marché** (7 chapitres complets)
- ✅ **Module 2 — Chart** (7 chapitres complets) — *changé en v2.01, avant ch.4-7 premium*
- ✅ **Module 3 — Psycho** (7 chapitres complets) — *changé en v2.01, avant ch.4-7 premium*
- ✅ **Module 4 — Étude des courbes ch.1-3** : patterns chandeliers, RSI/momentum, MACD/Bollinger (bases d'analyse technique)

### Outils
- ✅ Simulateur de trading (illimité, débloque après M0-M3)
- ✅ Bibliothèque complète (26 fiches)
- ✅ Glossaire (26 termes)
- ✅ Défi du jour (1/jour)
- ✅ Streak, citation du jour, partage progrès
- ✅ Quiz fin de module + confettis
- ✅ Notifications rappels (basiques)

---

## ✦ Premium — 3€/mois ou 25€/an (-30%)

> Tout ce qui demande **données réelles**, **temps de l'IA** ou **techniques de pro**.

### Module 4 expert (ch.4-7)
- 🔒 **Dow + Fibonacci** — théorie classique, retracements 38.2/50/61.8
- 🔒 **Volume Profile + VWAP** — POC, Value Area, anchored VWAP
- 🔒 **Order book + microstructure** — bid/ask, iceberg, spoofing
- 🔒 **Backtesting + journal** — Sharpe, drawdown, profit factor, overfitting

### Accompagnement IA
- 🔒 **Coach IA** — review de tes sessions simu, suggestions de plans (Claude API)
- 🔒 **Analyse de TES trades** — win rate par setup, par horaire, drawdown personnel
- 🔒 **Newsletter hebdo personnalisée** — selon ta progression et tes points faibles

### Données live + scénarios pro
- 🔒 **Watchlist live** — prix temps réel (Binance / Yahoo Finance)
- 🔒 **Scénarios simu historiques** — krach 2008, COVID 2020, dotcom 2000, FTX 2022
- 🔒 **Stats avancées** — patterns détaillés sur ta progression

---

## Tech implémentation

### Phase 1 — Verrous UI (actuel)
- `localStorage.tradegenius_premium` (manual debug toggle via burger `premium` / `unpremium`)
- Helper `isPremium()` dans tg-common.js
- Module 4 ch.4-7 → confirm() avec redirect accueil pour upgrade
- Premium card hub accueil : message centré sur **mode expert + accompagnement**, jamais sur "débloquer le savoir de base"

### Phase 2 — Paiement
**Option A — Play Billing (recommandé)**
- Via TWA, 15% commission Google
- Subscription gérée par Play Store
- Pas de backend nécessaire

**Option B — Stripe + Cloudflare Workers**
- ~5€/mois infra
- Commission 1.4% + 0.25€
- Plus de marge, mais setup serveur

**Option C — RevenueCat**
- Wrapper unifié iOS/Android/Web
- Free jusqu'à 2.5k$ MRR
- Recommandé si extension iOS plus tard

### Phase 3 — Coach IA
- Endpoint Claude API (Anthropic) ou OpenAI
- Prompt système : "Tu es un coach trading pour un débutant qui termine ses modules. Analyse cette session simu et propose 3 améliorations."
- Limite : 20 reviews/mois pour les abonnés mensuels, illimité annuel
- Pas de stockage des trades sur serveur — tout local, payload envoyé à la demande

### Phase 4 — Données live
- Binance public API (gratuit, rate-limit)
- Yahoo Finance via proxy Cloudflare Worker
- Refresh 30s pour la watchlist (5 tickers max free, illimité premium)

---

## Pourquoi ce modèle

1. **L'apprentissage doit être accessible.** Si quelqu'un veut apprendre la bourse de zéro, il l'apprend ici, gratuitement, en entier.
2. **Le premium n'est pas un mur**, c'est une rampe — pour ceux qui ont fini les bases et veulent vraiment aller au-delà (techniques pro + accompagnement IA).
3. **Coût marginal réel** : le Coach IA, la watchlist live, les données historiques pro = des coûts variables (API Claude, datafeed). Le freemium est ici cohérent économiquement, pas artificiel.
4. **Trust > conversion** : un utilisateur qui termine M0-M3 gratuitement et trouve l'app excellente est 10× plus probable de prendre le premium qu'un utilisateur frustré au chapitre 4.
