import { Group } from 'three';
import type { Object3D } from 'three';
import type { Editor } from '../core/Editor';
import type { EntityChange } from '../core/SceneModel';
import type { EntityObject, SceneBuilder } from './SceneBuilder';

/**
 * エディタのシーンデータ (SceneModel) と Three.js のオブジェクトを同期させる。
 * モデルのイベント (追加・削除・変更・階層変更) を購読し、差分だけを反映する。
 */
export class SceneBridge {
  readonly root = new Group();
  readonly objects = new Map<string, EntityObject>();
  private pickCache: Object3D[] | null = null;
  private unsubs: (() => void)[] = [];

  /** 何かが変わった (再描画が必要) ときに呼ばれる */
  onChange: () => void = () => {};

  constructor(
    private editor: Editor,
    private builder: SceneBuilder,
  ) {
    this.root.name = '__world';
    const ev = editor.events;
    this.unsubs.push(
      ev.on('scene-loaded', () => this.rebuild()),
      ev.on('entity-added', (id) => this.add(id)),
      ev.on('entity-removed', (id) => this.remove(id)),
      ev.on('entity-changed', (c) => this.update(c)),
      ev.on('hierarchy-changed', () => this.syncHierarchy()),
    );
    this.rebuild();
  }

  get(id: string | null | undefined): EntityObject | undefined {
    return id ? this.objects.get(id) : undefined;
  }

  rebuild(): void {
    for (const obj of this.objects.values()) {
      obj.removeFromParent();
      this.builder.dispose(obj);
    }
    this.objects.clear();
    for (const e of this.editor.scene.ordered()) this.add(e.id);
    this.invalidate();
  }

  private add(id: string): void {
    const e = this.editor.scene.get(id);
    if (!e || this.objects.has(id)) return;
    const obj = this.builder.create(e);
    this.objects.set(id, obj);
    const parent = e.parent ? this.objects.get(e.parent) : undefined;
    (parent ?? this.root).add(obj);
    // 先に子が追加されていた場合 (通常は無い) の付け替え
    for (const cid of e.children) {
      const child = this.objects.get(cid);
      if (child && child.parent !== obj) obj.add(child);
    }
    this.invalidate();
  }

  private remove(id: string): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    obj.removeFromParent();
    this.builder.dispose(obj);
    this.objects.delete(id);
    this.invalidate();
  }

  private update(change: EntityChange): void {
    const obj = this.objects.get(change.id);
    const e = this.editor.scene.get(change.id);
    if (!obj || !e) return;
    if (change.transformOnly) this.builder.applyTransform(obj, e);
    else this.builder.apply(obj, e);
    this.invalidate();
  }

  private syncHierarchy(): void {
    for (const [id, obj] of this.objects) {
      const e = this.editor.scene.get(id);
      if (!e) continue;
      const parent = e.parent ? (this.objects.get(e.parent) ?? this.root) : this.root;
      if (obj.parent !== parent) parent.add(obj);
    }
    this.invalidate();
  }

  private invalidate(): void {
    this.pickCache = null;
    this.onChange();
  }

  /** タップ選択の対象になるメッシュ (表示中かつロックされていないもの) */
  pickables(): Object3D[] {
    if (this.pickCache) return this.pickCache;
    const out: Object3D[] = [];
    const model = this.editor.scene;
    const visit = (ids: string[], parentVisible: boolean) => {
      for (const id of ids) {
        const e = model.get(id);
        const obj = this.objects.get(id);
        if (!e || !obj) continue;
        const visible = parentVisible && e.visible;
        if (visible && !e.locked) out.push(...obj.userData.pickTargets);
        visit(e.children, visible);
      }
    };
    visit(model.data.roots, true);
    this.pickCache = out;
    return out;
  }

  dispose(): void {
    this.unsubs.forEach((u) => u());
    for (const obj of this.objects.values()) this.builder.dispose(obj);
    this.objects.clear();
    this.root.clear();
  }
}
