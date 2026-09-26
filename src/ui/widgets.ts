import type { Vec3 } from '../core/types';
import { clamp, evaluateExpression, hexToRgb, normalizeHex, rgbToHex } from '../core/util';
import { button, h, isTouchDevice } from './dom';
import { icon } from './icons';
import { openModal } from './overlays';

/**
 * Inspector などで使う入力部品。
 * スマホでは OS のキーボードを出さずに「専用テンキー」で数値を入力でき、
 * 左右ドラッグで値を連続的に変えられる (スクラブ操作)。
 */

export function formatNumber(v: number, precision = 3): string {
  if (!Number.isFinite(v)) return '0';
  const s = v.toFixed(precision);
  const trimmed = s.includes('.') ? s.replace(/\.?0+$/, '') : s;
  return trimmed === '-0' ? '0' : trimmed;
}

// ------------------------------------------------------------------
// テンキー
// ------------------------------------------------------------------

export interface NumPadOptions {
  title: string;
  value: number;
  min?: number;
  max?: number;
  onSubmit: (v: number) => void;
}

export function openNumPad(opts: NumPadOptions): void {
  let text = formatNumber(opts.value, 4);
  let fresh = true; // 最初のキー入力で値を置き換える
  const display = h('div', { class: 'numpad-display', attrs: { 'data-testid': 'numpad-display' } });
  const error = h('div', { class: 'numpad-error' });
  const render = () => {
    display.textContent = text || '0';
    display.classList.toggle('fresh', fresh);
    const v = evaluateExpression(text);
    error.textContent = text && v === null ? '計算できない式です' : '';
  };
  const press = (k: string) => {
    if (k === 'back') {
      text = fresh ? '' : text.slice(0, -1);
      fresh = false;
    } else if (k === 'clear') {
      text = '';
      fresh = false;
    } else if (k === 'neg') {
      const v = evaluateExpression(text);
      text = v !== null ? formatNumber(-v, 6) : text.startsWith('-') ? text.slice(1) : `-${text}`;
      fresh = false;
    } else if (k === '-' && fresh) {
      // 最初に「−」を押したら負の数の入力を始める
      text = '-';
      fresh = false;
    } else if (k === '+' || k === '-' || k === '*' || k === '/') {
      // 現在の値に対する計算 (例: 「+1」で 1 増やす)
      text = `${text}${k}`;
      fresh = false;
    } else {
      text = fresh ? k : text + k;
      fresh = false;
    }
    render();
  };
  const submit = (): boolean => {
    const v = evaluateExpression(text || '0');
    if (v === null) {
      render();
      return false;
    }
    let out = v;
    if (opts.min !== undefined) out = Math.max(opts.min, out);
    if (opts.max !== undefined) out = Math.min(opts.max, out);
    opts.onSubmit(out);
    return true;
  };

  const keys: [string, string, string?][] = [
    ['7', '7'], ['8', '8'], ['9', '9'], ['back', '⌫', 'fn'],
    ['4', '4'], ['5', '5'], ['6', '6'], ['clear', 'C', 'fn'],
    ['1', '1'], ['2', '2'], ['3', '3'], ['neg', '±', 'fn'],
    ['0', '0'], ['.', '.'], ['-', '−', 'op'], ['+', '+', 'op'],
  ];
  const grid = h('div', { class: 'numpad-grid' });
  for (const [k, label, kind] of keys) {
    grid.appendChild(
      h('button', {
        class: `numpad-key ${kind ?? ''}`.trim(),
        text: label,
        attrs: { type: 'button', 'data-key': k },
        on: { click: () => press(k) },
      }),
    );
  }
  const content = h('div', { class: 'numpad' }, display, error, grid);
  // 物理キーボードでも入力できるようにする
  const onKey = (e: KeyboardEvent) => {
    if (/^[0-9.]$/.test(e.key) || ['+', '-', '*', '/'].includes(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('back');
    else if (e.key === 'Enter') {
      if (submit()) modal.close();
    } else return;
    e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  const modal = openModal({
    title: opts.title,
    content,
    className: 'numpad-modal',
    testId: 'numpad',
    actions: [
      { label: 'キャンセル' },
      { label: '決定', kind: 'primary', testId: 'numpad-ok', onClick: () => submit() },
    ],
    onClose: () => window.removeEventListener('keydown', onKey),
  });
  render();
}

// ------------------------------------------------------------------
// 数値フィールド
// ------------------------------------------------------------------

export interface NumberFieldOptions {
  label?: string;
  axis?: 'x' | 'y' | 'z';
  /** ドラッグ 10px あたりの変化量 */
  step?: number;
  min?: number;
  max?: number;
  precision?: number;
  /** テンキーに表示する名前 */
  title?: string;
  testId?: string;
  onChange: (value: number) => void;
}

export class NumberField {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private value = 0;
  private editing = false;

  constructor(private opts: NumberFieldOptions) {
    this.input = h('input', {
      class: 'num-input',
      attrs: { type: 'text', inputmode: 'decimal', 'data-testid': opts.testId, 'aria-label': opts.title ?? opts.label, enterkeyhint: 'done' },
      props: { readOnly: true, value: '0' },
    });
    this.el = h(
      'div',
      { class: `num-field ${opts.axis ? `axis-${opts.axis}` : ''}`.trim() },
      opts.label ? h('span', { class: 'num-label', text: opts.label }) : null,
      this.input,
    );
    this.bindPointer();
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.input.blur();
      } else if (e.key === 'Escape') {
        this.input.value = formatNumber(this.value, this.opts.precision ?? 3);
        this.input.blur();
      }
    });
    this.input.addEventListener('blur', () => {
      if (!this.editing) return;
      this.editing = false;
      this.input.readOnly = true;
      const v = evaluateExpression(this.input.value);
      if (v !== null) this.commit(v);
      else this.input.value = formatNumber(this.value, this.opts.precision ?? 3);
    });
  }

  private clampValue(v: number): number {
    let out = v;
    if (this.opts.min !== undefined) out = Math.max(this.opts.min, out);
    if (this.opts.max !== undefined) out = Math.min(this.opts.max, out);
    return out;
  }

  private commit(v: number): void {
    const c = this.clampValue(v);
    this.value = c;
    this.input.value = formatNumber(c, this.opts.precision ?? 3);
    this.opts.onChange(c);
  }

  private bindPointer(): void {
    let start: { x: number; y: number; v: number; id: number; type: string } | null = null;
    let scrubbing = false;
    this.el.addEventListener('pointerdown', (e) => {
      if (this.editing || this.el.classList.contains('disabled')) return;
      start = { x: e.clientX, y: e.clientY, v: this.value, id: e.pointerId, type: e.pointerType };
      scrubbing = false;
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!scrubbing) {
        // 縦方向の動きはスクロールとみなす
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
          start = null;
          return;
        }
        if (Math.abs(dx) < 6) return;
        scrubbing = true;
        this.el.classList.add('scrubbing');
        try {
          this.el.setPointerCapture(e.pointerId);
        } catch {
          // 無視
        }
      }
      e.preventDefault();
      const step = this.opts.step ?? 0.1;
      const raw = start.v + (dx / 10) * step;
      // ステップ単位に丸める
      const snapped = Math.round(raw / step) * step;
      const v = this.clampValue(parseFloat(snapped.toFixed(6)));
      if (v !== this.value) this.commit(v);
    });
    const end = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      const wasScrub = scrubbing;
      const type = start.type;
      start = null;
      scrubbing = false;
      this.el.classList.remove('scrubbing');
      if (wasScrub || e.type === 'pointercancel') return;
      // タップ: タッチはテンキー、マウスは直接入力
      if (type === 'mouse' && !isTouchDevice()) {
        this.editing = true;
        this.input.readOnly = false;
        this.input.focus();
        this.input.select();
      } else {
        openNumPad({
          title: this.opts.title ?? this.opts.label ?? '数値',
          value: this.value,
          min: this.opts.min,
          max: this.opts.max,
          onSubmit: (v) => this.commit(v),
        });
      }
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
  }

  /** 表示値を更新 (null = 複数選択で値が異なる) */
  set(v: number | null): void {
    if (this.editing) return;
    if (v === null) {
      this.input.value = '—';
      this.el.classList.add('mixed');
      return;
    }
    this.el.classList.remove('mixed');
    this.value = v;
    const text = formatNumber(v, this.opts.precision ?? 3);
    if (this.input.value !== text) this.input.value = text;
  }

  setDisabled(disabled: boolean): void {
    this.el.classList.toggle('disabled', disabled);
  }
}

