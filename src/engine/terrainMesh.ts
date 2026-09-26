import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import type { Object3D, Ray } from 'three';
import { cellSize, heightAt, heightRange } from '../core/terrain';
import type { TerrainData } from '../core/types';

/**
 * 地形のメッシュ。格子の頂点の高さを変えるだけなので、ブラシで編集中も作り直さずに更新できる。
 * 色は高さと傾きから自動で塗る (低い所は砂、急な斜面は岩、高い所は雪)。
 */

export function buildTerrainGeometry(t: TerrainData): BufferGeometry {
  const n = t.resolution;
  const w = n + 1;
  const positions = new Float32Array(w * w * 3);
  const uvs = new Float32Array(w * w * 2);
  const cs = cellSize(t);
  for (let r = 0; r < w; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      positions[i * 3] = -t.size / 2 + c * cs;
      positions[i * 3 + 2] = -t.size / 2 + r * cs;
      uvs[i * 2] = c / n;
      uvs[i * 2 + 1] = 1 - r / n;
    }
  }
  const index = new (w * w > 65535 ? Uint32Array : Uint16Array)(n * n * 6);
  let k = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const a = r * w + c;
      const b = a + 1;
      const d = a + w;
      const e = d + 1;
      index[k++] = a;
      index[k++] = d;
      index[k++] = b;
      index[k++] = b;
      index[k++] = d;
      index[k++] = e;
    }
  }
  const g = new BufferGeometry();
  g.setIndex(new BufferAttribute(index, 1));
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setAttribute('uv', new BufferAttribute(uvs, 2));
  g.setAttribute('color', new BufferAttribute(new Float32Array(w * w * 3), 3));
  updateTerrainGeometry(g, t);
  return g;
}

const _c = new Color();
const _sand = new Color();
const _grass = new Color();
const _rock = new Color();
const _snow = new Color();

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 高さ・法線・色を更新する */
export function updateTerrainGeometry(g: BufferGeometry, t: TerrainData): void {
  const pos = g.getAttribute('position') as BufferAttribute;
  const arr = pos.array as Float32Array;
  const h = t.heights;
  for (let i = 0; i < h.length; i++) arr[i * 3 + 1] = h[i];
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const col = g.getAttribute('color') as BufferAttribute;
  const ca = col.array as Float32Array;
  const nrm = (g.getAttribute('normal') as BufferAttribute).array as Float32Array;
  _grass.set(t.colors.grass);
  if (!t.autoColor) {
    for (let i = 0; i < h.length; i++) {
      ca[i * 3] = _grass.r;
      ca[i * 3 + 1] = _grass.g;
      ca[i * 3 + 2] = _grass.b;
    }
  } else {
    _sand.set(t.colors.sand);
    _rock.set(t.colors.rock);
    _snow.set(t.colors.snow);
    for (let i = 0; i < h.length; i++) {
      const y = h[i];
      const up = nrm[i * 3 + 1];
      _c.copy(_grass);
      // 低い所は砂
      _c.lerp(_sand, 1 - smooth(t.sandLevel - 0.25, t.sandLevel + 0.25, y));
      // 急な斜面は岩
      _c.lerp(_rock, 1 - smooth(0.62, 0.82, up));
      // 高い所は雪 (急な斜面には積もりにくい)
      _c.lerp(_snow, smooth(t.snowLevel - 0.8, t.snowLevel + 0.8, y) * smooth(0.5, 0.75, up));
      ca[i * 3] = _c.r;
      ca[i * 3 + 1] = _c.g;
      ca[i * 3 + 2] = _c.b;
    }
  }
  col.needsUpdate = true;
}

export function createTerrainMaterial(t: TerrainData): MeshStandardMaterial {
  return new MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0, flatShading: t.flatShading });
}

export function createTerrainMesh(t: TerrainData): Mesh {
  const mesh = new Mesh(buildTerrainGeometry(t), createTerrainMaterial(t));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.ownGeometry = true;
  mesh.userData.ownMaterial = true;
  mesh.userData.isTerrain = true;
  return mesh;
}

/** データが変わったかどうかを調べるための値 */
export function terrainKey(t: TerrainData): string {
  let sum = 0;
  const h = t.heights;
  for (let i = 0; i < h.length; i++) sum = (sum * 31 + Math.round(h[i] * 100)) | 0;
  return `${t.size}:${sum}:${t.autoColor}:${t.colors.sand}${t.colors.grass}${t.colors.rock}${t.colors.snow}:${t.sandLevel}:${t.snowLevel}:${t.flatShading}`;
}

