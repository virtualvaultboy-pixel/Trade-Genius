# Trade Genius — Codes d'affiliation broker

> Guide rapide pour activer la monétisation v2.40. Une fois rempli,
> les boutons "Passer à l'action" dans l'app utilisent automatiquement
> tes codes pour tracker tes commissions.

## ⏱ Temps total : 15-30 minutes

| # | Broker | Temps | Statut |
|---|--------|-------|--------|
| 1 | Binance | 5 min | ✅ `CPA_00OPLGOBMC` |
| 2 | Bitpanda | 5 min | ⬜ |
| 3 | Trade Republic | 3 min | ✅ `r37Oswtt` |
| 4 | eToro | 10 min (modération 24-48h) | ⬜ |

---

## 1️⃣ Binance — crypto, le plus rentable

**Prérequis** : compte Binance vérifié (KYC + 2FA).

**Étapes** :
1. Ouvre https://www.binance.com et connecte-toi
2. Va sur https://www.binance.com/fr/activity/referral
3. Crée ton **ID de référence** (3-9 caractères, ex: `TGenius`)
4. Note ton **Referral ID** (ex: `KPS12ABX` ou ton custom code)

**Récupère** : ton **Referral ID** (apparaît dans l'URL `binance.com/register?ref=XXXX`)

**Colle dans `index.html`** (recherche `BROKER_LINKS.binance.refCode`) :
```js
refCode: 'XXXX',   // ← Ton code Binance
```

---

## 2️⃣ Bitpanda — crypto + actions FR (intéressant pour le marché FR)

**Étapes** :
1. https://www.bitpanda.com/fr/affiliate-program
2. Clique "Devenir partenaire" → formulaire (2 min)
3. Validation immédiate la plupart du temps
4. Dans ton dashboard partenaire : copie ton **username** ou ton **lien d'affiliation**

**Récupère** : ton **username Bitpanda** (le bout de l'URL `bitpanda.com/r/XXXX`)

**Colle** :
```js
refCode: 'tonusername',   // ← Bitpanda
```

---

## 3️⃣ Trade Republic — actions + ETF FR

**Note** : ce n'est pas un programme affilié classique mais un parrainage. Quand un nouvel utilisateur s'inscrit via ton lien et fait un dépôt + un trade, vous recevez **chacun une action gratuite** (jusqu'à 200€). Pas du cash récurrent mais c'est un acquis sympa.

**Étapes** :
1. Ouvre l'app Trade Republic (mobile)
2. Profil > "Inviter un ami"
3. Copie ton **lien de parrainage** (format : `https://ref.trade.re/XXXXXXX`)

**Récupère** : la partie après `/` (ex: `abc123de`)

**Colle** :
```js
refCode: 'abc123de',   // ← Trade Republic
```

---

## 4️⃣ eToro — copy-trading + CFD

**Le plus exigeant** : modération sous 24-48h.

**Étapes** :
1. https://partners.etoro.com
2. Inscription affilié (formulaire avec siret/auto-entrepreneur ou perso, modération manuelle)
3. Une fois validé, tu reçois un **Affiliate ID** (numérique, ex: `B12345_67890`)

**Récupère** : ton **Affiliate ID** (paramètre `A` dans l'URL `med.etoro.com/aw.aspx?A=XXXX`)

**Colle** :
```js
refCode: 'B12345_67890',   // ← eToro
```

---

## Comment éditer rapidement les codes

Dans `index.html`, cherche le bloc `const BROKER_LINKS = {` (vers la ligne ~6500).
Remplace les `refCode: ''` par tes codes :

```js
const BROKER_LINKS = {
  binance: {
    ...
    refCode: 'TONCODE',   // ← ICI
    ...
  },
  bitpanda: {
    ...
    refCode: 'TONCODE',   // ← ICI
    ...
  },
  // etc.
};
```

Puis :
```bash
git add index.html BROKER_CODES.md
git commit -m "chore: add my affiliate broker codes"
git push
```

L'app utilise automatiquement tes codes à partir du prochain commit.

---

## Suivi des revenus

Chaque broker a son dashboard analytics :
- **Binance** : https://www.binance.com/fr/activity/referral/overview
- **Bitpanda** : dashboard partenaire (envoyé par email)
- **Trade Republic** : dans l'app, section parrainage
- **eToro** : https://partners.etoro.com (login affilié)

Surveille au moins 1× / mois pour ajuster ta stratégie.

---

## Pour info — ce que tu déclares fiscalement (France)

- Si auto-entrepreneur : ces revenus = **BNC** (Bénéfices Non Commerciaux) si tu fais aussi du contenu / formation. À déclarer sur ton compte Urssaf.
- Si particulier : ces commissions deviennent imposables au-delà d'un certain seuil. **Demande à un comptable** si tu prévois >1000€/an.

Pas d'angoisse au début — les premiers revenus prennent du temps.

---

## En attendant que tu remplisses

Sans codes, les boutons dans l'app **renvoient quand même vers les brokers** (lien direct sans referral). Donc l'app fonctionne, juste tu ne touches pas de commission tant que les `refCode` sont vides.