// ------------------------------------------------------------------
// Vec3 (X/Y/Z)
// ------------------------------------------------------------------

export interface Vec3FieldOptions {
  step?: number;
  min?: number;
  precision?: number;
  title: string;
  testId?: string;
  onChange: (axis: 0 | 1 | 2, value: number) => void;
}

export class Vec3Field {
  readonly el: HTMLElement;
  readonly fields: NumberField[];

  constructor(opts: Vec3FieldOptions) {
    const axes = ['x', 'y', 'z'] as const;
    this.fields = axes.map(
      (a, i) =>
        new NumberField({
          label: a.toUpperCase(),
          axis: a,
          step: opts.step,
          min: opts.min,
          precision: opts.precision,
          title: `${opts.title} ${a.toUpperCase()}`,
          testId: opts.testId ? `${opts.testId}-${a}` : undefined,
          onChange: (v) => opts.onChange(i as 0 | 1 | 2, v),
        }),
    );
    this.el = h('div', { class: 'vec3-field' }, this.fields.map((f) => f.el));
  }

  set(v: Vec3 | (number | null)[]): void {
    this.fields.forEach((f, i) => f.set(v[i] ?? null));
  }
}

// ------------------------------------------------------------------
// スライダー
// ------------------------------------------------------------------

export interface SliderOptions {
  min: number;
  max: number;
  step: number;
  title: string;
  testId?: string;
  onChange: (v: number) => void;
}

