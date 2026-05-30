/**
 * Trade Genius — v8.8 WISDOM BASE
 *
 * Base de connaissances historique : 15 événements de marché majeurs (1997-2024)
 * avec leurs déclencheurs détectables (VIX/yield curve/Fed cycle/sector rotation)
 * et le playbook IA appris ex-post.
 *
 * Permet à build-ai-study.mjs de :
 *   1. Détecter quel pattern historique ressemble le plus à la situation actuelle
 *   2. Ajuster le quality_score des setups selon les leçons historiques
 *   3. Produire un "market_reading" enrichi dans ai-study.json
 *
 * Pas de magie : c'est de la sagesse encodée, pas du ML.
 * Les triggers sont des conditions détectables via nos indicateurs existants.
 */

/**
 * Format d'un événement :
 * {
 *   id: string,           // identifiant unique
 *   date: 'YYYY-MM-DD',   // date de référence
 *   name: string,         // nom court
 *   category: string,     // systemic-crash | bubble-pop | geopolitical | fed-pivot | bull-run | sideways
 *   triggers: {           // conditions détectables aujourd'hui pour matcher
 *     vix_range: [min, max] | null,
 *     dxy_trend: 'up' | 'down' | 'neutral' | null,
 *     yield_curve: 'inverted' | 'steep' | 'flat' | null,
 *     btc_30d_change: [min, max] | null,    // %
 *     sp500_30d_change: [min, max] | null,
 *     dominant_sectors: string[],            // top 3 ETF symbols
 *     dominant_news_themes: string[],        // 'fed' | 'war' | 'crypto' | 'tech' | 'earnings' | 'inflation'
 *     special_flags: string[],               // 'btc_dump' | 'tech_dump' | 'risk_off' | 'macro_event_imminent'
 *   },
 *   market_response: {
 *     duration_days: number,
 *     sp500_pct: number,    // performance S&P sur la période
 *     btc_pct: number | null,
 *     winners: string[],    // sectors/themes qui ont surperformé
 *     losers: string[],
 *   },
 *   ia_playbook: {
 *     bastion: { weight: number, note: string },   // weight 0-1.5 (multiplie quality_score)
 *     phenix:  { weight: number, note: string },
 *     rafale:  { weight: number, note: string },
 *     nexus:   { weight: number, note: string },
 *     volt:    { weight: number, note: string },
 *   },
 *   lesson: string,        // 1 phrase actionnable
 * }
 */

