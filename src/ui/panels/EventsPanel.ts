import * as A from '../../core/actions';
import type { BlockDef, BlockKind, EventBlock, EventRule, ParamDef, SummaryContext, VariableDef, VarValue } from '../../core/events';
import { blockDefs, createBlock, createRule, defaultParams, getBlockDef, missingParam, parseValue, summarize } from '../../core/events';
import { BUILTIN_MUSIC, BUILTIN_PREFIX, BUILTIN_SFX, builtinSoundLabel, isBuiltinSound } from '../../core/sounds';
import type { EntityData, Vec3 } from '../../core/types';
import { clone, createId } from '../../core/util';
import type { AppContext } from '../context';
import { button, h, rafThrottle } from '../dom';
import { icon } from '../icons';
import { actionSheet, confirmDialog, openModal, promptDialog, toast } from '../overlays';
import { fieldRow, NumberField, Select, TextArea, TextField, Toggle, Vec3Field } from '../widgets';

/**
 * イベントタブ: ノーコードで「いつ」→「もし」→「なら / そうでなければ」を組み立てる。
 * 1つのイベントはカードで表示し、各項目 (チップ) をタップするとその内容を編集できる。
 * 編集はすべて A.setEvents を通すので、1回の操作 = 1回の Undo になる。
 */

const KIND_TITLE: Record<BlockKind, string> = { trigger: 'いつ', condition: 'もし', action: 'なら' };
const KIND_NOUN: Record<BlockKind, string> = { trigger: 'トリガー', condition: '条件', action: '動作' };

type ListKey = 'conditions' | 'actions' | 'elseActions';