/** 表示中の地形メッシュを最新のデータに合わせる (分割数が同じとき) */
export function refreshTerrainMesh(mesh: Mesh, t: TerrainData): void {
  const g = mesh.geometry;
  const count = (g.getAttribute('position') as BufferAttribute).count;
  if (count !== t.heights.length) return;
  // 大きさが変わったら格子の位置も変える
  const cs = cellSize(t);
  const pos = g.getAttribute('position') as BufferAttribute;
  const arr = pos.array as Float32Array;
  const w = t.resolution + 1;
  if (Math.abs(arr[3] - arr[0] - cs) > 1e-4) {
    for (let r = 0; r < w; r++) {
      for (let c = 0; c < w; c++) {
        const i = r * w + c;
        arr[i * 3] = -t.size / 2 + c * cs;
        arr[i * 3 + 2] = -t.size / 2 + r * cs;
      }
    }
  }
  updateTerrainGeometry(g, t);
  const m = mesh.material as MeshStandardMaterial;
  if (m.flatShading !== t.flatShading) {
    m.flatShading = t.flatShading;
    m.needsUpdate = true;
  }
}

/**
 * 地形のローカル座標での光線との交点 (格子を細かく進んで高さと比べる)。
 * メッシュの三角形すべてと当てるより速い
 */
export function raycastHeights(t: TerrainData, origin: Vector3, dir: Vector3, maxDist = 5000): Vector3 | null {
  const half = t.size / 2;
  // 地形の範囲 (箱) に入る所から調べる
  let tMin = 0;
  let tMax = maxDist;
  for (const axis of ['x', 'z'] as const) {
    const o = origin[axis];
    const d = dir[axis];
    if (Math.abs(d) < 1e-9) {
      if (o < -half || o > half) return null;
    } else {
      let a = (-half - o) / d;
      let b = (half - o) / d;
      if (a > b) [a, b] = [b, a];
      tMin = Math.max(tMin, a);
      tMax = Math.min(tMax, b);
    }
  }
  // 高さの範囲 (上下) でも絞る
  const { min, max } = heightRange(t);
  const lo = min - 0.01;
  const hi = max + 0.01;
  if (Math.abs(dir.y) < 1e-9) {
    if (origin.y < lo || origin.y > hi) return null;
  } else {
    let a = (lo - origin.y) / dir.y;
    let b = (hi - origin.y) / dir.y;
    if (a > b) [a, b] = [b, a];
    tMin = Math.max(tMin, a);
    tMax = Math.min(tMax, b);
  }
  if (tMin > tMax) return null;
  const step = cellSize(t) * 0.5;
  const p = new Vector3();
  const above = (s: number) => {
    p.copy(origin).addScaledVector(dir, s);
    return p.y - heightAt(t, p.x, p.z);
  };
  let prevS = tMin;
  let prev = above(prevS);
  if (prev < 0) return p.copy(origin).addScaledVector(dir, tMin);
  for (let s = tMin + step; s <= tMax + step; s += step) {
    const cur = above(Math.min(s, tMax));
    if (cur <= 0) {
      // 二分法で交点を詰める
      let lo = prevS;
      let hi = Math.min(s, tMax);
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2;
        if (above(mid) > 0) lo = mid;
        else hi = mid;
      }
      return p.copy(origin).addScaledVector(dir, hi);
    }
    prevS = Math.min(s, tMax);
    prev = cur;
    if (prevS >= tMax) break;
  }
  return null;
}

/** ワールド座標の光線と地形 (オブジェクト) の交点 (ワールド座標) */
export function raycastTerrainObject(object: Object3D, t: TerrainData, ray: Ray): Vector3 | null {
  object.updateWorldMatrix(true, false);
  const inv = object.matrixWorld.clone().invert();
  const o = ray.origin.clone().applyMatrix4(inv);
  const d = ray.direction.clone().transformDirection(inv);
  // transformDirection は正規化するので、拡大があっても交点の位置は正しい (距離の単位だけ変わる)
  const hit = raycastHeights(t, o, d);
  return hit ? hit.applyMatrix4(object.matrixWorld) : null;
}
