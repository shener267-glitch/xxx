import { CanvasTexture, RepeatWrapping, SRGBColorSpace, Texture } from 'three';
import type { MaterialPattern } from '../core/types';

/**
 * テクスチャの管理。
 * - 手続き的な模様 (木目・レンガなど) は Canvas で生成してキャッシュする (画像ファイル不要)
 * - 画像アセットは IndexedDB などからリゾルバ経由で非同期に読み込む
 *
 * マテリアルごとに UV (繰り返し・ずれ・回転) を変えられるよう、元テクスチャを複製して渡す。
 * 複製は画像データ (Source) を共有するため、メモリ・GPU 転送は1回で済む。
 */

export type AssetResolver = (assetId: string) => Promise<Blob | null>;

let resolver: AssetResolver | null = null;
const listeners = new Set<() => void>();

/** アセット (Blob) の取得方法を登録する。エディタと書き出したゲームで実装が異なる */
export function setAssetResolver(fn: AssetResolver | null): void {
  resolver = fn;
}

/** テクスチャの読み込みが完了したとき (再描画が必要) に呼ばれる */
export function onTextureLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

interface BaseEntry {
  base: Texture;
  ready: boolean;
  clones: Set<Texture>;
}

const bases = new Map<string, BaseEntry>();
let maxTextureSize = 1024;

export function setMaxTextureSize(size: number): void {
  maxTextureSize = size;
}

// ------------------------------------------------------------------
// 手続き的な模様
// ------------------------------------------------------------------

/** 決定的な乱数 (模様が毎回同じになるように) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 滑らかなノイズ (値ノイズ) を格子で生成 */
function valueNoise(size: number, cells: number, rand: () => number): Float32Array {
  const grid = new Float32Array((cells + 1) * (cells + 1));
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  // タイル状に繋がるよう端を揃える
  for (let i = 0; i <= cells; i++) {
    grid[i * (cells + 1) + cells] = grid[i * (cells + 1)];
    grid[cells * (cells + 1) + i] = grid[i];
  }
  const out = new Float32Array(size * size);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * cells;
      const gy = (y / size) * cells;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const tx = smooth(gx - x0);
      const ty = smooth(gy - y0);
      const i00 = grid[y0 * (cells + 1) + x0];
      const i10 = grid[y0 * (cells + 1) + x0 + 1];
      const i01 = grid[(y0 + 1) * (cells + 1) + x0];
      const i11 = grid[(y0 + 1) * (cells + 1) + x0 + 1];
      out[y * size + x] = (i00 * (1 - tx) + i10 * tx) * (1 - ty) + (i01 * (1 - tx) + i11 * tx) * ty;
    }
  }
  return out;
}

function fbm(size: number, rand: () => number, octaves: number[]): Float32Array {
  const out = new Float32Array(size * size);
  let total = 0;
  octaves.forEach((cells, i) => {
    const w = 1 / (i + 1);
    total += w;
    const n = valueNoise(size, cells, rand);
    for (let k = 0; k < out.length; k++) out[k] += n[k] * w;
  });
  for (let k = 0; k < out.length; k++) out[k] /= total;
  return out;
}

/**
 * 模様を明るさ (0〜1) として描く。マテリアルの色と掛け合わされるので、白〜灰色で作る。
 */
