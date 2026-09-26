import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import * as A from '../src/core/actions';
import { History } from '../src/core/History';
import { evaluateExpression, normalizeHex, uniqueName } from '../src/core/util';
import { makeEditor } from './helpers';

describe('util', () => {
  it('uniqueName が重複しない名前を作る', () => {
    expect(uniqueName('キューブ', [])).toBe('キューブ');
    expect(uniqueName('キューブ', ['キューブ'])).toBe('キューブ 2');
    expect(uniqueName('キューブ 2', ['キューブ', 'キューブ 2'])).toBe('キューブ 3');
  });
  it('normalizeHex', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('12ab34')).toBe('#12ab34');
    expect(normalizeHex('xyz')).toBeNull();
  });
  it('evaluateExpression は四則演算のみ評価する', () => {
    expect(evaluateExpression('1+2*3')).toBe(7);
    expect(evaluateExpression('-(2+3)/5')).toBe(-1);
    expect(evaluateExpression('1.5')).toBe(1.5);
    expect(evaluateExpression('alert(1)')).toBeNull();
    expect(evaluateExpression('')).toBeNull();
  });
});

describe('追加・削除・Undo/Redo', () => {
  it('キューブを追加して Undo/Redo できる', () => {
    const ed = makeEditor();
    const before = ed.scene.count;
    const id = A.addEntity(ed, 'cube')!;
    expect(ed.scene.count).toBe(before + 1);
    expect(ed.selection.ids).toEqual([id]);
    expect(ed.scene.get(id)!.kind).toBe('mesh');
    ed.undo();
    expect(ed.scene.has(id)).toBe(false);
    expect(ed.selection.size).toBe(0);
    ed.redo();
    expect(ed.scene.has(id)).toBe(true);
    expect(ed.selection.ids).toEqual([id]);
  });

  it('名前が重複しない', () => {
    const ed = makeEditor();
    const a = A.addEntity(ed, 'cube')!;
    const b = A.addEntity(ed, 'cube')!;
    expect(ed.scene.get(a)!.name).toBe('キューブ');
    expect(ed.scene.get(b)!.name).toBe('キューブ 2');
  });

  it('親子ごと削除して元の位置に戻せる', () => {
    const ed = makeEditor();
    const a = A.addEntity(ed, 'cube')!;
    const b = A.addEntity(ed, 'sphere')!;
    A.setParent(ed, [b], a);
    const rootsBefore = [...ed.sceneData.roots];
    A.deleteEntities(ed, [a, b]);
    expect(ed.scene.has(a)).toBe(false);
    expect(ed.scene.has(b)).toBe(false);
    ed.undo();
    expect(ed.sceneData.roots).toEqual(rootsBefore);
    expect(ed.scene.get(a)!.children).toEqual([b]);
    expect(ed.scene.get(b)!.parent).toBe(a);
  });

  it('複製は新しい ID と名前で隣に挿入される', () => {
    const ed = makeEditor();
    const a = A.addEntity(ed, 'cube')!;
    const child = A.addEntity(ed, 'sphere')!;
    A.setParent(ed, [child], a);
    const [dup] = A.duplicateEntities(ed, [a]);
    const d = ed.scene.get(dup)!;
    expect(dup).not.toBe(a);
    expect(d.name).toBe('キューブ 2');
    expect(d.children).toHaveLength(1);
    expect(d.children[0]).not.toBe(child);
    expect(ed.scene.get(d.children[0])!.parent).toBe(dup);
    const roots = ed.sceneData.roots;
    expect(roots.indexOf(dup)).toBe(roots.indexOf(a) + 1);
    expect(d.transform.position[0]).toBeCloseTo(ed.scene.get(a)!.transform.position[0] + 1);
  });

  it('コピー＆ペースト', () => {
    const ed = makeEditor();
    const a = A.addEntity(ed, 'cube')!;
    expect(A.copyEntities(ed, [a])).toBe(1);
    const pasted = A.pasteEntities(ed);
    expect(pasted).toHaveLength(1);
    expect(ed.scene.get(pasted[0])!.name).toBe('キューブ 2');
    expect(ed.selection.ids).toEqual(pasted);
  });
});

describe('プロパティ変更', () => {
  it('パス指定で値を変更し Undo できる', () => {
    const ed = makeEditor();
    const a = A.addEntity(ed, 'cube')!;
    A.setEntityValue(ed, [a], 'mesh.material.color', '#ff0000');
    expect(ed.scene.get(a)!.mesh!.material.color).toBe('#ff0000');
    ed.undo();
    expect(ed.scene.get(a)!.mesh!.material.color).not.toBe('#ff0000');
  });

  it('同じ mergeKey の連続変更は1回の Undo にまとまる', () => {
    const ed = makeEditor();
    const a = A.addEntity(ed, 'cube')!;
    const size = ed.history.size;
    A.setEntityValue(ed, [a], 'transform.position.0', 1, { mergeKey: 'px' });
    A.setEntityValue(ed, [a], 'transform.position.0', 2, { mergeKey: 'px' });
    A.setEntityValue(ed, [a], 'transform.position.0', 3, { mergeKey: 'px' });
    expect(ed.history.size).toBe(size + 1);
    ed.undo();
    expect(ed.scene.get(a)!.transform.position[0]).toBe(0);
  });

  it('複数選択に同じ値を設定できる', () => {
    const ed = makeEditor();
    const a = A.addEntity(ed, 'cube')!;
    const b = A.addEntity(ed, 'sphere')!;
    A.setEntityValue(ed, [a, b], 'transform.scale', [2, 2, 2]);
    expect(ed.scene.get(a)!.transform.scale).toEqual([2, 2, 2]);
    expect(ed.scene.get(b)!.transform.scale).toEqual([2, 2, 2]);
  });

  it('名前変更・表示・ロック', () => {
    const ed = makeEditor();
    const a = A.addEntity(ed, 'cube')!;
    A.renameEntity(ed, a, '  ドア  ');
    expect(ed.scene.get(a)!.name).toBe('ドア');
    expect(A.renameEntity(ed, a, '   ')).toBe(false);
    A.toggleVisible(ed, a);
    expect(ed.scene.get(a)!.visible).toBe(false);
    A.toggleLocked(ed, a);
    expect(ed.scene.get(a)!.locked).toBe(true);
    ed.undo();
    ed.undo();
    expect(ed.scene.get(a)!.visible).toBe(true);
    expect(ed.scene.get(a)!.locked).toBe(false);
  });
});

