import { describe, expect, it } from 'vitest';
import { Group, Ray, Vector3 } from 'three';
import { createEntity } from '../src/core/catalog';
import { sanitizeScene } from '../src/core/serialization';
import { applyBrush, defaultTerrain, generateHeights, heightAt, heightRange, resampleHeights, sanitizeTerrain } from '../src/core/terrain';
import { createEmptyScene } from '../src/core/project';
import type { EntityData } from '../src/core/types';
import { resolveBodySpec, terrainHeightfield } from '../src/engine/colliderShapes';
import { buildTerrainGeometry, raycastHeights, raycastTerrainObject } from '../src/engine/terrainMesh';
import { PhysicsWorld } from '../src/runtime/PhysicsWorld';

const idx = (n: number, r: number, c: number) => r * (n + 1) + c;

describe('地形のデータ', () => {
  it('平らな地形を作る', () => {
    const t = defaultTerrain(16, 20);
    expect(t.heights).toHaveLength(17 * 17);
    expect(heightRange(t)).toEqual({ min: 0, max: 0 });
  });

  it('格子の間の高さを補間する', () => {
    const t = defaultTerrain(8, 8); // 間隔 1m, x/z = -4 〜 4
    t.heights[idx(8, 4, 4)] = 2; // 中心
    t.heights[idx(8, 4, 8)] = 3; // x = 4, z = 0 (端)
    expect(heightAt(t, 0, 0)).toBeCloseTo(2);
    expect(heightAt(t, 0.5, 0)).toBeCloseTo(1);
    expect(heightAt(t, 0, 0.25)).toBeCloseTo(1.5);
    expect(heightAt(t, -1, -1)).toBeCloseTo(0);
    // 範囲外は端の値
    expect(heightAt(t, 50, 0)).toBeCloseTo(3);
  });

  it('生成: 同じ設定なら同じ形。島は中心が高くまわりが低い', () => {
    const t = defaultTerrain(32, 40);
    const a = generateHeights(t, { type: 'hills', height: 5, seed: 3, roughness: 1 });
    const b = generateHeights(t, { type: 'hills', height: 5, seed: 3, roughness: 1 });
    const c = generateHeights(t, { type: 'hills', height: 5, seed: 4, roughness: 1 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    const island = { ...t, heights: generateHeights(t, { type: 'island', height: 8, seed: 1, roughness: 1 }) };
    expect(heightAt(island, 0, 0)).toBeGreaterThan(3);
    expect(heightAt(island, 19.5, 19.5)).toBeLessThan(0);
    const mountains = { ...t, heights: generateHeights(t, { type: 'mountains', height: 20, seed: 1, roughness: 1 }) };
    const r = heightRange(mountains);
    // いちばん高い所が指定した高さになる
    expect(r.max).toBeCloseTo(20, 1);
    const valley = { ...t, heights: generateHeights(t, { type: 'valley', height: 10, seed: 1, roughness: 1 }) };
    // 谷: 端は高く、真ん中付近は低い
    expect(heightAt(valley, -19, 0)).toBeGreaterThan(heightAt(valley, 0, 0) + 3);
    const flat = generateHeights(t, { type: 'flat', height: 10, seed: 1, roughness: 1 });
    expect(flat.every((v) => v === 0)).toBe(true);
  });

  it('ブラシ: 盛る・下げる・平らに・なめらか', () => {
    const t = defaultTerrain(32, 32); // 間隔 1m
    const changed = applyBrush(t, 0, 0, { tool: 'raise', radius: 4, strength: 1 }, 0.5);
    expect(changed).not.toBeNull();
    expect(heightAt(t, 0, 0)).toBeCloseTo(3, 1);
    // 半径の外は変わらない
    expect(heightAt(t, 6, 0)).toBe(0);
    // 中心ほど高い
    expect(heightAt(t, 2, 0)).toBeGreaterThan(0);
    expect(heightAt(t, 2, 0)).toBeLessThan(heightAt(t, 0, 0));
    applyBrush(t, 0, 0, { tool: 'lower', radius: 4, strength: 1 }, 0.25);
    expect(heightAt(t, 0, 0)).toBeCloseTo(1.5, 1);
    for (let i = 0; i < 30; i++) applyBrush(t, 0, 0, { tool: 'flatten', radius: 6, strength: 1, target: 0.5 }, 0.1);
    expect(heightAt(t, 0, 0)).toBeCloseTo(0.5, 2);
    // なめらか: とがった点がならされる
    const s = defaultTerrain(16, 16);
    s.heights[idx(16, 8, 8)] = 4;
    applyBrush(s, 0, 0, { tool: 'smooth', radius: 3, strength: 1 }, 0.1);
    expect(s.heights[idx(16, 8, 8)]).toBeLessThan(4);
    expect(s.heights[idx(16, 8, 9)]).toBeGreaterThan(0);
    // 地形の外では何も変わらない
    expect(applyBrush(defaultTerrain(8, 8), 100, 100, { tool: 'raise', radius: 1, strength: 1 }, 0.1)).toBeNull();
  });

  it('分割数を変えても形を保つ', () => {
    const t = defaultTerrain(16, 32);
    t.heights = generateHeights(t, { type: 'hills', height: 6, seed: 2, roughness: 0.6 });
    const up = resampleHeights(t, 32);
    const t2 = { ...t, resolution: 32, heights: up };
    for (const [x, z] of [
      [0, 0],
      [4, -6],
      [-10, 12],
    ]) {
      expect(heightAt(t2, x, z)).toBeCloseTo(heightAt(t, x, z), 1);
    }
  });

  it('壊れたデータを直す', () => {
    const t = sanitizeTerrain({ resolution: 4, size: -5, heights: [1, 'x', null, 3], colors: { grass: 'red' }, autoColor: false });
    expect(t.resolution).toBe(8);
    expect(t.size).toBe(1);
    expect(t.heights).toHaveLength(81);
    expect(t.heights[0]).toBe(1);
    expect(t.heights[1]).toBe(0);
    expect(t.heights[3]).toBe(3);
    expect(t.colors.grass).toMatch(/^#/);
    expect(t.autoColor).toBe(false);
  });

  it('シーンの保存と読み込みで地形が残る', () => {
    const scene = createEmptyScene('テスト', false);
    const e = createEntity('terrain-hills');
    scene.entities[e.id] = e;
    scene.roots.push(e.id);
    const back = sanitizeScene(JSON.parse(JSON.stringify(scene)));
    const t = back.entities[e.id].terrain!;
    expect(back.entities[e.id].kind).toBe('terrain');
    expect(t.heights).toEqual(e.terrain!.heights);
    expect(heightRange(t).max).toBeGreaterThan(0.5);
  });
});

describe('地形の表示・当たり判定', () => {
  it('メッシュの頂点が高さになる', () => {
    const t = defaultTerrain(8, 8);
    t.heights[idx(8, 4, 4)] = 3;
    const g = buildTerrainGeometry(t);
    const pos = g.getAttribute('position');
    expect(pos.count).toBe(81);
    expect(pos.getY(idx(8, 4, 4))).toBe(3);
    expect(pos.getX(idx(8, 4, 4))).toBeCloseTo(0);
    expect(pos.getZ(idx(8, 4, 4))).toBeCloseTo(0);
    expect(g.getAttribute('color').count).toBe(81);
  });

  it('光線と地形の交点', () => {
    const t = defaultTerrain(32, 32);
    t.heights = generateHeights(t, { type: 'hills', height: 5, seed: 1, roughness: 1 });
    const down = raycastHeights(t, new Vector3(3, 100, -4), new Vector3(0, -1, 0));
    expect(down).not.toBeNull();
    expect(down!.y).toBeCloseTo(heightAt(t, 3, -4), 2);
    const dir = new Vector3(1, -1.5, 0.5).normalize();
    const hit = raycastHeights(t, new Vector3(-10, 15, -5), dir)!;
    expect(hit).not.toBeNull();
    expect(hit.y).toBeCloseTo(heightAt(t, hit.x, hit.z), 2);
    // 地形の外を通る光線
    expect(raycastHeights(t, new Vector3(100, 10, 100), new Vector3(0, -1, 0))).toBeNull();
    // 移動・拡大したオブジェクト
    const obj = new Group();
    obj.position.set(10, 2, 0);
    obj.scale.set(2, 1, 2);
    obj.updateMatrixWorld(true);
    const w = raycastTerrainObject(obj, t, new Ray(new Vector3(12, 100, 0), new Vector3(0, -1, 0)))!;
    expect(w.y).toBeCloseTo(2 + heightAt(t, 1, 0), 2);
  });

  it('物理の Heightfield の並び (列・行の向き)', () => {
    const t = defaultTerrain(8, 8);
    t.heights[idx(8, 0, 7)] = 7; // x = 3, z = -4
    const hf = terrainHeightfield(t);
    if (hf.kind !== 'heightfield') throw new Error('heightfield');
    expect(hf.data).toHaveLength(9);
    expect(hf.data[7][8]).toBe(7); // 列 c=7, 行を逆にした j = 8 - 0
    expect(hf.offset).toEqual([-4, 0, 4]);
    expect(hf.elementSize).toBe(1);
    // 拡大すると間隔と高さも変わる
    const big = terrainHeightfield(t, 2, 3);
    if (big.kind === 'heightfield') {
      expect(big.elementSize).toBe(2);
      expect(big.data[7][8]).toBe(21);
    }
    const e = createEntity('terrain-flat');
    expect(resolveBodySpec(e, { autoColliders: false })).toEqual({ rb: null, collider: null });
  });

  it('箱が地形の上に落ちて止まる (盛った所は高い)', async () => {
    const world = await PhysicsWorld.create({ enabled: true, gravity: [0, -9.81, 0], autoColliders: false });
    const ground = createEntity('terrain-flat');
    ground.terrain = defaultTerrain(16, 16);
    // x > 0 の半分を 2m 高くする
    for (let r = 0; r <= 16; r++) for (let c = 9; c <= 16; c++) ground.terrain.heights[idx(16, r, c)] = 2;
    const gObj = new Group();
    gObj.updateMatrixWorld(true);
    world.addEntity(ground, gObj, resolveBodySpec(ground, { autoColliders: false })!);
    const drop = (x: number): number => {
      const box: EntityData = createEntity('cube', `箱${x}`);
      box.components.push({ id: `rb${x}`, type: 'rigidbody', enabled: true, props: { type: 'dynamic', mass: 1 } });
      box.transform.position = [x, 6, 0];
      const obj = new Group();
      obj.position.set(x, 6, 0);
      obj.updateMatrixWorld(true);
      world.addEntity(box, obj);
      for (let i = 0; i < 240; i++) world.step(1 / 60);
      return obj.position.y;
    };
    expect(drop(-4)).toBeCloseTo(0.5, 1);
    expect(drop(5)).toBeCloseTo(2.5, 1);
    // 真下への光線 (接地の判定に使う) も地形に当たる
    const hit = world.raycast([5, 10, 3], [5, -10, 3]);
    expect(hit?.id).toBe(ground.id);
    expect(hit!.point[1]).toBeCloseTo(2, 2);
  });
});
