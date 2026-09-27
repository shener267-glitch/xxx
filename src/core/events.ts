import { createId } from './util';

/**
 * ノーコードのイベント (「いつ」→「もし」→「なら / そうでなければ」)。
 *
 * - トリガー (いつ): ゲーム開始・○秒ごと・触れた・拾った・倒した・ボタンが押された など
 * - 条件 (もし): 変数・スコア・持ち物・確率 など (すべて満たすと「なら」を実行)
 * - 動作 (なら): 変数を変える・スコア・音・メッセージ・表示/非表示・移動・シーン切り替え など
 *
 * すべて「種類 + パラメータ」のブロックで表し、パラメータの定義 (ParamDef) から
 * エディタの入力欄と文章の要約を自動生成する。
 */

export type ParamType =
  | 'number'
  | 'string'
  | 'text'
  | 'boolean'
  | 'select'
  /** オブジェクト (エンティティ ID。'player' = 操作中のプレイヤー、'' = 指定なし) */
  | 'entity'
  | 'sound'
  | 'music'
  | 'scene'
  /** 変数名 */
  | 'variable'
  /** アニメーションの名前 (シーン内のアニメーションから選ぶ) */
  | 'clip'
  /** シーンのタイムライン (ID) */
  | 'timeline'
  | 'vec3';

export type EntityFilter = 'any' | 'ui' | 'button' | 'object' | 'animation' | 'particles' | 'camera';

export interface ParamDef {
  key: string;
  label: string;
  type: ParamType;
  default: unknown;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: string;
  /** entity: 選べるもの */
  filter?: EntityFilter;
  /** entity: 「プレイヤー」を選べる */
  allowPlayer?: boolean;
  /** entity: 「どれでも」(空) を選べる */
  allowAny?: boolean;
}

export type BlockKind = 'trigger' | 'condition' | 'action';

export interface EventBlock {
  type: string;
  params: Record<string, unknown>;
}

export interface EventRule {
  id: string;
  name: string;
  enabled: boolean;
  /** 1回だけ実行する */
  once: boolean;
  trigger: EventBlock;
  conditions: EventBlock[];
  actions: EventBlock[];
  elseActions: EventBlock[];
}

export type VarValue = number | string | boolean;

/** プロジェクト全体の変数 (シーンをまたいで値が残る) */
export interface VariableDef {
  id: string;
  name: string;
  initial: VarValue;
}

/** 要約の文章を作るための名前の解決 */
export interface SummaryContext {
  entityName(id: string): string;
  sceneName(id: string): string;
  soundName(source: string): string;
  timelineName?(id: string): string;
}

export interface BlockDef {
  type: string;
  kind: BlockKind;
  label: string;
  icon: string;
  group: string;
  params: ParamDef[];
  summary(p: Record<string, unknown>, ctx: SummaryContext): string;
}

// ------------------------------------------------------------------
// 共通の部品
// ------------------------------------------------------------------

export const COMPARE_OPS = [
  { value: '>=', label: '以上' },
  { value: '>', label: 'より大きい' },
  { value: '==', label: 'と同じ' },
  { value: '!=', label: 'と違う' },
  { value: '<=', label: '以下' },
  { value: '<', label: 'より小さい' },
];

const EFFECT_LABELS: Record<string, string> = { explosion: '爆発', sparks: '火花', smoke: '煙', magic: 'キラキラ', confetti: '紙吹雪', fire: '炎' };

const opLabel = (op: unknown) => COMPARE_OPS.find((o) => o.value === op)?.label ?? String(op);
const n = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const s = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const q = (text: unknown, max = 18) => {
  const t = s(text).replace(/\s+/g, ' ').trim();
  return `「${t.length > max ? `${t.slice(0, max)}…` : t}」`;
};

const ent = (key: string, label: string, opts: Partial<ParamDef> = {}): ParamDef => ({ key, label, type: 'entity', default: '', filter: 'object', ...opts });
const num = (key: string, label: string, def: number, opts: Partial<ParamDef> = {}): ParamDef => ({ key, label, type: 'number', default: def, ...opts });
const str = (key: string, label: string, def: string, opts: Partial<ParamDef> = {}): ParamDef => ({ key, label, type: 'string', default: def, ...opts });
const op = (): ParamDef => ({ key: 'op', label: '比べ方', type: 'select', default: '>=', options: COMPARE_OPS });

