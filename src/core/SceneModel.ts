import { Matrix4 } from 'three';
import type { EntityData, SceneData, TransformData } from './types';
import { transformToMatrix } from './transformMath';
import { clone } from './util';

export interface EntityChange {
  id: string;
  /** true の場合は位置・回転・拡大のみの変更 (表示側は軽量更新でよい) */
  transformOnly: boolean;
}

/** SceneModel が必要とするイベント発行口 (Emitter の emit だけを要求する) */
export interface SceneEventSink {
  emit<K extends keyof SceneEvents>(type: K, payload: SceneEvents[K]): void;
}

export interface SceneEvents {
  /** シーン全体が差し替わった (全再構築が必要) */
  'scene-loaded': SceneData;
  'entity-added': string;
  'entity-removed': string;
  'entity-changed': EntityChange;
  /** 親子関係・並び順が変わった */
  'hierarchy-changed': void;
}

/** 親子関係以外のエンティティ属性 */
export type EntityProps = Omit<EntityData, 'id' | 'parent' | 'children'>;

export interface RemovedSubtree {
  /** entities[0] が削除したサブツリーのルート */
  entities: EntityData[];
  parent: string | null;
  index: number;
}

export interface SceneSnapshot {
  roots: string[];
  entities: Record<string, EntityData>;
}

export function extractProps(e: EntityData): EntityProps {
  const { id: _id, parent: _p, children: _c, ...rest } = e;
  return clone(rest);
}

/**
 * アクティブなシーンのデータを包むクラス。
 * 読み取り用の問い合わせと、コマンドから呼ばれる低レベルな変更操作を提供する。
 * 変更操作は必ずイベントを発行し、表示 (Three.js / UI) はそれを購読して更新する。
 */
export class SceneModel {
  constructor(
    public data: SceneData,
    private events: SceneEventSink,
  ) {}

  // ------------------------------------------------------------------
  // 問い合わせ
  // ------------------------------------------------------------------

  get(id: string | null | undefined): EntityData | undefined {
    if (!id) return undefined;
    return this.data.entities[id];
  }

  require(id: string): EntityData {
    const e = this.data.entities[id];
    if (!e) throw new Error(`エンティティが見つかりません: ${id}`);
    return e;
  }

  has(id: string): boolean {
    return id in this.data.entities;
  }

  get count(): number {
    return Object.keys(this.data.entities).length;
  }

  childIds(parent: string | null): string[] {
    if (parent === null) return this.data.roots;
    return this.data.entities[parent]?.children ?? [];
  }

  indexInParent(id: string): number {
    const e = this.require(id);
    return this.childIds(e.parent).indexOf(id);
  }

  /** 階層順 (深さ優先) のエンティティ一覧 */
  ordered(): EntityData[] {
    const out: EntityData[] = [];
    const visit = (ids: string[]) => {
      for (const id of ids) {
        const e = this.data.entities[id];
        if (!e) continue;
        out.push(e);
        visit(e.children);
      }
    };
    visit(this.data.roots);
    return out;
  }

  /** id をルートとするサブツリー (ルートが先頭の深さ優先順) */
  subtree(id: string): EntityData[] {
    const out: EntityData[] = [];
    const visit = (eid: string) => {
      const e = this.data.entities[eid];
      if (!e) return;
      out.push(e);
      e.children.forEach(visit);
    };
    visit(id);
    return out;
  }

  ancestors(id: string): string[] {
    const out: string[] = [];
    let cur = this.get(id)?.parent ?? null;
    while (cur) {
      out.push(cur);
      cur = this.get(cur)?.parent ?? null;
    }
    return out;
  }

  /** ancestor が id の祖先 (または同一) かどうか */
  isAncestorOrSelf(ancestor: string, id: string): boolean {
    return ancestor === id || this.ancestors(id).includes(ancestor);
  }

  depth(id: string): number {
    return this.ancestors(id).length;
  }

