import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { World, gltfLoader, rand } from './world.js';
import { Operator, makeRifle } from './operator.js';
import { FX } from './fx.js';
import { Sfx, SOUND_BANK } from './audio.js';

const $ = (id) => document.getElementById(id);
const bar = $('loadbar'), loadTxt = $('loadtxt');
const progress = (p, t) => { bar.style.width = `${Math.round(p * 100)}%`; if (t) loadTxt.textContent = t; };

// ---------- renderer ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.9;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xbfcbd4, 0.0021);
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.05, 2500);
camera.position.set(0, 2, -4);

const sun = new THREE.DirectionalLight(0xfff0dc, 3.2);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -50, right: 50, top: 50, bottom: -50, near: 1, far: 400 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
const SUN_DIR = new THREE.Vector3(-0.45, 0.72, -0.53).normalize(); // replaced by the HDRI's real sun below
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x5b5140, 0.35));

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.35, 0.5, 0.92);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------- load everything ----------
progress(0.02, 'Loading sky…');
const hdr = await new RGBELoader().loadAsync('assets/hdri/sky_2k.hdr');
hdr.mapping = THREE.EquirectangularReflectionMapping;
scene.background = hdr; scene.environment = hdr; scene.environmentIntensity = 0.85; scene.backgroundIntensity = 1;
// find the sun in the HDRI (brightest pixel) so shadows match the sky
{
  const { data, width: W, height: H } = hdr.image, half = data instanceof Uint16Array;
  const get = i => half ? THREE.DataUtils.fromHalfFloat(data[i]) : data[i];
  let best = -1, bi = 0;
  for (let y = 0; y < H / 2; y += 2) for (let x = 0; x < W; x += 2) {
    const i = (y * W + x) * 4, l = get(i) + get(i + 1) + get(i + 2);
    if (l > best) { best = l; bi = y * W + x; }
  }
  const px = bi % W, py = Math.floor(bi / W);
  const u = (px + 0.5) / W, v = 1 - (py + 0.5) / H;
  const th = (u - 0.5) * Math.PI * 2, ph = (v - 0.5) * Math.PI;
  SUN_DIR.set(Math.cos(th) * Math.cos(ph), Math.sin(ph), Math.sin(th) * Math.cos(ph)).normalize();
  if (SUN_DIR.y < 0.25) { SUN_DIR.y = 0.25; SUN_DIR.normalize(); }
}

const world = new World(scene);
const fx = new FX(scene);
const sfx = new Sfx();

progress(0.08, 'Building the map…');
const [_, soldierG, m4] = await Promise.all([
  world.build(p => progress(0.08 + p * 0.62, 'Building the map…')),
  gltfLoader.loadAsync('assets/soldier_real.glb'),
  new FBXLoader().loadAsync('assets/m4/M4A1/M4A1.fbx'),
  sfx.load(SOUND_BANK),
]);
progress(0.75, 'Arming operators…');

// M4 PBR textures
{
  const tl = new THREE.TextureLoader(), T = (n, srgb) => { const t = tl.load(`assets/m4/M4A1/M4A1_${n}.png`); if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
  const mat = new THREE.MeshStandardMaterial({ map: T('Base_Color', true), metalnessMap: T('Metallic'), roughnessMap: T('Roughness'), normalMap: T('Normal'), metalness: 1, roughness: 1 });
  m4.traverse(o => { if (o.isMesh) o.material = mat; });
}
const RIFLE_CFG = window.RIFLE_CFG = { rot: [0, Math.PI, 0], length: 0.86, boreFrac: 0.73, gripFrac: 0.31, foreFrac: 0.64 };
const rifle = makeRifle(m4, RIFLE_CFG);

const player = new Operator(soldierG, rifle, scene);
player.group.position.set(3, 0, -6);

const SPAWNS = [[18, 30], [-22, 44], [30, -24], [-30, -40], [45, 12], [-18, 70], [60, -8], [205, -20], [12, -70], [-60, 10]];
const enemies = SPAWNS.map(([x, z], i) => {
  const e = new Operator(soldierG, rifle, scene, { tint: 0xb0a090 });
  e.group.position.set(x, 0, z);
  e.home = new THREE.Vector3(x, 0, z); e.target = e.home.clone(); e.yaw = rand() * 6.28; e.hp = 100; e.state = 'patrol';
  e.wait = rand() * 4; e.fireT = 0; e.burst = 0; e.name = `Bot_${['Viper', 'Ghost', 'Hawk', 'Wolf', 'Cobra', 'Raven', 'Shadow', 'Blaze', 'Titan', 'Rogue'][i]}`;
  // hitboxes
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1.45, 8), new THREE.MeshBasicMaterial({ visible: false }));
  body.position.y = 0.75; body.userData.enemy = e; body.userData.part = 'body'; e.group.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
  head.userData.enemy = e; head.userData.part = 'head'; scene.add(head); e.headBox = head; e.bodyBox = body;
  return e;
});
const hitboxes = enemies.flatMap(e => [e.bodyBox, e.headBox]);