/** オブジェクト名 (プレイヤー・どれでも を含む) */
function who(ctx: SummaryContext, id: unknown, any = 'どれか'): string {
  const v = s(id);
  if (v === 'player') return 'プレイヤー';
  if (!v) return any;
  return ctx.entityName(v);
}

// ------------------------------------------------------------------
// トリガー (いつ)
// ------------------------------------------------------------------

const WEATHER_OPTIONS = [
  { value: 'none', label: '晴れ' },
  { value: 'rain', label: '雨' },
  { value: 'storm', label: '雷雨' },
  { value: 'snow', label: '雪' },
];

const TRIGGERS: BlockDef[] = [
  { type: 'start', kind: 'trigger', label: 'ゲームが始まったとき', icon: 'play', group: 'ゲーム', params: [], summary: () => 'ゲームが始まったとき' },
  {
    type: 'every',
    kind: 'trigger',
    label: '○秒ごと (タイマー)',
    icon: 'reset',
    group: '時間',
    params: [num('seconds', '間隔', 5, { min: 0.1, max: 3600, step: 0.5, unit: '秒' })],
    summary: (p) => `${n(p.seconds, 5)}秒ごと`,
  },
  {
    type: 'after',
    kind: 'trigger',
    label: '○秒たったとき',
    icon: 'reset',
    group: '時間',
    params: [num('seconds', '時間', 3, { min: 0, max: 36000, step: 0.5, unit: '秒' })],
    summary: (p) => `始まってから${n(p.seconds, 3)}秒たったとき`,
  },
  {
    type: 'timelineEnd',
    kind: 'trigger',
    label: 'タイムラインが終わったとき',
    icon: 'film',
    group: 'タイムライン',
    params: [{ key: 'timeline', label: 'タイムライン', type: 'timeline', default: '', allowAny: true }],
    summary: (p, c) => `${s(p.timeline) ? (c.timelineName?.(s(p.timeline)) ?? 'タイムライン') : 'タイムライン'}が終わったとき`,
  },
  { type: 'morning', kind: 'trigger', label: '朝になったとき', icon: 'sun', group: '時間', params: [], summary: () => '朝になったとき (時刻が 5 時)' },
  { type: 'night', kind: 'trigger', label: '夜になったとき', icon: 'moon', group: '時間', params: [], summary: () => '夜になったとき (時刻が 19 時)' },
  {
    type: 'touch',
    kind: 'trigger',
    label: '触れたとき',
    icon: 'hand',
    group: 'ぶつかる',
    params: [ent('a', 'だれが', { default: 'player', allowPlayer: true }), ent('b', 'なにに', { allowPlayer: true })],
    summary: (p, c) => `${who(c, p.a, '(未選択)')}が${who(c, p.b, '(未選択)')}に触れたとき`,
  },
  {
    type: 'leave',
    kind: 'trigger',
    label: '離れたとき',
    icon: 'hand',
    group: 'ぶつかる',
    params: [ent('a', 'だれが', { default: 'player', allowPlayer: true }), ent('b', 'なにから', { allowPlayer: true })],
    summary: (p, c) => `${who(c, p.a, '(未選択)')}が${who(c, p.b, '(未選択)')}から離れたとき`,
  },
  {
    type: 'pickup',
    kind: 'trigger',
    label: 'アイテムを拾ったとき',
    icon: 'coin',
    group: 'ゲーム',
    params: [ent('target', 'アイテム', { allowAny: true })],
    summary: (p, c) => `${who(c, p.target, 'アイテム')}を拾ったとき`,
  },
  {
    type: 'defeated',
    kind: 'trigger',
    label: '倒したとき',
    icon: 'enemy',
    group: 'ゲーム',
    params: [ent('target', '相手', { allowAny: true })],
    summary: (p, c) => `${who(c, p.target, '敵')}を倒したとき`,
  },
  {
    type: 'damaged',
    kind: 'trigger',
    label: 'プレイヤーがダメージを受けたとき',
    icon: 'heart',
    group: 'ゲーム',
    params: [],
    summary: () => 'プレイヤーがダメージを受けたとき',
  },
  { type: 'jump', kind: 'trigger', label: 'プレイヤーがジャンプしたとき', icon: 'arrowUp', group: 'ゲーム', params: [], summary: () => 'プレイヤーがジャンプしたとき' },
  {
    type: 'talk',
    kind: 'trigger',
    label: '話しかけたとき',
    icon: 'chat',
    group: 'ゲーム',
    params: [ent('target', 'だれに', { allowAny: true })],
    summary: (p, c) => `${who(c, p.target, 'だれか')}に話しかけたとき`,
  },
  {
    type: 'click',
    kind: 'trigger',
    label: 'ボタンが押されたとき',
    icon: 'pointer',
    group: '操作',
    params: [ent('target', 'ボタン', { filter: 'button', allowAny: true })],
    summary: (p, c) => `${who(c, p.target, 'ボタン')}が押されたとき`,
  },
  {
    type: 'key',
    kind: 'trigger',
    label: 'キーが押されたとき (PC)',
    icon: 'grid',
    group: '操作',
    params: [
      {
        key: 'key',
        label: 'キー',
        type: 'select',
        default: 'q',
        options: ['q', 'r', 'f', 'g', 'z', 'x', 'c', '1', '2', '3', 'enter', 'space'].map((k) => ({ value: k, label: k.toUpperCase() })),
      },
    ],
    summary: (p) => `${s(p.key, 'q').toUpperCase()} キーが押されたとき`,
  },
  {
    type: 'varChanged',
    kind: 'trigger',
    label: '変数が変わったとき',
    icon: 'sliders',
    group: '変数',
    params: [{ key: 'name', label: '変数', type: 'variable', default: '' }],
    summary: (p) => `変数「${s(p.name) || '?'}」が変わったとき`,
  },
  {
    type: 'condition',
    kind: 'trigger',
    label: '条件を満たしたとき',
    icon: 'checkSquare',
    group: '変数',
    params: [],
    summary: () => '「もし」の条件を満たしたとき',
  },
];

