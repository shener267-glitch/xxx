import { createEntity } from './catalog';
import { createBlock, createRule } from './events';
import type { CreateKind } from './catalog';
import { createEmptyScene, createProject } from './project';
import { createTimeline, createTimelineItem } from './timeline';
import type { EntityData, ProjectData, SceneData, Vec3 } from './types';

/**
 * 新しいプロジェクトのテンプレート (遊べるゲームの見本)。
 * 仕組みはすべて Inspector で見て・変えられるコンポーネントで作っている。
 * ※ コンポーネントの既定値を使うため、registerBuiltinComponents() の後で呼ぶこと
 */

export type TemplateId = 'castle' | 'sample' | 'empty' | 'coins' | 'adventure';

export interface TemplateInfo {
  id: TemplateId;
  label: string;
  description: string;
  icon: string;
  defaultName: string;
}

export const TEMPLATES: TemplateInfo[] = [
  {
    id: 'castle',
    label: 'ポケット城の冒険 (完成版サンプル)',
    description: 'スイッチで門を開け、鍵で塔へ、ボスを倒して宝物を手に入れる。NPC・敵・ドア・2 つのシーン・タイトル/クリア/ゲームオーバー入り',
    icon: 'trophy',
    defaultName: 'ポケット城の冒険',
  },
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
  const guide = add(scene, 'ui-text', '説明', [0, 0, 0], (e) => {
    Object.assign(e.ui!, { anchor: 'top', y: 84, text: 'コインを集めて (スコア 100) ゴールへ！', fontSize: 14, backgroundOpacity: 0.4, radius: 10 });
  });
  scene.music = { source: 'builtin:happy', volume: 0.5 };
  // イベントの見本
  const reach = createRule('スコア 100 でお知らせ', createBlock('trigger', 'condition'));
  reach.once = true;
  reach.conditions.push(createBlock('condition', 'score', { op: '>=', value: 100 }));
  reach.actions.push(
    createBlock('action', 'sound', { sound: 'builtin:powerup' }),
    createBlock('action', 'message', { text: 'スコア 100 達成！ ゴールへ向かおう', seconds: 3 }),
    createBlock('action', 'setText', { target: guide.id, text: 'ゴール (黄色い柱) へ向かおう！' }),
  );
  const defeat = createRule('敵を倒した数を数える', createBlock('trigger', 'defeated', { target: '' }));
  defeat.actions.push(createBlock('action', 'setVar', { name: '倒した数', mode: 'add', value: '1' }), createBlock('action', 'score', { value: 20 }));
  scene.events = [reach, defeat];
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
  const goal = add(scene, 'ui-text', '目的', [0, 0, 0], (e) => {
    Object.assign(e.ui!, { anchor: 'top', y: 84, text: '村長に話しかけてみよう', fontSize: 14, backgroundOpacity: 0.4, radius: 10 });
  });
  scene.music = { source: 'builtin:adventure', volume: 0.45 };
  // イベントの見本: 話したら・鍵を拾ったら目的の文字を変える
  const chief = Object.values(scene.entities).find((e) => e.name === '村長')!;
  const key = Object.values(scene.entities).find((e) => e.name === '鍵')!;
  const talked = createRule('村長と話したら', createBlock('trigger', 'talk', { target: chief.id }));
  talked.conditions.push(createBlock('condition', 'item', { item: '鍵', count: 1 }));
  talked.actions.push(createBlock('action', 'dialog', { name: '村長', text: 'おお、鍵を見つけてくれたか！ 北の扉へ向かうのじゃ。' }));
  talked.elseActions.push(createBlock('action', 'setText', { target: goal.id, text: '東の森で鍵を探そう' }));
  const gotKey = createRule('鍵を拾ったら', createBlock('trigger', 'pickup', { target: key.id }));
  gotKey.actions.push(createBlock('action', 'setText', { target: goal.id, text: '北の扉を開けよう！' }), createBlock('action', 'sound', { sound: 'builtin:powerup' }));
  scene.events = [talked, gotKey];
  return scene;
}

