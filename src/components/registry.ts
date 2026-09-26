import type { Box3, Object3D, Vector3 } from 'three';
import type { PlayCameraMode, QualityLevel } from '../core/settings';
import type { EntityData, Vec3 } from '../core/types';
import type { GameState } from '../runtime/GameState';
import type { PhysicsWorld } from '../runtime/PhysicsWorld';

/**
 * ゲームロジック用コンポーネントのレジストリ。
 *
 * 新しい動作 (Rigidbody / Trigger / プレイヤー操作 / スクリプトなど) は
 * ComponentDef を registerComponent() で登録するだけで、
 * Inspector の UI と Play Mode の実行の両方に自動的に反映される。
 */

/** text = 複数行の文章、sound = 効果音の選択 (組み込み / 音声アセット)、clips = アニメーションの編集 */
export type PropType = 'number' | 'vec3' | 'boolean' | 'select' | 'color' | 'string' | 'text' | 'sound' | 'clips';

export interface PropSchema {
  key: string;
  label: string;
  type: PropType;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; label: string }[];
  /** 補足説明 */
  hint?: string;
}

/** Play 中の操作入力 */
export interface GameInput {
  /** 移動 (-1〜1)。x: 右が正、y: 前が正 */
  readonly move: { readonly x: number; readonly y: number };
  readonly running: boolean;
  /** ジャンプボタンが押されたか (読むと消える) */
  consumeJump(): boolean;
  /** アクションボタン (攻撃・話す) が押されたか (読むと消える) */
  consumeAction(): boolean;
}

/** プレイヤー操作コンポーネントがランタイムに登録する操作口 */
export interface PlayerControllerHandle {
  /** 上へ跳ね返す (敵を踏んだときなど) */
  bounce(speed: number): void;
  /** 指定方向へ弾き飛ばす (ダメージを受けたとき) */
  knockback(dir: Vec3, strength: number): void;
  /** 復活地点へ移動する */
  respawn(pos: Vec3): void;
}

/** Play 中にコンポーネントから使えるランタイム機能 */
export interface RuntimeAPI {
  /** 経過時間 (秒) */
  readonly time: number;
  /** 物理演算 (物理を使うシーンのみ) */
  readonly physics: PhysicsWorld | null;
  /** スコア・お金・HP・持ち物・変数など */
  readonly state: GameState;
  readonly input: GameInput;
  /** 重力の強さ (m/s², 正の値) */
  readonly gravity: number;
  /** 操作中のプレイヤーのエンティティ ID */
  readonly playerId: string | null;
  findObjectByName(name: string): Object3D | null;
  getObject(entityId: string): Object3D | null;
  getEntity(entityId: string): EntityData | undefined;
  log(message: string): void;
  /** 効果音を鳴らす ('builtin:coin' または音声アセット ID) */
  playSound(source: string | null | undefined, volume?: number): void;
  /** 画面にお知らせを表示 */
  toast(message: string): void;
  /** 会話ウィンドウを表示し、閉じられるまで待つ (その間ゲームは止まる) */
  talk(name: string, pages: string[]): Promise<void>;
  /** 今のカメラの水平の向き (度)。0 = -Z 方向 */
  cameraYaw(): number;
  getCameraMode(): PlayCameraMode;
  /** ワールド座標 */
  worldPosition(entityId: string, out?: Vector3): Vector3;
  /** 2つのオブジェクトの見た目の箱が重なっているか (margin だけ広げて判定) */
  overlaps(a: string, b: string, margin?: number): boolean;
  /** 見た目の箱 (ワールド座標。1フレームの間キャッシュされる) */
  bounds(entityId: string): Box3;
  /** 足元が地面に着いているか (物理なしの場合は常に false) */
  isGrounded(entityId: string): boolean;
  isDestroyed(entityId: string): boolean;
  /** オブジェクトを消す (effect = 'pop' で縮んで消える) */
  destroyEntity(entityId: string, effect?: 'pop' | 'none'): void;
  /** HP を減らす。無敵時間中などで効かなかった場合は false */
  damage(target: string, amount: number, source?: string): boolean;
  heal(target: string, amount: number): boolean;
  getHealth(entityId: string): { hp: number; maxHp: number } | null;
  /** HP を持つ (倒せる) オブジェクトの一覧 */
  healthTargets(): Iterable<string>;
  /** 近くで「話す」などができることを知らせる (毎フレーム呼ぶ。一番近いものが選ばれる) */
  offerInteraction(entityId: string, label: string, distance: number, run: () => void): void;
  /** アクションボタンが押されたときに近くのものと関わる。関われたら true */
  interact(): boolean;
  registerPlayer(entityId: string, handle: PlayerControllerHandle): void;
  bouncePlayer(speed: number): void;
  knockbackPlayer(dir: Vec3, strength: number): void;
  /** 復活地点を記録 (persist = 端末に保存して「つづきから」で再開できる) */
  saveCheckpoint(pos: Vec3, persist: boolean): void;
  gameOver(message?: string): void;
  gameClear(message?: string): void;
  /** イベントを通知する (Phase 4 のイベントシステム用) */
  emit(event: string, entityId: string, data?: unknown): void;
  /** 画質 (パーティクルの数などを調整する) */
  readonly quality: QualityLevel;
  /** 描画領域の高さ (px)。パーティクルの大きさの計算用 */
  readonly viewportHeight: number;
  /** コンポーネントの操作口を登録する (イベントから「再生」などを呼ぶため) */
  registerController(entityId: string, kind: string, handle: unknown): void;
  getController<T>(entityId: string, kind: string): T | undefined;
  /** 使い捨てのエフェクト (爆発など) をその場所に出す */
  spawnEffect(preset: string, at: Vec3, scale?: number): void;
}

export interface ComponentContext {
  entity: EntityData;
  object: Object3D;
  runtime: RuntimeAPI;
}

export interface ComponentInstance {
  start?(): void;
  update?(dt: number, time: number): void;
  /** 物理的な接触 (trigger = すり抜け判定) の開始・終了 */
  onContact?(otherId: string, began: boolean, trigger: boolean): void;
  destroy?(): void;
}

export interface ComponentDef {
  type: string;
  label: string;
  icon: string;
  description: string;
  category: 'motion' | 'physics' | 'gameplay' | 'audio' | 'effect' | 'script';
  defaults(): Record<string, unknown>;
  schema: PropSchema[];
  /** 同じエンティティに複数付けられるか */
  allowMultiple?: boolean;
  create?(ctx: ComponentContext, props: Record<string, unknown>): ComponentInstance;
}

const registry = new Map<string, ComponentDef>();

export function registerComponent(def: ComponentDef): void {
  registry.set(def.type, def);
}

export function getComponentDef(type: string): ComponentDef | undefined {
  return registry.get(type);
}

export function listComponentDefs(): ComponentDef[] {
  return [...registry.values()];
}
