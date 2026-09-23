// WebAudio sound engine: sample playback with pitch/volume jitter, 3D panning,
// an outdoor "slap-back" reverb send, and synthesized wind + aircraft drone.
const range = (p, n, pad = 3) => Array.from({ length: n }, (_, i) => `assets/sfx/${p}${String(i).padStart(pad, '0')}.mp3`);
const shots = (p, n) => Array.from({ length: n }, (_, i) => `assets/sfx/${p}_${i}.mp3`);

export const SOUND_BANK = {
  shot: shots('ar_near', 2),
  shotFar: shots('ar_far', 2),
  enemyShot: shots('ak_near', 4),
  enemyShotFar: shots('ak_far', 2),
  stepGrass: range('footstep_grass_', 5),
  stepConcrete: range('footstep_concrete_', 5),
  stepWood: range('footstep_wood_', 5),
  shell: range('impactMetal_light_', 3),
  hitWood: range('impactPlank_medium_', 3),
  hitGround: range('impactGeneric_light_', 3),
  hitRock: range('impactMining_', 3),
  hitFlesh: range('impactSoft_heavy_', 3),
  body: range('impactPunch_medium_', 3),
  reload: ['assets/sfx/reload.mp3'],
};

export class Sfx {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain(); this.master.gain.value = 0.9;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -10; comp.ratio.value = 6;
    this.master.connect(comp).connect(this.ctx.destination);
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.4, 3.2);
    this.reverbGain = this.ctx.createGain(); this.reverbGain.gain.value = 0.55;
    this.reverb.connect(this.reverbGain).connect(this.master);
    this.buffers = {};
    this.lastPlay = {};
  }
  impulse(seconds, decay) {
    const sr = this.ctx.sampleRate, len = sr * seconds, b = this.ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // sparse early reflections (buildings) + diffuse tail
        const early = (i % 2400 < 3 && t < 0.25) ? (Math.random() * 2 - 1) * 0.8 : 0;
        d[i] = (early + (Math.random() * 2 - 1) * 0.35) * Math.pow(1 - t, decay);
      }
    }
    return b;
  }
  async load(bank, onProgress) {
    const entries = Object.entries(bank); let done = 0; const total = entries.reduce((n, [, u]) => n + u.length, 0);
    await Promise.all(entries.map(async ([k, urls]) => {
      this.buffers[k] = await Promise.all(urls.map(async u => {
        try { const ab = await (await fetch(u)).arrayBuffer(); return await this.ctx.decodeAudioData(ab); }
        catch { return null; } finally { onProgress && onProgress(++done / total); }
      }));
      this.buffers[k] = this.buffers[k].filter(Boolean);
    }));
  }
  resume() { if (this.ctx.state !== 'running') this.ctx.resume(); }
  setListener(cam) {
    const l = this.ctx.listener, p = cam.position, t = this.ctx.currentTime;
    const f = cam.getWorldDirection(this._f || (this._f = cam.position.clone()));
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, .02); l.positionY.setTargetAtTime(p.y, t, .02); l.positionZ.setTargetAtTime(p.z, t, .02);
      l.forwardX.value = f.x; l.forwardY.value = f.y; l.forwardZ.value = f.z; l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else { l.setPosition(p.x, p.y, p.z); l.setOrientation(f.x, f.y, f.z, 0, 1, 0); }
  }
  play(name, { vol = 1, rate = 1, jitter = 0.06, pos = null, reverb = 0.15, minGap = 0, offset = 0 } = {}) {
    const list = this.buffers[name]; if (!list || !list.length || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    if (minGap && this.lastPlay[name] && now - this.lastPlay[name] < minGap) return;
    this.lastPlay[name] = now;
    const src = this.ctx.createBufferSource();
    src.buffer = list[(Math.random() * list.length) | 0];
    src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * jitter);
    const g = this.ctx.createGain(); g.gain.value = vol * (1 + (Math.random() * 2 - 1) * jitter * 0.5);
    let out = g;
    if (pos) {
      const p = this.ctx.createPanner();
      Object.assign(p, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 4, maxDistance: 800, rolloffFactor: 1.1 });
      if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } else p.setPosition(pos.x, pos.y, pos.z);
      g.connect(p); out = p;
    }
    src.connect(g); out.connect(this.master);
    if (reverb > 0) { const s = this.ctx.createGain(); s.gain.value = reverb; out.connect(s).connect(this.reverb); }
    src.start(now, offset);
    return src;
  }
  noiseBuffer(sec = 4) {
    const sr = this.ctx.sampleRate, b = this.ctx.createBuffer(1, sr * sec, sr), d = b.getChannelData(0);
    let last = 0; for (let i = 0; i < d.length; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    return b;
  }
  startWind() {
    const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuffer(6); src.loop = true;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 420; f.Q.value = 0.6;
    const g = this.ctx.createGain(); g.gain.value = 0.22;
    const lfo = this.ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lg = this.ctx.createGain(); lg.gain.value = 0.12; lfo.connect(lg).connect(g.gain);
    const lfo2 = this.ctx.createOscillator(); lfo2.frequency.value = 0.13;
    const lg2 = this.ctx.createGain(); lg2.gain.value = 180; lfo2.connect(lg2).connect(f.frequency);
    src.connect(f).connect(g).connect(this.master); src.start(); lfo.start(); lfo2.start();
  }
  // positional propeller/turbine drone for aircraft
  engine() {
    const ctx = this.ctx, out = ctx.createGain(); out.gain.value = 0;
    const p = ctx.createPanner(); Object.assign(p, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 60, rolloffFactor: 1, maxDistance: 3000 });
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuffer(5); n.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 74;
    const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 111;
    const og = ctx.createGain(); og.gain.value = 0.25;
    const am = ctx.createOscillator(); am.frequency.value = 18; const amg = ctx.createGain(); amg.gain.value = 0.12; am.connect(amg).connect(og.gain);
    o1.connect(og); o2.connect(og); og.connect(lp); n.connect(lp); lp.connect(out).connect(p).connect(this.master);
    [n, o1, o2, am].forEach(s => s.start());
    return {
      set(pos, vol) {
        if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } else p.setPosition(pos.x, pos.y, pos.z);
        out.gain.setTargetAtTime(vol, ctx.currentTime, 0.3);
      },
    };
  }
}
