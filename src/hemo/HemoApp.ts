import { Plane, Raycaster, Vector2, Vector3 } from 'three';
import type { QualityLevel } from '../core/settings';
import { EditorCamera } from '../engine/EditorCamera';
import { EngineRenderer } from '../engine/EngineRenderer';
import { h } from '../ui/dom';
import { HemoCameraInput } from './HemoCameraInput';
import { HOME_VIEW } from './lab';
import { LabScene } from './LabScene';

/**
 * Project HEMO のアプリ本体 (Phase 1: 実験室と自由カメラ)。
 * Pocket Engine の描画 (EngineRenderer) とオービットカメラ (EditorCamera) を再利用する。
 * 通常のエディタとは独立していて、`?mode=hemo` で起動したときだけ読み込まれる。
 */
export class HemoApp {
  readonly engine: EngineRenderer;
  readonly lab: LabScene;
  readonly cam: EditorCamera;
  readonly input: HemoCameraInput;
  private viewport: HTMLElement;
  private selectionLabel: HTMLElement;
  private fpsLabel: HTMLElement;
  private menu: HTMLElement;
  private dirty = true;
  private raf = 0;
  private frames = 0;
  private fpsStart = performance.now();
  private raycaster = new Raycaster();
  private drag: { id: string; plane: Plane; offX: number; offZ: number } | null = null;
  private showFps = true;