// ---------- input ----------
const keys = {};
let yaw = Math.PI, pitch = -0.08, firing = false, aiming = false, locked = false;
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'KeyR') reload();
  if (e.code === 'KeyM') { sfx.master.gain.value = sfx.master.gain.value > 0 ? 0 : 0.9; }
});
addEventListener('keyup', e => keys[e.code] = false);
const startBtn = $('start');
startBtn.addEventListener('click', () => { sfx.resume(); renderer.domElement.requestPointerLock(); });
renderer.domElement.addEventListener('click', () => { if (!locked) { sfx.resume(); renderer.domElement.requestPointerLock(); } });
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
  $('overlay').classList.toggle('hide', locked);
  if (!locked) firing = false;
});
addEventListener('mousemove', e => {
  if (!locked) return;
  const k = aiming ? 0.0012 : 0.0022;
  yaw -= e.movementX * k; pitch = THREE.MathUtils.clamp(pitch - e.movementY * k, -1.2, 0.9);
});
addEventListener('mousedown', e => { if (!locked) return; if (e.button === 0) firing = true; if (e.button === 2) aiming = true; });
addEventListener('mouseup', e => { if (e.button === 0) firing = false; if (e.button === 2) aiming = false; });
addEventListener('contextmenu', e => e.preventDefault());

// ---------- player state ----------
const MAG = 30;
const S = { ammo: MAG, reserve: 150, hp: 100, lastHurt: -9, reloading: 0, cool: 0, spread: 0, kills: 0, bodyYaw: Math.PI, dead: 0, shotsInBurst: 0 };
const ray = new THREE.Raycaster();
const tmp = new THREE.Vector3();
let aimPoint = new THREE.Vector3();

function reload() {
  if (S.reloading > 0 || S.ammo === MAG || S.reserve <= 0 || S.dead) return;
  S.reloading = 2.1; sfx.play('reload', { vol: 0.9, jitter: 0 });
}
function hud() {
  $('ammo').textContent = S.ammo; $('reserve').textContent = S.reserve;
  $('hpfill').style.width = `${S.hp}%`;
  $('hpfill').style.background = S.hp > 50 ? '#e8e8e8' : S.hp > 25 ? '#f0b54a' : '#e5484d';
}
function killfeed(text) {
  const d = document.createElement('div'); d.className = 'kf'; d.innerHTML = text; $('feed').prepend(d);
  setTimeout(() => d.remove(), 5000);
}
function hitmarker(head) {
  const h = $('hitmark'); h.classList.remove('show', 'head'); void h.offsetWidth; h.classList.add('show'); if (head) h.classList.add('head');
}
function surfaceSound(x, z) { const s = world.surfaceAt(x, z); return s === 'concrete' ? 'stepConcrete' : 'stepGrass'; }
function impactKind(obj) {
  if (obj === world.groundMesh) return 'ground';
  const m = obj.material; const n = (m && (m.name || '')) + (obj.name || '');
  if (/wood|plank|madeira|bark|branch|tree/i.test(n) || m?.map?.image?.src?.includes('planks')) return 'wood';
  return 'hard';
}

player.stepCb = () => {
  if (S.dead) return;
  const p = player.position, run = keys.ShiftLeft && !aiming;
  sfx.play(surfaceSound(p.x, p.z), { vol: run ? 0.55 : 0.35, rate: 1, jitter: 0.1, reverb: 0.05 });
};
enemies.forEach(e => e.stepCb = () => {
  const d = e.position.distanceTo(camera.position); if (d > 35) return;
  sfx.play(surfaceSound(e.position.x, e.position.z), { vol: 0.5, pos: e.position.clone(), reverb: 0.05 });
});

