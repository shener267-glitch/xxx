import type { Command } from './History';
import type { EntityProps, RemovedSubtree, SceneModel, SceneSnapshot } from './SceneModel';
import { extractProps } from './SceneModel';
import type { EntityData, TransformData } from './types';
import { clone, deepEqual } from './util';

/** エンティティ (サブツリー) の追加 */
export class AddEntitiesCommand implements Command {
  private readonly items: { entities: EntityData[]; parent: string | null; index: number }[];

  constructor(
    private model: SceneModel,
    items: { entities: EntityData[]; parent: string | null; index?: number }[],
    readonly label = 'オブジェクトを追加',
  ) {
    // 実行時にデータが書き換わっても Redo できるよう複製して保持する
    this.items = items.map((it) => ({ entities: clone(it.entities), parent: it.parent, index: it.index ?? -1 }));
  }

  get rootIds(): string[] {
    return this.items.map((it) => it.entities[0].id);
  }

  execute(): void {
    for (const it of this.items) this.model.insert(clone(it.entities), it.parent, it.index);
  }

  undo(): void {
    for (let i = this.items.length - 1; i >= 0; i--) this.model.remove(this.items[i].entities[0].id);
  }
}

/** エンティティ (サブツリー) の削除 */
export class RemoveEntitiesCommand implements Command {
  private removed: RemovedSubtree[] = [];

  constructor(
    private model: SceneModel,
    private ids: string[],
    readonly label = 'オブジェクトを削除',
  ) {}

  execute(): void {
    this.removed = [];
    for (const id of this.model.topLevel(this.ids)) {
      const r = this.model.remove(id);
      this.removed.push({ ...r, entities: clone(r.entities) });
    }
  }

  undo(): void {
    // 削除と逆順に戻すことで元のインデックスを復元する
    for (let i = this.removed.length - 1; i >= 0; i--) {
      const r = this.removed[i];
      this.model.insert(clone(r.entities), r.parent, r.index);
    }
  }
}

/**
 * 属性変更 (名前・色・位置など)。親子関係は変更しない。
 * mergeKey が同じ連続変更は1つの Undo 単位に統合される。
 */
export class UpdateEntitiesCommand implements Command {
  constructor(
    private model: SceneModel,
    private before: Map<string, EntityProps>,
    private after: Map<string, EntityProps>,
    readonly label = 'プロパティを変更',
    readonly mergeKey: string | null = null,
    private transformOnly = false,
  ) {}

  /** 変更関数から before/after を作るヘルパー */
  static fromMutation(
    model: SceneModel,
    ids: string[],
    mutate: (e: EntityData) => void,
    label?: string,
    mergeKey: string | null = null,
    transformOnly = false,
  ): UpdateEntitiesCommand {
    const before = new Map<string, EntityProps>();
    const after = new Map<string, EntityProps>();
    for (const id of ids) {
      const e = model.get(id);
      if (!e) continue;
      before.set(id, extractProps(e));
      const draft = clone(e);
      mutate(draft);
      after.set(id, extractProps(draft));
    }
    return new UpdateEntitiesCommand(model, before, after, label, mergeKey, transformOnly);
  }

  execute(): void {
    for (const [id, props] of this.after) if (this.model.has(id)) this.model.applyProps(id, props, this.transformOnly);
  }

  undo(): void {
    for (const [id, props] of this.before) if (this.model.has(id)) this.model.applyProps(id, props, this.transformOnly);
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof UpdateEntitiesCommand)) return false;
    if (!this.mergeKey || next.mergeKey !== this.mergeKey) return false;
    if (next.after.size !== this.after.size) return false;
    for (const id of next.after.keys()) if (!this.after.has(id)) return false;
    this.after = next.after;
    return true;
  }

  isNoop(): boolean {
    for (const [id, props] of this.after) {
      if (!deepEqual(props, this.before.get(id))) return false;
    }
    return true;
  }
}

/** 位置・回転・拡大のみの変更 (ギズモ操作・ドラッグ移動用) */
export class SetTransformsCommand implements Command {
  constructor(
    private model: SceneModel,
    private before: Map<string, TransformData>,
    private after: Map<string, TransformData>,
    readonly label = 'トランスフォームを変更',
  ) {}

  execute(): void {
    for (const [id, t] of this.after) if (this.model.has(id)) this.model.setTransform(id, t);
  }

  undo(): void {
    for (const [id, t] of this.before) if (this.model.has(id)) this.model.setTransform(id, t);
  }

  isNoop(): boolean {
    for (const [id, t] of this.after) if (!deepEqual(t, this.before.get(id))) return false;
    return true;
  }
}

/**
 * シーン全体のスナップショットを使うコマンド。
 * 親子付け・グループ化など構造が大きく変わる操作に使う (確実に元に戻せる)。
 */
export class SnapshotCommand implements Command {
  private before: SceneSnapshot | null = null;
  private after: SceneSnapshot | null = null;

  constructor(
    private model: SceneModel,
    private mutate: (model: SceneModel) => void,
    readonly label: string,
  ) {}

  execute(): void {
    if (this.after) {
      this.model.replaceAll(this.after);
      return;
    }
    this.before = this.model.snapshot();
    try {
      this.mutate(this.model);
    } catch (err) {
      // 途中で失敗した場合は元に戻してから例外を伝える
      this.model.replaceAll(this.before);
      throw err;
    }
    this.after = this.model.snapshot();
  }

  undo(): void {
    if (this.before) this.model.replaceAll(this.before);
  }

  isNoop(): boolean {
    return this.before !== null && this.after !== null && deepEqual(this.before, this.after);
  }
}

/** 任意の処理を Undo 可能にする汎用コマンド (シーン設定の変更など) */
export class LambdaCommand implements Command {
  constructor(
    readonly label: string,
    private doFn: () => void,
    private undoFn: () => void,
  ) {}

  execute(): void {
    this.doFn();
  }

  undo(): void {
    this.undoFn();
  }
}
