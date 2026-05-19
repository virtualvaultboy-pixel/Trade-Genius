# 📱 Trade Genius — Guide PlayStore (TWA / Trusted Web Activity)

Transformer la PWA en APK Android uploadable sur Google Play.

---

## 🎯 Pré-requis

- [x] PWA conforme TWA (manifest, sw, HTTPS, icons) — **✅ déjà fait**
- [x] Manifest enrichi (id, shortcuts, screenshots) — **✅ déjà fait**
- [ ] Compte Google Play Console (25 €, paiement unique)
- [ ] Java JDK 8+ installé
- [ ] Node.js 14+ installé (pour Bubblewrap)
- [ ] Android SDK (Bubblewrap l'installe auto si absent)

---

## 🚀 Option A — Bubblewrap (CLI, recommandé)

Bubblewrap = outil officiel Google pour TWA → APK.

### 1. Install

```powershell
npm install -g @bubblewrap/cli
```

### 2. Init projet

Dans un dossier vide à l'extérieur du repo (pas dans `Trade-Genius/files/`):

```powershell
mkdir tg-android
cd tg-android
bubblewrap init --manifest=https://virtualvaultboy-pixel.github.io/Trade-Genius/manifest.json
```

Bubblewrap pose ~15 questions :
- **Package name** : `studio.deponchy.tradegenius` (déjà identifié dans le code)
- **App version** : 1 (sera 2, 3, ... à chaque update Play Store)
- **Display mode** : `standalone`
- **Orientation** : `portrait`
- **Theme color** : `#0a0a0c`
- **Background color** : `#0a0a0c`
- **Icon URL** : laisse par défaut (lit le manifest)
- **Splash color** : `#0a0a0c`
- **Status bar color** : `#0a0a0c`
- **Domain** : `virtualvaultboy-pixel.github.io`
- **URL path** : `/Trade-Genius/`
- **Notifications** : `No` (pour l'instant)
- **Sign in with Google** : `No`
- **Signing key** : `Generate a new one` (1ère fois) → renseigne password fort

### 3. Récupérer le SHA-256 fingerprint

```powershell
bubblewrap fingerprint
```

Tu obtiens :
```
SHA256: AB:CD:EF:12:34:56:...:99
```

**Copie cette valeur.**

### 4. Mettre à jour assetlinks.json côté web

⚠️ **IMPORTANT** : Google exige que `assetlinks.json` soit à la **racine du domaine**, pas dans un sous-path.

Pour GitHub Pages, ça veut dire :
- ❌ Pas ici : `https://virtualvaultboy-pixel.github.io/Trade-Genius/.well-known/assetlinks.json`
- ✅ Mais ici : `https://virtualvaultboy-pixel.github.io/.well-known/assetlinks.json`

**Solution** : créer un nouveau repo GitHub `virtualvaultboy-pixel.github.io` (user site racine) :

```powershell
mkdir tg-user-site
cd tg-user-site
git init
mkdir -p .well-known
# Copie le assetlinks.json depuis Trade-Genius/files/.well-known/
cp "C:\Users\qfichet\Desktop\Document IA\Trade Genius\files\.well-known\assetlinks.json" .well-known/

# Édite .well-known/assetlinks.json pour mettre le bon SHA-256:
# "sha256_cert_fingerprints": ["AB:CD:EF:12:34:56:...:99"]

# Crée index.html minimal qui redirige vers le repo Trade-Genius:
@'
<!DOCTYPE html>
<html><head><meta http-equiv="refresh" content="0;url=/Trade-Genius/"></head>
<body><a href="/Trade-Genius/">→ Trade Genius</a></body></html>
'@ | Out-File index.html -Encoding utf8

git add .
git commit -m "Initial: assetlinks for Trade Genius TWA"
& "C:\Program Files\GitHub CLI\gh.exe" repo create virtualvaultboy-pixel.github.io --public --source=. --push
```

Vérifie que `https://virtualvaultboy-pixel.github.io/.well-known/assetlinks.json` s'affiche bien (peut prendre 1-2 min après push + activation Pages dans Settings).

Le fichier `files/.well-known/assetlinks.json` de ce repo Trade-Genius peut être supprimé (il ne sert plus à TWA) — gardé seulement comme reference.

### 5. Build l'APK

```powershell
cd tg-android
bubblewrap build
```

Tu obtiens :
- `app-release-signed.apk` (à installer en debug)
- `app-release-bundle.aab` (à upload sur Play Console)

### 6. Test local

Avec ton Samsung en USB debug :

```powershell
bubblewrap install
```

L'app s'installe. Lance-la, vérifie :
- ✅ Splash s'affiche
- ✅ Pas de barre d'adresse browser (sinon assetlinks pas validé)
- ✅ Notifications système (si activées) marchent

### 7. Upload Play Console

1. Va sur [play.google.com/console](https://play.google.com/console)
2. Crée une nouvelle app "Trade Genius"
3. Section "App releases" → "Production" → "Create release"
4. Upload `app-release-bundle.aab`
5. Remplis la fiche :
   - **Description courte** (80 chars) : « Apprends la bourse de zéro. 4 modules + simulateur. »
   - **Description longue** (4000 chars) : voir [APP_LISTING.md](APP_LISTING.md) ci-dessous
   - **Screenshots** : `screenshot-1.png` à `screenshot-4.png` (à générer depuis ton Samsung)
   - **Icône** : `icon-512.png`
   - **Feature graphic** : 1024×500 (à créer)
   - **Catégorie** : Finance
   - **Public cible** : 13+ (pas de violence, pas de pub)
6. Submit pour review (~3-7 jours)

---

## 🚀 Option B — PWABuilder.com (web, plus simple)

Si tu veux éviter le CLI :

1. Va sur [pwabuilder.com](https://www.pwabuilder.com/)
2. Entre : `https://virtualvaultboy-pixel.github.io/Trade-Genius/`
3. PWABuilder analyse, donne un score (devrait être ≥ 80)
4. Clique **"Package for Stores"** → **"Android"**
5. Configure :
   - **Package ID** : `studio.deponchy.tradegenius`
   - **Version** : 1
   - **Signing key** : "Create new" (sauvegarde-la précieusement !)
6. **Download** le ZIP qui contient :
   - `app-release-bundle.aab`
   - `assetlinks.json` (déjà avec le bon SHA-256)
   - `signing.keystore`
7. Copie le contenu de leur `assetlinks.json` dans `files/.well-known/assetlinks.json`
8. Push, puis upload le `.aab` sur Play Console

⚠️ **Garde le `signing.keystore`** : si tu le perds, tu ne pourras plus update l'app !

---

## 🔑 Sécurité de la signing key

La signing key est **critique** :
- Sans elle = impossible de publier une nouvelle version
- Stocke `signing.keystore` dans un **password manager** (1Password, Bitwarden)
- Note le **mot de passe** du keystore
- Backup chez un proche de confiance

Alternativement : Google Play App Signing prend le relais après le 1er upload.

---

## 📊 Optimisations bonus

### Screenshots — méthode rapide

Sur ton Samsung :
1. Ouvre l'app web https://virtualvaultboy-pixel.github.io/Trade-Genius/
2. Navigue vers :
   - Hub accueil → screenshot
   - Hub modules → screenshot
   - Simu en action (acheté + chart) → screenshot
   - Biblio (vue catégories) → screenshot
3. `screenshot-1.png` à `screenshot-4.png` → place dans `files/`
4. `./bump.sh + git push`

Idéalement les screenshots font **1080×1920** (portrait 9:16).

### Feature graphic (1024×500)

Image hero pour la fiche Play Store. Peux la faire dans Figma :
- Fond noir #0a0a0c
- Logo T-chandelier acid à gauche
- Texte "TRADE GENIUS · Apprends la bourse de zéro" à droite
- Petits chandeliers décoratifs

### Localized listings

Pour toucher plus de monde, traduis la fiche en EN/ES/DE.

---

## ❓ Troubleshooting

**"App s'ouvre dans le browser avec barre d'adresse"**
→ `assetlinks.json` pas validé. Vérifier :
- URL `https://virtualvaultboy-pixel.github.io/.well-known/assetlinks.json` accessible
- SHA-256 dedans match celui de `bubblewrap fingerprint`
- Wait 1h après push (Google cache)

**"PWABuilder dit score faible"**
→ Vérifier que :
- HTTPS ✅
- Service worker ✅
- Manifest complet ✅
- Icons 192 et 512 ✅
- Pas de mixed content (http:// dans https://)

**"Pas de notifications push"**
→ Pour activer plus tard : Firebase Cloud Messaging + Web Push API.

---

## 📅 Workflow update

Pour pusher une nouvelle version de l'app sur Play Store :

1. Modif le code (ex: fix bug, nouvelle feature)
2. `./bump.sh 1.X` + `git push`
3. Vérifier en prod (https://virtualvaultboy-pixel.github.io/Trade-Genius/)
4. `cd tg-android && bubblewrap update` (re-fetch manifest)
5. Incrémenter `versionCode` dans `twa-manifest.json` (1 → 2 → 3...)
6. `bubblewrap build`
7. Upload nouveau `.aab` sur Play Console

Les utilisateurs reçoivent l'update auto via Play Store.

---

**Fin du guide. Prêt pour le Play Store 🚀**
