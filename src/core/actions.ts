import { Matrix4, Vector3 } from 'three';
import { getComponentDef } from '../components/registry';
import type { CreateKind } from './catalog';
import { catalogItem, createEntity, MATERIAL_PRESETS } from './catalog';
import {
  AddEntitiesCommand,
  LambdaCommand,
  RemoveEntitiesCommand,
  SetTransformsCommand,
  SnapshotCommand,
  UpdateEntitiesCommand,
  ValueCommand,
} from './commands';
import type { Editor } from './Editor';
import { createEmptyScene } from './project';
import type { SceneModel } from './SceneModel';
import { matrixToTransform } from './transformMath';
import type { EntityData, EnvironmentData, GameSettings, MaterialPreset, MusicData, PhysicsSettings, SceneData, TransformData, Vec3 } from './types';
import { clone, createId, setPath, uniqueName } from './util';

/**
 * エディタの高レベル操作。UI (ボタン・ショートカット) はここの関数を呼ぶ。
 * すべての変更はコマンド経由で行うため Undo / Redo できる。
 */

// ------------------------------------------------------------------
// 追加 / 削除 / 複製
// ------------------------------------------------------------------

export interface AddOptions {
  /** ワールド座標での配置位置 (y は形状に応じて調整しない) */
  position?: Vec3;
  parent?: string | null;
  name?: string;
}

export function addEntity(editor: Editor, kind: CreateKind, opts: AddOptions = {}): string | null {
  const model = editor.scene;
  const e = createEntity(kind, opts.name);
  e.name = uniqueName(opts.name ?? catalogItem(kind).defaultName, model.names());
  if (opts.position) {
    e.transform.position = [opts.position[0], opts.position[1], opts.position[2]];
  }
  // 最初のカメラは自動的にメインカメラにする
  if (e.kind === 'camera' && !Object.values(model.data.entities).some((x) => x.camera?.main)) {
    e.camera!.main = true;
  }
  const parent = opts.parent && model.has(opts.parent) ? opts.parent : null;
  if (parent) {
    // 親のローカル座標系に変換して、指定したワールド位置に置く
    const inv = model.worldMatrix(parent).invert();
    const local = new Vector3(...e.transform.position).applyMatrix4(inv);
    e.transform.position = [local.x, local.y, local.z];
  }
  const cmd = new AddEntitiesCommand(model, [{ entities: [e], parent }], `${e.name}を追加`);
  return editor.execute(cmd, { select: [e.id] }) ? e.id : null;
}

export function deleteEntities(editor: Editor, ids: readonly string[] = editor.selection.ids): boolean {
  const targets = editor.scene.topLevel(ids);
  if (targets.length === 0) return false;
  const label = targets.length === 1 ? `${editor.scene.require(targets[0]).name}を削除` : `${targets.length}個のオブジェクトを削除`;
  return editor.execute(new RemoveEntitiesCommand(editor.scene, targets, label), { select: [] });
}

/** サブツリーを新しい ID で複製する (entities[0] がルート) */
export function cloneWithNewIds(entities: EntityData[]): EntityData[] {
  const map = new Map<string, string>();
  for (const e of entities) map.set(e.id, createId('e'));
  return entities.map((e) => {
    const c = clone(e);
    c.id = map.get(e.id)!;
    c.parent = e.parent && map.has(e.parent) ? map.get(e.parent)! : null;
    c.children = e.children.filter((id) => map.has(id)).map((id) => map.get(id)!);
    c.components = c.components.map((comp) => ({ ...comp, id: createId('c') }));
    // メインカメラは複製しない (1つだけにするため)
    if (c.camera) c.camera.main = false;
    return c;
  });
}

export function duplicateEntities(editor: Editor, ids: readonly string[] = editor.selection.ids, offset: Vec3 = [1, 0, 0]): string[] {
  const model = editor.scene;
  const targets = model.topLevel(ids);
  if (targets.length === 0) return [];
  const names = model.names();
  const items = targets.map((id) => {
    const src = model.subtree(id);
    const copy = cloneWithNewIds(src);
    const root = copy[0];
    root.name = uniqueName(root.name, names);
    names.push(root.name);
    root.transform.position = [
      root.transform.position[0] + offset[0],
      root.transform.position[1] + offset[1],
      root.transform.position[2] + offset[2],
    ];
    const parent = model.require(id).parent;
    return { entities: copy, parent, index: model.indexInParent(id) + 1 };
  });
  // 同じ親の中でインデックスがずれないよう、後ろから挿入する
  items.sort((a, b) => b.index - a.index);
  const newIds = items.map((it) => it.entities[0].id);
  const label = targets.length === 1 ? `${model.require(targets[0]).name}を複製` : `${targets.length}個を複製`;
  editor.execute(new AddEntitiesCommand(model, items, label), { select: newIds });
  return newIds;
}

