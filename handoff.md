# Trade Genius — Handoff

> **Studio :** Deponchy Studio
> **Co-dev :** Aurélien + Quent1 (à confirmer pour ce projet)
> **Version actuelle :** v0.1
> **Bundle ID prévu :** `studio.deponchy.tradegenius`
> **Repo cible :** À créer (proposition : `deponchy/trade-genius`)

---

## Pitch

Trade Genius est une app pédagogique mobile-first qui apprend à trader **honnêtement**. Aucune promesse de richesse, focus sur la compréhension réelle des marchés et la mise en évidence des risques (notamment via la statistique "80% des traders perdent"). Positionnement différenciant face aux "formateurs" Instagram à 1500 €.

Marque ombrelle : ligne **Genius** de Deponchy Studio (BJ Genius, Trade Genius, futurs Genius).

---

## Stack & conventions

- **Single-file `index.html`** (comme BJ Genius)
- **Vanilla JS, HTML, CSS** — pas de framework pour le MVP
- **Mobile-first**, wrap Capacitor prévu en phase build
- **localStorage** pour la progression (`tradegenius_v1`)
- **Semver +0.1 par modification**, badge visible (`#version-badge`)
- **handoff.md** à régénérer à chaque "handoff/transfert/switch"
- **API Claude** : `claude-sonnet-4-20250514` pour le tuteur IA (phase v0.3)
- **Données marché** (phase v0.4) : Binance public API pour crypto

### Design system

- **Aesthetic** : éditorial premium / sombre raffiné
- **Couleurs** : fond `#0a0a0f`, surfaces `#13131c`, accent or `#d4af37`
- **Typo** : Fraunces (display serif) + Manrope (body) + JetBrains Mono (data)
- **Différenciation visuelle** : leçon "80% perdent" en accent warning (amber)

---

## État au 13 mai 2026 (v0.1)

### ✓ Livré

- **Architecture app** : header sticky, 5 vues, bottom nav, navigation JS
- **Vue Accueil** : carte progression, stats (streak, quiz), "vérité du jour", carte promesse
- **Vue Cours** : 5 modules listés, M01 actif, M02-M05 lockés
- **Vue Module** : détail des 8 leçons du M01 avec progression
- **Vue Leçon** : rendu HTML complet, marquage "terminée", auto-passage à la leçon suivante
- **Vue Glossaire** : 53 termes, recherche live, regroupement alphabétique
- **Vue Tuteur** : placeholder + roadmap
- **Vue Profil** : stats, reset progression, disclaimer légal
- **Module 1 entièrement rédigé** : 8 leçons (~400 mots chacune) :
  1. Qu'est-ce qu'un marché financier ?
  2. Les classes d'actifs
  3. Comment fonctionne un ordre
  4. Lire un graphique
  5. Le carnet d'ordres et la liquidité
  6. **Pourquoi 80% des traders perdent** (leçon signature, traitement visuel spécial)
  7. Les frais cachés
  8. Quiz récap (questions affichées, correction manuelle pour v0.1)

### En attente

- **Modules 2 à 5** : structure créée, contenu à rédiger
- **Quiz interactifs** : prévu v0.2 (correction auto + score persistant)
- **Tuteur IA** : prévu v0.3 (intégration API Claude)
- **Simulateur historique** : prévu v0.4 (Binance kline data, moteur de simulation, debrief IA)
- **Mode événement** : prévu v0.5 (scénarios historiques : COVID, FTX, etc.)
- **Build Capacitor** : bloqué tant qu'Aurélien n'a pas de PC non-Samsung disponible (cf. BJ Genius Phase 2)

---

## Roadmap

| Version | Contenu | Échéance |
|---------|---------|----------|
| v0.1 ✓  | MVP : cours M01 + glossaire | Mai 2026 |
| v0.2    | Quiz interactifs + score + M02 rédigé | Juin 2026 (cible) |
| v0.3    | Tuteur IA (Claude API) + M03 | Été 2026 |
| v0.4    | Simulateur historique crypto | T3 2026 |
| v0.5    | Mode événement + M04, M05 | T4 2026 |
| v1.0    | Release Google Play + IAP | T4 2026 |

---

## Monétisation (à valider)

Modèle freemium aligné avec BJ Genius :
- **Gratuit** : Module 1 complet + glossaire + 3 questions/jour au tuteur
- **Premium** (4,99 €/mois ou 39,99 €/an) : modules 2-5, tuteur illimité, simulateur
- **Lifetime** (one-shot 49,99 € ?) : à étudier

---

## Décisions ouvertes

- [ ] Validation finale du nom **Trade Genius** (vs. Market Genius / autre)
- [ ] Présence de Quent1 sur ce projet (co-dev ou Aurélien solo) ?
- [ ] Modèle freemium vs. one-shot comme BJ Genius
- [ ] Périmètre simulateur v0.4 : crypto uniquement OU crypto + actions (APIs $)
- [ ] Statut juridique : faire valider le disclaimer par un juriste avant release Play

---

## Points de vigilance légaux

- **Pas de conseil en investissement** : Trade Genius est pédagogique, point. Jamais de "achète X". L'app dit clairement "ceci n'est pas du conseil financier".
- **Démarchage AMF** : en France, le statut de CIF est requis pour donner du conseil. On reste éducationnel pur.
- **Pas de témoignages "j'ai fait +X%"** : signe immédiat d'arnaque, pollue la crédibilité.
- **Disclaimer permanent** : présent sur vue Profil. À répliquer sur écran d'inscription si on en ajoute un.

---

## Notes techniques

### Localisation de la version badge

```html
<span class="version-badge" id="version-badge">v0.1</span>
```
→ ligne ~1008 dans `index.html`. À incrémenter de +0.1 à chaque modif (v0.1 → v0.2 → v0.3…).

### Structure des données cours

Les modules et leçons sont actuellement embarqués dans le JS (`const MODULES = [...]`). Si le volume de contenu devient ingérable (estimation : à partir du M03), on pourra externaliser en `content/courses.json` chargé via fetch.

### Storage

Clé `tradegenius_v1` en localStorage :
```js
{
  completedLessons: [],     // IDs des leçons terminées
  currentModule: 'm01',     // module actif
  currentLesson: null,      // leçon en cours
  lastVisit: 'date string', // pour streak
  streak: 0,
  quizzes: 0
}
```

---

## Pour la prochaine session

**Prochaines tâches prioritaires :**
1. Tester le rendu sur mobile réel (responsive, safe areas iOS)
2. Rédiger le **Module 2 — Analyse technique** (~8 leçons)
3. Implémenter les **quiz interactifs** (composant + persistance scores)
4. Bumper en **v0.2**

**Commande de régénération attendue :**
> "handoff" / "transfert" / "switch" → régénérer `index.html` + `handoff.md` complets
