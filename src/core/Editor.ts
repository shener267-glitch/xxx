import { Emitter } from './Emitter';
import type { Command } from './History';
import { History } from './History';
import { logger } from './logger';
import type { SceneEvents } from './SceneModel';
import { SceneModel } from './SceneModel';
import { Selection } from './Selection';
import type { EditorSettings } from './settings';
import { DEFAULT_SETTINGS } from './settings';
import type { EntityData, ProjectData, SceneData } from './types';

export type Tool = 'select' | 'translate' | 'rotate' | 'scale';
export type TransformSpace = 'world' | 'local';
export type EditorMode = 'edit' | 'play';

export interface EditorEvents extends SceneEvents {
  'selection-changed': void;
  'history-changed': void;
  'tool-changed': void;
  'mode-changed': EditorMode;
  'settings-changed': keyof EditorSettings | null;
  /** プロジェクト名・シーン一覧・アクティブシーンなどの変更 */
  'project-changed': void;
  'environment-changed': void;
  'dirty-changed': boolean;
  /** ビューポートにフォーカス (カメラを寄せる) 要求 */
  'focus-request': string[];
  /** アセット一覧の変更 */
  'assets-changed': void;
  /** イベント・変数の変更 */
  'events-changed': void;
}

export interface ExecuteOptions {
  /** 実行後に選択する ID */
  select?: string[];
  /** この時間 (ms) 以内の同種の変更は1回の Undo にまとめる */
  mergeWindow?: number;
}

/**
 * エディタの中心となる状態管理クラス。
 * DOM や Three.js の描画には依存しない (単体テスト可能にするため)。
 */
export class Editor {
  readonly events = new Emitter<EditorEvents>();
  readonly selection: Selection;
  project!: ProjectData;
  scene!: SceneModel;
  settings: EditorSettings;
  tool: Tool = 'translate';
  space: TransformSpace = 'world';
  mode: EditorMode = 'edit';
  /** タッチ操作用の「複数選択モード」 */
  multiSelect = false;
  dirty = false;

  private models = new Map<string, SceneModel>();
  private histories = new Map<string, History>();

  constructor(project: ProjectData, settings: EditorSettings = { ...DEFAULT_SETTINGS }) {
    this.settings = settings;
    this.selection = new Selection(() => this.events.emit('selection-changed', undefined));
    this.loadProject(project);
  }

  // ------------------------------------------------------------------
  // プロジェクト / シーン
  // ------------------------------------------------------------------

  loadProject(project: ProjectData): void {
    this.project = project;
    this.models.clear();
    this.histories.clear();
    const id = project.scenes.some((s) => s.id === project.activeSceneId) ? project.activeSceneId : project.scenes[0].id;
    this.activateScene(id);
    this.setDirty(false);
    this.events.emit('project-changed', undefined);
  }

  get history(): History {
    let h = this.histories.get(this.scene.data.id);
    if (!h) {
      h = new History(100);
      this.histories.set(this.scene.data.id, h);
    }
    return h;
  }

  get sceneData(): SceneData {
    return this.scene.data;
  }

  findScene(id: string): SceneData | undefined {
    return this.project.scenes.find((s) => s.id === id);
  }

  /** アクティブシーンを切り替える (Undo 履歴はシーンごとに保持) */
  setActiveScene(id: string): void {
    if (this.scene && this.scene.data.id === id) return;
    if (!this.findScene(id)) throw new Error(`シーンが見つかりません: ${id}`);
    this.activateScene(id);
    this.markDirty();
    this.events.emit('project-changed', undefined);
  }

  private activateScene(id: string): void {
    const data = this.findScene(id)!;
    let model = this.models.get(id);
    if (!model || model.data !== data) {
      model = new SceneModel(data, this.events);
      this.models.set(id, model);
    }
    this.scene = model;
    this.project.activeSceneId = id;
    this.selection.clear();
    this.events.emit('scene-loaded', data);
    this.events.emit('history-changed', undefined);
    this.events.emit('environment-changed', undefined);
  }

