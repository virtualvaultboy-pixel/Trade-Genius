// Trade Genius — common shared module
// Version partagée, badge auto, billet 3D Three.js
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

export const TG_VERSION = 'v9.1';

// === Badge version auto ===
export function injectVersionBadge() {
  if (document.getElementById('version-badge')) return;
  const b = document.createElement('div');
  b.id = 'version-badge';
  b.textContent = TG_VERSION;
  b.style.cssText = `
    position:fixed;bottom:8px;right:8px;z-index:9999;
    font-family:'JetBrains Mono',monospace;font-size:9px;
    color:rgba(255,255,255,.4);padding:3px 6px;
    border:1px solid rgba(255,255,255,.1);border-radius:4px;
    background:rgba(0,0,0,.3);backdrop-filter:blur(8px);
    pointer-events:none;letter-spacing:.1em;
  `;
  document.body.appendChild(b);
}

// === Billet 3D Three.js (factorisé) ===
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let sharedTexture = null;
let textureLoading = false;
const pendingCallbacks = [];
const bill3DInstances = [];

function loadTexture() {
  if (textureLoading || sharedTexture) return;
  textureLoading = true;
  const texLoader = new THREE.TextureLoader();
  const onSuccess = tex => {
    tex.colorSpace = THREE.SRGBColorSpace;
    sharedTexture = tex;
    pendingCallbacks.forEach(cb => cb(tex));
    pendingCallbacks.length = 0;
  };
  texLoader.load('bill_20.webp?v=1', onSuccess, undefined, () => {
    texLoader.load('bill_20.png?v=1', onSuccess, undefined, err => {
      console.warn('[bill3D] texture load failed', err);
    });
  });
}

function withTexture(cb) {
  if (sharedTexture) cb(sharedTexture);
  else { pendingCallbacks.push(cb); loadTexture(); }
}

window.__bill3DResizeAll = () => bill3DInstances.forEach(i => i.resize && i.resize());

export function initBill3D(canvas, opts = {}) {
  if (!canvas || canvas.dataset.bill3dInit === '1') return;
  canvas.dataset.bill3dInit = '1';
  const wrap = canvas.parentElement;
  const grayscale = !!opts.grayscale;
  const idleRot = opts.idleRot != null ? opts.idleRot : -0.2;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({canvas, antialias:true, alpha:true, powerPreference:'low-power'});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  } catch (e) {
    wrap.style.backgroundImage = 'url(bill_20.webp?v=1), url(bill_20.png?v=1)';
    wrap.style.backgroundSize = 'contain';
    wrap.style.backgroundRepeat = 'no-repeat';
    wrap.style.backgroundPosition = 'center';
    canvas.style.display = 'none';
    return;
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 0, 4.2);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const keyLight = new THREE.DirectionalLight(grayscale ? 0xcccccc : 0xfde88a, 1.2);
  keyLight.position.set(3, 4, 5); scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(grayscale ? 0x999999 : 0x7dd3fc, 0.7);
  rimLight.position.set(-3, -2, 2); scene.add(rimLight);
  const fillLight = new THREE.PointLight(grayscale ? 0xaaaaaa : 0xa78bfa, 0.5, 10);
  fillLight.position.set(0, 0, 3); scene.add(fillLight);

  let bill = null, isVisible = false, rafId = null;
  let t = Math.random()*10, mx=0, my=0, tmx=0, tmy=0;
  const ctrl = new AbortController();

  withTexture(tex => {
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const geo = new THREE.PlaneGeometry(3.0, 1.6);
    const matOpts = { map: tex, metalness: 0.25, roughness: 0.5, side: THREE.DoubleSide };
    if (grayscale) matOpts.color = new THREE.Color(0x888888);
    else { matOpts.emissive = new THREE.Color(0x1a2a4a); matOpts.emissiveIntensity = 0.05; }
    const mat = new THREE.MeshStandardMaterial(matOpts);
    bill = new THREE.Mesh(geo, mat); scene.add(bill);
    const backMat = new THREE.MeshStandardMaterial({
      color: grayscale ? 0x555555 : 0x4a6a8a, metalness: 0.4, roughness: 0.5, side: THREE.DoubleSide,
    });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.6), backMat);
    back.position.z = -0.002; back.rotation.y = Math.PI; bill.add(back);
    bill.rotation.y = idleRot; bill.rotation.x = 0.08;
    renderer.render(scene, camera);
    if (isVisible && !reduceMotion) startLoop();
  });

  function onPointer(e) {
    if (!isVisible) return;
    const r = wrap.getBoundingClientRect();
    tmx = ((e.clientX - r.left)/r.width - 0.5) * 0.5;
    tmy = ((e.clientY - r.top)/r.height - 0.5) * 0.35;
  }
  function onOrient(e) {
    if (!isVisible || e.gamma == null || e.beta == null) return;
    tmx = Math.max(-0.5, Math.min(0.5, e.gamma/45*0.5));
    tmy = Math.max(-0.35, Math.min(0.35, e.beta/90*0.35));
  }

  function animate() {
    rafId = requestAnimationFrame(animate);
    t += 0.01;
    mx += (tmx-mx)*0.08; my += (tmy-my)*0.08;
    if (bill) {
      bill.rotation.y = idleRot + Math.sin(t*0.4)*0.18 + mx;
      bill.rotation.x = 0.08 + Math.cos(t*0.3)*0.05 - my;
      bill.rotation.z = Math.sin(t*0.25)*0.025;
      bill.position.y = Math.sin(t*0.5)*0.05;
      keyLight.position.x = Math.sin(t*0.4)*4;
      keyLight.position.y = 3 + Math.cos(t*0.3)*1.5;
    }
    renderer.render(scene, camera);
  }
  function startLoop() {
    if (rafId != null) return;
    if (reduceMotion) { if (bill) renderer.render(scene, camera); return; }
    window.addEventListener('pointermove', onPointer, {signal: ctrl.signal});
    window.addEventListener('deviceorientation', onOrient, {signal: ctrl.signal});
    animate();
  }
  function stopLoop() {
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function resize() {
    const r = wrap.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      renderer.setSize(r.width, r.height, false);
      camera.aspect = r.width/r.height;
      camera.updateProjectionMatrix();
      if (bill && rafId == null) renderer.render(scene, camera);
    }
  }
  resize();
  setTimeout(resize, 100); setTimeout(resize, 500); setTimeout(resize, 1500);
  window.addEventListener('resize', resize, {signal: ctrl.signal});
  new ResizeObserver(resize).observe(wrap);

  const io = new IntersectionObserver(entries => {
    entries.forEach(ent => {
      isVisible = ent.isIntersecting;
      if (isVisible) startLoop(); else stopLoop();
    });
  }, {threshold: 0.05});
  io.observe(wrap);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopLoop();
    else if (isVisible) startLoop();
  }, {signal: ctrl.signal});

  bill3DInstances.push({ resize });
}

export function initAllBills() {
  document.querySelectorAll('.bill-3d-canvas').forEach(c => {
    const grayscale = c.dataset.grayscale === '1';
    const idleRot = c.dataset.idleRot ? parseFloat(c.dataset.idleRot) : -0.2;
    initBill3D(c, { grayscale, idleRot });
  });
}

// === Analytics — Umami Cloud (cookieless, RGPD-friendly, opt-out) ===
// Remplir UMAMI_WEBSITE_ID après création du site sur cloud.umami.is
const UMAMI_WEBSITE_ID = '4789a3ad-b04e-4766-abee-91b1f1b41a0c';
const UMAMI_SRC = 'https://cloud.umami.is/script.js';
const CONSENT_KEY = 'tradegenius_analytics_consent';

export function loadAnalytics() {
  if (!UMAMI_WEBSITE_ID) return;
  if (localStorage.getItem(CONSENT_KEY) === 'refused') return;
  if (document.querySelector('script[data-website-id]')) return;
  const s = document.createElement('script');
  s.defer = true;
  s.src = UMAMI_SRC;
  s.setAttribute('data-website-id', UMAMI_WEBSITE_ID);
  document.head.appendChild(s);
}

export function injectConsentBanner() {
  if (!UMAMI_WEBSITE_ID) return;
  if (localStorage.getItem(CONSENT_KEY)) return;
  const banner = document.createElement('div');
  banner.id = 'tg-consent';
  banner.style.cssText = `
    position:fixed;bottom:12px;left:12px;right:12px;z-index:99999;
    background:rgba(10,10,12,0.95);backdrop-filter:blur(10px);
    -webkit-backdrop-filter:blur(10px);
    border:1px solid rgba(255,255,255,0.12);border-radius:12px;
    padding:10px 12px;display:flex;align-items:center;gap:10px;
    font-family:'Manrope',system-ui,sans-serif;font-size:12px;
    color:#b8b3ad;box-shadow:0 8px 32px rgba(0,0,0,0.5);
    max-width:480px;margin:0 auto;
  `;
  banner.innerHTML = `
    <span style="flex:1;line-height:1.4">📊 Stats anonymes <span style="color:#6a6864">·</span> pas de cookies</span>
    <button id="tg-consent-off" style="background:transparent;border:1px solid rgba(255,255,255,0.18);color:#bef264;font-size:11px;padding:5px 10px;border-radius:7px;cursor:pointer;font-weight:600;font-family:inherit;">Désactiver</button>
    <button id="tg-consent-ok" style="background:transparent;border:none;color:#6a6864;font-size:16px;cursor:pointer;padding:4px 6px;font-family:inherit;line-height:1;" aria-label="Fermer">×</button>
  `;
  document.body.appendChild(banner);
  document.getElementById('tg-consent-off').onclick = () => {
    localStorage.setItem(CONSENT_KEY, 'refused');
    banner.remove();
    document.querySelectorAll('script[data-website-id]').forEach(s => s.remove());
  };
  document.getElementById('tg-consent-ok').onclick = () => {
    localStorage.setItem(CONSENT_KEY, 'accepted');
    banner.remove();
  };
}

