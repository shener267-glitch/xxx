import { Matrix4, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { commitTransforms } from '../core/actions';
import type { Editor } from '../core/Editor';
import { vec3Round } from '../core/transformMath';
import type { TransformData } from '../core/types';
import { clone, snapTo } from '../core/util';
import type { EditorCamera } from './EditorCamera';
import type { GizmoController, NdcPointer } from './GizmoController';
import type { SceneBridge } from './SceneBridge';

/**
 * ビューポートのタッチ / マウス入力を解釈する。
 *
 * - 1本指タップ: 選択 (何もない所なら選択解除)
 * - 1本指ドラッグ: ギズモ操作 / 選択中オブジェクトの直接移動 / カメラ回転
 * - 2本指: ドラッグで平行移動、ピンチでズーム、ひねりで回転
 * - 長押し: コンテキストメニュー
 * - ダブルタップ: フォーカス
 * - マウス: 左ドラッグ回転、右/中ドラッグ平行移動、ホイールでズーム
 */

type Mode = 'idle' | 'pending' | 'gizmo' | 'orbit' | 'pan' | 'drag-object' | 'multi' | 'blocked';

interface PointerInfo {
  id: number;
  type: string;
  button: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  t0: number;
}

interface ObjectDrag {
  ids: string[];
  pickedId: string;
  before: Map<string, TransformData>;
  startWorld: Map<string, Vector3>;
  parentInv: Map<string, Matrix4>;
  plane: Plane;
  startHit: Vector3;
}

export interface ViewportInputHandlers {
  onTap(clientX: number, clientY: number, additive: boolean): void;
  onDoubleTap(clientX: number, clientY: number): void;
  onLongPress(clientX: number, clientY: number): void;
  /** ジェスチャー開始・終了 (UI のヒント表示用) */
  onGesture?(active: boolean): void;
}

const TAP_SLOP_TOUCH = 10;
const TAP_SLOP_MOUSE = 4;
const LONG_PRESS_MS = 550;

export class ViewportInput {
  enabled = true;
  private mode: Mode = 'idle';
  private pointers = new Map<number, PointerInfo>();
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressFrame = 0;
  private lastTap = { t: 0, x: 0, y: 0 };
  private multi = { dist: 0, midX: 0, midY: 0, angle: 0 };
  private drag: ObjectDrag | null = null;
  private raycaster = new Raycaster();
  private disposers: (() => void)[] = [];

  constructor(
    private el: HTMLElement,
    private editor: Editor,
    private camera: EditorCamera,
    private gizmo: GizmoController,
    private bridge: SceneBridge,
    private pickAt: (clientX: number, clientY: number) => string | null,
    private handlers: ViewportInputHandlers,
  ) {
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    on('pointerdown', (e) => this.onDown(e));
    on('pointermove', (e) => this.onMove(e));
    on('pointerup', (e) => this.onUp(e, false));
    on('pointercancel', (e) => this.onUp(e, true));
    on('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.pointers.has(e.pointerId)) this.gizmo.hover(null);
    });
    on('wheel', (e) => this.onWheel(e), { passive: false });
    on('contextmenu', (e) => e.preventDefault());
    el.style.touchAction = 'none';
  }

  get busy(): boolean {
    return this.mode !== 'idle';
  }

  private ndc(clientX: number, clientY: number): NdcPointer {
    const r = this.el.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * 2 - 1, y: -((clientY - r.top) / r.height) * 2 + 1 };
  }

  private setMode(mode: Mode): void {
    const wasActive = this.mode !== 'idle' && this.mode !== 'pending';
    this.mode = mode;
    const active = mode !== 'idle' && mode !== 'pending';
    if (wasActive !== active) this.handlers.onGesture?.(active);
  }

  // ------------------------------------------------------------------

  private onDown(e: PointerEvent): void {
    if (!this.enabled) return;
    e.preventDefault();
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      // 一部ブラウザではキャプチャできないことがある
    }
    const p: PointerInfo = {
      id: e.pointerId,
      type: e.pointerType,
      button: e.button,
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      t0: performance.now(),
    };
    this.pointers.set(e.pointerId, p);

    if (this.pointers.size === 1) {
      this.clearLongPress();
      if (e.pointerType === 'mouse' && e.button !== 0) {
        this.setMode('pending');
        return;
      }
      const ndc = this.ndc(e.clientX, e.clientY);
      const axis = this.gizmo.peekAxis(ndc);
      // 移動ツールで中央付近のハンドル (平面・自由移動) と選択中の本体が重なる場合は、
      // 指で扱いやすい「本体ドラッグ (地面に沿って移動)」を優先する。矢印 (X/Y/Z) はギズモ優先
      const centerHandle = axis !== null && this.editor.tool === 'translate' && ['XYZ', 'XY', 'YZ', 'XZ'].includes(axis);
      if (axis !== null && !(centerHandle && this.isOnSelected(e.clientX, e.clientY)) && this.gizmo.tryStart(ndc)) {
        this.setMode('gizmo');
        return;
      }
      this.gizmo.hover(null);
      this.setMode('pending');
      if (e.pointerType !== 'mouse') {
        this.longPressTimer = setTimeout(() => {
          this.longPressTimer = null;
          // 描画が重い端末では指の移動イベントが遅れて届くことがある。
          // 溜まっている入力を先に処理させるため、判定は次のフレームで行う
          // (その間に指が動いていればドラッグとして扱われ、長押しにはならない)
          this.longPressFrame = requestAnimationFrame(() => {
            this.longPressFrame = 0;
            if (this.mode === 'pending' && this.pointers.size === 1 && this.pointers.get(p.id) === p) {
              this.setMode('blocked');
              this.handlers.onLongPress(p.x, p.y);
            }
          });
        }, LONG_PRESS_MS);
      }
    } else if (this.pointers.size === 2) {
      this.clearLongPress();
      // 1本指の操作中に2本目が触れたら、その操作を取り消してカメラ操作に切り替える
      if (this.mode === 'gizmo') this.gizmo.cancel();
      if (this.mode === 'drag-object') this.cancelObjectDrag();
      this.beginMulti();
      this.setMode('multi');
    } else {
      this.setMode('blocked');
    }
  }

  private onMove(e: PointerEvent): void {
    if (!this.enabled) return;
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      // ボタンを押していないマウス移動: ギズモのハイライト
      if (e.pointerType === 'mouse') this.gizmo.hover(this.ndc(e.clientX, e.clientY));
      return;
    }
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;

    switch (this.mode) {
      case 'gizmo':
        this.gizmo.move(this.ndc(p.x, p.y));
        break;
      case 'pending': {
        const slop = p.type === 'mouse' ? TAP_SLOP_MOUSE : TAP_SLOP_TOUCH;
        if (Math.hypot(p.x - p.startX, p.y - p.startY) < slop) break;
        this.clearLongPress();
        if (p.type === 'mouse' && (p.button === 1 || p.button === 2 || e.shiftKey)) {
          this.setMode('pan');
          this.camera.pan(p.x - p.startX, p.y - p.startY, this.el.clientHeight);
        } else if (this.tryBeginObjectDrag(p)) {
          this.setMode('drag-object');
          this.updateObjectDrag(p.x, p.y);
        } else if (p.type === 'mouse' || this.editor.settings.oneFingerOrbit) {
          this.setMode('orbit');
          this.camera.orbit(p.x - p.startX, p.y - p.startY);
        } else {
          this.setMode('blocked');
        }
        break;
      }
      case 'orbit':
        this.camera.orbit(dx, dy);
        break;
      case 'pan':
        this.camera.pan(dx, dy, this.el.clientHeight);
        break;
      case 'drag-object':
        this.updateObjectDrag(p.x, p.y);
        break;
      case 'multi':
        this.updateMulti();
        break;
      default:
        break;
    }
  }

  private onUp(e: PointerEvent, cancelled: boolean): void {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    try {
      this.el.releasePointerCapture(e.pointerId);
    } catch {
      // 既に解放済み
    }
    this.clearLongPress();

    switch (this.mode) {
      case 'pending':
        if (this.pointers.size === 0 && !cancelled) {
          if (p.type === 'mouse' && p.button === 2) {
            this.handlers.onLongPress(p.x, p.y);
          } else if (p.type !== 'mouse' || p.button === 0) {
            this.handleTap(p, e);
          }
        }
        break;
      case 'gizmo': {
        const slop = p.type === 'mouse' ? TAP_SLOP_MOUSE : TAP_SLOP_TOUCH;
        const isTap = Math.hypot(p.x - p.startX, p.y - p.startY) < slop && performance.now() - p.t0 < 500;
        if (cancelled || isTap) {
          this.gizmo.cancel();
          // ハンドルの上でも「動かさずに離した」場合はタップとして選択に使う
          // (ハンドルが隣のオブジェクトに重なっていても選択できるように)
          // 何も無い所ならハンドルを押し損ねただけとみなして選択は変えない
          if (isTap && !cancelled && this.pointers.size === 0 && this.pickAt(p.x, p.y)) this.handleTap(p, e);
        } else {
          this.gizmo.end(this.ndc(e.clientX, e.clientY));
        }
        break;
      }
      case 'drag-object':
        if (cancelled) this.cancelObjectDrag();
        else this.endObjectDrag();
        break;
      default:
        break;
    }

    if (this.pointers.size === 0) this.setMode('idle');
    else if (this.mode === 'multi' && this.pointers.size === 1) this.setMode('blocked');
    else if (this.pointers.size === 2) this.beginMulti();
  }

  private handleTap(p: PointerInfo, e: PointerEvent): void {
    const now = performance.now();
    const isDouble = now - this.lastTap.t < 320 && Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < 30;
    this.lastTap = { t: isDouble ? 0 : now, x: p.x, y: p.y };
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (isDouble) this.handlers.onDoubleTap(p.x, p.y);
    else this.handlers.onTap(p.x, p.y, additive);
  }

  private onWheel(e: WheelEvent): void {
    if (!this.enabled) return;
    e.preventDefault();
    if (e.ctrlKey) {
      // トラックパッドのピンチ
      this.camera.zoom(Math.exp(e.deltaY * 0.01));
    } else {
      this.camera.zoom(Math.exp(Math.max(-100, Math.min(100, e.deltaY)) * 0.0015));
    }
  }

  private clearLongPress(): void {
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    this.longPressTimer = null;
    if (this.longPressFrame) cancelAnimationFrame(this.longPressFrame);
    this.longPressFrame = 0;
  }

  // ------------------------------------------------------------------
  // 2本指ジェスチャー
  // ------------------------------------------------------------------

  private twoPointers(): [PointerInfo, PointerInfo] | null {
    const list = [...this.pointers.values()];
    return list.length >= 2 ? [list[0], list[1]] : null;
  }

  private beginMulti(): void {
    const pair = this.twoPointers();
    if (!pair) return;
    const [a, b] = pair;
    this.multi = {
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }

  private updateMulti(): void {
    const pair = this.twoPointers();
    if (!pair) return;
    const [a, b] = pair;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const m = this.multi;
    if (m.dist > 10 && dist > 10) this.camera.zoom(m.dist / dist);
    this.camera.pan(midX - m.midX, midY - m.midY, this.el.clientHeight);
    let dAngle = angle - m.angle;
    if (dAngle > Math.PI) dAngle -= Math.PI * 2;
    if (dAngle < -Math.PI) dAngle += Math.PI * 2;
    // ひねり: 水平回転 (指の入れ替わりなどによる急な角度の飛びは無視)
    if (Math.abs(dAngle) < 0.3) this.camera.orbit((-dAngle * 180) / Math.PI / 0.35, 0);
    this.multi = { dist, midX, midY, angle };
  }

  // ------------------------------------------------------------------
  // 選択中オブジェクトの直接ドラッグ移動 (地面と平行に動かす)
  // ------------------------------------------------------------------

  private rayAt(clientX: number, clientY: number): Raycaster {
    const n = this.ndc(clientX, clientY);
    this.raycaster.setFromCamera(new Vector2(n.x, n.y), this.camera.camera);
    return this.raycaster;
  }

  private intersectPlane(plane: Plane, clientX: number, clientY: number): Vector3 | null {
    const ray = this.rayAt(clientX, clientY).ray;
    if (Math.abs(ray.direction.y) < 0.02) return null;
    const hit = ray.intersectPlane(plane, new Vector3());
    if (!hit || hit.distanceTo(ray.origin) > 500) return null;
    return hit;
  }

  /** 画面座標が選択中のオブジェクト (またはその子) の上か */
  private isOnSelected(clientX: number, clientY: number): boolean {
    const picked = this.pickAt(clientX, clientY);
    if (!picked) return false;
    const model = this.editor.scene;
    return this.editor.selection.ids.some((id) => model.isAncestorOrSelf(id, picked));
  }

  private tryBeginObjectDrag(p: PointerInfo): boolean {
    const ed = this.editor;
    if (ed.tool !== 'translate' || ed.selection.size === 0 || ed.mode !== 'edit') return false;
    const picked = this.pickAt(p.startX, p.startY);
    if (!picked) return false;
    // 選択中のオブジェクト (またはその子) を掴んだ場合のみ
    const model = ed.scene;
    const selected = ed.selection.ids.find((id) => model.isAncestorOrSelf(id, picked));
    if (!selected) return false;
    const ids = model.topLevel(ed.selection.ids).filter((id) => !model.get(id)?.locked);
    if (ids.length === 0) return false;
    const pickedObj = this.bridge.get(selected);
    if (!pickedObj) return false;
    pickedObj.updateWorldMatrix(true, false);
    const origin = new Vector3().setFromMatrixPosition(pickedObj.matrixWorld);
    const plane = new Plane(new Vector3(0, 1, 0), -origin.y);
    const startHit = this.intersectPlane(plane, p.startX, p.startY);
    if (!startHit) return false;

    const before = new Map<string, TransformData>();
    const startWorld = new Map<string, Vector3>();
    const parentInv = new Map<string, Matrix4>();
    for (const id of ids) {
      const obj = this.bridge.get(id);
      if (!obj) continue;
      obj.updateWorldMatrix(true, false);
      before.set(id, clone(model.require(id).transform));
      startWorld.set(id, new Vector3().setFromMatrixPosition(obj.matrixWorld));
      parentInv.set(id, obj.parent ? obj.parent.matrixWorld.clone().invert() : new Matrix4());
    }
    this.drag = { ids: [...before.keys()], pickedId: selected, before, startWorld, parentInv, plane, startHit };
    return true;
  }

  private updateObjectDrag(clientX: number, clientY: number): void {
    const d = this.drag;
    if (!d) return;
    const hit = this.intersectPlane(d.plane, clientX, clientY);
    if (!hit) return;
    const delta = hit.sub(d.startHit);
    delta.y = 0;
    const s = this.editor.settings;
    if (s.snapEnabled) {
      // 掴んだオブジェクトの位置をグリッドに合わせ、その差分を全体に適用
      const base = d.startWorld.get(d.pickedId) ?? d.startWorld.values().next().value!;
      const target = base.clone().add(delta);
      target.x = snapTo(target.x, s.snapMove);
      target.z = snapTo(target.z, s.snapMove);
      delta.copy(target.sub(base));
    }
    const model = this.editor.scene;
    for (const id of d.ids) {
      const start = d.startWorld.get(id);
      const inv = d.parentInv.get(id);
      const e = model.get(id);
      if (!start || !inv || !e) continue;
      const local = start.clone().add(delta).applyMatrix4(inv);
      model.setTransform(id, { ...e.transform, position: vec3Round([local.x, local.y, local.z]) });
    }
  }

  private endObjectDrag(): void {
    const d = this.drag;
    this.drag = null;
    if (d) commitTransforms(this.editor, d.before, '移動');
  }

  private cancelObjectDrag(): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    for (const [id, t] of d.before) if (this.editor.scene.has(id)) this.editor.scene.setTransform(id, t);
  }

  /** Play 開始時など、進行中の操作をすべて中断する */
  reset(): void {
    if (this.mode === 'gizmo') this.gizmo.cancel();
    if (this.mode === 'drag-object') this.cancelObjectDrag();
    this.clearLongPress();
    this.pointers.clear();
    this.setMode('idle');
  }

  dispose(): void {
    this.reset();
    this.disposers.forEach((d) => d());
  }
}