  /**
   * 指定 ID のうち、祖先が同じ集合に含まれないものだけを階層順で返す。
   * (複数選択で親子を同時に選んだ場合に二重に移動・削除しないため)
   */
  topLevel(ids: Iterable<string>): string[] {
    const set = new Set([...ids].filter((id) => this.has(id)));
    const result = [...set].filter((id) => !this.ancestors(id).some((a) => set.has(a)));
    const order = new Map(this.ordered().map((e, i) => [e.id, i]));
    return result.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }

  names(): string[] {
    return Object.values(this.data.entities).map((e) => e.name);
  }

  localMatrix(id: string, out = new Matrix4()): Matrix4 {
    return transformToMatrix(this.require(id).transform, out);
  }

  /** データ上の親子関係からワールド行列を計算する (Three.js オブジェクト不要) */
  worldMatrix(id: string | null, out = new Matrix4()): Matrix4 {
    out.identity();
    if (!id) return out;
    const chain = [id, ...this.ancestors(id)].reverse();
    const tmp = new Matrix4();
    for (const eid of chain) {
      transformToMatrix(this.require(eid).transform, tmp);
      out.multiply(tmp);
    }
    return out;
  }

  snapshot(): SceneSnapshot {
    return clone({ roots: this.data.roots, entities: this.data.entities });
  }

  // ------------------------------------------------------------------
  // 低レベル変更操作 (Command から呼ぶ)
  // ------------------------------------------------------------------

  /**
   * サブツリーを挿入する。entities[0] がルートで、残りは子孫 (parent/children 設定済み)。
   */
  insert(entities: EntityData[], parent: string | null, index = -1): void {
    if (entities.length === 0) return;
    const root = entities[0];
    if (parent !== null && !this.has(parent)) throw new Error(`親が見つかりません: ${parent}`);
    for (const e of entities) {
      if (this.has(e.id)) throw new Error(`ID が重複しています: ${e.id}`);
    }
    root.parent = parent;
    for (const e of entities) this.data.entities[e.id] = e;
    const list = this.childIds(parent);
    const i = index < 0 || index > list.length ? list.length : index;
    list.splice(i, 0, root.id);
    for (const e of entities) this.events.emit('entity-added', e.id);
    this.events.emit('hierarchy-changed', undefined);
  }

  remove(id: string): RemovedSubtree {
    const root = this.require(id);
    const parent = root.parent;
    const list = this.childIds(parent);
    const index = list.indexOf(id);
    if (index >= 0) list.splice(index, 1);
    const entities = this.subtree(id);
    for (const e of entities) delete this.data.entities[e.id];
    // 子から順に通知する
    for (let i = entities.length - 1; i >= 0; i--) this.events.emit('entity-removed', entities[i].id);
    this.events.emit('hierarchy-changed', undefined);
    return { entities, parent, index };
  }

  applyProps(id: string, props: EntityProps, transformOnly = false): void {
    const e = this.require(id);
    Object.assign(e, clone(props));
    this.events.emit('entity-changed', { id, transformOnly });
  }

  setTransform(id: string, t: TransformData): void {
    const e = this.require(id);
    e.transform = clone(t);
    this.events.emit('entity-changed', { id, transformOnly: true });
  }

  /** 親と並び順を変更する (ワールド座標の補正は呼び出し側で行う) */
  move(id: string, newParent: string | null, index = -1): void {
    const e = this.require(id);
    if (newParent !== null) {
      if (!this.has(newParent)) throw new Error(`親が見つかりません: ${newParent}`);
      if (this.isAncestorOrSelf(id, newParent)) throw new Error('自分自身や子孫を親にはできません');
    }
    const oldList = this.childIds(e.parent);
    const oldIndex = oldList.indexOf(id);
    if (oldIndex >= 0) oldList.splice(oldIndex, 1);
    e.parent = newParent;
    const list = this.childIds(newParent);
    const i = index < 0 || index > list.length ? list.length : index;
    list.splice(i, 0, id);
    this.events.emit('hierarchy-changed', undefined);
  }

  replaceAll(snapshot: SceneSnapshot): void {
    const s = clone(snapshot);
    this.data.roots = s.roots;
    this.data.entities = s.entities;
    this.events.emit('scene-loaded', this.data);
  }
}
