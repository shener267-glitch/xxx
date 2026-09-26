import { Box3, MathUtils, PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { ComponentInstance, PlayerControllerHandle, RuntimeAPI } from '../components/registry';
import { getComponentDef } from '../components/registry';
import { logger } from '../core/logger';
import type { PlayCameraMode, QualityLevel } from '../core/settings';
import type { EntityData, ProjectData, SceneData, TransformData, UIButtonAction, Vec3 } from '../core/types';
import { vec3Round } from '../core/transformMath';
import type { EngineRenderer } from '../engine/EngineRenderer';
import { sharedUniforms } from '../engine/materials';
import { SceneBuilder } from '../engine/SceneBuilder';
import { findSunDirection, SceneEnvironment } from '../engine/SceneEnvironment';
import type { EntityObject } from '../engine/SceneBuilder';
import { resolveBodySpec } from '../engine/colliderShapes';
import { resolveAsset } from '../engine/textures';
import { AudioEngine } from './AudioEngine';
import type { AudioVolumes } from './AudioEngine';
import type { CameraRig } from './cameraRigs';
import { FirstPersonRig, GameCameraRig, ThirdPersonRig } from './cameraRigs';
import type { SaveData } from './GameState';
import { GameState } from './GameState';
import { GameUI } from './GameUI';
import type { ContactEvent } from './PhysicsWorld';
import { PhysicsWorld } from './PhysicsWorld';
import { RuntimeInput } from './RuntimeInput';

/**
 * ゲームの実行環境 (Play Mode)。
 *
 * エディタのシーンデータの「複製」から独立した Three.js シーンを組み立てて動かすため、
 * Play 中に何が起きてもエディタのデータは壊れない (Stop で元に戻る)。
 * エディタに依存しないので、ゲーム書き出しでもそのまま使う。
 *
 * Phase 3 で追加: ゲームの状態 (スコア・HP など)・音・ゲーム画面の UI・
 * HP とダメージ・敵を倒す・アイテムを拾う・会話・タイトル / 終了画面。
 */

export interface RuntimeStats {
  fps: number;
  drawCalls: number;
  triangles: number;
  /** MB (対応ブラウザのみ) */
  memory: number | null;
}

export type RuntimeRequest = 'restart' | 'title' | 'exit';

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
  /** 書き出したゲームとして動作する (一時停止メニューなどを自前で表示) */
  standalone?: boolean;
  /** タイトル画面から始める */
  showTitle?: boolean;
  /** セーブデータから再開する */
  continueFromSave?: boolean;
  /** 画面上部に確保する余白 (エディタの Play 用ボタン) */
  topInset?: number;
  /** セーブデータの保存先 (null なら端末に保存しない) */
  saveKey?: string | null;
  onStats?(stats: RuntimeStats): void;
  onMessage?(message: string, level: 'info' | 'warn' | 'error'): void;
  /** もう一度・タイトルへ・エディタに戻る */
  onRequest?(kind: RuntimeRequest): void;
  onPauseChange?(paused: boolean): void;
}

interface ActiveComponent {
  entityId: string;
  instance: ComponentInstance;
  label: string;
  entityName: string;
  failed: boolean;
}

interface HealthInfo {
  hp: number;
  maxHp: number;
  invincibleTime: number;
  invincibleUntil: number;
  score: number;
}

interface Interaction {
  id: string;
  label: string;
  distance: number;
  run: () => void;
}

interface Anim {
  obj: Object3D;
  t: number;
  dur: number;
  kind: 'pop' | 'squash';
  base: Vector3;
}

export type RuntimeEventListener = (event: string, entityId: string, data?: unknown) => void;

const VOLUME_KEY = 'pocket-engine:game-volumes';

function loadVolumes(): AudioVolumes {
  const d: AudioVolumes = { master: 1, music: 0.7, sfx: 0.9 };
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (!raw) return d;
    const v = JSON.parse(raw) as Partial<AudioVolumes>;
    const n = (x: unknown, def: number) => (typeof x === 'number' && x >= 0 && x <= 1 ? x : def);
    return { master: n(v.master, d.master), music: n(v.music, d.music), sfx: n(v.sfx, d.sfx) };
  } catch {
    return d;
  }
}

