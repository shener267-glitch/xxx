import type { EventRule, VariableDef } from './events';
import { createBlock, createRule } from './events';
import type { EntityData } from './types';
import { createId } from './util';

/**
 * イベントの「ひな形」: よく使う仕組み (スイッチでドアを開ける・鍵でドアを開ける など) を、
 * 対象のオブジェクトを選ぶだけで作る。作られるのはふつうのイベントなので、あとから自由に直せる。
 */

export interface TemplateField {
  key: string;
  label: string;
  type: 'entity' | 'string' | 'number';
  hint?: string;
  /** entity: 最初に選んでおく候補 (名前・タグ・役割で推測) */
  guess?: (e: EntityData) => boolean;
  default?: string | number;
  min?: number;
  step?: number;
}

export type TemplateValues = Record<string, string | number>;

export interface TemplateContext {
  /** シーンのオブジェクト (数を数える・名前を使う) */
  entities: EntityData[];
  entityName(id: string): string;
}

export interface EventTemplate {
  id: string;
  label: string;
  description: string;
  icon: string;
  fields: TemplateField[];
  build(values: TemplateValues, ctx: TemplateContext): { rules: EventRule[]; variables: VariableDef[] };
}

const nameIs = (re: RegExp) => (e: EntityData) => re.test(e.name) || e.tags.some((t) => re.test(t));
const hasComp = (type: string) => (e: EntityData) => e.components.some((c) => c.type === type);

const str = (v: TemplateValues, key: string, d = '') => (typeof v[key] === 'string' ? (v[key] as string) : d);
const num = (v: TemplateValues, key: string, d: number) => (typeof v[key] === 'number' && Number.isFinite(v[key]) ? (v[key] as number) : d);

