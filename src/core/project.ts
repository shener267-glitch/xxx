import { createEntity, defaultEnvironment, defaultGameSettings, defaultMusic, defaultPhysics } from './catalog';
import type { EntityData, ProjectData, SceneData } from './types';
import { PROJECT_FORMAT, PROJECT_VERSION } from './types';
import { createId } from './util';

/** 空のシーン (ライトとカメラと地面だけ) を作る */
export function createEmptyScene(name: string, withStarterContent = true): SceneData {
  const scene: SceneData = {
    id: createId('s'),
    name,
    roots: [],
    entities: {},
    environment: defaultEnvironment('gradient'),
    editorCamera: { target: [0, 0.5, 0], yaw: 35, pitch: 28, distance: 13 },
    bookmarks: [],
    playerId: null,
    physics: defaultPhysics(),
    music: defaultMusic(),
    events: [],
    timelines: [],
  };
  if (!withStarterContent) return scene;

  const ground = createEntity('plane', '地面');
  ground.transform.scale = [20, 1, 20];
  ground.mesh!.material.color = '#5b6270';
  ground.mesh!.castShadow = false;
  // 地面をうっかり選択・移動しないよう最初からロックしておく
  ground.locked = true;

  const sun = createEntity('light-directional', '太陽光');
  const hemi = createEntity('light-hemisphere', '環境光');

  const camera = createEntity('camera', 'メインカメラ');
  camera.camera!.main = true;
  camera.transform.position = [0, 3.5, 9];
  camera.transform.rotation = [-15, 0, 0];

  for (const e of [ground, sun, hemi, camera]) addRoot(scene, e);
  return scene;
}

/** 新規プロジェクトの初期実験室。Phase 1では既存のプリミティブと環境機能を流用する。 */
export function createSampleScene(name = 'HEMO 実験室'): SceneData {
  const scene = createEmptyScene(name, false);
  scene.environment.sky.type = 'gradient';
  scene.environment.sky.topColor = '#071b2a';
  scene.environment.sky.horizonColor = '#163c4a';
  scene.environment.sky.bottomColor = '#050b12';
  scene.environment.fog.enabled = true;
  scene.environment.fog.color = '#0b1d26';
  scene.environment.fog.near = 18;
  scene.environment.fog.far = 42;
  scene.editorCamera = { target: [0, 1.1, -1.5], yaw: 0, pitch: 18, distance: 11 };

  const floor = createEntity('plane', '実験室フロア');
  floor.transform.scale = [18, 1, 18];
  floor.mesh!.material.color = '#17272d';
  floor.mesh!.material.pattern = 'tiles';
  floor.mesh!.castShadow = false;
  floor.locked = true;

  const backWall = createEntity('cube', '実験室・背面壁');
  backWall.transform.position = [0, 3, -7];
  backWall.transform.scale = [14, 6, 0.25];
  backWall.mesh!.material.color = '#1b333b';
  backWall.locked = true;

  const leftWall = createEntity('cube', '実験室・左壁');
  leftWall.transform.position = [-7, 3, 0];
  leftWall.transform.scale = [0.25, 6, 14];
  leftWall.mesh!.material.color = '#14272f';
  leftWall.locked = true;

  const rightWall = createEntity('cube', '実験室・右壁');
  rightWall.transform.position = [7, 3, 0];
  rightWall.transform.scale = [0.25, 6, 14];
  rightWall.mesh!.material.color = '#14272f';
  rightWall.locked = true;

  const platform = createEntity('cylinder', '観察プラットフォーム');
  platform.transform.position = [0, 0.12, -1.5];
  platform.transform.scale = [3.2, 0.24, 3.2];
  platform.mesh!.material.color = '#24515a';
  platform.locked = true;

  const specimen = createEntity('capsule', '実験対象・仮モデル');
  specimen.transform.position = [0, 1.15, -1.5];
  specimen.transform.scale = [0.9, 2.2, 0.9];
  specimen.mesh!.material.color = '#d58f83';

  const workLight = createEntity('light-point', '検査ライト');
  workLight.transform.position = [0, 4.5, -1.5];
  workLight.light!.color = '#83e6dc';
  workLight.light!.intensity = 18;
  workLight.light!.distance = 12;

  const rimLight = createEntity('light-spot', 'リムライト');
  rimLight.transform.position = [3, 3.5, -4];
  rimLight.transform.rotation = [-25, -35, 0];
  rimLight.light!.color = '#4d9dff';
  rimLight.light!.intensity = 35;
  rimLight.light!.distance = 18;

  const camera = createEntity('camera', '観察カメラ');
  camera.camera!.main = true;
  camera.transform.position = [0, 3.5, 9];
  camera.transform.rotation = [-15, 0, 0];

  for (const e of [floor, backWall, leftWall, rightWall, platform, specimen, workLight, rimLight, camera]) addRoot(scene, e);
  return scene;
}

function addRoot(scene: SceneData, e: EntityData): void {
  e.parent = null;
  scene.entities[e.id] = e;
  scene.roots.push(e.id);
}

export function createProject(name = '新しいゲーム', sample = true): ProjectData {
  const scene = sample ? createSampleScene() : createEmptyScene('シーン1');
  const now = Date.now();
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    id: createId('p'),
    name,
    createdAt: now,
    updatedAt: now,
    scenes: [scene],
    activeSceneId: scene.id,
    startSceneId: scene.id,
    assets: [],
    prefabs: [],
    assetFolders: [],
    game: defaultGameSettings(name),
    variables: [],
  };
}

export function countEntities(p: ProjectData): number {
  return p.scenes.reduce((n, s) => n + Object.keys(s.entities).length, 0);
}
