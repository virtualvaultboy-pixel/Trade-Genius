# 🔔 Notifications — Architecture & Roadmap

## ✅ État actuel (v1.76)

**Système implémenté : Web Notification API + auto-check au load**

```
User ouvre l'app → tg-common.js autoInit() → checkStreakDangerNotify()
                                            ↓
              Si streak ≥ 2 ET visité hier ET pas aujourd'hui ET permission OK
                                            ↓
                               🔔 Notification système Android
```

**Avantages** :
- Aucun backend requis (GitHub Pages compatible)
- Permission demandée volontairement (bouton hub accueil)
- Throttle : max 1 notif/jour par utilisateur
- Funcs exportées : `getNotifState`, `requestNotifPermission`, `disableNotifs`

**Limite** :
- Notifications déclenchées **uniquement quand l'app s'ouvre**
- L'utilisateur doit avoir l'habitude d'ouvrir l'app (streak crée l'habitude)
- Pas de notif "réveil" type WhatsApp

---

## 🚀 Niveau 2 : Periodic Background Sync (Chrome only)

API **expérimentale Chrome/Edge** : le Service Worker se réveille périodiquement même app fermée.

**Prérequis** :
- PWA installée par l'user
- L'user a utilisé l'app plusieurs fois (Chrome heuristics)
- Permission `periodic-background-sync` (rare et difficile à obtenir)

**Code à ajouter dans sw.js** :
```js
self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'streak-check') {
    e.waitUntil(self.registration.showNotification('🔥 Trade Genius', {
      body: 'Reviens 5 min pour entretenir ton streak.',
      icon: 'icon-512.png',
      badge: 'icon-192.png',
      tag: 'daily-streak',
    }));
  }
});
```

**Code client** :
```js
const reg = await navigator.serviceWorker.ready;
await reg.periodicSync.register('streak-check', {
  minInterval: 24 * 60 * 60 * 1000, // 24h
});
```

**Limite** : ne marche que sur Chrome desktop/Android. iOS PWA = pas supporté.

---

## 🌐 Niveau 3 : Firebase Cloud Messaging (true push)

Pour notifications **vraiment background** (app fermée + iOS + Android), il faut un backend ou Firebase.

### Setup Firebase (gratuit jusqu'à 100k notifications/mois)

1. https://console.firebase.google.com → "Add project" → "Trade Genius"
2. Add Web App → copie la config :
   ```js
   const firebaseConfig = {
     apiKey: "...", authDomain: "...", projectId: "...",
     storageBucket: "...", messagingSenderId: "...", appId: "...",
   };
   ```
3. Active **Cloud Messaging** dans la console
4. Generate **VAPID key pair** (Web Push certificates)

### Côté client (tg-common.js)

```js
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js';
import { getMessaging, getToken, onMessage } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging.js';

const app = initializeApp(firebaseConfig);
const messaging = getMessaging(app);

export async function setupFCM() {
  const token = await getToken(messaging, { vapidKey: 'YOUR_VAPID_KEY' });
  // Envoyer le token à ton backend pour cibler cet utilisateur
  await fetch('https://your-backend/register-token', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
  onMessage(messaging, (payload) => {
    new Notification(payload.notification.title, {
      body: payload.notification.body,
      icon: 'icon-512.png',
    });
  });
}
```

### Service Worker dédié (firebase-messaging-sw.js)

Fichier à la racine. Important : DIFFÉRENT de sw.js actuel.

```js
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  self.registration.showNotification(payload.notification.title, {
    body: payload.notification.body,
    icon: 'icon-512.png',
    badge: 'icon-192.png',
  });
});
```

### Backend pour trigger les notifs

Tu as besoin d'un endpoint qui :
1. Stocke les FCM tokens des users
2. Cron 1x/jour vérifie qui n'a pas visité depuis 20h
3. Envoie une notif via Firebase Admin SDK

Options de backend gratuit :
- **Firebase Functions** (en plus du FCM)
- **Vercel / Netlify Functions** (serverless)
- **Cloudflare Workers** (10M req/mois free)
- **Supabase Edge Functions** (gratuit avec cron)

Exemple Vercel function (`api/send-streak-reminder.js`) :
```js
import admin from 'firebase-admin';
admin.initializeApp({ credential: admin.credential.cert(...) });

export default async function handler(req, res) {
  // Récupère tous les tokens des users avec streak en danger
  const tokens = await getUsersWithStreakDanger();
  await admin.messaging().sendEachForMulticast({
    notification: { title: '🔥 Ton streak', body: '...' },
    tokens,
  });
  res.status(200).json({ ok: true });
}
```

Cron via Vercel : ajouter dans `vercel.json` :
```json
{ "crons": [{ "path": "/api/send-streak-reminder", "schedule": "0 19 * * *" }] }
```

---

## 📊 Comparatif

| Solution | Background | iOS | Coût | Effort |
|---|---|---|---|---|
| Web Notification API au load (actuel) | ❌ | ✅ | Gratuit | ✅ Fait |
| Periodic Sync (Chrome) | ⚠️ Chrome only | ❌ | Gratuit | 1h |
| Firebase FCM + Vercel cron | ✅ | ⚠️ iOS 16.4+ PWA | Gratuit jusqu'à 100k/mois | 1-2 jours |
| Service Push self-hosted | ✅ | ⚠️ | VPS ~5€/mois | 1 semaine |

---

## 🎯 Recommandation Trade Genius

**Phase 1 (maintenant)** : système au load suffit pour MVP
- Création habitude (streak fait revenir l'user)
- Pas de friction d'install
- Conforme RGPD (notif locale, pas de tracker)

**Phase 2 (si traction)** : ajouter FCM + Vercel cron
- Quand t'as ~1000 utilisateurs actifs
- Quand tu veux pousser engagement (rappels matin/soir)
- Quand tu veux annoncer nouveau module / fonctionnalité

**Phase 3 (long terme)** : push contextuelles
- "Le marché a chuté de 5% → vois quoi en penser (Module 3)"
- "Nouveau scenario dans le simu : crash banques 2023"

---

**Fichier à conserver pour référence future. Ne nécessite aucune action immédiate.**
