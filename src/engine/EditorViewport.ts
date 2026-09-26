import { Box3, Box3Helper, Color, Mesh, Raycaster, Scene, Vector2, Vector3 } from 'three';
import type { LineBasicMaterial, Object3D } from 'three';
import type { Editor } from '../core/Editor';
import type { Vec3 } from '../core/types';
import { snapTo } from '../core/util';
import { EditorCamera } from './EditorCamera';
import type { EngineRenderer } from './EngineRenderer';
import { GizmoController } from './GizmoController';
import { Grid } from './Grid';
import { SceneBridge } from './SceneBridge';
import { findEntityObject, SceneBuilder } from './SceneBuilder';
import type { EntityObject } from './SceneBuilder';
import type { ViewportInputHandlers } from './ViewportInput';
import { ViewportInput } from './ViewportInput';

const ACTIVE_COLOR = new Color('#ffb020');
const SELECTED_COLOR = new Color('#ffd78a');

/**
 * エディタの 3D ビュー。
 * 必要なときだけ描画する「オンデマンド描画」で、スマホのバッテリー消費と発熱を抑える。
 */
export class EditorViewport {
  readonly scene = new Scene();
  readonly camera: EditorCamera;
  readonly bridge: SceneBridge;
  readonly gizmo: GizmoController;
  readonly input: ViewportInput;
  readonly grid = new Grid();
  private builder: SceneBuilder;
  private selectionBoxes: Box3Helper[] = [];
  private selectionDirty = true;
  private needsRender = true;
  private running = true;
  private raf = 0;
  private raycaster = new Raycaster();
  private listeners = new Set<() => void>();
  private unsubs: (() => void)[] = [];

  constructor(
    private editor: Editor,
    readonly engine: EngineRenderer,
    private element: HTMLElement,
    handlers: ViewportInputHandlers,
  ) {
    this.builder = new SceneBuilder({ editor: true, shadowMapSize: 1024 });
    this.camera = new EditorCamera(engine.width / engine.height);
    this.camera.onChange = () => this.requestRender();

    this.scene.add(this.grid);
    this.bridge = new SceneBridge(editor, this.builder);
    this.bridge.onChange = () => {
      this.selectionDirty = true;
      this.requestRender();
    };
    this.scene.add(this.bridge.root);

    this.gizmo = new GizmoController(editor, this.bridge, this.camera.camera, this.scene);
    this.gizmo.onChange = () => this.requestRender();

    this.input = new ViewportInput(
      element,
      editor,
      this.camera,
      this.gizmo,
      this.bridge,
      (x, y) => this.pick(x, y),
      handlers,
    );

    this.unsubs.push(
      engine.onResize((w, h) => {
        this.camera.setAspect(w / h);
        this.requestRender();
      }),
    );
    const ev = editor.events;
    this.unsubs.push(
      ev.on('selection-changed', () => {
        this.selectionDirty = true;
        this.requestRender();
      }),
      ev.on('scene-loaded', () => this.onSceneLoaded()),
      ev.on('environment-changed', () => this.applyEnvironment()),
      ev.on('settings-changed', () => this.applySettings()),
      ev.on('focus-request', (ids) => this.focus(ids)),
    );
    this.camera.setAspect(engine.width / engine.height);
    this.onSceneLoaded();
    this.applySettings();
    this.raf = requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------------
  // 描画ループ
  // ------------------------------------------------------------------

  requestRender(): void {
    this.needsRender = true;
  }

  /** 描画後に呼ばれるリスナー (軸ギズモ表示の更新など) */
  onRender(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.running) return;
    if (this.camera.tick(now)) this.needsRender = true;
    if (!this.needsRender) return;
    this.renderNow();
  };

  renderNow(): void {
    this.needsRender = false;
    if (this.selectionDirty) this.updateSelectionBoxes();
    // グリッドのフェード距離をズームに合わせる
    this.grid.setFadeDistance(Math.max(30, this.camera.distance * 4));
    this.engine.render(this.scene, this.camera.camera);
    for (const fn of this.listeners) fn();
  }

  /** Play Mode 中は描画と入力を止める */
  suspend(): void {
    this.running = false;
    this.input.reset();
    this.input.enabled = false;
  }