function drawPattern(pattern: MaterialPattern, size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const rand = mulberry32(1234 + pattern.length * 97);
  const set = (x: number, y: number, v: number) => {
    const i = (y * size + x) * 4;
    const c = Math.max(0, Math.min(255, Math.round(v * 255)));
    d[i] = c;
    d[i + 1] = c;
    d[i + 2] = c;
    d[i + 3] = 255;
  };
  switch (pattern) {
    case 'wood': {
      const n = fbm(size, rand, [4, 8, 16]);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          // 横方向に伸びた年輪 + ノイズによる揺らぎ
          const warp = n[y * size + x] * 6;
          const ring = Math.sin((y / size) * Math.PI * 2 * 7 + warp * 2.2) * 0.5 + 0.5;
          const grain = Math.sin((y / size) * Math.PI * 2 * 60 + warp * 10) * 0.5 + 0.5;
          set(x, y, 0.62 + ring * 0.28 + grain * 0.08);
        }
      }
      break;
    }
    case 'checker': {
      const cell = size / 8;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
          set(x, y, on ? 1 : 0.55);
        }
      }
      break;
    }
    case 'brick': {
      const n = fbm(size, rand, [8, 32]);
      const rows = 8;
      const cols = 4;
      const bh = size / rows;
      const bw = size / cols;
      const mortar = Math.max(2, size / 96);
      for (let y = 0; y < size; y++) {
        const row = Math.floor(y / bh);
        const shift = row % 2 === 0 ? 0 : bw / 2;
        for (let x = 0; x < size; x++) {
          const lx = (x + shift) % bw;
          const ly = y % bh;
          const isMortar = lx < mortar || ly < mortar;
          const brickId = Math.floor((x + shift) / bw) + row * 7;
          const tone = 0.72 + ((brickId * 37) % 11) / 60;
          set(x, y, isMortar ? 0.95 : tone + (n[y * size + x] - 0.5) * 0.2);
        }
      }
      break;
    }
    case 'stone': {
      const n = fbm(size, rand, [4, 8, 16, 32]);
      for (let k = 0; k < n.length; k++) set(k % size, Math.floor(k / size), 0.5 + n[k] * 0.5);
      break;
    }
    case 'tiles': {
      const cell = size / 4;
      const grout = Math.max(2, size / 80);
      const n = fbm(size, rand, [16, 32]);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const g = x % cell < grout || y % cell < grout;
          set(x, y, g ? 0.55 : 0.92 + (n[y * size + x] - 0.5) * 0.1);
        }
      }
      break;
    }
    case 'grass': {
      const n = fbm(size, rand, [8, 32, 64]);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const speck = rand() < 0.08 ? 0.12 : 0;
          set(x, y, 0.62 + n[y * size + x] * 0.35 + speck);
        }
      }
      break;
    }
    default:
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size, size);
      return canvas;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function patternBase(pattern: MaterialPattern): BaseEntry {
  const key = `pattern:${pattern}`;
  let entry = bases.get(key);
  if (!entry) {
    const tex = new CanvasTexture(drawPattern(pattern, 256));
    tex.colorSpace = SRGBColorSpace;
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.anisotropy = 4;
    entry = { base: tex, ready: true, clones: new Set() };
    bases.set(key, entry);
  }
  return entry;
}

// ------------------------------------------------------------------
// 画像アセット
// ------------------------------------------------------------------

async function loadImage(blob: Blob): Promise<HTMLImageElement | HTMLCanvasElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // 大きすぎる画像はスマホのメモリを圧迫するので縮小する
    const max = Math.max(img.naturalWidth, img.naturalHeight);
    if (max <= maxTextureSize) return img;
    const scale = maxTextureSize / max;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function assetBase(assetId: string): BaseEntry {
  const key = `asset:${assetId}`;
  let entry = bases.get(key);
  if (entry) return entry;
  const tex = new Texture();
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.anisotropy = 4;
  const e: BaseEntry = { base: tex, ready: false, clones: new Set() };
  bases.set(key, e);
  entry = e;
  void (async () => {
    try {
      const blob = resolver ? await resolver(assetId) : null;
      if (!blob) return;
      const image = await loadImage(blob);
      tex.image = image;
      tex.needsUpdate = true;
      e.ready = true;
      for (const c of e.clones) c.needsUpdate = true;
      for (const fn of listeners) fn();
    } catch (err) {
      console.warn('[PocketEngine] テクスチャを読み込めませんでした', assetId, err);
    }
  })();
  return entry;
}

// ------------------------------------------------------------------
// 取得と解放
// ------------------------------------------------------------------

/** マテリアル用のテクスチャを取得する (使い終わったら releaseTexture) */
export function acquireTexture(key: string): Texture | null {
  let entry: BaseEntry | null = null;
  if (key.startsWith('pattern:')) entry = patternBase(key.slice(8) as MaterialPattern);
  else if (key.startsWith('asset:')) entry = assetBase(key.slice(6));
  if (!entry) return null;
  const clone = entry.base.clone();
  clone.userData.baseKey = key;
  if (entry.ready) clone.needsUpdate = true;
  entry.clones.add(clone);
  return clone;
}

export function releaseTexture(tex: Texture | null | undefined): void {
  if (!tex) return;
  const key = tex.userData.baseKey as string | undefined;
  if (key) bases.get(key)?.clones.delete(tex);
  tex.dispose();
}

/** アセットが削除・差し替えされたときにキャッシュを破棄する */
export function invalidateAssetTexture(assetId: string): void {
  const key = `asset:${assetId}`;
  const entry = bases.get(key);
  if (!entry) return;
  entry.base.dispose();
  bases.delete(key);
}