function shoot() {
  S.ammo--; S.cool = 0.085; S.shotsInBurst++;
  const muzzle = player.muzzleWorld(), bdir = player.barrelDir();
  // spread grows while moving / hip firing / sustained fire
  const moving = keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD;
  const spread = (aiming ? 0.004 : 0.018) + (moving ? 0.012 : 0) + Math.min(0.02, S.shotsInBurst * 0.0015);
  ray.setFromCamera(new THREE.Vector2((Math.random() - .5) * spread * 2, (Math.random() - .5) * spread * 2), camera);
  const camHits = ray.intersectObjects([...world.solids, ...hitboxes.filter(h => !h.userData.enemy.dead)], false);
  const target = camHits[0] ? camHits[0].point : ray.ray.at(600, new THREE.Vector3());
  // second ray from the muzzle so cover between gun and target is respected
  const dir = target.clone().sub(muzzle).normalize();
  ray.set(muzzle, dir); ray.far = 700;
  const hits = ray.intersectObjects([...world.solids, ...hitboxes.filter(h => !h.userData.enemy.dead)], false).filter(h => h.distance > 0.05);
  const hit = hits[0];
  const end = hit ? hit.point : muzzle.clone().addScaledVector(dir, 600);
  fx.muzzle(muzzle, bdir); fx.tracer(muzzle.clone().addScaledVector(dir, 0.6), end);
  player.kick();
  // camera recoil
  recoilPitch += 0.012 + Math.random() * 0.006; yaw += (Math.random() - .5) * 0.006;
  camShake = Math.min(1, camShake + 0.35);
  sfx.play('shot', { vol: 1, rate: 1.0, jitter: 0.04, reverb: 0.45 });
  const ej = player.gun.localToWorld(rifle.ejector.clone());
  const right = new THREE.Vector3(-1, 0, 0).applyQuaternion(player.gun.quaternion);
  fx.shell(ej, right.add(new THREE.Vector3(0, 0.3, 0)), p => sfx.play('shell', { vol: 0.12, rate: 2.2, pos: p, reverb: 0 }));
  alertNearby(end, 30);
  if (!hit) return;
  const en = hit.object.userData.enemy;
  if (en) {
    const head = hit.object.userData.part === 'head';
    en.hp -= head ? 100 : 34; fx.impact(hit, 'flesh');
    sfx.play('hitFlesh', { vol: 0.8, pos: hit.point, reverb: 0 }); hitmarker(head);
    en.state = 'combat'; en.alertT = 12;
    if (en.hp <= 0) {
      en.die(dir); S.kills++; $('kills').textContent = S.kills;
      setTimeout(() => sfx.play('body', { vol: 0.8, pos: en.position.clone(), reverb: 0.1 }), 420);
      killfeed(`<b>You</b> <span class="gun">M4A1</span> ${head ? '<span class="hs">⌖ headshot</span> ' : ''}<b class="en">${en.name}</b>`);
      en.respawnT = 10;
    }
  } else {
    const kind = impactKind(hit.object);
    fx.impact(hit, kind);
    sfx.play(kind === 'wood' ? 'hitWood' : kind === 'ground' ? 'hitGround' : 'hitRock', { vol: 0.5, pos: hit.point, reverb: 0.1, minGap: 0.03 });
  }
}
function alertNearby(p, r) {
  for (const e of enemies) if (!e.dead && e.position.distanceTo(p) < r) { e.state = 'combat'; e.alertT = 10; }
}