function saveVolumes(v: AudioVolumes): void {
  try {
    localStorage.setItem(VOLUME_KEY, JSON.stringify(v));
  } catch {
    // 保存できなくても続ける
  }
}

export function readSave(key: string | null | undefined): SaveData | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveData;
    return data && data.version === 1 ? data : null;
  } catch {
    return null;
  }
}

const _box = new Box3();
const _v = new Vector3();

export class GameRuntime implements RuntimeAPI {
  readonly scene = new Scene();
  readonly objects = new Map<string, EntityObject>();
  readonly sceneData: SceneData;
  readonly state = new GameState();
  readonly audio: AudioEngine;
  readonly ui: GameUI;
  time = 0;
  paused = false;
  /** 'title' の間はゲームが進まない */
  phase: 'title' | 'playing' = 'playing';
  cameraMode: PlayCameraMode;
  physics: PhysicsWorld | null = null;
  /** 接触イベントの購読者 (イベントシステムなど) */
  readonly contactListeners = new Set<(e: ContactEvent, began: boolean) => void>();
  /** ゲーム内イベントの購読者 (Phase 4 のイベントシステム・テスト用) */
  readonly eventListeners = new Set<RuntimeEventListener>();
  /** 最近のゲーム内イベント (デバッグ用) */
  readonly eventLog: { event: string; entityId: string; time: number }[] = [];
  private builder: SceneBuilder;
  private env: SceneEnvironment;
  private components: ActiveComponent[] = [];
  private inputImpl: RuntimeInput;
  private rig!: CameraRig;
  private mainCamera: PerspectiveCamera | null = null;
  private raf = 0;
  private lastTime = 0;
  private running = false;
  private statFrames = 0;
  private statTime = 0;
  private unsubResize: () => void;
  private readonly health = new Map<string, HealthInfo>();
  private readonly destroyed = new Set<string>();
  private readonly boundsCache = new Map<string, Box3>();
  private anims: Anim[] = [];
  private blinkUntil = new Map<string, number>();
  private interaction: Interaction | null = null;
  private lastInteraction: Interaction | null = null;
  private playerHandle: PlayerControllerHandle | null = null;
  /** プレイヤー操作コンポーネントを持つエンティティ */
  private controllerId: string | null = null;
  private controllerCamera: PlayCameraMode | null = null;
  private canAttack = false;
  private startPositions = new Map<string, Vec3>();

  constructor(private opts: RuntimeOptions) {
    const scene = opts.project.scenes.find((s) => s.id === opts.sceneId) ?? opts.project.scenes[0];
    this.sceneData = scene;
    this.cameraMode = opts.cameraMode;
    const quality = opts.quality ?? 'medium';
    this.builder = new SceneBuilder({ editor: false, quality });
    this.env = new SceneEnvironment(this.scene, opts.engine.renderer, quality);
    this.inputImpl = new RuntimeInput(opts.overlay);
    this.audio = new AudioEngine(resolveAsset);
    this.audio.setVolumes(loadVolumes());
    const game = opts.project.game;
    this.state.timeLimit = game.timeLimit;
    this.ui = new GameUI({
      root: opts.overlay,
      state: this.state,
      game,
      standalone: opts.standalone === true,
      topInset: opts.topInset ?? 0,
      volumes: this.audio.getVolumes(),
      resolveImage: async (id) => {
        const blob = await resolveAsset(id);
        return blob ? URL.createObjectURL(blob) : null;
      },
      handlers: {
        onJump: () => this.inputImpl.pressJump(),
        onAction: () => this.inputImpl.pressAction(),
        onUIButton: (id, action) => this.onUIButton(id, action),
        onStart: (fromSave) => this.beginGame(fromSave),
        onRestart: () => this.request('restart'),
        onTitle: () => this.request('title'),
        onPauseChange: (p) => this.setPaused(p),
        onVolumes: (v) => {
          this.audio.setVolumes(v);
          saveVolumes(this.audio.getVolumes());
        },
        onExit: opts.standalone ? undefined : () => this.request('exit'),
      },
    });
    this.inputImpl.onPauseKey = () => {
      if (!opts.standalone || this.phase !== 'playing' || this.state.ended) return;
      if (this.ui.screenOpen) return;
      this.ui.showPause();
    };
    // 最初のタップで音を出せるようにする (ブラウザの自動再生制限)
    opts.overlay.addEventListener('pointerdown', this.unlockAudio, { capture: true });
    this.build();
    this.env.apply(scene.environment, findSunDirection(this.scene));
    this.setCameraMode(this.controllerCamera ?? opts.cameraMode);
    this.unsubResize = opts.engine.onResize((w, h) => this.rig?.setAspect(w / h));
    if (opts.showTitle) {
      this.phase = 'title';
      this.ui.showTitle(readSave(opts.saveKey) !== null);
    }
  }