// ------------------------------------------------------------------
// コピー / ペースト
// ------------------------------------------------------------------

interface ClipboardItem {
  entities: EntityData[];
  /** コピー元のワールド座標 (ペースト先がルートのため) */
  world: TransformData;
}

let clipboard: ClipboardItem[] = [];

export function hasClipboard(): boolean {
  return clipboard.length > 0;
}

export function copyEntities(editor: Editor, ids: readonly string[] = editor.selection.ids): number {
  const model = editor.scene;
  const targets = model.topLevel(ids);
  if (targets.length === 0) return 0;
  clipboard = targets.map((id) => ({
    entities: clone(model.subtree(id)),
    world: matrixToTransform(model.worldMatrix(id)),
  }));
  return clipboard.length;
}

export function pasteEntities(editor: Editor, offset: Vec3 = [0.5, 0, 0.5]): string[] {
  if (clipboard.length === 0) return [];
  const model = editor.scene;
  const names = model.names();
  const items = clipboard.map((item) => {
    const copy = cloneWithNewIds(item.entities);
    const root = copy[0];
    root.parent = null;
    root.name = uniqueName(root.name, names);
    names.push(root.name);
    root.transform = clone(item.world);
    root.transform.position = [
      root.transform.position[0] + offset[0],
      root.transform.position[1] + offset[1],
      root.transform.position[2] + offset[2],
    ];
    return { entities: copy, parent: null as string | null };
  });
  const newIds = items.map((it) => it.entities[0].id);
  editor.execute(new AddEntitiesCommand(model, items, `${items.length}個を貼り付け`), { select: newIds });
  return newIds;
}

// ------------------------------------------------------------------
// 親子関係 / グループ化
// ------------------------------------------------------------------

/** ワールド座標を保ったまま親を変更する (SnapshotCommand の中で使用) */
function reparentKeepWorld(model: SceneModel, id: string, parent: string | null, index = -1): void {
  const world = model.worldMatrix(id);
  const parentInv = model.worldMatrix(parent).invert();
  const local = new Matrix4().multiplyMatrices(parentInv, world);
  model.move(id, parent, index);
  model.setTransform(id, matrixToTransform(local));
}

export function canParent(model: SceneModel, id: string, parent: string | null): boolean {
  if (parent === null) return true;
  if (!model.has(parent)) return false;
  return !model.isAncestorOrSelf(id, parent);
}

export function setParent(editor: Editor, ids: readonly string[], parent: string | null): boolean {
  const model = editor.scene;
  const targets = model.topLevel(ids).filter((id) => canParent(model, id, parent) && model.require(id).parent !== parent);
  if (targets.length === 0) return false;
  const parentName = parent ? model.require(parent).name : 'ルート';
  const cmd = new SnapshotCommand(
    model,
    (m) => {
      for (const id of targets) reparentKeepWorld(m, id, parent);
    },
    `親を${parentName}に変更`,
  );
  return editor.execute(cmd, { select: targets });
}

export function groupEntities(editor: Editor, ids: readonly string[] = editor.selection.ids): string | null {
  const model = editor.scene;
  const targets = model.topLevel(ids);
  if (targets.length === 0) return null;
  // 全員が同じ親ならその親の下に、違う場合はルートにグループを作る
  const parents = new Set(targets.map((id) => model.require(id).parent));
  const parent = parents.size === 1 ? [...parents][0] : null;
  const center = new Vector3();
  for (const id of targets) center.add(new Vector3().setFromMatrixPosition(model.worldMatrix(id)));
  center.divideScalar(targets.length);
  const local = center.clone().applyMatrix4(model.worldMatrix(parent).invert());

  const group = createEntity('empty', uniqueName('グループ', model.names()));
  group.transform.position = [local.x, local.y, local.z].map((v) => Math.round(v * 1e4) / 1e4) as Vec3;
  const index = model.indexInParent(targets[0]);

  const cmd = new SnapshotCommand(
    model,
    (m) => {
      m.insert([clone(group)], parent, index);
      for (const id of targets) reparentKeepWorld(m, id, group.id);
    },
    `${targets.length}個をグループ化`,
  );
  return editor.execute(cmd, { select: [group.id] }) ? group.id : null;
}

