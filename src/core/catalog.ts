import type {
  CameraData,
  EntityData,
  EntityKind,
  EnvironmentData,
  LightData,
  LightType,
  MaterialData,
  MaterialPattern,
  MaterialPreset,
  MeshData,
  PhysicsSettings,
  PrimitiveShape,
  TransformData,
} from './types';
import { createId } from './util';

/**
 * 「追加」メニューに並ぶオブジェクトの種類カタログ。
 * UI (追加シート / Assets 画面) とエンティティ生成の両方がこの定義を参照する。
 */
export type CreateKind =
  | PrimitiveShape
  | 'camera'
  | 'light-directional'
  | 'light-point'
  | 'light-spot'
  | 'light-hemisphere'
  | 'light-ambient'
  | 'water'
  | 'empty';

export interface CatalogItem {
  kind: CreateKind;
  /** 表示名 (日本語) */
  label: string;
  /** 英語名 (Unity 等の経験者向けの補助表記) */
  english: string;
  /** 生成時のエンティティ名 */
  defaultName: string;
  icon: string;
  category: 'shape' | 'camera' | 'light' | 'other';
  description: string;
}

export const CATALOG: CatalogItem[] = [
  { kind: 'cube', label: 'キューブ', english: 'Cube', defaultName: 'キューブ', icon: 'cube', category: 'shape', description: '箱型。床・壁・ブロックなどに' },
  { kind: 'sphere', label: '球体', english: 'Sphere', defaultName: '球体', icon: 'sphere', category: 'shape', description: 'ボール・惑星など' },
  { kind: 'plane', label: '平面', english: 'Plane', defaultName: '平面', icon: 'plane', category: 'shape', description: '地面や床に' },
  { kind: 'cylinder', label: '円柱', english: 'Cylinder', defaultName: '円柱', icon: 'cylinder', category: 'shape', description: '柱・缶など' },
  { kind: 'cone', label: '円錐', english: 'Cone', defaultName: '円錐', icon: 'cone', category: 'shape', description: 'コーン・屋根など' },
  { kind: 'capsule', label: 'カプセル', english: 'Capsule', defaultName: 'カプセル', icon: 'capsule', category: 'shape', description: 'キャラクターの仮モデルに' },
  { kind: 'water', label: '水面', english: 'Water', defaultName: '水面', icon: 'wave', category: 'shape', description: '波打つ水。池や海に' },
  { kind: 'camera', label: 'カメラ', english: 'Camera', defaultName: 'カメラ', icon: 'camera', category: 'camera', description: 'Play 時の視点' },
  { kind: 'light-directional', label: '太陽光', english: 'Directional Light', defaultName: '太陽光', icon: 'sun', category: 'light', description: '一方向から照らす光。影を作れる' },
  { kind: 'light-point', label: 'ポイントライト', english: 'Point Light', defaultName: 'ポイントライト', icon: 'bulb', category: 'light', description: '電球のように周囲を照らす' },
  { kind: 'light-spot', label: 'スポットライト', english: 'Spot Light', defaultName: 'スポットライト', icon: 'spot', category: 'light', description: '円錐状に照らす' },
  { kind: 'light-hemisphere', label: '環境光 (空)', english: 'Hemisphere Light', defaultName: '環境光', icon: 'hemi', category: 'light', description: '空と地面の色で全体を照らす' },
  { kind: 'light-ambient', label: '環境光 (均一)', english: 'Ambient Light', defaultName: 'アンビエント', icon: 'ambient', category: 'light', description: '全体を均一に明るくする' },
  { kind: 'empty', label: '空オブジェクト', english: 'Empty', defaultName: '空オブジェクト', icon: 'empty', category: 'other', description: 'グループ化や目印に' },
];

export function catalogItem(kind: CreateKind): CatalogItem {
  const item = CATALOG.find((c) => c.kind === kind);
  if (!item) throw new Error(`未知のオブジェクト種類: ${kind}`);
  return item;
}

export const SHAPE_LABELS: Record<PrimitiveShape, string> = {
  cube: 'キューブ',
  sphere: '球体',
  plane: '平面',
  cylinder: '円柱',
  cone: '円錐',
  capsule: 'カプセル',
};

