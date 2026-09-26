import { MathUtils, PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { ComponentInstance, RuntimeAPI } from '../components/registry';
import { getComponentDef } from '../components/registry';
import { logger } from '../core/logger';
import type { PlayCameraMode, QualityLevel } from '../core/settings';
import type { EntityData, ProjectData, SceneData, TransformData } from '../core/types';
import { vec3Round } from '../core/transformMath';
import type { EngineRenderer } from '../engine/EngineRenderer';
import { sharedUniforms } from '../engine/materials';
import { SceneBuilder } from '../engine/SceneBuilder';
import { findSunDirection, SceneEnvironment } from '../engine/SceneEnvironment';
import type { EntityObject } from '../engine/SceneBuilder';
import { hasPhysics } from '../engine/colliderShapes';
import type { CameraRig } from './cameraRigs';
import type { ContactEvent } from './PhysicsWorld';
import { PhysicsWorld } from './PhysicsWorld';
import { FirstPersonRig, GameCameraRig, ThirdPersonRig } from './cameraRigs';
import { RuntimeInput } from './RuntimeInput';

/**
 * ゲームの実行環境 (Play Mode)。
 *
 * エディタのシーンデータの「複製」から独立した Three.js シーンを組み立てて動かすため、
 * Play 中に何が起きてもエディタのデータは壊れない (Stop で元に戻る)。
 * エディタに依存しないので、Phase 6 のゲーム書き出しでもそのまま使う。
 */

export interface RuntimeStats {
  fps: number;
  drawCalls: number;
  triangles: number;
  /** MB (対応ブラウザのみ) */
  memory: number | null;
}

export interface RuntimeOptions {
  engine: EngineRenderer;
  project: ProjectData;
  sceneId: string;
  /** 入力を受け取るオーバーレイ要素 (キャンバスの上に重ねる) */
  overlay: HTMLElement;
  cameraMode: PlayCameraMode;
  quality?: QualityLevel;
  /** メインカメラが無い場合の視点 (エディタのカメラ位置など) */
  fallbackView?: { position: Vector3; quaternion: Quaternion };
  /** 三人称で操作する対象 (未指定ならシーンの playerId) */
  playerId?: string | null;
  onStats?(stats: RuntimeStats): void;
  onMessage?(message: string, level: 'info' | 'warn' | 'error'): void;
}

interface ActiveComponent {
  entityId: string;
  instance: ComponentInstance;
  label: string;
  entityName: string;
  failed: boolean;
}

export class GameRuntime implements RuntimeAPI {
  readonly scene = new Scene();
  readonly objects = new Map<string, EntityObject>();
  readonly sceneData: SceneData;
  time = 0;
  paused = false;
  cameraMode: PlayCameraMode;
  physics: PhysicsWorld | null = null;
  /** 接触イベントの購読者 (イベントシステムなど) */
  readonly contactListeners = new Set<(e: ContactEvent, began: boolean) => void>();
  private builder: SceneBuilder;
  private env: SceneEnvironment;
  private components: ActiveComponent[] = [];
  private input: RuntimeInput;
  private rig!: CameraRig;
  private mainCamera: PerspectiveCamera | null = null;
  private raf = 0;
  private lastTime = 0;
  private running = false;
  private statFrames = 0;
  private statTime = 0;
  private unsubResize: () => void;

  constructor(private opts: RuntimeOptions) {
    const scene = opts.project.scenes.find((s) => s.id === opts.sceneId) ?? opts.project.scenes[0];
    this.sceneData = scene;
    this.cameraMode = opts.cameraMode;
    const quality = opts.quality ?? 'medium';
    this.builder = new SceneBuilder({ editor: false, quality });
    this.env = new SceneEnvironment(this.scene, opts.engine.renderer, quality);
    this.input = new RuntimeInput(opts.overlay);
    this.build();
    this.env.apply(scene.environment, findSunDirection(this.scene));
    this.setCameraMode(opts.cameraMode);
    this.unsubResize = opts.engine.onResize((w, h) => this.rig?.setAspect(w / h));
  }

  // ------------------------------------------------------------------
  // 構築
  // ------------------------------------------------------------------

  private build(): void {
    const data = this.sceneData;
    const visit = (ids: string[], parent: Object3D) => {
      for (const id of ids) {
        const e = data.entities[id];
        if (!e) continue;
        const obj = this.builder.create(e);
        this.objects.set(id, obj);
        parent.add(obj);
        visit(e.children, obj);
      }
    };
    visit(data.roots, this.scene);

    // メインカメラ (無ければ最初のカメラ)
    const cams = Object.values(data.entities).filter((e) => e.kind === 'camera' && e.visible);
    const main = cams.find((e) => e.camera?.main) ?? cams[0];
    if (main) {
      const content = this.objects.get(main.id)?.userData.content;
      if (content instanceof PerspectiveCamera) this.mainCamera = content;
    }

    // コンポーネントの生成
    for (const e of Object.values(data.entities)) {
      const obj = this.objects.get(e.id);
      if (!obj) continue;
      for (const c of e.components) {
        if (!c.enabled) continue;
        const def = getComponentDef(c.type);
        if (!def?.create) {
          if (!def) this.report(`不明なコンポーネント「${c.type}」をスキップしました`, 'warn', e);
          continue;
        }
        try {
          const instance = def.create({ entity: e, object: obj, runtime: this }, c.props);
          this.components.push({ entityId: e.id, instance, label: def.label, entityName: e.name, failed: false });
        } catch (err) {
          this.report(`${def.label}の初期化に失敗しました`, 'error', e, err);
        }
      }
    }
  }

  private report(message: string, level: 'info' | 'warn' | 'error', entity?: EntityData | string, err?: unknown): void {
    const name = typeof entity === 'string' ? entity : entity?.name;
    const source = name ? `Play / ${name}` : 'Play';
    logger.log(level, message, source, err);
    this.opts.onMessage?.(`${name ? `[${name}] ` : ''}${message}`, level);
  }

  // ------------------------------------------------------------------
  // カメラ
  // ------------------------------------------------------------------

  get player(): EntityObject | null {
    const id = this.opts.playerId ?? this.sceneData.playerId;
    return id ? (this.objects.get(id) ?? null) : null;
  }

  get hasPlayer(): boolean {
    return this.player !== null;
  }

  /** 現在のカメラのワールド姿勢 */
  private currentView(): { position: Vector3; quaternion: Quaternion; fov?: number } {
    const cam = this.rig?.camera ?? this.mainCamera;
    if (cam) {
      cam.updateWorldMatrix(true, false);
      const position = new Vector3();
      const quaternion = new Quaternion();
      cam.matrixWorld.decompose(position, quaternion, new Vector3());
      return { position, quaternion, fov: cam.fov };
    }
    if (this.opts.fallbackView) return { ...this.opts.fallbackView, fov: 60 };
    return { position: new Vector3(0, 2, 8), quaternion: new Quaternion() };
  }

  setCameraMode(mode: PlayCameraMode): PlayCameraMode {
    let actual = mode;
    if (mode === 'thirdPerson' && !this.player) {
      this.report('三人称カメラの対象 (プレイヤー) が設定されていないため一人称にしました', 'warn');
      actual = 'firstPerson';
    }
    const view = this.currentView();
    this.rig?.dispose?.();
    if (actual === 'game') {
      if (this.mainCamera) {
        this.rig = new GameCameraRig(this.mainCamera);
      } else {
        // カメラが無い場合は固定視点
        const cam = new PerspectiveCamera(60, 1, 0.05, 1000);
        cam.position.copy(view.position);
        cam.quaternion.copy(view.quaternion);
        this.rig = new GameCameraRig(cam);
      }
    } else if (actual === 'firstPerson') {
      this.rig = new FirstPersonRig(view);
    } else {
      // 現在の視線方向の後ろから追いかける
      const forward = new Vector3(0, 0, -1).applyQuaternion(view.quaternion);
      const yaw = MathUtils.radToDeg(Math.atan2(-forward.x, -forward.z));
      this.rig = new ThirdPersonRig(this.player!, yaw);
    }
    this.cameraMode = actual;
    this.input.setJoystickEnabled(actual !== 'game');
    this.rig.setAspect(this.opts.engine.width / this.opts.engine.height);
    return actual;
  }

  // ------------------------------------------------------------------
  // 実行
  // ------------------------------------------------------------------

  /** 物理演算の準備 (物理を使うシーンのみ cannon-es を読み込む) */
  private async initPhysics(): Promise<void> {
    const data = this.sceneData;
    if (!data.physics.enabled) return;
    const targets = Object.values(data.entities).filter((e) => hasPhysics(e));
    if (targets.length === 0) return;
    try {
      const physics = await PhysicsWorld.create(data.physics);
      for (const e of targets) {
        const obj = this.objects.get(e.id);
        if (!obj || !this.isVisibleInHierarchy(e)) continue;
        try {
          physics.addEntity(e, obj);
        } catch (err) {
          this.report('当たり判定を作れませんでした', 'warn', e, err);
        }
      }
      physics.onContactBegin = (ev) => this.dispatchContact(ev, true);
      physics.onContactEnd = (ev) => this.dispatchContact(ev, false);
      this.physics = physics;
    } catch (err) {
      this.report('物理演算を読み込めませんでした (物理なしで実行します)', 'error', undefined, err);
    }
  }

  private isVisibleInHierarchy(e: EntityData): boolean {
    let cur: EntityData | undefined = e;
    while (cur) {
      if (!cur.visible) return false;
      cur = cur.parent ? this.sceneData.entities[cur.parent] : undefined;
    }
    return true;
  }

  private dispatchContact(ev: ContactEvent, began: boolean): void {
    for (const c of this.components) {
      if (c.failed || !c.instance.onContact) continue;
      const other = c.entityId === ev.a ? ev.b : c.entityId === ev.b ? ev.a : null;
      if (!other) continue;
      try {
        c.instance.onContact(other, began, ev.trigger);
      } catch (err) {
        c.failed = true;
        this.report(`${c.label}でエラーが発生したため停止しました`, 'error', c.entityName, err);
      }
    }
    for (const fn of this.contactListeners) fn(ev, began);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.initPhysics();
    // シェーダーを事前にコンパイルして、最初のフレームでの引っかかりを防ぐ
    try {
      await this.opts.engine.renderer.compileAsync(this.scene, this.rig.camera);
    } catch {
      // 非対応の環境では最初の描画時にコンパイルされる
    }
    // 読み込み中に停止された場合
    if (!this.running) return;
    for (const c of this.components) {
      if (!c.instance.start) continue;
      try {
        c.instance.start();
      } catch (err) {
        c.failed = true;
        this.report(`${c.label}の開始時にエラーが発生しました`, 'error', c.entityName, err);
      }
    }
    this.lastTime = performance.now();
    this.statTime = this.lastTime;
    this.raf = requestAnimationFrame(this.loop);
  }

  private loop = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    // タブ復帰時などの大きな時間の飛びは抑える
    const dt = Math.min(0.1, Math.max(0, (now - this.lastTime) / 1000));
    this.lastTime = now;
    if (!this.paused) this.step(dt);
    this.opts.engine.render(this.scene, this.rig.camera);
    this.updateStats(now);
  };

  /** 1フレーム分ゲームを進める (テストからも呼べる) */
  step(dt: number): void {
    this.time += dt;
    for (const c of this.components) {
      if (c.failed || !c.instance.update) continue;
      try {
        c.instance.update(dt, this.time);
      } catch (err) {
        // 毎フレームエラーを出し続けないよう、そのコンポーネントを停止する
        c.failed = true;
        this.report(`${c.label}でエラーが発生したため停止しました`, 'error', c.entityName, err);
      }
    }
    this.physics?.step(dt);
    this.rig.update(dt, this.input);
    sharedUniforms.uTime.value = this.time;
    this.env.update(this.time, this.rig.camera);
  }

  private updateStats(now: number): void {
    this.statFrames++;
    const elapsed = now - this.statTime;
    if (elapsed < 500) return;
    const info = this.opts.engine.renderer.info;
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    this.opts.onStats?.({
      fps: Math.round((this.statFrames * 1000) / elapsed),
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      memory: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
    });
    this.statFrames = 0;
    this.statTime = now;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  // ------------------------------------------------------------------
  // RuntimeAPI
  // ------------------------------------------------------------------

  findObjectByName(name: string): Object3D | null {
    for (const obj of this.objects.values()) if (obj.name === name) return obj;
    return null;
  }

  getObject(entityId: string): Object3D | null {
    return this.objects.get(entityId) ?? null;
  }

  getEntity(entityId: string): EntityData | undefined {
    return this.sceneData.entities[entityId];
  }

  log(message: string): void {
    this.report(message, 'info');
  }

  /** Play 中に変化した位置・回転・拡大 (「変更を保持」用) */
  exportTransforms(): Map<string, TransformData> {
    const out = new Map<string, TransformData>();
    for (const [id, obj] of this.objects) {
      const t: TransformData = {
        position: vec3Round([obj.position.x, obj.position.y, obj.position.z]),
        rotation: vec3Round([
          MathUtils.radToDeg(obj.rotation.x),
          MathUtils.radToDeg(obj.rotation.y),
          MathUtils.radToDeg(obj.rotation.z),
        ]),
        scale: vec3Round([obj.scale.x, obj.scale.y, obj.scale.z]),
      };
      out.set(id, t);
    }
    return out;
  }

  dispose(): void {
    this.stop();
    for (const c of this.components) {
      try {
        c.instance.destroy?.();
      } catch (err) {
        logger.warn(`${c.label}の終了処理でエラー`, 'Play', err);
      }
    }
    this.components = [];
    this.rig?.dispose?.();
    this.physics?.dispose();
    this.physics = null;
    this.env.dispose();
    this.unsubResize();
    this.input.dispose();
    for (const obj of this.objects.values()) this.builder.dispose(obj);
    this.objects.clear();
    this.scene.clear();
  }
}
