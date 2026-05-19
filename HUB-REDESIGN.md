# 🎨 Hub accueil — Refonte

## Diagnostic actuel
- Section "Hello dynamique" : ok
- Hero du jour (citation) : ok
- Resume block (next step) : ok mais peu visible
- Stats row : pas hiérarchisée
- Tools grid 3 colonnes : statique
- Buttons rappels/partage : OK
- Trop d'éléments en stack → manque de respiration

## Nouvelle architecture

```
[Header sticky]
  Avatar 👤 + Greeting + Streak 🔥 X jours
                                            ⚙️
[HERO CARD — Continuer (1 grand bloc)]
  Module 1 — Le marché
  ▓▓▓▓▓░░ 5/7 chapitres
  [REPRENDRE →]

[Quick stats — 3 mini cards]
  📚 5 fiches | 🎮 3 sessions | 🎯 78% winrate

[Hero du jour]
  💡 Citation
  "..."

[Défi du jour (compact)]
  🎯 1 question (état déjà fait/non fait)

[Section Outils]
  📚 Apprendre · 🎮 Entraîner · 📖 Biblio · 📊 Analyse

[Section Premium] (si pas premium)
  ✨ Débloque tout

[Footer]
  Brand · Glossaire · Privacy
```

## Changements visuels

### Header (NEW)
- Avatar coloré (emoji aléatoire ou first letter du jour : 🌅, 🌙, 🎯)
- Streak en pleine visibilité (taille +50%)
- Bouton settings discret (ouvre paramètres)

### Hero "Continuer" (NEW)
- Grande card (full width, hauteur 120px)
- Couleur du module en background gradient
- CTA gros bouton "REPRENDRE"
- Si tout fini : "✓ Parcours complet — Essaie le simu"

### Stats compactes (REFONTE)
- 3 mini-cards avec icône + chiffre + label
- Sparkline mini (évolution 7 jours)
- Tap → ouvre détail

### Section Outils (REFONTE)
- 4 cards (vs 3) : Apprendre / Entraîner / Bibliothèque / Analyse
- Plus petites mais avec gradient et icon plus grosse
- 2x2 grid au lieu de 1x3

### Hero du jour (compact)
- Moins gros qu'actuellement
- Citation en italique courte
- Source en petit

### Card Premium (NEW si pas premium)
- Gradient acid → blue
- "✨ Premium — Débloque Module 2+3+4 + simu illimitée"
- Bouton "En savoir plus"
- Masquée si user premium

## Tokens design utilisés

```css
--card-radius: 16px (vs 14px actuel)
--gap-major: 16px
--gap-minor: 10px
--hero-min-height: 120px
--header-height: 64px sticky
```

## Animations

- Hero card slide-in au load
- Stats count-up animation
- Cards outils hover-lift (scale 1.02)
- Premium card pulse acid subtle

## Roadmap implémentation

1. Refonte header (avatar + streak grand)
2. Hero Card "Continuer"
3. Refonte stats compactes
4. Section outils 2x2
5. Card Premium (verrou freemium)
6. Animations finales

Estimation : 3-4 commits, ~1h.
