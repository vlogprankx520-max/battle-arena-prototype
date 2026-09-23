import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Tree } from '@dgreenheck/ez-tree';

const texLoader = new THREE.TextureLoader();
const draco = new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/');
export const gltfLoader = new GLTFLoader().setDRACOLoader(draco);
const loadGLTF = (u) => gltfLoader.loadAsync(u);

// deterministic RNG so the map is the same every load
let seed = 1337;
export const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = (a) => a[(rand() * a.length) | 0];

function tex(url, srgb) {
  const t = texLoader.load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// PBR material from a Poly Haven set; texSize = metres covered by one tile
function pbr(name, texSize, extra = {}) {
  const m = new THREE.MeshStandardMaterial({
    map: tex(`assets/tex/${name}_diff.jpg`, true), normalMap: tex(`assets/tex/${name}_nor.jpg`),
    roughnessMap: tex(`assets/tex/${name}_rough.jpg`), ...extra,
  });
  m.userData.texSize = texSize; return m;
}

export const M = {};
function makeMaterials() {
  Object.assign(M, {
    brick: pbr('brick', 2.2), redBrick: pbr('red_brick', 2.4), plaster: pbr('plaster', 3),
    plaster2: pbr('plaster2', 3), concrete: pbr('concrete', 3), roof: pbr('roof', 2.5),
    tin: pbr('tin', 2.5, { metalness: 0.6 }), planks: pbr('planks', 2), asphalt: pbr('asphalt', 6),
    runway: pbr('runway', 8), dirt: pbr('dirt', 10),
    frame: new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.6 }),
    darkFrame: new THREE.MeshStandardMaterial({ color: 0x3b2f25, roughness: 0.7 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x1d2a33, roughness: 0.05, metalness: 0.9, envMapIntensity: 1.6 }),
    paint: new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.8 }),
  });
  M.plaster.color.set(0xf1e7d6); M.plaster2.color.set(0xdfe6ea);
}

// box whose UVs are in world metres / texSize so textures never stretch
function wbox(w, h, d, mat) {
  const g = new THREE.BoxGeometry(w, h, d), s = mat.userData.texSize || 1, uv = g.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) { const k = f * 4 + i; uv.setXY(k, uv.getX(k) * dims[f][0] / s, uv.getY(k) * dims[f][1] / s); }
  const m = new THREE.Mesh(g, mat); return m;
}
function place(m, x, y, z, parent) { m.position.set(x, y, z); parent.add(m); return m; }

// collapse a group into one mesh per material (few draw calls, fast shadows)
function mergeByMaterial(group) {
  group.updateMatrixWorld(true);
  const buckets = new Map();
  group.traverse(o => {
    if (!o.isMesh) return;
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!buckets.has(o.material)) buckets.set(o.material, []);
    buckets.get(o.material).push(g);
  });
  const out = new THREE.Group();
  for (const [mat, geos] of buckets) {
    const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
    mesh.castShadow = mesh.receiveShadow = true; out.add(mesh);
  }
  return out;
}

