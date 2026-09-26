import { icon } from './icons';

/**
 * 最小限の DOM 生成ヘルパー (UI フレームワークに依存しないため)。
 */

export type Child = Node | string | number | null | undefined | false | Child[];

type EventMap = HTMLElementEventMap;

export interface HProps {
  class?: string;
  style?: string;
  title?: string;
  text?: string;
  html?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  data?: Record<string, string>;
  on?: { [K in keyof EventMap]?: (e: EventMap[K]) => void };
  /** value / type / placeholder など要素のプロパティ */
  props?: Record<string, unknown>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: HProps | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = props.class;
    if (props.style) el.setAttribute('style', props.style);
    if (props.title) el.title = props.title;
    if (props.text !== undefined) el.textContent = props.text;
    if (props.html !== undefined) el.innerHTML = props.html;
    if (props.attrs) {
      for (const [k, v] of Object.entries(props.attrs)) {
        if (v === null || v === undefined || v === false) continue;
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (props.data) for (const [k, v] of Object.entries(props.data)) el.dataset[k] = v;
    if (props.props) Object.assign(el, props.props);
    if (props.on) {
      for (const [type, fn] of Object.entries(props.on)) {
        if (fn) el.addEventListener(type, fn as EventListener);
      }
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else if (c instanceof Node) parent.appendChild(c);
    else parent.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export interface ButtonOptions {
  icon?: string;
  label?: string;
  title?: string;
  class?: string;
  onClick?: (e: MouseEvent) => void;
  disabled?: boolean;
  iconSize?: number;
  testId?: string;
}

/** アイコン付きボタン */
export function button(opts: ButtonOptions): HTMLButtonElement {
  const b = h('button', {
    class: `btn ${opts.class ?? ''}`.trim(),
    title: opts.title ?? opts.label,
    attrs: { type: 'button', 'aria-label': opts.title ?? opts.label, 'data-testid': opts.testId },
  });
  if (opts.icon) b.insertAdjacentHTML('beforeend', icon(opts.icon, opts.iconSize ?? 22));
  if (opts.label) b.appendChild(h('span', { class: 'btn-label', text: opts.label }));
  if (opts.disabled) b.disabled = true;
  if (opts.onClick) {
    const fn = opts.onClick;
    b.addEventListener('click', (e) => {
      if (b.disabled) return;
      fn(e);
    });
  }
  return b;
}

export function setIcon(el: HTMLElement, name: string, size = 22): void {
  const old = el.querySelector('svg.icon');
  const tmp = document.createElement('span');
  tmp.innerHTML = icon(name, size);
  const svg = tmp.firstElementChild!;
  if (old) old.replaceWith(svg);
  else el.prepend(svg);
}

/** requestAnimationFrame で処理をまとめる (連続イベントでの再描画を1回にする) */
export function rafThrottle(fn: () => void): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn();
    });
  };
}

/** 長押し検出 (タッチ用のコンテキストメニューなど) */
export function onLongPress(el: HTMLElement, fn: (e: PointerEvent) => void, ms = 520): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start = { x: 0, y: 0 };
  let fired = false;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    fired = false;
    start = { x: e.clientX, y: e.clientY };
    cancel();
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      if (navigator.vibrate) navigator.vibrate(10);
      fn(e);
    }, ms);
  });
  el.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) cancel();
  });
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  // 長押し後の click を無効化
  el.addEventListener(
    'click',
    (e) => {
      if (fired) {
        e.stopPropagation();
        e.preventDefault();
        fired = false;
      }
    },
    true,
  );
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!fired) fn(e as unknown as PointerEvent);
  });
}

export const isTouchDevice = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;
