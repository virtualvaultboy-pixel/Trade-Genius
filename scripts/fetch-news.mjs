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
const LIMIT_PER_SOURCE = 3;
const TOTAL_LIMIT = 6;

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
  const all = [...market, ...crypto]
    .filter((n) => n.title && n.title.length > 5)
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .slice(0, TOTAL_LIMIT);

  const out = {
    generated: new Date().toISOString(),
    sources: ['CryptoCompare News', 'Yahoo Finance RSS'],
    count: all.length,
    news: all,
  };

  const target = path.join(process.cwd(), 'data', 'news.json');
  await fs.mkdir(path.dirname(target), { recursive: true });

  // Ne pas commiter si rien n'a changé sur le contenu utile (ignore le champ generated)
  let prev = null;
  try {
    const raw = await fs.readFile(target, 'utf8');
    prev = JSON.parse(raw);
  } catch {}

  const newsFingerprint = (o) =>
    JSON.stringify((o?.news || []).map((n) => ({ t: n.title, u: n.url, s: n.source })));
  if (prev && newsFingerprint(prev) === newsFingerprint(out)) {
    console.log('News unchanged — skipping write.');
    return;
  }

  await fs.writeFile(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${all.length} news items to data/news.json`);
}

main().catch((e) => {
  console.error('fetch-news.mjs failed:', e);
  process.exit(1);
});