export class EventsPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private header: HTMLElement;
  private schedule = rafThrottle(() => this.render());

  constructor(private ctx: AppContext) {
    this.header = h('div', { class: 'ev-top' });
    this.list = h('div', { class: 'ev-list', attrs: { 'data-testid': 'ev-list' } });
    this.el = h('div', { class: 'panel events-panel', attrs: { 'data-testid': 'events-panel' } }, this.header, this.list);
    const ev = ctx.editor.events;
    for (const type of ['scene-loaded', 'events-changed', 'entity-added', 'entity-removed', 'entity-changed', 'project-changed', 'assets-changed'] as const) {
      ev.on(type, this.schedule);
    }
    this.render();
  }

  private get rules(): EventRule[] {
    return this.ctx.editor.sceneData.events;
  }

  private commit(rules: EventRule[], label: string): void {
    A.setEvents(this.ctx.editor, rules, label);
  }

  private updateRule(id: string, fn: (r: EventRule) => void, label: string): void {
    const rules = clone(this.rules);
    const r = rules.find((x) => x.id === id);
    if (!r) return;
    fn(r);
    this.commit(rules, label);
  }

  // ------------------------------------------------------------------
  // 名前の解決 (要約の文章用)
  // ------------------------------------------------------------------

  private get summaryCtx(): SummaryContext {
    const ed = this.ctx.editor;
    return {
      entityName: (id) => {
        const e = ed.scene.get(id);
        return e ? `「${e.name}」` : '(削除されたオブジェクト)';
      },
      sceneName: (id) => ed.findScene(id)?.name ?? '(削除されたシーン)',
      soundName: (src) => {
        if (!src) return 'なし';
        if (isBuiltinSound(src)) return `「${builtinSoundLabel(src)}」`;
        const a = this.ctx.assets.find(src);
        return a ? `「${a.name}」` : '(見つかりません)';
      },
    };
  }

  // ------------------------------------------------------------------
  // 表示
  // ------------------------------------------------------------------

  render(): void {
    const ed = this.ctx.editor;
    const rules = this.rules;
    this.header.replaceChildren(
      h(
        'div',
        { class: 'panel-intro' },
        h('b', { text: `イベント (${ed.sceneData.name})` }),
        h('span', { text: '「いつ」「もし」「なら」を選ぶだけでゲームの仕組みを作れます' }),
      ),
      h(
        'div',
        { class: 'button-row' },
        button({ icon: 'plus', label: 'イベントを追加', class: 'primary', testId: 'ev-add', onClick: () => this.addRule() }),
        button({ icon: 'sliders', label: `変数 (${ed.project.variables.length})`, class: 'secondary', testId: 'ev-vars', onClick: () => this.openVariables() }),
      ),
    );
    this.list.replaceChildren();
    if (rules.length === 0) {
      this.list.appendChild(
        h(
          'div',
          { class: 'hint-card' },
          h('span', { html: icon('zap', 22) }),
          h('p', { text: '例: 「プレイヤーがコインに触れたとき」→「スコアを 10 増やす」「効果音を鳴らす」。まずは「イベントを追加」を押してください。' }),
        ),
      );
      return;
    }
    rules.forEach((r, i) => this.list.appendChild(this.card(r, i)));
  }

  private card(r: EventRule, index: number): HTMLElement {
    const sc = this.summaryCtx;
    const enabled = new Toggle({ title: '有効', testId: `ev-enabled-${index}`, onChange: (v) => this.updateRule(r.id, (x) => (x.enabled = v), v ? 'イベントを有効化' : 'イベントを無効化') });
    enabled.set(r.enabled);
    const title = h('button', {
      class: 'ev-name',
      attrs: { type: 'button', 'data-testid': `ev-name-${index}` },
      text: r.name,
      on: {
        click: () => {
          void promptDialog('イベントの名前', r.name, { okLabel: '変更', maxLength: 100 }).then((name) => {
            if (name && name.trim()) this.updateRule(r.id, (x) => (x.name = name.trim()), 'イベント名を変更');
          });
        },
      },
    });
    const menu = button({ icon: 'more', title: 'イベントのメニュー', class: 'icon-btn small ghost', testId: `ev-menu-${index}`, onClick: () => this.ruleMenu(r, index) });

    const chip = (kind: BlockKind, block: EventBlock, onTap: () => void, testId: string, prefix?: string) => {
      const def = getBlockDef(kind, block.type);
      return h(
        'button',
        { class: `ev-chip ${kind}${def ? '' : ' unknown'}`, attrs: { type: 'button', 'data-testid': testId }, on: { click: onTap } },
        h('span', { class: 'ev-chip-icon', html: icon(def?.icon ?? 'help', 16) }),
        prefix ? h('span', { class: 'ev-chip-num', text: prefix }) : null,
        h('span', { class: 'ev-chip-text', text: summarize(kind, block, sc) }),
      );
    };
    const addBtn = (label: string, testId: string, onClick: () => void) =>
      h('button', { class: 'ev-add', attrs: { type: 'button', 'data-testid': testId }, on: { click: onClick } }, h('span', { html: icon('plus', 14) }), h('span', { text: label }));

    const row = (label: string, cls: string, children: (HTMLElement | null)[]) =>
      h('div', { class: `ev-row ${cls}` }, h('div', { class: 'ev-label', text: label }), h('div', { class: 'ev-items' }, children));

    const listChips = (key: ListKey, kind: BlockKind, numbered: boolean) =>
      r[key].map((b, i) => chip(kind, b, () => this.editBlock(r.id, key, i), `ev-${key}-${index}-${i}`, numbered ? String(i + 1) : undefined));

    const rows: HTMLElement[] = [
      row('いつ', 'when', [chip('trigger', r.trigger, () => this.editTrigger(r.id), `ev-trigger-${index}`)]),
      row('もし', 'if', [
        ...listChips('conditions', 'condition', false),
        r.conditions.length === 0 ? h('span', { class: 'ev-none', text: '(条件なし = いつでも)' }) : null,
        addBtn('条件', `ev-add-condition-${index}`, () => this.addBlock(r.id, 'conditions', 'condition')),
      ]),
      row('なら', 'then', [...listChips('actions', 'action', true), addBtn('動作', `ev-add-action-${index}`, () => this.addBlock(r.id, 'actions', 'action'))]),
    ];
    if (r.conditions.length > 0 || r.elseActions.length > 0) {
      rows.push(
        row('ちがえば', 'else', [
          ...listChips('elseActions', 'action', true),
          addBtn('動作', `ev-add-else-${index}`, () => this.addBlock(r.id, 'elseActions', 'action')),
        ]),
      );
    }
    return h(
      'div',
      { class: `ev-card${r.enabled ? '' : ' disabled'}`, attrs: { 'data-testid': `ev-card-${index}` } },
      h('div', { class: 'ev-head' }, enabled.el, title, r.once ? h('span', { class: 'ev-badge', text: '1回だけ' }) : null, menu),
      rows,
    );
  }

  private ruleMenu(r: EventRule, index: number): void {
    const rules = this.rules;
    actionSheet(r.name, [
      {
        label: r.once ? '何度でも実行する' : '1回だけ実行する',
        icon: 'check',
        testId: 'ev-once',
        onSelect: () => this.updateRule(r.id, (x) => (x.once = !x.once), '実行回数を変更'),
      },
      {
        label: '複製',
        icon: 'duplicate',
        testId: 'ev-duplicate',
        onSelect: () => {
          const list = clone(rules);
          const copy = { ...clone(r), id: createId('ev'), name: `${r.name} コピー` };
          list.splice(index + 1, 0, copy);
          this.commit(list, 'イベントを複製');
        },
      },
      {
        label: '上へ',
        icon: 'arrowUp',
        disabled: index === 0,
        onSelect: () => {
          const list = clone(rules);
          [list[index - 1], list[index]] = [list[index], list[index - 1]];
          this.commit(list, 'イベントの順番を変更');
        },
      },
      {
        label: '下へ',
        icon: 'arrowDown',
        disabled: index >= rules.length - 1,
        onSelect: () => {
          const list = clone(rules);
          [list[index + 1], list[index]] = [list[index], list[index + 1]];
          this.commit(list, 'イベントの順番を変更');
        },
      },
      'separator',
      {
        label: '削除',
        icon: 'trash',
        danger: true,
        testId: 'ev-delete',
        onSelect: () =>
          this.commit(
            rules.filter((x) => x.id !== r.id),
            'イベントを削除',
          ),
      },
    ]);
  }

  // ------------------------------------------------------------------
  // 追加・編集
  // ------------------------------------------------------------------

  /** 種類の一覧 (グループ見出し付き) から選ぶ */
  private pickType(kind: BlockKind, onPick: (def: BlockDef) => void): void {
    const defs = blockDefs(kind);
    const items: Parameters<typeof actionSheet>[1] = [];
    let group = '';
    for (const d of defs) {
      if (d.group !== group) {
        if (group) items.push('separator');
        group = d.group;
      }
      items.push({ label: d.label, icon: d.icon, hint: d.group, testId: `ev-type-${d.type}`, onSelect: () => onPick(d) });
    }
    actionSheet(`${KIND_TITLE[kind]} (${KIND_NOUN[kind]}) を選ぶ`, items, { testId: 'ev-type-sheet' });
  }

  private addRule(): void {
    this.pickType('trigger', (def) => {
      const create = (params: Record<string, unknown>) => {
        const rule = createRule(`イベント${this.rules.length + 1}`, { type: def.type, params });
        this.commit([...this.rules, rule], 'イベントを追加');
      };
      if (def.params.length === 0) create(defaultParams(def));
      else this.openForm('trigger', { type: def.type, params: defaultParams(def) }, { onOk: (b) => create(b.params) });
    });
  }

  private editTrigger(ruleId: string): void {
    const r = this.rules.find((x) => x.id === ruleId);
    if (!r) return;
    this.openForm('trigger', r.trigger, {
      onOk: (b) => this.updateRule(ruleId, (x) => (x.trigger = b), 'トリガーを変更'),
      allowTypeChange: true,
    });
  }

  private addBlock(ruleId: string, key: ListKey, kind: BlockKind): void {
    this.pickType(kind, (def) => {
      const push = (b: EventBlock) => this.updateRule(ruleId, (x) => x[key].push(b), `${KIND_NOUN[kind]}を追加`);
      if (def.params.length === 0) push(createBlock(kind, def.type));
      else this.openForm(kind, createBlock(kind, def.type), { onOk: push });
    });
  }

  private editBlock(ruleId: string, key: ListKey, index: number): void {
    const r = this.rules.find((x) => x.id === ruleId);
    const block = r?.[key][index];
    if (!r || !block) return;
    const kind: BlockKind = key === 'conditions' ? 'condition' : 'action';
    const len = r[key].length;
    this.openForm(kind, block, {
      onOk: (b) => this.updateRule(ruleId, (x) => (x[key][index] = b), `${KIND_NOUN[kind]}を変更`),
      onDelete: () => this.updateRule(ruleId, (x) => x[key].splice(index, 1), `${KIND_NOUN[kind]}を削除`),
      onMove:
        len > 1
          ? (dir) =>
              this.updateRule(
                ruleId,
                (x) => {
                  const j = index + dir;
                  if (j < 0 || j >= x[key].length) return;
                  [x[key][index], x[key][j]] = [x[key][j], x[key][index]];
                },
                `${KIND_NOUN[kind]}の順番を変更`,
              )
          : undefined,
      allowTypeChange: true,
    });
  }

  /** ブロックのパラメータを編集するフォーム */
  private openForm(
    kind: BlockKind,
    block: EventBlock,
    opts: { onOk(b: EventBlock): void; onDelete?(): void; onMove?(dir: -1 | 1): void; allowTypeChange?: boolean },
  ): void {
    const draft: EventBlock = clone(block);
    const def = getBlockDef(kind, draft.type);
    const body = h('div', { class: 'ev-form', attrs: { 'data-testid': 'ev-form' } });
    const preview = h('div', { class: `ev-preview ${kind}` });
    const updatePreview = () => (preview.textContent = summarize(kind, draft, this.summaryCtx));

    let handle: { close(): void } | null = null;
    const typeRow = def
      ? h(
          'div',
          { class: 'ev-form-type' },
          h('span', { html: icon(def.icon, 18) }),
          h('b', { text: def.label }),
          opts.allowTypeChange
            ? button({
                label: '種類を変える',
                class: 'secondary small',
                testId: 'ev-change-type',
                onClick: () => {
                  handle?.close();
                  this.pickType(kind, (nd) => {
                    const nb: EventBlock = { type: nd.type, params: defaultParams(nd) };
                    if (nd.params.length === 0) opts.onOk(nb);
                    else this.openForm(kind, nb, opts);
                  });
                },
              })
            : null,
        )
      : h('p', { class: 'field-note warn', text: `この${KIND_NOUN[kind]} (${draft.type}) は、このバージョンでは使えません。` });
    body.append(typeRow, preview);
    for (const p of def?.params ?? []) body.appendChild(this.paramField(p, draft, updatePreview));
    updatePreview();

    const actions: { label: string; kind?: 'primary' | 'danger' | 'default'; testId?: string; onClick?: () => boolean | void }[] = [];
    if (opts.onDelete) {
      const del = opts.onDelete;
      actions.push({ label: '削除', kind: 'danger', testId: 'ev-form-delete', onClick: () => del() });
    }
    if (opts.onMove) {
      const move = opts.onMove;
      body.appendChild(
        h(
          'div',
          { class: 'button-row' },
          button({ icon: 'arrowUp', label: '前へ', class: 'secondary small', testId: 'ev-form-up', onClick: () => (move(-1), handle?.close()) }),
          button({ icon: 'arrowDown', label: '後ろへ', class: 'secondary small', testId: 'ev-form-down', onClick: () => (move(1), handle?.close()) }),
        ),
      );
    }
    actions.push({ label: 'キャンセル', testId: 'ev-form-cancel' });
    actions.push({
      label: '決定',
      kind: 'primary',
      testId: 'ev-form-ok',
      onClick: () => {
        const missing = missingParam(kind, draft);
        if (missing) {
          toast(`「${missing}」を選んでください`, 'warn', 2000);
          return false;
        }
        opts.onOk(draft);
      },
    });
    handle = openModal({ title: `${KIND_TITLE[kind]} (${KIND_NOUN[kind]})`, content: body, actions, testId: 'ev-form-modal', className: 'ev-modal' });
  }

  // ------------------------------------------------------------------
  // パラメータの入力欄
  // ------------------------------------------------------------------

  private entityOptions(p: ParamDef): { value: string; label: string }[] {
    const ed = this.ctx.editor;
    const out: { value: string; label: string }[] = [];
    if (p.allowAny) out.push({ value: '', label: '(どれでも)' });
    else out.push({ value: '', label: '(選んでください)' });
    if (p.allowPlayer) out.push({ value: 'player', label: '★ プレイヤー' });
    const ok = (e: EntityData) => {
      switch (p.filter) {
        case 'ui':
          return e.kind === 'ui';
        case 'button':
          return e.kind === 'ui' && e.ui?.type === 'button';
        case 'any':
          return true;
        case 'animation':
          return e.components.some((c) => c.type === 'animation');
        case 'particles':
          return e.components.some((c) => c.type === 'particles');
        default:
          return e.kind !== 'ui';
      }
    };
    for (const e of ed.scene.ordered()) {
      if (!ok(e)) continue;
      const depth = ed.scene.depth(e.id);
      out.push({ value: e.id, label: `${'  '.repeat(depth)}${e.name}` });
    }
    return out;
  }

  private soundOptions(music: boolean): { value: string; label: string }[] {
    const out: { value: string; label: string }[] = [];
    if (music) out.push({ value: '', label: '(なし = BGM を止める)' });
    for (const s of music ? BUILTIN_MUSIC : BUILTIN_SFX) out.push({ value: `${BUILTIN_PREFIX}${s.id}`, label: `${s.label} (組み込み)` });
    for (const a of this.ctx.assets.byType('audio')) out.push({ value: a.id, label: a.name });
    return out;
  }

  private paramField(p: ParamDef, draft: EventBlock, changed: () => void): HTMLElement {
    const set = (v: unknown) => {
      draft.params[p.key] = v;
      changed();
    };
    const cur = draft.params[p.key];
    const testId = `ev-param-${p.key}`;
    const label = p.unit ? `${p.label} (${p.unit})` : p.label;
    switch (p.type) {
      case 'number': {
        const f = new NumberField({ step: p.step ?? 1, min: p.min, max: p.max, title: p.label, testId, onChange: (v) => set(v) });
        f.set(typeof cur === 'number' ? cur : Number(p.default) || 0);
        return fieldRow(label, f.el, { hint: p.hint });
      }
      case 'boolean': {
        const t = new Toggle({ title: p.label, testId, onChange: (v) => set(v) });
        t.set(cur === true);
        return fieldRow(label, t.el, { hint: p.hint });
      }
      case 'select': {
        const sel = new Select({ options: p.options ?? [], title: p.label, testId, onChange: (v) => set(v) });
        sel.set(String(cur ?? p.default));
        return fieldRow(label, sel.el, { hint: p.hint });
      }
      case 'text': {
        const t = new TextArea({ title: p.label, testId, rows: 3, onChange: (v) => set(v) });
        t.set(String(cur ?? ''));
        // 入力中も要約を更新する
        t.el.addEventListener('input', () => set(t.el.value));
        return fieldRow(label, t.el, { stacked: true, hint: p.hint });
      }
      case 'vec3': {
        const v: Vec3 = Array.isArray(cur) && cur.length === 3 ? ([...cur] as Vec3) : [0, 0, 0];
        const f = new Vec3Field({
          title: p.label,
          step: p.step ?? 0.5,
          onChange: (axis, val) => {
            v[axis] = val;
            set([...v]);
          },
        });
        f.set(v);
        return fieldRow(label, f.el, { stacked: true, hint: p.hint });
      }
      case 'entity':
      case 'sound':
      case 'music':
      case 'scene': {
        const options =
          p.type === 'entity'
            ? this.entityOptions(p)
            : p.type === 'scene'
              ? [{ value: '', label: '(選んでください)' }, ...this.ctx.editor.project.scenes.map((s) => ({ value: s.id, label: s.name }))]
              : this.soundOptions(p.type === 'music');
        const sel = new Select({ options, title: p.label, testId, onChange: (v) => set(v) });
        const value = String(cur ?? '');
        if (value && !options.some((o) => o.value === value)) {
          sel.el.appendChild(h('option', { text: '(見つかりません)', props: { value } }));
        }
        sel.el.value = value;
        return fieldRow(label, sel.el, { hint: p.hint });
      }
      case 'clip': {
        // シーン内のアニメーションの名前から選ぶ
        const names = new Set<string>();
        for (const e of this.ctx.editor.scene.ordered()) {
          for (const c of e.components) {
            if (c.type !== 'animation' || !Array.isArray(c.props.clips)) continue;
            for (const clip of c.props.clips as { name?: unknown }[]) if (typeof clip.name === 'string') names.add(clip.name);
          }
        }
        const value = String(cur ?? '');
        if (value) names.add(value);
        const options = [{ value: '', label: names.size ? '(選んでください)' : '(アニメーションがありません)' }, ...[...names].map((n) => ({ value: n, label: n }))];
        const sel = new Select({ options, title: p.label, testId, onChange: (v) => set(v) });
        sel.el.value = value;
        return fieldRow(label, sel.el, { hint: p.hint ?? 'オブジェクトの「アニメーション」で作った名前' });
      }
      case 'variable': {
        const sel = h('select', { class: 'select', attrs: { 'aria-label': p.label, 'data-testid': testId } });
        const fill = (selected: string) => {
          sel.replaceChildren(h('option', { text: '(選んでください)', props: { value: '' } }));
          for (const v of this.ctx.editor.project.variables) sel.appendChild(h('option', { text: v.name, props: { value: v.name } }));
          if (selected && !this.ctx.editor.project.variables.some((v) => v.name === selected)) {
            sel.appendChild(h('option', { text: `${selected} (未登録)`, props: { value: selected } }));
          }
          sel.appendChild(h('option', { text: '＋ 新しい変数…', props: { value: '__new' } }));
          sel.value = selected;
        };
        fill(String(cur ?? ''));
        sel.addEventListener('change', () => {
          if (sel.value !== '__new') {
            set(sel.value);
            return;
          }
          void promptDialog('新しい変数の名前', '', { okLabel: '作成', maxLength: 40, placeholder: '例: 倒した数' }).then((name) => {
            const n = name?.trim();
            if (!n) {
              fill(String(draft.params[p.key] ?? ''));
              return;
            }
            this.ensureVariable(n);
            set(n);
            fill(n);
          });
        });
        return fieldRow(label, sel, { hint: p.hint ?? '変数は「変数」ボタンでまとめて管理できます' });
      }
      default: {
        const t = new TextField({ title: p.label, testId, maxLength: 200, onChange: (v) => set(v) });
        t.set(String(cur ?? ''));
        t.el.addEventListener('input', () => set(t.el.value));
        return fieldRow(label, t.el, { hint: p.hint });
      }
    }
  }

  // ------------------------------------------------------------------
  // 変数
  // ------------------------------------------------------------------

  private ensureVariable(name: string, initial: VarValue = 0): void {
    const vars = this.ctx.editor.project.variables;
    if (vars.some((v) => v.name === name)) return;
    A.setVariables(this.ctx.editor, [...clone(vars), { id: createId('var'), name, initial }], `変数「${name}」を追加`);
  }

  private openVariables(): void {
    const ed = this.ctx.editor;
    const body = h('div', { class: 'ev-vars', attrs: { 'data-testid': 'ev-vars-list' } });
    const render = () => {
      const vars = ed.project.variables;
      body.replaceChildren(
        h('p', { class: 'field-note', text: '変数はゲーム全体で使える値です (シーンを移動しても残ります)。UI の文字で {var:名前} と書くと表示できます。' }),
      );
      if (vars.length === 0) body.appendChild(h('p', { class: 'ev-none', text: '変数はまだありません' }));
      vars.forEach((v, i) => {
        const initial = new TextField({
          title: `${v.name} の最初の値`,
          testId: `ev-var-initial-${i}`,
          onChange: (val) => this.updateVariable(v.id, (x) => (x.initial = parseValue(val))),
        });
        initial.set(String(v.initial));
        body.appendChild(
          h(
            'div',
            { class: 'ev-var-row' },
            h('b', { class: 'ev-var-name', text: v.name }),
            h('span', { class: 'ev-var-label', text: '最初の値' }),
            initial.el,
            button({
              icon: 'trash',
              title: '削除',
              class: 'icon-btn small ghost',
              onClick: () => {
                void confirmDialog(`変数「${v.name}」を削除しますか？ (イベントの中の「${v.name}」は未登録になります)`, { title: '変数を削除', okLabel: '削除', danger: true }).then((ok) => {
                  if (!ok) return;
                  A.setVariables(ed, ed.project.variables.filter((x) => x.id !== v.id), `変数「${v.name}」を削除`);
                  render();
                });
              },
            }),
          ),
        );
      });
      body.appendChild(
        button({
          icon: 'plus',
          label: '変数を追加',
          class: 'secondary wide',
          testId: 'ev-var-add',
          onClick: () => {
            void promptDialog('新しい変数の名前', '', { okLabel: '作成', maxLength: 40, placeholder: '例: 倒した数' }).then((name) => {
              const n = name?.trim();
              if (!n) return;
              if (ed.project.variables.some((v) => v.name === n)) {
                toast('同じ名前の変数があります', 'warn');
                return;
              }
              this.ensureVariable(n);
              render();
            });
          },
        }),
      );
    };
    render();
    openModal({ title: '変数', content: body, actions: [{ label: '閉じる', kind: 'primary', testId: 'ev-vars-close' }], testId: 'ev-vars-modal' });
  }

  private updateVariable(id: string, fn: (v: VariableDef) => void): void {
    const vars = clone(this.ctx.editor.project.variables);
    const v = vars.find((x) => x.id === id);
    if (!v) return;
    fn(v);
    A.setVariables(this.ctx.editor, vars, `変数「${v.name}」を変更`);
  }
}