export const WISDOM_EVENTS = [
  // ─────────────────────────────────────────────────────────────────────
  // 1. CRISE ASIATIQUE 1997 — devises émergentes, contagion
  {
    id: '1997-asian-crisis',
    date: '1997-07-02',
    name: 'Crise asiatique (devaluation baht)',
    category: 'geopolitical',
    triggers: {
      vix_range: [22, 45],
      dxy_trend: 'up',
      yield_curve: null,
      btc_30d_change: null,
      sp500_30d_change: [-15, 0],
      dominant_sectors: ['XLU', 'XLP', 'GLD'],
      dominant_news_themes: ['currency', 'em-stress'],
      special_flags: ['risk_off'],
    },
    market_response: {
      duration_days: 120, sp500_pct: -10, btc_pct: null,
      winners: ['XLU', 'XLP', 'GLD', 'TLT'], losers: ['EM', 'XLF', 'XLI'],
    },
    ia_playbook: {
      bastion: { weight: 0.8, note: 'Wait — DXY strong tue les EM, attendre stabilisation' },
      phenix:  { weight: 0.85, note: 'Rotation defensive : XLU/XLP only' },
      rafale:  { weight: 0.7, note: 'Volatilité erratique, scalper avec stops serrés' },
      nexus:   { weight: 0.6, note: 'Crypto n\'existe pas — N/A historique mais EM = warning' },
      volt:    { weight: 0.5, note: 'Capital à risque, réduire exposure' },
    },
    lesson: 'Devises émergentes en chute + DXY fort = risk-off graduel, défensive 2-4 mois.',
  },

  // ─────────────────────────────────────────────────────────────────────
  // 2. CRASH RUSSIE/LTCM 1998 — choc liquidité
  {
    id: '1998-russia-ltcm',
    date: '1998-08-17',
    name: 'Default Russie + collapse LTCM',
    category: 'systemic-crash',
    triggers: {
      vix_range: [35, 50],
      dxy_trend: 'down',
      yield_curve: 'flat',
      btc_30d_change: null,
      sp500_30d_change: [-20, -10],
      dominant_sectors: ['TLT', 'GLD'],
      dominant_news_themes: ['credit', 'liquidity'],
      special_flags: ['risk_off'],
    },
    market_response: {
      duration_days: 75, sp500_pct: -19, btc_pct: null,
      winners: ['TLT', 'GLD'], losers: ['XLF', 'IEMG', 'JNK'],
    },
    ia_playbook: {
      bastion: { weight: 0.7, note: 'Crise liquidité — wait pour Fed action' },
      phenix:  { weight: 0.75, note: 'Long-only sur quality dividend' },
      rafale:  { weight: 0.6, note: 'Spreads bid-ask larges, attention exécution' },
      nexus:   { weight: 0.6, note: 'N/A — pas de crypto' },
      volt:    { weight: 0.4, note: 'Cash 100% jusqu\'à VIX <25' },
    },
    lesson: 'Quand VIX >40 + liquidité bancaire stressée, Fed cuts = signal d\'achat ~ 4-6 semaines après.',
  },

  // ─────────────────────────────────────────────────────────────────────
  // 3. BULLE DOT-COM PEAK 2000
  {
    id: '2000-dotcom-peak',
    date: '2000-03-10',
    name: 'Pic bulle dot-com (Nasdaq ATH)',
    category: 'bubble-pop',
    triggers: {
      vix_range: [18, 28],
      dxy_trend: 'up',
      yield_curve: 'inverted',
      btc_30d_change: null,
      sp500_30d_change: [5, 15],
      dominant_sectors: ['XLK', 'XLC', 'SOXX'],
      dominant_news_themes: ['tech', 'ipo', 'valuation'],
      special_flags: [],
    },
    market_response: {
      duration_days: 730, sp500_pct: -49, btc_pct: null,
      winners: ['XLP', 'XLU', 'XLE'], losers: ['XLK', 'SOXX', 'IBB'],
    },
    ia_playbook: {
      bastion: { weight: 0.5, note: 'Peak valorisations + curve inversée = bear séculaire imminent' },
      phenix:  { weight: 0.6, note: 'Rotation tech → value/utilities' },
      rafale:  { weight: 0.7, note: 'Volatilité tech extrême, scalper possible mais stops <1 ATR' },
      nexus:   { weight: 0.4, note: 'N/A historique mais analogue : pic crypto IA = warning' },
      volt:    { weight: 0.3, note: 'Cash + petits shorts tech only' },
    },
    lesson: 'Courbe taux inversée + tech bullée + PE >35 = bear market 18-24 mois, rotation défensive obligatoire.',
  },

  // ─────────────────────────────────────────────────────────────────────
  // 4. POST 9/11 2001 — choc géopolitique
  {
    id: '2001-nine-eleven',
    date: '2001-09-11',
    name: 'Attentats 11 septembre',
    category: 'geopolitical',
    triggers: {
      vix_range: [40, 55],
      dxy_trend: 'down',
      yield_curve: 'flat',
      btc_30d_change: null,
      sp500_30d_change: [-15, -5],
      dominant_sectors: ['XLE', 'XLU', 'GLD'],
      dominant_news_themes: ['war', 'terrorism', 'oil'],
      special_flags: ['risk_off', 'tech_dump'],
    },
    market_response: {
      duration_days: 60, sp500_pct: -12, btc_pct: null,
      winners: ['XLE', 'GLD', 'TLT', 'ITA'], losers: ['XLY', 'IYT', 'XLF'],
    },
    ia_playbook: {
      bastion: { weight: 0.8, note: 'Rebond V-shape historique ~30j post-event, accumuler' },
      phenix:  { weight: 0.9, note: 'Bottom-fishing sur quality après VIX <30' },
      rafale:  { weight: 0.7, note: 'Volatilité énorme premiers jours, attendre 5j' },
      nexus:   { weight: 0.6, note: 'N/A — pas de crypto' },
      volt:    { weight: 0.8, note: 'Opportunité haute conviction sur capitulation' },
    },
    lesson: 'Choc géopolitique unique → rebond V-shape ~30j post-event si pas d\'extension structurelle.',
  },

  // ─────────────────────────────────────────────────────────────────────
  // 5. SUBPRIME PEAK 2007
  {
    id: '2007-subprime-peak',
    date: '2007-10-09',
    name: 'Pic pré-subprime (ATH S&P)',
    category: 'bubble-pop',
    triggers: {
      vix_range: [16, 24],
      dxy_trend: 'down',
      yield_curve: 'inverted',
      btc_30d_change: null,
      sp500_30d_change: [2, 10],
      dominant_sectors: ['XLF', 'XLY', 'XLB'],
      dominant_news_themes: ['housing', 'credit', 'subprime'],
      special_flags: [],
    },
    market_response: {
      duration_days: 510, sp500_pct: -56, btc_pct: null,
      winners: ['TLT', 'GLD', 'XLP'], losers: ['XLF', 'XLY', 'XHB'],
    },
    ia_playbook: {
      bastion: { weight: 0.4, note: 'Sortir des longs financières/conso disc — bear imminent' },
      phenix:  { weight: 0.5, note: 'Rotation defensive XLP/XLU/TLT' },
      rafale:  { weight: 0.6, note: 'Short rebounds possibles' },
      nexus:   { weight: 0.4, note: 'N/A — pas de crypto' },
      volt:    { weight: 0.2, note: 'Capital à risque énorme, attendre Lehman+' },
    },
    lesson: 'Yield curve inversée + bulle housing + credit spreads écartés = pre-2008 setup, défensive obligatoire.',
  },

  // ─────────────────────────────────────────────────────────────────────
  // 6. LEHMAN 2008
  {
    id: '2008-lehman',
    date: '2008-09-15',
    name: 'Faillite Lehman Brothers',
    category: 'systemic-crash',
    triggers: {
      vix_range: [45, 90],
      dxy_trend: 'up',
      yield_curve: 'flat',
      btc_30d_change: null,
      sp500_30d_change: [-30, -15],
      dominant_sectors: ['TLT', 'GLD', 'UUP'],
      dominant_news_themes: ['credit', 'bank', 'liquidity', 'fed'],
      special_flags: ['risk_off', 'tech_dump'],
    },
    market_response: {
      duration_days: 180, sp500_pct: -38, btc_pct: null,
      winners: ['TLT', 'GLD', 'UUP'], losers: ['XLF', 'XLI', 'XLY', 'XHB'],
    },
    ia_playbook: {
      bastion: { weight: 0.3, note: 'NO LONG — attendre bottom Q1 2009 (VIX <30 confirmé)' },
      phenix:  { weight: 0.35, note: 'Cash sauf treasuries' },
      rafale:  { weight: 0.5, note: 'Scalp rebounds techniques, stops 0.5 ATR max' },
      nexus:   { weight: 0.3, note: 'N/A historique mais crypto sera pareil en cas de hack systémique' },
      volt:    { weight: 0.1, note: 'CAPITULATION CASH — kill switch automatique' },
    },
    lesson: 'VIX >40 sustained + bank failures → bottom ~6 mois après peak panic, accumuler graduellement.',
  },

  // ─────────────────────────────────────────────────────────────────────
  // 7. BOTTOM 2009 — opportunité générationnelle
  {
    id: '2009-bottom',
    date: '2009-03-09',
    name: 'Bottom Lehman bear (S&P 666)',
    category: 'fed-pivot',
    triggers: {
      vix_range: [38, 55],
      dxy_trend: 'down',
      yield_curve: 'steep',
      btc_30d_change: null,
      sp500_30d_change: [-15, -5],
      dominant_sectors: ['XLF', 'XLY', 'XLK'],
      dominant_news_themes: ['fed', 'qe', 'stimulus'],
      special_flags: [],
    },
    market_response: {
      duration_days: 365, sp500_pct: 68, btc_pct: null,
      winners: ['XLF', 'XLK', 'XLY'], losers: ['TLT', 'UUP'],
    },
    ia_playbook: {
      bastion: { weight: 1.4, note: 'OPPORTUNITÉ GÉNÉRATIONNELLE — long all-in quality' },
      phenix:  { weight: 1.35, note: 'Rotation cash → tech/finance' },
      rafale:  { weight: 1.2, note: 'Bull momentum, riding trend' },
      nexus:   { weight: 1.1, note: 'N/A — crypto pas encore mature' },
      volt:    { weight: 1.3, note: 'Haute conviction sur recovery plays' },
    },
    lesson: 'QE annoncé + VIX qui retombe + courbe steepening = bottom, accumuler agressivement.',
  },

  // ─────────────────────────────────────────────────────────────────────
  // 8. CRISE EURO 2011
  {
    id: '2011-euro-crisis',
    date: '2011-08-08',
    name: 'Crise dette souveraine euro (S&P US downgrade)',
    category: 'systemic-crash',
    triggers: {
      vix_range: [30, 48],
      dxy_trend: 'up',
      yield_curve: 'flat',
      btc_30d_change: null,
      sp500_30d_change: [-18, -8],
      dominant_sectors: ['TLT', 'GLD'],
      dominant_news_themes: ['credit', 'sovereign', 'eu'],
      special_flags: ['risk_off'],
    },
    market_response: {
      duration_days: 120, sp500_pct: -16, btc_pct: null,
      winners: ['TLT', 'GLD', 'XLP'], losers: ['XLF', 'EZU', 'EWP'],
    },
    ia_playbook: {
      bastion: { weight: 0.7, note: 'Skip Europe, focus US quality' },
      phenix:  { weight: 0.75, note: 'Rotation defensive court terme' },
      rafale:  { weight: 0.7, note: 'Scalp VIX spikes' },
      nexus:   { weight: 0.8, note: 'Crypto nascent — BTC volatile mais découplé' },
      volt:    { weight: 0.5, note: 'Réduire size, sélectivité max' },
    },
    lesson: 'Crise régionale (Europe) + downgrade US = risk-off 3-4 mois mais Fed/BCE finissent par calmer.',
  },

  // ─────────────────────────────────────────────────────────────────────
  // 9. FLASH CRASH 2010 + tapering 2013 = vol spikes courts
  {
    id: '2013-tapering-tantrum',
    date: '2013-05-22',
    name: 'Tapering tantrum (Bernanke)',
    category: 'fed-pivot',
    triggers: {
      vix_range: [15, 22],
      dxy_trend: 'up',
      yield_curve: 'steep',
      btc_30d_change: null,
      sp500_30d_change: [-5, 2],
      dominant_sectors: ['XLF', 'XLI'],
      dominant_news_themes: ['fed', 'tapering', 'rates'],
      special_flags: ['macro_event_imminent'],
    },
    market_response: {
      duration_days: 45, sp500_pct: -5, btc_pct: null,
      winners: ['XLF', 'XLI'], losers: ['TLT', 'XLU', 'IYR'],
    },
    ia_playbook: {
      bastion: { weight: 1.0, note: 'Reprise du bull, opportunités sur dip' },
      phenix:  { weight: 1.1, note: 'Bottom-fishing post-overreaction' },
      rafale:  { weight: 1.1, note: 'Scalp les overreactions rapides' },
      nexus:   { weight: 0.9, note: 'BTC en baisse, attendre stabilisation' },
      volt:    { weight: 1.0, note: 'Quick rebounds possibles' },
    },
    lesson: 'Sell-off Fed-driven sans récession = correction technique 4-8 semaines, buy the dip.',
  },

  // ─────────────────────────────────────────────────────────────────────
  // 10. BREXIT 2016
  {
    id: '2016-brexit',
    date: '2016-06-24',
    name: 'Brexit vote',
    category: 'geopolitical',
    triggers: {
      vix_range: [22, 32],
      dxy_trend: 'up',
      yield_curve: 'flat',
      btc_30d_change: [5, 25],
      sp500_30d_change: [-8, 2],
      dominant_sectors: ['XLU', 'XLP', 'GLD'],
      dominant_news_themes: ['geopolitical', 'currency'],
      special_flags: ['risk_off'],
    },
    market_response: {
      duration_days: 30, sp500_pct: 5, btc_pct: 20,
      winners: ['XLU', 'GLD', 'TLT', 'BTC'], losers: ['XLF', 'EZU', 'EWU'],
    },
    ia_playbook: {
      bastion: { weight: 1.0, note: 'Skip UK/EU, US continue trend' },
      phenix:  { weight: 1.05, note: 'Buy the dip ~5 jours après' },
      rafale:  { weight: 1.1, note: 'Vol spike → scalper jour 1' },
      nexus:   { weight: 1.2, note: 'BTC safe-haven émergent : +20% en 1 semaine' },
      volt:    { weight: 1.0, note: 'Recovery rapide V-shape' },
    },
    lesson: 'Choc politique unique sans contagion économique = recovery <1 mois, BTC commence à jouer safe-haven.',
  },

  // ─────────────────────────────────────────────────────────────────────
  // 11. SELL-OFF Q4 2018 (Fed hawkish + Powell put absent)
  {
    id: '2018-q4-selloff',
    date: '2018-12-24',
    name: 'Sell-off Q4 2018 (Fed hawkish)',
    category: 'fed-pivot',
    triggers: {
      vix_range: [25, 40],
      dxy_trend: 'up',
      yield_curve: 'flat',
      btc_30d_change: [-30, -10],
      sp500_30d_change: [-20, -10],
      dominant_sectors: ['XLP', 'XLU'],
      dominant_news_themes: ['fed', 'rates', 'trade-war'],
      special_flags: ['risk_off', 'tech_dump'],
    },
    market_response: {
      duration_days: 60, sp500_pct: -19, btc_pct: -25,
      winners: ['XLP', 'XLU', 'TLT'], losers: ['XLK', 'SOXX', 'XLY'],
    },
    ia_playbook: {
      bastion: { weight: 0.85, note: 'Attendre Fed pivot — environ 4-6 semaines' },
      phenix:  { weight: 0.9, note: 'Long quality post-Powell pivot' },
      rafale:  { weight: 0.95, note: 'V-shape attendu après capitulation' },
      nexus:   { weight: 0.7, note: 'BTC en bear, attendre stabilisation $3000-3500' },
      volt:    { weight: 0.75, note: 'Réduire size, attendre signal Fed' },
    },
    lesson: 'Fed trop hawkish sans inflation → sell-off 2 mois jusqu\'au pivot, puis V-shape +25% en 3 mois.',
  },

  // ─────────────────────────────────────────────────────────────────────
  // 12. COVID CRASH 2020
  {
    id: '2020-covid-crash',
    date: '2020-03-16',
    name: 'COVID crash (limit down × 4)',
    category: 'systemic-crash',
    triggers: {
      vix_range: [60, 85],
      dxy_trend: 'up',
      yield_curve: 'steep',
      btc_30d_change: [-50, -20],
      sp500_30d_change: [-35, -20],
      dominant_sectors: ['TLT', 'GLD'],
      dominant_news_themes: ['pandemic', 'lockdown', 'fed', 'stimulus'],
      special_flags: ['risk_off', 'tech_dump', 'btc_dump'],
    },
    market_response: {
      duration_days: 30, sp500_pct: -34, btc_pct: -50,
      winners: ['TLT', 'GLD', 'ZM', 'NFLX'], losers: ['XLE', 'IYT', 'CCL'],
    },
    ia_playbook: {
      bastion: { weight: 0.6, note: 'Wait Fed stimulus, puis all-in tech/biotech' },
      phenix:  { weight: 0.65, note: 'Bottom-fishing post-Fed unlimited QE' },
      rafale:  { weight: 0.75, note: 'Scalp rebounds techniques V-shape' },
      nexus:   { weight: 0.6, note: 'BTC dump -50% mais rebond x4 en 12 mois' },
      volt:    { weight: 0.4, note: 'Capitulation cash puis re-entry post-QE' },
    },
    lesson: 'Choc exogène + Fed unlimited QE = bottom rapide (<6 semaines), recovery V-shape avec tech mega-cap leader.',
  },

  // ─────────────────────────────────────────────────────────────────────
  // 13. BULL POST-COVID 2020-2021 — easy money + retail boom
  {
    id: '2021-meme-bull',
    date: '2021-01-27',
    name: 'Bull post-COVID (meme stocks + retail)',
    category: 'bull-run',
    triggers: {
      vix_range: [15, 28],
      dxy_trend: 'down',
      yield_curve: 'steep',
      btc_30d_change: [10, 80],
      sp500_30d_change: [5, 12],
      dominant_sectors: ['XLK', 'ARKK', 'XLY'],
      dominant_news_themes: ['stimulus', 'retail', 'crypto', 'tech'],
      special_flags: [],
    },
    market_response: {
      duration_days: 365, sp500_pct: 28, btc_pct: 350,
      winners: ['XLK', 'ARKK', 'BTC', 'ETH', 'meme stocks'], losers: ['XLE défensives early'],
    },
    ia_playbook: {
      bastion: { weight: 1.35, note: 'Bull market profitable, holds longs OK' },
      phenix:  { weight: 1.4, note: 'Momentum tech + growth' },
      rafale:  { weight: 1.2, note: 'Scalp les pumps mais attention reversals violents' },
      nexus:   { weight: 1.5, note: 'Crypto en parabolique, accumuler avec scaled-in' },
      volt:    { weight: 1.4, note: 'Haute conviction sur mid-cap volatiles' },
    },
    lesson: 'Easy money + retail euphoria = parabolic 12 mois mais top brutal, garder trailing stops 5-8 ATR.',
  },

  // ─────────────────────────────────────────────────────────────────────
  // 14. BEAR 2022 — Fed hawkish + guerre Ukraine + inflation
  {
    id: '2022-fed-hawkish-bear',
    date: '2022-06-13',
    name: 'Bear 2022 (Fed +75bps + inflation 9%)',
    category: 'fed-pivot',
    triggers: {
      vix_range: [25, 38],
      dxy_trend: 'up',
      yield_curve: 'inverted',
      btc_30d_change: [-40, -10],
      sp500_30d_change: [-15, -5],
      dominant_sectors: ['XLE', 'XLP'],
      dominant_news_themes: ['inflation', 'fed', 'war', 'oil'],
      special_flags: ['risk_off'],
    },
    market_response: {
      duration_days: 280, sp500_pct: -22, btc_pct: -65,
      winners: ['XLE', 'GLD', 'UUP'], losers: ['XLK', 'ARKK', 'BTC', 'ETH'],
    },
    ia_playbook: {
      bastion: { weight: 0.6, note: 'Rotation tech → énergie/défensive' },
      phenix:  { weight: 0.7, note: 'Long energy + defensive, short tech' },
      rafale:  { weight: 0.8, note: 'Scalp bear rallies + courts' },
      nexus:   { weight: 0.5, note: 'BTC en bear séculaire, wait ATR plat' },
      volt:    { weight: 0.4, note: 'Capital à risque, attendre Fed pivot' },
    },
    lesson: 'Fed hawkish + inflation persistante + courbe inversée = bear 9-12 mois, rotation vers value/energy.',
  },

  // ─────────────────────────────────────────────────────────────────────
  // 15. RALLY IA 2024 — Nvidia + Mag7 + crypto halving
  {
    id: '2024-ai-rally',
    date: '2024-03-08',
    name: 'Rally IA + Halving BTC',
    category: 'bull-run',
    triggers: {
      vix_range: [12, 18],
      dxy_trend: 'neutral',
      yield_curve: 'inverted',
      btc_30d_change: [5, 40],
      sp500_30d_change: [3, 10],
      dominant_sectors: ['SOXX', 'XLK', 'SMH'],
      dominant_news_themes: ['ai', 'tech', 'crypto', 'halving'],
      special_flags: [],
    },
    market_response: {
      duration_days: 240, sp500_pct: 18, btc_pct: 55,
      winners: ['SOXX', 'NVDA', 'BTC', 'SMH', 'XLK'], losers: ['XLU', 'XLP', 'KRE'],
    },
    ia_playbook: {
      bastion: { weight: 1.3, note: 'Bull momentum tech/IA, trailing stops larges' },
      phenix:  { weight: 1.35, note: 'Long semicon + IA infra' },
      rafale:  { weight: 1.2, note: 'Scalper rotations sectorielles' },
      nexus:   { weight: 1.45, note: 'BTC halving cycle = bull confirmé, accumuler' },
      volt:    { weight: 1.3, note: 'Mid-cap crypto + AI speculatif OK' },
    },
    lesson: 'Narrative IA + halving BTC + Fed pause = bull 6-12 mois, momentum porte mais reversion brutale possible.',
  },
];

