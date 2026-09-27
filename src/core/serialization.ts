import {
  defaultModel,
  defaultCamera,
  defaultClouds,
  defaultEnvironment,
  defaultPostEffects,
  defaultTimeOfDay,
  defaultGameSettings,
  defaultLight,
  defaultMaterial,
  defaultMesh,
  defaultMusic,
  defaultPhysics,
  defaultTransform,
  defaultUI,
} from './catalog';
import type {
  AssetEntry,
  AssetInfo,
  PrefabEntry,
  AssetType,
  CameraStateData,
  ComponentData,
  EntityData,
  EntityKind,
  CloudData,
  EnvironmentData,
  PostEffectsData,
  TimeOfDayData,
  GameSettings,
  LightType,
  MusicData,
  MaterialPattern,
  MaterialPreset,
  PrimitiveShape,
  ProjectData,
  SceneData,
  SceneFile,
  SkyType,
  UIAnchor,
  UIButtonAction,
  UIElementData,
  UIType,
  Vec3,
  WeatherType,
} from './types';
import { PROJECT_FORMAT, PROJECT_VERSION, SCENE_FORMAT } from './types';
import { sanitizeRules, sanitizeVariables } from './events';
import { sanitizeTerrain } from './terrain';
import { clone, createId, normalizeHex } from './util';

/**
 * 保存データの検証・修復・移行。
 * 外部から読み込んだ JSON や古いバージョンの保存データを、
 * 現在のデータモデルとして安全に扱える形に整える。
 */

export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFormatError';
  }
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const color = (v: unknown, d: string): string => (typeof v === 'string' ? (normalizeHex(v) ?? d) : d);
const vec3 = (v: unknown, d: Vec3): Vec3 =>
  Array.isArray(v) && v.length === 3 ? [num(v[0], d[0]), num(v[1], d[1]), num(v[2], d[2])] : [...d];

const vec2 = (v: unknown, d: [number, number]): [number, number] =>
  Array.isArray(v) && v.length === 2 ? [num(v[0], d[0]), num(v[1], d[1])] : [d[0], d[1]];
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

const SHAPES: PrimitiveShape[] = ['cube', 'sphere', 'plane', 'cylinder', 'cone', 'capsule'];
const PRESETS: MaterialPreset[] = ['standard', 'unlit', 'wood', 'metal', 'glass', 'water'];
const PATTERNS: MaterialPattern[] = ['none', 'wood', 'checker', 'brick', 'stone', 'tiles', 'grass'];
const SKIES: SkyType[] = ['color', 'gradient', 'physical'];
const WEATHERS: WeatherType[] = ['none', 'rain', 'snow'];
const ASSET_TYPES: AssetType[] = ['image', 'audio', 'model', 'font'];
const LIGHTS: LightType[] = ['directional', 'point', 'spot', 'hemisphere', 'ambient'];
const KINDS: EntityKind[] = ['empty', 'mesh', 'camera', 'light', 'ui', 'model', 'terrain'];
const UI_TYPES: UIType[] = ['text', 'button', 'image', 'bar'];
const UI_ACTIONS: UIButtonAction[] = ['none', 'jump', 'action', 'pause', 'restart', 'title'];
const UI_ANCHORS: UIAnchor[] = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];

function sanitizeUI(raw: unknown): UIElementData {
  const u = isObj(raw) ? raw : {};
  const type = oneOf(u.type, UI_TYPES, 'text');
  const d = defaultUI(type);
  return {
    type,
    anchor: oneOf(u.anchor, UI_ANCHORS, d.anchor),
    x: num(u.x, d.x),
    y: num(u.y, d.y),
    width: Math.max(0, num(u.width, d.width)),
    height: Math.max(0, num(u.height, d.height)),
    text: str(u.text, d.text).slice(0, 500),
    fontSize: Math.max(4, Math.min(200, num(u.fontSize, d.fontSize))),
    color: color(u.color, d.color),
    background: color(u.background, d.background),
    backgroundOpacity: Math.max(0, Math.min(1, num(u.backgroundOpacity, d.backgroundOpacity))),
    image: typeof u.image === 'string' ? u.image : null,
    barValue: str(u.barValue, d.barValue),
    barMax: Math.max(0, num(u.barMax, d.barMax)),
    action: oneOf(u.action, UI_ACTIONS, d.action),
    font: typeof u.font === 'string' && u.font ? u.font : null,
    radius: Math.max(0, num(u.radius, d.radius)),
  };
}

