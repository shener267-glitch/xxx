import { createEntity } from './catalog';
import type { CreateKind } from './catalog';
import { createEmptyScene, createProject } from './project';
import type { EntityData, ProjectData, SceneData, Vec3 } from './types';

/**
 * 新しいプロジェクトのテンプレート (遊べるゲームの見本)。
 * 仕組みはすべて Inspector で見て・変えられるコンポーネントで作っている。
 * ※ コンポーネントの既定値を使うため、registerBuiltinComponents() の後で呼ぶこと
 */

export type TemplateId = 'sample' | 'empty' | 'coins' | 'adventure';

export interface TemplateInfo {
  id: TemplateId;
  label: string;
  description: string;
  icon: string;
  defaultName: string;
}

export const TEMPLATES: TemplateInfo[] = [
  { id: 'coins', label: 'コインあつめ', description: '制限時間内にコインを集めてゴール。敵・トゲ・回復・セーブポイント入り', icon: 'coin', defaultName: 'コインあつめ' },
  { id: 'adventure', label: 'ぼうけん', description: '村人と話して鍵を探し、扉を開けてクリア。会話・持ち物・敵入り', icon: 'chat', defaultName: 'ぼうけん' },
  { id: 'sample', label: 'サンプル', description: '回転・往復するオブジェクトの入った練習用シーン', icon: 'cube', defaultName: '新しいゲーム' },
  { id: 'empty', label: '空のシーン', description: '地面・ライト・カメラだけ', icon: 'plane', defaultName: '新しいゲーム' },
];

function add(scene: SceneData, kind: CreateKind, name: string, pos: Vec3, edit?: (e: EntityData) => void): EntityData {
  const e = createEntity(kind, name);
  e.transform.position = [...pos];
  edit?.(e);
  e.parent = null;
  scene.entities[e.id] = e;
  scene.roots.push(e.id);
  return e;
}

function props(e: EntityData, type: string, patch: Record<string, unknown>): void {
  const c = e.components.find((x) => x.type === type);
  if (c) Object.assign(c.props, patch);
}

/** 共通: 草の地面・プレイヤー・空 */
function baseGameScene(name: string, groundSize: number): { scene: SceneData; player: EntityData } {
  const scene = createEmptyScene(name);
  const ground = Object.values(scene.entities).find((e) => e.kind === 'mesh')!;
  ground.transform.scale = [groundSize, 1, groundSize];
  Object.assign(ground.mesh!.material, { color: '#6fae5a', pattern: 'grass', uvScale: [groundSize / 2, groundSize / 2] });
  const cam = Object.values(scene.entities).find((e) => e.kind === 'camera');
  if (cam) {
    cam.transform.position = [0, 6, 12];
    cam.transform.rotation = [-22, 0, 0];
  }
  scene.environment.fog = { enabled: true, color: '#cfe3f5', near: 30, far: 90 };
  const player = add(scene, 'game-player', 'プレイヤー', [0, 1, 6]);
  scene.playerId = player.id;
  scene.editorCamera = { target: [0, 0.5, 0], yaw: 30, pitch: 38, distance: 24 };
  return { scene, player };
}

function coinsScene(): SceneData {
  const { scene } = baseGameScene('ステージ1', 36);
  // コインを円形に並べる
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    add(scene, 'game-coin', `コイン${i + 1}`, [Math.round(Math.sin(a) * 7 * 10) / 10, 0.8, Math.round(Math.cos(a) * 7 * 10) / 10], (e) =>
      props(e, 'item', { kind: 'score', value: 10 }),
    );
  }
  // 台の上のコイン (ジャンプで取る)
  add(scene, 'cube', '台', [-10, 0.5, -4], (e) => {
    e.transform.scale = [3, 1, 3];
    Object.assign(e.mesh!.material, { preset: 'wood', color: '#b07a45', pattern: 'wood', roughness: 0.75 });
  });
  add(scene, 'game-coin', 'コイン (台の上)', [-10, 1.8, -4], (e) => props(e, 'item', { kind: 'score', value: 50 }));
  add(scene, 'cube', '壁', [5, 1, -9], (e) => {
    e.transform.scale = [8, 2, 1];
    Object.assign(e.mesh!.material, { color: '#a7a39a', pattern: 'brick', uvScale: [4, 1] });
  });
  add(scene, 'game-enemy', '敵1', [4, 0.5, -3], (e) => props(e, 'enemy', { patrol: 3, detectRange: 6 }));
  add(scene, 'game-enemy', '敵2', [-5, 0.5, 3], (e) => props(e, 'enemy', { patrol: 2, detectRange: 5, speed: 2.5 }));
  add(scene, 'game-spike', 'トゲ', [8, 0.5, 4]);
  add(scene, 'game-heal', '回復アイテム', [-8, 0.8, 7]);
  add(scene, 'game-savepoint', 'セーブポイント', [0, 0.05, 1]);
  add(scene, 'game-goal', 'ゴール', [0, 1.5, -12], (e) => props(e, 'goal', { requireScore: 100, message: 'ステージクリア！' }));
  add(scene, 'ui-text', '説明', [0, 0, 0], (e) => {
    Object.assign(e.ui!, { anchor: 'top', y: 84, text: 'コインを集めて (スコア 100) ゴールへ！', fontSize: 14, backgroundOpacity: 0.4, radius: 10 });
  });
  scene.music = { source: 'builtin:happy', volume: 0.5 };
  return scene;
}

