import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const V = () => new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _a = V(), _b = V(), _c = V();

// ---------- bone helpers (all in world space) ----------
function rotateWorld(bone, dq) {
  bone.getWorldQuaternion(_q); _q.premultiply(dq);
  bone.parent.getWorldQuaternion(_q2).invert();
  bone.quaternion.copy(_q2.multiply(_q)); bone.updateMatrixWorld(true);
}
function setWorldQuat(bone, q) {
  bone.parent.getWorldQuaternion(_q2).invert();
  bone.quaternion.copy(_q2.multiply(q)); bone.updateMatrixWorld(true);
}
function pointBone(bone, childWorld, target) {
  bone.getWorldPosition(_a);
  const from = _b.copy(childWorld).sub(_a), to = _c.copy(target).sub(_a);
  if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return;
  rotateWorld(bone, new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize()));
}
function twoBoneIK(upper, lower, end, target, pole) {
  const a = upper.getWorldPosition(V()), b = lower.getWorldPosition(V()), c = end.getWorldPosition(V());
  const l1 = a.distanceTo(b), l2 = b.distanceTo(c);
  const toT = target.clone().sub(a), dist = THREE.MathUtils.clamp(toT.length(), 0.05, (l1 + l2) * 0.999), dir = toT.normalize();
  const cosA = THREE.MathUtils.clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
  const pOrtho = ortho(pole, dir);
  const elbow = a.clone().addScaledVector(dir, cosA * l1).addScaledVector(pOrtho, sinA * l1);
  pointBone(upper, b, elbow);
  pointBone(lower, end.getWorldPosition(V()), a.clone().addScaledVector(dir, dist));
}
// rotation that maps frame (f1,s1) onto frame (f2,s2)
function frameQuat(f1, s1, f2, s2) {
  const m1 = new THREE.Matrix4().makeBasis(f1, s1, f1.clone().cross(s1));
  const m2 = new THREE.Matrix4().makeBasis(f2, s2, f2.clone().cross(s2));
  return new THREE.Quaternion().setFromRotationMatrix(m2.multiply(m1.transpose()));
}
// component of v perpendicular to n (never returns a zero/NaN vector)
function ortho(v, n) {
  const r = v.clone().sub(n.clone().multiplyScalar(v.dot(n)));
  if (r.lengthSq() < 1e-8) r.copy(Math.abs(n.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0)).sub(n.clone().multiplyScalar(n.y));
  return r.normalize();
}
const finiteQ = q => Number.isFinite(q.x + q.y + q.z + q.w);

// ---------- weapon ----------
// Wraps a rifle model so its frame is: origin at butt-stock on bore line, +Z = barrel, +Y = up.
export function makeRifle(src, { rot = [0, 0, 0], length = 0.86, boreFrac = 0.72, gripFrac = 0.36, foreFrac = 0.62 }) {
  const inner = src.clone(true);
  inner.rotation.set(...rot);
  const pivot = new THREE.Group(); pivot.add(inner);
  let b = new THREE.Box3().setFromObject(pivot); const s = b.getSize(V());
  inner.scale.multiplyScalar(length / s.z);
  pivot.updateMatrixWorld(true); b = new THREE.Box3().setFromObject(pivot);
  const h = b.max.y - b.min.y;
  const boreY = b.min.y + h * boreFrac;
  inner.position.sub(new THREE.Vector3((b.min.x + b.max.x) / 2, boreY, b.min.z));
  inner.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  const L = length;
  return {
    obj: pivot, L,
    grip: new THREE.Vector3(0, -h * 0.34, L * gripFrac),
    fore: new THREE.Vector3(0, -h * 0.2, L * foreFrac),
    muzzle: new THREE.Vector3(0, 0, L + 0.02),
    ejector: new THREE.Vector3(-0.03, 0, L * 0.42),
  };
}