// Permet de réactiver depuis ailleurs (ex: bouton "Paramètres confidentialité")
export function resetConsent() {
  localStorage.removeItem(CONSENT_KEY);
  location.reload();
}

// === Glossaire flottant — tap sur [data-term] → popup définition ===
const GLOSSARY = {
  'action': "Part de propriété dans une entreprise cotée. Si l'entreprise va bien, l'action prend de la valeur.",
  'obligation': "Prêt à un État ou une entreprise. Tu touches des intérêts puis ton capital à échéance.",
  'dividende': "Part des bénéfices d'une entreprise versée aux actionnaires, généralement 1 à 4 fois par an.",
  'etf': "Panier d'actions ou obligations qui suit un indice (ex: S&P 500). Diversifié et peu cher.",
  'indice': "Moyenne pondérée d'un panier d'entreprises (ex: CAC 40 = 40 plus grosses françaises).",
  'capitalisation': "Valeur totale d'une entreprise en bourse = prix × nombre d'actions.",
  'volatilité': "Mesure des variations de prix. Forte = ça bouge beaucoup. Faible = stable.",
  'liquidité': "Facilité à acheter/vendre rapidement sans perdre sur le prix.",
  'spread': "Écart entre le prix d'achat (ask) et le prix de vente (bid).",
  'plus-value': "Gain réalisé entre achat et vente : (prix vente − prix achat) × quantité.",
  'stop-loss': "Ordre automatique qui vend si le prix descend à un seuil. Limite tes pertes.",
  'take-profit': "Ordre automatique qui vend si le prix monte à un seuil. Sécurise tes gains.",
  'bull market': "Marché haussier. Les prix montent durablement. Optimisme.",
  'bear market': "Marché baissier (≥ −20%). Les prix descendent durablement. Pessimisme.",
  'ipo': "Introduction en bourse. Première fois qu'une entreprise propose ses actions au public.",
  'p/e ratio': "Price/Earnings. Combien tu paies pour 1€ de bénéfice. Plus haut = plus cher.",
  'leverage': "Effet de levier. Trader avec plus que ton capital. Risque amplifié × N.",
  'short': "Parier sur la baisse. Tu vends ce que tu n'as pas, espérant racheter moins cher.",
  'long': "Parier sur la hausse. Position d'achat classique.",
  'fomo': "Fear Of Missing Out. Peur de rater une hausse → achat impulsif au plus haut.",
  'fud': "Fear, Uncertainty, Doubt. Peurs propagées qui font vendre dans la panique.",
  'chandelier': "Bougie sur un chart qui montre 4 infos sur une période : ouverture, clôture, plus haut, plus bas.",
  'tendance': "Direction générale du prix sur une période : haussière (↗), baissière (↘) ou latérale (→).",
  'support': "Niveau de prix où les acheteurs reviennent. Le prix rebondit souvent dessus.",
  'résistance': "Niveau de prix où les vendeurs reprennent la main. Le prix bute souvent dessus.",
  'volume': "Quantité d'actions échangées sur une période. Volume fort = mouvement crédible.",
  // v7.19 — Indicateurs techniques (utilisés massivement par les 5 IA)
  'rsi': "Relative Strength Index (0-100). Mesure la force/faiblesse récente. <30 = survendu (rebond probable), >70 = suracheté (correction probable).",
  'macd': "Moving Average Convergence Divergence. Différence entre 2 moyennes mobiles exponentielles. Histogramme positif = momentum haussier.",
  'adx': "Average Directional Index (0-100). Mesure la FORCE d'une tendance (peu importe le sens). >25 = tendance solide, <20 = sans direction claire.",
  'atr': "Average True Range. Mesure la volatilité moyenne en valeur absolue. Sert à calibrer les stops et take-profit proportionnellement.",
  'ichimoku': "Indicateur japonais multi-composants (nuage Kumo + lignes Tenkan/Kijun). Au-dessus du nuage bull + signal bull = tendance forte confirmée.",
  'bollinger': "Bandes de Bollinger : moyenne mobile ± 2 écarts-types. Bande basse = zone d'achat potentielle, bande haute = zone de vente.",
  'mfi': "Money Flow Index. Comme le RSI mais pondéré par le volume. Détecte les divergences smart money. <20 = entrée institutionnelle, >80 = distribution.",
  'obv': "On Balance Volume. Cumul des volumes positifs et négatifs. Confirme (ou contredit) la tendance du prix.",
  'r/r': "Ratio Risk/Reward. (Take-profit − Entrée) / (Entrée − Stop). 1:3 = je risque 1€ pour potentiellement gagner 3€.",
  'walk-forward': "Méthode de validation : on optimise sur les N premiers folds (entraînement IS) puis on mesure la perf sur les folds suivants (OOS, jamais vus). Évite l'overfit.",
  'slippage': "Différence entre le prix attendu et le prix réellement obtenu lors de l'exécution. Trade Genius modélise 0,4 % par trade (réaliste broker).",
  'vwap': "Volume Weighted Average Price. Prix moyen pondéré par le volume sur la journée. Référence des institutions.",
  'hull ma': "Hull Moving Average. Moyenne mobile rapide et lisse (moins de retard que SMA classique). Détecte les retournements.",
  'heikin ashi': "Bougies modifiées (formule moyenne) qui filtrent le bruit. Permet de visualiser les tendances plus clairement.",
  'sma200': "Simple Moving Average sur 200 périodes. Référence de la tendance long terme. Prix > SMA200 = bull séculaire.",
  'ema': "Exponential Moving Average. Moyenne mobile qui donne plus de poids aux prix récents (plus réactive que SMA).",
  'doji': "Bougie de doute (ouverture ≈ clôture). Signal de retournement potentiel si en bas d'un mouvement baissier.",
  'pattern a': "Pattern contrarian. RSI<25 + Bollinger basse + MACD<0. On achète la peur extrême. PF mesuré 3.42 sur 20 ans backtest.",
  'pattern b': "Pattern trend-follow correction. RSI>35 + ADX≥25 + Bollinger mid + MACD<0. On achète la correction d'une tendance forte.",
  'pattern c': "Pattern pullback Ichimoku bull. RSI>35 + Bollinger basse + Ichimoku above-cloud. PF OOS 5.65.",
  'pattern d': "Pattern VOLT scalp contrarian. Même logique que Pattern A mais sur univers volatil (cryptos mid-cap + actions high-beta).",
  'quality score': "Score 0-100 calculé par l'IA pour chaque setup. Base par pattern + bonus régime + ADX + R/R + OBV. Détermine le sizing recommandé (3-5 % du capital).",
  'drawdown': "Perte maximale entre un pic et un creux (DD). Mesure le risque max ressenti. Trade Genius vise DD < 5 % sur 6 folds.",
  'profit factor': "PF = gains bruts / pertes brutes. >1.5 = stratégie rentable, >2 = très bonne, >3 = exceptionnelle. Toutes nos IA ont PF > 1.5 stress.",
  'win rate': "WR = % de trades gagnants. Trade Genius : 30-40 % en moyenne, mais compensé par R/R favorable (un gagnant vaut 3+ perdants).",
  'backtest': "Simulation rétroactive d'une stratégie sur historique passé. Mesure perf théorique. Trade Genius : backtests 600-1500j avec slippage modélisé.",
  'stacking': "Quand plusieurs patterns (A+B+C) détectent simultanément sur le même actif. Bonus quality_score (rare et statistiquement puissant).",
  'kill switch': "Garde-fou VOLT : si drawdown intra-période ≤ -5 %, l'IA pause 7 jours pour préserver le capital.",
  'kelly': "Kelly-light streak : multiplicateur de sizing (×1.2 après 3 gains consécutifs, ×0.7 après 3 pertes) pour adapter dynamiquement le risque.",
  'is/oos': "In-Sample / Out-of-Sample. Découpage temporel pour anti-overfit : on entraîne sur les premiers folds (IS), on valide sur les derniers (OOS) jamais vus pendant l'optimisation.",
};

function ensureGlossaryStyle() {
  if (document.getElementById('tg-glossary-style')) return;
  const s = document.createElement('style');
  s.id = 'tg-glossary-style';
  s.textContent = `
    [data-term] { border-bottom: 1px dashed currentColor; cursor: pointer; transition: opacity 0.15s; }
    [data-term]:hover { opacity: 0.75; }
    [data-term]:active { opacity: 0.55; }
    .tg-gloss-modal { position: fixed; inset: 0; z-index: 99998; background: rgba(0,0,0,0.7); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; padding: 16px; opacity: 0; pointer-events: none; transition: opacity 0.2s; }
    .tg-gloss-modal.active { opacity: 1; pointer-events: auto; }
    .tg-gloss-card { background: linear-gradient(180deg, #16161c, #0c0c10); border: 1px solid rgba(125,211,252,0.3); border-radius: 14px; padding: 20px 18px 18px; max-width: 380px; width: 100%; box-shadow: 0 12px 40px rgba(0,0,0,0.6), 0 0 24px rgba(125,211,252,0.15); transform: translateY(20px); transition: transform 0.25s cubic-bezier(0.2,0.8,0.2,1); }
    .tg-gloss-modal.active .tg-gloss-card { transform: translateY(0); }
    .tg-gloss-eyebrow { font-family: 'JetBrains Mono', monospace; font-size: 9px; font-weight: 700; color: #7dd3fc; letter-spacing: 0.18em; text-transform: uppercase; margin-bottom: 6px; }
    .tg-gloss-term { font-family: 'Bricolage Grotesque', serif; font-size: 22px; font-weight: 800; color: #f5f3ef; letter-spacing: -0.02em; margin-bottom: 10px; text-transform: capitalize; }
    .tg-gloss-def { font-family: 'Manrope', sans-serif; font-size: 14px; line-height: 1.5; color: #b8b3ad; }
    .tg-gloss-close { margin-top: 14px; width: 100%; background: rgba(125,211,252,0.12); border: 1px solid rgba(125,211,252,0.25); color: #7dd3fc; font-family: 'Manrope', sans-serif; font-size: 13px; font-weight: 700; padding: 9px; border-radius: 9px; cursor: pointer; letter-spacing: 0.04em; }
    .tg-gloss-close:active { background: rgba(125,211,252,0.18); }
  `;
  document.head.appendChild(s);
}