// ---------- enemy AI ----------
function losTo(from, to) {
  const d = to.clone().sub(from), len = d.length(); ray.set(from, d.normalize()); ray.far = len - 0.5;
  const h = ray.intersectObjects(world.solids, false); ray.far = Infinity; return h.length === 0;
}
function enemyThink(e, dt, t) {
  if (e.dead) {
    e.update(dt, { aimPoint: tmp, bodyYaw: e.yaw });
    if ((e.respawnT -= dt) <= 0) { e.revive(e.home); e.hp = 100; e.state = 'patrol'; }
    return;
  }
  const toP = player.position.clone().sub(e.position); const dist = toP.length();
  let moveSpeed = 0, aim = 0, look;
  if (e.state === 'combat' && !S.dead) {
    e.alertT -= dt; if (e.alertT <= 0 && dist > 60) e.state = 'patrol';
    look = player.chest();
    e.yaw = Math.atan2(toP.x, toP.z); aim = 1;
    const eye = e.chest().add(new THREE.Vector3(0, 0.3, 0));
    const see = dist < 120 && losTo(eye, look);
    if (see) e.alertT = 10;
    // keep some distance, strafe a bit
    if (dist > 28) moveSpeed = 2.6;
    e.fireT -= dt;
    if (see && e.fireT <= 0) {
      e.burst = 3 + (Math.random() * 4 | 0); e.fireT = 1.6 + Math.random() * 2;
    }
    if (e.burst > 0 && (e.shotT = (e.shotT || 0) - dt) <= 0) { e.burst--; e.shotT = 0.11; enemyShoot(e, look, dist); }
  } else {
    // patrol between random points near home
    const toT = e.target.clone().sub(e.position); toT.y = 0;
    if (toT.length() < 1 || (e.wait -= dt) > 0) {
      if (toT.length() < 1 && e.wait <= 0) { e.wait = 2 + Math.random() * 5; e.target = e.home.clone().add(new THREE.Vector3((Math.random() - .5) * 24, 0, (Math.random() - .5) * 24)); }
    } else { moveSpeed = 1.45; e.yaw = lerpAngle(e.yaw, Math.atan2(toT.x, toT.z), 1 - Math.exp(-dt * 5)); }
    look = e.position.clone().add(new THREE.Vector3(Math.sin(e.yaw) * 10, 1.2, Math.cos(e.yaw) * 10));
    if (dist < 18 && !S.dead) { e.state = 'combat'; e.alertT = 8; }
  }
  if (moveSpeed) {
    const dirv = e.state === 'combat' ? toP.clone().setY(0).normalize() : e.target.clone().sub(e.position).setY(0).normalize();
    const nx = e.position.x + dirv.x * moveSpeed * dt, nz = e.position.z + dirv.z * moveSpeed * dt;
    if (!world.blocked(nx, e.position.z)) e.position.x = nx; else e.target = e.home.clone();
    if (!world.blocked(e.position.x, nz)) e.position.z = nz;
    e.play(moveSpeed > 2 ? 'Run' : 'Walk', 0.3, moveSpeed > 2 ? 0.8 : 1);
  } else e.play('Idle');
  e.update(dt, { aimPoint: look, aim, bodyYaw: e.yaw });
  e.headBox.position.copy(e.b.head.getWorldPosition(tmp)).add(new THREE.Vector3(0, 0.06, 0));
}
function enemyShoot(e, target, dist) {
  const m = e.muzzleWorld();
  const inacc = 0.6 + dist * 0.04; // metres of scatter
  const aimAt = target.clone().add(new THREE.Vector3((Math.random() - .5) * inacc, (Math.random() - .5) * inacc, (Math.random() - .5) * inacc));
  const dir = aimAt.clone().sub(m).normalize();
  ray.set(m, dir); ray.far = 400;
  const wh = ray.intersectObjects(world.solids, false)[0];
  const playerDist = m.distanceTo(target);
  const hitPlayer = (!wh || wh.distance > playerDist) && aimAt.distanceTo(target) < 0.45;
  const end = hitPlayer ? aimAt : wh ? wh.point : m.clone().addScaledVector(dir, 400);
  fx.muzzle(m, e.barrelDir()); fx.tracer(m, end, 360); e.kick();
  const far = dist > 70;
  sfx.play(far ? 'enemyShotFar' : 'enemyShot', { vol: far ? 0.8 : 1, pos: m, reverb: 0.4 });
  if (wh && !hitPlayer) { fx.impact(wh, impactKind(wh.object)); }
  if (hitPlayer && !S.dead) {
    S.hp -= 7 + Math.random() * 5; S.lastHurt = clock.elapsedTime;
    const v = $('dmg'); v.style.opacity = 0.9; camShake = Math.min(1, camShake + 0.5);
    sfx.play('hitFlesh', { vol: 0.9, reverb: 0 });
    // damage direction indicator
    const a = Math.atan2(e.position.x - player.position.x, e.position.z - player.position.z) - yaw;
    const ind = $('dir'); ind.style.transform = `translate(-50%,-50%) rotate(${-a + Math.PI}rad)`; ind.style.opacity = 1;
    if (S.hp <= 0) playerDie(e);
  } else if (m.distanceTo(camera.position) < 60) {
    // near miss crack
    const close = ray.ray.distanceToPoint(camera.position);
    if (close < 3) sfx.play('hitGround', { vol: 0.25, rate: 2.5, pos: camera.position.clone().add(dir.clone().multiplyScalar(-2)), reverb: 0 });
  }
  hud();
}
function playerDie(by) {
  S.dead = 3.5; S.hp = 0; player.die(by.position.clone().sub(player.position).normalize().negate());
  killfeed(`<b class="en">${by.name}</b> <span class="gun">AKM</span> <b>You</b>`);
  $('deadmsg').classList.add('show');
}
const lerpAngle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