  /** シーン削除時などに内部キャッシュを破棄する */
  forgetScene(id: string): void {
    this.models.delete(id);
    this.histories.delete(id);
  }

  // ------------------------------------------------------------------
  // コマンド実行 / Undo / Redo
  // ------------------------------------------------------------------

  execute(command: Command, opts: ExecuteOptions = {}): boolean {
    if (this.mode === 'play') {
      logger.warn('Play 中はシーンを編集できません', 'Editor');
      return false;
    }
    const selectionBefore = [...this.selection.ids];
    try {
      command.execute();
    } catch (err) {
      logger.error(`「${command.label}」に失敗しました: ${err instanceof Error ? err.message : String(err)}`, 'Editor', err);
      return false;
    }
    if (opts.select) this.selection.set(opts.select);
    this.selection.prune((id) => this.scene.has(id));
    this.history.push(
      { command, selectionBefore, selectionAfter: [...this.selection.ids], time: Date.now() },
      opts.mergeWindow ?? 0,
    );
    this.markDirty();
    this.events.emit('history-changed', undefined);
    return true;
  }

  undo(): void {
    if (this.mode === 'play') return;
    try {
      const entry = this.history.undo();
      if (!entry) return;
      this.selection.set(entry.selectionBefore.filter((id) => this.scene.has(id)));
    } catch (err) {
      logger.error('元に戻す操作に失敗しました', 'Editor', err);
    }
    this.selection.prune((id) => this.scene.has(id));
    this.markDirty();
    this.events.emit('history-changed', undefined);
  }

  redo(): void {
    if (this.mode === 'play') return;
    try {
      const entry = this.history.redo();
      if (!entry) return;
      this.selection.set(entry.selectionAfter.filter((id) => this.scene.has(id)));
    } catch (err) {
      logger.error('やり直し操作に失敗しました', 'Editor', err);
    }
    this.selection.prune((id) => this.scene.has(id));
    this.markDirty();
    this.events.emit('history-changed', undefined);
  }

  // ------------------------------------------------------------------
  // 状態
  // ------------------------------------------------------------------

  markDirty(): void {
    this.setDirty(true);
  }

  setDirty(dirty: boolean): void {
    if (this.dirty === dirty) return;
    this.dirty = dirty;
    this.events.emit('dirty-changed', dirty);
  }

  setTool(tool: Tool): void {
    if (this.tool === tool) return;
    this.tool = tool;
    this.events.emit('tool-changed', undefined);
  }

  setSpace(space: TransformSpace): void {
    if (this.space === space) return;
    this.space = space;
    this.events.emit('tool-changed', undefined);
  }

  setMultiSelect(on: boolean): void {
    if (this.multiSelect === on) return;
    this.multiSelect = on;
    this.events.emit('tool-changed', undefined);
  }

  setMode(mode: EditorMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.events.emit('mode-changed', mode);
  }

  updateSettings(patch: Partial<EditorSettings>): void {
    let changed: keyof EditorSettings | null = null;
    for (const key of Object.keys(patch) as (keyof EditorSettings)[]) {
      if (this.settings[key] !== patch[key]) {
        (this.settings as unknown as Record<string, unknown>)[key] = patch[key];
        changed = key;
      }
    }
    if (changed) this.events.emit('settings-changed', changed);
  }

  get activeEntity(): EntityData | undefined {
    return this.scene.get(this.selection.active);
  }

  selectedEntities(): EntityData[] {
    return this.selection.ids.map((id) => this.scene.get(id)).filter((e): e is EntityData => !!e);
  }

  /** ビューポート上のタップなどによる選択 */
  select(id: string | null, additive = false): void {
    if (id === null) {
      if (!additive) this.selection.clear();
      return;
    }
    if (additive || this.multiSelect) this.selection.toggle(id);
    else this.selection.set([id]);
  }

  requestFocus(ids: string[] = [...this.selection.ids]): void {
    this.events.emit('focus-request', ids);
  }
}