function openGlossaryPopup(term) {
  const key = (term || '').toLowerCase().trim();
  const def = GLOSSARY[key];
  if (!def) return;
  let modal = document.getElementById('tg-gloss-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'tg-gloss-modal';
    modal.className = 'tg-gloss-modal';
    modal.innerHTML = `
      <div class="tg-gloss-card">
        <div class="tg-gloss-eyebrow">📖 Glossaire</div>
        <div class="tg-gloss-term"></div>
        <div class="tg-gloss-def"></div>
        <button class="tg-gloss-close">Compris ✓</button>
      </div>
    `;
    document.body.appendChild(modal);
    const close = () => modal.classList.remove('active');
    modal.querySelector('.tg-gloss-close').onclick = close;
    modal.onclick = (e) => { if (e.target === modal) close(); };
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('active')) close();
    });
  }
  modal.querySelector('.tg-gloss-term').textContent = term;
  modal.querySelector('.tg-gloss-def').textContent = def;
  modal.classList.add('active');
  if (navigator.vibrate) navigator.vibrate(8);
}

export function initGlossary() {
  ensureGlossaryStyle();
  document.body.addEventListener('click', (e) => {
    const el = e.target.closest('[data-term]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    openGlossaryPopup(el.dataset.term || el.textContent);
  });
}

export function addGlossaryTerm(term, definition) {
  GLOSSARY[term.toLowerCase().trim()] = definition;
}

export function getGlossary() {
  return { ...GLOSSARY };
}

// === Freemium — détection user premium ===
export function isPremium() {
  try { return localStorage.getItem('tradegenius_premium') === '1'; } catch { return false; }
}
export function setPremium(v) {
  try { localStorage.setItem('tradegenius_premium', v ? '1' : '0'); } catch {}
}

// === Recap fin de chapitre (Duolingo-style) ===
function ensureRecapStyle() {
  if (document.getElementById('tg-recap-style')) return;
  const s = document.createElement('style');
  s.id = 'tg-recap-style';
  s.textContent = `
    .tg-recap-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.82); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); display: flex; align-items: center; justify-content: center; padding: 18px; z-index: 250; opacity: 0; pointer-events: none; transition: opacity 0.32s; }
    .tg-recap-overlay.active { opacity: 1; pointer-events: auto; }
    .tg-recap-card { background: linear-gradient(180deg, #16161c, #0c0c10); border: 1px solid rgba(190,242,100,0.32); border-radius: 22px; padding: 26px 22px 22px; max-width: 440px; width: 100%; box-shadow: 0 16px 60px rgba(0,0,0,0.7), 0 0 50px rgba(190,242,100,0.18), inset 0 1px 0 rgba(190,242,100,0.08); transform: translateY(36px) scale(0.94); transition: transform 0.42s cubic-bezier(0.2, 0.8, 0.2, 1); max-height: 88vh; overflow-y: auto; text-align: center; position: relative; }
    .tg-recap-overlay.active .tg-recap-card { transform: translateY(0) scale(1); }
    .tg-recap-card::before { content: ''; position: absolute; top: -1px; left: 50%; transform: translateX(-50%); width: 60%; height: 1px; background: linear-gradient(90deg, transparent, #bef264, transparent); opacity: 0.8; }
    .tg-recap-check { width: 58px; height: 58px; margin: 0 auto 14px; background: linear-gradient(135deg, #bef264, #d9f99d); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 30px; color: #0a0a0c; box-shadow: 0 0 0 8px rgba(190,242,100,0.14), 0 6px 22px rgba(190,242,100,0.45); transform: scale(0); animation: recapCheckIn 0.55s cubic-bezier(0.34, 1.56, 0.64, 1) 0.12s forwards; }
    @keyframes recapCheckIn { 0% { transform: scale(0) rotate(-90deg); } 70% { transform: scale(1.12) rotate(8deg); } 100% { transform: scale(1) rotate(0); } }
    .tg-recap-eyebrow { font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 800; letter-spacing: 0.22em; color: #bef264; text-transform: uppercase; margin-bottom: 8px; }
    .tg-recap-title { font-family: 'Bricolage Grotesque', Georgia, serif; font-size: 26px; font-weight: 800; color: #f5f3ef; letter-spacing: -0.02em; line-height: 1.15; margin: 0 0 22px; }
    .tg-recap-points { list-style: none; padding: 0; margin: 0 0 22px; display: flex; flex-direction: column; gap: 10px; text-align: left; }
    .tg-recap-points li {
      display: grid; grid-template-columns: 32px 1fr; gap: 12px; align-items: center;
      font-family: 'Manrope', system-ui, sans-serif; font-size: 13.5px; color: #b8b3ad; line-height: 1.45;
      padding: 13px 14px;
      background: linear-gradient(135deg, rgba(190,242,100,0.07), rgba(190,242,100,0.01));
      border: 1px solid rgba(190,242,100,0.2);
      border-radius: 12px;
      opacity: 0; transform: translateX(-14px);
      animation: recapPointIn 0.44s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }
    .tg-recap-points li:nth-child(1) { animation-delay: 0.30s; }
    .tg-recap-points li:nth-child(2) { animation-delay: 0.42s; }
    .tg-recap-points li:nth-child(3) { animation-delay: 0.54s; }
    .tg-recap-points li:nth-child(4) { animation-delay: 0.66s; }
    @keyframes recapPointIn { from { opacity: 0; transform: translateX(-14px); } to { opacity: 1; transform: translateX(0); } }
    .tg-recap-points li .e { font-size: 22px; line-height: 1; text-align: center; }
    .tg-recap-points li .t strong { color: #f5f3ef; font-weight: 700; }
    .tg-recap-cta {
      width: 100%; background: linear-gradient(135deg, #bef264, #d9f99d); color: #0a0a0c;
      border: none; font-family: 'Bricolage Grotesque', Georgia, serif; font-size: 16px; font-weight: 800;
      letter-spacing: -0.005em; padding: 15px; border-radius: 13px; cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 10px;
      box-shadow: 0 6px 18px rgba(190,242,100,0.4), 0 0 24px rgba(190,242,100,0.2);
      transition: transform 0.15s, box-shadow 0.2s; opacity: 0;
      animation: recapPointIn 0.42s ease-out 0.85s forwards;
    }
    .tg-recap-cta:active { transform: scale(0.97); box-shadow: 0 3px 10px rgba(190,242,100,0.3); }
    @media (prefers-reduced-motion: reduce) {
      .tg-recap-check, .tg-recap-points li, .tg-recap-cta { animation: none; opacity: 1; transform: none; }
    }
  `;
  document.head.appendChild(s);
}

// === Confettis (célébration fin de module ou achievement) ===
function ensureConfettiStyle() {
  if (document.getElementById('tg-confetti-style')) return;
  const s = document.createElement('style');
  s.id = 'tg-confetti-style';
  s.textContent = `
    .tg-confetti-wrap { position: fixed; inset: 0; pointer-events: none; z-index: 99999; overflow: hidden; }
    .tg-confetti-piece { position: absolute; top: -20px; width: 9px; height: 14px; border-radius: 2px; opacity: 0; transform-origin: center; }
    @keyframes tgConfettiFall {
      0%   { opacity: 0; transform: translateY(-30px) translateX(0) rotate(0); }
      10%  { opacity: 1; }
      100% { opacity: 0.1; transform: translateY(110vh) translateX(var(--tg-drift)) rotate(var(--tg-rot)); }
    }
  `;
  document.head.appendChild(s);
}

export function launchConfetti({ count = 80, duration = 2200, colors = ['#bef264', '#d9f99d', '#fbbf24', '#a78bfa', '#7dd3fc'] } = {}) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  ensureConfettiStyle();
  const wrap = document.createElement('div');
  wrap.className = 'tg-confetti-wrap';
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'tg-confetti-piece';
    const c = colors[Math.floor(Math.random() * colors.length)];
    const left = Math.random() * 100;
    const delay = Math.random() * 0.3;
    const dur = 1.6 + Math.random() * 1.2;
    const rot = Math.random() * 720 - 360;
    const drift = (Math.random() - 0.5) * 200;
    p.style.cssText = `left:${left}%;background:${c};animation:tgConfettiFall ${dur}s cubic-bezier(0.4,0.6,0.5,1) ${delay}s forwards;--tg-rot:${rot}deg;--tg-drift:${drift}px;`;
    wrap.appendChild(p);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), duration + 600);
}

export function showRecap({ eyebrow = '✓ VALIDÉ', title = 'Ce que tu as appris', points = [], onContinue = null, confetti = false } = {}) {
  ensureRecapStyle();
  let overlay = document.getElementById('tg-recap-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'tg-recap-overlay';
    overlay.className = 'tg-recap-overlay';
    document.body.appendChild(overlay);
  }
  // Recrée le contenu à chaque show pour rejouer les animations CSS
  overlay.innerHTML = `
    <div class="tg-recap-card">
      <div class="tg-recap-check">${confetti ? '🏆' : '✓'}</div>
      <div class="tg-recap-eyebrow">${eyebrow}</div>
      <h2 class="tg-recap-title">${title}</h2>
      <ul class="tg-recap-points">
        ${points.map(p => `<li><span class="e">${p.e || '✓'}</span><span class="t">${p.t || ''}</span></li>`).join('')}
      </ul>
      <button class="tg-recap-cta" id="tg-recap-cta">
        <span>Continuer</span><span>→</span>
      </button>
    </div>
  `;
  document.getElementById('tg-recap-cta').onclick = () => {
    if (navigator.vibrate) navigator.vibrate(10);
    overlay.classList.remove('active');
    setTimeout(() => { if (typeof onContinue === 'function') onContinue(); }, 380);
  };
  overlay.classList.add('active');
  if (navigator.vibrate) navigator.vibrate(confetti ? [50, 80, 50, 80, 100] : [12, 60, 28]);
  if (confetti) {
    setTimeout(() => launchConfetti({ count: 130, duration: 2800 }), 250);
  }
}