export class Slider {
  readonly el: HTMLElement;
  private range: HTMLInputElement;
  private number: NumberField;

  constructor(opts: SliderOptions) {
    this.range = h('input', {
      class: 'range',
      attrs: { type: 'range', min: opts.min, max: opts.max, step: opts.step, 'aria-label': opts.title, 'data-testid': opts.testId },
    });
    this.number = new NumberField({
      step: opts.step * 5,
      min: opts.min,
      precision: 2,
      title: opts.title,
      onChange: (v) => {
        this.range.value = String(v);
        opts.onChange(v);
      },
    });
    this.range.addEventListener('input', () => {
      const v = parseFloat(this.range.value);
      this.number.set(v);
      opts.onChange(v);
    });
    this.el = h('div', { class: 'slider' }, this.range, this.number.el);
  }

  set(v: number | null): void {
    if (v !== null) this.range.value = String(v);
    this.number.set(v);
  }
}

// ------------------------------------------------------------------
// トグルスイッチ
// ------------------------------------------------------------------

export class Toggle {
  readonly el: HTMLButtonElement;
  private value = false;

  constructor(opts: { title: string; testId?: string; onChange: (v: boolean) => void }) {
    this.el = h('button', {
      class: 'toggle',
      attrs: { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': opts.title, 'data-testid': opts.testId },
      on: {
        click: () => {
          this.set(!this.value);
          opts.onChange(this.value);
        },
      },
    });
    this.el.appendChild(h('span', { class: 'toggle-thumb' }));
  }

  set(v: boolean | null): void {
    this.value = !!v;
    this.el.setAttribute('aria-checked', String(this.value));
    this.el.classList.toggle('on', this.value);
    this.el.classList.toggle('mixed', v === null);
  }
}

// ------------------------------------------------------------------
// セレクト
// ------------------------------------------------------------------

export class Select<T extends string = string> {
  readonly el: HTMLSelectElement;

  constructor(opts: { options: { value: T; label: string }[]; title: string; testId?: string; onChange: (v: T) => void }) {
    this.el = h('select', {
      class: 'select',
      attrs: { 'aria-label': opts.title, 'data-testid': opts.testId },
      on: { change: () => opts.onChange(this.el.value as T) },
    });
    for (const o of opts.options) this.el.appendChild(h('option', { text: o.label, props: { value: o.value } }));
  }

  set(v: T | null): void {
    if (v !== null && this.el.value !== v) this.el.value = v;
  }
}

// ------------------------------------------------------------------
// テキスト
// ------------------------------------------------------------------

export class TextField {
  readonly el: HTMLInputElement;

  constructor(opts: { title: string; placeholder?: string; testId?: string; maxLength?: number; onChange: (v: string) => void }) {
    this.el = h('input', {
      class: 'text-input',
      attrs: {
        type: 'text',
        'aria-label': opts.title,
        placeholder: opts.placeholder,
        maxlength: opts.maxLength ?? 100,
        'data-testid': opts.testId,
        enterkeyhint: 'done',
      },
    });
    let committed = '';
    const commit = () => {
      if (this.el.value !== committed) {
        committed = this.el.value;
        opts.onChange(this.el.value);
      }
    };
    this.el.addEventListener('focus', () => (committed = this.el.value));
    this.el.addEventListener('change', commit);
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        this.el.blur();
      }
    });
  }

  set(v: string): void {
    if (document.activeElement === this.el) return;
    if (this.el.value !== v) this.el.value = v;
  }
}

