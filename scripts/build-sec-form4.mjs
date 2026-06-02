#!/usr/bin/env node
/**
 * Trade Genius — Fetch SEC EDGAR Form 4 (insider trading)
 *
 * Form 4 = déclaration obligatoire des insiders (CEO, CFO, directors)
 * dans les 2 jours après chaque transaction. Achats massifs d'insiders
 * = signal historiquement très fort (ils savent quelque chose).
 *
 * Source : SEC EDGAR public RSS, sans clé, sans rate limit (avec un
 * user-agent identifiable + politesse 1 req/sec recommandée).
 *
 * Output : data/sec-form4.json avec liste des Form 4 récents 7j.
 *   { generated, count, filings: [{ company, ticker?, filed_at, cik, accession, url }] }
 *
 * Tourné par .github/workflows/sec-form4.yml toutes les 6h.
 * Lu par build-ai-study.mjs pour booster quality_score des setups
 * dont le ticker matche un Form 4 récent.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const SEC_UA = 'Trade Genius Research deponchy.studio@gmail.com';
const KEEP_DAYS = 7;
const MAX_FILINGS = 200;

/**
 * Fetch le flux RSS des Form 4 récents (latest 100).
 * URL : /cgi-bin/browse-edgar?action=getcurrent&type=4&output=atom
 */