// === Streak quotidien — tracking auto à chaque visite ===
const STREAK_KEY = 'tradegenius_streak';
export function recordVisit() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    let s = JSON.parse(localStorage.getItem(STREAK_KEY) || '{}');
    if (s.lastDate === today) return;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    s.count = (s.lastDate === yesterday) ? (s.count || 0) + 1 : 1;
    s.lastDate = today;
    localStorage.setItem(STREAK_KEY, JSON.stringify(s));
  } catch {}
}

// === Partage — génère un visuel 1080x1080 partageable (Web Share API ou download) ===
// Usage: TG.shareCard({ title: 'Chapitre 3 validé', stat: '3 / 7', quote: 'Pense long terme.' })
function wrapText(ctx, text, x, y, maxW, lineH) {
  const words = (text || '').split(' ');
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const test = line + words[i] + ' ';
    if (ctx.measureText(test).width > maxW && i > 0) {
      ctx.fillText(line.trim(), x, y);
      line = words[i] + ' ';
      y += lineH;
    } else line = test;
  }
  ctx.fillText(line.trim(), x, y);
  return y;
}

export async function shareCard({ title = 'Trade Genius', stat = '', quote = '' } = {}) {
  try { await document.fonts.ready; } catch {}
  const W = 1080, H = 1080;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  // Fond gradient
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0a0a0c'); bg.addColorStop(1, '#16161c');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  // Glow acid radial top-left
  const glow = ctx.createRadialGradient(220, 200, 0, 220, 200, 600);
  glow.addColorStop(0, 'rgba(190,242,100,0.18)'); glow.addColorStop(1, 'rgba(190,242,100,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

  // Top accent bar
  ctx.fillStyle = '#bef264';
  ctx.fillRect(0, 0, W, 8);

  // Logo monogramme T-chandelier + brand
  ctx.textAlign = 'left';
  ctx.fillStyle = '#bef264';
  // Scale viewBox 0..100 → 0..160 px à partir de (80, 100)
  const lx = 80, ly = 100, lw = 160;
  const sx = (n) => lx + (n / 100) * lw;
  const sy = (n) => ly + (n / 100) * lw;
  // Toit du T
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(sx(14), sy(20), sx(86) - sx(14), sy(30) - sy(20), 4) : ctx.rect(sx(14), sy(20), sx(86) - sx(14), sy(30) - sy(20));
  ctx.fill();
  // Mèche supérieure (opacity 0.85)
  ctx.globalAlpha = 0.85;
  ctx.fillRect(sx(48.5), sy(30), sx(51.5) - sx(48.5), sy(39) - sy(30));
  ctx.globalAlpha = 1;
  // Corps de la bougie
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(sx(40), sy(39), sx(60) - sx(40), sy(79) - sy(39), 4) : ctx.rect(sx(40), sy(39), sx(60) - sx(40), sy(79) - sy(39));
  ctx.fill();
  // Mèche inférieure
  ctx.globalAlpha = 0.85;
  ctx.fillRect(sx(48.5), sy(79), sx(51.5) - sx(48.5), sy(85) - sy(79));
  ctx.globalAlpha = 1;

  ctx.fillStyle = 'rgba(245,243,239,0.55)';
  ctx.font = '700 22px "JetBrains Mono", monospace';
  ctx.fillText('TRADE GENIUS', 80, 308);

  // Title (gros)
  ctx.fillStyle = '#f5f3ef';
  ctx.font = '800 78px "Bricolage Grotesque", Georgia, serif';
  let y = wrapText(ctx, title, 80, 480, W - 160, 92);

  // Stat (acid)
  if (stat) {
    ctx.fillStyle = '#bef264';
    ctx.font = '700 38px "Manrope", system-ui, sans-serif';
    ctx.fillText(stat, 80, y + 80);
  }

  // Quote
  if (quote) {
    ctx.fillStyle = 'rgba(184,179,173,0.9)';
    ctx.font = 'italic 30px "Manrope", system-ui, sans-serif';
    wrapText(ctx, '« ' + quote + ' »', 80, 870, W - 160, 42);
  }

  // Footer URL
  ctx.fillStyle = 'rgba(245,243,239,0.4)';
  ctx.font = '600 18px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.fillText('virtualvaultboy-pixel.github.io/Trade-Genius', W - 80, H - 60);

  const blob = await new Promise(r => c.toBlob(r, 'image/png', 0.95));
  if (!blob) return false;

  // Web Share API (Android natif, iOS 16+)
  const file = new File([blob], 'tradegenius.png', { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Trade Genius', text: title });
      return true;
    } catch (e) { /* user cancelled, fallback */ }
  }
  // Fallback: download
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'tradegenius-' + Date.now() + '.png';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return false;
}

// Expose API globalement pour usage hors module (scripts inline des HTML)
window.TG = Object.assign(window.TG || {}, {
  shareCard, addGlossaryTerm, getGlossary, isPremium, setPremium, recordVisit, resetConsent, showRecap, launchConfetti,
  getNotifState, requestNotifPermission, disableNotifs, checkStreakDangerNotify,
  getDailyChallenge, getDailyState, showDailyChallenge, showModuleQuiz,
  TG_VERSION,
});

// === Prefetch scenes critiques (perf navigation, après LCP) ===
export function prefetchScenes() {
  const run = () => setTimeout(() => {
    const v = TG_VERSION.replace(/^v/, '').replace(/\./g, '');
    const here = location.pathname.split('/').pop() || 'index.html';
    ['index.html', 'scene-01.html', 'scene-05.html', 'scene-06.html'].forEach(s => {
      if (here === s) return;
      if (document.querySelector(`link[rel="prefetch"][href*="${s}"]`)) return;
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = s + '?v=' + v;
      link.as = 'document';
      document.head.appendChild(link);
    });
  }, 2200);
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run, { once: true });
}