function sanitizeMusic(raw: unknown): MusicData {
  const m = isObj(raw) ? raw : {};
  const d = defaultMusic();
  return { source: typeof m.source === 'string' && m.source ? m.source : null, volume: Math.max(0, Math.min(1, num(m.volume, d.volume))) };
}

function sanitizeGame(raw: unknown, name: string): GameSettings {
  const g = isObj(raw) ? raw : {};
  const d = defaultGameSettings(name);
  return {
    title: str(g.title, d.title).slice(0, 100),
    subtitle: str(g.subtitle, d.subtitle).slice(0, 200),
    titleBackground: color(g.titleBackground, d.titleBackground),
    titleImage: typeof g.titleImage === 'string' ? g.titleImage : null,
    icon: typeof g.icon === 'string' ? g.icon : null,
    timeLimit: Math.max(0, num(g.timeLimit, d.timeLimit)),
    timeUpResult: g.timeUpResult === 'clear' ? 'clear' : 'gameover',
    showHud: bool(g.showHud, d.showHud),
    clearMessage: str(g.clearMessage, d.clearMessage).slice(0, 200),
    gameOverMessage: str(g.gameOverMessage, d.gameOverMessage).slice(0, 200),
  };
}

function sanitizeEntity(raw: Obj, id: string): EntityData {
  const kind = KINDS.includes(raw.kind as EntityKind) ? (raw.kind as EntityKind) : 'empty';
  const t = isObj(raw.transform) ? raw.transform : {};
  const dt = defaultTransform();
  const e: EntityData = {
    id,
    name: str(raw.name, 'オブジェクト').slice(0, 100),
    kind,
    parent: typeof raw.parent === 'string' ? raw.parent : null,
    children: Array.isArray(raw.children) ? raw.children.filter((c): c is string => typeof c === 'string') : [],
    visible: bool(raw.visible, true),
    locked: bool(raw.locked, false),
    transform: {
      position: vec3(t.position, dt.position),
      rotation: vec3(t.rotation, dt.rotation),
      scale: vec3(t.scale, dt.scale),
    },
    components: [],
    tags: Array.isArray(raw.tags) ? raw.tags.filter((x): x is string => typeof x === 'string') : [],
  };
  if (typeof raw.prefab === 'string' && raw.prefab) e.prefab = raw.prefab;

  if (kind === 'mesh') {
    const m = isObj(raw.mesh) ? raw.mesh : {};
    const shape = SHAPES.includes(m.shape as PrimitiveShape) ? (m.shape as PrimitiveShape) : 'cube';
    const dm = defaultMesh(shape);
    const mat = isObj(m.material) ? m.material : {};
    const d = defaultMaterial();
    e.mesh = {
      shape,
      castShadow: bool(m.castShadow, dm.castShadow),
      receiveShadow: bool(m.receiveShadow, dm.receiveShadow),
      material: {
        preset: oneOf(mat.preset, PRESETS, 'standard'),
        color: color(mat.color, d.color),
        roughness: num(mat.roughness, d.roughness),
        metalness: num(mat.metalness, d.metalness),
        opacity: num(mat.opacity, d.opacity),
        emissive: color(mat.emissive, d.emissive),
        emissiveIntensity: num(mat.emissiveIntensity, d.emissiveIntensity),
        wireframe: bool(mat.wireframe, d.wireframe),
        pattern: oneOf(mat.pattern, PATTERNS, 'none'),
        texture: typeof mat.texture === 'string' ? mat.texture : null,
        uvScale: vec2(mat.uvScale, d.uvScale),
        uvOffset: vec2(mat.uvOffset, d.uvOffset),
        uvRotation: num(mat.uvRotation, d.uvRotation),
        envIntensity: num(mat.envIntensity, d.envIntensity),
      },
    };
  } else if (kind === 'light') {
    const l = isObj(raw.light) ? raw.light : {};
    const type = LIGHTS.includes(l.type as LightType) ? (l.type as LightType) : 'point';
    const d = defaultLight(type);
    e.light = {
      type,
      color: color(l.color, d.color),
      groundColor: color(l.groundColor, d.groundColor),
      intensity: num(l.intensity, d.intensity),
      distance: num(l.distance, d.distance),
      angle: num(l.angle, d.angle),
      penumbra: num(l.penumbra, d.penumbra),
      castShadow: bool(l.castShadow, d.castShadow),
    };
  } else if (kind === 'ui') {
    e.ui = sanitizeUI(raw.ui);
  } else if (kind === 'model') {
    const m = isObj(raw.model) ? raw.model : {};
    const d = defaultModel();
    e.model = {
      asset: typeof m.asset === 'string' && m.asset ? m.asset : null,
      size: vec3(m.size, d.size).map((v) => Math.max(0.001, Math.abs(v))) as Vec3,
      center: vec3(m.center, d.center),
      castShadow: bool(m.castShadow, d.castShadow),
      receiveShadow: bool(m.receiveShadow, d.receiveShadow),
      animation: str(m.animation, '').slice(0, 100),
    };
  } else if (kind === 'terrain') {
    e.terrain = sanitizeTerrain(raw.terrain);
  } else if (kind === 'camera') {
    const c = isObj(raw.camera) ? raw.camera : {};
    const d = defaultCamera();
    e.camera = {
      fov: num(c.fov, d.fov),
      near: num(c.near, d.near),
      far: num(c.far, d.far),
      main: bool(c.main, d.main),
    };
  }

  if (Array.isArray(raw.components)) {
    for (const c of raw.components) {
      if (!isObj(c) || typeof c.type !== 'string') continue;
      const comp: ComponentData = {
        id: str(c.id, createId('c')),
        type: c.type,
        enabled: bool(c.enabled, true),
        props: isObj(c.props) ? clone(c.props) : {},
      };
      e.components.push(comp);
    }
  }
  return e;
}