// ------------------------------------------------------------------
// 完成版サンプル「ポケット城の冒険」
// エディタの機能 (追加・インスペクター・イベント・タイムライン) だけで作れる内容にしている
// ------------------------------------------------------------------

type Mat = Partial<EntityData['mesh'] extends infer M ? (M extends { material: infer T } ? T : never) : never>;

function shape(scene: SceneData, kind: CreateKind, name: string, pos: Vec3, scale: Vec3, mat: Mat, rot?: Vec3): EntityData {
  return add(scene, kind, name, pos, (e) => {
    e.transform.scale = scale;
    if (rot) e.transform.rotation = rot;
    Object.assign(e.mesh!.material, mat);
  });
}

const STONE: Mat = { color: '#9c9486', pattern: 'stone', roughness: 0.9 };
const DARK_STONE: Mat = { color: '#6f6878', pattern: 'brick', roughness: 0.9 };
const WOOD: Mat = { preset: 'wood', color: '#8b5a2b', pattern: 'wood', roughness: 0.75 };
const ROOF: Mat = { color: '#b8423a', roughness: 0.7 };

function tree(scene: SceneData, i: number, x: number, z: number): void {
  shape(scene, 'cylinder', `木の幹${i}`, [x, 1, z], [0.45, 2, 0.45], { color: '#7a5230', pattern: 'wood' });
  shape(scene, 'cone', `木の葉${i}`, [x, 3.1, z], [2.2, 2.6, 2.2], { color: i % 2 ? '#2f7d3a' : '#3b8f45' });
}

function torch(scene: SceneData, name: string, pos: Vec3): void {
  add(scene, 'fx-fire', name, pos, (e) => {
    const c = e.components.find((x) => x.type === 'particles');
    if (c) Object.assign(c.props, { amount: 0.6, size: 0.6 });
  });
}

