// Trade Genius — common shared module
// Version partagée, badge auto, billet 3D Three.js
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

export const TG_VERSION = 'v1.83';

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

export function showRecap({ eyebrow = '✓ VALIDÉ', title = 'Ce que tu as appris', points = [], onContinue = null } = {}) {
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
      <div class="tg-recap-check">✓</div>
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
  if (navigator.vibrate) navigator.vibrate([12, 60, 28]);
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
  shareCard, addGlossaryTerm, recordVisit, resetConsent, showRecap,
  getNotifState, requestNotifPermission, disableNotifs, checkStreakDangerNotify,
  getDailyChallenge, getDailyState, showDailyChallenge,
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
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoInit);
else autoInit();
