import type { EntityData, PrefabEntry, Vec3 } from './types';
import { clone, createId } from './util';

/**
 * 部品 (Prefab) と大量配置。DOM や描画に依存しない。
 */

/** サブツリー (ルートが先頭) を entities から集める */
export function collectSubtree(entities: Record<string, EntityData>, rootId: string): EntityData[] {
  const out: EntityData[] = [];
  const visit = (id: string) => {
    const e = entities[id];
    if (!e) return;
    out.push(e);
    e.children.forEach(visit);
  };
  visit(rootId);
  return out;
}

/** 選択したオブジェクト (と子) から Prefab を作る。位置は原点に戻して保存する */
export function createPrefab(subtree: EntityData[], name: string, folder = ''): PrefabEntry {
  const list = clone(subtree);
  const root = list[0];
  root.parent = null;
  root.transform.position = [0, 0, 0];
  delete root.prefab;
  const entities: Record<string, EntityData> = {};
  for (const e of list) {
    if (e.camera) e.camera.main = false;
    entities[e.id] = e;
  }
  return { id: createId('pf'), name: name.slice(0, 100) || '部品', root: root.id, entities, folder, createdAt: Date.now() };
}

/** Prefab から新しい ID のオブジェクト (ルートが先頭) を作る */
export function instantiatePrefab(prefab: PrefabEntry): EntityData[] {
  const src = collectSubtree(prefab.entities, prefab.root);
  const map = new Map<string, string>();
  for (const e of src) map.set(e.id, createId('e'));
  const out = src.map((e) => {
    const c = clone(e);
    c.id = map.get(e.id)!;
    c.parent = e.parent && map.has(e.parent) ? map.get(e.parent)! : null;
    c.children = e.children.filter((id) => map.has(id)).map((id) => map.get(id)!);
    c.components = c.components.map((comp) => ({ ...comp, id: createId('c') }));
    return c;
  });
  out[0].parent = null;
  out[0].prefab = prefab.id;
  out[0].name = prefab.name;
  return out;
}

export function duplicatePrefab(prefab: PrefabEntry, name: string): PrefabEntry {
  return { ...clone(prefab), id: createId('pf'), name, createdAt: Date.now() };
}

export function prefabEntityCount(prefab: PrefabEntry): number {
  return collectSubtree(prefab.entities, prefab.root).length;
}

// ------------------------------------------------------------------
// 大量配置
// ------------------------------------------------------------------

export type ScatterPattern = 'grid' | 'line' | 'circle' | 'random';

export interface ScatterOptions {
  pattern: ScatterPattern;
  /** 数 (grid 以外) */
  count: number;
  /** grid: 行・列 */
  rows: number;
  cols: number;
  /** 間隔 (grid / line) */
  spacing: number;
  /** 半径 (circle) */
  radius: number;
  /** 範囲 (random, 幅 × 奥行き) */
  width: number;
  depth: number;
  /** ランダムに向きを変える */
  randomRotation: boolean;
  /** ランダムな大きさの幅 (0 = 変えない、0.3 = ±30%) */
  randomScale: number;
  /** circle: 中心を向く */
  faceCenter: boolean;
  seed: number;
}

export const DEFAULT_SCATTER: ScatterOptions = {
  pattern: 'grid',
  count: 10,
  rows: 3,
  cols: 3,
  spacing: 2,
  radius: 5,
  width: 10,
  depth: 10,
  randomRotation: true,
  randomScale: 0.2,
  faceCenter: false,
  seed: 1,
};

export interface Placement {
  position: Vec3;
  /** Y 軸の回転 (度) */
  rotationY: number;
  scale: number;
}

/** 決まった順に乱数を出す (同じ設定なら同じ配置になる) */
function random(seed: number): () => number {
  let s = (Math.floor(seed) * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/** 配置する位置の一覧 (中心 center の周り)。最大 500 個 */
export function scatterPlacements(o: ScatterOptions, center: Vec3): Placement[] {
  const rnd = random(o.seed);
  const out: Placement[] = [];
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const push = (x: number, z: number, rotY = 0) => {
    const rot = o.randomRotation ? Math.round(rnd() * 360) : rotY;
    const sc = o.randomScale > 0 ? 1 + (rnd() * 2 - 1) * Math.min(0.9, o.randomScale) : 1;
    out.push({ position: [r2(center[0] + x), center[1], r2(center[2] + z)], rotationY: rot, scale: Math.round(sc * 100) / 100 });
  };
  const cap = 500;
  switch (o.pattern) {
    case 'grid': {
      const rows = Math.max(1, Math.min(50, Math.floor(o.rows)));
      const cols = Math.max(1, Math.min(50, Math.floor(o.cols)));
      for (let r = 0; r < rows && out.length < cap; r++) {
        for (let c = 0; c < cols && out.length < cap; c++) {
          push((c - (cols - 1) / 2) * o.spacing, (r - (rows - 1) / 2) * o.spacing);
        }
      }
      break;
    }
    case 'line': {
      const n = Math.max(1, Math.min(cap, Math.floor(o.count)));
      for (let i = 0; i < n; i++) push((i - (n - 1) / 2) * o.spacing, 0);
      break;
    }
    case 'circle': {
      const n = Math.max(1, Math.min(cap, Math.floor(o.count)));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rotY = o.faceCenter ? Math.round((Math.atan2(-Math.sin(a), -Math.cos(a)) * 180) / Math.PI) : 0;
        push(Math.sin(a) * o.radius, Math.cos(a) * o.radius, rotY);
      }
      break;
    }
    default: {
      const n = Math.max(1, Math.min(cap, Math.floor(o.count)));
      for (let i = 0; i < n; i++) push((rnd() - 0.5) * o.width, (rnd() - 0.5) * o.depth);
    }
  }
  return out;
}
