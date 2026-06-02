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

// v11.12 — Élargissement sources : Bloomberg / MarketWatch / CNBC / Investing.com / Reuters
// Toutes RSS publiques gratuites. Headlines uniquement (pas de contenu paywall).
// Approche unifiée : 1 helper fetchRSS(name, url, kind, limit) pour tous.
async function fetchRSS(name, url, kind, limit = 5) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (trade-genius-bot)' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const xml = await r.text();
    const items = [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)].slice(0, limit);
    return items
      .map(([, block]) => {
        const pick = (tag) => {
          const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`);
          const m = block.match(re);
          return m ? m[1].trim() : '';
        };
        const desc = pick('description').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        const pubDate = pick('pubDate');
        return {
          kind,
          title: trim(pick('title'), 140),
          body: trim(desc, MAX_BODY),
          source: name,
          url: pick('link'),
          time: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        };
      })
      .filter((n) => n.title && n.title.length > 5);
  } catch (e) {
    console.warn(`${name} fetch failed:`, e.message);
    return [];
  }
}

// v11.12 — Sources premium RSS publiques (titres + descriptions courtes uniquement)
// Aucun contenu paywall scrapé. Headlines = info publique, légale à republier.
const PREMIUM_RSS_SOURCES = [
  { name: 'MarketWatch',  url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',                    kind: 'marche' },
  { name: 'CNBC',         url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',                         kind: 'marche' },
  { name: 'Investing.com', url: 'https://www.investing.com/rss/news.rss',                                       kind: 'marche' },
  { name: 'Yahoo Finance Crypto', url: 'https://finance.yahoo.com/news/rssindex',                               kind: 'marche' },
  { name: 'CoinDesk',     url: 'https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml',                kind: 'crypto' },
];

async function fetchPremiumSources() {
  const results = await Promise.all(
    PREMIUM_RSS_SOURCES.map(s => fetchRSS(s.name, s.url, s.kind, LIMIT_PER_SOURCE))
  );
  return results.flat();
}

// v11.13 — Reddit RSS public (le JSON est blocked HTTP 403 maintenant).
// Endpoint .rss/?sort=top encore accessible avec user-agent navigateur.
// Détecte le buzz retail/communauté sur les subs finance.
const REDDIT_SUBS = [
  { sub: 'wallstreetbets', kind: 'marche', limit: 6 },
  { sub: 'stocks',         kind: 'marche', limit: 5 },
  { sub: 'investing',      kind: 'marche', limit: 4 },
  { sub: 'cryptocurrency', kind: 'crypto', limit: 5 },
];
async function fetchRedditOne(cfg) {
  try {
    // Atom feed (pas RSS classique pour Reddit, mais le parser handle les <entry>)
    const url = `https://www.reddit.com/r/${cfg.sub}/top/.rss?t=day`;
    const r = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) trade-genius-bot/1.0' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const xml = await r.text();
    // Atom feed parsing : <entry>...</entry>
    const entries = [...xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/g)].slice(0, cfg.limit);
    return entries
      .map(([, block]) => {
        const pick = (tag) => {
          const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
          const m = block.match(re);
          return m ? m[1].trim() : '';
        };
        const link = (block.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
        const updated = pick('updated');
        return {
          kind: cfg.kind,
          title: trim(pick('title').replace(/^\[.+?\]\s*/, ''), 140),
          body: '',
          source: `Reddit r/${cfg.sub}`,
          url: link,
          time: updated ? new Date(updated).toISOString() : new Date().toISOString(),
        };
      })
      .filter(n => n.title && n.title.length > 5);
  } catch (e) {
    console.warn(`Reddit r/${cfg.sub} fetch failed:`, e.message);
    return [];
  }
}
async function fetchReddit() {
  const all = await Promise.all(REDDIT_SUBS.map(fetchRedditOne));
  return all.flat();
}

// v11.13 — HackerNews (Firebase API publique, sans clé).
// Filtre les stories pertinentes finance/trading/crypto via keywords.
const HN_KEYWORDS = /\b(stock|trading|crypto|bitcoin|ethereum|federal reserve|fed |inflation|recession|market|nasdaq|s&p 500|wall street|tesla|nvidia|apple|microsoft|google|amazon|meta|earnings|ipo|sec |fintech)\b/i;
async function fetchHackerNews() {
  try {
    const r = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ids = await r.json();
    if (!Array.isArray(ids)) return [];
    // Vérifie les 30 premiers, garde max 5 finance-related
    const topIds = ids.slice(0, 30);
    const items = await Promise.all(
      topIds.map(async (id) => {
        try {
          const rr = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
          if (!rr.ok) return null;
          return await rr.json();
        } catch { return null; }
      })
    );
    const filtered = items
      .filter(it => it && it.title && it.type === 'story' && HN_KEYWORDS.test(it.title))
      .slice(0, 5)
      .map(it => ({
        kind: 'marche',
        title: trim(it.title, 140),
        body: '',
        source: 'Hacker News',
        url: it.url || `https://news.ycombinator.com/item?id=${it.id}`,
        time: it.time ? new Date(it.time * 1000).toISOString() : new Date().toISOString(),
      }));
    return filtered;
  } catch (e) {
    console.warn('Hacker News fetch failed:', e.message);
    return [];
  }
}

async function main() {
  const [market, crypto, premium, reddit, hn] = await Promise.all([
    fetchYahooRSS(),
    fetchCryptoNews(),
    fetchPremiumSources(),
    fetchReddit(),
    fetchHackerNews(),
  ]);
  const fresh = [...market, ...crypto, ...premium, ...reddit, ...hn]
    .filter((n) => n.title && n.title.length > 5);
  console.log(`Sources : Yahoo=${market.length}, CryptoCompare=${crypto.length}, Premium=${premium.length}, Reddit=${reddit.length}, HN=${hn.length} (total fresh=${fresh.length})`);

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
    sources: [
      'Yahoo Finance RSS', 'CryptoCompare News',
      ...PREMIUM_RSS_SOURCES.map(s => s.name),
      ...REDDIT_SUBS.map(s => 'Reddit r/' + s.sub),
      'Hacker News',
    ],
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