  resume(): void {
    this.running = true;
    this.input.enabled = true;
    this.camera.setAspect(this.engine.width / this.engine.height);
    this.requestRender();
  }

  // ------------------------------------------------------------------
  // シーン設定
  // ------------------------------------------------------------------

  private onSceneLoaded(): void {
    const cam = this.editor.sceneData.editorCamera;
    if (cam) this.camera.setState(cam);
    this.applyEnvironment();
    this.selectionDirty = true;
    this.requestRender();
  }

  private applyEnvironment(): void {
    this.scene.background = new Color(this.editor.sceneData.environment.background);
    this.requestRender();
  }

  private applySettings(): void {
    const s = this.editor.settings;
    this.grid.visible = s.showGrid;
    this.engine.setShadows(s.shadows);
    this.engine.setQuality(s.quality);
    this.gizmo.refresh();
    this.requestRender();
  }

  /** 現在のカメラ位置をシーンデータに記録する (保存前に呼ぶ) */
  storeCameraState(): void {
    this.editor.sceneData.editorCamera = this.camera.getState();
  }

  // ------------------------------------------------------------------
  // 選択表示
  // ------------------------------------------------------------------

  private updateSelectionBoxes(): void {
    this.selectionDirty = false;
    const ids = this.editor.selection.ids;
    while (this.selectionBoxes.length > ids.length) {
      const h = this.selectionBoxes.pop()!;
      h.removeFromParent();
      h.geometry.dispose();
      (h.material as LineBasicMaterial).dispose();
    }
    const active = this.editor.selection.active;
    ids.forEach((id, i) => {
      let helper = this.selectionBoxes[i];
      if (!helper) {
        helper = new Box3Helper(new Box3(), ACTIVE_COLOR);
        const mat = helper.material as LineBasicMaterial;
        mat.depthTest = false;
        mat.transparent = true;
        mat.opacity = 0.95;
        helper.renderOrder = 999;
        helper.userData.noPick = true;
        this.selectionBoxes.push(helper);
        this.scene.add(helper);
      }
      const obj = this.bridge.get(id);
      const box = helper.box;
      box.makeEmpty();
      if (obj) this.computeBounds(obj, box);
      helper.visible = !box.isEmpty();
      if (!box.isEmpty()) box.expandByScalar(0.02);
      (helper.material as LineBasicMaterial).color.copy(id === active ? ACTIVE_COLOR : SELECTED_COLOR);
    });
  }

