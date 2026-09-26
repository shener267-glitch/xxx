/**
 * Play 中の入力。
 * - タッチ: 画面左側を触るとその場に仮想ジョイスティックが出る。右側ドラッグで視点操作
 * - マウス: ドラッグで視点操作、ホイールでズーム
 * - キーボード: WASD / 矢印キーで移動、Shift で走る
 *
 * 書き出したゲーム (Phase 6) でもそのまま使えるよう、エディタには依存しない。
 */

const JOYSTICK_RADIUS = 56;

export class RuntimeInput {
  /** 移動入力 (-1〜1)。x: 右が正、y: 前が正 */
  readonly move = { x: 0, y: 0 };
  /** 走行中 (ジョイスティックを大きく倒す / Shift) */
  running = false;
  /** 視点操作の累積量 (px)。consumeLook() で取り出す */
  private look = { x: 0, y: 0 };
  private zoomDelta = 0;
  private keys = new Set<string>();
  private joyPointer: number | null = null;
  private joyOrigin = { x: 0, y: 0 };
  private joyVec = { x: 0, y: 0 };
  private lookPointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private joyBase: HTMLDivElement;
  private joyKnob: HTMLDivElement;
  private disposers: (() => void)[] = [];
  joystickEnabled = true;

  constructor(private el: HTMLElement) {
    el.classList.add('runtime-input');
    el.style.touchAction = 'none';
    this.joyBase = document.createElement('div');
    this.joyBase.className = 'joystick';
    this.joyKnob = document.createElement('div');
    this.joyKnob.className = 'joystick-knob';
    this.joyBase.appendChild(this.joyKnob);
    el.appendChild(this.joyBase);
    this.hideJoystick();

    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    on(el, 'pointerdown', (e) => this.onDown(e));
    on(el, 'pointermove', (e) => this.onMove(e));
    on(el, 'pointerup', (e) => this.onUp(e));
    on(el, 'pointercancel', (e) => this.onUp(e));
    on(el, 'wheel', (e) => {
      e.preventDefault();
      this.zoomDelta += e.deltaY;
    }, { passive: false });
    on(el, 'contextmenu', (e) => e.preventDefault());
    on(window, 'keydown', (e) => this.onKey(e as unknown as KeyboardEvent, true));
    on(window, 'keyup', (e) => this.onKey(e as unknown as KeyboardEvent, false));
    on(window, 'blur', () => {
      this.keys.clear();
      this.updateMove();
    });
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift', ' '].includes(k)) {
      if (down) this.keys.add(k);
      else this.keys.delete(k);
      this.updateMove();
      if (k.startsWith('arrow') || k === ' ') e.preventDefault();
    }
  }

  private updateMove(): void {
    let x = this.joyVec.x;
    let y = this.joyVec.y;
    const k = this.keys;
    if (k.has('w') || k.has('arrowup')) y += 1;
    if (k.has('s') || k.has('arrowdown')) y -= 1;
    if (k.has('d') || k.has('arrowright')) x += 1;
    if (k.has('a') || k.has('arrowleft')) x -= 1;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    this.move.x = x;
    this.move.y = y;
    this.running = k.has('shift') || Math.hypot(this.joyVec.x, this.joyVec.y) > 0.92;
  }

  private onDown(e: PointerEvent): void {
    e.preventDefault();
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      // 無視
    }
    const rect = this.el.getBoundingClientRect();
    const leftSide = e.clientX - rect.left < rect.width * 0.45;
    if (this.joystickEnabled && e.pointerType !== 'mouse' && leftSide && this.joyPointer === null) {
      this.joyPointer = e.pointerId;
      this.joyOrigin = { x: e.clientX, y: e.clientY };
      this.joyVec = { x: 0, y: 0 };
      this.showJoystick(e.clientX - rect.left, e.clientY - rect.top);
      this.updateMove();
      return;
    }
    this.lookPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.lookPointers.size === 2) this.pinchDist = this.currentPinch();
  }

  private currentPinch(): number {
    const [a, b] = [...this.lookPointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerId === this.joyPointer) {
      let dx = e.clientX - this.joyOrigin.x;
      let dy = e.clientY - this.joyOrigin.y;
      const len = Math.hypot(dx, dy);
      if (len > JOYSTICK_RADIUS) {
        dx = (dx / len) * JOYSTICK_RADIUS;
        dy = (dy / len) * JOYSTICK_RADIUS;
      }
      this.joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.joyVec = { x: dx / JOYSTICK_RADIUS, y: -dy / JOYSTICK_RADIUS };
      this.updateMove();
      return;
    }
    const p = this.lookPointers.get(e.pointerId);
    if (!p) return;
    if (this.lookPointers.size === 1) {
      this.look.x += e.clientX - p.x;
      this.look.y += e.clientY - p.y;
    }
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.lookPointers.size === 2) {
      const d = this.currentPinch();
      if (this.pinchDist > 0 && d > 0) this.zoomDelta += (this.pinchDist - d) * 2;
      this.pinchDist = d;
    }
  }

  private onUp(e: PointerEvent): void {
    try {
      this.el.releasePointerCapture(e.pointerId);
    } catch {
      // 無視
    }
    if (e.pointerId === this.joyPointer) {
      this.joyPointer = null;
      this.joyVec = { x: 0, y: 0 };
      this.hideJoystick();
      this.updateMove();
      return;
    }
    this.lookPointers.delete(e.pointerId);
    this.pinchDist = this.lookPointers.size === 2 ? this.currentPinch() : 0;
  }

  private showJoystick(x: number, y: number): void {
    this.joyBase.style.left = `${x}px`;
    this.joyBase.style.top = `${y}px`;
    this.joyBase.classList.add('active');
    this.joyKnob.style.transform = 'translate(0px, 0px)';
  }

  private hideJoystick(): void {
    this.joyBase.classList.remove('active');
  }

  consumeLook(): { x: number; y: number } {
    const v = { ...this.look };
    this.look.x = 0;
    this.look.y = 0;
    return v;
  }

  consumeZoom(): number {
    const z = this.zoomDelta;
    this.zoomDelta = 0;
    return z;
  }

  setJoystickEnabled(on: boolean): void {
    this.joystickEnabled = on;
    if (!on && this.joyPointer !== null) {
      this.joyPointer = null;
      this.joyVec = { x: 0, y: 0 };
      this.hideJoystick();
      this.updateMove();
    }
  }

  dispose(): void {
    this.disposers.forEach((d) => d());
    this.joyBase.remove();
    this.el.classList.remove('runtime-input');
  }
}