// === Défi du jour — quiz aléatoire ===
const DAILY_KEY = 'tradegenius_daily_challenge';
const DAILY_QUESTIONS = [
  { m: 0, q: 'Pourquoi un billet de 20€ a-t-il de la valeur ?',
    options: ['Il est garanti en or', 'Convention sociale, confiance dans l\'État', 'Décret européen 2012', 'Aucune valeur réelle'],
    correct: 1, explain: 'Depuis 1971, les monnaies sont fiat : leur valeur tient uniquement à la confiance collective.' },
  { m: 0, q: 'En quelle année Nixon décroche le dollar de l\'or ?',
    options: ['1944', '1971', '1989', '2008'], correct: 1,
    explain: '15 août 1971 : fin de l\'étalon-or. Toutes les monnaies deviennent fiat.' },
  { m: 0, q: 'Quels sont les 3 rôles d\'une monnaie ?',
    options: ['Acheter, voter, voyager', 'Échange, mesure de valeur, épargne', 'Spéculer, prêter, miner', 'Frapper, garder, brûler'],
    correct: 1, explain: 'Une monnaie = moyen d\'échange + unité de compte + réserve de valeur.' },
  { m: 0, q: 'Qui invente le billet de banque ?',
    options: ['Les Romains', 'La Chine (~700)', 'Napoléon', 'La FED en 1913'],
    correct: 1, explain: 'La Chine invente le billet vers l\'an 700, arrive en Europe au 17e siècle.' },
  { m: 1, q: 'Que représente une action ?',
    options: ['Un prêt à l\'entreprise', 'Une part de propriété', 'Un bon d\'achat', 'Un dividende'],
    correct: 1, explain: 'Acheter une action = devenir copropriétaire d\'une fraction de l\'entreprise.' },
  { m: 1, q: 'L\'obligation, c\'est :',
    options: ['Une part d\'entreprise', 'Un prêt à un État/entreprise', 'Un dérivé spéculatif', 'Une crypto'],
    correct: 1, explain: 'Tu prêtes ton argent, tu touches des intérêts puis le capital à échéance.' },
  { m: 1, q: 'Un ETF est :',
    options: ['Un fonds actif géré', 'Un panier d\'actifs qui suit un indice', 'Une action exotique', 'Un produit dérivé'],
    correct: 1, explain: 'ETF = panier diversifié (ex: S&P 500) avec des frais très bas (~0.1%/an).' },
  { m: 1, q: 'Bull market signifie :',
    options: ['Marché qui descend', 'Marché qui monte durablement', 'Krach', 'Volatilité extrême'],
    correct: 1, explain: 'Bull = taureau qui frappe vers le haut. Bear = ours qui frappe vers le bas.' },
  { m: 1, q: 'Le spread c\'est :',
    options: ['La taxe sur les trades', 'L\'écart bid/ask', 'La commission du courtier', 'Le levier max'],
    correct: 1, explain: 'Spread = différence entre prix d\'achat (ask) et prix de vente (bid). Faible = liquide.' },
  { m: 2, q: 'Combien de prix sont représentés dans un chandelier ?',
    options: ['1 (la clôture)', '2 (ouverture, clôture)', '4 (open, high, low, close)', '6'],
    correct: 2, explain: 'OHLC : Open, High, Low, Close. Les mèches montrent high/low, le corps montre open→close.' },
  { m: 2, q: 'Une chandelle verte signifie :',
    options: ['Prix monte sur le moment', 'Clôture > ouverture', 'Achat massif', 'Tendance haussière'],
    correct: 1, explain: 'Vert = clôture supérieure à ouverture. Acheteurs ont gagné sur cette période.' },
  { m: 2, q: 'Un support est :',
    options: ['Un plafond de prix', 'Un plancher où le prix rebondit', 'Une moyenne mobile', 'Un indicateur'],
    correct: 1, explain: 'Support = niveau où les acheteurs reviennent. Cassé, il devient résistance.' },
  { m: 2, q: 'Volume fort + mouvement signifie :',
    options: ['Mouvement crédible', 'Manipulation', 'Bull trap', 'Indifférent'],
    correct: 0, explain: 'Volume confirme. Mouvement avec volume faible = méfiance, mouvement fragile.' },
  { m: 3, q: 'Quel % de traders particuliers perdent à long terme ?',
    options: ['~30%', '~50%', '~70%', '~95%'], correct: 3,
    explain: 'Environ 95% des traders actifs perdent ou sous-performent un simple ETF World.' },
  { m: 3, q: 'FOMO veut dire :',
    options: ['Fund Of Money Only', 'Fear Of Missing Out', 'Forex Online', 'Free Open Market'],
    correct: 1, explain: 'FOMO = peur de rater. Pousse à acheter au sommet, juste avant le retournement.' },
  { m: 3, q: 'La règle des 2% c\'est :',
    options: ['Frais max courtier', 'Risque max par trade', 'Levier max', 'Diversification'],
    correct: 1, explain: 'Ne perdre jamais plus de 2% du capital sur un trade unique. Garantit la survie.' },
  { m: 3, q: 'Selon Kahneman, le Système 1 c\'est :',
    options: ['Pensée rationnelle, lente', 'Pensée rapide, instinctive', 'Système informatique', 'Algorithme trading'],
    correct: 1, explain: 'Système 1 = rapide et émotionnel (l\'ennemi). Système 2 = lent et rationnel (à activer).' },
  { m: 3, q: 'Le stop-loss sert à :',
    options: ['Augmenter le levier', 'Limiter automatiquement les pertes', 'Acheter plus bas', 'Bloquer le compte'],
    correct: 1, explain: 'Ordre auto qui vend quand le prix descend à un seuil. Indispensable.' },
  // === Module 4 — Étude des courbes ===
  { m: 4, q: 'Le pattern engulfing haussier signale :',
    options: ['Une continuation baissière', 'Un retournement à la hausse', 'Une indécision', 'Une volatilité forte'],
    correct: 1, explain: 'Une bougie verte qui avale une rouge précédente = acheteurs reprennent le contrôle.' },
  { m: 4, q: 'Un RSI > 70 indique :',
    options: ['Survente', 'Surachat possible', 'Tendance forte', 'Sortie de range'],
    correct: 1, explain: 'RSI > 70 = surachat probable, le marché peut corriger. Pas un signal de vente automatique.' },
  { m: 4, q: 'Le niveau Fibonacci le plus respecté est :',
    options: ['23.6%', '38.2%', '50%', '61.8%'],
    correct: 3, explain: 'Le golden ratio 61.8% est le niveau de retracement le plus suivi par les traders.' },
  { m: 4, q: 'Le MACD croisement haussier c\'est :',
    options: ['MACD sous le signal', 'MACD passe au-dessus du signal', 'Histogramme à 0', 'RSI > 70'],
    correct: 1, explain: 'Quand la MACD line croise au-dessus de la signal line = momentum haussier confirmé.' },
  { m: 4, q: 'Un Bollinger squeeze c\'est :',
    options: ['Bandes qui s\'écartent', 'Bandes qui se resserrent', 'Cassure de la moyenne', 'Volume à zéro'],
    correct: 1, explain: 'Les bandes qui se resserrent annoncent une explosion de volatilité imminente.' },
  { m: 4, q: 'Le POC (Point of Control) c\'est :',
    options: ['Le prix actuel', 'Prix où le plus de volume s\'est échangé', 'La moyenne mobile 200', 'Le niveau Fibo 50%'],
    correct: 1, explain: 'POC = prix où le plus gros volume s\'est échangé. Aimant à prix dans le futur.' },
  { m: 4, q: 'Un Sharpe ratio acceptable est :',
    options: ['< 0', 'Entre 0 et 0.5', '> 1', 'Peu importe'],
    correct: 2, explain: 'Sharpe > 1 = stratégie correcte. Sharpe > 2 = excellente performance ajustée du risque.' },
  { m: 4, q: 'L\'overfitting en backtesting c\'est :',
    options: ['Trop de trades', 'Stratégie trop optimisée sur le passé', 'Levier trop élevé', 'Frais trop importants'],
    correct: 1, explain: 'Une stratégie ultra-optimisée pour les données passées échoue souvent en réel.' },
];

function _todayKey() { return new Date().toISOString().slice(0, 10); }
function _dayOfYear() {
  const n = new Date();
  return Math.floor((n - new Date(n.getFullYear(), 0, 0)) / 86400000);
}

export function getDailyChallenge() {
  const idx = _dayOfYear() % DAILY_QUESTIONS.length;
  return { ...DAILY_QUESTIONS[idx], index: idx };
}

export function getDailyState() {
  try {
    const s = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}');
    if (s.date === _todayKey()) return s;
  } catch {}
  return null;
}

function ensureDailyStyle() {
  if (document.getElementById('tg-daily-style')) return;
  const s = document.createElement('style');
  s.id = 'tg-daily-style';
  s.textContent = `
    .tg-daily-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.82); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); display: flex; align-items: center; justify-content: center; padding: 18px; z-index: 9990; opacity: 0; pointer-events: none; transition: opacity 0.3s; }
    .tg-daily-overlay.active { opacity: 1; pointer-events: auto; }
    .tg-daily-card { background: linear-gradient(180deg, #16161c, #0c0c10); border: 1px solid rgba(212,165,116,0.32); border-radius: 18px; padding: 22px 20px 18px; max-width: 440px; width: 100%; max-height: 88vh; overflow-y: auto; box-shadow: 0 16px 60px rgba(0,0,0,0.7), 0 0 32px rgba(212,165,116,0.18); transform: translateY(28px) scale(0.97); transition: transform 0.38s cubic-bezier(0.2,0.8,0.2,1); }
    .tg-daily-overlay.active .tg-daily-card { transform: translateY(0) scale(1); }
    .tg-daily-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
    .tg-daily-eyebrow { font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 800; letter-spacing: 0.18em; color: #d4a574; text-transform: uppercase; }
    .tg-daily-close { width: 30px; height: 30px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); color: #b8b3ad; border-radius: 50%; font-size: 14px; cursor: pointer; }
    .tg-daily-q { font-family: 'Bricolage Grotesque', Georgia, serif; font-size: 19px; font-weight: 800; color: #f5f3ef; letter-spacing: -0.01em; line-height: 1.25; margin: 0 0 18px; }
    .tg-daily-opts { display: flex; flex-direction: column; gap: 9px; margin: 0 0 16px; }
    .tg-daily-opt { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); color: #f5f3ef; font-family: 'Manrope', system-ui, sans-serif; font-size: 14px; font-weight: 600; text-align: left; padding: 13px 14px; border-radius: 11px; cursor: pointer; transition: all 0.18s; line-height: 1.35; -webkit-tap-highlight-color: transparent; }
    .tg-daily-opt:active { transform: scale(0.98); background: rgba(255,255,255,0.08); }
    .tg-daily-opt:disabled { cursor: not-allowed; }
    .tg-daily-opt.correct { background: rgba(74,222,128,0.16); border-color: #4ade80; color: #86efac; font-weight: 700; }
    .tg-daily-opt.wrong { background: rgba(248,113,113,0.16); border-color: #f87171; color: #fca5a5; }
    .tg-daily-explain { background: rgba(212,165,116,0.08); border-left: 3px solid #d4a574; border-radius: 8px; padding: 12px 14px; font-family: 'Manrope', system-ui, sans-serif; font-size: 13.5px; line-height: 1.45; color: #b8b3ad; margin: 0 0 16px; display: none; }
    .tg-daily-explain.show { display: block; animation: dailyFadeIn 0.3s ease-out; }
    .tg-daily-explain strong { color: #f5f3ef; }
    @keyframes dailyFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    .tg-daily-result-pill { display: inline-block; padding: 4px 10px; border-radius: 999px; font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; }
    .tg-daily-result-pill.ok { background: rgba(74,222,128,0.18); color: #86efac; }
    .tg-daily-result-pill.ko { background: rgba(248,113,113,0.18); color: #fca5a5; }
    .tg-daily-cta { display: block; width: 100%; background: linear-gradient(135deg, #d4a574, #e8c39a); color: #1a1a0a; border: none; font-family: 'Bricolage Grotesque', Georgia, serif; font-size: 14px; font-weight: 800; padding: 12px; border-radius: 11px; cursor: pointer; box-shadow: 0 4px 14px rgba(212,165,116,0.35); display: none; }
    .tg-daily-cta.show { display: block; }
    .tg-daily-cta:active { transform: scale(0.97); }
  `;
  document.head.appendChild(s);
}

