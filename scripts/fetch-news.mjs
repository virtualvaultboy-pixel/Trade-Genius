#!/usr/bin/env node
/**
 * Trade Genius — Fetch news feed pour GH Pages
 * Source 1 : CryptoCompare News (gratuit, sans clé)
 * Source 2 : Yahoo Finance RSS (gratuit, sans clé)
 *
 * Tourné par .github/workflows/news-update.yml toutes les 30 min.
 * Écrit data/news.json à la racine. L'app charge ce JSON comme un
 * fichier statique servi par GitHub Pages — VRAIMENT illimité côté
 * users (pas de proxy, pas de rate limit).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_BODY = 240;
const LIMIT_PER_SOURCE = 6;
// v2.86 — On accumule maintenant les news des 48 dernières heures pour permettre
// au croisement IA × news (build-ai-study.mjs) de détecter les contextes
// d'actualité récente sur les actifs.
const KEEP_HOURS = 48;
const MAX_KEPT_NEWS = 150;

function trim(s, n) {
  if (!s) return '';
  s = String(s).trim();
  return s.length > n ? s.slice(0, n).trim() + '…' : s;
}

async function fetchCryptoNews() {
  try {
    const r = await fetch(
      `https://min-api.cryptocompare.com/data/v2/news/?lang=EN&limit=${LIMIT_PER_SOURCE + 1}`,
      { headers: { 'user-agent': 'trade-genius-bot/1.0 (github.com/virtualvaultboy-pixel/Trade-Genius)' } }
    );
    if (!r.ok) throw new Error(`CC HTTP ${r.status}`);
    const j = await r.json();
    const items = Array.isArray(j?.Data) ? j.Data.slice(0, LIMIT_PER_SOURCE) : [];
    return items.map((n) => ({
      kind: 'crypto',
      title: trim(n.title, 140),
      body: trim(n.body, MAX_BODY),
      source: n.source_info?.name || n.source || 'CryptoCompare',
      url: n.url || '',
      time: n.published_on ? new Date(n.published_on * 1000).toISOString() : new Date().toISOString(),
    })).filter((n) => n.title);
  } catch (e) {
    console.warn('CryptoCompare fetch failed:', e.message);
    return [];
  }
}

async function fetchYahooRSS() {
  try {
    const url =
      'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC,%5EIXIC,%5EFCHI,%5EDJI&region=US&lang=en-US';
    const r = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (trade-genius-bot)' },
    });
    if (!r.ok) throw new Error(`YH HTTP ${r.status}`);
    const xml = await r.text();
    const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, LIMIT_PER_SOURCE);
    return itemBlocks
      .map(([, block]) => {
        const pick = (tag) => {
          const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`);
          const m = block.match(re);
          return m ? m[1].trim() : '';
        };
        const desc = pick('description').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        const pubDate = pick('pubDate');
        return {
          kind: 'marche',
          title: trim(pick('title'), 140),
          body: trim(desc, MAX_BODY),
          source: 'Yahoo Finance',
          url: pick('link'),
          time: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        };
      })
      .filter((n) => n.title);
  } catch (e) {
    console.warn('Yahoo RSS fetch failed:', e.message);
    return [];
  }
}

async function main() {
  const [market, crypto] = await Promise.all([fetchYahooRSS(), fetchCryptoNews()]);
  const fresh = [...market, ...crypto].filter((n) => n.title && n.title.length > 5);

  const target = path.join(process.cwd(), 'data', 'news.json');
  await fs.mkdir(path.dirname(target), { recursive: true });

  // v2.86 — Charge les news existantes et merge avec les fraîches.
  // Garde uniquement celles < KEEP_HOURS, dédoublonne par URL+title.
  let existing = [];
  try {
    const raw = await fs.readFile(target, 'utf8');
    const prev = JSON.parse(raw);
    existing = Array.isArray(prev?.news) ? prev.news : [];
  } catch {}

  const cutoff = Date.now() - KEEP_HOURS * 3600 * 1000;
  const dedupKey = (n) => (n.url || '') + '|' + (n.title || '');
  const seen = new Set();
  const all = [];
  for (const n of [...fresh, ...existing]) {
    const k = dedupKey(n);
    if (seen.has(k)) continue;
    seen.add(k);
    const t = new Date(n.time).getTime();
    if (Number.isFinite(t) && t < cutoff) continue;
    all.push(n);
  }
  all.sort((a, b) => new Date(b.time) - new Date(a.time));
  if (all.length > MAX_KEPT_NEWS) all.length = MAX_KEPT_NEWS;

  const out = {
    generated: new Date().toISOString(),
    sources: ['CryptoCompare News', 'Yahoo Finance RSS'],
    window_hours: KEEP_HOURS,
    count: all.length,
    news: all,
  };

  // Skip si liste identique
  const fingerprint = (arr) => JSON.stringify(arr.map((n) => ({ t: n.title, u: n.url })));
  if (existing.length && fingerprint(existing) === fingerprint(all)) {
    console.log('News list unchanged — skipping write.');
    return;
  }

  await fs.writeFile(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${all.length} news items (kept ${KEEP_HOURS}h window) to data/news.json`);
}

main().catch((e) => {
  console.error('fetch-news.mjs failed:', e);
  process.exit(1);
});
