# Trade Genius — Setup Capacitor + Bulle native Android

> **Version cible :** v2.75 · **Stack :** Capacitor 6 + Kotlin + ML Kit Vision

## 🎯 Objectif

Transformer la PWA Trade Genius en **app Android Play Store** avec une **bulle flottante persistante** (style BJ Genius) qui scanne le graph affiché sur n'importe quelle app broker et donne une reco via l'agent IA actif.

## 📋 Pré-requis (à installer en local)

- Node.js 20+
- Android Studio (Hedgehog ou plus récent)
- JDK 17+
- Variable d'env `ANDROID_HOME` configurée

## 🚀 Setup initial (1 fois)

```bash
cd "C:\Users\qfichet\Desktop\Document IA\Trade Genius\files"

# 1. Installer Capacitor
npm install

# 2. Initialiser le projet Android
npx cap add android

# 3. Synchroniser le code web
npx cap sync android
```

Un dossier `android/` est créé. Il contient ton projet Android Studio.

## 🔧 Intégration du plugin BubbleOverlay

Tous les fichiers Kotlin sont dans `mobile/`. Voici comment les intégrer :

### 1. Copier les 4 fichiers Kotlin

```bash
# Destination
TARGET="android/app/src/main/java/studio/deponchy/tradegenius"
mkdir -p "$TARGET"

# Source : mobile/
cp mobile/BubbleOverlayPlugin.kt   "$TARGET/"
cp mobile/BubbleService.kt          "$TARGET/"
cp mobile/ScreenScanManager.kt      "$TARGET/"
cp mobile/MainActivity.kt           "$TARGET/"  # REMPLACE l'existant
```

### 2. Copier le drawable

```bash
cp mobile/bubble_bg.xml  android/app/src/main/res/drawable/
```

### 3. Ajouter les permissions dans `AndroidManifest.xml`

Ouvre `android/app/src/main/AndroidManifest.xml` et fusionne le contenu de `mobile/AndroidManifest-snippet.xml` :

- 4 `<uses-permission>` à ajouter à la racine du `<manifest>`
- 1 `<service>` à ajouter dans `<application>`
- Ajouter `android:launchMode="singleTask"` sur l'activity principale

### 4. Ajouter la dépendance ML Kit dans `app/build.gradle`

```gradle
dependencies {
    // ... (existant)
    implementation 'com.google.mlkit:text-recognition:16.0.1'
    implementation 'androidx.core:core-ktx:1.13.1'
}
```

### 5. Inclure `tg-bubble.js` dans le HTML

Dans `index.html` (à la fin, juste avant `</body>`) :

```html
<script src="tg-bubble.js?v=275"></script>
```

(`bump.sh` est déjà configuré pour synchroniser ce numéro.)

## 🔨 Compilation

```bash
# Sync le code web vers le projet Android
npx cap sync android

# Ouvrir Android Studio (interactif)
npx cap open android

# OU build direct en CLI
cd android
./gradlew assembleDebug
# APK généré : android/app/build/outputs/apk/debug/app-debug.apk
```

## 📱 Test sur Samsung réel

1. Active **Mode développeur** + **USB debugging** sur le téléphone
2. Branche en USB
3. `npx cap run android` → installe et lance
4. À la 1re ouverture : autorise SYSTEM_ALERT_WINDOW dans les paramètres
5. Au 1er scan : autorise MediaProjection (popup système)
6. La bulle 🤖 apparaît, déplaçable, tap pour scanner

## 🧠 Comment ça marche

```
┌─────────────────────────────────────────────────────────────┐
│ USER ouvre Binance / TradingView / eToro                    │
│   ↓ tap sur la bulle 🤖                                      │
│ BubbleService capte le tap → TradeGeniusBridge.onBubbleTap()│
│   ↓                                                          │
│ BubbleOverlayPlugin.onBubbleTapped()                        │
│   ↓                                                          │
│ ScreenScanManager.requestScan()                              │
│   - 1re fois : popup MediaProjection (user accepte)         │
│   - ensuite : capture directe                                │
│   ↓                                                          │
│ Bitmap capturé → ML Kit OCR                                  │
│   ↓                                                          │
│ Extraction Ticker + Prix par regex                           │
│   ↓                                                          │
│ notifyListeners('bubbleScanResult', { ticker, price, text })│
│   ↓                                                          │
│ tg-bubble.js handleScanResult(data)                         │
│   - map ticker → asset id (catalog tg-analyst.js)           │
│   - appelle tgaAnalyze(assetId)                              │
│   ↓                                                          │
│ FAB Analyste 🤖 ouvre l'app sur le popup d'analyse          │
│ L'agent actif (ATLAS/ZEN/NOVA/KAIRO) donne sa reco          │
└─────────────────────────────────────────────────────────────┘
```

## ⚠️ Limites actuelles & améliorations futures

**Limite 1 — OCR du ticker uniquement**
On reconnaît le NOM de l'actif ("BNB/USDT", "BTC", "AAPL"), pas les bougies. C'est suffisant pour identifier l'actif et lancer notre propre analyse (qui utilise nos data Yahoo/CoinGecko, pas celles du screenshot). Avantage : on contrôle la qualité.

**Limite 2 — Mapping ticker manuel**
Le mapping est dans `tg-bubble.js` (BTC → bitcoin, EURUSD → EURUSD=X, etc.). À étendre avec les variants d'écriture des brokers.

**Limite 3 — Si l'actif n'est pas dans nos 52**
On ne sait pas faire — affichage d'un message "Actif non couvert" futur.

**Amélioration v3 (gros chantier) — Extraction des bougies depuis l'image**
Avec un modèle TensorFlow Lite custom (~2 semaines de dev + dataset à entraîner), on pourrait extraire la série OHLC directement du graph. Pour l'instant, on s'en passe car on a nos data live.

## 🏪 Publication Play Store

1. Sign l'APK release : `./gradlew bundleRelease`
2. Upload `.aab` sur Play Console
3. Justification SYSTEM_ALERT_WINDOW dans la fiche app (obligatoire) :
   > "La bulle flottante permet à l'utilisateur de scanner les graphs de marché affichés sur d'autres apps de trading (Binance, eToro, TradingView) pour obtenir une analyse technique pédagogique du Trade Genius. C'est un outil éducatif, sans exécution d'ordre."
4. Politique de confidentialité : déjà sur https://virtualvaultboy-pixel.github.io/Trade-Genius/privacy.html

## 🆘 Troubleshooting

| Problème | Solution |
|---|---|
| Build error "package studio.deponchy.tradegenius not found" | Vérifier que `appId` dans `capacitor.config.json` correspond au package des fichiers Kotlin |
| Bulle ne s'affiche pas | Vérifier permission Settings.canDrawOverlays(this) — appeler `requestOverlayPermission()` au démarrage |
| MediaProjection refusée | Re-demander au prochain tap, l'user peut ré-accepter |
| OCR ne reconnaît pas le ticker | Élargir le regex `[A-Z]{2,6}` dans `ScreenScanManager.kt` |
| Service tué après quelques minutes | Vérifier que `foregroundServiceType="mediaProjection"` est bien dans le manifest |

## 📝 Roadmap mobile

- **v2.75** ✅ Setup Capacitor + plugin BubbleOverlay (ce document)
- **v2.76** — Ajouter onboarding mobile (permissions step-by-step)
- **v2.77** — Cache OCR résultats (éviter re-scan immédiat même actif)
- **v2.78** — Notification push native (au lieu de Web Notif) pour les patterns
- **v3.0** — Modèle ML Vision custom pour extraction bougies (gros chantier)