  private unlockAudio = () => this.audio.unlock();

  // ------------------------------------------------------------------
  // 構築
  // ------------------------------------------------------------------

  private build(): void {
    const data = this.sceneData;
    const order: EntityData[] = [];
    const visit = (ids: string[], parent: Object3D) => {
      for (const id of ids) {
        const e = data.entities[id];
        if (!e) continue;
        order.push(e);
        const obj = this.builder.create(e);
        this.objects.set(id, obj);
        parent.add(obj);
        visit(e.children, obj);
      }
    };
    visit(data.roots, this.scene);
    this.scene.updateMatrixWorld(true);

    // メインカメラ (無ければ最初のカメラ)
    const cams = Object.values(data.entities).filter((e) => e.kind === 'camera' && e.visible);
    const main = cams.find((e) => e.camera?.main) ?? cams[0];
    if (main) {
      const content = this.objects.get(main.id)?.userData.content;
      if (content instanceof PerspectiveCamera) this.mainCamera = content;
    }

    // プレイヤー操作コンポーネント (あればそのオブジェクトがプレイヤー)
    const controller = order.find((e) => this.isVisibleInHierarchy(e) && e.components.some((c) => c.enabled && c.type === 'player'));
    if (controller) {
      this.controllerId = controller.id;
      const props = controller.components.find((c) => c.type === 'player')!.props;
      this.controllerCamera = props.camera === 'firstPerson' ? 'firstPerson' : props.camera === 'scene' ? 'game' : 'thirdPerson';
      this.canAttack = props.attack !== false;
      const lives = Number(props.lives);
      this.state.lives = Number.isFinite(lives) && lives >= 1 ? Math.round(lives) : 3;
    }

    // HP
    for (const e of order) {
      const c = e.components.find((x) => x.enabled && x.type === 'health');
      if (!c) continue;
      const maxHp = Math.max(1, Number(c.props.maxHp) || 100);
      const inv = Number(c.props.invincibleTime);
      this.health.set(e.id, {
        hp: maxHp,
        maxHp,
        invincibleTime: Number.isFinite(inv) && inv >= 0 ? inv : 1,
        invincibleUntil: 0,
        score: Math.max(0, Number(c.props.score) || 0),
      });
    }
    const playerId = this.playerId;
    if (playerId) {
      const hp = this.health.get(playerId);
      if (hp) this.state.setHp(hp.hp, hp.maxHp);
    }
    for (const e of order) {
      const obj = this.objects.get(e.id);
      if (obj) {
        const p = obj.getWorldPosition(new Vector3());
        this.startPositions.set(e.id, [p.x, p.y, p.z]);
      }
    }

    // コンポーネントの生成
    for (const e of order) {
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

    // ゲーム画面の UI
    this.ui.setUIEntities(order.filter((e) => e.kind === 'ui' && this.isVisibleInHierarchy(e)));
    const hasNpc = order.some((e) => e.components.some((c) => c.enabled && c.type === 'npc'));
    this.ui.configureHud({ hasHp: !!(playerId && this.health.has(playerId)), showLives: this.controllerId !== null && this.state.lives > 1 });
    this.ui.setControls({ jump: this.controllerId !== null, action: this.controllerId !== null && (this.canAttack || hasNpc) });
    this.ui.setActionLabel('攻撃');
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

  /** 操作中のプレイヤー (プレイヤー操作コンポーネント > 指定 > シーンの設定) */
  get playerId(): string | null {
    return this.controllerId ?? this.opts.playerId ?? this.sceneData.playerId ?? null;
  }

  get player(): EntityObject | null {
    const id = this.playerId;
    return id ? (this.objects.get(id) ?? null) : null;
  }

  get hasPlayer(): boolean {
    return this.player !== null;
  }

  getCameraMode(): PlayCameraMode {
    return this.cameraMode;
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
    const player = this.player;
    const controlled = this.controllerId !== null;
    if (mode === 'thirdPerson' && !player) {
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
      if (controlled && player) {
        const box = new Box3().setFromObject(player);
        const eye = Math.max(0.2, (box.max.y - box.min.y) * 0.38);
        this.rig = new FirstPersonRig(view, { object: player, eyeHeight: eye });
      } else {
        this.rig = new FirstPersonRig(view);
      }
    } else {
      // 現在の視線方向の後ろから追いかける
      const forward = new Vector3(0, 0, -1).applyQuaternion(view.quaternion);
      const yaw = MathUtils.radToDeg(Math.atan2(-forward.x, -forward.z));
      this.rig = new ThirdPersonRig(player!, yaw, !controlled);
    }
    this.cameraMode = actual;
    // プレイヤーを操作するゲームでは、シーンのカメラでもジョイスティックを使う
    this.inputImpl.setJoystickEnabled(actual !== 'game' || controlled);
    this.rig.setAspect(this.opts.engine.width / this.opts.engine.height);
    return actual;
  }

  cameraYaw(): number {
    const cam = this.rig.camera;
    cam.updateWorldMatrix(true, false);
    const e = cam.matrixWorld.elements;
    // カメラの前方向 = -Z 軸
    const fx = -e[8];
    const fz = -e[10];
    return MathUtils.radToDeg(Math.atan2(-fx, -fz));
  }

  // ------------------------------------------------------------------
  // 実行
  // ------------------------------------------------------------------

  /** 物理演算の準備 (物理を使うシーンのみ cannon-es を読み込む) */
  private async initPhysics(): Promise<void> {
    const data = this.sceneData;
    if (!data.physics.enabled) return;
    const autoColliders = data.physics.autoColliders && this.controllerId !== null;
    const targets = Object.values(data.entities)
      .filter((e) => this.isVisibleInHierarchy(e))
      .map((e) => ({ e, spec: resolveBodySpec(e, { autoColliders }) }))
      .filter((t) => t.spec !== null);
    if (targets.length === 0) return;
    try {
      const physics = await PhysicsWorld.create(data.physics);
      for (const { e, spec } of targets) {
        const obj = this.objects.get(e.id);
        if (!obj) continue;
        try {
          physics.addEntity(e, obj, spec!);
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
    if (this.phase === 'playing') this.beginGame(this.opts.continueFromSave === true);
    this.lastTime = performance.now();
    this.statTime = this.lastTime;
    this.raf = requestAnimationFrame(this.loop);
  }

  /** タイトル画面から (または直接) ゲームを始める */
  beginGame(fromSave: boolean): void {
    this.phase = 'playing';
    this.ui.closeScreen();
    this.audio.unlock();
    if (fromSave) this.loadSave();
    const music = this.sceneData.music;
    if (music.source) this.audio.playMusic(music.source, music.volume);
    this.emit('start', '');
  }

  private loadSave(): void {
    const data = readSave(this.opts.saveKey);
    if (!data) return;
    this.state.load(data);
    const pid = this.playerId;
    if (pid) {
      const hp = this.health.get(pid);
      if (hp) {
        hp.maxHp = this.state.maxHp || hp.maxHp;
        hp.hp = this.state.hp;
      }
      if (data.sceneId === this.sceneData.id && this.state.checkpoint) this.movePlayer(this.state.checkpoint);
    }
    this.ui.toast('セーブデータから再開しました');
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

  /** ゲームの進行が止まっている (タイトル・会話・メニュー・終了) */
  get frozen(): boolean {
    return this.phase !== 'playing' || this.state.ended || this.ui.dialogOpen || this.ui.screenOpen;
  }

  /** 1フレーム分ゲームを進める (テストからも呼べる) */
  step(dt: number): void {
    this.boundsCache.clear();
    if (!this.frozen) {
      this.time += dt;
      if (this.state.tick(dt)) this.timeUp();
      this.lastInteraction = this.interaction;
      this.interaction = null;
      for (const c of this.components) {
        if (c.failed || !c.instance.update || this.destroyed.has(c.entityId)) continue;
        try {
          c.instance.update(dt, this.time);
        } catch (err) {
          // 毎フレームエラーを出し続けないよう、そのコンポーネントを停止する
          c.failed = true;
          this.report(`${c.label}でエラーが発生したため停止しました`, 'error', c.entityName, err);
        }
      }
      this.physics?.step(dt);
      if (this.controllerId) {
        // コンポーネントの update 中に offerInteraction で設定される
        const it = this.interaction as Interaction | null;
        this.ui.setActionLabel(it ? it.label : this.canAttack ? '攻撃' : '調べる');
      }
    } else {
      this.inputImpl.clearQueued();
    }
    this.updateAnims(dt);
    this.rig.update(dt, this.inputImpl);
    sharedUniforms.uTime.value += dt;
    this.env.update(sharedUniforms.uTime.value, this.rig.camera);
    this.state.flush();
  }

  private updateAnims(dt: number): void {
    if (this.anims.length > 0) {
      this.anims = this.anims.filter((a) => {
        a.t += dt;
        const k = Math.min(1, a.t / a.dur);
        if (a.kind === 'pop') {
          const s = k < 0.3 ? 1 + k * 0.8 : Math.max(0, 1.24 * (1 - (k - 0.3) / 0.7));
          a.obj.scale.copy(a.base).multiplyScalar(Math.max(0.0001, s));
          if (k >= 1) a.obj.visible = false;
        } else {
          const s = 1 - Math.sin(k * Math.PI) * 0.22;
          a.obj.scale.set(a.base.x * (2 - s), a.base.y * s, a.base.z * (2 - s));
          if (k >= 1) a.obj.scale.copy(a.base);
        }
        return k < 1;
      });
    }
    for (const [id, until] of this.blinkUntil) {
      const obj = this.objects.get(id);
      if (!obj) continue;
      if (this.time >= until || this.destroyed.has(id)) {
        obj.visible = !this.destroyed.has(id);
        this.blinkUntil.delete(id);
      } else {
        obj.visible = Math.floor(this.time * 12) % 2 === 0;
      }
    }
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
    if (this.paused === paused) return;
    this.paused = paused;
    this.audio.setPaused(paused);
    this.opts.onPauseChange?.(paused);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private request(kind: RuntimeRequest): void {
    this.audio.play('builtin:click', 0.6);
    if (this.opts.onRequest) this.opts.onRequest(kind);
  }

  private onUIButton(id: string, action: UIButtonAction): void {
    if (this.phase !== 'playing') return;
    this.audio.play('builtin:click', 0.5);
    this.emit('ui-click', id);
    switch (action) {
      case 'jump':
        this.inputImpl.pressJump();
        break;
      case 'action':
        this.inputImpl.pressAction();
        break;
      case 'pause':
        this.ui.showPause();
        break;
      case 'restart':
        this.request('restart');
        break;
      case 'title':
        this.request('title');
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------
  // RuntimeAPI
  // ------------------------------------------------------------------

  get input(): RuntimeInput {
    return this.inputImpl;
  }

  get gravity(): number {
    const g = this.sceneData.physics.gravity;
    const len = Math.hypot(g[0], g[1], g[2]);
    return len > 0.01 ? len : 9.81;
  }

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

  playSound(source: string | null | undefined, volume = 1): void {
    this.audio.play(source, volume);
  }

  toast(message: string): void {
    this.ui.toast(message);
  }

  async talk(name: string, pages: string[]): Promise<void> {
    this.inputImpl.clearQueued();
    this.audio.play('builtin:talk', 0.5);
    await this.ui.showDialog(name, pages, () => this.audio.play('builtin:talk', 0.3));
    this.inputImpl.clearQueued();
  }

  worldPosition(entityId: string, out = new Vector3()): Vector3 {
    const obj = this.objects.get(entityId);
    if (!obj) return out.set(0, 0, 0);
    obj.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(obj.matrixWorld);
  }

  bounds(entityId: string): Box3 {
    let box = this.boundsCache.get(entityId);
    if (!box) {
      box = new Box3();
      const obj = this.objects.get(entityId);
      if (obj) {
        obj.updateWorldMatrix(true, true);
        box.setFromObject(obj);
        if (box.isEmpty()) box.setFromCenterAndSize(obj.getWorldPosition(_v), new Vector3(0.1, 0.1, 0.1));
      }
      this.boundsCache.set(entityId, box);
    }
    return box;
  }

  overlaps(a: string, b: string, margin = 0): boolean {
    if (this.destroyed.has(a) || this.destroyed.has(b)) return false;
    const oa = this.objects.get(a);
    const ob = this.objects.get(b);
    if (!oa || !ob || !oa.visible) return false;
    _box.copy(this.bounds(a)).expandByScalar(margin);
    return _box.intersectsBox(this.bounds(b));
  }

  isGrounded(entityId: string): boolean {
    return this.physics?.isGrounded(entityId) ?? false;
  }

  isDestroyed(entityId: string): boolean {
    return this.destroyed.has(entityId);
  }

  destroyEntity(entityId: string, effect: 'pop' | 'none' = 'none'): void {
    if (this.destroyed.has(entityId)) return;
    const obj = this.objects.get(entityId);
    const mark = (id: string) => {
      this.destroyed.add(id);
      this.physics?.removeEntity(id);
      const e = this.sceneData.entities[id];
      e?.children.forEach(mark);
    };
    mark(entityId);
    if (!obj) return;
    if (effect === 'pop') this.anims.push({ obj, t: 0, dur: 0.22, kind: 'pop', base: obj.scale.clone() });
    else obj.visible = false;
    this.emit('destroyed', entityId);
  }

  healthTargets(): Iterable<string> {
    return this.health.keys();
  }

  getHealth(entityId: string): { hp: number; maxHp: number } | null {
    const h = this.health.get(entityId);
    return h ? { hp: h.hp, maxHp: h.maxHp } : null;
  }

  damage(target: string, amount: number, source?: string): boolean {
    const h = this.health.get(target);
    if (!h || h.hp <= 0 || this.destroyed.has(target) || this.state.ended || amount <= 0) return false;
    const lethal = amount === Number.POSITIVE_INFINITY;
    if (!lethal && this.time < h.invincibleUntil) return false;
    h.hp = Math.max(0, h.hp - amount);
    h.invincibleUntil = this.time + h.invincibleTime;
    const isPlayer = target === this.playerId;
    if (isPlayer) {
      this.state.setHp(h.hp, h.maxHp);
      this.audio.play('builtin:damage');
      if (h.hp > 0 && h.invincibleTime > 0) this.blinkUntil.set(target, this.time + h.invincibleTime);
    } else {
      const obj = this.objects.get(target);
      if (obj && h.hp > 0) this.anims.push({ obj, t: 0, dur: 0.18, kind: 'squash', base: obj.scale.clone() });
    }
    this.emit('damage', target, { amount, source });
    if (h.hp <= 0) this.onDeath(target, h);
    return true;
  }

  heal(target: string, amount: number): boolean {
    const h = this.health.get(target);
    if (!h || h.hp <= 0 || h.hp >= h.maxHp || amount <= 0) return false;
    h.hp = Math.min(h.maxHp, h.hp + amount);
    if (target === this.playerId) this.state.setHp(h.hp, h.maxHp);
    this.emit('heal', target, { amount });
    return true;
  }

  private onDeath(target: string, h: HealthInfo): void {
    if (target !== this.playerId) {
      this.state.addScore(h.score);
      this.audio.play('builtin:explosion', 0.6);
      this.destroyEntity(target, 'pop');
      this.emit('defeated', target);
      return;
    }
    this.state.lives = Math.max(0, this.state.lives - 1);
    this.state.markDirty();
    this.emit('player-down', target);
    if (this.state.lives <= 0) {
      this.gameOver();
      return;
    }
    // 残機があれば復活地点から再開
    const pos = this.state.checkpoint ?? this.startPositions.get(target) ?? [0, 1, 0];
    this.movePlayer(pos);
    h.hp = h.maxHp;
    h.invincibleUntil = this.time + 2;
    this.blinkUntil.set(target, this.time + 2);
    this.state.setHp(h.hp, h.maxHp);
    this.ui.toast(`残り ${this.state.lives}`);
  }

  private movePlayer(pos: Vec3): void {
    const id = this.playerId;
    if (!id) return;
    if (this.playerHandle) {
      this.playerHandle.respawn(pos);
    } else if (this.physics?.bodies.get(id)) {
      this.physics.teleport(id, pos);
    } else {
      this.objects.get(id)?.position.set(pos[0], pos[1], pos[2]);
    }
  }

  offerInteraction(entityId: string, label: string, distance: number, run: () => void): void {
    if (!this.interaction || distance < this.interaction.distance) this.interaction = { id: entityId, label, distance, run };
  }

  interact(): boolean {
    const it = this.lastInteraction;
    if (!it || this.destroyed.has(it.id)) return false;
    try {
      it.run();
    } catch (err) {
      this.report('操作中にエラーが発生しました', 'error', this.sceneData.entities[it.id], err);
    }
    return true;
  }

  registerPlayer(entityId: string, handle: PlayerControllerHandle): void {
    if (entityId === this.playerId) this.playerHandle = handle;
  }

  bouncePlayer(speed: number): void {
    this.playerHandle?.bounce(speed);
  }

  knockbackPlayer(dir: Vec3, strength: number): void {
    this.playerHandle?.knockback(dir, strength);
  }

  saveCheckpoint(pos: Vec3, persist: boolean): void {
    this.state.checkpoint = [...pos];
    const key = this.opts.saveKey;
    if (!persist || !key) return;
    try {
      localStorage.setItem(key, JSON.stringify(this.state.toSave(this.sceneData.id, pos)));
    } catch (err) {
      this.report('セーブできませんでした (端末の保存領域を確認してください)', 'warn', undefined, err);
    }
  }

  private timeUp(): void {
    const g = this.opts.project.game;
    if (g.timeUpResult === 'clear') this.gameClear(g.clearMessage);
    else this.gameOver(`時間切れ！ ${g.gameOverMessage}`);
  }

  gameOver(message?: string): void {
    const text = message || this.opts.project.game.gameOverMessage;
    if (!this.state.end('gameover', text)) return;
    this.audio.stopMusic();
    this.audio.play('builtin:lose');
    this.ui.closeDialog();
    this.ui.showEnd('gameover', text);
    this.emit('gameover', '');
  }

  gameClear(message?: string): void {
    const text = message || this.opts.project.game.clearMessage;
    if (!this.state.end('clear', text)) return;
    this.audio.stopMusic();
    this.audio.play('builtin:win');
    this.ui.closeDialog();
    this.ui.showEnd('clear', text);
    this.emit('clear', '');
  }

  emit(event: string, entityId: string, data?: unknown): void {
    this.eventLog.push({ event, entityId, time: this.time });
    if (this.eventLog.length > 100) this.eventLog.shift();
    for (const fn of this.eventListeners) {
      try {
        fn(event, entityId, data);
      } catch (err) {
        logger.warn('イベント処理でエラー', 'Play', err);
      }
    }
  }

  /** Play 中に変化した位置・回転・拡大 (「変更を保持」用) */
  exportTransforms(): Map<string, TransformData> {
    const out = new Map<string, TransformData>();
    for (const [id, obj] of this.objects) {
      if (this.destroyed.has(id)) continue;
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
    this.opts.overlay.removeEventListener('pointerdown', this.unlockAudio, { capture: true });
    this.inputImpl.dispose();
    this.ui.dispose();
    this.audio.dispose();
    this.eventListeners.clear();
    for (const obj of this.objects.values()) this.builder.dispose(obj);
    this.objects.clear();
    this.scene.clear();
  }
}
