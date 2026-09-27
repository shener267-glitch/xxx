import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three';
import type { Camera } from 'three';
import type { QualityLevel } from '../core/settings';
import type { CloudData } from '../core/types';

/**
 * 時刻と空: 太陽の通り道・空の色・星・月・雲・稲妻。
 * 時刻から計算する部分は描画に依存しない (単体テスト対象)。
 */

const UP = new Vector3(0, 1, 0);
const MAX_ELEVATION = (65 * Math.PI) / 180;

export const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * 時刻 (0〜24) の太陽のある方向。6 時に東 (heading 0 のとき +X) から昇り、12 時に最も高く、18 時に西に沈む。
 * heading (度) で通り道の向きを回す
 */
export function sunDirectionAt(hour: number, headingDeg = 0, out = new Vector3()): Vector3 {
  const a = ((hour - 6) / 12) * Math.PI;
  out.set(Math.cos(a), Math.sin(a) * Math.sin(MAX_ELEVATION), Math.sin(a) * Math.cos(MAX_ELEVATION) * 0.6).normalize();
  return out.applyAxisAngle(UP, (headingDeg * Math.PI) / 180);
}

/** 昼の明るさ 0 (夜) 〜 1 (昼) */
export function daylight(sunY: number): number {
  return smoothstep(-0.08, 0.2, sunY);
}

/** 夜の暗さ 0 (昼) 〜 1 (夜): 星の見え方 */
export function nightness(sunY: number): number {
  return 1 - smoothstep(-0.22, 0.04, sunY);
}

/** 朝焼け・夕焼けの強さ 0〜1 */
export function twilight(sunY: number): number {
  return Math.max(0, 1 - Math.abs(sunY - 0.02) / 0.22);
}

export interface SkyColors {
  top: string;
  horizon: string;
  bottom: string;
}

const NIGHT: SkyColors = { top: '#050914', horizon: '#16203a', bottom: '#0a0d14' };
const DUSK: SkyColors = { top: '#2b3d78', horizon: '#f29a5e', bottom: '#3a3440' };

const _a = new Color();
const _b = new Color();
function mix(a: string, b: string, t: number): string {
  _a.set(a);
  _b.set(b);
  return `#${_a.lerp(_b, Math.max(0, Math.min(1, t))).getHexString()}`;
}

/** 時刻に合わせた空の色 (昼の色は設定の色) */
export function skyColorsAt(sunY: number, day: SkyColors): SkyColors {
  const toDusk = smoothstep(-0.25, 0.0, sunY);
  const toDay = smoothstep(0.02, 0.32, sunY);
  const pick = (k: keyof SkyColors) => mix(mix(NIGHT[k], DUSK[k], toDusk), day[k], toDay);
  return { top: pick('top'), horizon: pick('horizon'), bottom: pick('bottom') };
}

/** 太陽光の色 (地平線に近いほど赤っぽい) */
export function sunColorAt(sunY: number, base: string): string {
  return mix('#ff8a4a', base, smoothstep(0.03, 0.35, sunY));
}

// ------------------------------------------------------------------
// 星
// ------------------------------------------------------------------

