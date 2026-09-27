import type { TerrainData } from './types';

/**
 * 地形 (高さの格子)。DOM や描画に依存しない。
 *
 * - 格子は一辺 resolution 分割 ((resolution + 1)² 個の頂点)。ローカル座標の中心が原点
 * - heights[r * (resolution + 1) + c] が x = -size/2 + c * 間隔, z = -size/2 + r * 間隔 の高さ (m)
 * - 生成 (山・谷・丘・島) とブラシ (盛る・下げる・なめらか・平らに) で編集する
 */

export const TERRAIN_RESOLUTIONS = [16, 32, 64, 96, 128] as const;
export const MAX_TERRAIN_HEIGHT = 200;

export type TerrainGenerator = 'flat' | 'hills' | 'mountains' | 'valley' | 'island' | 'plateau';

export const TERRAIN_GENERATORS: { value: TerrainGenerator; label: string }[] = [
  { value: 'hills', label: 'なだらかな丘' },
  { value: 'mountains', label: '山' },
  { value: 'valley', label: '谷' },
  { value: 'island', label: '島 (まわりが低い)' },
  { value: 'plateau', label: '台地' },
  { value: 'flat', label: '平ら' },
];

export type BrushTool = 'raise' | 'lower' | 'smooth' | 'flatten';

export const BRUSH_TOOLS: { value: BrushTool; label: string; icon: string }[] = [
  { value: 'raise', label: '盛る', icon: 'plus' },
  { value: 'lower', label: '下げる', icon: 'minus' },
  { value: 'smooth', label: 'なめらか', icon: 'wave' },
  { value: 'flatten', label: '平らに', icon: 'square' },
];

export function defaultTerrain(resolution = 64, size = 40): TerrainData {
  const res = clampResolution(resolution);
  return {
    resolution: res,
    size,
    heights: new Array((res + 1) * (res + 1)).fill(0),
    autoColor: true,
    colors: { sand: '#d9c78f', grass: '#5e9c48', rock: '#857d72', snow: '#f3f5f7' },
    sandLevel: 0.3,
    snowLevel: 12,
    flatShading: false,
  };
}

export function clampResolution(n: number): number {
  const v = Math.round(Number(n) || 64);
  return Math.max(8, Math.min(128, v));
}

export const vertexCount = (t: TerrainData) => (t.resolution + 1) * (t.resolution + 1);
export const cellSize = (t: TerrainData) => t.size / t.resolution;

// ------------------------------------------------------------------
// 高さを調べる
// ------------------------------------------------------------------

/** ローカル座標 (x, z) の高さ (格子の間は補間)。範囲外は端の値 */
export function heightAt(t: TerrainData, x: number, z: number): number {
  const n = t.resolution;
  const fc = Math.max(0, Math.min(n, (x + t.size / 2) / cellSize(t)));
  const fr = Math.max(0, Math.min(n, (z + t.size / 2) / cellSize(t)));
  const c0 = Math.min(n - 1, Math.floor(fc));
  const r0 = Math.min(n - 1, Math.floor(fr));
  const u = fc - c0;
  const v = fr - r0;
  const w = n + 1;
  const h = t.heights;
  const a = h[r0 * w + c0];
  const b = h[r0 * w + c0 + 1];
  const c = h[(r0 + 1) * w + c0];
  const d = h[(r0 + 1) * w + c0 + 1];
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

export function heightRange(t: TerrainData): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of t.heights) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0 };
}

// ------------------------------------------------------------------
// 生成
// ------------------------------------------------------------------

function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** なめらかな乱数 (値ノイズ, 0〜1) */
function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

/** 重ねたノイズ (0〜1) */
export function fbm(x: number, y: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * f, y * f, seed + i * 17) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

export interface GenerateOptions {
  type: TerrainGenerator;
  /** いちばん高い所の高さ (m) */
  height: number;
  seed: number;
  /** 起伏の細かさ (1 = ふつう) */
  roughness: number;
}