export function showDailyChallenge() {
  ensureDailyStyle();
  const ch = getDailyChallenge();
  const prev = getDailyState();
  let overlay = document.getElementById('tg-daily-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'tg-daily-overlay';
    overlay.className = 'tg-daily-overlay';
    document.body.appendChild(overlay);
  }
  const moduleNames = ['Monnaie', 'Marché', 'Chart', 'Psycho'];
  overlay.innerHTML = `
    <div class="tg-daily-card">
      <div class="tg-daily-head">
        <span class="tg-daily-eyebrow">🎯 Défi du jour · M${ch.m} ${moduleNames[ch.m]}</span>
        <button class="tg-daily-close" id="tg-daily-close" aria-label="Fermer">✕</button>
      </div>
      <h3 class="tg-daily-q">${ch.q}</h3>
      <div class="tg-daily-opts" id="tg-daily-opts">
        ${ch.options.map((opt, i) => `<button class="tg-daily-opt" data-i="${i}">${opt}</button>`).join('')}
      </div>
      <div class="tg-daily-explain" id="tg-daily-explain"></div>
      <button class="tg-daily-cta" id="tg-daily-cta">Continuer →</button>
    </div>
  `;
  const close = () => overlay.classList.remove('active');
  document.getElementById('tg-daily-close').onclick = close;
  document.getElementById('tg-daily-cta').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const optBtns = overlay.querySelectorAll('.tg-daily-opt');
  const explainEl = document.getElementById('tg-daily-explain');
  const ctaEl = document.getElementById('tg-daily-cta');

  const reveal = (choice) => {
    optBtns.forEach((btn, i) => {
      btn.disabled = true;
      if (i === ch.correct) btn.classList.add('correct');
      else if (i === choice) btn.classList.add('wrong');
    });
    const isCorrect = choice === ch.correct;
    explainEl.innerHTML = `<span class="tg-daily-result-pill ${isCorrect ? 'ok' : 'ko'}">${isCorrect ? '✓ Bonne réponse' : '✗ Faux'}</span><br><br>${ch.explain}`;
    explainEl.classList.add('show');
    ctaEl.classList.add('show');
    if (navigator.vibrate) navigator.vibrate(isCorrect ? [12, 60, 28] : [60, 40, 60]);
  };

  if (prev) {
    // Déjà répondu : montrer le résultat
    reveal(prev.choice);
  } else {
    optBtns.forEach(btn => {
      btn.onclick = () => {
        const choice = parseInt(btn.dataset.i, 10);
        const isCorrect = choice === ch.correct;
        try { localStorage.setItem(DAILY_KEY, JSON.stringify({ date: _todayKey(), choice, correct: isCorrect, ts: Date.now() })); } catch {}
        reveal(choice);
      };
    });
  }

  overlay.classList.add('active');
  if (navigator.vibrate) navigator.vibrate(8);
}

// === Quiz fin de module — 5 questions pour valider ===
function ensureModuleQuizStyle() {
  if (document.getElementById('tg-mq-style')) return;
  const s = document.createElement('style');
  s.id = 'tg-mq-style';
  s.textContent = `
    .tg-mq-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.84); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); display: flex; align-items: center; justify-content: center; padding: 18px; z-index: 260; opacity: 0; pointer-events: none; transition: opacity 0.32s; }
    .tg-mq-overlay.active { opacity: 1; pointer-events: auto; }
    .tg-mq-card { background: linear-gradient(180deg, #16161c, #0c0c10); border: 1px solid rgba(190,242,100,0.32); border-radius: 20px; padding: 22px 20px 20px; max-width: 440px; width: 100%; max-height: 90vh; overflow-y: auto; box-shadow: 0 16px 60px rgba(0,0,0,0.7), 0 0 40px rgba(190,242,100,0.16); transform: translateY(28px) scale(0.96); transition: transform 0.4s cubic-bezier(0.2,0.8,0.2,1); }
    .tg-mq-overlay.active .tg-mq-card { transform: translateY(0) scale(1); }
    .tg-mq-progress { margin-bottom: 18px; }
    .tg-mq-progress-bar { height: 5px; background: rgba(255,255,255,0.06); border-radius: 999px; overflow: hidden; margin-bottom: 8px; }
    .tg-mq-progress-fill { height: 100%; background: linear-gradient(90deg, #bef264, #d9f99d); border-radius: 999px; transition: width 0.5s cubic-bezier(0.2,0.8,0.2,1); }
    .tg-mq-progress-text { font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 700; letter-spacing: 0.14em; color: #bef264; text-transform: uppercase; }
    .tg-mq-q { font-family: 'Bricolage Grotesque', Georgia, serif; font-size: 19px; font-weight: 800; color: #f5f3ef; letter-spacing: -0.01em; line-height: 1.25; margin: 0 0 18px; }
    .tg-mq-opts { display: flex; flex-direction: column; gap: 9px; margin: 0 0 14px; }
    .tg-mq-opt { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); color: #f5f3ef; font-family: 'Manrope', system-ui, sans-serif; font-size: 14px; font-weight: 600; text-align: left; padding: 13px 14px; border-radius: 11px; cursor: pointer; transition: all 0.18s; line-height: 1.35; -webkit-tap-highlight-color: transparent; }
    .tg-mq-opt:active { transform: scale(0.98); background: rgba(255,255,255,0.08); }
    .tg-mq-opt:disabled { cursor: not-allowed; }
    .tg-mq-opt.correct { background: rgba(74,222,128,0.16); border-color: #4ade80; color: #86efac; font-weight: 700; }
    .tg-mq-opt.wrong { background: rgba(248,113,113,0.16); border-color: #f87171; color: #fca5a5; }
    .tg-mq-explain { background: rgba(190,242,100,0.06); border-left: 3px solid #bef264; border-radius: 8px; padding: 12px 14px; font-family: 'Manrope', system-ui, sans-serif; font-size: 13px; line-height: 1.45; color: #b8b3ad; margin: 0 0 14px; display: none; }
    .tg-mq-explain.show { display: block; animation: mqFadeIn 0.3s ease-out; }
    .tg-mq-explain strong { color: #f5f3ef; }
    @keyframes mqFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    .tg-mq-next, .tg-mq-cta { width: 100%; background: linear-gradient(135deg, #bef264, #d9f99d); color: #0a0a0c; border: none; font-family: 'Bricolage Grotesque', Georgia, serif; font-size: 15px; font-weight: 800; padding: 14px; border-radius: 12px; cursor: pointer; box-shadow: 0 4px 14px rgba(190,242,100,0.35); display: none; }
    .tg-mq-next.show, .tg-mq-cta { display: block; }
    .tg-mq-next:active, .tg-mq-cta:active { transform: scale(0.97); }
    /* Fin de quiz */
    .tg-mq-end { text-align: center; }
    .tg-mq-medal { font-size: 70px; margin-bottom: 10px; line-height: 1; animation: mqMedalIn 0.6s cubic-bezier(0.34,1.56,0.64,1); }
    @keyframes mqMedalIn { 0% { transform: scale(0) rotate(-180deg); } 60% { transform: scale(1.18) rotate(15deg); } 100% { transform: scale(1) rotate(0); } }
    .tg-mq-eyebrow { font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 800; letter-spacing: 0.22em; color: #bef264; text-transform: uppercase; margin-bottom: 6px; }
    .tg-mq-score { font-family: 'Bricolage Grotesque', Georgia, serif; font-size: 42px; font-weight: 800; color: #f5f3ef; letter-spacing: -0.03em; line-height: 1; margin: 0 0 6px; }
    .tg-mq-pct { font-family: 'Manrope', sans-serif; font-size: 13px; color: #b8b3ad; margin: 0 0 22px; }
  `;
  document.head.appendChild(s);
}

export function showModuleQuiz({ moduleId = 0, onComplete = null, total = 5 } = {}) {
  ensureModuleQuizStyle();
  const all = DAILY_QUESTIONS.filter(q => q.m === moduleId);
  const questions = all.slice(0, Math.min(total, all.length));
  if (questions.length === 0) {
    if (onComplete) onComplete({ score: 0, total: 0, pct: 0 });
    return;
  }
  let idx = 0, score = 0;
  let overlay = document.getElementById('tg-mq-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'tg-mq-overlay';
    overlay.className = 'tg-mq-overlay';
    document.body.appendChild(overlay);
  }

  function renderEnd() {
    const pct = (score / questions.length) * 100;
    let medal = '🥉', label = 'Bien essayé';
    if (pct >= 100)      { medal = '🏆'; label = 'Parfait'; }
    else if (pct >= 80)  { medal = '🥇'; label = 'Excellent'; }
    else if (pct >= 60)  { medal = '🥈'; label = 'Très bien'; }
    const key = `tradegenius_quiz_m${moduleId}_best`;
    const prevBest = parseInt(localStorage.getItem(key) || '0', 10);
    const newBest = Math.max(prevBest, score);
    try { localStorage.setItem(key, String(newBest)); } catch {}
    overlay.innerHTML = `
      <div class="tg-mq-card tg-mq-end">
        <div class="tg-mq-medal">${medal}</div>
        <div class="tg-mq-eyebrow">${label}</div>
        <h3 class="tg-mq-score">${score} / ${questions.length}</h3>
        <p class="tg-mq-pct">${Math.round(pct)}% de bonnes réponses${newBest > prevBest ? ' · 🎯 Nouveau record !' : ''}</p>
        <button class="tg-mq-cta" id="tg-mq-cta">Continuer →</button>
      </div>
    `;
    document.getElementById('tg-mq-cta').onclick = () => {
      if (navigator.vibrate) navigator.vibrate(10);
      overlay.classList.remove('active');
      setTimeout(() => { if (typeof onComplete === 'function') onComplete({ score, total: questions.length, pct }); }, 380);
    };
    if (pct >= 100) launchConfetti({ count: 90, duration: 2200 });
    if (navigator.vibrate) navigator.vibrate(pct >= 80 ? [40, 60, 40, 60, 80] : [20, 40, 20]);
  }

  function renderQ() {
    if (idx >= questions.length) { renderEnd(); return; }
    const ch = questions[idx];
    overlay.innerHTML = `
      <div class="tg-mq-card">
        <div class="tg-mq-progress">
          <div class="tg-mq-progress-bar"><div class="tg-mq-progress-fill" style="width:${((idx+1)/questions.length)*100}%"></div></div>
          <span class="tg-mq-progress-text">QUIZ · Question ${idx+1} / ${questions.length}</span>
        </div>
        <h3 class="tg-mq-q">${ch.q}</h3>
        <div class="tg-mq-opts" id="tg-mq-opts">
          ${ch.options.map((opt, i) => `<button class="tg-mq-opt" data-i="${i}">${opt}</button>`).join('')}
        </div>
        <div class="tg-mq-explain" id="tg-mq-explain"></div>
        <button class="tg-mq-next" id="tg-mq-next">Question suivante →</button>
      </div>
    `;
    const explainEl = document.getElementById('tg-mq-explain');
    const nextEl = document.getElementById('tg-mq-next');
    overlay.querySelectorAll('.tg-mq-opt').forEach(btn => {
      btn.onclick = () => {
        const choice = parseInt(btn.dataset.i, 10);
        const isCorrect = choice === ch.correct;
        if (isCorrect) score++;
        overlay.querySelectorAll('.tg-mq-opt').forEach((b, i) => {
          b.disabled = true;
          if (i === ch.correct) b.classList.add('correct');
          else if (i === choice) b.classList.add('wrong');
        });
        explainEl.innerHTML = `<strong>${isCorrect ? '✓ Bonne réponse.' : '✗ Faux.'}</strong> ${ch.explain}`;
        explainEl.classList.add('show');
        nextEl.classList.add('show');
        nextEl.textContent = (idx + 1 >= questions.length) ? 'Voir le score →' : 'Question suivante →';
        if (navigator.vibrate) navigator.vibrate(isCorrect ? [12, 40, 18] : [40, 40, 40]);
      };
    });
    nextEl.onclick = () => { idx++; renderQ(); };
  }

  overlay.classList.add('active');
  renderQ();
}