// ---------- camera ----------
let recoilPitch = 0, camShake = 0, camDist = 3;
const camPivot = new THREE.Vector3(), camWant = new THREE.Vector3();
function updateCamera(dt) {
  recoilPitch *= Math.exp(-dt * 9);
  const p = pitch + recoilPitch;
  const aimK = player.aimBlend;
  const dist = THREE.MathUtils.lerp(3.4, 1.45, aimK), shoulder = THREE.MathUtils.lerp(0.72, 0.58, aimK), height = THREE.MathUtils.lerp(1.78, 1.68, aimK);
  const fwd = new THREE.Vector3(Math.sin(yaw) * Math.cos(p), Math.sin(p), Math.cos(yaw) * Math.cos(p));
  const right = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
  camPivot.copy(player.position).setY(player.position.y + height).addScaledVector(right, shoulder);
  // camera collision
  ray.set(camPivot, fwd.clone().negate()); ray.far = dist + 0.3;
  const h = ray.intersectObjects(world.solids, false)[0];
  const want = h ? Math.max(0.3, h.distance - 0.3) : dist;
  camDist += (want - camDist) * (1 - Math.exp(-dt * (want < camDist ? 30 : 6)));
  camWant.copy(camPivot).addScaledVector(fwd, -camDist);
  camera.position.copy(camWant);
  camera.position.y = Math.max(camera.position.y, 0.25);
  camera.lookAt(camPivot.clone().addScaledVector(fwd, 10));
  if (camShake > 0.001) {
    camShake *= Math.exp(-dt * 10);
    camera.rotateZ((Math.random() - .5) * 0.01 * camShake); camera.rotateX((Math.random() - .5) * 0.008 * camShake);
  }
  const fov = THREE.MathUtils.lerp(keys.ShiftLeft && !aiming && moving() ? 68 : 62, 44, aimK);
  camera.fov += (fov - camera.fov) * (1 - Math.exp(-dt * 10)); camera.updateProjectionMatrix();
  // what the crosshair points at
  camera.updateMatrixWorld();
  ray.setFromCamera(new THREE.Vector2(0, 0), camera); ray.far = 800;
  const ah = ray.intersectObjects([...world.solids, ...hitboxes], false).find(x => x.distance > camDist + 0.4);
  aimPoint = ah ? ah.point : ray.ray.at(300, new THREE.Vector3());
  ray.far = Infinity;
  const o = window.__camOverride; // debug: inspect the rig from any angle
  if (o) { camera.position.copy(player.position).add(o.off); camera.lookAt(player.position.clone().add(o.look)); }
}
const moving = () => keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD;

// ---------- compass ----------
const compass = $('compass');
{
  let html = '';
  for (let d = -360; d <= 720; d += 15) {
    const n = ((d % 360) + 360) % 360, lbl = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[n];
    html += `<span style="left:${(d + 360) * 4}px" class="${lbl ? 'major' : n % 45 ? '' : 'mid'}">${lbl || (n % 45 ? '|' : n)}</span>`;
  }
  compass.innerHTML = `<div id="ctrack">${html}</div>`;
}
function updateCompass() {
  const deg = ((-yaw * 180 / Math.PI + 180) % 360 + 360) % 360;
  $('ctrack').style.transform = `translateX(${-(deg + 360) * 4 + compass.clientWidth / 2}px)`;
  $('bearing').textContent = Math.round(deg);
}