// ─────────────────────────────────────────────────────────────────────────
// MATCHER : compare situation actuelle vs chaque event historique
// ─────────────────────────────────────────────────────────────────────────

/**
 * Calcule un score de similarité 0-100 entre la situation actuelle et un event.
 * Pondération :
 *   - VIX range : 20 points
 *   - DXY trend : 10 points
 *   - Yield curve : 10 points
 *   - BTC 30d change : 10 points
 *   - SP500 30d change : 15 points
 *   - Sectors dominants (overlap) : 15 points
 *   - News themes (overlap) : 10 points
 *   - Special flags (overlap) : 10 points
 */
export function computeEventSimilarity(currentState, event) {
  const t = event.triggers;
  let score = 0;
  let maxScore = 0;

  // VIX range (20 pts)
  if (t.vix_range && currentState.vix != null) {
    maxScore += 20;
    if (currentState.vix >= t.vix_range[0] && currentState.vix <= t.vix_range[1]) score += 20;
    else {
      // Demi-points si proche (<20% écart)
      const mid = (t.vix_range[0] + t.vix_range[1]) / 2;
      const dist = Math.abs(currentState.vix - mid) / mid;
      if (dist < 0.3) score += 10;
    }
  }

  // DXY trend (10 pts)
  if (t.dxy_trend && currentState.dxy_trend) {
    maxScore += 10;
    if (t.dxy_trend === currentState.dxy_trend) score += 10;
  }

  // Yield curve (10 pts)
  if (t.yield_curve && currentState.yield_curve) {
    maxScore += 10;
    if (t.yield_curve === currentState.yield_curve) score += 10;
  }

  // BTC 30d change (10 pts)
  if (t.btc_30d_change && currentState.btc_30d_change != null) {
    maxScore += 10;
    if (currentState.btc_30d_change >= t.btc_30d_change[0] && currentState.btc_30d_change <= t.btc_30d_change[1]) score += 10;
  }

  // SP500 30d change (15 pts)
  if (t.sp500_30d_change && currentState.sp500_30d_change != null) {
    maxScore += 15;
    if (currentState.sp500_30d_change >= t.sp500_30d_change[0] && currentState.sp500_30d_change <= t.sp500_30d_change[1]) score += 15;
    else {
      const mid = (t.sp500_30d_change[0] + t.sp500_30d_change[1]) / 2;
      if (Math.abs(currentState.sp500_30d_change - mid) < 5) score += 8;
    }
  }

  // Sectors dominants (15 pts) — overlap
  if (t.dominant_sectors?.length && currentState.dominant_sectors?.length) {
    maxScore += 15;
    const overlap = t.dominant_sectors.filter(s => currentState.dominant_sectors.includes(s)).length;
    score += Math.min(15, overlap * 5);
  }

  // News themes (10 pts) — overlap
  if (t.dominant_news_themes?.length && currentState.dominant_news_themes?.length) {
    maxScore += 10;
    const overlap = t.dominant_news_themes.filter(s => currentState.dominant_news_themes.includes(s)).length;
    score += Math.min(10, overlap * 4);
  }

  // Special flags (10 pts) — overlap
  if (t.special_flags?.length && currentState.special_flags?.length) {
    maxScore += 10;
    const overlap = t.special_flags.filter(s => currentState.special_flags.includes(s)).length;
    score += Math.min(10, overlap * 5);
  }

  if (maxScore === 0) return 0;
  return Math.round((score / maxScore) * 100);
}