/** 親子関係の整合性を修復する (壊れた参照・循環・孤立ノード) */
function repairHierarchy(scene: SceneData): void {
  const ents = scene.entities;
  const seen = new Set<string>();
  const newRoots: string[] = [];

  const visit = (id: string, parent: string | null): boolean => {
    const e = ents[id];
    if (!e || seen.has(id)) return false;
    seen.add(id);
    e.parent = parent;
    e.children = e.children.filter((c) => visit(c, id));
    return true;
  };
  for (const id of scene.roots) if (visit(id, null)) newRoots.push(id);
  // どこからも参照されていないエンティティはルートに救出する
  for (const id of Object.keys(ents)) {
    if (!seen.has(id) && visit(id, null)) newRoots.push(id);
  }
  scene.roots = newRoots;
}

function sanitizeCameraState(v: unknown): CameraStateData | null {
  if (!isObj(v)) return null;
  return {
    target: vec3(v.target, [0, 0, 0]),
    yaw: num(v.yaw, 35),
    pitch: num(v.pitch, 28),
    distance: Math.max(0.1, num(v.distance, 12)),
  };
}

function sanitizeEnvironment(env: Obj): EnvironmentData {
  // 空の設定が無い古いデータ (Phase 1) は見た目を変えないよう「単色」にする
  const d = defaultEnvironment(isObj(env.sky) ? 'gradient' : 'color');
  const sky = isObj(env.sky) ? env.sky : {};
  const fog = isObj(env.fog) ? env.fog : {};
  const weather = isObj(env.weather) ? env.weather : {};
  return {
    background: color(env.background, d.background),
    sky: {
      type: oneOf(sky.type, SKIES, d.sky.type),
      topColor: color(sky.topColor, d.sky.topColor),
      horizonColor: color(sky.horizonColor, d.sky.horizonColor),
      bottomColor: color(sky.bottomColor, d.sky.bottomColor),
      turbidity: num(sky.turbidity, d.sky.turbidity),
    },
    fog: {
      enabled: bool(fog.enabled, d.fog.enabled),
      color: color(fog.color, d.fog.color),
      near: num(fog.near, d.fog.near),
      far: num(fog.far, d.fog.far),
    },
    reflections: bool(env.reflections, d.reflections),
    exposure: num(env.exposure, d.exposure),
    weather: {
      type: oneOf(weather.type, WEATHERS, d.weather.type),
      intensity: num(weather.intensity, d.weather.intensity),
      lightning: bool(weather.lightning, false),
    },
    time: sanitizeTime(env.time),
    clouds: sanitizeClouds(env.clouds),
    post: sanitizePost(env.post),
  };
}

const clampNum = (v: unknown, d: number, min: number, max: number) => Math.max(min, Math.min(max, num(v, d)));

function sanitizeTime(raw: unknown): TimeOfDayData {
  const d = defaultTimeOfDay();
  const t = isObj(raw) ? raw : {};
  return {
    enabled: bool(t.enabled, d.enabled),
    hour: ((num(t.hour, d.hour) % 24) + 24) % 24,
    cycle: bool(t.cycle, d.cycle),
    dayMinutes: clampNum(t.dayMinutes, d.dayMinutes, 0.1, 1440),
    sunDirection: num(t.sunDirection, d.sunDirection),
    stars: bool(t.stars, d.stars),
    moon: bool(t.moon, d.moon),
  };
}

