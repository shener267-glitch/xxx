import type { BlockKind, EventBlock } from './events';
import { getBlockDef, missingParam } from './events';
import type { EntityData, ProjectData, SceneData } from './types';

/**
 * プロジェクトの問題チェック (初心者向け)。
 * Play や書き出しの前に「ゲームが思った通りに動かない原因」になりやすい設定を見つけ、
 * 何が起きるか・どう直すかを日本語で説明する。DOM に依存しない (単体テスト対象)。
 */

export type IssueLevel = 'error' | 'warn' | 'info';

/** エディタがその場で直せる問題の種類 */
export type IssueFixKind = 'add-player' | 'add-light';

export interface Issue {
  /** 一覧の中で一意なキー */
  key: string;
  level: IssueLevel;
  /** 短い見出し */
  title: string;
  /** 何が起きるか・どう直すか */
  detail: string;
  sceneId: string;
  sceneName: string;
  /** 原因のオブジェクト (選んで直せる) */
  entityId?: string;
  /** 原因のイベント */
  ruleId?: string;
  /** 原因のタイムライン */
  timelineId?: string;
  /** その場で直せる場合 */
  fix?: { kind: IssueFixKind; label: string };
}

const LEVEL_ORDER: Record<IssueLevel, number> = { error: 0, warn: 1, info: 2 };

function comp(e: EntityData, type: string) {
  return e.components.find((c) => c.type === type && c.enabled);
}

const GAMEPLAY = ['enemy', 'item', 'goal', 'npc', 'damage', 'savepoint'];

