<div align="center">

# Trade Genius

**Apprendre à trader. Vraiment.**

App pédagogique mobile-first qui explique honnêtement comment fonctionnent les marchés financiers — sans promesse de richesse, sans formation à 1 500 €, sans bullshit.

[![Status](https://img.shields.io/badge/status-v0.1%20MVP-d4af37?style=flat-square)](#roadmap)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Studio](https://img.shields.io/badge/studio-Deponchy-1a1a26?style=flat-square)](https://github.com/virtualvaultboy-pixel)

</div>

---

## 🎯 Pourquoi cette app

Le marché des "formations trading" est saturé à 90 % par des vendeurs de rêve qui facturent 500 à 2 000 € du contenu qu'on trouve gratuit ailleurs. Pendant ce temps, **74 à 89 % des traders retail perdent de l'argent** (chiffre imposé par l'ESMA, affiché par tous les brokers européens).

Trade Genius prend l'angle inverse : **apprendre à comprendre les marchés, pas à promettre des gains**. La leçon 6 du Module 1 s'appelle littéralement "Pourquoi 80 % des traders perdent" — et elle est placée *avant* les cours d'analyse technique. Volontairement.

---

## ✨ Ce que contient la v0.1

- **📚 Module 1 complet — Les fondations** (8 leçons rédigées, ~3 200 mots)
  1. Qu'est-ce qu'un marché financier ?
  2. Les classes d'actifs
  3. Comment fonctionne un ordre
  4. Lire un graphique
  5. Le carnet d'ordres et la liquidité
  6. **Pourquoi 80 % des traders perdent** *(leçon signature)*
  7. Les frais cachés
  8. Quiz récap

- **📖 Glossaire** — 53 termes essentiels du trading, recherche live
- **📊 Suivi de progression** — streak quotidien, leçons complétées, persistance localStorage
- **🎨 Design éditorial premium** — sombre raffiné, typo Fraunces + Manrope, accent or signature Deponchy

---

## 🗺️ Roadmap

| Version | Contenu | Statut |
|---------|---------|--------|
| **v0.1** | MVP : cours M01 + glossaire | ✅ Livré |
| v0.2 | Quiz interactifs + score + Module 2 (Analyse technique) | 🔜 |
| v0.3 | Tuteur IA personnalisé (Claude API) | 📋 |
| v0.4 | Simulateur historique crypto (Binance kline data) | 📋 |
| v0.5 | Mode événement (scénarios historiques : COVID, FTX, ETF flows) | 📋 |
| v1.0 | Release Google Play + IAP | 🎯 T4 2026 |

Détails complets dans [`handoff.md`](handoff.md).

---

## 🛠️ Stack

- **Frontend** : HTML / CSS / JS vanilla, single-file (`index.html`)
- **Stockage** : localStorage (clé `tradegenius_v1`)
- **Polices** : Fraunces (display) + Manrope (body) + JetBrains Mono (data) via Google Fonts
- **Mobile** : Capacitor (build prévu pour Android via Play Store)
- **IA** *(v0.3+)* : API Anthropic Claude (`claude-sonnet-4-20250514`)
- **Données marché** *(v0.4+)* : Binance public API

Pas de framework, pas de build step pour le MVP. Tu ouvres `index.html` dans un navigateur, ça tourne.

---

## 🚀 Lancer en local

```bash
git clone https://github.com/virtualvaultboy-pixel/Trade-Genius.git
cd Trade-Genius
# Ouvre simplement index.html dans ton navigateur
# Ou avec un mini-serveur local :
python3 -m http.server 8000
# Puis http://localhost:8000
```

Pour une vraie preview mobile, utilise les DevTools Chrome (F12 → mode device) avec un iPhone 14 Pro ou Pixel 7.

---

## 📁 Structure

```
Trade-Genius/
├── index.html       # App complète (single-file, ~76 Ko)
├── handoff.md       # Continuité de session (état détaillé, décisions, todos)
├── README.md        # Ce fichier
└── LICENSE          # MIT
```

---

## ⚠️ Disclaimer légal

Trade Genius est une **application pédagogique**. Aucun contenu de cette app ne constitue un conseil en investissement au sens de l'article L.541-1 du Code monétaire et financier.

Le trading et l'investissement comportent un **risque de perte en capital pouvant aller jusqu'à la totalité du montant investi**. Avant toute décision d'investissement réelle, consultez un conseiller en investissements financiers (CIF) agréé par l'ORIAS.

Les chiffres cités (89 % de pertes retail, etc.) proviennent de sources publiques (AMF, ESMA, études académiques) et sont sourcés dans le contenu.

---

## 🏢 À propos

Trade Genius fait partie de la gamme **Genius** de **Deponchy Studio**, aux côtés de [BJ Genius](https://github.com/virtualvaultboy-pixel) (app blackjack).

Marque ombrelle : *les apps Genius de Deponchy.*

---

## 📜 Licence

MIT — voir [LICENSE](LICENSE).

Tu peux utiliser, modifier, redistribuer le code. Si tu en fais quelque chose de cool, un crédit `Deponchy Studio` fait toujours plaisir 😉
