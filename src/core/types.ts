/**
 * Pocket Engine のデータモデル定義。
 *
 * すべての編集データはここで定義した「プレーンな JSON オブジェクト」で表現する。
 * Three.js のオブジェクトはこのデータから生成される「表示用の写像」にすぎないため、
 * 保存・Undo/Redo・Play Mode のスナップショットはすべてこのデータを複製するだけで実現できる。
 */

export type Vec3 = [number, number, number];

/** 位置・回転・拡大縮小。回転は度数法 (XYZ 順のオイラー角) で保持する。 */
export interface TransformData {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

/** 基本図形の種類 */
export type PrimitiveShape = 'cube' | 'sphere' | 'plane' | 'cylinder' | 'cone' | 'capsule';

/**
 * マテリアルの種類。見た目の作り方 (シェーダー) が変わる。
 * 選ぶと色・粗さなどの推奨値が設定され、その後自由に調整できる。
 */
export type MaterialPreset = 'standard' | 'unlit' | 'wood' | 'metal' | 'glass' | 'water';

/** 手続き的に生成する模様テクスチャ (画像ファイル不要) */
export type MaterialPattern = 'none' | 'wood' | 'checker' | 'brick' | 'stone' | 'tiles' | 'grass';

export interface MaterialData {
  preset: MaterialPreset;
  /** '#rrggbb' 形式 */
  color: string;
  roughness: number;
  metalness: number;
  opacity: number;
  emissive: string;
  emissiveIntensity: number;
  wireframe: boolean;
  /** 模様 (画像テクスチャが無い場合に使用) */
  pattern: MaterialPattern;
  /** 画像テクスチャのアセット ID */
  texture: string | null;
  /** テクスチャの繰り返し回数 (U, V) */
  uvScale: [number, number];
  /** テクスチャのずれ (U, V) */
  uvOffset: [number, number];
  /** テクスチャの回転 (度) */
  uvRotation: number;
  /** 周囲の映り込みの強さ */
  envIntensity: number;
}

export interface MeshData {
  shape: PrimitiveShape;
  material: MaterialData;
  castShadow: boolean;
  receiveShadow: boolean;
}

export type LightType = 'directional' | 'point' | 'spot' | 'hemisphere' | 'ambient';

export interface LightData {
  type: LightType;
  color: string;
  /** hemisphere ライトの地面側の色 */
  groundColor: string;
  intensity: number;
  /** point / spot の到達距離 (0 = 無限) */
  distance: number;
  /** spot の照射角 (度) */
  angle: number;
  /** spot の縁のぼかし (0〜1) */
  penumbra: number;
  castShadow: boolean;
}

export interface CameraData {
  fov: number;
  near: number;
  far: number;
  /** Play 時に使用するメインカメラかどうか */
  main: boolean;
}

/**
 * ゲームロジック用コンポーネント (自動回転・往復運動など)。
 * 種類ごとの定義は components/registry.ts に登録する。
 * Phase 2 以降の Rigidbody / Collider / Trigger / Script もこの形式で追加する。
 */
export interface ComponentData {
  id: string;
  type: string;
  enabled: boolean;
  props: Record<string, unknown>;
}

export type EntityKind = 'empty' | 'mesh' | 'camera' | 'light' | 'ui';

export type UIType = 'text' | 'button' | 'image' | 'bar';
export type UIAnchor = 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right';

/** ボタンを押したときの組み込み動作 (Phase 4 のイベントでも「ボタンが押された」を使える) */
export type UIButtonAction = 'none' | 'jump' | 'action' | 'pause' | 'restart' | 'title';

/**
 * ゲーム画面に重ねて表示する UI (文字・ボタン・画像・ゲージ)。
 * 文字には {score} {money} {hp} {maxHp} {time} {timer} {var:名前} {item:名前} を埋め込める。
 */
export interface UIElementData {
  type: UIType;
  anchor: UIAnchor;
  /** アンカーからのずれ (px) */
  x: number;
  y: number;
  /** 幅・高さ (px)。0 は自動 */
  width: number;
  height: number;
  text: string;
  fontSize: number;
  color: string;
  background: string;
  backgroundOpacity: number;
  /** 画像のアセット ID */
  image: string | null;
  /** ゲージの値: 'hp' または 'var:変数名' */
  barValue: string;
  /** ゲージの最大値 (0 = 最大 HP) */
  barMax: number;
  /** ボタンの動作 */
  action: UIButtonAction;
  /** 角の丸み (px) */
  radius: number;
}

export interface EntityData {
  id: string;
  name: string;
  kind: EntityKind;
  /** 親エンティティの ID。ルートの場合は null */
  parent: string | null;
  /** 子エンティティの ID (表示順) */
  children: string[];
  visible: boolean;
  locked: boolean;
  transform: TransformData;
  mesh?: MeshData;
  light?: LightData;
  camera?: CameraData;
  ui?: UIElementData;
  components: ComponentData[];
  tags: string[];
}

/** 編集用カメラ (オービットカメラ) の状態 */
export interface CameraStateData {
  target: Vec3;
  /** 水平方向の角度 (度) */
  yaw: number;
  /** 見下ろし角 (度) */
  pitch: number;
  distance: number;
}

export interface CameraBookmark {
  id: string;
  name: string;
  state: CameraStateData;
}

export type SkyType = 'color' | 'gradient' | 'physical';

export interface SkyData {
  type: SkyType;
  topColor: string;
  horizonColor: string;
  bottomColor: string;
  /** 物理的な空の大気の濁り (2〜20) */
  turbidity: number;
}

export interface FogData {
  enabled: boolean;
  color: string;
  /** 霧が始まる距離 */
  near: number;
  /** 完全に霧になる距離 */
  far: number;
}

export type WeatherType = 'none' | 'rain' | 'snow';

export interface WeatherData {
  type: WeatherType;
  /** 強さ 0〜1 */
  intensity: number;
}

export interface EnvironmentData {
  /** 背景色 '#rrggbb' (空の種類が「単色」のとき) */
  background: string;
  sky: SkyData;
  fog: FogData;
  /** 空を映り込み (反射) に使う */
  reflections: boolean;
  /** 全体の明るさ (露出) */
  exposure: number;
  weather: WeatherData;
}

export interface PhysicsSettings {
  enabled: boolean;
  gravity: Vec3;
  /** プレイヤーがいるシーンでは、当たり判定の無いメッシュも固体として扱う */
  autoColliders: boolean;
}

/** シーンの BGM。source は 'builtin:名前' またはアセット ID */
export interface MusicData {
  source: string | null;
  volume: number;
}

/** ゲーム全体の設定 (タイトル画面・制限時間・終了画面など) */
export interface GameSettings {
  title: string;
  subtitle: string;
  /** タイトル画面の背景色 */
  titleBackground: string;
  /** タイトル画面の背景画像 (アセット ID) */
  titleImage: string | null;
  /** ゲームアイコン (アセット ID, Phase 10 の書き出しで使用) */
  icon: string | null;
  /** 制限時間 (秒, 0 = なし) */
  timeLimit: number;
  timeUpResult: 'gameover' | 'clear';
  /** 標準の HUD (HP・スコア・お金・タイマー) を表示する */
  showHud: boolean;
  clearMessage: string;
  gameOverMessage: string;
}

export interface SceneData {
  id: string;
  name: string;
  roots: string[];
  entities: Record<string, EntityData>;
  environment: EnvironmentData;
  /** 最後に使っていた編集カメラ位置 */
  editorCamera: CameraStateData | null;
  /** 保存したカメラ位置 */
  bookmarks: CameraBookmark[];
  /** 三人称カメラで追従・操作するエンティティ */
  playerId: string | null;
  physics: PhysicsSettings;
  music: MusicData;
}

export type AssetType = 'image' | 'audio' | 'model' | 'font';

/**
 * アセットのメタ情報。ファイル本体 (Blob) は IndexedDB の assets ストアに保存し、
 * 書き出し時はプロジェクトファイルに埋め込む。
 */
export interface AssetEntry {
  id: string;
  name: string;
  type: AssetType;
  /** フォルダのパス ('' はルート。例: 'キャラクター/敵') */
  folder: string;
  mime: string;
  size: number;
  createdAt: number;
}

/** Phase 5 で Prefab を実装する際の予約領域 */
export interface PrefabEntry {
  id: string;
  name: string;
  root: string;
  entities: Record<string, EntityData>;
}

export const PROJECT_FORMAT = 'pocket-engine-project';
export const SCENE_FORMAT = 'pocket-engine-scene';
export const PROJECT_VERSION = 1;

export interface ProjectData {
  format: typeof PROJECT_FORMAT;
  version: number;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  scenes: SceneData[];
  activeSceneId: string;
  /** 書き出したゲームで最初に開くシーン */
  startSceneId: string;
  assets: AssetEntry[];
  prefabs: PrefabEntry[];
  game: GameSettings;
}

/** プロジェクト一覧用の軽量メタ情報 */
export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  sceneCount: number;
  entityCount: number;
  thumbnail: string | null;
}

/** 単体シーンの書き出し形式 */
export interface SceneFile {
  format: typeof SCENE_FORMAT;
  version: number;
  scene: SceneData;
}