// ------------------------------------------------------------------
// 色
// ------------------------------------------------------------------

const PRESET_COLORS = [
  '#ffffff', '#d9dde3', '#8a9099', '#4a4f58', '#1c1f24', '#000000',
  '#ff4d4f', '#ff7a45', '#ffa940', '#ffd666', '#bae637', '#52c41a',
  '#36cfc9', '#40a9ff', '#4c8dff', '#597ef7', '#9254de', '#f759ab',
  '#8b5a2b', '#c9a27a', '#6b8e23', '#2f4f4f', '#b0c4de', '#ffe4c4',
];

const RECENT_KEY = 'pocket-engine:recent-colors';

function recentColors(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string').slice(0, 12) : [];
  } catch {
    return [];
  }
}

function pushRecent(color: string): void {
  try {
    const list = [color, ...recentColors().filter((c) => c !== color)].slice(0, 12);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // 無視
  }
}

/**
 * RGB スライダー・HEX 入力・パレットで色を選ぶ。
 * 選択中はリアルタイムにプレビュー (onChange) し、キャンセルで元の色に戻す。
 */
export function openColorPicker(title: string, initial: string, onChange: (hex: string) => void): void {
  const original = normalizeHex(initial) ?? '#ffffff';
  let current = original;
  const preview = h('div', { class: 'cp-preview' }, h('div', { class: 'cp-before', style: `background:${original}` }), h('div', { class: 'cp-after' }));
  const after = preview.lastElementChild as HTMLElement;
  const hexInput = h('input', {
    class: 'text-input cp-hex',
    attrs: { type: 'text', maxlength: 7, 'aria-label': 'HEX', 'data-testid': 'color-hex', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'done' },
  });
  const channels = (['R', 'G', 'B'] as const).map((name, i) => {
    const range = h('input', { class: `range cp-range cp-${name.toLowerCase()}`, attrs: { type: 'range', min: 0, max: 255, step: 1, 'aria-label': name } });
    const num = new NumberField({
      step: 5,
      min: 0,
      max: 255,
      precision: 0,
      title: name,
      testId: `color-${name.toLowerCase()}`,
      onChange: (v) => {
        const rgb = hexToRgb(current);
        rgb[i] = clamp(Math.round(v), 0, 255);
        update(rgbToHex(rgb[0], rgb[1], rgb[2]), 'rgb');
      },
    });
    range.addEventListener('input', () => {
      const rgb = hexToRgb(current);
      rgb[i] = parseInt(range.value, 10);
      update(rgbToHex(rgb[0], rgb[1], rgb[2]), 'rgb');
    });
    const row = h('div', { class: 'cp-row' }, h('span', { class: `cp-label cp-${name.toLowerCase()}-label`, text: name }), range, num.el);
    return { range, num, row };
  });

  const update = (hex: string, source: 'hex' | 'rgb' | 'preset' | 'init') => {
    current = hex;
    after.style.background = hex;
    const rgb = hexToRgb(hex);
    channels.forEach((c, i) => {
      c.range.value = String(rgb[i]);
      c.num.set(rgb[i]);
      // スライダーの背景を現在の色から作るグラデーションにする
      const from = [...rgb];
      const to = [...rgb];
      from[i] = 0;
      to[i] = 255;
      c.range.style.background = `linear-gradient(90deg, ${rgbToHex(from[0], from[1], from[2])}, ${rgbToHex(to[0], to[1], to[2])})`;
    });
    if (source !== 'hex') hexInput.value = hex.toUpperCase();
    if (source !== 'init') onChange(hex);
  };

  hexInput.addEventListener('input', () => {
    const n = normalizeHex(hexInput.value);
    hexInput.classList.toggle('invalid', !n);
    if (n && hexInput.value.replace('#', '').length === 6) update(n, 'hex');
  });
  hexInput.addEventListener('change', () => {
    const n = normalizeHex(hexInput.value);
    if (n) update(n, 'preset');
    else hexInput.value = current.toUpperCase();
  });

  const swatches = (colors: string[]) =>
    h(
      'div',
      { class: 'cp-swatches' },
      colors.map((c) =>
        h('button', {
          class: 'cp-swatch',
          style: `background:${c}`,
          title: c,
          attrs: { type: 'button', 'aria-label': c },
          on: { click: () => update(c, 'preset') },
        }),
      ),
    );

  const native = h('input', { class: 'cp-native', attrs: { type: 'color', 'aria-label': 'システムの色選択' } });
  native.addEventListener('input', () => update(native.value, 'preset'));
  const nativeBtn = h('label', { class: 'btn secondary cp-native-btn', html: `${icon('palette', 18)}<span class="btn-label">その他の色</span>` }, native);

  const recent = recentColors();
  const content = h(
    'div',
    { class: 'color-picker' },
    h('div', { class: 'cp-top' }, preview, h('div', { class: 'cp-hex-wrap' }, h('span', { class: 'cp-label', text: 'HEX' }), hexInput)),
    channels.map((c) => c.row),
    h('div', { class: 'cp-section-title', text: 'パレット' }),
    swatches(PRESET_COLORS),
    recent.length > 0 ? [h('div', { class: 'cp-section-title', text: '最近使った色' }), swatches(recent)] : null,
    nativeBtn,
  );

  let accepted = false;
  openModal({
    title,
    content,
    className: 'color-modal',
    testId: 'color-picker',
    actions: [
      { label: 'キャンセル' },
      {
        label: '決定',
        kind: 'primary',
        testId: 'color-ok',
        onClick: () => {
          accepted = true;
          pushRecent(current);
        },
      },
    ],
    onClose: () => {
      // キャンセル時は元の色に戻す
      if (!accepted && current !== original) onChange(original);
    },
  });
  native.value = original;
  update(original, 'init');
}

