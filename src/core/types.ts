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
 * マテリアルの種類。Phase 1 は standard / unlit。
 * Phase 2 で wood / metal / glass などのプリセットを追加する想定。
 */
export type MaterialPreset = 'standard' | 'unlit';

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

export type EntityKind = 'empty' | 'mesh' | 'camera' | 'light';

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

export interface EnvironmentData {
  /** 背景色 '#rrggbb' */
  background: string;
  // Phase 2: sky / fog / weather / postprocess
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
}

/** Phase 5 でアセット管理を実装する際の予約領域 */
export interface AssetEntry {
  id: string;
  name: string;
  type: 'model' | 'image' | 'texture' | 'audio' | 'font' | 'animation';
  folder: string;
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
