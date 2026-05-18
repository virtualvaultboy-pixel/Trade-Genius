// Trade Genius — common shared module
// Version partagée, badge auto, billet 3D Three.js
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

export const TG_VERSION = 'v1.51';

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

// Auto-init au load
function autoInit() {
  injectVersionBadge();
  initAllBills();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoInit);
else autoInit();