export class ColorField {
  readonly el: HTMLElement;
  private swatch: HTMLButtonElement;
  private label: HTMLSpanElement;
  private value = '#ffffff';

  constructor(opts: { title: string; testId?: string; onChange: (hex: string) => void }) {
    this.swatch = h('button', {
      class: 'color-swatch',
      attrs: { type: 'button', 'aria-label': opts.title, 'data-testid': opts.testId },
      on: { click: () => openColorPicker(opts.title, this.value, opts.onChange) },
    });
    this.label = h('span', { class: 'color-hex' });
    this.el = h('div', { class: 'color-field' }, this.swatch, this.label);
    this.label.addEventListener('click', () => this.swatch.click());
  }

  set(v: string | null): void {
    if (v === null) {
      this.swatch.style.background = 'repeating-linear-gradient(45deg,#666 0 4px,#999 4px 8px)';
      this.label.textContent = '—';
      return;
    }
    this.value = v;
    this.swatch.style.background = v;
    this.label.textContent = v.toUpperCase();
  }
}

/** Inspector の1行 (ラベル + 入力) */
export function fieldRow(label: string, control: HTMLElement | HTMLElement[], opts: { hint?: string; extra?: HTMLElement | null; stacked?: boolean } = {}): HTMLElement {
  return h(
    'div',
    { class: `field-row ${opts.stacked ? 'stacked' : ''}`.trim() },
    h('div', { class: 'field-label' }, h('span', { text: label }), opts.hint ? h('small', { text: opts.hint }) : null),
    h('div', { class: 'field-control' }, control),
    opts.extra ?? null,
  );
}

/** 折りたたみ可能なセクション */
export function section(title: string, iconName: string, body: HTMLElement[], opts: { collapsed?: boolean; actions?: HTMLElement[]; testId?: string } = {}): HTMLElement {
  const content = h('div', { class: 'section-body' }, body);
  const header = h(
    'div',
    { class: 'section-header' },
    h('button', {
      class: 'section-toggle',
      attrs: { type: 'button', 'aria-expanded': String(!opts.collapsed) },
      html: `${icon('chevronDown', 16)}${icon(iconName, 18)}<span>${title}</span>`,
      on: {
        click: () => {
          const collapsed = el.classList.toggle('collapsed');
          header.firstElementChild!.setAttribute('aria-expanded', String(!collapsed));
        },
      },
    }),
    opts.actions ? h('div', { class: 'section-actions' }, opts.actions) : null,
  );
  const el = h('section', { class: `section ${opts.collapsed ? 'collapsed' : ''}`.trim(), attrs: { 'data-testid': opts.testId } }, header, content);
  return el;
}

export { button };
