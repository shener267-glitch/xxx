import { AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, Color, NormalBlending, Points, ShaderMaterial, Texture, Vector3 } from 'three';
import type { Matrix4, Object3D } from 'three';
import type { QualityLevel } from '../core/settings';
import type { Vec3 } from '../core/types';

/**
 * パーティクル (炎・煙・火花・爆発・雨・雪など)。
 * 粒は CPU で動かし、描画は1回の Points で行う (スマホでも軽い)。
 * 粒はワールド座標で動くので、発生源が動いても煙がたなびくように残る。
 */

export type ParticlePreset = 'fire' | 'smoke' | 'sparks' | 'explosion' | 'rain' | 'snow' | 'magic' | 'confetti';

export interface ParticleSettings {
  preset: ParticlePreset;
  /** 1秒あたりに出す数 (0 = 連続では出さない) */
  rate: number;
  /** 一度に出す数 (爆発など) */
  burst: number;
  /** くり返し出し続ける */
  loop: boolean;
  lifetime: number;
  speed: number;
  /** 飛び散る角度 (0 = まっすぐ上、180 = 全方向) */
  spread: number;
  /** 上向きが正の加速度 (m/s²)。煙は上へ、火花は下へ */
  gravity: number;
  size: number;
  sizeEnd: number;
  color: string;
  colorEnd: string;
  opacity: number;
  additive: boolean;
  /** 発生する範囲 (箱の大きさ) */
  area: Vec3;
  /** ゆらゆら動く強さ */
  turbulence: number;
}

export const PARTICLE_PRESETS: Record<ParticlePreset, { label: string; settings: ParticleSettings }> = {
  fire: {
    label: '炎',
    settings: { preset: 'fire', rate: 60, burst: 0, loop: true, lifetime: 0.9, speed: 1.6, spread: 18, gravity: 1.5, size: 0.55, sizeEnd: 0.1, color: '#ffd35a', colorEnd: '#ff3b12', opacity: 0.9, additive: true, area: [0.35, 0.05, 0.35], turbulence: 0.6 },
  },
  smoke: {
    label: '煙',
    settings: { preset: 'smoke', rate: 14, burst: 0, loop: true, lifetime: 3.2, speed: 0.9, spread: 20, gravity: 0.35, size: 0.5, sizeEnd: 1.8, color: '#9a9a9a', colorEnd: '#4a4a4a', opacity: 0.45, additive: false, area: [0.3, 0.05, 0.3], turbulence: 0.5 },
  },
  sparks: {
    label: '火花',
    settings: { preset: 'sparks', rate: 40, burst: 0, loop: true, lifetime: 0.8, speed: 4, spread: 60, gravity: -9, size: 0.12, sizeEnd: 0.02, color: '#fff2a8', colorEnd: '#ff7a1a', opacity: 1, additive: true, area: [0.05, 0.05, 0.05], turbulence: 0 },
  },
  explosion: {
    label: '爆発',
    settings: { preset: 'explosion', rate: 0, burst: 90, loop: false, lifetime: 0.9, speed: 6, spread: 180, gravity: -2, size: 0.7, sizeEnd: 0.05, color: '#fff0a0', colorEnd: '#ff3000', opacity: 1, additive: true, area: [0.3, 0.3, 0.3], turbulence: 0.3 },
  },
  rain: {
    label: '雨 (範囲)',
    settings: { preset: 'rain', rate: 220, burst: 0, loop: true, lifetime: 1.1, speed: 11, spread: 0, gravity: -9.8, size: 0.07, sizeEnd: 0.07, color: '#bcd7ff', colorEnd: '#bcd7ff', opacity: 0.7, additive: false, area: [10, 0.1, 10], turbulence: 0 },
  },
  snow: {
    label: '雪 (範囲)',
    settings: { preset: 'snow', rate: 70, burst: 0, loop: true, lifetime: 6, speed: 0.8, spread: 0, gravity: -0.4, size: 0.14, sizeEnd: 0.14, color: '#ffffff', colorEnd: '#ffffff', opacity: 0.9, additive: false, area: [10, 0.1, 10], turbulence: 0.8 },
  },
  magic: {
    label: 'キラキラ',
    settings: { preset: 'magic', rate: 30, burst: 0, loop: true, lifetime: 1.6, speed: 0.6, spread: 180, gravity: 0.4, size: 0.18, sizeEnd: 0.02, color: '#9ee7ff', colorEnd: '#c77dff', opacity: 1, additive: true, area: [0.8, 0.8, 0.8], turbulence: 0.8 },
  },
  confetti: {
    label: '紙吹雪',
    settings: { preset: 'confetti', rate: 0, burst: 120, loop: false, lifetime: 3, speed: 6, spread: 35, gravity: -3.5, size: 0.16, sizeEnd: 0.16, color: '#ff5c8a', colorEnd: '#5ce1ff', opacity: 1, additive: false, area: [0.2, 0.2, 0.2], turbulence: 1.2 },
  },
};