// ---------- operator (player or bot) ----------
export class Operator {
  constructor(gltf, rifleProto, scene, { tint = null } = {}) {
    this.root = SkeletonUtils.clone(gltf.scene);
    this.root.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
        if (tint) { o.material = o.material.clone(); o.material.color.multiply(new THREE.Color(tint)); }
      }
    });
    // measure height from the head bone (skinned-mesh bounding boxes are unreliable before the first frame)
    this.root.updateMatrixWorld(true);
    const headY = this.root.getObjectByName('mixamorigHeadTop_End')?.getWorldPosition(V()).y || 1.8;
    this.root.scale.multiplyScalar(1.8 / headY);
    this.root.rotation.y = Math.PI; // model is authored facing -Z
    this.group = new THREE.Group(); this.group.add(this.root); scene.add(this.group);

    this.mixer = new THREE.AnimationMixer(this.root);
    this.actions = {};
    for (const c of gltf.animations) this.actions[c.name] = this.mixer.clipAction(c);
    this.current = null;

    const bone = n => this.root.getObjectByName('mixamorig' + n);
    this.b = {
      hips: bone('Hips'), spine: [bone('Spine'), bone('Spine1'), bone('Spine2')], neck: bone('Neck'), head: bone('Head'),
      rArm: bone('RightArm'), rFore: bone('RightForeArm'), rHand: bone('RightHand'),
      lArm: bone('LeftArm'), lFore: bone('LeftForeArm'), lHand: bone('LeftHand'),
      lFoot: bone('LeftFoot'), rFoot: bone('RightFoot'),
    };
    this.fingers = { R: {}, L: {} };
    for (const side of ['Right', 'Left']) for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'])
      this.fingers[side[0]][f] = [1, 2, 3].map(i => bone(`${side}Hand${f}${i}`));

    // calibrate hand frames from the T-pose: finger direction + thumb-side direction
    this.actions.TPose.play(); this.mixer.update(0); this.root.updateMatrixWorld(true);
    this.handRest = {};
    for (const S of ['R', 'L']) {
      const hand = S === 'R' ? this.b.rHand : this.b.lHand, F = this.fingers[S];
      const hp = hand.getWorldPosition(V()), mid = F.Middle[0].getWorldPosition(V());
      const idx = F.Index[0].getWorldPosition(V()), pky = F.Pinky[0].getWorldPosition(V());
      const f = mid.sub(hp).normalize(), s = ortho(idx.sub(pky), f);
      this.handRest[S] = { f, s, q: hand.getWorldQuaternion(new THREE.Quaternion()), palmLen: hp.distanceTo(F.Middle[0].getWorldPosition(V())) };
    }
    this.actions.TPose.stop();

    this.rifle = rifleProto; this.gun = rifleProto.obj.clone(true); scene.add(this.gun);
    this.aimBlend = 0; this.recoil = 0; this.recoilSide = 0; this.dead = false; this.fall = 0;
    this.footY = { l: 1, r: 1 }; this.stepCb = null;
    this.play('Idle');
  }
  play(name, fade = 0.25, timeScale = 1) {
    const a = this.actions[name]; if (!a) return;
    a.timeScale = timeScale;
    if (this.current === a) return;
    a.reset().setEffectiveWeight(1).fadeIn(fade).play();
    if (this.current) this.current.fadeOut(fade);
    this.current = a;
  }
  get position() { return this.group.position; }
  chest() { return this.b.spine[2].getWorldPosition(V()); }
  muzzleWorld() { return this.gun.localToWorld(this.rifle.muzzle.clone()); }
  barrelDir() { return new THREE.Vector3(0, 0, 1).applyQuaternion(this.gun.quaternion); }

  // aimPoint: world target. aim: 0..1 (low-ready → shouldered). twist: hips yaw offset for strafing.
  update(dt, { aimPoint, aim = 0, twist = 0, bodyYaw }) {
    this.mixer.update(dt);
    if (!this.dead) this.group.rotation.y = bodyYaw;
    this.root.updateMatrixWorld(true);
    if (this.dead) { this.updateDeath(dt); return; }

    this.aimBlend += (aim - this.aimBlend) * (1 - Math.exp(-dt * 14));
    this.recoil *= Math.exp(-dt * 16);

    // 1) hips twist (strafe) and spine counter-twist + pitch toward target
    if (twist) rotateWorld(this.b.hips, new THREE.Quaternion().setFromAxisAngle(UP, twist));
    const chest = this.chest();
    const toT = aimPoint.clone().sub(chest);
    const flat = Math.hypot(toT.x, toT.z);
    const pitch = Math.atan2(toT.y, flat);
    const yawTarget = Math.atan2(toT.x, toT.z);
    let yawDelta = yawTarget - (bodyYaw + twist);
    yawDelta = Math.atan2(Math.sin(yawDelta), Math.cos(yawDelta));
    yawDelta = THREE.MathUtils.clamp(yawDelta, -1.2, 1.2);
    for (const sb of this.b.spine) rotateWorld(sb, new THREE.Quaternion().setFromAxisAngle(UP, yawDelta / 3));
    const bodyFwd = new THREE.Vector3(Math.sin(yawTarget), 0, Math.cos(yawTarget));
    const bodyRight = bodyFwd.clone().cross(UP).normalize();
    const pitchK = 0.55 + 0.45 * this.aimBlend;
    for (const sb of this.b.spine) rotateWorld(sb, new THREE.Quaternion().setFromAxisAngle(bodyRight, pitch * pitchK / 3));

    // 2) place the rifle: stock in shoulder pocket, barrel toward aim point (shouldered) or angled down (low ready)
    const shoulder = this.b.rArm.getWorldPosition(V());
    const D = aimPoint.clone().sub(shoulder).normalize();
    const R = D.clone().cross(UP).normalize(), U = R.clone().cross(D).normalize();
    const low = D.clone().applyAxisAngle(R, -0.62).applyAxisAngle(UP, 0.42).normalize();
    const dir = low.lerp(D, this.aimBlend).normalize();
    dir.applyAxisAngle(R, this.recoil * 0.09).applyAxisAngle(U, this.recoilSide * this.recoil * 0.03);
    const dR = dir.clone().cross(UP).normalize(), dU = dR.clone().cross(dir).normalize();
    const buttAim = shoulder.clone().addScaledVector(D, 0.04).addScaledVector(R, -0.11).addScaledVector(U, 0.03);
    const buttLow = shoulder.clone().addScaledVector(D, 0.1).addScaledVector(R, -0.14).addScaledVector(U, -0.13);
    const butt = buttLow.lerp(buttAim, this.aimBlend).addScaledVector(dir, -0.06 * this.recoil);
    const basis = new THREE.Matrix4().makeBasis(dU.clone().cross(dir), dU, dir);
    this.gun.quaternion.setFromRotationMatrix(basis);
    this.gun.position.copy(butt);
    this.gun.updateMatrixWorld(true);

    // 3) IK both arms onto the weapon + orient hands + curl fingers
    const armBones = [this.b.rArm, this.b.rFore, this.b.rHand, this.b.lArm, this.b.lFore, this.b.lHand];
    const saved = armBones.map(b => b.quaternion.clone());
    const gX = new THREE.Vector3(1, 0, 0).applyQuaternion(this.gun.quaternion); // gun's left
    const gR = gX.clone().negate();
    const grip = this.gun.localToWorld(this.rifle.grip.clone());
    const fore = this.gun.localToWorld(this.rifle.fore.clone());
    // right hand: fingers wrap forward/down around pistol grip, thumb side up, palm faces left
    const rf = dir.clone().multiplyScalar(0.55).addScaledVector(dU, -0.75).addScaledVector(gR, -0.2).normalize();
    const rs = ortho(dU.clone().addScaledVector(dir, 0.3), rf);
    this.placeHand('R', grip, rf, rs, dR.clone().multiplyScalar(0.5).addScaledVector(dU, -1), gR.clone().multiplyScalar(0.035));
    // left hand: under the handguard, fingers wrapping up the right side, thumb on the left
    const lf = gR.clone().multiplyScalar(0.55).addScaledVector(dir, 0.55).addScaledVector(dU, 0.35).normalize();
    const ls = ortho(dir.clone().addScaledVector(dU, 0.4), lf);
    this.placeHand('L', fore, lf, ls, dR.clone().multiplyScalar(-0.6).addScaledVector(dU, -1), dU.clone().multiplyScalar(-0.035));
    this.curl('R', [0.95, 1.1, 0.7], 0.45);
    this.curl('L', [0.9, 1.0, 0.6], 0.3);
    if (!armBones.every(b => finiteQ(b.quaternion))) { armBones.forEach((b, i) => b.quaternion.copy(saved[i])); this.root.updateMatrixWorld(true); }

    // 4) footstep detection from foot height
    for (const [k, foot] of [['l', this.b.lFoot], ['r', this.b.rFoot]]) {
      const y = foot.getWorldPosition(V()).y - this.group.position.y;
      if (this.footY[k] > 0.16 && y <= 0.13 && this.stepCb) this.stepCb(k);
      this.footY[k] = y;
    }
  }
  placeHand(S, target, f, s, pole, palmOffset) {
    const rest = this.handRest[S];
    const arm = S === 'R' ? [this.b.rArm, this.b.rFore, this.b.rHand] : [this.b.lArm, this.b.lFore, this.b.lHand];
    const wrist = target.clone().addScaledVector(f, -rest.palmLen * 0.85).add(palmOffset);
    twoBoneIK(arm[0], arm[1], arm[2], wrist, pole.normalize());
    const q = frameQuat(rest.f, rest.s, f, s).multiply(rest.q.clone());
    setWorldQuat(arm[2], q);
  }
  curl(S, [a, b, c], trigger) {
    const hand = S === 'R' ? this.b.rHand : this.b.lHand, F = this.fingers[S];
    const rest = this.handRest[S];
    // curl axis = thumb-side direction of the hand in world (rotating about it bends fingers toward the palm)
    const hq = hand.getWorldQuaternion(new THREE.Quaternion());
    const axis = rest.s.clone().applyQuaternion(rest.q.clone().invert()).applyQuaternion(hq).normalize();
    const sign = S === 'R' ? 1 : -1;
    for (const name of ['Index', 'Middle', 'Ring', 'Pinky']) {
      const k = name === 'Index' && S === 'R' ? trigger : 1;
      F[name].forEach((bn, i) => bn && rotateWorld(bn, new THREE.Quaternion().setFromAxisAngle(axis, sign * [a, b, c][i] * k)));
    }
    const thumbAxis = rest.f.clone().applyQuaternion(rest.q.clone().invert()).applyQuaternion(hq).normalize();
    F.Thumb.forEach((bn, i) => bn && rotateWorld(bn, new THREE.Quaternion().setFromAxisAngle(thumbAxis, -sign * [0.35, 0.3, 0.2][i])));
  }
  kick() { this.recoil = Math.min(1.4, this.recoil + 1); this.recoilSide = Math.random() * 2 - 1; }

  die(fromDir) {
    if (this.dead) return;
    this.dead = true; this.fall = 0; this.deathYaw = this.group.rotation.y; this.fallAxis = fromDir.clone().cross(UP).normalize().negate();
    this.gunVel = new THREE.Vector3((Math.random() - .5) * 2, 2, (Math.random() - .5) * 2).addScaledVector(fromDir, 1.5);
    this.gunSpin = new THREE.Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    this.mixer.timeScale = 0;
  }
  updateDeath(dt) {
    if (this.fall < 1) {
      this.fall = Math.min(1, this.fall + dt * 2.2);
      const e = this.fall * this.fall;
      this.group.quaternion.setFromAxisAngle(this.fallAxis, e * Math.PI / 2 * 0.97)
        .multiply(new THREE.Quaternion().setFromAxisAngle(UP, this.deathYaw));
    }
    if (this.gun.position.y > 0.05) {
      this.gunVel.y -= 9.8 * dt; this.gun.position.addScaledVector(this.gunVel, dt);
      this.gun.rotation.x += this.gunSpin.x * dt; this.gun.rotation.z += this.gunSpin.z * dt;
      if (this.gun.position.y <= 0.05) { this.gun.position.y = 0.05; this.gun.rotation.set(Math.PI / 2, this.gun.rotation.y, 0); }
    }
  }
  revive(pos) {
    this.dead = false; this.mixer.timeScale = 1; this.group.quaternion.identity(); this.group.position.copy(pos);
  }
}