function castleVillageScene(): { scene: SceneData; ids: Record<string, string> } {
  const { scene, player } = baseGameScene('森の村と城', 60);
  player.transform.position = [0, 1, 20];
  scene.editorCamera = { target: [0, 0.5, 2], yaw: 20, pitch: 48, distance: 46 };
  scene.environment.fog = { enabled: true, color: '#cfe3f5', near: 40, far: 110 };
  scene.music = { source: 'builtin:adventure', volume: 0.45 };

  // ---- 村 ----
  shape(scene, 'cube', '家', [-10, 1.25, 16], [4, 2.5, 4], WOOD);
  shape(scene, 'cone', '家の屋根', [-10, 3.3, 16], [4.4, 1.6, 4.4], ROOF, [0, 45, 0]);
  const guide = add(scene, 'game-npc', '案内人', [-6, 1, 15], (e) =>
    props(e, 'npc', {
      message:
        'ようこそ、ポケット城へ！\n\n城の門は、村の東の森にあるスイッチを踏むと開くよ。\n\n中庭のどこかに「塔の鍵」が落ちているらしい。番兵に気をつけて！\n\n塔の中には宝物が眠っているんだ。がんばってね！',
    }),
  );
  const coins: Vec3[] = [
    [3, 0.8, 16],
    [5, 0.8, 13],
    [7, 0.8, 10],
    [-2, 0.8, 11],
    [-4, 0.8, 8],
    [2, 0.8, 6],
  ];
  coins.forEach((p, i) => add(scene, 'game-coin', `コイン${i + 1}`, p, (e) => props(e, 'item', { kind: 'score', value: 10 })));
  add(scene, 'game-heal', '回復のハート', [-7, 0.8, 5]);

  // ---- 東の森とスイッチ ----
  [
    [14, 12],
    [18, 8],
    [11, 5],
    [19, 1],
    [12, -1],
    [22, 12],
  ].forEach(([x, z], i) => tree(scene, i + 1, x, z));
  shape(scene, 'cylinder', 'スイッチの台', [15, 0.04, 4], [2.2, 0.08, 2.2], STONE);
  const sw = add(scene, 'game-switch', 'スイッチ', [15, 0.12, 4], (e) => (e.transform.scale = [1.2, 0.1, 1.2]));
  add(scene, 'game-enemy', 'スライム', [13, 0.5, 9], (e) => {
    props(e, 'enemy', { patrol: 2.5, detectRange: 6, speed: 1.8 });
    e.mesh!.shape = 'sphere';
    e.mesh!.material.color = '#58c26b';
  });
  add(scene, 'game-enemy', 'スライム2', [17, 0.5, -3], (e) => {
    props(e, 'enemy', { patrol: 2, detectRange: 6, speed: 1.8 });
    e.mesh!.shape = 'sphere';
    e.mesh!.material.color = '#4aa3d8';
  });

  // ---- 城 (城壁・門・中庭・塔) ----
  shape(scene, 'cube', '城壁 左', [-9, 1.75, -6], [14, 3.5, 1], STONE);
  shape(scene, 'cube', '城壁 右', [9, 1.75, -6], [14, 3.5, 1], STONE);
  shape(scene, 'cube', '城壁 西', [-16, 1.75, -16], [1, 3.5, 20], STONE);
  shape(scene, 'cube', '城壁 東', [16, 1.75, -16], [1, 3.5, 20], STONE);
  shape(scene, 'cube', '城壁 北', [0, 1.75, -26], [33, 3.5, 1], STONE);
  shape(scene, 'cylinder', '見張り塔 左', [-16, 2.5, -6], [2.6, 5, 2.6], STONE);
  shape(scene, 'cylinder', '見張り塔 右', [16, 2.5, -6], [2.6, 5, 2.6], STONE);
  shape(scene, 'cone', '見張り塔の屋根 左', [-16, 5.8, -6], [3.2, 1.6, 3.2], ROOF);
  shape(scene, 'cone', '見張り塔の屋根 右', [16, 5.8, -6], [3.2, 1.6, 3.2], ROOF);
  const gate = add(scene, 'game-door', '城の門', [0, 1.5, -6], (e) => {
    e.transform.scale = [4, 3, 0.5];
    e.mesh!.material.color = '#6b4423';
  });
  torch(scene, 'たいまつ 左', [-2.6, 2.4, -5.2]);
  torch(scene, 'たいまつ 右', [2.6, 2.4, -5.2]);
  add(scene, 'game-savepoint', '中庭のセーブポイント', [0, 0.05, -9]);
  add(scene, 'game-spike', 'トゲ', [4, 0.5, -14]);
  add(scene, 'game-spike', 'トゲ2', [-5, 0.5, -16]);
  add(scene, 'game-heal', '回復のハート2', [-12, 0.8, -21]);
  const courtCoins: Vec3[] = [
    [-9, 0.8, -11],
    [-12, 0.8, -15],
    [7, 0.8, -10],
  ];
  courtCoins.forEach((p, i) => add(scene, 'game-coin', `中庭のコイン${i + 1}`, p, (e) => props(e, 'item', { kind: 'score', value: 10 })));
  const key = add(scene, 'game-key', '塔の鍵', [11, 0.8, -21], (e) => props(e, 'item', { itemName: '塔の鍵' }));
  const guard = add(scene, 'game-enemy', '番兵', [9, 0.6, -18], (e) => {
    e.transform.scale = [1.2, 1.2, 1.2];
    e.mesh!.material.color = '#8e2b3a';
    props(e, 'enemy', { patrol: 3, detectRange: 7, speed: 2.4, damage: 20 });
    props(e, 'health', { maxHp: 40, score: 50 });
  });
  shape(scene, 'cylinder', '塔', [0, 4, -22], [7, 8, 7], DARK_STONE);
  shape(scene, 'cone', '塔の屋根', [0, 9.6, -22], [8.4, 3.2, 8.4], ROOF);
  const towerDoor = add(scene, 'game-door', '塔の扉', [0, 1.3, -18.3], (e) => (e.mesh!.material.color = '#4a2e18'));

  // ---- 画面の UI ----
  const goalText = add(scene, 'ui-text', '目的', [0, 0, 0], (e) => {
    Object.assign(e.ui!, { anchor: 'top', y: 84, text: '村の案内人に話しかけよう', fontSize: 14, backgroundOpacity: 0.45, radius: 10 });
  });
  const hint = add(scene, 'ui-button', 'ヒント', [0, 0, 0], (e) => {
    Object.assign(e.ui!, { anchor: 'top', y: 128, text: '？ ヒント', fontSize: 13, width: 0, height: 36, action: 'none' });
  });

  // ---- オープニング (タイムライン) ----
  const cam = add(scene, 'camera', '城を見るカメラ', [0, 8, 6], (e) => (e.transform.rotation = [-18, 0, 0]));
  const opening = createTimeline('オープニング');
  Object.assign(opening, { duration: 4, autoplay: true, lockPlayer: true, skippable: true, restoreCamera: true });
  opening.items.push(
    createTimelineItem(0, createBlock('action', 'camera', { target: cam.id, seconds: 0 })),
    createTimelineItem(0.3, createBlock('action', 'message', { text: 'ポケット城の宝物をめざせ！', seconds: 2.5 })),
    createTimelineItem(3, createBlock('action', 'camera', { target: 'player', seconds: 1 })),
  );
  scene.timelines = [opening];

  // ---- イベント ----
  const talked = createRule('案内人と話したら', createBlock('trigger', 'talk', { target: guide.id }));
  talked.once = true;
  talked.actions.push(createBlock('action', 'setText', { target: goalText.id, text: '東の森のスイッチを踏んで、城の門を開けよう' }));

  const openGate = createRule('スイッチで城の門を開ける', createBlock('trigger', 'touch', { a: 'player', b: sw.id }));
  openGate.once = true;
  openGate.actions.push(
    createBlock('action', 'sound', { sound: 'builtin:click' }),
    createBlock('action', 'move', { target: sw.id, offset: [0, -0.06, 0], seconds: 0.2 }),
    createBlock('action', 'sound', { sound: 'builtin:powerup' }),
    createBlock('action', 'move', { target: gate.id, offset: [0, 3.2, 0], seconds: 1.5 }),
    createBlock('action', 'message', { text: 'ゴゴゴ… 城の門が開いた！', seconds: 2.5 }),
    createBlock('action', 'setText', { target: goalText.id, text: '城の中庭で「塔の鍵」を探そう' }),
    createBlock('action', 'setVar', { name: '門', mode: 'set', value: '1' }),
  );

  const gotKey = createRule('塔の鍵を拾ったら', createBlock('trigger', 'pickup', { target: key.id }));
  gotKey.actions.push(createBlock('action', 'setText', { target: goalText.id, text: '塔の扉を開けて中へ！' }));

  const enterTower = createRule('塔の扉を開けて中へ', createBlock('trigger', 'touch', { a: 'player', b: towerDoor.id }));
  enterTower.once = true;
  enterTower.conditions.push(createBlock('condition', 'item', { item: '塔の鍵', count: 1 }));
  enterTower.actions.push(
    createBlock('action', 'sound', { sound: 'builtin:powerup' }),
    createBlock('action', 'move', { target: towerDoor.id, offset: [0, 2.8, 0], seconds: 0.8 }),
    createBlock('action', 'message', { text: '扉が開いた！ 塔の中へ…', seconds: 1.5 }),
    createBlock('action', 'wait', { seconds: 1 }),
    createBlock('action', 'scene', { scene: '' }),
  );
  enterTower.elseActions.push(createBlock('action', 'message', { text: '鍵がかかっている… 「塔の鍵」が必要だ', seconds: 2 }));

  const guardDown = createRule('番兵を倒したら', createBlock('trigger', 'defeated', { target: guard.id }));
  guardDown.actions.push(createBlock('action', 'message', { text: '番兵をやっつけた！', seconds: 2 }));

  const hintRule = createRule('ヒントを見る', createBlock('trigger', 'click', { target: hint.id }));
  hintRule.conditions.push(createBlock('condition', 'var', { name: '門', op: '==', value: '0' }));
  hintRule.actions.push(createBlock('action', 'dialog', { name: '案内人', text: '村の東の森にスイッチがあるよ。\n\n踏むと城の門が開くんだ。' }));
  hintRule.elseActions.push(createBlock('action', 'dialog', { name: '案内人', text: '中庭のどこかに「塔の鍵」があるよ。\n\n番兵は攻撃ボタンか、上から踏んで倒せる！' }));

  scene.events = [talked, openGate, gotKey, enterTower, guardDown, hintRule];
  return { scene, ids: { enterTower: enterTower.id } };
}