export const LIGHT_LABELS: Record<LightType, string> = {
  directional: '太陽光 (Directional)',
  point: 'ポイントライト (Point)',
  spot: 'スポットライト (Spot)',
  hemisphere: '環境光・空 (Hemisphere)',
  ambient: '環境光・均一 (Ambient)',
};

export const KIND_LABELS: Record<EntityKind, string> = {
  empty: '空オブジェクト',
  mesh: 'メッシュ',
  camera: 'カメラ',
  light: 'ライト',
};

/** エンティティの見た目に合うアイコン名 */
export function entityIcon(e: EntityData): string {
  switch (e.kind) {
    case 'mesh':
      return e.mesh?.shape ?? 'cube';
    case 'camera':
      return 'camera';
    case 'light':
      switch (e.light?.type) {
        case 'directional':
          return 'sun';
        case 'point':
          return 'bulb';
        case 'spot':
          return 'spot';
        case 'hemisphere':
          return 'hemi';
        default:
          return 'ambient';
      }
    default:
      return e.children.length > 0 ? 'group' : 'empty';
  }
}

/** エンティティの種類の表示名 */
export function entityTypeLabel(e: EntityData): string {
  if (e.kind === 'mesh' && e.mesh) return `${SHAPE_LABELS[e.mesh.shape]} (メッシュ)`;
  if (e.kind === 'light' && e.light) return LIGHT_LABELS[e.light.type];
  if (e.kind === 'empty' && e.children.length > 0) return 'グループ';
  return KIND_LABELS[e.kind];
}

// ------------------------------------------------------------
// 既定値
// ------------------------------------------------------------

export function defaultTransform(): TransformData {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
}

export function defaultMaterial(color = '#d9dde3'): MaterialData {
  return {
    preset: 'standard',
    color,
    roughness: 0.6,
    metalness: 0,
    opacity: 1,
    emissive: '#000000',
    emissiveIntensity: 1,
    wireframe: false,
    pattern: 'none',
    texture: null,
    uvScale: [1, 1],
    uvOffset: [0, 0],
    uvRotation: 0,
    envIntensity: 1,
  };
}

export interface MaterialPresetInfo {
  preset: MaterialPreset;
  label: string;
  description: string;
  /** 選んだときに設定する推奨値 */
  values: Partial<MaterialData>;
}

export const MATERIAL_PRESETS: MaterialPresetInfo[] = [
  { preset: 'standard', label: '標準', description: '一般的な質感', values: { roughness: 0.6, metalness: 0, opacity: 1, pattern: 'none' } },
  { preset: 'wood', label: '木材', description: '木目のある質感', values: { color: '#b07a45', roughness: 0.75, metalness: 0, opacity: 1, pattern: 'wood' } },
  { preset: 'metal', label: '金属', description: '周りを映すツヤのある金属', values: { color: '#c9ced6', roughness: 0.22, metalness: 1, opacity: 1, pattern: 'none', envIntensity: 1.2 } },
  { preset: 'glass', label: 'ガラス', description: '透き通ったガラス', values: { color: '#d8ecff', roughness: 0.04, metalness: 0, opacity: 0.3, pattern: 'none', envIntensity: 1.5 } },
  { preset: 'water', label: '水', description: '波打つ水面 (平面向け)', values: { color: '#2a7bb8', roughness: 0.08, metalness: 0, opacity: 0.82, pattern: 'none' } },
  { preset: 'unlit', label: 'アンリット', description: '光の影響を受けない (UI・発光表現向け)', values: { opacity: 1 } },
];

export const PATTERN_LABELS: Record<MaterialPattern, string> = {
  none: 'なし',
  wood: '木目',
  checker: '市松模様',
  brick: 'レンガ',
  stone: '石',
  tiles: 'タイル',
  grass: '草地',
};

export function defaultEnvironment(sky: 'color' | 'gradient' = 'gradient'): EnvironmentData {
  return {
    background: '#1f232b',
    sky: { type: sky, topColor: '#3d7fd6', horizonColor: '#c9dff2', bottomColor: '#5b6270', turbidity: 6 },
    fog: { enabled: false, color: '#c9dff2', near: 20, far: 120 },
    reflections: true,
    exposure: 1,
    weather: { type: 'none', intensity: 0.6 },
  };
}