/** グループ解除: 子を親の階層へ移し、空オブジェクトなら削除する */
export function ungroupEntity(editor: Editor, id: string | null = editor.selection.active): string[] {
  const model = editor.scene;
  const group = model.get(id);
  if (!group || group.children.length === 0) return [];
  const children = [...group.children];
  const parent = group.parent;
  const index = model.indexInParent(group.id);
  const removeGroup = group.kind === 'empty';
  const cmd = new SnapshotCommand(
    model,
    (m) => {
      children.forEach((cid, i) => reparentKeepWorld(m, cid, parent, index + 1 + i));
      if (removeGroup) m.remove(group.id);
    },
    `${group.name}のグループを解除`,
  );
  editor.execute(cmd, { select: children });
  return children;
}

/** 兄弟の中での並び順を変更する */
export function moveInSiblings(editor: Editor, id: string, delta: number): boolean {
  const model = editor.scene;
  const e = model.get(id);
  if (!e) return false;
  const list = model.childIds(e.parent);
  const from = list.indexOf(id);
  const to = Math.max(0, Math.min(list.length - 1, from + delta));
  if (from === to) return false;
  const cmd = new SnapshotCommand(model, (m) => m.move(id, e.parent, to), `${e.name}の順番を変更`);
  return editor.execute(cmd);
}

// ------------------------------------------------------------------
// 属性変更
// ------------------------------------------------------------------

export interface SetValueOptions {
  label?: string;
  /** 同じキーの連続変更を1回の Undo にまとめる */
  mergeKey?: string;
}

/**
 * 'transform.position.0' や 'mesh.material.color' のようなパスで値を設定する。
 * 複数選択時は該当する全エンティティに同じ値を設定する。
 */
export function setEntityValue(
  editor: Editor,
  ids: readonly string[],
  path: string,
  value: unknown,
  opts: SetValueOptions = {},
): boolean {
  const model = editor.scene;
  const targets = ids.filter((id) => model.has(id));
  if (targets.length === 0) return false;
  const transformOnly = path.startsWith('transform.');
  const cmd = UpdateEntitiesCommand.fromMutation(
    model,
    targets,
    (e) => {
      setPath(e, path, clone(value));
    },
    opts.label ?? 'プロパティを変更',
    opts.mergeKey ? `${opts.mergeKey}:${targets.join(',')}` : null,
    transformOnly,
  );
  return editor.execute(cmd, { mergeWindow: opts.mergeKey ? 1500 : 0 });
}

/** 任意の変更関数による更新 */
export function updateEntities(
  editor: Editor,
  ids: readonly string[],
  mutate: (e: EntityData) => void,
  label: string,
  mergeKey?: string,
): boolean {
  const model = editor.scene;
  const targets = ids.filter((id) => model.has(id));
  if (targets.length === 0) return false;
  const cmd = UpdateEntitiesCommand.fromMutation(
    model,
    targets,
    mutate,
    label,
    mergeKey ? `${mergeKey}:${targets.join(',')}` : null,
  );
  return editor.execute(cmd, { mergeWindow: mergeKey ? 1500 : 0 });
}

export function renameEntity(editor: Editor, id: string, name: string): boolean {
  const trimmed = name.trim().slice(0, 100);
  if (!trimmed) return false;
  return updateEntities(editor, [id], (e) => (e.name = trimmed), `名前を「${trimmed}」に変更`);
}

export function setVisible(editor: Editor, ids: readonly string[], visible: boolean): boolean {
  return updateEntities(editor, ids, (e) => (e.visible = visible), visible ? '表示' : '非表示');
}

export function setLocked(editor: Editor, ids: readonly string[], locked: boolean): boolean {
  return updateEntities(editor, ids, (e) => (e.locked = locked), locked ? 'ロック' : 'ロック解除');
}

export function toggleVisible(editor: Editor, id: string): boolean {
  const e = editor.scene.get(id);
  return e ? setVisible(editor, [id], !e.visible) : false;
}

export function toggleLocked(editor: Editor, id: string): boolean {
  const e = editor.scene.get(id);
  return e ? setLocked(editor, [id], !e.locked) : false;
}

/**
 * ギズモやドラッグで既に変更済みのトランスフォームを履歴に確定する。
 * before はドラッグ開始時の値。
 */
export function commitTransforms(editor: Editor, before: Map<string, TransformData>, label = '移動'): boolean {
  const model = editor.scene;
  const after = new Map<string, TransformData>();
  for (const id of before.keys()) {
    const e = model.get(id);
    if (e) after.set(id, clone(e.transform));
  }
  return editor.execute(new SetTransformsCommand(model, before, after, label));
}