function sanitizeClouds(raw: unknown): CloudData {
  const d = defaultClouds();
  const c = isObj(raw) ? raw : {};
  return {
    enabled: bool(c.enabled, d.enabled),
    amount: clampNum(c.amount, d.amount, 0, 1),
    speed: clampNum(c.speed, d.speed, 0, 100),
    height: clampNum(c.height, d.height, 5, 2000),
    color: color(c.color, d.color),
  };
}

function sanitizePost(raw: unknown): PostEffectsData {
  const d = defaultPostEffects();
  const p = isObj(raw) ? raw : {};
  const b = isObj(p.bloom) ? p.bloom : {};
  const f = isObj(p.dof) ? p.dof : {};
  return {
    bloom: {
      enabled: bool(b.enabled, d.bloom.enabled),
      strength: clampNum(b.strength, d.bloom.strength, 0, 3),
      threshold: clampNum(b.threshold, d.bloom.threshold, 0, 1),
      radius: clampNum(b.radius, d.bloom.radius, 0, 1),
    },
    dof: {
      enabled: bool(f.enabled, d.dof.enabled),
      focus: clampNum(f.focus, d.dof.focus, 0.1, 1000),
      blur: clampNum(f.blur, d.dof.blur, 0, 1),
      autoFocus: bool(f.autoFocus, d.dof.autoFocus),
    },
    vignette: clampNum(p.vignette, d.vignette, 0, 1),
    saturation: clampNum(p.saturation, d.saturation, -1, 1),
    contrast: clampNum(p.contrast, d.contrast, -1, 1),
    warmth: clampNum(p.warmth, d.warmth, -1, 1),
  };
}

function sanitizeAssets(raw: unknown): AssetEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: AssetEntry[] = [];
  const ids = new Set<string>();
  for (const a of raw) {
    if (!isObj(a) || typeof a.id !== 'string' || ids.has(a.id)) continue;
    const type = oneOf(a.type, ASSET_TYPES, 'image');
    ids.add(a.id);
    out.push({
      id: a.id,
      name: str(a.name, 'アセット').slice(0, 120),
      type,
      folder: str(a.folder, ''),
      mime: str(a.mime, ''),
      size: num(a.size, 0),
      createdAt: num(a.createdAt, Date.now()),
      ...(typeof a.thumb === 'string' && a.thumb.startsWith('data:image/') && a.thumb.length < 200_000 ? { thumb: a.thumb } : {}),
      ...(isObj(a.info) ? { info: sanitizeAssetInfo(a.info) } : {}),
    });
  }
  return out;
}

function sanitizeAssetInfo(i: Obj): AssetInfo {
  const out: AssetInfo = {};
  if (typeof i.width === 'number') out.width = num(i.width, 0);
  if (typeof i.height === 'number') out.height = num(i.height, 0);
  if (typeof i.duration === 'number') out.duration = num(i.duration, 0);
  if (Array.isArray(i.modelSize)) out.modelSize = vec3(i.modelSize, [1, 1, 1]);
  if (Array.isArray(i.modelCenter)) out.modelCenter = vec3(i.modelCenter, [0, 0, 0]);
  if (Array.isArray(i.animations)) out.animations = i.animations.filter((x): x is string => typeof x === 'string').slice(0, 100);
  if (typeof i.triangles === 'number') out.triangles = num(i.triangles, 0);
  return out;
}

function sanitizePrefabs(raw: unknown): PrefabEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PrefabEntry[] = [];
  const ids = new Set<string>();
  for (const p of raw) {
    if (!isObj(p) || typeof p.id !== 'string' || ids.has(p.id) || !isObj(p.entities)) continue;
    const entities: Record<string, EntityData> = {};
    for (const [id, e] of Object.entries(p.entities)) if (isObj(e)) entities[id] = sanitizeEntity(e, id);
    const root = typeof p.root === 'string' && entities[p.root] ? p.root : Object.keys(entities)[0];
    if (!root) continue;
    // 参照の壊れた子を取り除く
    for (const e of Object.values(entities)) e.children = e.children.filter((c) => entities[c]);
    entities[root].parent = null;
    ids.add(p.id);
    out.push({
      id: p.id,
      name: str(p.name, '部品').slice(0, 100),
      root,
      entities,
      folder: str(p.folder, ''),
      createdAt: num(p.createdAt, Date.now()),
      ...(typeof p.thumb === 'string' && p.thumb.startsWith('data:image/') && p.thumb.length < 200_000 ? { thumb: p.thumb } : {}),
    });
  }
  return out;
}