export function defaultPhysics(): PhysicsSettings {
  return { enabled: true, gravity: [0, -9.81, 0] };
}

export function defaultMesh(shape: PrimitiveShape, color?: string): MeshData {
  return { shape, material: defaultMaterial(color), castShadow: true, receiveShadow: true };
}

export function defaultLight(type: LightType): LightData {
  const base: LightData = {
    type,
    color: '#ffffff',
    groundColor: '#3a3f47',
    intensity: 1,
    distance: 0,
    angle: 35,
    penumbra: 0.3,
    castShadow: false,
  };
  switch (type) {
    case 'directional':
      return { ...base, color: '#fff4e5', intensity: 2.2, castShadow: true };
    case 'point':
      return { ...base, intensity: 12, distance: 20 };
    case 'spot':
      return { ...base, intensity: 30, distance: 30 };
    case 'hemisphere':
      return { ...base, color: '#cfe6ff', groundColor: '#4a4238', intensity: 1.2 };
    case 'ambient':
      return { ...base, intensity: 0.4 };
  }
}

export function defaultCamera(): CameraData {
  return { fov: 60, near: 0.1, far: 1000, main: false };
}

/** 形状ごとの「地面に置いたときの」Y 座標 */
export function restingHeight(shape: PrimitiveShape): number {
  switch (shape) {
    case 'plane':
      return 0;
    case 'capsule':
      return 1;
    default:
      return 0.5;
  }
}

const SHAPE_COLORS: Partial<Record<PrimitiveShape, string>> = {
  cube: '#4c8dff',
  sphere: '#ff7a59',
  plane: '#8a9099',
  cylinder: '#3ecf8e',
  cone: '#ffc233',
  capsule: '#b18cff',
};

/**
 * カタログの種類から新しいエンティティデータを作る。
 * (親子関係・名前の重複調整は呼び出し側で行う)
 */
export function createEntity(kind: CreateKind, name?: string): EntityData {
  const item = catalogItem(kind);
  const base: EntityData = {
    id: createId('e'),
    name: name ?? item.defaultName,
    kind: 'empty',
    parent: null,
    children: [],
    visible: true,
    locked: false,
    transform: defaultTransform(),
    components: [],
    tags: [],
  };
  switch (kind) {
    case 'cube':
    case 'sphere':
    case 'plane':
    case 'cylinder':
    case 'cone':
    case 'capsule':
      base.kind = 'mesh';
      base.mesh = defaultMesh(kind, SHAPE_COLORS[kind]);
      base.transform.position[1] = restingHeight(kind);
      if (kind === 'plane') base.transform.scale = [4, 1, 4];
      return base;
    case 'water':
      base.kind = 'mesh';
      base.mesh = defaultMesh('plane', '#2a7bb8');
      Object.assign(base.mesh.material, MATERIAL_PRESETS.find((p) => p.preset === 'water')!.values, { preset: 'water' });
      base.mesh.castShadow = false;
      base.transform.position[1] = 0.1;
      base.transform.scale = [20, 1, 20];
      return base;
    case 'camera':
      base.kind = 'camera';
      base.camera = defaultCamera();
      base.transform.position = [0, 2, 6];
      base.transform.rotation = [-12, 0, 0];
      return base;
    case 'light-directional':
      base.kind = 'light';
      base.light = defaultLight('directional');
      base.transform.position = [4, 8, 4];
      base.transform.rotation = [-55, 40, 0];
      return base;
    case 'light-point':
      base.kind = 'light';
      base.light = defaultLight('point');
      base.transform.position = [0, 3, 0];
      return base;
    case 'light-spot':
      base.kind = 'light';
      base.light = defaultLight('spot');
      base.transform.position = [0, 5, 0];
      base.transform.rotation = [-90, 0, 0];
      return base;
    case 'light-hemisphere':
      base.kind = 'light';
      base.light = defaultLight('hemisphere');
      base.transform.position = [0, 6, 0];
      return base;
    case 'light-ambient':
      base.kind = 'light';
      base.light = defaultLight('ambient');
      base.transform.position = [0, 6, 0];
      return base;
    case 'empty':
      return base;
  }
}