// ------------------------------------------------------------------
// 条件 (もし)
// ------------------------------------------------------------------

const CONDITIONS: BlockDef[] = [
  {
    type: 'clock',
    kind: 'condition',
    label: '時刻 (○時〜○時)',
    icon: 'sun',
    group: '時間',
    params: [num('from', 'から', 19, { min: 0, max: 24, step: 0.5, unit: '時' }), num('to', 'まで', 5, { min: 0, max: 24, step: 0.5, unit: '時' })],
    summary: (p) => `時刻が ${n(p.from, 19)}時〜${n(p.to, 5)}時`,
  },
  {
    type: 'var',
    kind: 'condition',
    label: '変数を比べる',
    icon: 'sliders',
    group: '変数',
    params: [{ key: 'name', label: '変数', type: 'variable', default: '' }, op(), str('value', '値', '0', { hint: '数値または文字' })],
    summary: (p) => `変数「${s(p.name) || '?'}」が ${s(p.value)} ${opLabel(p.op)}`,
  },
  {
    type: 'score',
    kind: 'condition',
    label: 'スコアを比べる',
    icon: 'trophy',
    group: 'ゲーム',
    params: [op(), num('value', '値', 100, { step: 10 })],
    summary: (p) => `スコアが ${n(p.value)} ${opLabel(p.op)}`,
  },
  {
    type: 'money',
    kind: 'condition',
    label: 'お金を比べる',
    icon: 'coin',
    group: 'ゲーム',
    params: [op(), num('value', '値', 10, { step: 1 })],
    summary: (p) => `お金が ${n(p.value)} ${opLabel(p.op)}`,
  },
  {
    type: 'hp',
    kind: 'condition',
    label: 'HP を比べる',
    icon: 'heart',
    group: 'ゲーム',
    params: [op(), num('value', '値', 50, { step: 1 })],
    summary: (p) => `HP が ${n(p.value)} ${opLabel(p.op)}`,
  },
  {
    type: 'time',
    kind: 'condition',
    label: '経過時間を比べる',
    icon: 'reset',
    group: '時間',
    params: [op(), num('value', '秒', 30, { step: 1, unit: '秒' })],
    summary: (p) => `経過時間が ${n(p.value)}秒 ${opLabel(p.op)}`,
  },
  {
    type: 'item',
    kind: 'condition',
    label: '持ち物を持っている',
    icon: 'key',
    group: 'ゲーム',
    params: [str('item', '持ち物の名前', '鍵'), num('count', '個数', 1, { min: 1, step: 1 })],
    summary: (p) => `持ち物「${s(p.item)}」を ${n(p.count, 1)}個以上持っている`,
  },
  {
    type: 'exists',
    kind: 'condition',
    label: 'オブジェクトが残っている',
    icon: 'cube',
    group: 'オブジェクト',
    params: [ent('target', 'オブジェクト'), { key: 'not', label: '逆 (残っていない)', type: 'boolean', default: false }],
    summary: (p, c) => `${who(c, p.target, '?')}が${p.not ? '残っていない' : '残っている'}`,
  },
  {
    type: 'near',
    kind: 'condition',
    label: '距離が近い',
    icon: 'target',
    group: 'オブジェクト',
    params: [ent('a', 'だれが', { default: 'player', allowPlayer: true }), ent('b', 'なにに', { allowPlayer: true }), num('distance', '距離', 3, { min: 0, step: 0.5, unit: 'm' })],
    summary: (p, c) => `${who(c, p.a)}と${who(c, p.b)}の距離が ${n(p.distance, 3)}m 以内`,
  },
  {
    type: 'random',
    kind: 'condition',
    label: '確率 (ランダム)',
    icon: 'sparkles',
    group: 'その他',
    params: [num('percent', '確率', 50, { min: 0, max: 100, step: 5, unit: '%' })],
    summary: (p) => `${n(p.percent, 50)}% の確率で`,
  },
];