export class World {
  constructor(scene) {
    this.scene = scene;
    this.solids = [];     // meshes bullets can hit
    this.colliders = [];  // Box3 for movement
    this.roads = [];      // {minX,maxX,minZ,maxZ} for footstep surface
    this.trees = [];
    this.flyers = [];
  }
  addSolid(obj, collide = true) {
    this.scene.add(obj); obj.updateMatrixWorld(true);
    obj.traverse(o => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; this.solids.push(o); } });
    if (collide) this.colliders.push(new THREE.Box3().setFromObject(obj));
  }
  blocked(x, z, r = 0.35) {
    for (const b of this.colliders) if (x > b.min.x - r && x < b.max.x + r && z > b.min.z - r && z < b.max.z + r && b.min.y < 1.2) return true;
    return false;
  }
  surfaceAt(x, z) {
    for (const r of this.roads) if (x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ) return r.type;
    return 'grass';
  }

  async build(onProgress = () => {}) {
    makeMaterials();
    this.ground(); onProgress(0.1);
    this.layoutTown(); onProgress(0.3);
    await Promise.all([
      this.loadScannedBuildings().then(() => onProgress(0.45)),
      this.loadProps().then(() => onProgress(0.6)),
      this.loadAircraft().then(() => onProgress(0.75)),
    ]);
    this.plantTrees(); onProgress(1);
  }

  ground() {
    const size = 1200;
    const g = new THREE.PlaneGeometry(size, size, 1, 1); g.rotateX(-Math.PI / 2);
    g.attributes.uv.array.forEach((v, i, a) => a[i] = v * size / 7);
    const mat = pbr('ground', 7); mat.color.set(0xc9d3b0);
    const ground = new THREE.Mesh(g, mat); ground.receiveShadow = true;
    this.scene.add(ground); this.solids.push(ground); this.groundMesh = ground;

    const strip = (x, z, w, l, mat, y, type, rot = 0) => {
      const s = mat.userData.texSize, pg = new THREE.PlaneGeometry(w, l); pg.rotateX(-Math.PI / 2);
      const uv = pg.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / s, uv.getY(i) * l / s);
      const m = new THREE.Mesh(pg, mat); m.rotation.y = rot; m.position.set(x, y, z); m.receiveShadow = true;
      this.scene.add(m); this.solids.push(m);
      const hw = rot ? l / 2 : w / 2, hl = rot ? w / 2 : l / 2;
      this.roads.push({ minX: x - hw, maxX: x + hw, minZ: z - hl, maxZ: z + hl, type });
      return m;
    };
    strip(0, 0, 8, 500, M.asphalt, 0.02, 'concrete');          // N–S main road
    strip(0, 0, 8, 500, M.asphalt, 0.021, 'concrete', Math.PI / 2); // E–W main road
    strip(-70, 60, 5, 200, M.dirt, 0.015, 'grass', Math.PI / 2);
    // airstrip
    strip(170, 0, 34, 420, M.runway, 0.025, 'concrete');
    strip(215, -40, 60, 90, M.runway, 0.024, 'concrete');       // apron
    const dash = new THREE.PlaneGeometry(1, 12); dash.rotateX(-Math.PI / 2);
    for (let z = -195; z < 200; z += 24) place(new THREE.Mesh(dash, M.paint), 170, 0.03, z, this.scene).receiveShadow = true;
    for (const x of [155, 185]) { const edge = new THREE.PlaneGeometry(0.6, 420); edge.rotateX(-Math.PI / 2); place(new THREE.Mesh(edge, M.paint), x, 0.03, 0, this.scene); }
    for (let i = 0; i < 8; i++) { const t = new THREE.PlaneGeometry(1.4, 18); t.rotateX(-Math.PI / 2); place(new THREE.Mesh(t, M.paint), 159 + i * 1.7 * 2.2, 0.03, -195, this.scene); }
  }

  // ---------- procedural PBR houses ----------
  window(parent, x, y, z, ry, frameMat = M.frame) {
    const g = new THREE.Group();
    place(wbox(1.35, 1.55, 0.14, frameMat), 0, 0, 0, g);
    place(wbox(1.13, 1.33, 0.1, M.glass), 0, 0, 0.03, g);
    place(wbox(0.06, 1.33, 0.12, frameMat), 0, 0, 0.05, g);
    place(wbox(1.13, 0.06, 0.12, frameMat), 0, 0.15, 0.05, g);
    place(wbox(1.55, 0.08, 0.28, M.concrete), 0, -0.82, 0.08, g);
    g.position.set(x, y, z); g.rotation.y = ry; parent.add(g);
  }
  facadeWindows(parent, w, d, floors, fh, frameMat, doorFront = true) {
    const sides = [[w, d / 2, 0], [w, -d / 2, Math.PI], [d, w / 2, Math.PI / 2], [d, -w / 2, -Math.PI / 2]];
    sides.forEach(([len, off, ry], si) => {
      const n = Math.max(1, Math.floor((len - 1) / 3.2)), step = len / n;
      for (let f = 0; f < floors; f++) for (let i = 0; i < n; i++) {
        const u = -len / 2 + step * (i + 0.5);
        if (doorFront && si === 0 && f === 0 && Math.abs(u) < step * 0.6) continue;
        const y = f * fh + 1.65, o = off + Math.sign(off) * 0.04;
        if (ry === 0 || ry === Math.PI) this.window(parent, u, y, o, ry, frameMat);
        else this.window(parent, o, y, u, ry, frameMat);
      }
    });
  }
  gableRoof(parent, w, d, h, mat, wallMat) {
    const pitch = 0.6, over = 0.45, rise = (d / 2) * Math.tan(pitch), slab = (d / 2 + over) / Math.cos(pitch);
    for (const s of [-1, 1]) {
      const r = wbox(w + over * 2, 0.16, slab, mat);
      r.rotation.x = s * pitch; r.position.set(0, h + rise / 2 - 0.02, s * (d / 4 + over / 2) * 0.98);
      parent.add(r);
    }
    const shape = new THREE.Shape([new THREE.Vector2(-d / 2, 0), new THREE.Vector2(d / 2, 0), new THREE.Vector2(0, rise)]);
    const sg = new THREE.ShapeGeometry(shape), uv = sg.attributes.uv, ts = wallMat.userData.texSize;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / ts, uv.getY(i) / ts);
    for (const s of [-1, 1]) { const m = new THREE.Mesh(sg, wallMat); m.rotation.y = s * Math.PI / 2; m.position.set(s * w / 2, h, 0); parent.add(m); }
    return rise;
  }
  house(x, z, ry, o) {
    const { w, d, floors, wall, roof = 'gable', frame = M.frame } = o, fh = 3, h = floors * fh;
    const g = new THREE.Group();
    place(wbox(w + 0.3, 0.5, d + 0.3, M.concrete), 0, 0.25, 0, g);
    place(wbox(w, h, d, wall), 0, h / 2 + 0.01, 0, g);
    this.facadeWindows(g, w, d, floors, fh, frame);
    // door + steps + awning
    place(wbox(1.4, 2.5, 0.16, M.frame), 0, 1.25 + 0.3, d / 2 + 0.03, g);
    place(wbox(1.1, 2.25, 0.2, M.darkFrame), 0, 1.15 + 0.3, d / 2 + 0.05, g);
    place(wbox(2, 0.3, 1.2, M.concrete), 0, 0.15, d / 2 + 0.6, g);
    place(wbox(2.2, 0.12, 1.1, M.tin), 0, 3, d / 2 + 0.55, g);
    if (roof === 'gable') {
      const rise = this.gableRoof(g, w, d, h, M.roof, wall);
      if (rand() > 0.4) place(wbox(0.7, rise + 1.2, 0.7, M.redBrick), w * 0.25, h + rise * 0.6, -d * 0.18, g);
    } else {
      place(wbox(w, 0.2, d, M.concrete), 0, h + 0.1, 0, g);
      for (const [pw, pd, px, pz] of [[w, 0.25, 0, d / 2], [w, 0.25, 0, -d / 2], [0.25, d, w / 2, 0], [0.25, d, -w / 2, 0]])
        place(wbox(pw, 0.9, pd, M.concrete), px, h + 0.45, pz, g);
      place(wbox(1.4, 1, 1, M.tin), w * 0.2, h + 0.7, d * 0.1, g); // rooftop AC unit
    }
    const merged = mergeByMaterial(g);
    merged.position.set(x, 0, z); merged.rotation.y = ry;
    this.addSolid(merged);
  }
  hangar(x, z, ry, w = 26, l = 34) {
    const g = new THREE.Group(), r = w / 2, s = M.tin.userData.texSize;
    place(wbox(w, 4, l, M.tin), 0, 2, 0, g);
    const cg = new THREE.CylinderGeometry(r, r, l, 28, 1, true, -Math.PI / 2, Math.PI);
    const uv = cg.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * r / s, uv.getY(i) * l / s);
    const roof = new THREE.Mesh(cg, M.tin); roof.material.side = THREE.DoubleSide; roof.rotation.x = Math.PI / 2; roof.scale.z = 0.45; roof.position.y = 4; g.add(roof);
    const merged = mergeByMaterial(g);
    // dark doorway
    const door = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.7, 6), new THREE.MeshBasicMaterial({ color: 0x0b0b0b }));
    door.position.set(0, 3, l / 2 + 0.05); merged.add(door);
    merged.position.set(x, 0, z); merged.rotation.y = ry;
    this.addSolid(merged);
  }
  layoutTown() {
    const walls = [M.plaster, M.plaster2, M.brick, M.redBrick, M.plaster, M.concrete];
    const frames = [M.frame, M.darkFrame];
    // houses lining both main roads
    for (let t = -150; t <= 150; t += 22) {
      if (Math.abs(t) < 14) continue;
      for (const side of [-1, 1]) {
        if (rand() < 0.18) continue;
        const floors = rand() < 0.25 ? 3 : rand() < 0.6 ? 2 : 1;
        const o = { w: 9 + rand() * 4, d: 8 + rand() * 3, floors, wall: pick(walls), frame: pick(frames), roof: floors === 3 || rand() < 0.2 ? 'flat' : 'gable' };
        const off = 9 + o.d / 2 + rand() * 3;
        // along N–S road: front faces the road
        this.house(side * off, t + (rand() - 0.5) * 4, side > 0 ? -Math.PI / 2 : Math.PI / 2, o);
        if (rand() < 0.8 && Math.abs(t) < 120) {
          const o2 = { ...o, wall: pick(walls), floors: Math.max(1, floors - (rand() < 0.5 ? 1 : 0)) };
          this.house(t + (rand() - 0.5) * 4, side * off, side > 0 ? Math.PI : 0, o2);
        }
      }
    }
    // airfield hangars
    this.hangar(222, -95, -Math.PI / 2);
    this.hangar(222, 20, -Math.PI / 2, 22, 28);
    // sandbag / concrete cover near the crossroads
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2 + 0.4, b = wbox(3.2, 1.1, 0.9, M.concrete);
      b.position.set(Math.cos(a) * 20 + 0.1, 0.55, Math.sin(a) * 20); b.rotation.y = -a;
      if (Math.abs(b.position.x) > 5 && Math.abs(b.position.z) > 5) this.addSolid(b);
    }
  }

  // ---------- downloaded buildings ----------
  async loadScannedBuildings() {
    const [cabin, barn] = await Promise.all([
      loadGLTF('assets/bld/cabin.glb').catch(() => null),
      new ColladaLoader().loadAsync('assets/bld/barn/barn.dae').catch(() => null),
    ]);
    const fit = (obj, targetLen) => {
      const b = new THREE.Box3().setFromObject(obj), s = b.getSize(new THREE.Vector3());
      obj.scale.multiplyScalar(targetLen / Math.max(s.x, s.z));
      const b2 = new THREE.Box3().setFromObject(obj), c = b2.getCenter(new THREE.Vector3());
      obj.position.sub(new THREE.Vector3(c.x, b2.min.y, c.z));
      const wrap = new THREE.Group(); wrap.add(obj); return wrap;
    };
    if (cabin) {
      const spots = [[-70, 95, 0.3], [-95, 55, 2.1], [-55, 125, -1.2], [60, 150, 1.4], [-120, -60, 0.8]];
      for (const [x, z, r] of spots) {
        const c = fit(cabin.scene.clone(true), 9); c.position.set(x, 0, z); c.rotation.y = r; this.addSolid(c);
      }
    }
    if (barn) {
      const woodMap = tex('assets/bld/barn/wood_diff.png', true), strawMap = tex('assets/bld/barn/straw_diff.png', true);
      const woodN = tex('assets/bld/barn/wood_nor.png'), strawN = tex('assets/bld/barn/straw_nor.png');
      barn.scene.traverse(o => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const repl = mats.map(m => /straw/i.test(m.name)
          ? new THREE.MeshStandardMaterial({ map: strawMap, normalMap: strawN, roughness: 1 })
          : new THREE.MeshStandardMaterial({ map: woodMap, normalMap: woodN, roughness: 0.9 }));
        o.material = Array.isArray(o.material) ? repl : repl[0];
      });
      for (const [x, z, r] of [[-110, 110, 0.5], [-140, 30, -1.1], [90, -150, 2.4]]) {
        const b = fit(barn.scene.clone(true), 16); b.position.set(x, 0, z); b.rotation.y = r; this.addSolid(b);
      }
    }
  }

  async loadProps() {
    const names = ['old_military_crate', 'Barrel_01', 'concrete_road_barrier', 'covered_car', 'boulder_01', 'old_tyre', 'metal_trash_can'];
    const loaded = {};
    await Promise.all(names.map(async n => { try { loaded[n] = (await loadGLTF(`assets/props/${n}/${n}.gltf`)).scene; } catch { } }));
    const put = (n, x, z, ry = rand() * 6.28, s = 1, collide = true) => {
      if (!loaded[n]) return; const o = loaded[n].clone(true); o.position.set(x, 0, z); o.rotation.y = ry; o.scale.setScalar(s); this.addSolid(o, collide);
    };
    // military supply points
    for (const [cx, cz] of [[14, 14], [-16, -18], [205, -10], [30, -60], [-40, 30]]) {
      for (let i = 0; i < 5; i++) put('old_military_crate', cx + (rand() - .5) * 6, cz + (rand() - .5) * 6, rand() * 6.28, 1.3);
      for (let i = 0; i < 4; i++) put('Barrel_01', cx + (rand() - .5) * 8, cz + (rand() - .5) * 8);
    }
    // road blocks + cars
    for (const [x, z, r] of [[0, 40, 0], [2.5, 40, 0], [-2.5, 40, 0], [60, 0, 1.57], [60, 2.5, 1.57], [0, -95, 0], [-2.8, -95, 0]]) put('concrete_road_barrier', x, z, r);
    for (const [x, z, r] of [[5.5, 70, 0.05], [-5.5, -40, 3.1], [30, 5.6, 1.6], [-80, -5.5, -1.5], [210, -60, 0.4], [5.8, -120, 0.1]]) put('covered_car', x, z, r);
    for (let i = 0; i < 12; i++) put('old_tyre', (rand() - .5) * 200, (rand() - .5) * 200, rand() * 6, 1, false);
    for (let i = 0; i < 10; i++) put('metal_trash_can', (rand() > .5 ? 1 : -1) * (5 + rand()), (rand() - .5) * 200);
    for (let i = 0; i < 10; i++) {
      const a = rand() * 6.28, r = 50 + rand() * 200, x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.abs(x - 170) < 30 || Math.abs(x) < 8 || Math.abs(z) < 8) continue;
      put('boulder_01', x, z, rand() * 6.28, 1 + rand() * 2.5);
    }
  }

  async loadAircraft() {
    const fbx = new FBXLoader();
    const [an2, an2crash, hawk] = await Promise.all([
      fbx.loadAsync('assets/air/an2/an2.fbx').catch(() => null),
      fbx.loadAsync('assets/air/an2/an2_crashed.fbx').catch(() => null),
      loadGLTF('assets/air/globalhawk.glb').catch(() => null),
    ]);
    const fit = (obj, span) => {
      const b = new THREE.Box3().setFromObject(obj), s = b.getSize(new THREE.Vector3());
      obj.scale.multiplyScalar(span / Math.max(s.x, s.y, s.z));
      const b2 = new THREE.Box3().setFromObject(obj), c = b2.getCenter(new THREE.Vector3());
      obj.position.sub(new THREE.Vector3(c.x, b2.min.y, c.z));
      const w = new THREE.Group(); w.add(obj); return w;
    };
    const skin = (obj, png) => {
      const map = tex(png, true); map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping; map.flipY = true;
      obj.traverse(o => { if (o.isMesh) o.material = new THREE.MeshStandardMaterial({ map, roughness: 0.55, metalness: 0.35 }); });
    };
    if (an2) {
      skin(an2, 'assets/air/an2/An2Tex.png');
      const a = fit(an2, 18.2); a.position.set(215, 0, -30); a.rotation.y = -2.4; this.addSolid(a);
      this.an2 = an2;
      // the transport "drop plane" flying over the map
      const flyer = fit(an2.clone(true), 18.2); flyer.traverse(o => { if (o.isMesh) o.castShadow = true; });
      this.scene.add(flyer); this.flyers.push({ obj: flyer, speed: 55, alt: 140, t: 0.15, heading: 0.35, span: 1400, kind: 'an2' });
    }
    if (an2crash) {
      skin(an2crash, 'assets/air/an2/An2Tex_crashed.png');
      const c = fit(an2crash, 18.2); c.position.set(-150, 0, -120); c.rotation.set(0, 0.9, 0.05); this.addSolid(c);
    }
    if (hawk) {
      const h = fit(hawk.scene, 35); this.scene.add(h);
      h.traverse(o => { if (o.isMesh) o.castShadow = true; });
      this.flyers.push({ obj: h, speed: 80, alt: 230, t: 0.6, heading: -1.9, span: 1800, kind: 'hawk' });
    }
  }

  plantTrees() {
    const presets = ['Oak Medium', 'Pine Medium', 'Aspen Medium', 'Ash Medium', 'Oak Large', 'Pine Large'];
    const variants = presets.map((p, i) => {
      const t = new Tree(); t.loadPreset(p); t.options.seed = 100 + i * 17; t.generate();
      t.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      const b = new THREE.Box3().setFromObject(t), h = b.max.y - b.min.y;
      const target = /Large/.test(p) ? 16 : 11;
      t.scale.setScalar(target / h);
      this.trees.push(t); return t;
    });
    const ok = (x, z) => {
      if (Math.abs(x) < 12 || Math.abs(z) < 12) return false;          // roads
      if (x > 135 && x < 260 && z > -215 && z < 215) return false;      // airfield
      for (const b of this.colliders) if (x > b.min.x - 3 && x < b.max.x + 3 && z > b.min.z - 3 && z < b.max.z + 3) return false;
      return true;
    };
    let placed = 0, tries = 0;
    while (placed < 150 && tries++ < 6000) {
      const a = rand() * 6.28, r = 18 + Math.pow(rand(), 1.3) * 300, x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!ok(x, z)) continue;
      const v = variants[placed % variants.length];
      const t = placed < variants.length ? v : v.clone(true);
      t.position.set(x, 0, z); t.rotation.y = rand() * 6.28; t.scale.multiplyScalar(placed < variants.length ? 1 : 0.8 + rand() * 0.45);
      this.scene.add(t);
      // trunk collider (small) + hit mesh
      this.colliders.push(new THREE.Box3(new THREE.Vector3(x - 0.5, 0, z - 0.5), new THREE.Vector3(x + 0.5, 6, z + 0.5)));
      t.traverse(o => { if (o.isMesh && o.name !== 'leaves' && o.material?.name !== 'leaves') this.solids.push(o); });
      placed++;
    }
  }

  update(t, dt, sfx, camPos) {
    for (const tr of this.trees) tr.update?.(t);
    for (const f of this.flyers) {
      f.t = (f.t + dt * f.speed / f.span) % 1;
      const s = (f.t - 0.5) * f.span, dx = Math.sin(f.heading), dz = Math.cos(f.heading);
      f.obj.position.set(dx * s + dz * 60, f.alt, dz * s - dx * 60);
      f.obj.rotation.set(0, f.heading + (f.kind === 'an2' ? Math.PI / 2 : 0), 0);
      if (sfx) {
        if (!f.engine) f.engine = sfx.engine();
        const d = f.obj.position.distanceTo(camPos);
        f.engine.set(f.obj.position, THREE.MathUtils.clamp(1.6 - d / 900, 0, 1) * (f.kind === 'an2' ? 1 : 0.5));
      }
    }
  }
}