// === Notifications quotidiennes — rappel streak ===
const NOTIF_CONSENT_KEY = 'tradegenius_notif_consent';
const NOTIF_LAST_KEY = 'tradegenius_last_notif';

export function getNotifState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission; // 'granted' | 'denied' | 'default'
}

export async function requestNotifPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    const r = await Notification.requestPermission();
    if (r === 'granted') {
      localStorage.setItem(NOTIF_CONSENT_KEY, '1');
      // Notif de confirmation
      new Notification('🔔 Rappels activés', {
        body: 'On te rappellera si ton streak est en danger.',
        icon: 'icon-512.png',
        tag: 'tg-welcome',
      });
    }
    return r;
  } catch { return 'denied'; }
}

export function disableNotifs() {
  localStorage.removeItem(NOTIF_CONSENT_KEY);
}

function _streakInDanger() {
  try {
    const s = JSON.parse(localStorage.getItem('tradegenius_streak') || '{}');
    if (!s.lastDate || !s.count || s.count < 2) return false;
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    return s.lastDate === yesterday; // visité hier mais pas encore aujourd'hui
  } catch { return false; }
}

export function checkStreakDangerNotify() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if (localStorage.getItem(NOTIF_CONSENT_KEY) !== '1') return;
  if (!_streakInDanger()) return;
  const today = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem(NOTIF_LAST_KEY) === today) return; // déjà notifié aujourd'hui
  try {
    const s = JSON.parse(localStorage.getItem('tradegenius_streak') || '{}');
    new Notification('🔥 Ton streak est en danger !', {
      body: `Tu en es à ${s.count} jours d'affilée. 1 chapitre = 5 min — ne le casse pas.`,
      icon: 'icon-512.png',
      badge: 'icon-192.png',
      tag: 'streak-danger',
      requireInteraction: false,
    });
    localStorage.setItem(NOTIF_LAST_KEY, today);
  } catch {}
}

// Auto-init au load
function autoInit() {
  injectVersionBadge();
  initAllBills();
  loadAnalytics();
  injectConsentBanner();
  recordVisit();
  initGlossary();
  prefetchScenes();
  checkStreakDangerNotify();
  // v2.63 — Vérifie les badges au chargement de chaque page
  setTimeout(() => { try { checkBadges(); } catch {} }, 1200);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoInit);
else autoInit();

/* ═══════════════════════════════════════════════════════════════════
   v2.57 — Module CURRENCY (sélecteur global de devise)
   ═══════════════════════════════════════════════════════════════════
   Permet à l'utilisateur de choisir la devise d'affichage globale :
   - 'native' (default) : chaque actif dans sa devise naturelle (USD pour
     crypto/indices US/actions US, EUR pour indices EU)
   - 'USD' : tout converti en dollars
   - 'EUR' : tout converti en euros

   Le taux EUR/USD est récupéré depuis frankfurter.app (source ECB,
   gratuit illimité sans clé). Cache local 1h.

   Émission d'événement 'tg-currency-change' à chaque modification.
   ═══════════════════════════════════════════════════════════════════ */

const CURRENCY_PREF_KEY = 'tg_pref_currency';
const FX_CACHE_KEY = 'tg_fx_rates';
// v2.58 — Cache court 15 min (au lieu de 1h) pour suivre les fluctuations FX
const FX_CACHE_TTL = 15 * 60 * 1000;

// v2.58 — Invalidation immédiate des anciens caches "fallback" 0.92 (taux 2024
// hardcoded qui était devenu obsolète et donnait un écart de ~7% en 2026).
try {
  const _c = JSON.parse(localStorage.getItem(FX_CACHE_KEY));
  if (_c && _c.fallback) localStorage.removeItem(FX_CACHE_KEY);
} catch {}

function getCurrencyPref() {
  try { return localStorage.getItem(CURRENCY_PREF_KEY) || 'native'; }
  catch { return 'native'; }
}
function setCurrencyPref(val) {
  if (!['native', 'USD', 'EUR'].includes(val)) val = 'native';
  try { localStorage.setItem(CURRENCY_PREF_KEY, val); } catch {}
  // Trigger un événement custom que les rendus peuvent écouter pour re-render
  window.dispatchEvent(new CustomEvent('tg-currency-change', { detail: { pref: val } }));
}

// v2.58 — Récupère le taux EUR/USD avec 2 sources de secours.
// Ordre : 1) Frankfurter (ECB officiel) → 2) Yahoo EURUSD=X via corsproxy
//         → 3) Dernier cache même périmé → 4) Fallback raisonnable
async function getExchangeRates() {
  // 1) Cache frais
  try {
    const c = JSON.parse(localStorage.getItem(FX_CACHE_KEY));
    if (c && c.ts && (Date.now() - c.ts < FX_CACHE_TTL) && c.USD_EUR && !c.fallback) return c;
  } catch {}
  // 2) Frankfurter (BCE)
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=USD&to=EUR');
    if (r.ok) {
      const j = await r.json();
      const usdEur = j && j.rates && j.rates.EUR;
      if (usdEur && usdEur > 0.3 && usdEur < 3) {
        const data = { ts: Date.now(), USD_EUR: usdEur, EUR_USD: 1 / usdEur, source: 'frankfurter' };
        try { localStorage.setItem(FX_CACHE_KEY, JSON.stringify(data)); } catch {}
        return data;
      }
    }
  } catch (e) { console.warn('FX frankfurter failed', e.message); }
  // 3) Yahoo via corsproxy (notre route déjà utilisée pour les indices)
  try {
    const u = 'https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=1d&range=5d';
    const r = await fetch('https://corsproxy.io/?' + encodeURIComponent(u));
    if (r.ok) {
      const j = await r.json();
      const eurUsd = j && j.chart && j.chart.result && j.chart.result[0]
        && j.chart.result[0].meta && j.chart.result[0].meta.regularMarketPrice;
      if (eurUsd && eurUsd > 0.5 && eurUsd < 3) {
        const data = { ts: Date.now(), USD_EUR: 1 / eurUsd, EUR_USD: eurUsd, source: 'yahoo' };
        try { localStorage.setItem(FX_CACHE_KEY, JSON.stringify(data)); } catch {}
        return data;
      }
    }
  } catch (e) { console.warn('FX yahoo failed', e.message); }
  // 4) Dernier cache même périmé (mieux que rien)
  try {
    const c = JSON.parse(localStorage.getItem(FX_CACHE_KEY));
    if (c && c.USD_EUR) return Object.assign({}, c, { stale: true });
  } catch {}
  // 5) Aucune source : retourne null pour qu'on N'AFFICHE PAS de prix faux
  console.warn('FX: toutes les sources ont échoué — pas de conversion possible');
  return null;
}

// Convertit une valeur de `from` (USD ou EUR) vers `to` en utilisant les rates en cache
function _convertSync(value, from, to, rates) {
  if (!value || !rates || from === to) return value;
  if (from === 'USD' && to === 'EUR') return value * rates.USD_EUR;
  if (from === 'EUR' && to === 'USD') return value * rates.EUR_USD;
  // Autres devises (GBP, JPY) : on garde tel quel par défaut
  return value;
}

// Lance un fetch FX au chargement (warm-up cache)
async function _warmFXCache() {
  await getExchangeRates();
}

// Détermine la devise d'affichage selon la pref + devise native d'un actif
// nativeCur : la devise naturelle de l'actif (USD, EUR, GBP, etc.)
// Retourne { display: 'USD'/'EUR', symbol: '$'/'€', convert: bool }
function resolveDisplayCurrency(nativeCur) {
  const pref = getCurrencyPref();
  const native = (nativeCur || 'USD').toUpperCase();
  if (pref === 'native') return { display: native, symbol: _currencySymbol(native), convert: false };
  return { display: pref, symbol: _currencySymbol(pref), convert: native !== pref };
}

function _currencySymbol(cur) {
  return { USD: '$', EUR: '€', GBP: '£', JPY: '¥' }[cur] || cur;
}

// Format universel : prend une value + sa devise native + retourne string formatée
// dans la devise d'affichage (selon la préférence utilisateur)
function formatPriceConverted(value, nativeCur, ratesOpt) {
  if (value == null || isNaN(value)) return '—';
  const ctx = resolveDisplayCurrency(nativeCur);
  let v = value;
  let displaySym = ctx.symbol;
  let displayCur = ctx.display;
  if (ctx.convert) {
    const rates = ratesOpt || (window.TG && window.TG.fxRates);
    // v2.58 — Si pas de rate fiable disponible : on REVIENT en devise native
    // (mieux qu'afficher un prix faux). On signale par un astérisque léger.
    if (rates && rates.USD_EUR && !rates.fallback) {
      v = _convertSync(value, (nativeCur || 'USD').toUpperCase(), ctx.display, rates);
    } else {
      displayCur = (nativeCur || 'USD').toUpperCase();
      displaySym = _currencySymbol(displayCur);
    }
  }
  let txt;
  if (v >= 10000) txt = Math.round(v).toLocaleString('fr-FR');
  else if (v >= 100) txt = v.toFixed(0);
  else if (v >= 1) txt = v.toFixed(2);
  else txt = v.toFixed(4);
  return txt + ' ' + displaySym;
}