  /** 表示用メッシュと選択用の当たり判定からバウンディングボックスを計算 */
  computeBounds(root: Object3D, box: Box3): Box3 {
    root.updateWorldMatrix(true, true);
    const tmp = new Box3();
    root.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const eo = findEntityObject(o);
      if (!eo) return;
      const isContent = o === eo.userData.content;
      const isPicker = o === eo.userData.picker;
      if (!isContent && !isPicker) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      tmp.copy(o.geometry.boundingBox!).applyMatrix4(o.matrixWorld);
      box.union(tmp);
    });
    return box;
  }

  // ------------------------------------------------------------------
  // ピック・座標変換
  // ------------------------------------------------------------------

  private setRay(clientX: number, clientY: number): Raycaster {
    const r = this.element.getBoundingClientRect();
    const ndc = new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera.camera);
    return this.raycaster;
  }

  /** 画面座標にあるエンティティの ID */
  pick(clientX: number, clientY: number): string | null {
    const ray = this.setRay(clientX, clientY);
    const hits = ray.intersectObjects(this.bridge.pickables(), false);
    for (const h of hits) {
      const eo = findEntityObject(h.object);
      if (eo) return eo.userData.entityId;
    }
    return null;
  }

  /** 画面座標の先にある地面 (y=0) の点。オブジェクトに当たればその表面 */
  groundPointAt(clientX: number, clientY: number): Vector3 | null {
    const ray = this.setRay(clientX, clientY).ray;
    if (ray.direction.y >= -0.01) return null;
    const t = -ray.origin.y / ray.direction.y;
    if (t <= 0 || t > 500) return null;
    return ray.origin.clone().addScaledVector(ray.direction, t);
  }

  /** 新しいオブジェクトを置く位置 (画面中央の地面。スナップ有効時はグリッドに合わせる) */
  placementPoint(at?: { x: number; y: number }): Vec3 {
    const p = (at ? this.groundPointAt(at.x, at.y) : null) ?? this.camera.groundPointAtCenter();
    const step = this.editor.settings.snapEnabled ? this.editor.settings.snapMove : 0.5;
    const base: Vec3 = [snapTo(p.x, step), 0, snapTo(p.z, step)];
    // 場所を指定された場合はそのまま。画面中央に置く場合は既存の物と重ならない場所を探す
    return at ? base : this.findFreeSpot(base, Math.max(1, step));
  }

  /** 既存オブジェクトと重ならない地面上の位置を、近い順 (渦巻き状) に探す */
  private findFreeSpot(start: Vec3, spacing: number): Vec3 {
    const occupied: Vector3[] = [];
    const tmp = new Vector3();
    for (const e of this.editor.scene.ordered()) {
      if (e.locked || e.kind === 'light') continue;
      const obj = this.bridge.get(e.id);
      if (!obj) continue;
      obj.updateWorldMatrix(true, false);
      occupied.push(tmp.setFromMatrixPosition(obj.matrixWorld).clone());
    }
    const isFree = (x: number, z: number) => occupied.every((o) => Math.hypot(o.x - x, o.z - z) > spacing * 0.9);
    if (isFree(start[0], start[2])) return start;
    const dirs = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ];
    for (let r = 1; r <= 8; r++) {
      for (const [dx, dz] of dirs) {
        const x = start[0] + dx * r * spacing;
        const z = start[2] + dz * r * spacing;
        if (isFree(x, z)) return [x, 0, z];
      }
    }
    return start;
  }

  /** エンティティの画面上の位置 (ビューポート外なら null) */
  screenPosition(id: string): { x: number; y: number } | null {
    const obj = this.bridge.get(id);
    if (!obj) return null;
    const box = this.computeBounds(obj, new Box3());
    const center = box.isEmpty() ? new Vector3().setFromMatrixPosition(obj.matrixWorld) : box.getCenter(new Vector3());
    center.project(this.camera.camera);
    if (center.z > 1 || Math.abs(center.x) > 1 || Math.abs(center.y) > 1) return null;
    const r = this.element.getBoundingClientRect();
    return { x: r.left + ((center.x + 1) / 2) * r.width, y: r.top + ((1 - center.y) / 2) * r.height };
  }

  getObject(id: string): EntityObject | undefined {
    return this.bridge.get(id);
  }

  // ------------------------------------------------------------------
  // フォーカス
  // ------------------------------------------------------------------

  focus(ids: readonly string[]): void {
    const box = new Box3();
    const targets = ids.length > 0 ? ids : this.editor.scene.data.roots;
    for (const id of targets) {
      const obj = this.bridge.get(id);
      if (!obj) continue;
      // 地面などの巨大なロック済み物体は「全体表示」で除外する
      if (ids.length === 0 && this.editor.scene.get(id)?.locked) continue;
      this.computeBounds(obj, box);
    }
    if (box.isEmpty()) {
      for (const id of targets) {
        const obj = this.bridge.get(id);
        if (obj) box.expandByPoint(new Vector3().setFromMatrixPosition(obj.matrixWorld));
      }
    }
    if (!box.isEmpty()) this.camera.focusBox(box);
  }

  captureThumbnail(): string | null {
    const hidden: Object3D[] = [];
    // サムネイルにはギズモや選択枠を写さない
    for (const o of [this.gizmo.controls.getHelper(), ...this.selectionBoxes, this.grid]) {
      if (o.visible) {
        o.visible = false;
        hidden.push(o);
      }
    }
    const url = this.engine.captureThumbnail(() => this.engine.render(this.scene, this.camera.camera));
    for (const o of hidden) o.visible = true;
    this.requestRender();
    return url;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.unsubs.forEach((u) => u());
    this.input.dispose();
    this.gizmo.dispose();
    this.bridge.dispose();
    this.grid.dispose();
  }
}
