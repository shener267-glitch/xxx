import type { SheetState, TabId } from './context';
import { h } from './dom';
import { icon } from './icons';

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'scene', label: 'シーン', icon: 'layers' },
  { id: 'inspector', label: 'インスペクター', icon: 'sliders' },
  { id: 'events', label: 'イベント', icon: 'zap' },
  { id: 'assets', label: 'アセット', icon: 'folder' },
  { id: 'settings', label: '設定', icon: 'settings' },
];

/**
 * 画面下からせり上がるパネル (ボトムシート) とタブバー。
 * - 縦画面: 下から半分 / 全画面の高さで表示。ハンドルをドラッグして高さを変えられる
 * - 横画面・PC: 右側に浮かぶパネルとして表示 (画面を固定分割しない)
 */
export class BottomSheet {
  readonly el: HTMLElement;
  readonly tabbar: HTMLElement;
  state: SheetState = 'closed';
  tab: TabId = 'scene';
  private content: HTMLElement;
  private handle: HTMLElement;
  private title: HTMLElement;
  private tabButtons = new Map<TabId, HTMLButtonElement>();
  private panels = new Map<TabId, HTMLElement>();
  private dragHeight: number | null = null;
  private side = false;
  private listeners = new Set<() => void>();

  /**
   * @param host アプリのルート要素 (レイアウト用のクラス・CSS 変数を設定)
   * @param container シートが重なる領域 (高さの基準)
   */
  constructor(
    private host: HTMLElement,
    private container: HTMLElement,
  ) {
    this.title = h('span', { class: 'sheet-title' });
    this.handle = h(
      'div',
      { class: 'sheet-handle', attrs: { 'data-testid': 'sheet-handle' } },
      h('div', { class: 'sheet-grabber' }),
      h(
        'div',
        { class: 'sheet-head' },
        this.title,
        h('button', {
          class: 'btn icon-btn small ghost sheet-expand',
          attrs: { type: 'button', 'aria-label': '大きさを切り替え', 'data-testid': 'sheet-expand' },
          html: icon('chevronUp', 20),
          on: {
            click: (e) => {
              e.stopPropagation();
              this.setState(this.state === 'full' ? 'half' : 'full');
            },
          },
        }),
        h('button', {
          class: 'btn icon-btn small ghost',
          attrs: { type: 'button', 'aria-label': '閉じる', 'data-testid': 'sheet-close' },
          html: icon('x', 20),
          on: {
            click: (e) => {
              e.stopPropagation();
              this.setState('closed');
            },
          },
        }),
      ),
    );
    this.content = h('div', { class: 'sheet-content' });
    this.el = h('div', { class: 'sheet', attrs: { 'data-state': 'closed', 'data-testid': 'sheet' } }, this.handle, this.content);

    this.tabbar = h('nav', { class: 'tabbar', attrs: { role: 'tablist' } });
    for (const t of TABS) {
      const b = h(
        'button',
        {
          class: 'tab',
          attrs: { type: 'button', role: 'tab', 'aria-selected': 'false', 'data-testid': `tab-${t.id}` },
          on: { click: () => this.toggle(t.id) },
        },
        h('span', { html: icon(t.icon, 22) }),
        h('span', { class: 'tab-label', text: t.label }),
      );
      this.tabButtons.set(t.id, b);
      this.tabbar.appendChild(b);
    }

    this.bindDrag();
    const mq = window.matchMedia('(min-width: 900px), (orientation: landscape) and (max-height: 540px)');
    const applyMode = () => {
      this.side = mq.matches;
      this.host.classList.toggle('layout-side', this.side);
      this.apply();
    };
    mq.addEventListener?.('change', applyMode);
    window.addEventListener('resize', () => this.apply());
    applyMode();
  }