// ------------------------------------------------------------------
// 動作 (なら)
// ------------------------------------------------------------------

const ACTIONS: BlockDef[] = [
  {
    type: 'setVar',
    kind: 'action',
    label: '変数を変える',
    icon: 'sliders',
    group: '変数',
    params: [
      { key: 'name', label: '変数', type: 'variable', default: '' },
      {
        key: 'mode',
        label: '変え方',
        type: 'select',
        default: 'add',
        options: [
          { value: 'set', label: 'にする' },
          { value: 'add', label: 'を増やす' },
          { value: 'sub', label: 'を減らす' },
          { value: 'toggle', label: 'を反転 (はい/いいえ)' },
        ],
      },
      str('value', '値', '1'),
    ],
    summary: (p) => {
      const name = `変数「${s(p.name) || '?'}」`;
      switch (p.mode) {
        case 'set':
          return `${name}を ${s(p.value)} にする`;
        case 'sub':
          return `${name}を ${s(p.value)} 減らす`;
        case 'toggle':
          return `${name}を反転する`;
        default:
          return `${name}を ${s(p.value)} 増やす`;
      }
    },
  },
  {
    type: 'score',
    kind: 'action',
    label: 'スコアを増やす',
    icon: 'trophy',
    group: 'ゲーム',
    params: [num('value', '増やす量 (マイナスで減る)', 10, { step: 10 })],
    summary: (p) => (n(p.value) >= 0 ? `スコアを ${n(p.value)} 増やす` : `スコアを ${-n(p.value)} 減らす`),
  },
  {
    type: 'money',
    kind: 'action',
    label: 'お金を増やす',
    icon: 'coin',
    group: 'ゲーム',
    params: [num('value', '増やす量 (マイナスで減る)', 10, { step: 1 })],
    summary: (p) => (n(p.value) >= 0 ? `お金を ${n(p.value)} 増やす` : `お金を ${-n(p.value)} 減らす`),
  },
  {
    type: 'hp',
    kind: 'action',
    label: 'HP を変える (回復 / ダメージ)',
    icon: 'heart',
    group: 'ゲーム',
    params: [ent('target', 'だれの', { default: 'player', allowPlayer: true }), num('value', '量 (マイナスでダメージ)', 20, { step: 1 })],
    summary: (p, c) => (n(p.value) >= 0 ? `${who(c, p.target)}の HP を ${n(p.value)} 回復` : `${who(c, p.target)}に ${-n(p.value)} ダメージ`),
  },
  {
    type: 'item',
    kind: 'action',
    label: '持ち物をあげる / とる',
    icon: 'key',
    group: 'ゲーム',
    params: [str('item', '持ち物の名前', '鍵'), num('count', '個数 (マイナスでとる)', 1, { step: 1 })],
    summary: (p) => (n(p.count, 1) >= 0 ? `持ち物「${s(p.item)}」を ${n(p.count, 1)}個もらう` : `持ち物「${s(p.item)}」を ${-n(p.count, 1)}個なくす`),
  },
  {
    type: 'sound',
    kind: 'action',
    label: '効果音を鳴らす',
    icon: 'volume',
    group: '音',
    params: [{ key: 'sound', label: '音', type: 'sound', default: 'builtin:powerup' }, num('volume', '音量', 1, { min: 0, max: 1, step: 0.05 })],
    summary: (p, c) => `効果音 ${c.soundName(s(p.sound))} を鳴らす`,
  },
  {
    type: 'timeline',
    kind: 'action',
    label: 'タイムラインを再生',
    icon: 'film',
    group: 'カメラ',
    params: [{ key: 'timeline', label: 'タイムライン', type: 'timeline', default: '' }],
    summary: (p, c) => `${c.timelineName?.(s(p.timeline)) ?? 'タイムライン'}を再生`,
  },
  {
    type: 'camera',
    kind: 'action',
    label: 'カメラを切り替える',
    icon: 'camera',
    group: 'カメラ',
    params: [
      ent('target', 'カメラ', { filter: 'camera', allowPlayer: true }),
      num('seconds', '切り替える時間', 1, { min: 0, max: 30, step: 0.5, unit: '秒', hint: '0 = すぐに切り替える' }),
    ],
    summary: (p, c) =>
      s(p.target) === 'player' ? 'カメラをふだんの視点に戻す' : `カメラを${who(c, p.target, '(未選択)')}に切り替える${n(p.seconds, 1) > 0 ? ` (${n(p.seconds, 1)}秒で)` : ''}`,
  },
  {
    type: 'setTime',
    kind: 'action',
    label: '時刻を変える',
    icon: 'sun',
    group: '環境',
    params: [num('hour', '時刻', 18, { min: 0, max: 24, step: 0.5, unit: '時' })],
    summary: (p) => `時刻を ${n(p.hour, 18)}時にする`,
  },
  {
    type: 'weather',
    kind: 'action',
    label: '天気を変える',
    icon: 'cloud',
    group: '環境',
    params: [{ key: 'weather', label: '天気', type: 'select', default: 'rain', options: WEATHER_OPTIONS }],
    summary: (p) => `天気を${WEATHER_OPTIONS.find((o) => o.value === s(p.weather))?.label ?? '?'}にする`,
  },
  {
    type: 'music',
    kind: 'action',
    label: 'BGM を変える / 止める',
    icon: 'music',
    group: '音',
    params: [{ key: 'source', label: '音楽 (なし = 止める)', type: 'music', default: '' }],
    summary: (p, c) => (s(p.source) ? `BGM を ${c.soundName(s(p.source))} にする` : 'BGM を止める'),
  },
  {
    type: 'message',
    kind: 'action',
    label: 'お知らせを表示',
    icon: 'info',
    group: '画面',
    params: [{ key: 'text', label: '文章', type: 'text', default: 'やったね！', hint: '{score} などで値を表示' }, num('seconds', '表示する時間', 2, { min: 0.5, max: 30, step: 0.5, unit: '秒' })],
    summary: (p) => `お知らせ${q(p.text)}を表示`,
  },
  {
    type: 'dialog',
    kind: 'action',
    label: '会話ウィンドウを表示',
    icon: 'chat',
    group: '画面',
    params: [str('name', '話す人', ''), { key: 'text', label: 'セリフ', type: 'text', default: 'こんにちは！', hint: '空行でページを区切る' }],
    summary: (p) => `会話${q(p.text)}を表示 (閉じるまで待つ)`,
  },
  {
    type: 'setText',
    kind: 'action',
    label: 'UI の文字を変える',
    icon: 'font',
    group: '画面',
    params: [ent('target', 'UI', { filter: 'ui' }), { key: 'text', label: '文字', type: 'text', default: '', hint: '{score} などで値を表示' }],
    summary: (p, c) => `${who(c, p.target, '?')}の文字を${q(p.text)}にする`,
  },
  {
    type: 'visible',
    kind: 'action',
    label: '表示する / かくす',
    icon: 'eye',
    group: 'オブジェクト',
    params: [ent('target', 'オブジェクト / UI', { filter: 'any', allowPlayer: true }), { key: 'visible', label: '表示する', type: 'boolean', default: true }],
    summary: (p, c) => `${who(c, p.target, '?')}を${p.visible === false ? 'かくす' : '表示する'}`,
  },
  {
    type: 'destroy',
    kind: 'action',
    label: 'オブジェクトを消す',
    icon: 'trash',
    group: 'オブジェクト',
    params: [ent('target', 'オブジェクト')],
    summary: (p, c) => `${who(c, p.target, '?')}を消す`,
  },
  {
    type: 'move',
    kind: 'action',
    label: '動かす',
    icon: 'move',
    group: 'オブジェクト',
    params: [
      ent('target', 'オブジェクト', { allowPlayer: true }),
      { key: 'offset', label: '動かす量 (X/Y/Z)', type: 'vec3', default: [0, 2, 0], step: 0.5 },
      num('seconds', 'かける時間', 1, { min: 0, max: 60, step: 0.1, unit: '秒' }),
    ],
    summary: (p, c) => {
      const o = Array.isArray(p.offset) ? (p.offset as number[]) : [0, 0, 0];
      return `${who(c, p.target, '?')}を (${o.join(', ')}) 動かす`;
    },
  },
  {
    type: 'teleport',
    kind: 'action',
    label: '別の場所へ移動 (ワープ)',
    icon: 'target',
    group: 'オブジェクト',
    params: [ent('target', 'だれを', { default: 'player', allowPlayer: true }), ent('dest', 'どこへ (目印のオブジェクト)')],
    summary: (p, c) => `${who(c, p.target)}を${who(c, p.dest, '?')}の場所へ移動`,
  },
  {
    type: 'spawn',
    kind: 'action',
    label: '複製を出す',
    icon: 'duplicate',
    group: 'オブジェクト',
    params: [ent('target', '元のオブジェクト'), ent('at', 'どこに (空 = 元の場所)', { allowPlayer: true, allowAny: true })],
    summary: (p, c) => `${who(c, p.target, '?')}の複製を${s(p.at) ? `${who(c, p.at)}の場所に` : ''}出す`,
  },
  {
    type: 'launch',
    kind: 'action',
    label: '飛ばす (勢いをつける)',
    icon: 'zap',
    group: 'オブジェクト',
    params: [ent('target', 'オブジェクト', { default: 'player', allowPlayer: true }), { key: 'velocity', label: '速さ (X/Y/Z)', type: 'vec3', default: [0, 8, 0], step: 1 }],
    summary: (p, c) => `${who(c, p.target)}を飛ばす`,
  },
  {
    type: 'anim',
    kind: 'action',
    label: 'アニメーションを再生 / 止める',
    icon: 'film',
    group: 'アニメーション・エフェクト',
    params: [
      ent('target', 'オブジェクト', { filter: 'animation', allowPlayer: true }),
      { key: 'clip', label: 'アニメーション', type: 'clip', default: '' },
      {
        key: 'mode',
        label: 'どうする',
        type: 'select',
        default: 'play',
        options: [
          { value: 'play', label: '再生する' },
          { value: 'stop', label: '止める' },
        ],
      },
    ],
    summary: (p, c) => (p.mode === 'stop' ? `${who(c, p.target, '?')}のアニメーションを止める` : `${who(c, p.target, '?')}のアニメーション「${s(p.clip) || '?'}」を再生`),
  },
  {
    type: 'effect',
    kind: 'action',
    label: 'エフェクトを出す (爆発など)',
    icon: 'sparkles',
    group: 'アニメーション・エフェクト',
    params: [
      {
        key: 'preset',
        label: '種類',
        type: 'select',
        default: 'explosion',
        options: [
          { value: 'explosion', label: '爆発' },
          { value: 'sparks', label: '火花' },
          { value: 'smoke', label: '煙' },
          { value: 'magic', label: 'キラキラ' },
          { value: 'confetti', label: '紙吹雪' },
          { value: 'fire', label: '炎' },
        ],
      },
      ent('target', 'どこに', { default: 'player', allowPlayer: true, filter: 'any' }),
      num('scale', '大きさ', 1, { min: 0.1, max: 10, step: 0.1 }),
    ],
    summary: (p, c) => `${who(c, p.target, '?')}の場所に${EFFECT_LABELS[s(p.preset)] ?? 'エフェクト'}を出す`,
  },
  {
    type: 'particles',
    kind: 'action',
    label: 'パーティクルを出す / 止める',
    icon: 'sparkles',
    group: 'アニメーション・エフェクト',
    params: [
      ent('target', 'パーティクル', { filter: 'particles' }),
      {
        key: 'mode',
        label: 'どうする',
        type: 'select',
        default: 'play',
        options: [
          { value: 'play', label: '出す' },
          { value: 'stop', label: '止める' },
        ],
      },
    ],
    summary: (p, c) => `${who(c, p.target, '?')}の粒を${p.mode === 'stop' ? '止める' : '出す'}`,
  },
  {
    type: 'wait',
    kind: 'action',
    label: '待つ',
    icon: 'reset',
    group: '時間',
    params: [num('seconds', '時間', 1, { min: 0, max: 3600, step: 0.5, unit: '秒' })],
    summary: (p) => `${n(p.seconds, 1)}秒待つ`,
  },
  {
    type: 'scene',
    kind: 'action',
    label: 'シーンを切り替える',
    icon: 'layers',
    group: 'ゲーム',
    params: [{ key: 'scene', label: 'シーン', type: 'scene', default: '' }],
    summary: (p, c) => `シーン「${s(p.scene) ? c.sceneName(s(p.scene)) : '?'}」へ移動`,
  },
  {
    type: 'clear',
    kind: 'action',
    label: 'ゲームクリア',
    icon: 'trophy',
    group: 'ゲーム',
    params: [str('message', 'メッセージ (空 = ゲーム設定)', '')],
    summary: (p) => `ゲームクリア${s(p.message) ? q(p.message) : ''}`,
  },
  {
    type: 'gameover',
    kind: 'action',
    label: 'ゲームオーバー',
    icon: 'alert',
    group: 'ゲーム',
    params: [str('message', 'メッセージ (空 = ゲーム設定)', '')],
    summary: (p) => `ゲームオーバー${s(p.message) ? q(p.message) : ''}`,
  },
];