async function fetchLatestForm4() {
  try {
    const url = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&owner=include&count=100&output=atom';
    const r = await fetch(url, { headers: { 'user-agent': SEC_UA } });
    if (!r.ok) throw new Error(`SEC HTTP ${r.status}`);
    const xml = await r.text();
    const entries = [...xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/g)];
    return entries.map(([, block]) => {
      const pick = (tag) => {
        const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
        const m = block.match(re);
        return m ? m[1].trim() : '';
      };
      const linkHref = (block.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
      const title = pick('title');
      const updated = pick('updated');
      // v11.14 — Format réel SEC : "4 - COMPANY NAME (XXXXXXXXXX) (Issuer)"
      // CIK = 10 chiffres entre parenthèses (PAS préfixé "CIK ").
      // Chaque transaction apparaît 2× dans le flux : (Reporting) = insider personne,
      // (Issuer) = société. On garde Issuer (notre signal = société, pas qui a tradé).
      const cikMatch = title.match(/\((\d{10})\)/);
      const cik = cikMatch ? cikMatch[1] : null;
      const isIssuer = /\(Issuer\)\s*$/.test(title);
      const compMatch = title.match(/^\d+(?:\/A)?\s*-\s*([^(]+?)\s*\(\d{10}\)/);
      const company = compMatch ? compMatch[1].trim() : title;
      // Filtre type=4 uniquement (le flux contient parfois d'autres types 424B2, 8-K...)
      const isForm4 = /^4(?:\/A)?\s*-/.test(title);
      return {
        company,
        cik,
        filed_at: updated ? new Date(updated).toISOString() : new Date().toISOString(),
        url: linkHref,
        isIssuer,
        isForm4,
      };
    }).filter(f => f.company && f.cik && f.isIssuer && f.isForm4);
  } catch (e) {
    console.warn('SEC Form 4 fetch failed:', e.message);
    return [];
  }
}

/**
 * Mapping minimal company name → ticker pour nos actifs surveillés.
 * On mappe seulement les mega-caps qu'on a dans ASSETS de build-ai-study.
 * Pour les autres, on garde juste le company name (recherche fuzzy plus tard).
 */
const COMPANY_TO_TICKER = {
  'apple inc': 'Apple',
  'microsoft corp': 'Microsoft',
  'alphabet inc': 'Alphabet',
  'amazon com inc': 'Amazon',
  'meta platforms inc': 'Meta',
  'nvidia corp': 'Nvidia',
  'tesla inc': 'Tesla',
  'advanced micro devices inc': 'AMD',
  'netflix inc': 'Netflix',
  'jpmorgan chase & co': 'JPMorgan',
  'visa inc': 'Visa',
  'walmart inc': 'Walmart',
  'johnson & johnson': 'Johnson & J.',
  'coca cola co': 'Coca-Cola',
  'walt disney co': 'Disney',
  'starbucks corp': 'Starbucks',
  'oracle corp': 'Oracle',
  'salesforce inc': 'Salesforce',
  'adobe inc': 'Adobe',
  'intel corp': 'Intel',
  'cisco systems inc': 'Cisco',
  'palantir technologies inc': 'Palantir',
  'micro strategy inc': 'MicroStrategy',
  'microstrategy inc': 'MicroStrategy',
  'coinbase global inc': 'Coinbase',
  'super micro computer inc': 'Super Micro',
  'arm holdings plc': 'ARM Holdings',
  'rivian automotive inc': 'Rivian',
  'lucid group inc': 'Lucid',
  'plug power inc': 'Plug Power',
  'snap inc': 'Snap',
  'roblox corp': 'Roblox',
  'unity software inc': 'Unity',
  'roku inc': 'Roku',
  'beyond meat inc': 'Beyond Meat',
  'draftkings inc': 'DraftKings',
};

function mapToTicker(company) {
  if (!company) return null;
  const key = company.toLowerCase().replace(/[,.]/g, '').replace(/\s+/g, ' ').trim();
  // Exact match
  if (COMPANY_TO_TICKER[key]) return COMPANY_TO_TICKER[key];
  // Fuzzy : essaie sans "inc/corp/co"
  const trimmed = key.replace(/\s+(inc|corp|company|co|plc|ltd|llc)$/i, '').trim();
  for (const [k, v] of Object.entries(COMPANY_TO_TICKER)) {
    if (k.startsWith(trimmed) || trimmed.startsWith(k.split(' ')[0])) return v;
  }
  return null;
}

async function main() {
  console.log('Fetching SEC EDGAR Form 4 (latest insider filings)...');
  const raw = await fetchLatestForm4();
  console.log(`Got ${raw.length} raw Form 4 filings`);

  // v11.14 — Accumulator pattern : le flux RSS SEC ne donne que ~50 derniers
  // filings (5 min). Pour avoir 7j d'historique, on merge avec l'existant.
  const target = path.join(process.cwd(), 'data', 'sec-form4.json');
  let existing = [];
  try {
    const prevRaw = await fs.readFile(target, 'utf8');
    const prev = JSON.parse(prevRaw);
    existing = Array.isArray(prev?.filings) ? prev.filings : [];
  } catch {}

  const cutoff = Date.now() - KEEP_DAYS * 86400 * 1000;
  const seen = new Set();
  const filings = [];
  // Process new first (priority), puis ajoute existing non-dup
  for (const f of [...raw, ...existing]) {
    const t = new Date(f.filed_at).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    const key = f.cik + '|' + f.url;
    if (seen.has(key)) continue;
    seen.add(key);
    const ticker = f.ticker || mapToTicker(f.company);
    filings.push({ ...f, ticker });
    if (filings.length >= MAX_FILINGS) break;
  }
  filings.sort((a, b) => new Date(b.filed_at) - new Date(a.filed_at));

  // Aggregate par ticker (compte le nb de Form 4 par société sur 7j)
  const tickerCount = {};
  for (const f of filings) {
    if (!f.ticker) continue;
    tickerCount[f.ticker] = (tickerCount[f.ticker] || 0) + 1;
  }
  // Threshold : on note "insider activity" si >= 2 Form 4 / société / 7j
  // (un seul Form 4 = bruit, plusieurs = pattern fort)
  const tickerSignals = {};
  for (const [t, c] of Object.entries(tickerCount)) {
    if (c >= 2) tickerSignals[t] = { count: c, intensity: c >= 5 ? 'high' : c >= 3 ? 'medium' : 'low' };
  }

  const out = {
    generated: new Date().toISOString(),
    source: 'SEC EDGAR Form 4 RSS',
    window_days: KEEP_DAYS,
    count: filings.length,
    ticker_signals: tickerSignals,
    filings: filings.slice(0, 100),  // top 100 récents pour traçabilité
  };

  // v11.14 — target déjà défini en haut (accumulator pattern)
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${filings.length} filings · ${Object.keys(tickerSignals).length} tickers signalés → data/sec-form4.json`);
  if (Object.keys(tickerSignals).length > 0) {
    const top = Object.entries(tickerSignals).sort((a, b) => b[1].count - a[1].count).slice(0, 5);
    console.log('  Top tickers : ' + top.map(([t, s]) => `${t}=${s.count}`).join(' · '));
  }
}

main().catch((e) => {
  console.error('build-sec-form4.mjs failed:', e);
  process.exit(1);
});
