import { MathUtils, Matrix4, Object3D, Vector3 } from 'three';
import type { Camera, Scene } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { commitTransforms } from '../core/actions';
import type { Editor } from '../core/Editor';
import { matrixToTransform, vec3Round } from '../core/transformMath';
import type { TransformData } from '../core/types';
import { clone } from '../core/util';
import type { SceneBridge } from './SceneBridge';

export interface NdcPointer {
  x: number;
  y: number;
}

interface DragState {
  ids: string[];
  before: Map<string, TransformData>;
  /** 複数選択時: 各オブジェクトの開始時ワールド行列 */
  startWorld: Map<string, Matrix4>;
  pivotStartInv: Matrix4;
  multi: boolean;
}

const MODE_LABEL = { translate: '移動', rotate: '回転', scale: '拡大縮小' } as const;

/**
 * 移動・回転・拡大縮小のギズモ。
 * Three.js の TransformControls を DOM に接続せずに使い、
 * ポインター入力は ViewportInput から明示的に渡す (マルチタッチとの競合を避けるため)。
 * 複数選択時は中心に置いた「ピボット」を操作し、その変化量を全員に適用する。
 */
export class GizmoController {
  readonly controls: TransformControls;
  private pivot = new Object3D();
  private drag: DragState | null = null;
  private attachedIds: string[] = [];

  onChange: () => void = () => {};

