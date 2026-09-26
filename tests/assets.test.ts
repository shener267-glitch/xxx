import { beforeAll, describe, expect, it } from 'vitest';
import { registerBuiltinComponents } from '../src/components/builtin';
import { entityFromAsset } from '../src/core/assetPlacement';
import { createEntity } from '../src/core/catalog';
import { computeColliderShape } from '../src/engine/colliderShapes';
import { collectSubtree, createPrefab, instantiatePrefab, scatterPlacements, DEFAULT_SCATTER } from '../src/core/prefabs';
import { createProject } from '../src/core/project';
import { parseProjectJson } from '../src/core/serialization';
import type { AssetEntry } from '../src/core/types';
import { parseModel } from '../src/engine/models';
import { makeTestGlb } from './fixtures/glb';

beforeAll(() => registerBuiltinComponents());

describe('3D モデル', () => {
  it('GLB を読み込み、大きさ・中心・アニメーションを調べる', async () => {
    const glb = makeTestGlb();
    const m = await parseModel(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer);
    expect(m.size).toEqual([1, 2, 1]);
    expect(m.center).toEqual([0, 1, 0]);
    expect(m.triangles).toBe(12);
    expect(m.animations.map((a) => a.name)).toEqual(['Idle', 'Walk']);
  });

  it('モデルのアセットから置くオブジェクトを作る (底を地面に合わせる・大きすぎるものは縮める)', () => {
    const a: AssetEntry = { id: 'a1', name: '木', type: 'model', folder: '', mime: '', size: 1, createdAt: 0, info: { modelSize: [1, 2, 1], modelCenter: [0, 1, 0] } };
    const e = entityFromAsset(a, [3, 0, -2])!;
    expect(e.kind).toBe('model');
    expect(e.model).toMatchObject({ asset: 'a1', size: [1, 2, 1], center: [0, 1, 0] });
    expect(e.transform.position).toEqual([3, 0, -2]);
    const big = entityFromAsset({ ...a, info: { modelSize: [100, 50, 80], modelCenter: [0, 0, 0] } }, [0, 0, 0])!;
    expect(big.transform.scale[0]).toBeCloseTo(0.02);
    expect(big.transform.position[1]).toBeCloseTo(0.5);
    // 当たり判定は箱 (モデルの大きさ × 拡大)
    const shape = computeColliderShape(e, [2, 2, 2], null);
    expect(shape).toEqual({ kind: 'box', half: [1, 2, 1], offset: [0, 2, 0] });
  });

  it('画像は縦横比に合わせた板、音声は効果音のオブジェクトになる', () => {
    const img = entityFromAsset({ id: 'i', name: '看板', type: 'image', folder: '', mime: '', size: 1, createdAt: 0, info: { width: 400, height: 200 } }, [0, 0, 0])!;
    expect(img.mesh!.material.texture).toBe('i');
    expect(img.transform.scale[0] / img.transform.scale[2]).toBeCloseTo(2);
    const snd = entityFromAsset({ id: 's', name: '鐘', type: 'audio', folder: '', mime: '', size: 1, createdAt: 0 }, [0, 0, 0])!;
    expect(snd.components[0]).toMatchObject({ type: 'sound', props: { sound: 's' } });
    expect(entityFromAsset({ id: 'f', name: 'F', type: 'font', folder: '', mime: '', size: 1, createdAt: 0 }, [0, 0, 0])).toBeNull();
  });
});

describe('Prefab', () => {
  it('サブツリーから作り、新しい ID で何度でも置ける', () => {
    const root = createEntity('empty', '家');
    root.transform.position = [5, 0, 5];
    const roof = createEntity('cone', '屋根');
    roof.parent = root.id;
    root.children = [roof.id];
    const pf = createPrefab([root, roof], '家');
    expect(pf.entities[pf.root].transform.position).toEqual([0, 0, 0]);
    expect(collectSubtree(pf.entities, pf.root)).toHaveLength(2);
    const a = instantiatePrefab(pf);
    const b = instantiatePrefab(pf);
    expect(a[0].id).not.toBe(b[0].id);
    expect(a[0].prefab).toBe(pf.id);
    expect(a[1].parent).toBe(a[0].id);
    expect(a[0].children).toEqual([a[1].id]);
    // 元のデータは変わらない
    expect(root.transform.position).toEqual([5, 0, 5]);
  });

  it('Prefab・フォルダ・モデルは保存形式で往復できる', () => {
    const p = createProject('P');
    const root = createEntity('cube', '箱');
    p.prefabs = [createPrefab([root], '箱', '部品/小物')];
    p.assetFolders = ['部品/小物', 'モデル'];
    const m = entityFromAsset({ id: 'a1', name: 'M', type: 'model', folder: '', mime: '', size: 1, createdAt: 0, info: { modelSize: [1, 1, 1], modelCenter: [0, 0.5, 0] } }, [0, 0, 0])!;
    m.prefab = p.prefabs[0].id;
    p.scenes[0].entities[m.id] = m;
    p.scenes[0].roots.push(m.id);
    expect(parseProjectJson(JSON.stringify(p))).toEqual(p);
  });
});

describe('大量配置', () => {
  it('格子・一列・円・ばらばら', () => {
    const grid = scatterPlacements({ ...DEFAULT_SCATTER, pattern: 'grid', rows: 2, cols: 3, spacing: 2, randomRotation: false, randomScale: 0 }, [10, 0, 0]);
    expect(grid).toHaveLength(6);
    expect(grid[0].position).toEqual([8, 0, -1]);
    expect(grid[5].position).toEqual([12, 0, 1]);
    const line = scatterPlacements({ ...DEFAULT_SCATTER, pattern: 'line', count: 5, spacing: 1 }, [0, 0, 0]);
    expect(line.map((p) => p.position[0])).toEqual([-2, -1, 0, 1, 2]);
    const circle = scatterPlacements({ ...DEFAULT_SCATTER, pattern: 'circle', count: 4, radius: 3, randomRotation: false, faceCenter: true, randomScale: 0 }, [0, 0, 0]);
    expect(circle.every((p) => Math.abs(Math.hypot(p.position[0], p.position[2]) - 3) < 0.01)).toBe(true);
    const rnd = scatterPlacements({ ...DEFAULT_SCATTER, pattern: 'random', count: 50, width: 10, depth: 4, randomScale: 0.3 }, [0, 0, 0]);
    expect(rnd).toHaveLength(50);
    expect(rnd.every((p) => Math.abs(p.position[0]) <= 5 && Math.abs(p.position[2]) <= 2 && p.scale >= 0.7 && p.scale <= 1.3)).toBe(true);
    // 同じ設定なら同じ配置 (やり直しても変わらない)
    expect(scatterPlacements({ ...DEFAULT_SCATTER, pattern: 'random', count: 5 }, [0, 0, 0])).toEqual(scatterPlacements({ ...DEFAULT_SCATTER, pattern: 'random', count: 5 }, [0, 0, 0]));
    // 上限 500
    expect(scatterPlacements({ ...DEFAULT_SCATTER, pattern: 'grid', rows: 50, cols: 50 }, [0, 0, 0])).toHaveLength(500);
  });
});
