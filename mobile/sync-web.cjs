#!/usr/bin/env node
/**
 * mobile/sync-web.cjs — Copie les fichiers web vers ./www/ pour Capacitor
 *
 * Capacitor exige un dossier `webDir` distinct. On copie tous les assets
 * nécessaires depuis la racine vers ./www/ avant chaque build mobile.
 *
 * Usage : node mobile/sync-web.cjs
 *         (appelé automatiquement par npm run cap:sync)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');

// Fichiers / dossiers à copier
const FILES = [
  'index.html',
  'glossary.html', 'privacy.html',
  'scene-01.html', 'scene-02.html', 'scene-03.html', 'scene-04.html',
  'scene-05.html', 'scene-06.html', 'scene-07.html', 'scene-08.html',
  'scene-09.html', 'scene-10.html', 'scene-11.html',
  'tg-common.js', 'tg-analyst.js', 'tg-bubble.js',
  'sw.js', 'manifest.json',
  'icon.svg', 'icon-192.png', 'icon-512.png',
  'bill_20.webp', 'bill_20.png',
];
const DIRS = ['data', 'fonts', 'screenshots'];

function copyFile(src, dst) {
  const dir = path.dirname(dst);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const item of fs.readdirSync(src)) {
    const s = path.join(src, item);
    const d = path.join(dst, item);
    const stat = fs.statSync(s);
    if (stat.isDirectory()) copyDir(s, d);
    else copyFile(s, d);
  }
}

// Clean www/
if (fs.existsSync(WWW)) fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(WWW, { recursive: true });

let copied = 0;
for (const f of FILES) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) {
    copyFile(src, path.join(WWW, f));
    copied++;
  }
}
for (const d of DIRS) {
  const src = path.join(ROOT, d);
  if (fs.existsSync(src)) {
    copyDir(src, path.join(WWW, d));
    copied++;
  }
}
console.log('[sync-web] Copied', copied, 'files/dirs to www/');