/* ═══════════════════════════════════════════════════════════════════
   v2.63 — Système de BADGES (déblocages Duolingo-style)
   ═══════════════════════════════════════════════════════════════════ */
const BADGES_KEY = 'tg_badges';
const BADGES_DEF = [
  { id: 'first_track',   icon: '🎯', name: 'Premier trade', desc: 'Tu as tracké ton 1er setup' },
  { id: 'ten_tracks',    icon: '📋', name: 'Stratège',      desc: '10 setups trackés' },
  { id: 'first_pattern', icon: '🔍', name: 'Œil affûté',    desc: 'Tu as analysé ton 1er pattern' },
  { id: 'first_poll',    icon: '🔮', name: 'Devin du marché', desc: '1er pari quotidien' },
  { id: 'three_wins',    icon: '🏆', name: 'Triple touche', desc: '3 pronostics gagnés' },
  { id: 'streak_3',      icon: '🔥', name: 'Engagé', desc: 'Streak de 3 jours' },
  { id: 'streak_7',      icon: '⚡', name: 'Régulier', desc: 'Streak de 7 jours' },
  { id: 'streak_30',     icon: '👑', name: 'Roi du focus', desc: 'Streak de 30 jours' },
  { id: 'level_5',       icon: '⭐', name: 'Apprenti', desc: 'Niveau 5 atteint' },
  { id: 'level_10',      icon: '🌟', name: 'Confirmé', desc: 'Niveau 10 atteint' },
  { id: 'all_modules',   icon: '🎓', name: 'Diplômé', desc: 'Les 6 modules validés' },
];
function loadBadges() {
  try { const b = JSON.parse(localStorage.getItem(BADGES_KEY)); return Array.isArray(b) ? b : []; }
  catch { return []; }
}
function saveBadges(arr) {
  try { localStorage.setItem(BADGES_KEY, JSON.stringify(arr)); } catch {}
}
function unlockBadge(id) {
  const owned = loadBadges();
  if (owned.includes(id)) return false;
  const def = BADGES_DEF.find(b => b.id === id);
  if (!def) return false;
  owned.push(id);
  saveBadges(owned);
  // Toast custom
  showBadgeToast(def);
  return true;
}
function showBadgeToast(def) {
  const el = document.createElement('div');
  el.className = 'tg-badge-toast';
  el.innerHTML = '<div class="tgbt-ico">' + def.icon + '</div>'
    + '<div class="tgbt-body"><div class="tgbt-title">Badge débloqué !</div>'
    + '<div class="tgbt-name">' + def.name + '</div>'
    + '<div class="tgbt-desc">' + def.desc + '</div></div>';
  document.body.appendChild(el);
  if (!document.getElementById('tgbt-styles')) {
    const s = document.createElement('style');
    s.id = 'tgbt-styles';
    s.textContent = `
      .tg-badge-toast {
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%) translateY(-20px);
        z-index: 10010; max-width: 340px; padding: 12px 14px;
        background: linear-gradient(135deg, rgba(245,158,11,0.96), rgba(217,119,6,0.96));
        color: #1c1410; border-radius: 14px;
        box-shadow: 0 10px 30px rgba(245,158,11,0.45), 0 2px 8px rgba(0,0,0,0.4);
        display: flex; align-items: center; gap: 12px;
        opacity: 0; transition: opacity 0.3s, transform 0.3s;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      }
      .tg-badge-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
      .tgbt-ico { font-size: 32px; line-height: 1; flex-shrink: 0; }
      .tgbt-body { flex: 1; min-width: 0; }
      .tgbt-title { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.8; }
      .tgbt-name { font-size: 16px; font-weight: 800; margin: 2px 0; }
      .tgbt-desc { font-size: 12px; opacity: 0.85; line-height: 1.3; }
    `;
    document.head.appendChild(s);
  }
  requestAnimationFrame(() => el.classList.add('show'));
  if (navigator.vibrate) navigator.vibrate([30, 50, 30, 50, 60]);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, 4500);
}
// Vérifie les conditions automatiques à partir d'événements externes
function checkBadges() {
  try {
    // Streak
    const streak = JSON.parse(localStorage.getItem('tradegenius_streak') || '{}');
    if (streak.count >= 3)  unlockBadge('streak_3');
    if (streak.count >= 7)  unlockBadge('streak_7');
    if (streak.count >= 30) unlockBadge('streak_30');
    // XP / Level
    const xp = JSON.parse(localStorage.getItem('tg_xp') || '{}');
    const lvl = xp.level || 0;
    if (lvl >= 5)  unlockBadge('level_5');
    if (lvl >= 10) unlockBadge('level_10');
    // Trades trackés
    const trades = JSON.parse(localStorage.getItem('tg_tracked_trades') || '[]');
    if (Array.isArray(trades) && trades.length >= 1)  unlockBadge('first_track');
    if (Array.isArray(trades) && trades.length >= 10) unlockBadge('ten_tracks');
    // Polls gagnés
    const poll = JSON.parse(localStorage.getItem('tg_poll_history') || '{}');
    const wins = Object.values(poll).filter(p => p && p.correct).length;
    if (wins >= 1) unlockBadge('first_poll');
    if (wins >= 3) unlockBadge('three_wins');
    // Modules (les 6)
    const mods = ['tradegenius_v1','tradegenius_m1','tradegenius_m2','tradegenius_m3','tradegenius_m4','tradegenius_m5'];
    const allDone = mods.every(k => {
      try { const d = JSON.parse(localStorage.getItem(k) || '{}'); return d && (d.done || (d.progress && d.progress >= 100)); } catch { return false; }
    });
    if (allDone) unlockBadge('all_modules');
  } catch {}
}

/* ═══════════════════════════════════════════════════════════════════
   v2.61 — Mini-graph SVG partagé (popup IA + FAB Analyste)
   ═══════════════════════════════════════════════════════════════════ */
function renderMiniGraph(prices, levels, opts) {
  if (!prices || prices.length < 5) return '';
  levels = levels || {};
  opts = opts || {};
  const w = opts.width || 480;
  const h = opts.height || 220;
  const pad = 10;
  const padR = 70;
  const ipw = w - pad - padR;
  const iph = h - 2 * pad;
  const pts = [...prices];
  ['entry','stop','tp1','tp2','neckline'].forEach(k => { if (levels[k] != null) pts.push(levels[k]); });
  const mn = Math.min(...pts), mx = Math.max(...pts);
  const pad_ = (mx - mn) * 0.05 || 1;
  const min = mn - pad_, max = mx + pad_;
  const range = max - min || 1;
  const xS = (i) => pad + (i / (prices.length - 1)) * ipw;
  const yS = (v) => pad + iph - ((v - min) / range) * iph;
  const linePath = prices.map((p, i) => (i ? 'L' : 'M') + xS(i).toFixed(1) + ',' + yS(p).toFixed(1)).join(' ');
  const lastX = xS(prices.length - 1).toFixed(1);
  const areaPath = linePath + ' L' + lastX + ',' + (pad + iph) + ' L' + pad + ',' + (pad + iph) + ' Z';
  const trend = prices[prices.length - 1] - prices[0];
  const lc = trend >= 0 ? '#4ade80' : '#f87171';
  const fc = trend >= 0 ? 'rgba(74,222,128,0.10)' : 'rgba(248,113,113,0.10)';
  const lineFor = (val, color, lbl) => {
    if (val == null) return '';
    const y = yS(val).toFixed(1);
    return '<line x1="' + pad + '" y1="' + y + '" x2="' + (pad + ipw) + '" y2="' + y +
      '" stroke="' + color + '" stroke-width="1" stroke-dasharray="3,3" opacity="0.85"/>' +
      '<text x="' + (pad + ipw + 4) + '" y="' + (Number(y) + 3) + '" fill="' + color +
      '" font-size="10" font-family="monospace" font-weight="700">' + lbl + '</text>';
  };
  const lastY = yS(prices[prices.length - 1]).toFixed(1);
  const lastMarker = '<circle cx="' + lastX + '" cy="' + lastY + '" r="3" fill="' + lc + '" stroke="#fff" stroke-width="1.5"/>';
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block;background:rgba(0,0,0,0.28);border-radius:8px">'
    + '<path d="' + areaPath + '" fill="' + fc + '"/>'
    + '<path d="' + linePath + '" fill="none" stroke="' + lc + '" stroke-width="1.6"/>'
    + lineFor(levels.neckline, '#a78bfa', 'Neckline')
    + lineFor(levels.entry, '#60a5fa', 'Entrée')
    + lineFor(levels.stop, '#ef4444', 'Stop')
    + lineFor(levels.tp1, '#84cc16', 'TP1')
    + lineFor(levels.tp2, '#22c55e', 'TP2')
    + lastMarker
    + '</svg>';
}

// Expose tout via window.TG
window.TG = window.TG || {};
Object.assign(window.TG, {
  getCurrencyPref, setCurrencyPref,
  getExchangeRates, resolveDisplayCurrency, formatPriceConverted,
  renderMiniGraph,
  // v2.63 — Badges
  loadBadges, unlockBadge, checkBadges, BADGES_DEF,
  fxRates: null, // sera rempli par warm-up
});

// Warm-up + stockage du rate pour usage sync
// v2.58 — Si rates retourne null (toutes sources échouent), on n'écrase pas
// window.TG.fxRates pour que formatPriceConverted retombe sur la devise native
getExchangeRates().then(r => {
  if (r && r.USD_EUR) {
    window.TG.fxRates = r;
    window.dispatchEvent(new CustomEvent('tg-fx-ready', { detail: r }));
  }
});
