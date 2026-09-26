import { createEntity, defaultEnvironment, defaultPhysics } from './catalog';
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

/** 新規プロジェクトのサンプルシーン (Play を押すとすぐ動きが分かる内容) */
export function createSampleScene(name = 'シーン1'): SceneData {
  const scene = createEmptyScene(name);

  const cube = createEntity('cube', 'キューブ');
  cube.transform.position = [-1.5, 0.5, 0];
  cube.components.push({
    id: createId('c'),
    type: 'rotator',
    enabled: true,
    props: { speed: [0, 60, 0] },
  });

  const sphere = createEntity('sphere', 'プレイヤー');
  sphere.transform.position = [1.5, 0.5, 0];

  const pillar = createEntity('cylinder', '柱');
  pillar.transform.position = [0, 1, -3];
  pillar.transform.scale = [0.6, 2, 0.6];

  const floating = createEntity('cone', '浮遊コーン');
  floating.transform.position = [3.5, 1.5, -2];
  floating.components.push({
    id: createId('c'),
    type: 'oscillator',
    enabled: true,
    props: { axis: 'y', amplitude: 0.5, frequency: 0.5 },
  });

  for (const e of [cube, sphere, pillar, floating]) addRoot(scene, e);
  scene.playerId = sphere.id;
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
  };
}

export function countEntities(p: ProjectData): number {
  return p.scenes.reduce((n, s) => n + Object.keys(s.entities).length, 0);
}
