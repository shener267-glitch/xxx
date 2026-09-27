import { logger } from '../core/logger';
import type { QualityLevel } from '../core/settings';
import type { GameQuality, ProjectData } from '../core/types';
import { clone } from '../core/util';
import { EngineRenderer } from '../engine/EngineRenderer';
import { setMaxTextureSize } from '../engine/textures';
import type { SaveData } from '../runtime/GameState';
import { fullscreenSupported, isFullscreen, onFullscreenChange, setFullscreen } from '../runtime/fullscreen';
import { GameRuntime } from '../runtime/GameRuntime';
import type { RuntimeRequest } from '../runtime/GameRuntime';
import { h } from '../ui/dom';

/**
 * 書き出したゲームの本体: 画面いっぱいの 3D 表示とゲームのランタイム。
 * タイトル画面 → ゲーム → クリア / ゲームオーバー → もう一度 / タイトルへ、シーンの切り替えを扱う。
 * 設定画面に「画質」と「全画面」を足す。
 */

const QUALITY_LABELS: [GameQuality, string][] = [
  ['auto', '自動'],
  ['low', '低'],
  ['medium', '中'],
  ['high', '高'],
];

const TEXTURE_SIZE: Record<QualityLevel, number> = { low: 512, medium: 1024, high: 2048 };

/** 端末の性能のめやす (タッチ端末で CPU のコアが少なければ低画質) */
export function autoQuality(): QualityLevel {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  if (coarse) return cores >= 6 ? 'medium' : 'low';
  return 'high';
}

export class StandalonePlayer {
  readonly engine: EngineRenderer;
  runtime: GameRuntime | null = null;
  private view: HTMLElement;
  private overlay: HTMLElement;
  private rotateHint: HTMLElement;
  private qualityPref: GameQuality;

  constructor(
    private root: HTMLElement,
    private project: ProjectData,
  ) {
    root.classList.add('player-root');
    root.setAttribute('data-testid', 'player');
    this.view = h('div', { class: 'player-view' });
    this.overlay = h('div', { class: 'player-overlay' });
    this.rotateHint = h(
      'div',
      { class: 'pg-rotate', attrs: { 'data-testid': 'player-rotate', hidden: true } },
      h('span', {
        html: '<svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/></svg>',
      }),
      h('span', { text: project.game.orientation === 'landscape' ? '画面を横向きにして遊んでください' : '画面を縦向きにして遊んでください' }),
    );
    root.append(this.view, this.overlay, this.rotateHint);
    this.qualityPref = this.loadQualityPref();
    const quality = this.effectiveQuality();
    setMaxTextureSize(TEXTURE_SIZE[quality]);
    this.engine = new EngineRenderer(this.view, { quality, shadows: quality !== 'low' });
    const layout = () => {
      this.updateLayout();
      this.engine.resize();
    };
    window.addEventListener('resize', layout);
    window.visualViewport?.addEventListener('resize', layout);
    this.updateLayout();
    document.addEventListener('visibilitychange', () => {
      // 別のアプリに切り替えたら一時停止メニューを出す
      const rt = this.runtime;
      if (document.hidden && rt && rt.phase === 'playing' && !rt.state.ended && !rt.ui.screenOpen) rt.ui.showPause();
    });
    onFullscreenChange(() => this.refreshFullscreenButtons());
  }

  private get qualityKey(): string {
    return `pocket-game:quality:${this.project.id}`;
  }

  private loadQualityPref(): GameQuality {
    try {
      const saved = localStorage.getItem(this.qualityKey);
      if (saved === 'auto' || saved === 'low' || saved === 'medium' || saved === 'high') return saved;
    } catch {
      // localStorage が使えない (file:// の一部のブラウザなど)
    }
    return this.project.game.quality;
  }

  effectiveQuality(): QualityLevel {
    return this.qualityPref === 'auto' ? autoQuality() : this.qualityPref;
  }

  setQualityPref(q: GameQuality): void {
    this.qualityPref = q;
    try {
      localStorage.setItem(this.qualityKey, q);
    } catch {
      // 保存できなくても今回は反映する
    }
    const level = this.effectiveQuality();
    setMaxTextureSize(TEXTURE_SIZE[level]);
    this.runtime?.setQuality(level);
  }

  /** 画面の向き: スマホで合わなければ案内、PC の横長の画面で縦向きのゲームは縦長の枠で表示 */
  private updateLayout(): void {
    const want = this.project.game.orientation;
    const landscape = window.innerWidth > window.innerHeight;
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const mismatch = (want === 'portrait' && landscape) || (want === 'landscape' && !landscape);
    this.rotateHint.hidden = !(coarse && mismatch);
    this.root.classList.toggle('frame-portrait', !coarse && want === 'portrait' && landscape);
  }