  addPanel(id: TabId, el: HTMLElement): void {
    el.dataset.tab = id;
    el.hidden = id !== this.tab;
    this.panels.set(id, el);
    this.content.appendChild(el);
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  /** タブを開く (既に開いているタブを押したら閉じる) */
  toggle(tab: TabId): void {
    if (this.tab === tab && this.state !== 'closed') this.setState('closed');
    else this.open(tab);
  }

  open(tab: TabId, state?: SheetState): void {
    this.tab = tab;
    for (const [id, p] of this.panels) p.hidden = id !== tab;
    const next = state ?? (this.state === 'closed' ? 'half' : this.state);
    this.setState(next);
  }

  setState(state: SheetState): void {
    this.state = state;
    this.dragHeight = null;
    this.apply();
  }

  /** シートが画面下を覆っている高さ (px)。横画面モードでは 0 */
  get coveredHeight(): number {
    if (this.side || this.state === 'closed') return 0;
    return this.el.getBoundingClientRect().height;
  }

  private heights(): { half: number; full: number } {
    const H = this.container.clientHeight;
    return { half: Math.round(Math.max(260, H * 0.48)), full: Math.max(300, H - 8) };
  }

  private apply(): void {
    const label = TABS.find((t) => t.id === this.tab)?.label ?? '';
    this.title.textContent = label;
    this.el.dataset.state = this.state;
    this.host.dataset.sheet = this.state;
    for (const [id, b] of this.tabButtons) {
      const active = id === this.tab && this.state !== 'closed';
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    }
    if (this.side) {
      this.el.style.height = '';
    } else {
      const { half, full } = this.heights();
      const target = this.dragHeight ?? (this.state === 'closed' ? 0 : this.state === 'half' ? half : full);
      this.el.style.height = `${target}px`;
    }
    this.host.style.setProperty('--sheet-cover', `${this.side ? 0 : this.state === 'closed' ? 0 : parseFloat(this.el.style.height) || 0}px`);
    for (const fn of this.listeners) fn();
  }

  /** ハンドルのドラッグで高さを変える。離したときに近い段階へ吸着 */
  private bindDrag(): void {
    let start: { y: number; h: number; t: number; id: number } | null = null;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0;
    this.handle.addEventListener('pointerdown', (e) => {
      if (this.side) return;
      if ((e.target as HTMLElement).closest('button')) return;
      start = { y: e.clientY, h: this.el.getBoundingClientRect().height, t: performance.now(), id: e.pointerId };
      lastY = e.clientY;
      lastT = start.t;
      velocity = 0;
      this.handle.setPointerCapture(e.pointerId);
      this.el.classList.add('dragging');
    });
    this.handle.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      const now = performance.now();
      velocity = (e.clientY - lastY) / Math.max(1, now - lastT);
      lastY = e.clientY;
      lastT = now;
      const { full } = this.heights();
      this.dragHeight = Math.max(0, Math.min(full, start.h - (e.clientY - start.y)));
      if (this.state === 'closed') this.state = 'half';
      this.apply();
    });
    const end = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      const moved = Math.abs(e.clientY - start.y);
      start = null;
      this.el.classList.remove('dragging');
      if (moved < 6) {
        // タップ: 半分 ⇔ 全画面を切り替え
        this.setState(this.state === 'full' ? 'half' : 'full');
        return;
      }
      const hgt = this.dragHeight ?? 0;
      const { half, full } = this.heights();
      let next: SheetState;
      if (velocity > 0.6) next = hgt > half + 40 ? 'half' : 'closed';
      else if (velocity < -0.6) next = hgt < half - 40 ? 'half' : 'full';
      else {
        const options: [SheetState, number][] = [
          ['closed', 0],
          ['half', half],
          ['full', full],
        ];
        next = options.reduce((best, cur) => (Math.abs(cur[1] - hgt) < Math.abs(best[1] - hgt) ? cur : best))[0];
      }
      this.setState(next);
    };
    this.handle.addEventListener('pointerup', end);
    this.handle.addEventListener('pointercancel', end);
  }
}