export function resetTransform(editor: Editor, ids: readonly string[], part: 'position' | 'rotation' | 'scale'): boolean {
  const value: Vec3 = part === 'scale' ? [1, 1, 1] : [0, 0, 0];
  const labels = { position: '位置をリセット', rotation: '回転をリセット', scale: 'サイズをリセット' };
  return setEntityValue(editor, ids, `transform.${part}`, value, { label: labels[part] });
}

export function setMainCamera(editor: Editor, id: string): boolean {
  const model = editor.scene;
  const cams = Object.values(model.data.entities).filter((e) => e.kind === 'camera').map((e) => e.id);
  return updateEntities(editor, cams, (e) => (e.camera!.main = e.id === id), 'メインカメラを変更');
}

/** カメラエンティティを指定のワールド姿勢に合わせる (エディタの視点をカメラに反映) */
export function alignEntityToWorld(editor: Editor, id: string, world: Matrix4, label = 'カメラを現在の視点に合わせる'): boolean {
  const model = editor.scene;
  const e = model.get(id);
  if (!e) return false;
  const local = new Matrix4().multiplyMatrices(model.worldMatrix(e.parent).invert(), world);
  const t = matrixToTransform(local);
  t.scale = clone(e.transform.scale);
  return updateEntities(editor, [id], (x) => (x.transform = t), label);
}

// ------------------------------------------------------------------
// コンポーネント
// ------------------------------------------------------------------

export function addComponent(editor: Editor, id: string, type: string): boolean {
  const def = getComponentDef(type);
  if (!def) return false;
  const e = editor.scene.get(id);
  if (!e) return false;
  if (!def.allowMultiple && e.components.some((c) => c.type === type)) return false;
  return updateEntities(
    editor,
    [id],
    (x) => x.components.push({ id: createId('c'), type, enabled: true, props: def.defaults() }),
    `${def.label}を追加`,
  );
}

export function removeComponent(editor: Editor, id: string, componentId: string): boolean {
  return updateEntities(
    editor,
    [id],
    (x) => (x.components = x.components.filter((c) => c.id !== componentId)),
    'コンポーネントを削除',
  );
}

export function setComponentEnabled(editor: Editor, id: string, componentId: string, enabled: boolean): boolean {
  return updateEntities(
    editor,
    [id],
    (x) => {
      const c = x.components.find((cc) => cc.id === componentId);
      if (c) c.enabled = enabled;
    },
    enabled ? 'コンポーネントを有効化' : 'コンポーネントを無効化',
  );
}

export function setComponentProp(editor: Editor, id: string, componentId: string, key: string, value: unknown, merge = true): boolean {
  return updateEntities(
    editor,
    [id],
    (x) => {
      const c = x.components.find((cc) => cc.id === componentId);
      if (c) c.props[key] = clone(value);
    },
    'コンポーネントの設定を変更',
    merge ? `comp:${componentId}:${key}` : undefined,
  );
}

// ------------------------------------------------------------------
// シーン設定
// ------------------------------------------------------------------

export function setEnvironment(editor: Editor, patch: Partial<EnvironmentData>, label = '環境を変更', mergeKey?: string): boolean {
  const scene = editor.sceneData;
  const before = clone(scene.environment);
  const after = { ...clone(scene.environment), ...clone(patch) };
  const apply = (env: EnvironmentData) => {
    scene.environment = env;
    editor.events.emit('environment-changed', undefined);
  };
  const cmd = new ValueCommand(label, apply, before, after, mergeKey ? `env:${scene.id}:${mergeKey}` : null);
  return editor.execute(cmd, { mergeWindow: mergeKey ? 1500 : 0 });
}

export function setPhysicsSettings(editor: Editor, patch: Partial<PhysicsSettings>, label = '物理設定を変更', mergeKey?: string): boolean {
  const scene = editor.sceneData;
  const before = clone(scene.physics);
  const after = { ...clone(scene.physics), ...clone(patch) };
  const apply = (v: PhysicsSettings) => {
    scene.physics = v;
    editor.events.emit('environment-changed', undefined);
  };
  const cmd = new ValueCommand(label, apply, before, after, mergeKey ? `phys:${scene.id}:${mergeKey}` : null);
  return editor.execute(cmd, { mergeWindow: mergeKey ? 1500 : 0 });
}

export function setMusic(editor: Editor, patch: Partial<MusicData>, label = 'BGM を変更', mergeKey?: string): boolean {
  const scene = editor.sceneData;
  const before = clone(scene.music);
  const after = { ...clone(scene.music), ...clone(patch) };
  const apply = (v: MusicData) => {
    scene.music = v;
    editor.events.emit('environment-changed', undefined);
  };
  const cmd = new ValueCommand(label, apply, before, after, mergeKey ? `music:${scene.id}:${mergeKey}` : null);
  return editor.execute(cmd, { mergeWindow: mergeKey ? 1500 : 0 });
}

