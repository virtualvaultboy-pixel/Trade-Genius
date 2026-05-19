# 💰 Trade Genius — Plan Freemium

## Gratuit (acquisition)
- ✅ Module 0 (Monnaie) — 7 chapitres complets
- ✅ Module 1 (Marché) — 7 chapitres complets
- ✅ Bibliothèque : 5 fiches (Livret A, PEA, Assurance-vie, ETF, Action)
- ✅ Simulateur : 3 scenarios (AAPL crash, MSFT 2018, BTC 2017)
- ✅ Défi du jour (1/jour)
- ✅ Glossaire complet (26 termes)
- ✅ Streak, splash, partage

## Premium — 3€/mois ou 25€/an (-30%)
- 🔒 Module 2 (Chart) — 7 chapitres
- 🔒 Module 3 (Psycho) — 7 chapitres
- 🔒 **Module 4 (Analyse avancée)** — NEW, 7 chapitres
- 🔒 Bibliothèque complète : 26 fiches (vs 5)
- 🔒 Simulateur : 10+ scenarios (vs 3)
- 🔒 Défi illimité (5/jour vs 1)
- 🔒 Stats avancées (winrate par scenario, perf historique)
- 🔒 Glossaire étendu (50+ termes)
- 🔒 Notifications push avancées

## Tech implémentation

### Phase 1 (UI verrous)
- `localStorage.tradegenius_premium` (manual debug toggle)
- Helper `isPremium()` dans tg-common.js
- Modules 2+ → card avec cadenas + "Devenir Premium"
- Simu : scenarios 4+ → cards locked
- Biblio : fiches 6+ → preview + locked

### Phase 2 (paiement)
**Option A — Play Billing (recommandé)** : 
- Via TWA, 15% commission Google
- Subscription gérée par Play Store
- Pas de backend nécessaire

**Option B — Stripe + Cloudflare Workers** :
- ~5€/mois infra
- Commission 1.4% + 0.25€
- Plus de marge, mais setup serveur

**Option C — RevenueCat** :
- Wrapper unifié iOS/Android/Web
- Free jusqu'à 2.5k$ MRR
- Recommandé si extension iOS plus tard

### Phase 3 (modèles user)
- ID user via Firebase Auth (gratuit jusqu'à 50k)
- Synchro progression cross-device
- Token premium dans JWT signé