/**
 * Retourne le top N events historiques les plus similaires à la situation actuelle.
 */
export function findHistoricalAnalogs(currentState, topN = 3) {
  return WISDOM_EVENTS
    .map(event => ({
      ...event,
      similarity: computeEventSimilarity(currentState, event),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topN);
}

/**
 * Calcule un ajustement de quality_score (-20 à +20) pour un setup,
 * basé sur l'IA playbook du top match historique.
 */
// Mapping backend id → clé publique du playbook
const IA_ID_MAP = {
  atlas: 'bastion',
  nova: 'phenix',
  kairo: 'rafale',
  multi: 'nexus',
  volt: 'volt',
};

export function computeWisdomAdjustment(iaId, topMatch) {
  if (!topMatch || topMatch.similarity < 40) return { adjustment: 0, note: null };
  const publicKey = IA_ID_MAP[iaId] || iaId;
  const playbook = topMatch.ia_playbook?.[publicKey];
  if (!playbook) return { adjustment: 0, note: null };

  // weight 1.0 = neutre, 0.5 = -20, 1.5 = +20
  const weight = playbook.weight;
  const adjustment = Math.round((weight - 1.0) * 40);
  return {
    adjustment: Math.max(-20, Math.min(20, adjustment)),
    note: playbook.note,
    historical_analog: `${topMatch.name} (${topMatch.date.slice(0, 4)})`,
    lesson: topMatch.lesson,
    similarity: topMatch.similarity,
  };
}

/**
 * Catégorise les news par thème via mots-clés.
 * Retourne { fed: 12, war: 3, crypto: 8, ... }
 */
const THEME_KEYWORDS = {
  fed: ['fed', 'fomc', 'powell', 'rate', 'hike', 'cut', 'cpi', 'pce', 'inflation', 'jpow'],
  war: ['war', 'iran', 'russia', 'ukraine', 'gaza', 'israel', 'china', 'taiwan', 'tariff', 'sanction'],
  crypto: ['btc', 'bitcoin', 'eth', 'ethereum', 'crypto', 'halving', 'binance', 'coinbase', 'sec ', 'spot etf'],
  tech: ['ai ', 'nvidia', 'tsmc', 'chip', 'semiconductor', 'openai', 'anthropic', 'google ai', 'apple ai'],
  earnings: ['earnings', 'guidance', 'beat', 'miss', 'eps', 'revenue', 'quarter', 'q1', 'q2', 'q3', 'q4'],
  oil: ['oil', 'crude', 'opec', 'gas', 'wti', 'brent', 'energy'],
  credit: ['credit', 'default', 'bond', 'spread', 'high yield', 'liquidity', 'bank'],
  geopolitical: ['geopolitical', 'election', 'sanctions', 'trump', 'biden', 'eu', 'brexit'],
};

export function classifyNewsThemes(newsItems) {
  const themes = {};
  for (const item of newsItems) {
    const text = (item.title + ' ' + (item.body || '')).toLowerCase();
    for (const [theme, keywords] of Object.entries(THEME_KEYWORDS)) {
      const matches = keywords.filter(k => text.includes(k)).length;
      if (matches > 0) themes[theme] = (themes[theme] || 0) + matches;
    }
  }
  return themes;
}

/**
 * Retourne le top 3 thèmes dominants par fréquence.
 */
export function getDominantThemes(themesMap, topN = 3) {
  return Object.entries(themesMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([theme]) => theme);
}