function adventureScene(): SceneData {
  const { scene } = baseGameScene('村', 40);
  scene.environment.sky.type = 'gradient';
  add(scene, 'game-npc', '村長', [-3, 1, 2], (e) =>
    props(e, 'npc', {
      message: 'ようこそ、旅の人。\n\n北の扉の鍵を、東の森に落としてしまったのじゃ…\n\n鍵を見つけて扉を開けてくれんか？ 森には魔物がおるから気をつけるのじゃぞ。',
    }),
  );
  add(scene, 'game-npc', '子ども', [4, 1, 5], (e) => {
    props(e, 'npc', { message: '森の魔物は、上から踏んづけるとやっつけられるよ！\n\n攻撃ボタンでも倒せるんだって。' });
    e.transform.scale = [0.6, 0.6, 0.6];
    e.mesh!.material.color = '#f2a65a';
  });
  // 東の森 (木 = 円柱 + 円錐)
  const trees: Vec3[] = [
    [12, 0, -2],
    [14, 0, 3],
    [10, 0, 6],
    [16, 0, -6],
    [9, 0, -7],
  ];
  trees.forEach((p, i) => {
    add(scene, 'cylinder', `木の幹${i + 1}`, [p[0], 1, p[2]], (e) => {
      e.transform.scale = [0.4, 2, 0.4];
      Object.assign(e.mesh!.material, { color: '#7a5230', pattern: 'wood' });
    });
    add(scene, 'cone', `木の葉${i + 1}`, [p[0], 3, p[2]], (e) => {
      e.transform.scale = [2, 2.4, 2];
      e.mesh!.material.color = '#2f7d3a';
    });
  });
  add(scene, 'game-key', '鍵', [13, 0.8, 0]);
  add(scene, 'game-enemy', 'スライム', [11, 0.5, 2], (e) => {
    props(e, 'enemy', { patrol: 2, detectRange: 6, speed: 1.8 });
    e.mesh!.shape = 'sphere';
    e.mesh!.material.color = '#58c26b';
  });
  add(scene, 'game-enemy', 'スライム2', [14, 0.5, -4], (e) => {
    props(e, 'enemy', { patrol: 1.5, detectRange: 6, speed: 1.8 });
    e.mesh!.shape = 'sphere';
    e.mesh!.material.color = '#4aa3d8';
  });
  // 北の扉 (鍵が必要なゴール)
  add(scene, 'cube', '門の柱 左', [-2, 1.5, -12], (e) => {
    e.transform.scale = [1, 3, 1];
    Object.assign(e.mesh!.material, { color: '#9c9486', pattern: 'stone' });
  });
  add(scene, 'cube', '門の柱 右', [2, 1.5, -12], (e) => {
    e.transform.scale = [1, 3, 1];
    Object.assign(e.mesh!.material, { color: '#9c9486', pattern: 'stone' });
  });
  add(scene, 'game-goal', '扉', [0, 1.3, -12], (e) => {
    e.mesh!.shape = 'cube';
    e.transform.scale = [3, 2.6, 0.4];
    Object.assign(e.mesh!.material, { color: '#8b5a2b', pattern: 'wood', emissive: '#000000', emissiveIntensity: 0 });
    props(e, 'goal', { requireItem: '鍵', message: '扉が開いた！ ぼうけんクリア！' });
  });
  add(scene, 'game-heal', '薬草', [6, 0.8, -3]);
  add(scene, 'game-savepoint', 'セーブポイント', [5, 0.05, 0]);
  add(scene, 'ui-text', '目的', [0, 0, 0], (e) => {
    Object.assign(e.ui!, { anchor: 'top', y: 84, text: '村長に話しかけてみよう', fontSize: 14, backgroundOpacity: 0.4, radius: 10 });
  });
  scene.music = { source: 'builtin:adventure', volume: 0.45 };
  return scene;
}

export function createProjectFromTemplate(id: TemplateId, name: string): ProjectData {
  if (id === 'sample' || id === 'empty') return createProject(name, id === 'sample');
  const project = createProject(name, false);
  const scene = id === 'coins' ? coinsScene() : adventureScene();
  project.scenes = [scene];
  project.activeSceneId = scene.id;
  project.startSceneId = scene.id;
  project.game.title = name;
  if (id === 'coins') {
    project.game.subtitle = 'コインを集めてゴールをめざせ！';
    project.game.titleBackground = '#2a6f3f';
    project.game.timeLimit = 180;
    project.game.clearMessage = 'ステージクリア！';
  } else {
    project.game.subtitle = '鍵を見つけて扉を開けよう';
    project.game.titleBackground = '#3b2d5c';
    project.game.clearMessage = 'ぼうけんクリア！';
  }
  return project;
}
