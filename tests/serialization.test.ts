import { describe, expect, it } from 'vitest';
import { createProject } from '../src/core/project';
import { parseProjectJson, parseSceneJson, ProjectFormatError, sanitizeProject, sceneToFile } from '../src/core/serialization';

describe('serialization', () => {
  it('プロジェクトを JSON 経由で往復できる', () => {
    const p = createProject('往復テスト');
    const restored = parseProjectJson(JSON.stringify(p));
    expect(restored).toEqual(p);
  });

  it('不正な JSON はエラーになる', () => {
    expect(() => parseProjectJson('{')).toThrow(ProjectFormatError);
    expect(() => parseProjectJson('{"format":"other"}')).toThrow(ProjectFormatError);
  });

  it('壊れた親子関係を修復する', () => {
    const p = createProject('修復');
    const s = p.scenes[0];
    const [a, b] = s.roots;
    // 存在しない子・循環・孤立を作る
    s.entities[a].children.push('missing', b);
    s.entities[b].children.push(a);
    s.roots = [a];
    const fixed = sanitizeProject(JSON.parse(JSON.stringify(p)));
    const fs = fixed.scenes[0];
    expect(fs.entities[a].children).toEqual([b]);
    expect(fs.entities[b].children).toEqual([]);
    expect(fs.entities[b].parent).toBe(a);
    // すべてのエンティティがどこかから辿れる
    const reach = new Set<string>();
    const visit = (id: string) => {
      reach.add(id);
      fs.entities[id].children.forEach(visit);
    };
    fs.roots.forEach(visit);
    expect(reach.size).toBe(Object.keys(fs.entities).length);
  });

  it('欠けた値は既定値で補う', () => {
    const p = createProject('補完');
    const raw = JSON.parse(JSON.stringify(p));
    const id = raw.scenes[0].roots[0];
    delete raw.scenes[0].entities[id].transform;
    raw.scenes[0].entities[id].mesh.material.color = 'not-a-color';
    const fixed = sanitizeProject(raw);
    const e = fixed.scenes[0].entities[id];
    expect(e.transform.scale).toEqual([1, 1, 1]);
    expect(e.mesh!.material.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('新しいバージョンのデータは拒否する', () => {
    const raw = JSON.parse(JSON.stringify(createProject('未来')));
    raw.version = 999;
    expect(() => sanitizeProject(raw)).toThrow(/新しいバージョン/);
  });

  it('シーン単体の書き出しと読み込み', () => {
    const p = createProject('シーン');
    const text = JSON.stringify(sceneToFile(p.scenes[0]));
    const s = parseSceneJson(text);
    expect(s.name).toBe(p.scenes[0].name);
    expect(Object.keys(s.entities)).toHaveLength(Object.keys(p.scenes[0].entities).length);
  });
});

describe('Phase 2 の後方互換', () => {
  it('Phase 1 形式のデータに新しい項目を補う', () => {
    const p = createProject('旧データ');
    const raw = JSON.parse(JSON.stringify(p));
    const scene = raw.scenes[0];
    // Phase 1 の形式に戻す
    scene.environment = { background: '#123456' };
    delete scene.physics;
    for (const e of Object.values(scene.entities) as { mesh?: { material: Record<string, unknown> } }[]) {
      if (!e.mesh) continue;
      for (const k of ['pattern', 'texture', 'uvScale', 'uvOffset', 'uvRotation', 'envIntensity']) delete e.mesh.material[k];
    }
    const fixed = sanitizeProject(raw);
    const s = fixed.scenes[0];
    // 見た目が変わらないよう「単色の背景」になる
    expect(s.environment.sky.type).toBe('color');
    expect(s.environment.background).toBe('#123456');
    expect(s.environment.fog.enabled).toBe(false);
    expect(s.physics).toEqual({ enabled: true, gravity: [0, -9.81, 0], autoColliders: true });
    const mesh = Object.values(s.entities).find((e) => e.mesh)!;
    expect(mesh.mesh!.material).toMatchObject({ pattern: 'none', texture: null, uvScale: [1, 1], uvOffset: [0, 0], uvRotation: 0, envIntensity: 1 });
  });

  it('新しいシーンはグラデーションの空', () => {
    expect(createProject('新規').scenes[0].environment.sky.type).toBe('gradient');
  });

  it('アセットのメタ情報を検証する', () => {
    const raw = JSON.parse(JSON.stringify(createProject('アセット')));
    raw.assets = [{ id: 'a1', name: '画像', type: 'image', folder: '', mime: 'image/png', size: 10, createdAt: 1 }, { id: 'a1', name: '重複' }, 'x', { name: 'IDなし' }];
    const fixed = sanitizeProject(raw);
    expect(fixed.assets).toHaveLength(1);
    expect(fixed.assets[0].name).toBe('画像');
  });
});