// ---------- main loop ----------
const clock = new THREE.Clock();
sfx.startWindOnResume = true;
document.addEventListener('pointerlockchange', () => { if (sfx.startWindOnResume && locked) { sfx.startWind(); sfx.startWindOnResume = false; } });
progress(1, 'Ready');
$('loading').classList.add('hide'); $('overlay').classList.remove('hide');
hud();

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
  if (renderer.domElement.width !== Math.floor(innerWidth * renderer.getPixelRatio()) && innerWidth > 0) onResize();

  // --- player movement ---
  const f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0), s = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  const mv = (f || s) && !S.dead;
  const sprint = keys.ShiftLeft && !aiming && !firing && f > 0 && S.reloading <= 0;
  const combat = aiming || firing;
  if (!S.dead) {
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), right = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
    const dir = fwd.clone().multiplyScalar(f).addScaledVector(right, s);
    if (dir.lengthSq()) dir.normalize();
    const speed = !mv ? 0 : sprint ? 6.2 : combat ? 2.2 : f < 0 ? 1.9 : 3.0;
    const nx = player.position.x + dir.x * speed * dt, nz = player.position.z + dir.z * speed * dt;
    if (!world.blocked(nx, player.position.z)) player.position.x = nx;
    if (!world.blocked(player.position.x, nz)) player.position.z = nz;
    // body faces camera direction when moving/aiming; strafing twists the hips toward the move direction
    if (mv || combat) S.bodyYaw = lerpAngle(S.bodyYaw, yaw, 1 - Math.exp(-dt * 12));
    else if (Math.abs(Math.atan2(Math.sin(yaw - S.bodyYaw), Math.cos(yaw - S.bodyYaw))) > 1.0) S.bodyYaw = lerpAngle(S.bodyYaw, yaw, 1 - Math.exp(-dt * 4));
    let twist = 0;
    if (mv && s && f >= 0) twist = -s * (f ? 0.6 : 1.1);
    if (mv && s && f < 0) twist = s * 0.6;
    S.twist = (S.twist || 0) + (twist - (S.twist || 0)) * (1 - Math.exp(-dt * 10));
    if (!mv) player.play('Idle', 0.25);
    else if (sprint) player.play('Run', 0.2, 1);
    else if (f < 0) player.play('Walk', 0.25, -1);
    else player.play('Walk', 0.25, combat ? 0.8 : 1.05);
  }

  updateCamera(dt);
  const aim = S.reloading > 0 ? 0 : aiming || firing || S.cool > -0.4 ? 1 : 0;
  player.update(dt, { aimPoint: sprint ? player.position.clone().add(new THREE.Vector3(Math.sin(yaw) * 10, 0.6, Math.cos(yaw) * 10)) : aimPoint, aim, twist: S.twist || 0, bodyYaw: S.bodyYaw });

  // --- shooting / reload ---
  S.cool -= dt;
  if (!firing) S.shotsInBurst = Math.max(0, S.shotsInBurst - dt * 20);
  if (S.reloading > 0) {
    S.reloading -= dt;
    if (S.reloading <= 0) { const n = Math.min(MAG - S.ammo, S.reserve); S.ammo += n; S.reserve -= n; hud(); }
  } else if (firing && !sprint && !S.dead && S.cool <= 0) {
    if (S.ammo > 0) { shoot(); hud(); }
    else { S.cool = 0.3; sfx.play('shell', { vol: 0.3, rate: 3, reverb: 0 }); reload(); }
  }
  // spread crosshair
  const spreadPx = (aiming ? 6 : 14) + (mv ? 10 : 0) + S.shotsInBurst * 1.2 + (sprint ? 16 : 0);
  $('cross').style.setProperty('--gap', `${spreadPx}px`);
  $('cross').classList.toggle('ads', player.aimBlend > 0.7);

  // --- health ---
  if (!S.dead && S.hp < 100 && t - S.lastHurt > 5) { S.hp = Math.min(100, S.hp + dt * 12); hud(); }
  const dv = $('dmg'); dv.style.opacity = Math.max(0, parseFloat(dv.style.opacity || 0) - dt * 1.5) + (S.hp < 30 ? 0.25 : 0);
  const di = $('dir'); di.style.opacity = Math.max(0, parseFloat(di.style.opacity || 0) - dt * 0.8);
  if (S.dead) {
    S.dead -= dt;
    if (S.dead <= 0) {
      S.dead = 0; S.hp = 100; S.ammo = MAG; S.reserve = 150; player.revive(new THREE.Vector3(3, 0, -6)); hud();
      $('deadmsg').classList.remove('show');
      enemies.forEach(e => { e.state = 'patrol'; });
    }
  }

  for (const e of enemies) enemyThink(e, dt, t);
  world.update(t, dt, sfx.ctx.state === 'running' ? sfx : null, camera.position);
  fx.update(dt);
  sfx.setListener(camera);
  updateCompass();

  // sun + shadow frustum follow the player
  sun.position.copy(player.position).addScaledVector(SUN_DIR, 150);
  sun.target.position.copy(player.position);
  composer.render();
  requestAnimationFrame(tick);
}
function onResize() {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', onResize);
tick();

window.__dbg = { THREE, scene, camera, player, enemies, world, rifle, m4, S, sfx, setView: (y, p) => { yaw = y; pitch = p; }, setAim: v => { aiming = v; }, setFire: v => { firing = v; }, keys };