function towerScene(): SceneData {
  const { scene, player } = baseGameScene('塔の中', 24);
  player.transform.position = [0, 1, 9];
  const ground = Object.values(scene.entities).find((e) => e.name === '地面')!;
  Object.assign(ground.mesh!.material, { color: '#7a716a', pattern: 'tiles', uvScale: [8, 8] });
  scene.editorCamera = { target: [0, 1, 0], yaw: 30, pitch: 50, distance: 30 };
  Object.assign(scene.environment.sky, { type: 'color', topColor: '#1b1726', horizonColor: '#2a2438', bottomColor: '#1b1726' });
  scene.environment.fog = { enabled: true, color: '#1d1a26', near: 14, far: 40 };
  scene.environment.exposure = 0.95;
  scene.music = { source: 'builtin:tension', volume: 0.45 };
  for (const e of Object.values(scene.entities)) {
    if (e.light?.type === 'directional') e.light.intensity *= 0.6;
  }

  shape(scene, 'cube', '壁 北', [0, 3, -12], [24, 6, 1], DARK_STONE);
  shape(scene, 'cube', '壁 南', [0, 3, 12], [24, 6, 1], DARK_STONE);
  shape(scene, 'cube', '壁 西', [-12, 3, 0], [1, 6, 24], DARK_STONE);
  shape(scene, 'cube', '壁 東', [12, 3, 0], [1, 6, 24], DARK_STONE);
  // 階段 (0.8m ずつ上がる) と頂上の床
  shape(scene, 'cube', '階段1', [-6, 0.4, 6], [3, 0.8, 3], STONE);
  shape(scene, 'cube', '階段2', [-6, 0.8, 3], [3, 1.6, 3], STONE);
  shape(scene, 'cube', '階段3', [-6, 1.2, 0], [3, 2.4, 3], STONE);
  shape(scene, 'cube', '階段4', [-6, 1.6, -3], [3, 3.2, 3], STONE);
  shape(scene, 'cube', '頂上の床', [0, 1.6, -7], [9, 3.2, 6], STONE);
  add(scene, 'game-coin', '階段のコイン1', [-6, 2.2, 3], (e) => props(e, 'item', { kind: 'score', value: 20 }));
  add(scene, 'game-coin', '階段のコイン2', [-6, 3.0, 0], (e) => props(e, 'item', { kind: 'score', value: 20 }));
  add(scene, 'game-coin', '階段のコイン3', [-6, 3.8, -3], (e) => props(e, 'item', { kind: 'score', value: 20 }));

  const chest = add(scene, 'game-goal', '宝箱', [2, 3.7, -8], (e) => {
    e.mesh!.shape = 'cube';
    e.transform.scale = [1.4, 1, 1];
    Object.assign(e.mesh!.material, { color: '#d9a520', metalness: 0.7, roughness: 0.35, emissive: '#6b4a00', emissiveIntensity: 0.4 });
    props(e, 'goal', { requireItem: '王家の紋章', message: '宝物を手に入れた！' });
  });
  add(scene, 'fx-magic', '宝箱のキラキラ', [2, 4.4, -8]);
  const boss = add(scene, 'game-enemy', 'ボス スライム', [4, 0.9, 3], (e) => {
    e.mesh!.shape = 'sphere';
    e.transform.scale = [1.8, 1.8, 1.8];
    e.mesh!.material.color = '#7b3fc4';
    props(e, 'enemy', { patrol: 3, detectRange: 8, speed: 2.2, damage: 25, stompable: false });
    props(e, 'health', { maxHp: 40, score: 100 });
  });
  add(scene, 'game-enemy', 'コウモリ', [-2, 0.5, 5], (e) => {
    e.mesh!.shape = 'sphere';
    e.transform.scale = [0.6, 0.6, 0.6];
    e.mesh!.material.color = '#3a3450';
    props(e, 'enemy', { patrol: 2, detectRange: 5, speed: 2.6, damage: 10 });
  });
  add(scene, 'game-spike', 'トゲ', [-3, 0.5, 8]);
  add(scene, 'game-spike', 'トゲ2', [6, 0.5, 7]);
  add(scene, 'game-heal', '回復のハート', [9, 0.8, 9]);
  torch(scene, 'たいまつ 西', [-11.2, 3, -4]);
  torch(scene, 'たいまつ 東', [11.2, 3, -4]);
  add(scene, 'light-point', 'たいまつの光 西', [-10.5, 3, -4], (e) => Object.assign(e.light!, { color: '#ff9a3c', intensity: 18, distance: 14 }));
  add(scene, 'light-point', 'たいまつの光 東', [10.5, 3, -4], (e) => Object.assign(e.light!, { color: '#ff9a3c', intensity: 18, distance: 14 }));

  const goalText = add(scene, 'ui-text', '目的', [0, 0, 0], (e) => {
    Object.assign(e.ui!, { anchor: 'top', y: 84, text: 'ボス スライムを倒して「王家の紋章」を手に入れよう', fontSize: 14, backgroundOpacity: 0.45, radius: 10 });
  });

  const start = createRule('塔に入ったとき', createBlock('trigger', 'start'));
  start.actions.push(createBlock('action', 'message', { text: '塔の頂上の宝箱をめざせ！', seconds: 2.5 }));
  const bossDown = createRule('ボスを倒したら', createBlock('trigger', 'defeated', { target: boss.id }));
  bossDown.actions.push(
    createBlock('action', 'item', { item: '王家の紋章', count: 1 }),
    createBlock('action', 'sound', { sound: 'builtin:powerup' }),
    createBlock('action', 'effect', { preset: 'confetti', target: 'player', scale: 1 }),
    createBlock('action', 'message', { text: 'ボスを倒した！ 「王家の紋章」を手に入れた', seconds: 2.5 }),
    createBlock('action', 'setText', { target: goalText.id, text: '階段を上って宝箱を開けよう！' }),
  );
  const noCrest = createRule('紋章なしで宝箱に触れたら', createBlock('trigger', 'touch', { a: 'player', b: chest.id }));
  noCrest.conditions.push(createBlock('condition', 'item', { item: '王家の紋章', count: 1 }));
  noCrest.elseActions.push(createBlock('action', 'dialog', { name: '宝箱', text: '王家の紋章が無いと開かないようだ…\n\nボス スライムが持っているらしい。' }));
  scene.events = [start, bossDown, noCrest];
  return scene;
}