  constructor(
    private editor: Editor,
    private bridge: SceneBridge,
    camera: Camera,
    scene: Scene,
  ) {
    this.controls = new TransformControls(camera);
    this.pivot.name = '__gizmo_pivot';
    scene.add(this.pivot);
    const helper = this.controls.getHelper();
    helper.name = '__gizmo';
    scene.add(helper);

    this.controls.addEventListener('change', () => this.onChange());
    this.controls.addEventListener('objectChange', () => this.onObjectChange());

    const ev = editor.events;
    const refresh = () => this.refresh();
    ev.on('selection-changed', refresh);
    ev.on('tool-changed', refresh);
    ev.on('scene-loaded', refresh);
    ev.on('hierarchy-changed', refresh);
    ev.on('settings-changed', refresh);
    ev.on('mode-changed', refresh);
    ev.on('entity-changed', () => {
      // Inspector などで数値が変わったらピボット位置を追従させる
      if (!this.drag) this.refresh();
    });
    this.refresh();
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  get attached(): boolean {
    return this.controls.object !== undefined;
  }

  /** 操作可能な選択 (ロックされていない最上位のもの) */
  private editableSelection(): string[] {
    const model = this.editor.scene;
    return model.topLevel(this.editor.selection.ids).filter((id) => {
      const e = model.get(id);
      return e && !e.locked && e.kind !== 'ui' && this.bridge.get(id);
    });
  }

  /** 地形ブラシなどの間はギズモを隠す */
  private suspended = false;
  /** 画面の一部がパネルで覆われているときの大きさの補正 */
  private sizeScale = 1;

  setSizeScale(k: number): void {
    if (Math.abs(k - this.sizeScale) < 1e-4) return;
    this.sizeScale = k;
    this.controls.size = this.editor.settings.gizmoSize * k;
  }

  setEnabled(on: boolean): void {
    if (this.suspended === !on) return;
    this.suspended = !on;
    this.refresh();
  }

  refresh(): void {
    if (this.drag) return;
    const s = this.editor.settings;
    const tool = this.editor.tool;
    const ids = this.editor.mode === 'edit' && tool !== 'select' && !this.suspended ? this.editableSelection() : [];
    this.attachedIds = ids;
    const c = this.controls;
    c.size = s.gizmoSize * this.sizeScale;
    c.setTranslationSnap(s.snapEnabled ? s.snapMove : null);
    c.setRotationSnap(s.snapEnabled ? MathUtils.degToRad(s.snapRotate) : null);
    c.setScaleSnap(s.snapEnabled ? s.snapScale : null);

    if (ids.length === 0) {
      if (c.object) c.detach();
      this.onChange();
      return;
    }
    c.setMode(tool as 'translate' | 'rotate' | 'scale');
    if (ids.length === 1) {
      c.setSpace(this.editor.space);
      const obj = this.bridge.get(ids[0])!;
      if (c.object !== obj) c.attach(obj);
    } else {
      // 複数選択: 選択物の中心にピボットを置く
      const center = new Vector3();
      const tmp = new Vector3();
      for (const id of ids) {
        const obj = this.bridge.get(id)!;
        obj.updateWorldMatrix(true, false);
        center.add(tmp.setFromMatrixPosition(obj.matrixWorld));
      }
      center.divideScalar(ids.length);
      this.pivot.position.copy(center);
      this.pivot.quaternion.identity();
      this.pivot.scale.set(1, 1, 1);
      this.pivot.updateMatrixWorld(true);
      c.setSpace('world');
      if (c.object !== this.pivot) c.attach(this.pivot);
    }
    this.onChange();
  }

  hover(p: NdcPointer | null): void {
    if (!this.attached || this.drag) return;
    const before = this.controls.axis;
    if (p) this.controls.pointerHover({ x: p.x, y: p.y, button: -1 } as never);
    else this.controls.axis = null;
    if (before !== this.controls.axis) this.onChange();
  }

  /** 指定位置にあるハンドルの軸名 (無ければ null)。ドラッグは開始しない */
  peekAxis(p: NdcPointer): string | null {
    if (!this.attached || this.editor.mode !== 'edit') return null;
    this.controls.pointerHover({ x: p.x, y: p.y, button: -1 } as never);
    return this.controls.axis;
  }

  /** ハンドルを掴んだら true を返してドラッグを開始する */
  tryStart(p: NdcPointer): boolean {
    if (!this.attached || this.editor.mode !== 'edit') return false;
    const c = this.controls;
    c.pointerHover({ x: p.x, y: p.y, button: -1 } as never);
    if (c.axis === null) return false;
    c.pointerDown({ x: p.x, y: p.y, button: 0 } as never);
    if (!c.dragging) return false;

    const model = this.editor.scene;
    const ids = [...this.attachedIds];
    const before = new Map<string, TransformData>();
    const startWorld = new Map<string, Matrix4>();
    for (const id of ids) {
      before.set(id, clone(model.require(id).transform));
      const obj = this.bridge.get(id)!;
      obj.updateWorldMatrix(true, false);
      startWorld.set(id, obj.matrixWorld.clone());
    }
    this.pivot.updateMatrixWorld(true);
    this.drag = {
      ids,
      before,
      startWorld,
      pivotStartInv: this.pivot.matrixWorld.clone().invert(),
      multi: ids.length > 1,
    };
    this.onChange();
    return true;
  }

  move(p: NdcPointer): void {
    if (!this.drag) return;
    this.controls.pointerMove({ x: p.x, y: p.y, button: -1 } as never);
  }

  end(p: NdcPointer | null): void {
    if (!this.drag) return;
    this.controls.pointerUp(p ? ({ x: p.x, y: p.y, button: 0 } as never) : null);
    const drag = this.drag;
    this.drag = null;
    const mode = this.controls.mode as keyof typeof MODE_LABEL;
    commitTransforms(this.editor, drag.before, MODE_LABEL[mode] ?? '変形');
    this.refresh();
  }

  /** 2本目の指が触れた場合などにドラッグを取り消して元に戻す */
  cancel(): void {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    this.controls.pointerUp(null);
    for (const [id, t] of drag.before) {
      if (this.editor.scene.has(id)) this.editor.scene.setTransform(id, t);
    }
    this.refresh();
  }

  private onObjectChange(): void {
    const drag = this.drag;
    if (!drag) return;
    const model = this.editor.scene;
    if (!drag.multi) {
      const id = drag.ids[0];
      const obj = this.bridge.get(id);
      if (!obj) return;
      const t: TransformData = {
        position: vec3Round([obj.position.x, obj.position.y, obj.position.z]),
        rotation: vec3Round([
          MathUtils.radToDeg(obj.rotation.x),
          MathUtils.radToDeg(obj.rotation.y),
          MathUtils.radToDeg(obj.rotation.z),
        ]),
        scale: vec3Round([obj.scale.x, obj.scale.y, obj.scale.z]),
      };
      model.setTransform(id, t);
      return;
    }
    // ピボットの変化量 delta = 現在 * 開始時^-1 を各オブジェクトに適用
    this.pivot.updateMatrixWorld(true);
    const delta = new Matrix4().multiplyMatrices(this.pivot.matrixWorld, drag.pivotStartInv);
    const world = new Matrix4();
    const parentInv = new Matrix4();
    for (const id of drag.ids) {
      const obj = this.bridge.get(id);
      const start = drag.startWorld.get(id);
      if (!obj || !start) continue;
      world.multiplyMatrices(delta, start);
      if (obj.parent) {
        obj.parent.updateWorldMatrix(true, false);
        parentInv.copy(obj.parent.matrixWorld).invert();
      } else {
        parentInv.identity();
      }
      model.setTransform(id, matrixToTransform(parentInv.multiply(world)));
    }
  }

  dispose(): void {
    this.controls.detach();
    const helper = this.controls.getHelper();
    helper.removeFromParent();
    // TransformControls.dispose() は DOM 未接続だと失敗するため、表示部分だけ解放する
    helper.dispose();
    this.pivot.removeFromParent();
  }
}