export function sanitizeScene(raw: unknown): SceneData {
  if (!isObj(raw)) throw new ProjectFormatError('シーンデータの形式が正しくありません');
  const entitiesRaw = isObj(raw.entities) ? raw.entities : {};
  const entities: Record<string, EntityData> = {};
  for (const [id, e] of Object.entries(entitiesRaw)) {
    if (isObj(e)) entities[id] = sanitizeEntity(e, id);
  }
  const env = isObj(raw.environment) ? raw.environment : {};
  const phys = isObj(raw.physics) ? raw.physics : {};
  const dphys = defaultPhysics();
  const scene: SceneData = {
    id: str(raw.id, createId('s')),
    name: str(raw.name, 'シーン').slice(0, 100),
    roots: Array.isArray(raw.roots) ? raw.roots.filter((r): r is string => typeof r === 'string') : [],
    entities,
    environment: sanitizeEnvironment(env),
    editorCamera: sanitizeCameraState(raw.editorCamera),
    bookmarks: Array.isArray(raw.bookmarks)
      ? raw.bookmarks.flatMap((b) => {
          if (!isObj(b)) return [];
          const state = sanitizeCameraState(b.state);
          return state ? [{ id: str(b.id, createId('b')), name: str(b.name, 'ビュー'), state }] : [];
        })
      : [],
    playerId: typeof raw.playerId === 'string' ? raw.playerId : null,
    physics: {
      enabled: bool(phys.enabled, dphys.enabled),
      gravity: vec3(phys.gravity, dphys.gravity),
      autoColliders: bool(phys.autoColliders, dphys.autoColliders),
    },
    music: sanitizeMusic(raw.music),
    events: sanitizeRules(raw.events),
  };
  repairHierarchy(scene);
  if (scene.playerId && !scene.entities[scene.playerId]) scene.playerId = null;
  return scene;
}

/** 旧バージョンの保存データを現在の形式へ移行する (将来のスキーマ変更用) */
function migrate(raw: Obj): Obj {
  const version = num(raw.version, 1);
  if (version > PROJECT_VERSION) {
    throw new ProjectFormatError('新しいバージョンの Pocket Engine で作られたデータのため読み込めません');
  }
  // version 1 が最初の形式のため、現在は移行処理なし
  return raw;
}

export function sanitizeProject(input: unknown): ProjectData {
  if (!isObj(input)) throw new ProjectFormatError('プロジェクトファイルの形式が正しくありません');
  if (input.format !== PROJECT_FORMAT) {
    throw new ProjectFormatError('Pocket Engine のプロジェクトファイルではありません');
  }
  const raw = migrate(input);
  const scenesRaw = Array.isArray(raw.scenes) ? raw.scenes : [];
  const scenes = scenesRaw.map(sanitizeScene);
  if (scenes.length === 0) throw new ProjectFormatError('シーンが1つも含まれていません');
  // シーン ID の重複を修正
  const ids = new Set<string>();
  for (const s of scenes) {
    if (ids.has(s.id)) s.id = createId('s');
    ids.add(s.id);
  }
  const pickScene = (v: unknown) => (typeof v === 'string' && ids.has(v) ? v : scenes[0].id);
  const now = Date.now();
  const name = str(raw.name, '無題のゲーム').slice(0, 100);
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    id: str(raw.id, createId('p')),
    name,
    createdAt: num(raw.createdAt, now),
    updatedAt: num(raw.updatedAt, now),
    scenes,
    activeSceneId: pickScene(raw.activeSceneId),
    startSceneId: pickScene(raw.startSceneId),
    assets: sanitizeAssets(raw.assets),
    prefabs: sanitizePrefabs(raw.prefabs),
    assetFolders: Array.isArray(raw.assetFolders) ? [...new Set(raw.assetFolders.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map((f) => f.slice(0, 200)))] : [],
    game: sanitizeGame(raw.game, name),
    variables: sanitizeVariables(raw.variables),
  };
}

export function parseProjectJson(text: string): ProjectData {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProjectFormatError('JSON として読み込めませんでした');
  }
  return sanitizeProject(data);
}

export function sceneToFile(scene: SceneData): SceneFile {
  return { format: SCENE_FORMAT, version: PROJECT_VERSION, scene: clone(scene) };
}

export function parseSceneJson(text: string): SceneData {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProjectFormatError('JSON として読み込めませんでした');
  }
  if (!isObj(data) || data.format !== SCENE_FORMAT) {
    throw new ProjectFormatError('Pocket Engine のシーンファイルではありません');
  }
  return sanitizeScene(data.scene);
}