function castleProject(name: string): ProjectData {
  const project = createProject(name, false);
  const { scene: village, ids } = castleVillageScene();
  const tower = towerScene();
  // 塔の扉の「シーンを切り替える」の行き先
  const enter = village.events.find((r) => r.id === ids.enterTower);
  const go = enter?.actions.find((a) => a.type === 'scene');
  if (go) go.params.scene = tower.id;
  project.scenes = [village, tower];
  project.activeSceneId = village.id;
  project.startSceneId = village.id;
  project.variables = [{ id: 'var_gate', name: '門', initial: 0 }];
  Object.assign(project.game, {
    title: name,
    subtitle: 'スイッチで門を開け、鍵を見つけて塔の宝をめざせ！',
    titleBackground: '#2b3a67',
    clearMessage: '宝物を手に入れた！ ぼうけんクリア！',
    gameOverMessage: 'やられてしまった… もう一度挑戦しよう',
    author: 'Pocket Engine',
    version: '1.0.0',
    description: 'Pocket Engine だけで作ったサンプルの 3D アクションゲーム',
  });
  return project;
}

export function createProjectFromTemplate(id: TemplateId, name: string): ProjectData {
  if (id === 'castle') return castleProject(name);
  if (id === 'sample' || id === 'empty') return createProject(name, id === 'sample');
  const project = createProject(name, false);
  const scene = id === 'coins' ? coinsScene() : adventureScene();
  project.scenes = [scene];
  project.activeSceneId = scene.id;
  project.startSceneId = scene.id;
  project.game.title = name;
  if (id === 'coins') {
    project.variables = [{ id: 'var_defeated', name: '倒した数', initial: 0 }];
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