  constructor(
    root: HTMLElement,
    quality: QualityLevel,
  ) {
    root.innerHTML = '';
    root.classList.add('hemo-root');

    // --- 上部バー ---
    this.menu = h(
      'div',
      { class: 'hemo-menu', attrs: { hidden: true }, data: { testid: 'hemo-menu' } },
      h('button', { class: 'hemo-menu-item', text: '通常の Pocket Engine へ', attrs: { type: 'button' }, on: { click: () => (location.href = location.pathname) } }),
      h('button', {
        class: 'hemo-menu-item',
        text: 'FPS 表示 切り替え',
        attrs: { type: 'button' },
        data: { testid: 'hemo-toggle-fps' },
        on: {
          click: () => {
            this.showFps = !this.showFps;
            this.fpsLabel.hidden = !this.showFps;
            this.menu.hidden = true;
          },
        },
      }),
    );
    const top = h(
      'header',
      { class: 'hemo-top' },
      h('strong', { class: 'hemo-title', text: 'Project HEMO' }),
      h('span', { class: 'hemo-exp', text: '実験 1', data: { testid: 'hemo-exp-name' } }),
      h('span', { class: 'hemo-save', text: '未保存', data: { testid: 'hemo-save' } }),
      h('button', {
        class: 'hemo-btn hemo-menu-btn',
        text: '☰',
        attrs: { type: 'button', 'aria-label': 'メニュー' },
        data: { testid: 'hemo-menu-btn' },
        on: { click: () => (this.menu.hidden = !this.menu.hidden) },
      }),
      this.menu,
    );

    // --- 3D ビュー ---
    this.selectionLabel = h('div', { class: 'hemo-selection', text: '物をタップで選択', data: { testid: 'hemo-selection' } });
    this.fpsLabel = h('div', { class: 'hemo-fps', text: '-- fps', data: { testid: 'hemo-fps' } });
    this.viewport = h('div', { class: 'hemo-viewport', data: { testid: 'hemo-viewport' } }, this.selectionLabel, this.fpsLabel);

    // --- 下部の操作 ---
    const bar = h(
      'footer',
      { class: 'hemo-bar' },
      this.button('リセット', 'hemo-reset', () => this.resetExperiment(), '物を最初の位置に戻す'),
      this.button('フォーカス', 'hemo-focus', () => this.focusSelection(), '選んだ物にカメラを寄せる'),
      this.button('視点リセット', 'hemo-cam-reset', () => this.resetCamera(), 'カメラを最初の位置に戻す'),
    );
    root.append(top, this.viewport, bar);

    // --- 3D ---
    this.engine = new EngineRenderer(this.viewport, { quality, shadows: quality !== 'low' });
    this.lab = new LabScene(quality);
    this.cam = new EditorCamera(this.engine.width / this.engine.height);
    this.cam.onChange = () => (this.dirty = true);
    this.cam.setViewport(this.engine.width, this.engine.height);
    this.resetCamera(false);
    this.engine.onResize((w, hh) => {
      this.cam.setViewport(w, hh);
      this.dirty = true;
    });
    this.input = new HemoCameraInput(this.viewport, this.cam, {
      onTap: (x, y) => this.selectAt(x, y),
      onDoubleTap: (x, y) => {
        this.selectAt(x, y);
        this.focusSelection();
      },
      dragBegin: (x, y) => this.dragBegin(x, y),
      dragMove: (x, y) => this.dragMove(x, y),
      dragEnd: () => (this.drag = null),
    });

    window.addEventListener('keydown', this.onKey);
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      if (this.cam.tick(now)) this.dirty = true;
      this.frames++;
      if (now - this.fpsStart >= 1000) {
        this.fpsLabel.textContent = `${Math.round((this.frames * 1000) / (now - this.fpsStart))} fps`;
        this.frames = 0;
        this.fpsStart = now;
      }
      if (this.dirty) this.renderNow();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private button(label: string, testid: string, onClick: () => void, title: string): HTMLButtonElement {
    return h('button', { class: 'hemo-btn', text: label, title, attrs: { type: 'button' }, data: { testid }, on: { click: onClick } });
  }

  renderNow(): void {
    this.dirty = false;
    this.engine.render(this.lab.scene, this.cam.camera);
  }

  // ------------------------------------------------------------------
  // 操作
  // ------------------------------------------------------------------

  private onKey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'r' || e.key === 'R') this.resetCamera();
    else if (e.key === 'f' || e.key === 'F') this.focusSelection();
    else if (e.key === 'Escape') this.select(null);
  };

  resetCamera(animate = true): void {
    this.cam.setState({ target: [...HOME_VIEW.target], yaw: HOME_VIEW.yaw, pitch: HOME_VIEW.pitch, distance: HOME_VIEW.distance }, animate);
  }

  /** 実験の状態 (物の位置・選択) を最初に戻す。カメラは動かさない */
  resetExperiment(): void {
    this.lab.reset();
    this.drag = null;
    this.updateLabel();
    this.dirty = true;
  }

  focusSelection(): void {
    const id = this.lab.selectedId;
    const box = id ? this.lab.boundsOf(id) : null;
    if (box) this.cam.focusBox(box, true);
  }

  select(id: string | null): void {
    this.lab.select(id);
    this.updateLabel();
    this.dirty = true;
  }

  private updateLabel(): void {
    const id = this.lab.selectedId;
    this.selectionLabel.textContent = id ? `選択中: ${this.lab.def(id)?.label ?? id}` : '物をタップで選択';
    this.selectionLabel.dataset.selected = id ?? '';
  }

  /** 画面上の点から光線を作る */
  private aim(clientX: number, clientY: number): void {
    const r = this.engine.canvas.getBoundingClientRect();
    const ndc = new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.cam.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.cam.camera);
  }

  private selectAt(x: number, y: number): void {
    this.aim(x, y);
    this.select(this.lab.pick(this.raycaster));
  }

  private dragBegin(x: number, y: number): boolean {
    const id = this.lab.selectedId;
    if (!id) return false;
    this.aim(x, y);
    if (this.lab.pick(this.raycaster) !== id) return false;
    const mesh = this.lab.props.get(id)!;
    const plane = new Plane(new Vector3(0, 1, 0), -mesh.position.y);
    const hit = new Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return false;
    this.drag = { id, plane, offX: hit.x - mesh.position.x, offZ: hit.z - mesh.position.z };
    return true;
  }

  private dragMove(x: number, y: number): void {
    const d = this.drag;
    if (!d) return;
    this.aim(x, y);
    const hit = new Vector3();
    if (!this.raycaster.ray.intersectPlane(d.plane, hit)) return;
    this.lab.moveProp(d.id, hit.x - d.offX, hit.z - d.offZ);
    this.dirty = true;
  }

  /** 物の画面上の位置 (px)。自動テスト用 */
  screenPos(id: string): { x: number; y: number } | null {
    const mesh = this.lab.props.get(id);
    if (!mesh) return null;
    const r = this.engine.canvas.getBoundingClientRect();
    const v = mesh.getWorldPosition(new Vector3()).project(this.cam.camera);
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    this.input.dispose();
    this.lab.dispose();
  }
}
