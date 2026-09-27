import type { EntityData, GameSettings, UIAnchor, UIButtonAction, UIElementData } from '../core/types';
import { h } from '../ui/dom';
import { ensureFont, fontStack } from '../engine/fonts';
import type { AudioVolumes } from './AudioEngine';
import type { GameState } from './GameState';
import { barValue, formatTime, formatUIText } from './GameState';

/**
 * ゲーム画面の UI (Play 中・書き出したゲームで共通)。
 * - HUD (HP・スコア・お金・残機・時間・持ち物)
 * - シーンに置いた UI (文字・ボタン・画像・ゲージ)
 * - ジャンプ / アクションボタン、NPC の会話ウィンドウ、お知らせ
 * - タイトル・一時停止・設定・ゲームオーバー・クリア画面
 *
 * タップを受け付ける要素には data-interactive を付け、
 * 仮想ジョイスティック (RuntimeInput) が反応しないようにしている。
 */

export interface GameUIHandlers {
  onJump(): void;
  onAction(): void;
  onUIButton(entityId: string, action: UIButtonAction): void;
  onStart(fromSave: boolean): void;
  onRestart(): void;
  onTitle(): void;
  onPauseChange(paused: boolean): void;
  onVolumes(v: Partial<AudioVolumes>): void;
  /** エディタへ戻る (エディタの Play のみ) */
  onExit?(): void;
}

export interface GameUIOptions {
  root: HTMLElement;
  state: GameState;
  game: GameSettings;
  /** 書き出したゲームとして動作 (一時停止ボタンなどを自前で表示) */
  standalone: boolean;
  /** 上部に確保する余白 (エディタの Play 用ボタン列) */
  topInset: number;
  volumes: AudioVolumes;
  resolveImage(assetId: string): Promise<string | null>;
  handlers: GameUIHandlers;
  /** 設定画面に足す項目 (書き出したゲームの画質・全画面など) */
  extraSettings?(): HTMLElement[];
  /** タイトル画面に足すボタン (書き出したゲームの「全画面で遊ぶ」など) */
  extraTitle?(): HTMLElement[];
}

export interface UIItem {
  id: string;
  data: UIElementData;
  el: HTMLElement;
  textEl?: HTMLElement;
  fill?: HTMLElement;
  lastText?: string;
  lastPct?: number;
}

function hexToRgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(0,0,0,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** アンカーとずれから CSS の位置を作る */
export function anchorStyle(anchor: UIAnchor, x: number, y: number, topInset: number): Partial<CSSStyleDeclaration> {
  const s: Partial<CSSStyleDeclaration> = {};
  const [v, hz] = ((): ['top' | 'middle' | 'bottom', 'left' | 'center' | 'right'] => {
    switch (anchor) {
      case 'top-left':
        return ['top', 'left'];
      case 'top':
        return ['top', 'center'];
      case 'top-right':
        return ['top', 'right'];
      case 'left':
        return ['middle', 'left'];
      case 'center':
        return ['middle', 'center'];
      case 'right':
        return ['middle', 'right'];
      case 'bottom-left':
        return ['bottom', 'left'];
      case 'bottom':
        return ['bottom', 'center'];
      default:
        return ['bottom', 'right'];
    }
  })();
  const tx = hz === 'center' ? '-50%' : '0';
  const ty = v === 'middle' ? '-50%' : '0';
  if (hz === 'left') s.left = `calc(${x}px + var(--safe-left, 0px))`;
  else if (hz === 'right') s.right = `calc(${x}px + var(--safe-right, 0px))`;
  else s.left = `calc(50% + ${x}px)`;
  if (v === 'top') s.top = `calc(${y + topInset}px + var(--safe-top, 0px))`;
  else if (v === 'bottom') s.bottom = `calc(${y}px + var(--safe-bottom, 0px))`;
  else s.top = `calc(50% + ${y}px)`;
  s.transform = `translate(${tx}, ${ty})`;
  return s;
}

/**
 * UI 要素 (文字・ボタン・画像・ゲージ) の DOM を作る。エディタのプレビューでも使う。
 * onClick を省略するとボタンは押せない見た目だけになる。
 */
export function buildUIElement(
  id: string,
  d: UIElementData,
  opts: { topInset: number; resolveImage(assetId: string): Promise<string | null>; onClick?(action: UIButtonAction): void },
): UIItem {
  const pos = anchorStyle(d.anchor, d.x, d.y, opts.topInset);
  const bg = d.backgroundOpacity > 0 ? hexToRgba(d.background, d.backgroundOpacity) : 'transparent';
  let el: HTMLElement;
  const item: UIItem = { id, data: d, el: null as unknown as HTMLElement };
  switch (d.type) {
    case 'button': {
      el = h('button', { class: 'g-ui g-ui-button', attrs: { type: 'button' } });
      if (opts.onClick) {
        el.dataset.interactive = '';
        const fn = opts.onClick;
        el.addEventListener('click', () => fn(d.action));
      }
      item.textEl = el;
      break;
    }
    case 'image': {
      el = h('div', { class: 'g-ui g-ui-image' });
      if (d.image) {
        void opts.resolveImage(d.image).then((url) => {
          if (url) el.style.backgroundImage = `url("${url}")`;
        });
      } else {
        el.classList.add('empty');
      }
      break;
    }
    case 'bar': {
      item.fill = h('div', { class: 'g-ui-fill' });
      item.fill.style.background = d.color;
      el = h('div', { class: 'g-ui g-ui-bar' }, item.fill);
      break;
    }
    default:
      el = h('div', { class: 'g-ui g-ui-text' });
      item.textEl = el;
  }
  Object.assign(el.style, pos);
  el.style.fontSize = `${d.fontSize}px`;
  el.style.color = d.color;
  el.style.background = d.type === 'bar' ? hexToRgba(d.background, Math.max(d.backgroundOpacity, 0.05)) : bg;
  el.style.borderRadius = `${d.radius}px`;
  if (d.width > 0) el.style.width = `${d.width}px`;
  if (d.height > 0) el.style.height = `${d.height}px`;
  if (d.type === 'bar' && d.height <= 0) el.style.height = '12px';
  if (d.type === 'bar' && d.width <= 0) el.style.width = '120px';
  if (d.type === 'image' && d.width <= 0) el.style.width = '64px';
  if (d.type === 'image' && d.height <= 0) el.style.height = '64px';
  if (d.type === 'text' && d.backgroundOpacity > 0) el.style.padding = '4px 10px';
  if (d.font && (d.type === 'text' || d.type === 'button')) {
    el.style.fontFamily = fontStack(d.font);
    void ensureFont(d.font);
  }
  item.el = el;
  return item;
}

/** 文字・ゲージの表示を現在の状態に合わせる (変化があったときだけ DOM を触る) */
export function updateUIElement(item: UIItem, s: GameState): void {
  if (item.textEl) {
    const text = formatUIText(item.data.text, s);
    if (text !== item.lastText) {
      item.lastText = text;
      item.textEl.textContent = text;
    }
  }
  if (item.fill) {
    const { value, max } = barValue(item.data.barValue, item.data.barMax, s);
    const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    if (pct !== item.lastPct) {
      item.lastPct = pct;
      item.fill.style.width = `${pct * 100}%`;
    }
  }
}

export class GameUI {
  readonly el: HTMLElement;
  private hud: HTMLElement;
  private hpBox: HTMLElement;
  private hpFill: HTMLElement;
  private hpText: HTMLElement;
  private scoreEl: HTMLElement;
  private moneyEl: HTMLElement;
  private livesEl: HTMLElement;
  private timerEl: HTMLElement;
  private invEl: HTMLElement;
  private custom: HTMLElement;
  private controls: HTMLElement;
  private jumpBtn: HTMLButtonElement;
  private actionBtn: HTMLButtonElement;
  private pauseBtn: HTMLButtonElement | null = null;
  private toastEl: HTMLElement;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private screen: HTMLElement | null = null;
  private dialog: HTMLElement | null = null;
  private dialogResolve: (() => void) | null = null;
  private dialogChain: Promise<void> = Promise.resolve();
  private dialogGen = 0;
  private dialogQueue = 0;
  private items: UIItem[] = [];
  private objectUrls: string[] = [];
  private unsub: () => void;
  private lastInv = '';
  private hasHp = false;
  private showLives = false;
  private volumes: AudioVolumes;
  /** 画面 (タイトル・設定など) を開いている */
  screenOpen = false;

  constructor(private opts: GameUIOptions) {
    this.volumes = { ...opts.volumes };
    const interactive = { 'data-interactive': '' };

    this.hpFill = h('div', { class: 'g-hp-fill' });
    this.hpText = h('div', { class: 'g-hp-text' });
    this.hpBox = h('div', { class: 'g-hp', attrs: { 'data-testid': 'game-hp' } }, h('span', { class: 'g-heart', text: '♥' }), h('div', { class: 'g-hp-bar' }, this.hpFill), this.hpText);
    this.livesEl = h('div', { class: 'g-chip g-lives', attrs: { 'data-testid': 'game-lives' } });
    this.invEl = h('div', { class: 'g-inv', attrs: { 'data-testid': 'game-inventory' } });
    this.scoreEl = h('div', { class: 'g-chip g-score', attrs: { 'data-testid': 'game-score' } });
    this.moneyEl = h('div', { class: 'g-chip g-money', attrs: { 'data-testid': 'game-money' } });
    this.timerEl = h('div', { class: 'g-chip g-timer', attrs: { 'data-testid': 'game-timer' } });
    this.hud = h(
      'div',
      { class: 'g-hud' },
      h('div', { class: 'g-hud-left' }, this.hpBox, this.livesEl, this.invEl),
      h('div', { class: 'g-hud-right' }, this.timerEl, this.scoreEl, this.moneyEl),
    );
    this.hud.hidden = !opts.game.showHud;

    this.custom = h('div', { class: 'g-custom' });

    this.jumpBtn = h('button', {
      class: 'g-btn g-jump',
      attrs: { type: 'button', 'aria-label': 'ジャンプ', 'data-testid': 'game-jump', ...interactive },
      html: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 6-6 6 6"/><path d="M6 20h12"/></svg>',
    });
    this.actionBtn = h('button', {
      class: 'g-btn g-action',
      attrs: { type: 'button', 'aria-label': 'アクション', 'data-testid': 'game-action', ...interactive },
      text: '攻撃',
    });
    // 押した瞬間に反応させる (click だと離すまで遅れる)
    this.jumpBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      opts.handlers.onJump();
    });
    this.actionBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      opts.handlers.onAction();
    });
    this.controls = h('div', { class: 'g-controls' }, this.actionBtn, this.jumpBtn);
    this.controls.hidden = true;

    this.toastEl = h('div', { class: 'g-toast', attrs: { 'data-testid': 'game-toast' } });

    const children: HTMLElement[] = [this.custom, this.hud, this.controls, this.toastEl];
    if (opts.standalone) {
      this.pauseBtn = h('button', {
        class: 'g-btn g-pause',
        attrs: { type: 'button', 'aria-label': '一時停止', 'data-testid': 'game-pause', ...interactive },
        html: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
        on: { click: () => this.showPause() },
      });
      children.push(this.pauseBtn);
    }
    this.el = h('div', { class: 'game-ui', attrs: { 'data-testid': 'game-ui' } }, children);
    this.el.style.setProperty('--g-top', `${opts.topInset}px`);
    opts.root.appendChild(this.el);
    this.unsub = opts.state.onChange(() => this.update());
  }

  // ------------------------------------------------------------------
  // HUD
  // ------------------------------------------------------------------

  /** HUD に出す項目の設定 */
  configureHud(o: { hasHp: boolean; showLives: boolean }): void {
    this.hasHp = o.hasHp;
    this.showLives = o.showLives;
    this.update();
  }

  setControls(o: { jump: boolean; action: boolean }): void {
    this.jumpBtn.hidden = !o.jump;
    this.actionBtn.hidden = !o.action;
    this.controls.hidden = !o.jump && !o.action;
  }

  setActionLabel(label: string): void {
    if (this.actionBtn.textContent !== label) this.actionBtn.textContent = label;
    this.actionBtn.classList.toggle('talk', label !== '攻撃');
  }

  /** 表示を最新の状態にする (状態が変わったとき・時間表示用に定期的に呼ぶ) */
  update(): void {
    const s = this.opts.state;
    this.hpBox.hidden = !this.hasHp;
    if (this.hasHp) {
      const pct = s.maxHp > 0 ? Math.max(0, Math.min(1, s.hp / s.maxHp)) : 0;
      this.hpFill.style.width = `${pct * 100}%`;
      this.hpFill.classList.toggle('low', pct <= 0.3);
      this.hpText.textContent = `${Math.ceil(s.hp)}/${s.maxHp}`;
    }
    this.livesEl.hidden = !this.showLives;
    this.livesEl.textContent = `残り ${s.lives}`;
    this.scoreEl.textContent = `★ ${s.score}`;
    this.moneyEl.hidden = s.money === 0;
    this.moneyEl.textContent = `● ${s.money}`;
    const remaining = s.remaining;
    this.timerEl.hidden = remaining === null;
    if (remaining !== null) {
      this.timerEl.textContent = `⏱ ${formatTime(Math.ceil(remaining))}`;
      this.timerEl.classList.toggle('low', remaining <= 10);
    }
    const inv = [...s.inventory.entries()].map(([k, v]) => `${k}×${v}`).join('|');
    if (inv !== this.lastInv) {
      this.lastInv = inv;
      this.invEl.replaceChildren(...[...s.inventory.entries()].map(([k, v]) => h('span', { class: 'g-inv-item', text: v > 1 ? `${k} ×${v}` : k })));
    }
    for (const item of this.items) this.updateItem(item);
  }

  // ------------------------------------------------------------------
  // シーンに置いた UI
  // ------------------------------------------------------------------

  setUIEntities(entities: EntityData[]): void {
    this.custom.replaceChildren();
    this.items = [];
    for (const e of entities) {
      if (!e.ui || !e.visible) continue;
      const item = this.createItem(e.id, e.ui);
      item.el.dataset.testid = `game-ui-${e.name}`;
      this.custom.appendChild(item.el);
      this.items.push(item);
      this.updateItem(item);
    }
  }

  private createItem(id: string, d: UIElementData): UIItem {
    return buildUIElement(id, d, {
      topInset: this.opts.topInset,
      resolveImage: async (assetId) => {
        const url = await this.opts.resolveImage(assetId);
        if (url) this.objectUrls.push(url);
        return url;
      },
      onClick: (action) => this.opts.handlers.onUIButton(id, action),
    });
  }

  /** UI 要素の文字を変える (イベントの「UI の文字を変える」) */
  setItemText(id: string, text: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item || !item.textEl) return;
    item.data = { ...item.data, text };
    item.lastText = undefined;
    this.updateItem(item);
  }

  setItemVisible(id: string, visible: boolean): boolean {
    const item = this.items.find((i) => i.id === id);
    if (!item) return false;
    item.el.hidden = !visible;
    return true;
  }

  private updateItem(item: UIItem): void {
    updateUIElement(item, this.opts.state);
  }

  // ------------------------------------------------------------------
  // お知らせ・会話
  // ------------------------------------------------------------------

  toast(message: string, ms = 1800): void {
    ms = Math.max(500, ms);
    this.toastEl.textContent = message;
    this.toastEl.classList.add('show');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  get dialogOpen(): boolean {
    return this.dialog !== null || this.dialogQueue > 0;
  }

  /** 会話ウィンドウ。タップで次のページへ進み、最後まで読むと閉じる */
  /**
   * 会話ウィンドウを表示する。表示中に別の会話が来たら、今の会話が終わってから順に表示する。
   */
  showDialog(name: string, pages: string[], onPage?: () => void): Promise<void> {
    const gen = this.dialogGen;
    let run: Promise<void>;
    if (this.dialog === null && this.dialogQueue === 0) {
      // 何も表示していなければすぐに開く (同じフレームのうちにゲームを止めるため)
      run = this.openDialog(name, pages, onPage);
    } else {
      this.dialogQueue++;
      run = this.dialogChain.then(() => {
        this.dialogQueue--;
        return gen === this.dialogGen ? this.openDialog(name, pages, onPage) : undefined;
      });
    }
    this.dialogChain = run.catch(() => undefined);
    return run;
  }

  private openDialog(name: string, pages: string[], onPage?: () => void): Promise<void> {
    const list = pages.filter((p) => p.trim() !== '');
    if (list.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let i = 0;
      const text = h('div', { class: 'g-dialog-text', attrs: { 'data-testid': 'game-dialog-text' } });
      const next = h('div', { class: 'g-dialog-next' });
      const box = h(
        'div',
        { class: 'g-dialog', attrs: { 'data-testid': 'game-dialog', 'data-interactive': '', role: 'dialog' } },
        name ? h('div', { class: 'g-dialog-name', text: name }) : null,
        text,
        next,
      );
      const show = () => {
        text.textContent = list[i];
        next.textContent = i < list.length - 1 ? '▼ タップで次へ' : '✕ タップで閉じる';
        onPage?.();
      };
      box.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        i++;
        if (i >= list.length) this.finishDialog();
        else show();
      });
      show();
      this.dialog = box;
      this.dialogResolve = resolve;
      this.el.appendChild(box);
      this.syncBusy();
    });
  }

  private finishDialog(): void {
    this.dialog?.remove();
    this.dialog = null;
    const r = this.dialogResolve;
    this.dialogResolve = null;
    this.syncBusy();
    r?.();
  }

  /** 表示中の会話と、待っている会話をすべて閉じる (ゲーム終了時など) */
  closeDialog(): void {
    this.dialogGen++;
    this.finishDialog();
  }

  private skipBtn: HTMLButtonElement | null = null;

  /** カットシーン (タイムライン) の表示: 上下の黒帯・操作ボタンを隠す・スキップボタン */
  setCutscene(on: boolean, skippable: boolean, onSkip: () => void): void {
    this.el.classList.toggle('cutscene', on);
    this.skipBtn?.remove();
    this.skipBtn = null;
    if (on && skippable) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'timeline-skip';
      b.textContent = 'スキップ ▶▶';
      b.dataset.testid = 'timeline-skip';
      b.dataset.interactive = '';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onSkip();
      });
      this.el.appendChild(b);
      this.skipBtn = b;
    }
  }

  /** 会話・画面の表示中は操作ボタンを隠す */
  private syncBusy(): void {
    this.el.classList.toggle('busy', this.dialog !== null || this.screen !== null);
  }

  // ------------------------------------------------------------------
  // 画面 (タイトル・一時停止・設定・終了)
  // ------------------------------------------------------------------

  private openScreen(cls: string, testId: string, content: HTMLElement[], background?: string): HTMLElement {
    this.closeScreen();
    const card = h('div', { class: 'g-card' }, content);
    const screen = h('div', { class: `g-screen ${cls}`, attrs: { 'data-testid': testId, 'data-interactive': '' } }, card);
    if (background) screen.style.background = background;
    this.screen = screen;
    this.screenOpen = true;
    this.el.appendChild(screen);
    this.syncBusy();
    requestAnimationFrame(() => screen.classList.add('open'));
    return screen;
  }

  closeScreen(): void {
    this.screen?.remove();
    this.screen = null;
    this.screenOpen = false;
    this.syncBusy();
  }

  private btn(label: string, testId: string, onClick: () => void, primary = false): HTMLButtonElement {
    return h('button', {
      class: `g-menu-btn${primary ? ' primary' : ''}`,
      text: label,
      attrs: { type: 'button', 'data-testid': testId },
      on: { click: onClick },
    });
  }

  showTitle(hasSave: boolean): void {
    const g = this.opts.game;
    const content: HTMLElement[] = [];
    const logo = h('div', { class: 'g-title-image' });
    if (g.titleImage) {
      void this.opts.resolveImage(g.titleImage).then((url) => {
        if (!url) return;
        this.objectUrls.push(url);
        logo.style.backgroundImage = `url("${url}")`;
        logo.classList.add('has');
      });
    }
    content.push(
      logo,
      h('h1', { class: 'g-title', text: g.title || 'ゲーム', attrs: { 'data-testid': 'game-title-text' } }),
      h('p', { class: 'g-subtitle', text: g.subtitle }),
      this.btn('はじめる', 'game-start', () => this.opts.handlers.onStart(false), true),
    );
    if (hasSave) content.push(this.btn('つづきから', 'game-continue', () => this.opts.handlers.onStart(true)));
    content.push(this.btn('設定', 'game-open-settings', () => this.showSettings(() => this.showTitle(hasSave))));
    if (this.opts.extraTitle) content.push(...this.opts.extraTitle());
    const credit = [g.author ? `作: ${g.author}` : '', g.version ? `v${g.version}` : ''].filter(Boolean).join(' ・ ');
    if (this.opts.standalone && credit) content.push(h('p', { class: 'g-credit', text: credit, attrs: { 'data-testid': 'game-credit' } }));
    const bg = `radial-gradient(circle at 50% 30%, ${hexToRgba(g.titleBackground, 0.85)}, ${hexToRgba(g.titleBackground, 1)})`;
    this.openScreen('g-title-screen', 'game-title', content, bg);
  }

  showPause(): void {
    this.opts.handlers.onPauseChange(true);
    this.openScreen('g-pause-screen', 'game-pause-menu', [
      h('h2', { class: 'g-screen-title', text: '一時停止' }),
      this.btn('つづける', 'game-resume', () => this.resume(), true),
      this.btn('最初からやり直す', 'game-restart', () => {
        this.closeScreen();
        this.opts.handlers.onRestart();
      }),
      this.btn('設定', 'game-open-settings', () => this.showSettings(() => this.showPause())),
      this.btn('タイトルへ', 'game-to-title', () => {
        this.closeScreen();
        this.opts.handlers.onTitle();
      }),
    ]);
  }

  private resume(): void {
    this.closeScreen();
    this.opts.handlers.onPauseChange(false);
  }

  showSettings(back: () => void): void {
    const slider = (label: string, key: keyof AudioVolumes) => {
      const input = h('input', {
        attrs: { type: 'range', min: 0, max: 100, step: 5, 'data-testid': `game-vol-${key}` },
        props: { value: String(Math.round(this.volumes[key] * 100)) },
      });
      const value = h('span', { class: 'g-slider-value', text: `${Math.round(this.volumes[key] * 100)}` });
      input.addEventListener('input', () => {
        const v = Number(input.value) / 100;
        this.volumes[key] = v;
        value.textContent = input.value;
        this.opts.handlers.onVolumes({ [key]: v });
      });
      return h('label', { class: 'g-slider' }, h('span', { text: label }), input, value);
    };
    this.openScreen('g-settings-screen', 'game-settings', [
      h('h2', { class: 'g-screen-title', text: '設定' }),
      slider('全体の音量', 'master'),
      slider('音楽', 'music'),
      slider('効果音', 'sfx'),
      ...(this.opts.extraSettings?.() ?? []),
      h(
        'div',
        { class: 'g-help' },
        h('div', { text: '操作方法' }),
        h('div', { text: 'スマホ: 画面の左側をなぞって移動、右側をなぞって視点。ボタンでジャンプ・攻撃・会話' }),
        h('div', { text: 'PC: WASD / 矢印キーで移動、Shift で走る、Space でジャンプ、E で攻撃・会話' }),
      ),
      this.btn('もどる', 'game-settings-back', back, true),
    ]);
  }

  showEnd(kind: 'clear' | 'gameover', message: string): void {
    const s = this.opts.state;
    const stats = h(
      'div',
      { class: 'g-stats' },
      h('div', {}, h('span', { text: 'スコア' }), h('b', { text: String(s.score) })),
      s.money !== 0 ? h('div', {}, h('span', { text: 'お金' }), h('b', { text: String(s.money) })) : null,
      h('div', {}, h('span', { text: 'タイム' }), h('b', { text: formatTime(s.elapsed) })),
    );
    const buttons: HTMLElement[] = [this.btn('もう一度あそぶ', 'game-retry', () => this.opts.handlers.onRestart(), true)];
    if (this.opts.standalone) buttons.push(this.btn('タイトルへ', 'game-to-title', () => this.opts.handlers.onTitle()));
    if (this.opts.handlers.onExit) buttons.push(this.btn('エディタに戻る', 'game-exit', () => this.opts.handlers.onExit?.()));
    this.openScreen(`g-end-screen ${kind}`, kind === 'clear' ? 'game-clear' : 'game-over', [
      h('h2', { class: 'g-end-title', text: message || (kind === 'clear' ? 'ゲームクリア！' : 'ゲームオーバー') }),
      stats,
      ...buttons,
    ]);
  }

  setVisible(on: boolean): void {
    this.el.hidden = !on;
  }

  dispose(): void {
    this.unsub();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
    this.el.remove();
  }
}
