# Trade Genius Live — Sources Android natives

Ce dossier contient les fichiers Kotlin et Java de la bulle flottante
**Trade Genius Live** (v1.0+), forkée du pattern éprouvé BJ Genius v1.3.

Le workflow `.github/workflows/android-build.yml` copie automatiquement les
fichiers `.kt` et `.java` vers le bon emplacement du projet Android au moment
du build :

```
android-native/*.kt   → android/app/src/main/java/studio/deponchy/tradegenius/
android-native/*.java → android/app/src/main/java/studio/deponchy/tradegenius/
```

## Fichiers

| Fichier | Rôle |
|---|---|
| `TGBubbleService.kt` | Foreground service Android qui maintient la bulle visible |
| `BubbleOverlayView.kt` | Vue Kotlin de la bulle draggable (cercle vert "TG") |
| `TGBubblePlugin.java` | Plugin Capacitor exposant start/stop/setDecision au JS |

## Package

`studio.deponchy.tradegenius` — doit être identique au `applicationId` de
`android/app/build.gradle` et au `appId` de `capacitor.config.json`.

## API JS exposée

Côté JS, le plugin est accessible via `window.Capacitor.Plugins.TGBubble`,
mais `tg-bubble.js` expose une API unifiée plus pratique :

```js
window.TGBubble.isNative           // true en APK Android, false en PWA
window.TGBubble.showBubble()        // démarre le service + bulle
window.TGBubble.hideBubble()        // arrête et retire la bulle
window.TGBubble.hasOverlayPermission()
window.TGBubble.requestOverlayPermission()
window.TGBubble.onScanResult(cb)    // listener sur tap scan (ou OCR à venir)
```

## Events émis vers JS

```js
TGBubble.addListener('bubbleEvent', ({type}) => {
  if (type === 'scan_tap')   { /* user a tapé sur le bouton 📷 */ }
  if (type === 'bubble_tap') { /* user a tapé sur la bulle TG */ }
  if (type === 'close_tap')  { /* user a fermé la bulle */ }
});
```

## Modification

Tout changement de ces fichiers déclenche un rebuild du workflow.
Ces fichiers ne sont PAS modifiés en local par Capacitor sync — ils sont
toujours réécrits depuis ce dossier source au build.

## Tests

Pour Aurélien (sans PC Android SDK) : push sur `main` → onglet Actions
→ download APK depuis l'artifact ou la release auto.