/** プロジェクト全体 (sceneId を指定するとそのシーンだけ) を調べる */
export function checkProject(project: ProjectData, sceneId?: string): Issue[] {
  const issues: Issue[] = [];
  const assetIds = new Set(project.assets.map((a) => a.id));
  const soundOk = (src: unknown) => typeof src !== 'string' || src === '' || src.startsWith('builtin:') || assetIds.has(src);
  const assetOk = (id: string | null | undefined) => !id || assetIds.has(id);
  const variables = new Set(project.variables.map((v) => v.name));
  // 持ち物: アイテムで拾える名前と、イベントでもらえる名前
  const itemNames = new Set<string>();
  for (const sc of project.scenes) {
    for (const e of Object.values(sc.entities)) {
      const item = comp(e, 'item');
      if (item && item.props.kind === 'item' && typeof item.props.itemName === 'string') itemNames.add(item.props.itemName);
    }
    const give = (b: EventBlock) => {
      if (b.type === 'item' && typeof b.params.item === 'string' && Number(b.params.count ?? 1) > 0) itemNames.add(b.params.item);
    };
    for (const r of sc.events) [...r.actions, ...r.elseActions].forEach(give);
    for (const t of sc.timelines) t.items.forEach((it) => give(it.action));
  }

  for (const scene of project.scenes) {
    if (sceneId && scene.id !== sceneId) continue;
    let n = 0;
    const add = (issue: Omit<Issue, 'key' | 'sceneId' | 'sceneName'>) =>
      issues.push({ ...issue, key: `${scene.id}:${n++}`, sceneId: scene.id, sceneName: scene.name });
    checkScene(project, scene, { add, soundOk, assetOk, variables, itemNames });
  }
  return issues.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

interface CheckContext {
  add(issue: Omit<Issue, 'key' | 'sceneId' | 'sceneName'>): void;
  soundOk(src: unknown): boolean;
  assetOk(id: string | null | undefined): boolean;
  variables: Set<string>;
  itemNames: Set<string>;
}

function checkScene(project: ProjectData, scene: SceneData, c: CheckContext): void {
  const all = Object.values(scene.entities);

  // ---- プレイヤー ----
  const players = all.filter((e) => comp(e, 'player'));
  const gameplay = all.filter((e) => GAMEPLAY.some((t) => comp(e, t)));
  const playerOk = players.length > 0 || (!!scene.playerId && !!scene.entities[scene.playerId]);
  if (!playerOk && gameplay.length > 0) {
    c.add({
      level: 'warn',
      title: 'プレイヤーがいません',
      detail: '敵・アイテム・ゴールなどがありますが、操作するプレイヤーがいないため Play してもゲームを進められません。「追加」→「ゲーム」→「プレイヤー」を置いてください。',
      fix: { kind: 'add-player', label: 'プレイヤーを置く' },
    });
  }
  if (players.length > 1) {
    c.add({
      level: 'warn',
      title: `プレイヤーが ${players.length} 人います`,
      detail: '操作できるのは 1 人だけです。いらないプレイヤーを消すか、その「プレイヤー操作」の動作を外してください。',
      entityId: players[1].id,
    });
  }

  // ---- ライト ----
  if (all.length > 0 && !all.some((e) => e.kind === 'light' && e.visible)) {
    c.add({
      level: 'warn',
      title: 'ライトがありません',
      detail: '光が無いと物が暗く表示されます。「追加」→「ライト」→「太陽光」を置いてください。',
      fix: { kind: 'add-light', label: '太陽光を置く' },
    });
  }

  // ---- ゲーム用オブジェクト ----
  for (const e of all) {
    const goal = comp(e, 'goal');
    const need = goal && typeof goal.props.requireItem === 'string' ? goal.props.requireItem.trim() : '';
    if (need && !c.itemNames.has(need)) {
      c.add({
        level: 'warn',
        title: `ゴールに必要な「${need}」が手に入りません`,
        detail: `「${e.name}」は持ち物「${need}」が無いとクリアできませんが、「${need}」を拾えるアイテムがありません。アイテムの「持ち物の名前」を「${need}」にするか、ゴールの「必要な持ち物」を変えてください。`,
        entityId: e.id,
      });
    }
    const item = comp(e, 'item');
    if (item && item.props.kind === 'item' && !String(item.props.itemName ?? '').trim()) {
      c.add({
        level: 'warn',
        title: `「${e.name}」の持ち物の名前がありません`,
        detail: '種類が「持ち物」のアイテムは、名前 (例: 鍵) が無いと拾っても持ち物に入りません。インスペクターの「持ち物の名前」を入力してください。',
        entityId: e.id,
      });
    }
    if (item && !c.soundOk(item.props.sound)) {
      c.add({ level: 'warn', title: `「${e.name}」の効果音が見つかりません`, detail: '拾ったときの音に選んだ音声ファイルが見つかりません (削除した可能性があります)。音を選び直してください。', entityId: e.id });
    }
    const npc = comp(e, 'npc');
    if (npc && !String(npc.props.message ?? '').trim()) {
      c.add({ level: 'info', title: `「${e.name}」のセリフがありません`, detail: '話しかけても何も表示されません。インスペクターの「セリフ」を入力してください。', entityId: e.id });
    }
    const sound = comp(e, 'sound');
    if (sound && !c.soundOk(sound.props.sound)) {
      c.add({ level: 'warn', title: `「${e.name}」の音が見つかりません`, detail: '選んだ音声ファイルが見つかりません (削除した可能性があります)。音を選び直してください。', entityId: e.id });
    }
    if ((comp(e, 'rigidbody') || comp(e, 'collider')) && !scene.physics.enabled) {
      c.add({
        level: 'info',
        title: `「${e.name}」の物理は動きません`,
        detail: 'このシーンは物理演算が OFF です。落ちる・転がる動きを使うときは、何も選ばずにインスペクターを開き「物理」を ON にしてください。',
        entityId: e.id,
      });
    }

    // ---- アセット ----
    if (e.kind === 'model' && (!e.model?.asset || !c.assetOk(e.model.asset))) {
      c.add({
        level: 'error',
        title: `「${e.name}」の 3D モデルがありません`,
        detail: '使っていた 3D モデルのファイルが見つかりません (アセットを削除した可能性があります)。Play では箱で表示されます。モデルを読み込み直すか、このオブジェクトを消してください。',
        entityId: e.id,
      });
    }
    if (e.mesh?.material.texture && !c.assetOk(e.mesh.material.texture)) {
      c.add({ level: 'warn', title: `「${e.name}」の画像 (テクスチャ) がありません`, detail: '貼っていた画像が見つかりません。インスペクターの「マテリアル」で画像を選び直すか、外してください。', entityId: e.id });
    }
    if (e.ui?.type === 'image' && e.ui.image && !c.assetOk(e.ui.image)) {
      c.add({ level: 'warn', title: `「${e.name}」の画像がありません`, detail: '画面 UI に使っていた画像が見つかりません。インスペクターで画像を選び直してください。', entityId: e.id });
    }
    if (e.ui?.font && !c.assetOk(e.ui.font)) {
      c.add({ level: 'info', title: `「${e.name}」のフォントがありません`, detail: 'フォントのファイルが見つからないため、標準の文字で表示されます。', entityId: e.id });
    }

    // ---- 置き場所 ----
    if (!e.parent && (e.kind === 'mesh' || e.kind === 'model') && e.transform.position[1] < -30) {
      c.add({ level: 'info', title: `「${e.name}」が地面のずっと下にあります`, detail: '画面に映らない場所にあります。いらなければ消し、使うなら位置を直してください。', entityId: e.id });
    }

    // ---- ボタン ----
    if (e.kind === 'ui' && e.ui?.type === 'button' && e.ui.action === 'none') {
      const used = scene.events.some((r) => r.trigger.type === 'click' && (r.trigger.params.target === e.id || !r.trigger.params.target));
      if (!used) {
        c.add({
          level: 'info',
          title: `ボタン「${e.name}」を押しても何も起きません`,
          detail: 'インスペクターの「押したとき」を選ぶか、イベントの「ボタンが押されたとき」で動作を決めてください。',
          entityId: e.id,
        });
      }
    }
  }

  // ---- BGM ----
  if (!c.soundOk(scene.music.source)) {
    c.add({ level: 'warn', title: 'BGM の音声ファイルが見つかりません', detail: 'シーンの BGM に選んだファイルが見つかりません。何も選ばずにインスペクターを開き、「BGM」を選び直してください。' });
  }

  // ---- イベント・タイムライン ----
  for (const r of scene.events) {
    if (!r.enabled) continue;
    const blocks: [BlockKind, EventBlock][] = [['trigger', r.trigger], ...r.conditions.map((b): [BlockKind, EventBlock] => ['condition', b]), ...r.actions.map((b): [BlockKind, EventBlock] => ['action', b]), ...r.elseActions.map((b): [BlockKind, EventBlock] => ['action', b])];
    for (const [kind, block] of blocks) checkBlock(project, scene, kind, block, `イベント「${r.name}」`, { ruleId: r.id }, c);
    if (r.actions.length === 0 && r.elseActions.length === 0) {
      c.add({ level: 'info', title: `イベント「${r.name}」の「なら」が空です`, detail: '条件を満たしても何も起きません。「なら」に動作を追加してください。', ruleId: r.id });
    }
  }
  for (const t of scene.timelines) {
    for (const it of t.items) checkBlock(project, scene, 'action', it.action, `タイムライン「${t.name}」`, { timelineId: t.id }, c);
  }
}

function checkBlock(
  project: ProjectData,
  scene: SceneData,
  kind: BlockKind,
  block: EventBlock,
  where: string,
  ref: Pick<Issue, 'ruleId' | 'timelineId'>,
  c: CheckContext,
): void {
  const def = getBlockDef(kind, block.type);
  if (!def) return; // 新しいバージョンのデータ (実行時は無視される)
  const missing = missingParam(kind, block);
  if (missing) {
    c.add({
      level: 'error',
      title: `${where}: 「${missing}」が選ばれていません`,
      detail: `「${def.label}」の「${missing}」を選んでください。選ばれていないと、この部分は動きません。`,
      ...ref,
    });
    return;
  }
  for (const p of def.params) {
    const v = block.params[p.key];
    if (typeof v !== 'string' || v === '') continue;
    if (p.type === 'entity' && v !== 'player' && !scene.entities[v]) {
      c.add({
        level: 'error',
        title: `${where}が消えたオブジェクトを使っています`,
        detail: `「${def.label}」の「${p.label}」に選んだオブジェクトがシーンにありません (削除した可能性があります)。選び直してください。`,
        ...ref,
      });
    } else if (p.type === 'scene' && !project.scenes.some((s) => s.id === v)) {
      c.add({ level: 'error', title: `${where}が消えたシーンを使っています`, detail: `「${def.label}」の切り替え先のシーンがありません。シーンを選び直してください。`, ...ref });
    } else if (p.type === 'variable' && !c.variables.has(v)) {
      c.add({ level: 'warn', title: `変数「${v}」がありません`, detail: `${where}で使っている変数「${v}」が作られていません。イベントタブの「変数」で「${v}」を作ってください。`, ...ref });
    } else if (p.type === 'timeline' && !scene.timelines.some((t) => t.id === v)) {
      c.add({ level: 'error', title: `${where}が消えたタイムラインを使っています`, detail: `「${def.label}」のタイムラインがありません。選び直してください。`, ...ref });
    } else if ((p.type === 'sound' || p.type === 'music') && !c.soundOk(v)) {
      c.add({ level: 'warn', title: `${where}の音が見つかりません`, detail: `「${def.label}」に選んだ音声ファイルが見つかりません。音を選び直してください。`, ...ref });
    }
  }
}

/** 見出しの横に出す件数 (エラーと警告だけ数える) */
export function countProblems(issues: Issue[]): { errors: number; warnings: number; infos: number } {
  return {
    errors: issues.filter((i) => i.level === 'error').length,
    warnings: issues.filter((i) => i.level === 'warn').length,
    infos: issues.filter((i) => i.level === 'info').length,
  };
}