/** ゲーム全体の設定 (タイトル・制限時間など) を変更する */
export function setGameSettings(editor: Editor, patch: Partial<GameSettings>, label = 'ゲーム設定を変更', mergeKey?: string): boolean {
  const project = editor.project;
  const before = clone(project.game);
  const after = { ...clone(project.game), ...clone(patch) };
  const apply = (v: GameSettings) => {
    project.game = v;
    editor.events.emit('project-changed', undefined);
  };
  const cmd = new ValueCommand(label, apply, before, after, mergeKey ? `game:${mergeKey}` : null);
  return editor.execute(cmd, { mergeWindow: mergeKey ? 1500 : 0 });
}

/** マテリアルのプリセットを適用する (推奨値もまとめて設定し、1回で元に戻せる) */
export function applyMaterialPreset(editor: Editor, ids: readonly string[], preset: MaterialPreset): boolean {
  const info = MATERIAL_PRESETS.find((p) => p.preset === preset);
  const targets = ids.filter((id) => editor.scene.get(id)?.mesh);
  if (!info || targets.length === 0) return false;
  return updateEntities(
    editor,
    targets,
    (e) => {
      Object.assign(e.mesh!.material, clone(info.values), { preset });
      if (preset === 'water') e.mesh!.castShadow = false;
    },
    `マテリアルを「${info.label}」に変更`,
  );
}

export function setPlayer(editor: Editor, id: string | null): boolean {
  const scene = editor.sceneData;
  const before = scene.playerId;
  const apply = (v: string | null) => {
    scene.playerId = v;
    editor.events.emit('environment-changed', undefined);
  };
  return editor.execute(new LambdaCommand('プレイヤーを設定', () => apply(id), () => apply(before)));
}

// ------------------------------------------------------------------
// シーン管理 (プロジェクト単位の操作。Undo 対象外)
// ------------------------------------------------------------------

export function createScene(editor: Editor, name?: string): SceneData {
  const p = editor.project;
  const scene = createEmptyScene(uniqueName(name ?? `シーン${p.scenes.length + 1}`, p.scenes.map((s) => s.name)));
  p.scenes.push(scene);
  editor.setActiveScene(scene.id);
  return scene;
}

export function addSceneData(editor: Editor, scene: SceneData, activate = true): SceneData {
  const p = editor.project;
  const s = clone(scene);
  s.id = createId('s');
  s.name = uniqueName(s.name, p.scenes.map((x) => x.name));
  p.scenes.push(s);
  if (activate) editor.setActiveScene(s.id);
  else {
    editor.markDirty();
    editor.events.emit('project-changed', undefined);
  }
  return s;
}

export function duplicateScene(editor: Editor, id: string): SceneData | null {
  const src = editor.findScene(id);
  if (!src) return null;
  return addSceneData(editor, { ...clone(src), name: `${src.name} コピー` });
}

export function renameScene(editor: Editor, id: string, name: string): boolean {
  const s = editor.findScene(id);
  const trimmed = name.trim().slice(0, 100);
  if (!s || !trimmed) return false;
  s.name = trimmed;
  editor.markDirty();
  editor.events.emit('project-changed', undefined);
  return true;
}

export function deleteScene(editor: Editor, id: string): boolean {
  const p = editor.project;
  if (p.scenes.length <= 1) return false;
  const idx = p.scenes.findIndex((s) => s.id === id);
  if (idx < 0) return false;
  const wasActive = editor.sceneData.id === id;
  p.scenes.splice(idx, 1);
  editor.forgetScene(id);
  if (p.startSceneId === id) p.startSceneId = p.scenes[0].id;
  if (wasActive) editor.setActiveScene(p.scenes[Math.max(0, idx - 1)].id);
  editor.markDirty();
  editor.events.emit('project-changed', undefined);
  return true;
}

export function setStartScene(editor: Editor, id: string): void {
  if (!editor.findScene(id)) return;
  editor.project.startSceneId = id;
  editor.markDirty();
  editor.events.emit('project-changed', undefined);
}

export function renameProject(editor: Editor, name: string): boolean {
  const trimmed = name.trim().slice(0, 100);
  if (!trimmed) return false;
  editor.project.name = trimmed;
  editor.markDirty();
  editor.events.emit('project-changed', undefined);
  return true;
}