const ALL: BlockDef[] = [...TRIGGERS, ...CONDITIONS, ...ACTIONS];

/** 必ず選ぶ必要がある項目で、未設定のものの名前 (無ければ null) */
export function missingParam(kind: BlockKind, block: EventBlock): string | null {
  const def = getBlockDef(kind, block.type);
  if (!def) return null;
  for (const p of def.params) {
    const v = block.params[p.key];
    const empty = v === '' || v === null || v === undefined;
    if (!empty) continue;
    if ((p.type === 'entity' && !p.allowAny) || p.type === 'scene' || p.type === 'variable' || (p.type === 'timeline' && !p.allowAny)) return p.label;
    if (p.type === 'clip' && block.params.mode !== 'stop') return p.label;
  }
  return null;
}

export function blockDefs(kind: BlockKind): BlockDef[] {
  return kind === 'trigger' ? TRIGGERS : kind === 'condition' ? CONDITIONS : ACTIONS;
}

export function getBlockDef(kind: BlockKind, type: string): BlockDef | undefined {
  return ALL.find((d) => d.kind === kind && d.type === type);
}

export function defaultParams(def: BlockDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of def.params) out[p.key] = Array.isArray(p.default) ? [...p.default] : p.default;
  return out;
}

export function createBlock(kind: BlockKind, type: string, params: Record<string, unknown> = {}): EventBlock {
  const def = getBlockDef(kind, type);
  return { type, params: { ...(def ? defaultParams(def) : {}), ...params } };
}