describe('親子関係・グループ', () => {
  const worldPos = (ed: ReturnType<typeof makeEditor>, id: string) =>
    new Vector3().setFromMatrixPosition(ed.scene.worldMatrix(id));

  it('親を変更してもワールド位置が保たれる', () => {
    const ed = makeEditor();
    const parent = A.addEntity(ed, 'cube', { position: [5, 1, 0] })!;
    A.setEntityValue(ed, [parent], 'transform.rotation', [0, 90, 0]);
    A.setEntityValue(ed, [parent], 'transform.scale', [2, 2, 2]);
    const child = A.addEntity(ed, 'sphere', { position: [1, 2, 3] })!;
    const before = worldPos(ed, child);
    expect(A.setParent(ed, [child], parent)).toBe(true);
    expect(ed.scene.get(child)!.parent).toBe(parent);
    expect(worldPos(ed, child).distanceTo(before)).toBeLessThan(1e-3);
    ed.undo();
    expect(ed.scene.get(child)!.parent).toBeNull();
    expect(ed.scene.get(child)!.transform.position).toEqual([1, 2, 3]);
  });

  it('子孫を親にはできない', () => {
    const ed = makeEditor();
    const a = A.addEntity(ed, 'cube')!;
    const b = A.addEntity(ed, 'cube')!;
    A.setParent(ed, [b], a);
    expect(A.setParent(ed, [a], b)).toBe(false);
    expect(A.setParent(ed, [a], a)).toBe(false);
  });

  it('グループ化と解除', () => {
    const ed = makeEditor();
    const a = A.addEntity(ed, 'cube', { position: [0, 0, 0] })!;
    const b = A.addEntity(ed, 'cube', { position: [4, 0, 0] })!;
    const pa = worldPos(ed, a);
    const g = A.groupEntities(ed, [a, b])!;
    expect(ed.scene.get(g)!.children).toEqual([a, b]);
    expect(ed.scene.get(g)!.transform.position).toEqual([2, 0, 0]);
    expect(worldPos(ed, a).distanceTo(pa)).toBeLessThan(1e-3);
    const children = A.ungroupEntity(ed, g);
    expect(children).toEqual([a, b]);
    expect(ed.scene.has(g)).toBe(false);
    expect(ed.scene.get(a)!.parent).toBeNull();
    expect(worldPos(ed, a).distanceTo(pa)).toBeLessThan(1e-3);
    ed.undo();
    expect(ed.scene.get(a)!.parent).toBe(g);
    ed.undo();
    expect(ed.scene.has(g)).toBe(false);
  });

  it('並び替え', () => {
    const ed = makeEditor();
    const a = A.addEntity(ed, 'cube')!;
    const b = A.addEntity(ed, 'cube')!;
    const roots = ed.sceneData.roots;
    const ia = roots.indexOf(a);
    A.moveInSiblings(ed, b, -1);
    expect(ed.sceneData.roots.indexOf(b)).toBe(ia);
  });
});

describe('コンポーネント・シーン', () => {
  it('コンポーネントの追加・変更・削除', () => {
    const ed = makeEditor();
    const a = A.addEntity(ed, 'cube')!;
    expect(A.addComponent(ed, a, 'rotator')).toBe(true);
    expect(A.addComponent(ed, a, 'rotator')).toBe(false);
    const comp = ed.scene.get(a)!.components[0];
    A.setComponentProp(ed, a, comp.id, 'speed', [0, 10, 0]);
    expect(ed.scene.get(a)!.components[0].props.speed).toEqual([0, 10, 0]);
    A.removeComponent(ed, a, comp.id);
    expect(ed.scene.get(a)!.components).toHaveLength(0);
  });

  it('シーンの作成・切り替え・削除 (履歴はシーンごと)', () => {
    const ed = makeEditor();
    const first = ed.sceneData.id;
    A.addEntity(ed, 'cube');
    const s2 = A.createScene(ed);
    expect(ed.sceneData.id).toBe(s2.id);
    expect(ed.history.canUndo).toBe(false);
    ed.setActiveScene(first);
    expect(ed.history.canUndo).toBe(true);
    expect(A.deleteScene(ed, first)).toBe(true);
    expect(ed.sceneData.id).toBe(s2.id);
    expect(A.deleteScene(ed, s2.id)).toBe(false);
  });

  it('メインカメラは1つだけ', () => {
    const ed = makeEditor();
    const cam = A.addEntity(ed, 'camera')!;
    A.setMainCamera(ed, cam);
    const mains = Object.values(ed.sceneData.entities).filter((e) => e.camera?.main);
    expect(mains.map((e) => e.id)).toEqual([cam]);
  });
});

describe('History', () => {
  it('上限を超えると古い履歴が消える', () => {
    const h = new History(3);
    for (let i = 0; i < 5; i++) {
      h.push({ command: { label: `${i}`, execute() {}, undo() {} }, selectionBefore: [], selectionAfter: [], time: i });
    }
    expect(h.size).toBe(3);
    expect(h.undoLabel).toBe('4');
  });
});