export const DEFAULT_GENERATE: GenerateOptions = { type: 'hills', height: 6, seed: 1, roughness: 1 };

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 高さを作り直す (新しい heights を返す) */
export function generateHeights(t: TerrainData, o: GenerateOptions): number[] {
  const n = t.resolution;
  const w = n + 1;
  const out = new Array<number>(w * w);
  const H = Math.max(0, Math.min(MAX_TERRAIN_HEIGHT, o.height));
  // 地形の大きさが変わっても同じくらいの細かさになるよう、m 単位でノイズを取る
  const freq = (Math.max(0.2, Math.min(4, o.roughness)) * 3) / 40;
  const seed = Math.floor(o.seed) || 1;
  for (let r = 0; r < w; r++) {
    for (let c = 0; c < w; c++) {
      const u = c / n; // 0..1
      const v = r / n;
      const x = (u - 0.5) * t.size;
      const z = (v - 0.5) * t.size;
      const nx = x * freq;
      const nz = z * freq;
      let h = 0;
      switch (o.type) {
        case 'hills':
          h = (fbm(nx, nz, seed, 3) - 0.3) * 1.4;
          break;
        case 'mountains': {
          // 中央に山のかたまり、尾根 (ridged) のある大きな起伏 + 少しの細かい凹凸
          const d = Math.hypot(u - 0.5, v - 0.5) * 2;
          const massif = 1 - smoothstep(0.25, 1.05, d) * 0.8;
          const ridge = 1 - Math.abs(fbm(nx * 0.45, nz * 0.45, seed, 4) * 2 - 1);
          const broad = fbm(nx * 0.25, nz * 0.25, seed + 5, 3);
          h = (Math.pow(ridge, 2) * 0.55 + broad * 0.6) * massif + (fbm(nx * 1.6, nz * 1.6, seed + 11, 2) - 0.5) * 0.04 - 0.12;
          break;
        }
        case 'valley': {
          // 真ん中 (x = 0) を谷が通る。谷の線は少し曲がる
          const bend = (fbm(0, nz * 0.5, seed, 2) - 0.5) * 0.35;
          const d = Math.abs(u - 0.5 - bend) * 2;
          h = Math.pow(smoothstep(0.05, 0.9, d), 1.3) + (fbm(nx, nz, seed + 3, 4) - 0.5) * 0.25;
          break;
        }
        case 'island': {
          const d = Math.hypot(u - 0.5, v - 0.5) * 2;
          const shape = 1 - smoothstep(0.15, 0.95, d + (fbm(nx, nz, seed, 3) - 0.5) * 0.35);
          h = shape * (0.7 + fbm(nx * 1.5, nz * 1.5, seed + 9, 4) * 0.5) - 0.15;
          break;
        }
        case 'plateau': {
          const base = fbm(nx * 0.7, nz * 0.7, seed, 4);
          // 段々にする
          h = smoothstep(0.45, 0.55, base) * 0.8 + smoothstep(0.62, 0.68, base) * 0.2 + (fbm(nx * 3, nz * 3, seed + 2, 2) - 0.5) * 0.05;
          break;
        }
        default:
          h = 0;
      }
      out[r * w + c] = h;
    }
  }
  // いちばん高い所がちょうど「高さ」になるようにそろえる
  let max = 0;
  for (const v of out) if (v > max) max = v;
  const k = max > 1e-6 ? H / max : 0;
  return out.map((v) => round2(v * k));
}

// ------------------------------------------------------------------
// ブラシ
// ------------------------------------------------------------------

export interface BrushOptions {
  tool: BrushTool;
  /** 半径 (m, ローカル座標) */
  radius: number;
  /** 強さ 0〜1 */
  strength: number;
  /** 平らにするときの高さ (ストロークの最初の点の高さ) */
  target?: number;
}

/**
 * ブラシを 1 回かける (heights を直接書き換える)。dt は秒。
 * 変わった範囲 (格子の行・列) を返す。何も変わらなければ null
 */