/** プリセットの値 + 上書き */
export function particleSettings(preset: ParticlePreset, override: Partial<ParticleSettings> = {}): ParticleSettings {
  const base = PARTICLE_PRESETS[preset] ?? PARTICLE_PRESETS.fire;
  return { ...base.settings, ...override, preset: base.settings.preset, area: [...(override.area ?? base.settings.area)] as Vec3 };
}

/** 画質ごとの1つの発生源あたりの最大数 */
export const MAX_PARTICLES: Record<QualityLevel, number> = { low: 150, medium: 400, high: 900 };

let dotTexture: Texture | null = null;

/** ふんわりした丸い粒の画像 */
function getDotTexture(): Texture {
  if (dotTexture) return dotTexture;
  if (typeof document === 'undefined') {
    // テストなど DOM の無い環境
    dotTexture = new Texture();
    return dotTexture;
  }
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.8)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  dotTexture = new CanvasTexture(c);
  return dotTexture;
}

const VERT = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
varying vec4 vColor;
uniform float uScale;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec4 vColor;
void main() {
  vec4 t = texture2D(uMap, gl_PointCoord);
  float a = t.a * vColor.a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor.rgb * t.rgb, a);
}`;

const _c1 = new Color();
const _c2 = new Color();
const _hsl = new Color();
const _v = new Vector3();

export class ParticleEmitter {
  readonly points: Points;
  private settings: ParticleSettings;
  private max: number;
  private count = 0;
  private pos: Float32Array;
  private vel: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private seed: Float32Array;
  private sizes: Float32Array;
  private colors: Float32Array;
  private geometry: BufferGeometry;
  private material: ShaderMaterial;
  private acc = 0;
  private time = 0;
  /** 連続して出すのを止めた (残っている粒は最後まで動く) */
  stopped = false;
  private burstPending = 0;

  constructor(settings: ParticleSettings, maxParticles: number) {
    this.settings = settings;
    this.max = Math.max(8, Math.floor(maxParticles));
    this.pos = new Float32Array(this.max * 3);
    this.vel = new Float32Array(this.max * 3);
    this.age = new Float32Array(this.max);
    this.life = new Float32Array(this.max);
    this.seed = new Float32Array(this.max);
    this.sizes = new Float32Array(this.max);
    this.colors = new Float32Array(this.max * 4);
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.geometry.setAttribute('aSize', new BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute('aColor', new BufferAttribute(this.colors, 4));
    this.geometry.setDrawRange(0, 0);
    this.material = new ShaderMaterial({
      uniforms: { uMap: { value: getDotTexture() }, uScale: { value: 600 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: settings.additive ? AdditiveBlending : NormalBlending,
    });
    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.points.name = '__particles';
    this.points.userData.isParticles = true;
    if (settings.burst > 0) this.burstPending = settings.burst;
  }

  get alive(): number {
    return this.count;
  }

  /** 画面の高さに合わせて粒の大きさを調整する */
  setViewportHeight(h: number, fovDeg = 60): void {
    this.material.uniforms.uScale.value = h / (2 * Math.tan(((fovDeg * Math.PI) / 180) / 2));
  }

  /** 一度にまとめて出す */
  burst(n = this.settings.burst || 40): void {
    this.burstPending += n;
  }

  /** 出し終わって粒も残っていない (使い捨ての発生源の片付け用) */
  get finished(): boolean {
    return (this.stopped || (!this.settings.loop && this.settings.rate <= 0)) && this.burstPending === 0 && this.count === 0;
  }

  private spawn(origin: Matrix4): void {
    if (this.count >= this.max) return;
    const s = this.settings;
    const i = this.count++;
    const e = origin.elements;
    // 発生範囲 (ローカル) からワールドへ
    const lx = (Math.random() - 0.5) * s.area[0];
    const ly = (Math.random() - 0.5) * s.area[1];
    const lz = (Math.random() - 0.5) * s.area[2];
    _v.set(lx, ly, lz).applyMatrix4(origin);
    this.pos[i * 3] = _v.x;
    this.pos[i * 3 + 1] = _v.y;
    this.pos[i * 3 + 2] = _v.z;
    // 向き: 発生源の上方向を中心に spread の範囲へ
    const spread = (Math.min(180, Math.max(0, s.spread)) * Math.PI) / 180;
    const cosT = 1 - Math.random() * (1 - Math.cos(spread));
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = Math.random() * Math.PI * 2;
    const speed = s.speed * (0.6 + Math.random() * 0.8);
    // ローカルの上方向 (Y) を発生源の回転で傾ける (拡大の影響は除く)
    _v.set(sinT * Math.cos(phi), cosT, sinT * Math.sin(phi));
    const x = _v.x * e[0] + _v.y * e[4] + _v.z * e[8];
    const y = _v.x * e[1] + _v.y * e[5] + _v.z * e[9];
    const z = _v.x * e[2] + _v.y * e[6] + _v.z * e[10];
    const len = Math.hypot(x, y, z) || 1;
    this.vel[i * 3] = (x / len) * speed;
    this.vel[i * 3 + 1] = (y / len) * speed;
    this.vel[i * 3 + 2] = (z / len) * speed;
    this.age[i] = 0;
    this.life[i] = s.lifetime * (0.7 + Math.random() * 0.6);
    this.seed[i] = Math.random() * 100;
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    for (let k = 0; k < 3; k++) {
      this.pos[i * 3 + k] = this.pos[last * 3 + k];
      this.vel[i * 3 + k] = this.vel[last * 3 + k];
    }
    this.age[i] = this.age[last];
    this.life[i] = this.life[last];
    this.seed[i] = this.seed[last];
  }

  /** 1フレーム進める。origin は発生源のワールド行列 */
  update(dt: number, origin: Matrix4): void {
    const s = this.settings;
    this.time += dt;
    if (this.burstPending > 0) {
      const n = Math.min(this.burstPending, this.max - this.count);
      for (let k = 0; k < n; k++) this.spawn(origin);
      this.burstPending = 0;
    }
    if (!this.stopped && s.rate > 0 && (s.loop || this.time < s.lifetime)) {
      this.acc += dt * s.rate;
      while (this.acc >= 1) {
        this.acc -= 1;
        this.spawn(origin);
      }
    }
    _c1.set(s.color);
    _c2.set(s.colorEnd);
    const drag = s.preset === 'explosion' || s.preset === 'confetti' ? Math.exp(-dt * 2.2) : 1;
    for (let i = 0; i < this.count; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.kill(i);
        i--;
        continue;
      }
      const t = this.age[i] / this.life[i];
      const sd = this.seed[i];
      const turb = s.turbulence;
      this.vel[i * 3] = this.vel[i * 3] * drag + Math.sin(this.time * 2.3 + sd) * turb * dt;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * drag + s.gravity * dt;
      this.vel[i * 3 + 2] = this.vel[i * 3 + 2] * drag + Math.cos(this.time * 1.9 + sd * 1.3) * turb * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.sizes[i] = s.size + (s.sizeEnd - s.size) * t;
      // 出始めと消える前はふわっと
      const fade = Math.min(1, t * 6) * Math.min(1, (1 - t) * 3);
      let r = _c1.r + (_c2.r - _c1.r) * t;
      let g = _c1.g + (_c2.g - _c1.g) * t;
      let b = _c1.b + (_c2.b - _c1.b) * t;
      if (s.preset === 'confetti') {
        // 紙吹雪は粒ごとに色を変える
        _hsl.setHSL((sd * 0.137) % 1, 0.85, 0.6);
        r = _hsl.r;
        g = _hsl.g;
        b = _hsl.b;
      }
      this.colors[i * 4] = r;
      this.colors[i * 4 + 1] = g;
      this.colors[i * 4 + 2] = b;
      this.colors[i * 4 + 3] = s.opacity * fade;
    }
    this.geometry.setDrawRange(0, this.count);
    (this.geometry.attributes.position as BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.aSize as BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.aColor as BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** オブジェクトの一番上の親 (シーン) */
export function sceneRoot(obj: Object3D): Object3D {
  let cur = obj;
  while (cur.parent) cur = cur.parent;
  return cur;
}

/** コンポーネントのプロパティ (量・大きさ・速さの倍率、色の上書き) から設定を作る */
export function settingsFromProps(props: Record<string, unknown>): ParticleSettings {
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const preset = (typeof props.preset === 'string' && props.preset in PARTICLE_PRESETS ? props.preset : 'fire') as ParticlePreset;
  const base = particleSettings(preset);
  const amount = Math.max(0.05, n(props.amount, 1));
  const size = Math.max(0.05, n(props.size, 1));
  const speed = Math.max(0, n(props.speed, 1));
  const custom = props.customColor === true;
  return {
    ...base,
    rate: base.rate * amount,
    burst: Math.round(base.burst * amount),
    size: base.size * size,
    sizeEnd: base.sizeEnd * size,
    speed: base.speed * speed,
    area: base.area.map((a) => a * (preset === 'rain' || preset === 'snow' ? Math.max(0.1, n(props.areaScale, 1)) : size)) as Vec3,
    color: custom && typeof props.color === 'string' ? props.color : base.color,
    colorEnd: custom && typeof props.colorEnd === 'string' ? props.colorEnd : base.colorEnd,
    loop: props.loop === false ? false : base.loop,
  };
}
