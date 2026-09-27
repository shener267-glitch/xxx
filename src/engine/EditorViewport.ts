import {
  Box3,
  Box3Helper,
  BoxGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Quaternion,
  Ray,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';
import type { BufferGeometry, Camera } from 'three';
import type { LineBasicMaterial, Object3D } from 'three';
import type { Editor } from '../core/Editor';
import type { Vec3 } from '../core/types';
import { debounce, snapTo } from '../core/util';
import { sharedUniforms } from './materials';
import { computeColliderShape, hasPhysics, readCollider } from './colliderShapes';
import { findSunDirection, SceneEnvironment } from './SceneEnvironment';
import { onTextureLoaded } from './textures';
import { EditorCamera } from './EditorCamera';
import type { ViewInsets } from './EditorCamera';
import type { EngineRenderer } from './EngineRenderer';
import { GizmoController } from './GizmoController';
import { Grid } from './Grid';
import { SceneBridge } from './SceneBridge';
import { EffectPreview } from './EffectPreview';
import { findEntityObject, SceneBuilder } from './SceneBuilder';
import { raycastTerrainObject } from './terrainMesh';
import { TerrainBrush } from './TerrainBrush';
import type { EntityObject } from './SceneBuilder';
import type { ViewportInputHandlers } from './ViewportInput';
import { ViewportInput } from './ViewportInput';

const ACTIVE_COLOR = new Color('#ffb020');
const colliderMat = new MeshBasicMaterial({ color: 0x3fd584, wireframe: true, transparent: true, opacity: 0.7, depthTest: false });
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
  readonly env: SceneEnvironment;
  readonly effects: EffectPreview;
  /** 地形のブラシ編集 */
  readonly terrainBrush: TerrainBrush;
  private lastFrame = 0;
  /** アニメーション編集のプレビューで一時的に姿勢を変えているオブジェクト */
  private posed = new Set<string>();
  private builder: SceneBuilder;
  private selectionBoxes: Box3Helper[] = [];
  /** 選択中オブジェクトの当たり判定 (緑の枠) */
  private colliderGroup = new Group();
  private selectionDirty = true;
  private needsRender = true;
  private running = true;
  private raf = 0;
  private raycaster = new Raycaster();
  private listeners = new Set<() => void>();
  private brushListeners = new Set<() => void>();
  /** 「このカメラから見る」のカメラ (null = ふだんの編集カメラ) */
  previewCameraId: string | null = null;
  private previewListeners = new Set<() => void>();
  private unsubs: (() => void)[] = [];

  constructor(
    private editor: Editor,
    readonly engine: EngineRenderer,
    private element: HTMLElement,
    handlers: ViewportInputHandlers,
  ) {
    this.builder = new SceneBuilder({ editor: true, quality: editor.settings.quality });
    this.builder.onAsyncLoaded = () => {
      this.selectionDirty = true;
      this.requestRender();
    };
    this.env = new SceneEnvironment(this.scene, engine.renderer, editor.settings.quality);
    this.env.weatherVisible = editor.settings.previewEffects;
    this.env.animate = editor.settings.previewEffects;
    this.camera = new EditorCamera(engine.width / engine.height);
    this.camera.setViewport(engine.width, engine.height);
    this.camera.onChange = () => this.requestRender();

    this.scene.add(this.grid);
    this.colliderGroup.name = '__colliders';
    this.colliderGroup.renderOrder = 998;
    this.scene.add(this.colliderGroup);
    this.bridge = new SceneBridge(editor, this.builder);
    this.bridge.onChange = () => {
      this.selectionDirty = true;
      this.requestRender();
    };
    this.scene.add(this.bridge.root);
    this.env.setLightRoot(this.bridge.root);
    this.effects = new EffectPreview(editor, this.bridge, this.scene);
    const syncEffects = debounce(() => {
      this.effects.sync(editor.settings.quality, engine.height);
      this.requestRender();
    }, 60);

    this.gizmo = new GizmoController(editor, this.bridge, this.camera.camera, this.scene);
    this.gizmo.onChange = () => this.requestRender();

    // 「このカメラから見る」中は、タップやカメラ操作でふだんの視点に戻る
    const wrapped: ViewportInputHandlers = {
      ...handlers,
      onTap: (x, y, additive, touch) => {
        if (this.previewCameraId) this.setPreviewCamera(null);
        else handlers.onTap(x, y, additive, touch);
      },
      onGesture: (active) => {
        if (active && this.previewCameraId) this.setPreviewCamera(null);
        handlers.onGesture?.(active);
      },
    };
    this.input = new ViewportInput(
      element,
      editor,
      this.camera,
      this.gizmo,
      this.bridge,
      (x, y) => this.pick(x, y),
      wrapped,
    );

    this.terrainBrush = new TerrainBrush(editor, this.bridge, this.scene, (x, y) => this.setRay(x, y).ray.clone(), () => this.requestRender());
    const brushChanged = this.terrainBrush.onChange;
    this.terrainBrush.onChange = () => {
      this.input.tool = this.terrainBrush.active ? this.terrainBrush : null;
      // ブラシ中はギズモを出さない (地形をなぞりやすくする)
      this.gizmo.setEnabled(!this.terrainBrush.active);
      brushChanged?.();
      for (const fn of this.brushListeners) fn();
      this.requestRender();
    };

    this.unsubs.push(
      engine.onResize((w, h) => {
        this.camera.setViewport(w, h);
        this.effects?.setViewportHeight(h);
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
      // 一覧などで選んだ物が見えていなければ、見える所へカメラを動かす
      ev.on('selection-changed', () => this.scheduleReveal()),
      // 太陽光の向きが変わったら空と映り込みを更新する (ドラッグ中は間引く)
      ev.on('entity-changed', (c) => {
        if (editor.scene.get(c.id)?.light?.type === 'directional') this.scheduleEnvironment();
      }),
      ev.on('entity-added', () => {
        this.scheduleEnvironment();
        syncEffects();
      }),
      ev.on('entity-removed', () => {
        this.scheduleEnvironment();
        syncEffects();
      }),
      ev.on('entity-changed', () => syncEffects()),
      ev.on('scene-loaded', () => syncEffects()),
      ev.on('selection-changed', () => this.clearPoses()),
      // 別のシーンを開いたら、カメラの視点の表示をやめる
      ev.on('scene-loaded', () => this.setPreviewCamera(null)),
      onTextureLoaded(() => this.requestRender()),
      engine.onPostReady(() => this.requestRender()),
    );
    this.camera.setViewport(engine.width, engine.height);
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

  /** シーンのカメラの視点で表示する (null で戻す) */
  setPreviewCamera(id: string | null): void {
    const e = id ? this.editor.scene.get(id) : undefined;
    this.previewCameraId = e?.kind === 'camera' ? id : null;
    this.requestRender();
    for (const fn of this.previewListeners) fn();
  }

  onPreviewCameraChange(fn: () => void): () => void {
    this.previewListeners.add(fn);
    return () => this.previewListeners.delete(fn);
  }

  /** 表示に使うカメラ (「このカメラから見る」中はシーンのカメラ) */
  private renderCamera(): Camera {
    const id = this.previewCameraId;
    if (id) {
      const content = this.bridge.get(id)?.userData.content;
      if (content instanceof PerspectiveCamera && this.editor.scene.get(id)) {
        content.aspect = this.engine.width / this.engine.height;
        content.updateProjectionMatrix();
        content.updateWorldMatrix(true, false);
        return content;
      }
      this.previewCameraId = null;
      for (const fn of this.previewListeners) fn();
    }
    return this.camera.camera;
  }

  /** 地形ブラシの状態が変わったとき */
  onBrushChange(fn: () => void): () => void {
    this.brushListeners.add(fn);
    return () => this.brushListeners.delete(fn);
  }

  /** 描画後に呼ばれるリスナー (軸ギズモ表示の更新など) */
  onRender(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * 画面の右・下がパネルで覆われている量 (px)。
   * 覆われていない範囲の中央を 3D ビューの中心にする (選んだ物がパネルに隠れないように)
   */
  setInsets(insets: ViewInsets, animate = true): void {
    const wasAnimating = this.camera.insetsAnimating;
    this.camera.setInsets(insets, animate);
    if (!animate) {
      this.gizmo.setSizeScale(this.camera.screenScale);
      this.scheduleReveal();
    } else if (!wasAnimating && this.camera.insetsAnimating) {
      this.revealAfterInsets = true;
    }
    this.requestRender();
  }

  private revealAfterInsets = false;

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.running) return;
    const insetsBefore = this.camera.insetsAnimating;
    if (this.camera.tick(now)) {
      this.needsRender = true;
      this.gizmo.setSizeScale(this.camera.screenScale);
    }
    // パネルが開き終わったら、選んだ物が隠れていれば見える所へ動かす
    if (insetsBefore && !this.camera.insetsAnimating && this.revealAfterInsets) {
      this.revealAfterInsets = false;
      this.revealSelection();
    }
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    // パーティクル: 選択中のもの (プレビュー ON ならすべて) を動かす
    const sel = this.editor.selection.ids;
    const all = this.editor.settings.previewEffects;
    if (this.effects.update(dt, (id) => all || sel.includes(id))) this.needsRender = true;
    // エフェクトのプレビューが有効なときだけ毎フレーム描画する (水の波・天候)
    if (this.editor.settings.previewEffects) {
      sharedUniforms.uTime.value = now / 1000;
      this.env.update(now / 1000, this.camera.camera);
      this.needsRender = true;
    }
    if (!this.needsRender) return;
    this.renderNow();
  };

  renderNow(): void {
    this.needsRender = false;
    if (this.selectionDirty) this.updateSelectionBoxes();
    // グリッドのフェード距離をズームに合わせる
    this.grid.setFadeDistance(Math.max(30, this.camera.distance * 4));
    // 星・月・雲をカメラに合わせ、時刻による太陽光の向きを反映する
    if (!this.editor.settings.previewEffects) this.env.refresh(this.camera.camera);
    else this.env.applyTime();
    // ポストエフェクトは「エフェクトのプレビュー」が ON のときだけ (被写界深度は Play のみ)
    this.engine.setPost(this.editor.settings.previewEffects ? this.editor.sceneData.environment.post : null, { noDof: true });
    const cam = this.renderCamera();
    // カメラの視点で見ているときは、ギズモや選択の枠を出さない
    const previewing = cam !== this.camera.camera;
    this.gizmo.setEnabled(!previewing && !this.terrainBrush.active);
    this.colliderGroup.visible = !previewing;
    this.grid.visible = !previewing && this.editor.settings.showGrid;
    this.engine.render(this.scene, cam);
    for (const fn of this.listeners) fn();
  }

  /** アニメーション編集のプレビュー: データを変えずに見た目の姿勢だけ変える (null で元に戻す) */
  previewPose(id: string, pose: { p: Vec3; r: Vec3; s: Vec3 } | null): void {
    const obj = this.bridge.get(id);
    const e = this.editor.scene.get(id);
    if (!obj || !e) return;
    if (pose) {
      obj.position.set(pose.p[0], pose.p[1], pose.p[2]);
      obj.rotation.set((pose.r[0] * Math.PI) / 180, (pose.r[1] * Math.PI) / 180, (pose.r[2] * Math.PI) / 180, 'XYZ');
      obj.scale.set(pose.s[0] || 1e-4, pose.s[1] || 1e-4, pose.s[2] || 1e-4);
      this.posed.add(id);
    } else {
      this.builder.applyTransform(obj, e);
      this.posed.delete(id);
    }
    obj.updateMatrixWorld(true);
    this.selectionDirty = true;
    this.requestRender();
  }

  /** 見た目の姿勢 (プレビュー中ならその姿勢) */
  displayedTransform(id: string): { p: Vec3; r: Vec3; s: Vec3 } | null {
    const obj = this.bridge.get(id);
    if (!obj) return null;
    const r = (v: number) => Math.round(v * 1000) / 1000;
    return {
      p: [r(obj.position.x), r(obj.position.y), r(obj.position.z)],
      r: [r((obj.rotation.x * 180) / Math.PI), r((obj.rotation.y * 180) / Math.PI), r((obj.rotation.z * 180) / Math.PI)],
      s: [r(obj.scale.x), r(obj.scale.y), r(obj.scale.z)],
    };
  }

  clearPoses(): void {
    for (const id of [...this.posed]) this.previewPose(id, null);
  }

  /** Play Mode 中は描画と入力を止める */
  suspend(): void {
    this.clearPoses();
    this.running = false;
    this.input.reset();
    this.input.enabled = false;
  }

  resume(): void {
    this.running = true;
    this.input.enabled = true;
    this.camera.setViewport(this.engine.width, this.engine.height);
    // Play 中に変わったレンダラーの設定 (露出など) を戻す
    this.applyEnvironment();
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

  private scheduleEnvironment = debounce(() => this.applyEnvironment(), 150);

  private applyEnvironment(): void {
    this.env.apply(this.editor.sceneData.environment, findSunDirection(this.bridge.root));
    this.requestRender();
  }

  private applySettings(): void {
    const s = this.editor.settings;
    this.grid.visible = s.showGrid;
    this.engine.setShadows(s.shadows);
    this.engine.setQuality(s.quality);
    if (this.builder.quality !== s.quality) {
      this.builder.setQuality(s.quality);
      this.bridge.refreshAll();
    }
    this.env.setQuality(s.quality);
    this.env.setWeatherVisible(s.previewEffects);
    this.env.animate = s.previewEffects;
    this.effects.sync(s.quality, this.engine.height);
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
    this.updateColliderHelpers();
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

  /** 選択中で物理コンポーネントを持つオブジェクトの当たり判定を表示する */
  private updateColliderHelpers(): void {
    for (const c of [...this.colliderGroup.children]) {
      c.removeFromParent();
      (c as Mesh).geometry.dispose();
    }
    const model = this.editor.scene;
    const pos = new Vector3();
    const quat = new Quaternion();
    const scale = new Vector3();
    for (const id of this.editor.selection.ids) {
      const e = model.get(id);
      const obj = this.bridge.get(id);
      // 地形は見た目そのものが当たり判定なので表示しない
      if (!e || !obj || !hasPhysics(e) || e.kind === 'terrain') continue;
      obj.updateWorldMatrix(true, false);
      obj.matrixWorld.decompose(pos, quat, scale);
      const shape = computeColliderShape(e, [scale.x, scale.y, scale.z], readCollider(e.components.find((c) => c.type === 'collider')));
      let geo: BufferGeometry;
      switch (shape.kind) {
        case 'sphere':
          geo = new SphereGeometry(shape.radius, 16, 10);
          break;
        case 'cylinder':
          geo = new CylinderGeometry(shape.radiusTop, shape.radiusBottom, shape.height, 16);
          break;
        case 'capsule':
          geo = new CapsuleGeometry(shape.radius, shape.height, 4, 12);
          break;
        case 'box':
          geo = new BoxGeometry(shape.half[0] * 2, shape.half[1] * 2, shape.half[2] * 2);
          break;
        default:
          continue;
      }
      const m = new Mesh(geo, colliderMat);
      m.position.copy(pos).add(new Vector3(...shape.offset).applyQuaternion(quat));
      m.quaternion.copy(quat);
      m.renderOrder = 998;
      m.userData.noPick = true;
      this.colliderGroup.add(m);
    }
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

  /**
   * 画面座標にあるエンティティの ID。
   * tolerance (px) を指定すると、指の真下に無くても近くにある物を選ぶ (小さい物をタップしやすくする)
   */
  pick(clientX: number, clientY: number, tolerance = 0): string | null {
    return this.pickAll(clientX, clientY, tolerance)[0] ?? null;
  }

  /** 画面座標にあるエンティティの ID を手前から順に (重なっている物もすべて) */
  pickAll(clientX: number, clientY: number, tolerance = 0): string[] {
    const ids = this.pickRay(clientX, clientY);
    if (ids.length > 0 || tolerance <= 0) return ids;
    // 周りを円状に調べ、指に近い所で見つかった物から順に並べる
    const found: string[] = [];
    for (const r of [tolerance * 0.5, tolerance]) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + (r === tolerance ? Math.PI / 8 : 0);
        for (const id of this.pickRay(clientX + Math.cos(a) * r, clientY + Math.sin(a) * r)) {
          if (!found.includes(id)) found.push(id);
        }
      }
      if (found.length > 0) break;
    }
    return found;
  }

  private pickRay(clientX: number, clientY: number): string[] {
    const ray = this.setRay(clientX, clientY);
    const hits = ray.intersectObjects(this.bridge.pickables(), false);
    const ids: string[] = [];
    for (const h of hits) {
      const eo = findEntityObject(h.object);
      const id = eo?.userData.entityId as string | undefined;
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  /** 覆われていない範囲 (画面座標) */
  visibleClientRect(): { left: number; top: number; right: number; bottom: number } {
    const r = this.element.getBoundingClientRect();
    const v = this.camera.visibleRect();
    return { left: r.left + v.x, top: r.top + v.y, right: r.left + v.x + v.width, bottom: r.top + v.y + v.height };
  }

  /** 選択中の物の画面上の範囲 (カメラの後ろなら null) */
  private screenBounds(id: string): { left: number; top: number; right: number; bottom: number } | null {
    const obj = this.bridge.get(id);
    if (!obj) return null;
    const box = this.computeBounds(obj, new Box3());
    if (box.isEmpty()) box.setFromCenterAndSize(new Vector3().setFromMatrixPosition(obj.matrixWorld), new Vector3(0.2, 0.2, 0.2));
    const r = this.element.getBoundingClientRect();
    const cam = this.camera.camera;
    cam.updateMatrixWorld();
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    let front = 0;
    const p = new Vector3();
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      p.project(cam);
      if (p.z > 1) continue;
      front++;
      const x = r.left + ((p.x + 1) / 2) * r.width;
      const y = r.top + ((1 - p.y) / 2) * r.height;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    return front > 0 ? { left, top, right, bottom } : null;
  }

  /** 選んだ物が見えていなければ (パネルの下・画面の外) 見える所へカメラを動かす */
  revealSelection(): void {
    const id = this.editor.selection.active;
    const e = id ? this.editor.scene.get(id) : undefined;
    if (!id || !e || e.kind === 'ui' || this.editor.mode !== 'edit') return;
    const vis = this.visibleClientRect();
    const b = this.screenBounds(id);
    // 少しでも見えていれば動かさない (タップで選んだ物の位置が急に変わらないように)
    const margin = 12;
    if (b && b.right > vis.left + margin && b.left < vis.right - margin && b.bottom > vis.top + margin && b.top < vis.bottom - margin) return;
    const obj = this.bridge.get(id);
    if (!obj) return;
    const box = this.computeBounds(obj, new Box3());
    const center = box.isEmpty() ? new Vector3().setFromMatrixPosition(obj.matrixWorld) : box.getCenter(new Vector3());
    this.camera.revealPoint(center);
  }

  private revealTimer = 0;

  private scheduleReveal(): void {
    cancelAnimationFrame(this.revealTimer);
    this.revealTimer = requestAnimationFrame(() => this.revealSelection());
  }

  /** 光線と表示中の地形の、いちばん手前の交点 */
  terrainHit(ray: Ray): { point: Vector3; id: string } | null {
    let best: { point: Vector3; id: string; d: number } | null = null;
    for (const e of this.editor.scene.ordered()) {
      if (e.kind !== 'terrain' || !e.terrain) continue;
      const obj = this.bridge.get(e.id);
      if (!obj || !isShown(obj)) continue;
      const hit = raycastTerrainObject(obj, e.terrain, ray);
      if (!hit) continue;
      const d = hit.distanceTo(ray.origin);
      if (!best || d < best.d) best = { point: hit, id: e.id, d };
    }
    return best ? { point: best.point, id: best.id } : null;
  }

  /** その場所の地面の高さ (地形があればその表面、無ければ 0) */
  surfaceHeight(x: number, z: number): number {
    const hit = this.terrainHit(new Ray(new Vector3(x, 1000, z), new Vector3(0, -1, 0)));
    return hit ? Math.round(hit.point.y * 1000) / 1000 : 0;
  }

  /** 画面座標の先にある地面の点 (地形があればその表面、無ければ y=0 の平面) */
  groundPointAt(clientX: number, clientY: number): Vector3 | null {
    const ray = this.setRay(clientX, clientY).ray;
    const hit = this.terrainHit(ray);
    if (hit) return hit.point;
    if (ray.direction.y >= -0.01) return null;
    const t = -ray.origin.y / ray.direction.y;
    if (t <= 0 || t > 500) return null;
    return ray.origin.clone().addScaledVector(ray.direction, t);
  }

  /** 新しいオブジェクトを置く位置 (画面中央の地面。スナップ有効時はグリッドに合わせる) */
  placementPoint(at?: { x: number; y: number }): Vec3 {
    let p = at ? this.groundPointAt(at.x, at.y) : null;
    if (!p && !at) {
      // 画面の中央 (カメラの向き) の先。地形があればその表面
      const cam = this.camera.camera;
      const dir = cam.getWorldDirection(new Vector3());
      p = this.terrainHit(new Ray(cam.getWorldPosition(new Vector3()), dir))?.point ?? null;
    }
    p ??= this.camera.groundPointAtCenter();
    const step = this.editor.settings.snapEnabled ? this.editor.settings.snapMove : 0.5;
    const base: Vec3 = [snapTo(p.x, step), 0, snapTo(p.z, step)];
    // 場所を指定された場合はそのまま。画面中央に置く場合は既存の物と重ならない場所を探す
    const spot = at ? base : this.findFreeSpot(base, Math.max(1, step));
    // 地形の上なら、その表面の高さ
    const y = this.surfaceHeight(spot[0], spot[2]);
    return [spot[0], y, spot[2]];
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
    // サムネイルにはギズモや選択枠を写さない (環境は描画前に最新にする)
    for (const o of [this.gizmo.controls.getHelper(), ...this.selectionBoxes, this.grid, this.colliderGroup]) {
      if (o.visible) {
        o.visible = false;
        hidden.push(o);
      }
    }
    const url = this.camera.withoutInsets(() => this.engine.captureThumbnail(() => this.engine.render(this.scene, this.camera.camera)));
    for (const o of hidden) o.visible = true;
    this.requestRender();
    return url;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.revealTimer);
    this.scheduleEnvironment.cancel();
    this.env.dispose();
    this.unsubs.forEach((u) => u());
    this.input.dispose();
    this.gizmo.dispose();
    this.bridge.dispose();
    this.grid.dispose();
  }
}

/** 自分と親がすべて表示中か */
function isShown(o: Object3D): boolean {
  for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
