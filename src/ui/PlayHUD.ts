import type { PlayCameraMode } from '../core/settings';
import { fullscreenSupported, isFullscreen, setFullscreen } from '../runtime/fullscreen';
import type { RuntimeStats } from '../runtime/GameRuntime';
import type { AppContext } from './context';
import { button, h, setIcon } from './dom';
import { toast } from './overlays';

const MODES: { id: PlayCameraMode; label: string }[] = [
  { id: 'game', label: 'ゲーム' },
  { id: 'firstPerson', label: '一人称' },
  { id: 'thirdPerson', label: '三人称' },
];

/**
 * Play 中に表示する操作パネル。
 */
export class PlayHUD {
  readonly el: HTMLElement;
  private stats: HTMLElement;
  private pauseBtn: HTMLButtonElement;
  private modeButtons = new Map<PlayCameraMode, HTMLButtonElement>();
  private hint: HTMLElement;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private ctx: AppContext) {
    const play = ctx.play;
    this.stats = h('div', { class: 'play-stats', attrs: { 'data-testid': 'play-stats' } });
    this.pauseBtn = button({
      icon: 'pause',
      title: '一時停止',
      class: 'hud-btn',
      testId: 'play-pause',
      onClick: () => {
        play.togglePause();
      },
    });
    const seg = h('div', { class: 'segmented hud-modes' });
    for (const m of MODES) {
      const b = h('button', {
        class: 'seg-btn',
        text: m.label,
        attrs: { type: 'button', 'data-testid': `play-mode-${m.id}` },
        on: { click: () => play.setCameraMode(m.id) },
      });
      this.modeButtons.set(m.id, b);
      seg.appendChild(b);
    }
    this.hint = h('div', { class: 'play-hint' });

    this.el = h(
      'div',
      { class: 'play-hud', attrs: { 'data-testid': 'play-hud' } },
      h(
        'div',
        { class: 'hud-top' },
        button({ icon: 'stop', label: '停止', class: 'hud-btn stop', testId: 'stop', onClick: () => play.stop() }),
        this.pauseBtn,
        seg,
        h('div', { class: 'tb-spacer' }),
        button({ icon: 'fullscreen', title: '全画面', class: 'hud-btn', testId: 'play-fullscreen', onClick: () => this.toggleFullscreen() }),
      ),
      h(
        'div',
        { class: 'hud-side' },
        button({ icon: 'bug', title: 'デバッグコンソール', class: 'hud-btn small', testId: 'play-console', onClick: () => ctx.console.toggle() }),
      ),
      this.stats,
      h('div', { class: 'paused-label', text: '一時停止中' }),
      this.hint,
    );

    play.subscribe({
      onStart: () => {
        this.el.classList.remove('paused');
        setIcon(this.pauseBtn, 'pause');
        this.stats.textContent = '';
        this.stats.hidden = !ctx.editor.settings.showFps;
      },
      onStop: () => {
        if (isFullscreen()) void setFullscreen(false);
      },
      onStats: (s) => this.showStats(s),
      onMessage: (m, level) => toast(m, level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', 3500),
      onCameraMode: (mode) => this.setMode(mode),
      onPause: (paused) => {
        setIcon(this.pauseBtn, paused ? 'play' : 'pause');
        this.pauseBtn.title = paused ? '再開' : '一時停止';
        this.el.classList.toggle('paused', paused);
      },
    });
  }

  private setMode(mode: PlayCameraMode): void {
    for (const [id, b] of this.modeButtons) b.classList.toggle('active', id === mode);
    const text =
      mode === 'game'
        ? 'メインカメラの視点です'
        : mode === 'firstPerson'
          ? '左側をドラッグで移動 ・ 右側をドラッグで視点 (PC: WASD + ドラッグ)'
          : '左側をドラッグでプレイヤーを移動 ・ 右側をドラッグでカメラ回転';
    this.hint.textContent = text;
    this.hint.classList.add('show');
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => this.hint.classList.remove('show'), 3500);
  }

  private showStats(s: RuntimeStats): void {
    if (!this.ctx.editor.settings.showFps) {
      this.stats.hidden = true;
      return;
    }
    this.stats.hidden = false;
    const mem = s.memory !== null ? ` ・ ${s.memory}MB` : '';
    this.stats.textContent = `${s.fps} FPS ・ 描画 ${s.drawCalls} ・ ${Math.round(s.triangles / 1000)}k△${mem}`;
  }

  private toggleFullscreen(): void {
    if (isFullscreen()) {
      void setFullscreen(false);
    } else if (fullscreenSupported()) {
      void setFullscreen(true).then((on) => {
        if (!on) toast('このブラウザでは全画面にできません', 'warn');
      });
    } else {
      // iPhone の Safari は全画面に対応していない (ホーム画面に追加すると全画面で動作)
      toast('ホーム画面に追加すると全画面で遊べます', 'info', 3000);
    }
  }
}
