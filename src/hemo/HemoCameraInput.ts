import type { EditorCamera } from '../engine/EditorCamera';

/**
 * Project HEMO のタッチ / マウス入力。
 *
 * - 1本指ドラッグ: 選択中の物の上から始めたらその物を動かす / それ以外は視点回転
 * - 2本指: ドラッグで平行移動 + ピンチでズーム
 * - タップ: 選択 / ダブルタップ: フォーカス
 * - マウス: 左ドラッグ回転 (選択中の物の上なら移動)、右 / 中ドラッグ平行移動、ホイールでズーム
 * 物の移動とカメラ操作が競合しないよう、ドラッグの開始時にどちらかに決める。
 */

export interface HemoInputHandlers {
  onTap(clientX: number, clientY: number): void;
  onDoubleTap(clientX: number, clientY: number): void;
  /** 物の移動を始められるなら true (選択中の物の上で押したとき) */
  dragBegin(clientX: number, clientY: number): boolean;
  dragMove(clientX: number, clientY: number): void;
  dragEnd(): void;
}

type Mode = 'idle' | 'pending' | 'orbit' | 'pan' | 'object' | 'multi' | 'blocked';

interface Ptr {
  x: number;
  y: number;
  sx: number;
  sy: number;
  t0: number;
  type: string;
  button: number;
}

const SLOP_TOUCH = 10;
const SLOP_MOUSE = 4;
const TAP_MS = 500;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_DIST = 28;

export class HemoCameraInput {
  enabled = true;
  private mode: Mode = 'idle';
  private pointers = new Map<number, Ptr>();
  private lastTap = { t: 0, x: 0, y: 0 };
  private multi = { dist: 0, mx: 0, my: 0 };
  private disposers: (() => void)[] = [];

  constructor(
    private el: HTMLElement,
    private camera: EditorCamera,
    private handlers: HemoInputHandlers,
  ) {
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    on('pointerdown', (e) => this.onDown(e));
    on('pointermove', (e) => this.onMove(e));
    on('pointerup', (e) => this.onUp(e, false));
    on('pointercancel', (e) => this.onUp(e, true));
    on('wheel', (e) => this.onWheel(e), { passive: false });
    on('contextmenu', (e) => e.preventDefault());
    el.style.touchAction = 'none';
  }

  get currentMode(): string {
    return this.mode;
  }

  private onDown(e: PointerEvent): void {
    if (!this.enabled) return;
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      // 合成イベントなどでは取得できない (動作には影響しない)
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t0: performance.now(), type: e.pointerType, button: e.button });
    if (this.pointers.size === 1) {
      this.mode = e.pointerType === 'mouse' && (e.button === 1 || e.button === 2) ? 'pan' : 'pending';
    } else if (this.pointers.size === 2) {
      if (this.mode === 'object') this.handlers.dragEnd();
      this.mode = 'multi';
      const [a, b] = [...this.pointers.values()];
      this.multi = { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    } else {
      this.mode = 'blocked';
    }
    e.preventDefault();
  }

  private onMove(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.enabled) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    switch (this.mode) {
      case 'pending': {
        const slop = p.type === 'mouse' ? SLOP_MOUSE : SLOP_TOUCH;
        if (Math.hypot(p.x - p.sx, p.y - p.sy) < slop) return;
        if (this.handlers.dragBegin(p.sx, p.sy)) {
          this.mode = 'object';
          this.handlers.dragMove(p.x, p.y);
        } else {
          this.mode = 'orbit';
          this.camera.orbit(p.x - p.sx, p.y - p.sy);
        }
        break;
      }
      case 'orbit':
        this.camera.orbit(dx, dy);
        break;
      case 'pan':
        this.camera.pan(dx, dy, this.el.clientHeight);
        break;
      case 'object':
        this.handlers.dragMove(p.x, p.y);
        break;
      case 'multi': {
        if (this.pointers.size < 2) return;
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        if (this.multi.dist > 1 && dist > 1) this.camera.zoom(this.multi.dist / dist);
        this.camera.pan(mx - this.multi.mx, my - this.multi.my, this.el.clientHeight);
        this.multi = { dist, mx, my };
        break;
      }
      default:
        break;
    }
    e.preventDefault();
  }

  private onUp(e: PointerEvent, cancelled: boolean): void {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    try {
      this.el.releasePointerCapture(e.pointerId);
    } catch {
      // 取得していなければ何もしない
    }
    const wasMode = this.mode;
    if (wasMode === 'object') this.handlers.dragEnd();
    if (wasMode === 'pending' && !cancelled && performance.now() - p.t0 < TAP_MS) {
      const now = performance.now();
      const near = Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < DOUBLE_TAP_DIST;
      if (now - this.lastTap.t < DOUBLE_TAP_MS && near) {
        this.lastTap.t = 0;
        this.handlers.onDoubleTap(p.x, p.y);
      } else {
        this.lastTap = { t: now, x: p.x, y: p.y };
        this.handlers.onTap(p.x, p.y);
      }
    }
    // 2本指から1本に減ったときは、残った指で急に視点が回らないよう、全部離すまで何もしない
    this.mode = this.pointers.size === 0 ? 'idle' : 'blocked';
  }

  private onWheel(e: WheelEvent): void {
    if (!this.enabled) return;
    e.preventDefault();
    this.camera.zoom(e.deltaY > 0 ? 1.1 : 0.9);
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }
}