export function createRule(name = 'イベント', trigger: EventBlock = createBlock('trigger', 'start')): EventRule {
  return { id: createId('ev'), name, enabled: true, once: false, trigger, conditions: [], actions: [], elseActions: [] };
}

export function summarize(kind: BlockKind, block: EventBlock, ctx: SummaryContext): string {
  const def = getBlockDef(kind, block.type);
  if (!def) return `不明な${kind === 'trigger' ? 'トリガー' : kind === 'condition' ? '条件' : '動作'} (${block.type})`;
  try {
    return def.summary(block.params, ctx);
  } catch {
    return def.label;
  }
}

// ------------------------------------------------------------------
// 検証・修復 (読み込んだデータ用)
// ------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function sanitizeParam(def: ParamDef, v: unknown): unknown {
  switch (def.type) {
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return def.default;
      return Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, v));
    case 'boolean':
      return typeof v === 'boolean' ? v : def.default;
    case 'select':
      return def.options?.some((o) => o.value === v) ? v : def.default;
    case 'vec3':
      return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? [...v] : [...(def.default as number[])];
    default:
      return typeof v === 'string' ? v.slice(0, 2000) : def.default;
  }
}

function sanitizeBlock(kind: BlockKind, raw: unknown): EventBlock | null {
  if (!isObj(raw) || typeof raw.type !== 'string') return null;
  const def = getBlockDef(kind, raw.type);
  const params = isObj(raw.params) ? raw.params : {};
  // 知らない種類 (新しいバージョンのデータ) はそのまま残す (実行時は無視)
  if (!def) return { type: raw.type, params: JSON.parse(JSON.stringify(params)) as Obj };
  const out: Obj = {};
  for (const p of def.params) out[p.key] = sanitizeParam(p, params[p.key]);
  return { type: raw.type, params: out };
}