  /** 最初のシーンから始める (タイトル画面を出すかはゲームの設定。「タイトルへ」では必ず出す) */
  start(showTitle = this.project.game.startFromTitle): void {
    const first = this.project.startSceneId && this.project.scenes.some((s) => s.id === this.project.startSceneId) ? this.project.startSceneId : this.project.scenes[0]?.id;
    this.launch(first, showTitle, null);
  }

  private launch(sceneId: string | undefined, showTitle: boolean, carry: SaveData | null): void {
    const old = this.runtime;
    this.runtime = null;
    try {
      old?.dispose();
    } catch (err) {
      logger.warn('前のシーンの終了処理でエラーが発生しました', 'ゲーム', err);
    }
    const project = clone(this.project);
    const scene = project.scenes.find((s) => s.id === sceneId) ?? project.scenes[0];
    const runtime = new GameRuntime({
      engine: this.engine,
      project,
      sceneId: scene.id,
      carryState: carry,
      overlay: this.overlay,
      // プレイヤーのいるシーンは三人称、いなければシーンのカメラ
      cameraMode: scene.playerId ? 'thirdPerson' : 'game',
      quality: this.effectiveQuality(),
      showTitle,
      continueFromSave: false,
      standalone: true,
      topInset: 0,
      saveKey: `pocket-game:save:${project.id}`,
      onRequest: (kind, id) => this.handle(kind, id),
      extraSettings: () => this.settingsItems(),
      extraTitle: () => this.titleItems(),
    });
    this.runtime = runtime;
    runtime.start().catch((err) => logger.error('ゲームを開始できませんでした', 'ゲーム', err));
  }

  private handle(kind: RuntimeRequest, sceneId?: string): void {
    // ボタンの処理やイベントの途中でランタイムを破棄しないよう、次のタスクで行う
    setTimeout(() => {
      const rt = this.runtime;
      if (!rt) return;
      if (kind === 'scene' && sceneId) this.launch(sceneId, false, rt.carryOverState());
      else if (kind === 'title') this.start(true);
      else if (kind === 'restart') this.launch(rt.sceneData.id, false, null);
    }, 0);
  }

  // ------------------------------------------------------------------
  // 設定画面・タイトル画面に足すもの
  // ------------------------------------------------------------------

  private fullscreenButtons = new Set<HTMLButtonElement>();

  private fullscreenLabel(): string {
    return isFullscreen() ? '全画面をやめる' : '全画面で遊ぶ';
  }

  private refreshFullscreenButtons(): void {
    for (const b of [...this.fullscreenButtons]) {
      // 画面を閉じて消えたボタンは忘れる
      if (!b.isConnected) this.fullscreenButtons.delete(b);
      else b.textContent = this.fullscreenLabel();
    }
  }

  private fullscreenButton(cls: string): HTMLButtonElement {
    const b = h('button', {
      class: cls,
      text: this.fullscreenLabel(),
      attrs: { type: 'button', 'data-testid': 'player-fullscreen' },
      on: { click: () => void setFullscreen(!isFullscreen()).then(() => this.refreshFullscreenButtons()) },
    });
    this.fullscreenButtons.add(b);
    return b;
  }

  private titleItems(): HTMLElement[] {
    return fullscreenSupported() && !isFullscreen() ? [this.fullscreenButton('g-menu-btn')] : [];
  }

  private settingsItems(): HTMLElement[] {
    const buttons = QUALITY_LABELS.map(([q, label]) =>
      h('button', {
        text: label,
        class: q === this.qualityPref ? 'on' : '',
        attrs: { type: 'button', 'data-testid': `player-quality-${q}`, 'aria-pressed': String(q === this.qualityPref) },
        on: {
          click: () => {
            this.setQualityPref(q);
            for (const b of buttons) {
              const on = b.dataset.testid === `player-quality-${q}`;
              b.classList.toggle('on', on);
              b.setAttribute('aria-pressed', String(on));
            }
          },
        },
      }),
    );
    const items: HTMLElement[] = [h('div', { class: 'g-choice' }, h('span', { text: '画質' }), h('div', { class: 'g-choice-options', attrs: { role: 'group', 'aria-label': '画質' } }, buttons))];
    if (fullscreenSupported()) items.push(this.fullscreenButton('g-menu-btn'));
    return items;
  }
}
