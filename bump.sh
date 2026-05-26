#!/usr/bin/env bash
# Trade Genius — Bump version centralisé
# Usage: ./bump.sh 1.50
set -e
V="${1:-}"
if [ -z "$V" ]; then echo "Usage: $0 <version, ex: 1.50>"; exit 1; fi
VINT=$(echo "$V" | tr -d '.')

cd "$(dirname "$0")"

# 1) Sync tous les liens scene-XX.html?v=... dans index.html
for n in 01 02 03 04 05 06 07 08 09 10 11 12; do
  sed -i "s|scene-${n}\.html?v=[0-9]*|scene-${n}.html?v=${VINT}|g" index.html
done

# 2) Sync version dans tg-common.js
sed -i "s|export const TG_VERSION = 'v[0-9.]*';|export const TG_VERSION = 'v${V}';|" tg-common.js

# 3) Sync ?v=... du tg-common.js + tg-analyst.js dans toutes les pages (y compris glossary)
sed -i "s|tg-common\.js?v=[0-9]*|tg-common.js?v=${VINT}|g" index.html scene-*.html glossary.html 2>/dev/null
sed -i "s|tg-analyst\.js?v=[0-9]*|tg-analyst.js?v=${VINT}|g" index.html scene-*.html glossary.html 2>/dev/null
sed -i "s|tg-bubble\.js?v=[0-9]*|tg-bubble.js?v=${VINT}|g" index.html scene-*.html glossary.html 2>/dev/null

# 4) Sync ?v=... du sw.js dans toutes les pages (serviceWorker.register)
sed -i "s|sw\.js?v=[0-9]*|sw.js?v=${VINT}|g" index.html scene-*.html

# 5) Sync version dans sw.js
sed -i "s|const VERSION = 'tg-v[0-9.]*';|const VERSION = 'tg-v${V}';|" sw.js
for n in 01 02 03 04 05 06 07 08 09 10 11 12; do
  sed -i "s|scene-${n}\.html?v=[0-9]*|scene-${n}.html?v=${VINT}|g" sw.js
done
sed -i "s|tg-common\.js?v=[0-9]*|tg-common.js?v=${VINT}|g" sw.js
sed -i "s|tg-analyst\.js?v=[0-9]*|tg-analyst.js?v=${VINT}|g" sw.js
sed -i "s|tg-bubble\.js?v=[0-9]*|tg-bubble.js?v=${VINT}|g" sw.js

# 6) v2.59 — Sync auto des badges UI #bd-version et #hbb-tag (était manuel avant)
sed -i "s|id=\"bd-version\">v[0-9.]*<|id=\"bd-version\">v${V}<|" index.html
sed -i "s|id=\"hbb-tag\">v[0-9.]*<|id=\"hbb-tag\">v${V}<|" index.html

echo "Bumped to v$V ($VINT) — badges UI inclus"
