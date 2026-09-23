import * as THREE from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';

function canvasTex(size, draw) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const flashTex = canvasTex(128, (g, s) => {
  const r = s / 2; g.translate(r, r);
  const grd = g.createRadialGradient(0, 0, 0, 0, 0, r);
  grd.addColorStop(0, 'rgba(255,255,230,1)'); grd.addColorStop(0.25, 'rgba(255,200,90,0.9)'); grd.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = grd;
  for (let i = 0; i < 7; i++) { g.rotate(Math.PI * 2 / 7); g.beginPath(); g.moveTo(0, -6); g.lineTo(r, 0); g.lineTo(0, 6); g.fill(); }
  g.beginPath(); g.arc(0, 0, r * 0.35, 0, Math.PI * 2); g.fill();
});
const puffTex = canvasTex(64, (g, s) => {
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,0.9)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, s, s);
});
const holeTex = canvasTex(64, (g, s) => {
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(10,8,6,1)'); grd.addColorStop(0.25, 'rgba(25,20,15,0.95)'); grd.addColorStop(0.5, 'rgba(60,50,40,0.5)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, s, s);
});

export class FX {
  constructor(scene) {
    this.scene = scene; this.items = []; this.decals = [];
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color: 0xffffff }));
    this.flash.scale.setScalar(0.5); this.flash.visible = false; scene.add(this.flash);
    this.flashSide = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.22), new THREE.MeshBasicMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide }));
    this.flashSide.visible = false; scene.add(this.flashSide);
    this.light = new THREE.PointLight(0xffb060, 0, 9, 2); scene.add(this.light);
    this.tracerGeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 5, 1, true); this.tracerGeo.rotateX(Math.PI / 2); this.tracerGeo.translate(0, 0, -0.5);
    this.tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd27a, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    this.shellGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.045, 6); this.shellGeo.rotateZ(Math.PI / 2);
    this.shellMat = new THREE.MeshStandardMaterial({ color: 0xc8a040, metalness: 1, roughness: 0.3 });
    this.holeMat = new THREE.MeshStandardMaterial({ map: holeTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, roughness: 1 });
    this.flashT = 0;
  }
  muzzle(pos, dir) {
    this.flash.position.copy(pos); this.flash.material.rotation = Math.random() * 6.28;
    this.flash.scale.setScalar(0.35 + Math.random() * 0.25); this.flash.visible = true;
    this.flashSide.position.copy(pos).addScaledVector(dir, 0.2);
    this.flashSide.lookAt(pos.clone().add(dir)); this.flashSide.rotateY(Math.PI / 2); this.flashSide.rotateX(Math.random() * 3);
    this.flashSide.visible = true;
    this.light.position.copy(pos); this.light.intensity = 30;
    this.flashT = 0.045;
    // gun smoke
    this.puff(pos.clone().addScaledVector(dir, 0.15), { color: 0xcfcfcf, size: 0.25, grow: 2.2, life: 0.9, vel: dir.clone().multiplyScalar(0.8).add(new THREE.Vector3(0, 0.3, 0)), opacity: 0.18 });
  }
  tracer(from, to, speed = 420) {
    const len = from.distanceTo(to); if (len < 1) return;
    const m = new THREE.Mesh(this.tracerGeo, this.tracerMat);
    m.position.copy(from); m.lookAt(to); m.scale.set(1, 1, Math.min(9, len));
    this.scene.add(m);
    this.items.push({ m, t: 0, life: len / speed, from: from.clone(), dir: to.clone().sub(from).normalize(), len, kind: 'tracer', speed });
  }
  puff(pos, { color = 0x9a8a70, size = 0.3, grow = 3, life = 1, vel = new THREE.Vector3(0, 0.6, 0), opacity = 0.5, grav = 0 } = {}) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, color, transparent: true, depthWrite: false, opacity }));
    s.position.copy(pos); s.scale.setScalar(size); this.scene.add(s);
    this.items.push({ m: s, t: 0, life, vel, grow, size, opacity, grav, kind: 'puff' });
  }
  spark(pos, normal) {
    for (let i = 0; i < 6; i++) {
      const v = normal.clone().multiplyScalar(2 + Math.random() * 3).add(new THREE.Vector3((Math.random() - .5) * 4, Math.random() * 3, (Math.random() - .5) * 4));
      this.puff(pos, { color: 0xffc070, size: 0.05, grow: 0, life: 0.18 + Math.random() * 0.15, vel: v, opacity: 1, grav: 9 });
    }
  }
  impact(hit, kind) {
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    const p = hit.point.clone().addScaledVector(n, 0.02);
    if (kind === 'flesh') {
      for (let i = 0; i < 4; i++) this.puff(p, { color: 0x7a0a0a, size: 0.12, grow: 1.5, life: 0.45, vel: n.clone().multiplyScalar(1.2).add(new THREE.Vector3((Math.random() - .5), Math.random() * 0.6, (Math.random() - .5))), opacity: 0.85, grav: 3 });
      return;
    }
    const col = kind === 'wood' ? 0x8a6a45 : kind === 'ground' ? 0x86775a : 0xb0aca4;
    for (let i = 0; i < 3; i++) this.puff(p, { color: col, size: 0.2, grow: 3.5, life: 0.9 + Math.random() * 0.5, vel: n.clone().multiplyScalar(1.3).add(new THREE.Vector3((Math.random() - .5) * 0.8, 0.5 + Math.random() * 0.6, (Math.random() - .5) * 0.8)), opacity: 0.55 });
    if (kind !== 'ground') this.spark(p, n);
    // bullet hole decal
    if (hit.object.geometry && hit.object.geometry.attributes.normal && kind !== 'ground') {
      try {
        const orient = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), n, new THREE.Vector3(0, 1, 0)));
        orient.z = Math.random() * 6.28;
        const s = 0.09 + Math.random() * 0.05;
        const d = new THREE.Mesh(new DecalGeometry(hit.object, hit.point, orient, new THREE.Vector3(s, s, 0.2)), this.holeMat);
        this.scene.add(d); this.decals.push(d);
        if (this.decals.length > 120) { const old = this.decals.shift(); this.scene.remove(old); old.geometry.dispose(); }
      } catch { }
    }
  }
  shell(pos, right, onLand) {
    const m = new THREE.Mesh(this.shellGeo, this.shellMat);
    m.position.copy(pos); this.scene.add(m);
    const vel = right.clone().multiplyScalar(2.2 + Math.random()).add(new THREE.Vector3(0, 2 + Math.random(), 0));
    this.items.push({ m, t: 0, life: 3, vel, kind: 'shell', spin: new THREE.Vector3(Math.random() * 30, Math.random() * 30, 0), landed: false, onLand });
  }
  update(dt) {
    if (this.flashT > 0) { this.flashT -= dt; if (this.flashT <= 0) { this.flash.visible = this.flashSide.visible = false; } }
    this.light.intensity *= Math.exp(-dt * 40);
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]; it.t += dt;
      if (it.kind === 'tracer') {
        const d = Math.min(it.len, it.t * it.speed);
        it.m.position.copy(it.from).addScaledVector(it.dir, d);
      } else if (it.kind === 'puff') {
        it.vel.y -= it.grav * dt; it.vel.multiplyScalar(Math.exp(-dt * 1.5));
        it.m.position.addScaledVector(it.vel, dt);
        it.m.scale.setScalar(it.size * (1 + it.grow * it.t / it.life));
        it.m.material.opacity = it.opacity * (1 - it.t / it.life);
      } else if (it.kind === 'shell') {
        if (!it.landed) {
          it.vel.y -= 9.8 * dt; it.m.position.addScaledVector(it.vel, dt);
          it.m.rotation.x += it.spin.x * dt; it.m.rotation.y += it.spin.y * dt;
          if (it.m.position.y < 0.01) {
            it.m.position.y = 0.01;
            if (Math.abs(it.vel.y) > 1.2) { it.vel.y *= -0.35; it.vel.x *= 0.5; it.vel.z *= 0.5; it.onLand && it.onLand(it.m.position); }
            else it.landed = true;
          }
        }
      }
      if (it.t >= it.life) {
        this.scene.remove(it.m); if (it.kind === 'puff') it.m.material.dispose();
        this.items.splice(i, 1);
      }
    }
  }
}