export function sanitizeRules(raw: unknown): EventRule[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  const out: EventRule[] = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    const trigger = sanitizeBlock('trigger', r.trigger) ?? createBlock('trigger', 'start');
    let id = typeof r.id === 'string' ? r.id : createId('ev');
    if (ids.has(id)) id = createId('ev');
    ids.add(id);
    const list = (v: unknown, kind: BlockKind) => (Array.isArray(v) ? v.map((b) => sanitizeBlock(kind, b)).filter((b): b is EventBlock => b !== null) : []);
    out.push({
      id,
      name: typeof r.name === 'string' ? r.name.slice(0, 100) : 'イベント',
      enabled: r.enabled !== false,
      once: r.once === true,
      trigger,
      conditions: list(r.conditions, 'condition'),
      actions: list(r.actions, 'action'),
      elseActions: list(r.elseActions, 'action'),
    });
  }
  return out;
}

export function sanitizeVariables(raw: unknown): VariableDef[] {
  if (!Array.isArray(raw)) return [];
  const names = new Set<string>();
  const out: VariableDef[] = [];
  for (const v of raw) {
    if (!isObj(v) || typeof v.name !== 'string') continue;
    const name = v.name.trim().slice(0, 40);
    if (!name || names.has(name)) continue;
    names.add(name);
    const initial = typeof v.initial === 'number' || typeof v.initial === 'string' || typeof v.initial === 'boolean' ? v.initial : 0;
    out.push({ id: typeof v.id === 'string' ? v.id : createId('var'), name, initial });
  }
  return out;
}

/** 文字列の値を、数値として読めるなら数値にする (変数の比較・代入用) */
export function parseValue(v: unknown): VarValue {
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const t = String(v ?? '').trim();
  if (t === 'true' || t === 'はい') return true;
  if (t === 'false' || t === 'いいえ') return false;
  if (t !== '' && Number.isFinite(Number(t))) return Number(t);
  return t;
}

export function compare(a: VarValue | undefined, op: string, b: VarValue): boolean {
  const left = a ?? 0;
  if (typeof left === 'number' && typeof b === 'number') {
    switch (op) {
      case '>':
        return left > b;
      case '>=':
        return left >= b;
      case '<':
        return left < b;
      case '<=':
        return left <= b;
      case '!=':
        return left !== b;
      default:
        return left === b;
    }
  }
  const eq = String(left) === String(b);
  if (op === '==') return eq;
  if (op === '!=') return !eq;
  // 数値でないものの大小は、数値に変換して比べる
  const ln = Number(left);
  const rn = Number(b);
  if (!Number.isFinite(ln) || !Number.isFinite(rn)) return false;
  return compare(ln, op, rn);
}
