// Trade Genius — common shared module
// Version partagée, badge auto, billet 3D Three.js
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

export const TG_VERSION = 'v1.62';

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

  // Logo TG + brand
  ctx.textAlign = 'left';
  ctx.fillStyle = '#bef264';
  ctx.font = '800 140px "Bricolage Grotesque", Georgia, serif';
  ctx.fillText('TG', 80, 240);
  ctx.fillStyle = 'rgba(245,243,239,0.55)';
  ctx.font = '700 22px "JetBrains Mono", monospace';
  ctx.fillText('TRADE GENIUS', 80, 285);

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
  shareCard, addGlossaryTerm, recordVisit, resetConsent, TG_VERSION,
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

// Auto-init au load
function autoInit() {
  injectVersionBadge();
  initAllBills();
  loadAnalytics();
  injectConsentBanner();
  recordVisit();
  initGlossary();
  prefetchScenes();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoInit);
else autoInit();
