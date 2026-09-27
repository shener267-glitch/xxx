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
  /** タブごとの見出し (無ければタブ名) */
  private titles = new Map<TabId, HTMLElement>();
  private titleTab: TabId | null = null;
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

  addPanel(id: TabId, el: HTMLElement, title?: HTMLElement): void {
    if (title) {
      this.titles.set(id, title);
      if (id === this.tab) {
        this.titleTab = id;
        this.title.replaceChildren(title);
      }
    }
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

  /** ハンドルをドラッグ中か */
  get dragging(): boolean {
    return this.dragHeight !== null;
  }

  /**
   * 3D ビューのうち、シートで覆われる幅・高さ (px。開き終わったときの値)。
   * 全画面のときは 3D ビューを見ていないので、半分の高さとして扱う (開閉で視点が大きく動かないように)
   */
  cover(): { right: number; bottom: number } {
    if (this.state === 'closed' && this.dragHeight === null) return { right: 0, bottom: 0 };
    if (this.side) {
      const style = getComputedStyle(this.el);
      const width = parseFloat(style.width) || this.el.getBoundingClientRect().width;
      return { right: width + 16, bottom: 0 };
    }
    const { half } = this.heights();
    return { right: 0, bottom: Math.max(0, Math.min(this.dragHeight ?? half, half) - this.underlap()) };
  }

  /**
   * 縦画面ではシートを開くとツールバー (選択・移動… と「追加」) の上に重ねる。
   * その分シートと 3D ビューを広く使える (移動・回転・拡大は選択中の操作バーから切り替えられる)
   */
  private underlap(): number {
    if (this.side) return 0;
    return parseFloat(getComputedStyle(this.host).getPropertyValue('--toolbar-h')) || 0;
  }

  private heights(): { half: number; full: number } {
    const H = this.container.clientHeight + this.underlap();
    return { half: Math.round(Math.max(280, H * 0.5)), full: Math.max(300, H - 8) };
  }

  private apply(): void {
    if (this.titleTab !== this.tab) {
      this.titleTab = this.tab;
      const label = TABS.find((t) => t.id === this.tab)?.label ?? '';
      this.title.replaceChildren(this.titles.get(this.tab) ?? document.createTextNode(label));
    }
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
    const covered = this.side || this.state === 'closed' ? 0 : Math.max(0, (parseFloat(this.el.style.height) || 0) - this.underlap());
    this.host.style.setProperty('--sheet-cover', `${covered}px`);
    for (const fn of this.listeners) fn();
  }

  /** ハンドルのドラッグで高さを変える。離したときに近い段階へ吸着 */
  private bindDrag(): void {
    // fromButton: 見出しのボタン (シーン名など) の上で押した。動かさずに離せばボタンのタップ、動かせばシートのドラッグ
    let start: { y: number; h: number; t: number; id: number; fromButton: boolean; dragging: boolean } | null = null;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0;
    const beginDrag = (id: number) => {
      try {
        this.handle.setPointerCapture(id);
      } catch {
        // 既に離されている
      }
      this.el.classList.add('dragging');
    };
    this.handle.addEventListener('pointerdown', (e) => {
      if (this.side) return;
      const target = e.target as HTMLElement;
      const fromButton = !!target.closest('.sheet-title button');
      if (target.closest('button') && !fromButton) return;
      start = { y: e.clientY, h: this.el.getBoundingClientRect().height, t: performance.now(), id: e.pointerId, fromButton, dragging: !fromButton };
      lastY = e.clientY;
      lastT = start.t;
      velocity = 0;
      if (!fromButton) beginDrag(e.pointerId);
    });
    this.handle.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      if (!start.dragging) {
        if (Math.abs(e.clientY - start.y) < 6) return;
        start.dragging = true;
        beginDrag(e.pointerId);
      }
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
      const wasDragging = start.dragging;
      start = null;
      // 見出しのボタンをタップしただけ: ボタンの動作に任せる
      if (!wasDragging) return;
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