export function createStars(quality: QualityLevel): Points<BufferGeometry, ShaderMaterial> {
  const count = quality === 'low' ? 350 : quality === 'medium' ? 700 : 1200;
  const pos = new Float32Array(count * 3);
  const size = new Float32Array(count);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let i = 0; i < count; i++) {
    // 上半分 (少し地平線の下まで) に均等に散らす
    const y = rnd() * 1.1 - 0.1;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = rnd() * Math.PI * 2;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = Math.sin(a) * r;
    size[i] = 0.8 + Math.pow(rnd(), 3) * 2.4;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('aSize', new BufferAttribute(size, 1));
  const m = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { uOpacity: { value: 0 }, uTime: { value: 0 }, uPixelRatio: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      uniform float uTime;
      uniform float uPixelRatio;
      varying float vTw;
      void main() {
        // カメラからの向きだけを使う (無限に遠い)
        vec4 mv = modelViewMatrix * vec4(position * 400.0, 1.0);
        gl_Position = projectionMatrix * mv;
        vTw = 0.7 + 0.3 * sin(uTime * 2.0 + position.x * 40.0 + position.z * 17.0);
        gl_PointSize = aSize * uPixelRatio;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying float vTw;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * uOpacity * vTw;
        gl_FragColor = vec4(vec3(1.0, 0.97, 0.9) * a, a);
      }
    `,
  });
  const p = new Points(g, m);
  p.frustumCulled = false;
  p.renderOrder = -10;
  p.userData.noPick = true;
  p.name = '__stars';
  return p;
}

// ------------------------------------------------------------------
// 月
// ------------------------------------------------------------------

function moonTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const glow = g.createRadialGradient(64, 64, 20, 64, 64, 64);
  glow.addColorStop(0, 'rgba(255,250,230,0.5)');
  glow.addColorStop(1, 'rgba(255,250,230,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#f4f1e4';
  g.beginPath();
  g.arc(64, 64, 26, 0, Math.PI * 2);
  g.fill();
  // 模様 (海)
  g.fillStyle = 'rgba(160,160,150,0.45)';
  for (const [x, y, r] of [
    [56, 56, 7],
    [71, 66, 5],
    [60, 74, 4],
    [74, 52, 3],
  ]) {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export function createMoon(): Mesh<PlaneGeometry, MeshBasicMaterial> {
  const m = new Mesh(
    new PlaneGeometry(1, 1),
    new MeshBasicMaterial({ map: moonTexture(), transparent: true, depthWrite: false, fog: false, side: DoubleSide }),
  );
  m.frustumCulled = false;
  m.renderOrder = -9;
  m.userData.noPick = true;
  m.name = '__moon';
  return m;
}

// ------------------------------------------------------------------
// 雲 (カメラの上空を覆う 1 枚の板。模様はシェーダーのノイズ)
// ------------------------------------------------------------------

export const CLOUD_SIZE = 1400;

export function createClouds(): Mesh<PlaneGeometry, ShaderMaterial> {
  const m = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      uOffset: { value: new Vector3() },
      uCoverage: { value: 0.45 },
      uColor: { value: new Color('#ffffff') },
      uShade: { value: new Color('#9aa3b2') },
      uOpacity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vWorld;
      varying vec2 vLocal;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xz;
        vLocal = position.xy;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uOffset;
      uniform float uCoverage;
      uniform vec3 uColor;
      uniform vec3 uShade;
      uniform float uOpacity;
      varying vec2 vWorld;
      varying vec2 vLocal;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float s = 0.0;
        float a = 0.5;
        for (int i = 0; i < 5; i++) { s += noise(p) * a; p *= 2.03; a *= 0.5; }
        return s;
      }
      void main() {
        vec2 p = (vWorld + uOffset.xz) * 0.012;
        float n = fbm(p);
        float d = smoothstep(1.0 - uCoverage, 1.0 - uCoverage + 0.28, n);
        // 下側の影 (濃い所ほど暗い)
        float shade = smoothstep(0.55, 1.0, fbm(p * 1.7 + 3.1));
        vec3 col = mix(uColor, uShade, shade * 0.55);
        // 遠くは消す (板の端を見せない)
        float edge = 1.0 - smoothstep(0.3, 0.5, length(vLocal));
        gl_FragColor = vec4(col, d * edge * uOpacity);
      }
    `,
  });
  m.fog = false;
  const mesh = new Mesh(new PlaneGeometry(1, 1), m);
  mesh.rotation.x = -Math.PI / 2;
  mesh.scale.setScalar(CLOUD_SIZE);
  mesh.frustumCulled = false;
  mesh.renderOrder = -5;
  mesh.userData.noPick = true;
  mesh.name = '__clouds';
  return mesh;
}

/** 雲の色と量を反映する */
export function updateClouds(mesh: Mesh<PlaneGeometry, ShaderMaterial>, c: CloudData, sunY: number, driftX: number, camera: Camera): void {
  const u = mesh.material.uniforms;
  u.uCoverage.value = 0.15 + c.amount * 0.7;
  const day = daylight(sunY);
  const base = new Color(c.color);
  const dusk = new Color('#ffb08a');
  const night = new Color('#2a3142');
  const col = night.clone().lerp(base.clone().lerp(dusk, twilight(sunY) * 0.7), day);
  (u.uColor.value as Color).copy(col);
  (u.uShade.value as Color).copy(col.clone().multiplyScalar(0.62));
  u.uOpacity.value = 0.55 + 0.45 * day;
  // カメラの真上に置き、模様はワールド座標で流す
  const cam = camera.position;
  mesh.position.set(cam.x, Math.max(c.height, cam.y + 20), cam.z);
  (u.uOffset.value as Vector3).set(driftX, 0, 0);
}

// ------------------------------------------------------------------
// 稲妻
// ------------------------------------------------------------------

/** ギザギザの線 (空から地面へ) */
export function createBolt(from: Vector3, to: Vector3, seed = Math.random()): Line<BufferGeometry, LineBasicMaterial> {
  const pts: number[] = [];
  const steps = 14;
  let s = Math.floor(seed * 1e6) + 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = from.clone().lerp(to, t);
    if (i > 0 && i < steps) {
      p.x += (rnd() - 0.5) * 6;
      p.z += (rnd() - 0.5) * 6;
    }
    pts.push(p.x, p.y, p.z);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
  const line = new Line(g, new LineBasicMaterial({ color: 0xe8f0ff, transparent: true, opacity: 1, fog: false }));
  line.frustumCulled = false;
  line.userData.noPick = true;
  line.name = '__bolt';
  return line;
}