export function applyBrush(
  t: TerrainData,
  x: number,
  z: number,
  b: BrushOptions,
  dt: number,
): { r0: number; r1: number; c0: number; c1: number } | null {
  const n = t.resolution;
  const w = n + 1;
  const cs = cellSize(t);
  const radius = Math.max(cs, b.radius);
  const cc = (x + t.size / 2) / cs;
  const cr = (z + t.size / 2) / cs;
  const rc = radius / cs;
  const c0 = Math.max(0, Math.floor(cc - rc));
  const c1 = Math.min(n, Math.ceil(cc + rc));
  const r0 = Math.max(0, Math.floor(cr - rc));
  const r1 = Math.min(n, Math.ceil(cr + rc));
  if (c0 > c1 || r0 > r1) return null;
  const strength = Math.max(0.01, Math.min(1, b.strength));
  const h = t.heights;
  // なめらか用に元の値を写しておく
  const src = b.tool === 'smooth' ? h.slice() : h;
  let changed = false;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const d = Math.hypot(c - cc, r - cr) / rc;
      if (d >= 1) continue;
      // 中心ほど強い (なめらかな釣鐘形)
      const fall = 0.5 + 0.5 * Math.cos(d * Math.PI);
      const i = r * w + c;
      const before = h[i];
      switch (b.tool) {
        case 'raise':
          h[i] = Math.min(MAX_TERRAIN_HEIGHT, h[i] + strength * 6 * dt * fall);
          break;
        case 'lower':
          h[i] = Math.max(-MAX_TERRAIN_HEIGHT, h[i] - strength * 6 * dt * fall);
          break;
        case 'flatten': {
          const target = b.target ?? 0;
          const k = Math.min(1, strength * 8 * dt * fall);
          h[i] += (target - h[i]) * k;
          break;
        }
        case 'smooth': {
          let sum = 0;
          let cnt = 0;
          for (let rr = Math.max(0, r - 1); rr <= Math.min(n, r + 1); rr++) {
            for (let c2 = Math.max(0, c - 1); c2 <= Math.min(n, c + 1); c2++) {
              sum += src[rr * w + c2];
              cnt++;
            }
          }
          const k = Math.min(1, strength * 10 * dt * fall);
          h[i] += (sum / cnt - h[i]) * k;
          break;
        }
      }
      if (h[i] !== before) changed = true;
    }
  }
  return changed ? { r0, r1, c0, c1 } : null;
}

// ------------------------------------------------------------------
// 格子の細かさの変更・修復
// ------------------------------------------------------------------

/** 分割数を変える (形はなるべく保つ) */
export function resampleHeights(t: TerrainData, resolution: number): number[] {
  const n = clampResolution(resolution);
  const w = n + 1;
  const out = new Array<number>(w * w);
  for (let r = 0; r < w; r++) {
    for (let c = 0; c < w; c++) {
      const x = (c / n - 0.5) * t.size;
      const z = (r / n - 0.5) * t.size;
      out[r * w + c] = round2(heightAt(t, x, z));
    }
  }
  return out;
}

export function roundHeights(h: number[]): number[] {
  return h.map(round2);
}

function round2(v: number): number {
  // -0 は 0 にそろえる (保存すると 0 になるため)
  return Math.round(v * 100) / 100 || 0;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** 壊れたデータを直す */
export function sanitizeTerrain(raw: unknown): TerrainData {
  const d = defaultTerrain();
  if (!raw || typeof raw !== 'object') return d;
  const o = raw as Record<string, unknown>;
  const res = clampResolution(Number(o.resolution));
  const size = Math.max(1, Math.min(2000, Number(o.size) || d.size));
  const count = (res + 1) * (res + 1);
  const src = Array.isArray(o.heights) ? o.heights : [];
  const heights = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const v = Number(src[i]);
    heights[i] = Number.isFinite(v) ? Math.max(-MAX_TERRAIN_HEIGHT, Math.min(MAX_TERRAIN_HEIGHT, v)) : 0;
  }
  const colors = (o.colors && typeof o.colors === 'object' ? o.colors : {}) as Record<string, unknown>;
  const col = (k: keyof TerrainData['colors']) => (typeof colors[k] === 'string' && HEX.test(colors[k] as string) ? (colors[k] as string) : d.colors[k]);
  const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
  return {
    resolution: res,
    size,
    heights,
    autoColor: o.autoColor !== false,
    colors: { sand: col('sand'), grass: col('grass'), rock: col('rock'), snow: col('snow') },
    sandLevel: num(o.sandLevel, d.sandLevel),
    snowLevel: num(o.snowLevel, d.snowLevel),
    flatShading: o.flatShading === true,
  };
}