export const EVENT_TEMPLATES: EventTemplate[] = [
  {
    id: 'switch-door',
    label: 'スイッチでドアを開ける',
    description: 'プレイヤーがスイッチを踏むと、ドアが上に開く',
    icon: 'target',
    fields: [
      { key: 'switch', label: 'スイッチ', type: 'entity', guess: nameIs(/スイッチ|ボタン|switch/i) },
      { key: 'door', label: '開くドア', type: 'entity', guess: nameIs(/ドア|扉|門|door|gate/i) },
      { key: 'height', label: '開く高さ (m)', type: 'number', default: 3, min: 0.5, step: 0.5 },
    ],
    build(v, ctx) {
      const r = createRule(`${ctx.entityName(str(v, 'switch'))}でドアを開ける`, createBlock('trigger', 'touch', { a: 'player', b: str(v, 'switch') }));
      r.once = true;
      r.actions.push(
        createBlock('action', 'sound', { sound: 'builtin:click' }),
        createBlock('action', 'move', { target: str(v, 'switch'), offset: [0, -0.06, 0], seconds: 0.2 }),
        createBlock('action', 'sound', { sound: 'builtin:powerup' }),
        createBlock('action', 'move', { target: str(v, 'door'), offset: [0, num(v, 'height', 3), 0], seconds: 1.2 }),
        createBlock('action', 'message', { text: `${ctx.entityName(str(v, 'door'))}が開いた！`, seconds: 2 }),
      );
      return { rules: [r], variables: [] };
    },
  },
  {
    id: 'key-door',
    label: '鍵でドアを開ける',
    description: '持ち物 (鍵) を持ってドアに触れると開く。持っていなければ「鍵がかかっている」',
    icon: 'key',
    fields: [
      { key: 'door', label: 'ドア', type: 'entity', guess: nameIs(/ドア|扉|門|door|gate/i) },
      { key: 'item', label: '必要な持ち物', type: 'string', default: '鍵' },
      { key: 'height', label: '開く高さ (m)', type: 'number', default: 3, min: 0.5, step: 0.5 },
    ],
    build(v, ctx) {
      const item = str(v, 'item', '鍵').trim() || '鍵';
      const door = str(v, 'door');
      const r = createRule(`「${item}」で${ctx.entityName(door)}を開ける`, createBlock('trigger', 'touch', { a: 'player', b: door }));
      r.once = true;
      r.conditions.push(createBlock('condition', 'item', { item, count: 1 }));
      r.actions.push(
        createBlock('action', 'sound', { sound: 'builtin:powerup' }),
        createBlock('action', 'item', { item, count: -1 }),
        createBlock('action', 'move', { target: door, offset: [0, num(v, 'height', 3), 0], seconds: 1.2 }),
        createBlock('action', 'message', { text: `「${item}」で扉を開けた！`, seconds: 2 }),
      );
      r.elseActions.push(createBlock('action', 'message', { text: `鍵がかかっている… 「${item}」が必要だ`, seconds: 2 }));
      return { rules: [r], variables: [] };
    },
  },
  {
    id: 'talk-item',
    label: '話しかけると持ち物をもらえる',
    description: 'NPC に話しかけると、1 回だけ持ち物をもらえる',
    icon: 'chat',
    fields: [
      { key: 'npc', label: '話しかける相手', type: 'entity', guess: hasComp('npc') },
      { key: 'item', label: 'もらえる持ち物', type: 'string', default: '鍵' },
    ],
    build(v, ctx) {
      const item = str(v, 'item', '鍵').trim() || '鍵';
      const r = createRule(`${ctx.entityName(str(v, 'npc'))}から「${item}」をもらう`, createBlock('trigger', 'talk', { target: str(v, 'npc') }));
      r.once = true;
      r.actions.push(createBlock('action', 'item', { item, count: 1 }), createBlock('action', 'sound', { sound: 'builtin:item' }), createBlock('action', 'message', { text: `「${item}」をもらった！`, seconds: 2 }));
      return { rules: [r], variables: [] };
    },
  },
  {
    id: 'defeat-all',
    label: '敵を全部倒したらクリア',
    description: '変数「残りの敵」で数え、0 になったらゲームクリア',
    icon: 'enemy',
    fields: [],
    build(_v, ctx) {
      const count = ctx.entities.filter(hasComp('enemy')).length;
      const name = '残りの敵';
      const count1 = createRule('敵を倒したら数を減らす', createBlock('trigger', 'defeated', { target: '' }));
      count1.actions.push(createBlock('action', 'setVar', { name, mode: 'add', value: '-1' }));
      const clear = createRule('敵が 0 になったらクリア', createBlock('trigger', 'condition'));
      clear.once = true;
      clear.conditions.push(createBlock('condition', 'var', { name, op: '<=', value: '0' }));
      clear.actions.push(createBlock('action', 'message', { text: '敵を全部倒した！', seconds: 2 }), createBlock('action', 'wait', { seconds: 1 }), createBlock('action', 'clear', { message: '' }));
      return { rules: [count1, clear], variables: [{ id: createId('var'), name, initial: count }] };
    },
  },
  {
    id: 'score-clear',
    label: 'スコアを集めたらクリア',
    description: 'スコアが決めた数に届いたらゲームクリア',
    icon: 'trophy',
    fields: [{ key: 'score', label: '目標のスコア', type: 'number', default: 100, min: 1, step: 10 }],
    build(v) {
      const n = num(v, 'score', 100);
      const r = createRule(`スコア ${n} でクリア`, createBlock('trigger', 'condition'));
      r.once = true;
      r.conditions.push(createBlock('condition', 'score', { op: '>=', value: n }));
      r.actions.push(createBlock('action', 'sound', { sound: 'builtin:win' }), createBlock('action', 'clear', { message: `スコア ${n} 達成！` }));
      return { rules: [r], variables: [] };
    },
  },
  {
    id: 'warp',
    label: '触れたら別の場所へワープ',
    description: '入口に触れると、出口の場所へ移動する',
    icon: 'target',
    fields: [
      { key: 'from', label: '入口', type: 'entity' },
      { key: 'to', label: '出口 (目印)', type: 'entity' },
    ],
    build(v, ctx) {
      const r = createRule(`${ctx.entityName(str(v, 'from'))}からワープ`, createBlock('trigger', 'touch', { a: 'player', b: str(v, 'from') }));
      r.actions.push(
        createBlock('action', 'sound', { sound: 'builtin:powerup' }),
        createBlock('action', 'teleport', { target: 'player', dest: str(v, 'to') }),
        createBlock('action', 'effect', { preset: 'magic', target: 'player', scale: 1 }),
      );
      return { rules: [r], variables: [] };
    },
  },
];

/** 必ず選ぶ項目 (オブジェクト) が選ばれているか */
export function templateReady(t: EventTemplate, values: TemplateValues): string | null {
  for (const f of t.fields) {
    if (f.type === 'entity' && !str(values, f.key)) return f.label;
  }
  return null;
}
