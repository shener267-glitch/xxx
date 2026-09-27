import { Box3, MathUtils, PerspectiveCamera, Sphere, Vector3 } from 'three';
import type { CameraStateData, Vec3 } from '../core/types';

/**
 * エディタ用のオービットカメラ。
 * 注視点 (target) を中心に、水平角 (yaw)・見下ろし角 (pitch)・距離で位置を決める。
 * タッチ / マウスの入力は ViewportInput が解釈してこのクラスのメソッドを呼ぶ。
 */

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

export type ViewPreset = 'top' | 'bottom' | 'front' | 'back' | 'right' | 'left' | 'perspective';

/** 画面のうちパネルで覆われている幅・高さ (px) */
export interface ViewInsets {
  right: number;
  bottom: number;
}

const BASE_FOV = 55;
const INSET_MS = 260;

export class EditorCamera {
  readonly camera: PerspectiveCamera;
  target = new Vector3(0, 0.5, 0);
  yaw = 35;
  pitch = 28;
  distance = 13;

  private anim: {
    from: CameraStateData;
    to: CameraStateData;
    start: number;
    duration: number;
  } | null = null;

  private viewW = 1;
  private viewH = 1;
  private insets: ViewInsets = { right: 0, bottom: 0 };
  private insetAnim: { from: ViewInsets; to: ViewInsets; start: number } | null = null;

  /** カメラが動いたときに呼ばれる (再描画要求用) */
  onChange: () => void = () => {};

  constructor(aspect = 1) {
    this.camera = new PerspectiveCamera(BASE_FOV, aspect, 0.05, 2000);
    this.viewW = aspect;
    this.update();
  }

  setAspect(aspect: number): void {
    this.setViewport(aspect, 1);
  }

  /** 描画領域の大きさ (px) */
  setViewport(width: number, height: number): void {
    this.viewW = Math.max(1, width);
    this.viewH = Math.max(1, height);
    this.applyProjection();
  }

  /**
   * パネルに覆われた部分を除いた「見えている範囲」の中央を画面の中心にする。
   * (パネルを開いても選んだ物が隠れず、見た目の大きさは変わらない)
   */
  setInsets(insets: ViewInsets, animate = true): void {
    const to = { right: Math.max(0, insets.right), bottom: Math.max(0, insets.bottom) };
    const cur = this.insetAnim?.to ?? this.insets;
    if (Math.abs(cur.right - to.right) < 0.5 && Math.abs(cur.bottom - to.bottom) < 0.5) return;
    if (animate) {
      this.insetAnim = { from: { ...this.insets }, to, start: performance.now() };
    } else {
      this.insetAnim = null;
      this.insets = to;
      this.applyProjection();
      this.onChange();
    }
  }

  get viewInsets(): ViewInsets {
    return { ...this.insets };
  }

  get insetsAnimating(): boolean {
    return this.insetAnim !== null;
  }

  /** パネルで覆われていない範囲 (描画領域内の px) */
  visibleRect(): { x: number; y: number; width: number; height: number } {
    const { right, bottom } = this.clampedInsets();
    return { x: 0, y: 0, width: this.viewW - right, height: this.viewH - bottom };
  }

  /**
   * ギズモなど「画面に対して一定の大きさ」で描く物の補正倍率。
   * 覆われた分だけ仮想の画面が広がるので、その分小さくする
   */
  get screenScale(): number {
    const rad = MathUtils.degToRad(this.camera.fov / 2);
    return Math.tan(MathUtils.degToRad(BASE_FOV / 2)) / Math.tan(rad);
  }

  /** 覆われていない状態で処理する (サムネイルの撮影など) */
  withoutInsets<T>(fn: () => T): T {
    const saved = this.insets;
    this.insets = { right: 0, bottom: 0 };
    this.applyProjection();
    try {
      return fn();
    } finally {
      this.insets = saved;
      this.applyProjection();
    }
  }

  private clampedInsets(): ViewInsets {
    // 見える範囲が狭くなりすぎないようにする
    return {
      right: Math.min(this.insets.right, this.viewW * 0.7),
      bottom: Math.min(this.insets.bottom, this.viewH * 0.7),
    };
  }

  private applyProjection(): void {
    const cam = this.camera;
    const { right, bottom } = this.clampedInsets();
    const w = this.viewW;
    const h = this.viewH;
    if (right < 0.5 && bottom < 0.5) {
      cam.clearViewOffset();
      cam.fov = BASE_FOV;
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
      return;
    }
    // 画面より大きい仮想の画面を考え、その右下を切り出す。
    // 仮想の画面の中心 = 見えている範囲の中心、1px あたりの角度は元のまま
    const fullW = w + right;
    const fullH = h + bottom;
    cam.fov = MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(BASE_FOV / 2)) * (fullH / h)));
    cam.setViewOffset(fullW, fullH, right, bottom, w, h);
  }

  /** 状態から実際のカメラ位置・向きを計算する */
  update(): void {
    const yaw = MathUtils.degToRad(this.yaw);
    const pitch = MathUtils.degToRad(this.pitch);
    const offset = new Vector3(
      Math.cos(pitch) * Math.sin(yaw),
      Math.sin(pitch),
      Math.cos(pitch) * Math.cos(yaw),
    ).multiplyScalar(this.distance);
    this.camera.position.copy(this.target).add(offset);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
    // 距離に応じて描画範囲を調整 (遠景のちらつき防止)
    const near = MathUtils.clamp(this.distance * 0.005, 0.02, 1);
    if (Math.abs(this.camera.near - near) > 1e-4) {
      this.camera.near = near;
      this.camera.far = Math.max(2000, this.distance * 50);
      this.camera.updateProjectionMatrix();
    }
    this.onChange();
  }

  getState(): CameraStateData {
    return {
      target: [this.target.x, this.target.y, this.target.z].map((v) => Math.round(v * 1000) / 1000) as Vec3,
      yaw: Math.round(this.yaw * 100) / 100,
      pitch: Math.round(this.pitch * 100) / 100,
      distance: Math.round(this.distance * 1000) / 1000,
    };
  }

  setState(s: CameraStateData, animate = false): void {
    if (animate) {
      this.anim = { from: this.getState(), to: { ...s, target: [...s.target] as Vec3 }, start: performance.now(), duration: 350 };
      return;
    }
    this.anim = null;
    this.target.set(s.target[0], s.target[1], s.target[2]);
    this.yaw = s.yaw;
    this.pitch = MathUtils.clamp(s.pitch, -89, 89);
    this.distance = MathUtils.clamp(s.distance, 0.1, 1000);
    this.update();
  }

  /** アニメーション中なら1フレーム進める。動いていれば true */
  tick(now: number): boolean {
    const insetMoved = this.tickInsets(now);
    if (!this.anim) {
      if (insetMoved) this.onChange();
      return insetMoved;
    }
    const { from, to, start, duration } = this.anim;
    const t = Math.min(1, (now - start) / duration);
    const k = easeOutCubic(t);
    // 角度は近い方向に回るよう補間する
    let dYaw = ((to.yaw - from.yaw) % 360 + 540) % 360 - 180;
    if (!Number.isFinite(dYaw)) dYaw = 0;
    this.target.set(
      MathUtils.lerp(from.target[0], to.target[0], k),
      MathUtils.lerp(from.target[1], to.target[1], k),
      MathUtils.lerp(from.target[2], to.target[2], k),
    );
    this.yaw = from.yaw + dYaw * k;
    this.pitch = MathUtils.lerp(from.pitch, to.pitch, k);
    this.distance = MathUtils.lerp(from.distance, to.distance, k);
    if (t >= 1) this.anim = null;
    this.update();
    return true;
  }

  private tickInsets(now: number): boolean {
    const a = this.insetAnim;
    if (!a) return false;
    const t = Math.min(1, (now - a.start) / INSET_MS);
    const k = easeOutCubic(t);
    this.insets = {
      right: MathUtils.lerp(a.from.right, a.to.right, k),
      bottom: MathUtils.lerp(a.from.bottom, a.to.bottom, k),
    };
    if (t >= 1) this.insetAnim = null;
    this.applyProjection();
    return true;
  }

  get animating(): boolean {
    return this.anim !== null;
  }

  // ------------------------------------------------------------------
  // 操作
  // ------------------------------------------------------------------

  /** 画面上のドラッグ量 (px) で回転 */
  orbit(dx: number, dy: number): void {
    this.anim = null;
    this.yaw -= dx * 0.35;
    this.pitch = MathUtils.clamp(this.pitch + dy * 0.3, -89, 89);
    this.update();
  }

  /** 画面上のドラッグ量 (px) で平行移動。viewportHeight は描画領域の高さ */
  pan(dx: number, dy: number, viewportHeight: number): void {
    this.anim = null;
    const worldPerPx = (2 * this.distance * Math.tan(MathUtils.degToRad(BASE_FOV / 2))) / Math.max(1, viewportHeight);
    const right = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.target.addScaledVector(right, -dx * worldPerPx);
    this.target.addScaledVector(up, dy * worldPerPx);
    this.update();
  }

  /** factor < 1 で近づく */
  zoom(factor: number): void {
    this.anim = null;
    this.distance = MathUtils.clamp(this.distance * factor, 0.2, 800);
    this.update();
  }

  /** 境界球が「見えている範囲」に収まるようにカメラを寄せる */
  focusSphere(sphere: Sphere, animate = true): void {
    const r = Math.max(0.25, sphere.radius);
    const tanHalf = Math.tan(MathUtils.degToRad(BASE_FOV / 2));
    const vis = this.visibleRect();
    // 見えている範囲の縦・横の半分の角度 (tan)
    const tanV = tanHalf * (vis.height / this.viewH);
    const tanH = tanHalf * (vis.width / this.viewH);
    const fitH = r / Math.sin(Math.atan(tanV));
    const fitW = r / Math.sin(Math.atan(tanH));
    const dist = Math.max(fitH, fitW) * 1.15;
    const c = sphere.center;
    this.setState({ target: [c.x, c.y, c.z], yaw: this.yaw, pitch: this.pitch, distance: dist }, animate);
  }

  /** 距離・向きはそのままで、点が見えている範囲の中央に来るように動かす */
  revealPoint(p: Vector3, animate = true): void {
    this.setState({ target: [p.x, p.y, p.z], yaw: this.yaw, pitch: this.pitch, distance: this.distance }, animate);
  }

  focusBox(box: Box3, animate = true): void {
    if (box.isEmpty()) return;
    this.focusSphere(box.getBoundingSphere(new Sphere()), animate);
  }

  setView(preset: ViewPreset): void {
    const s = this.getState();
    const views: Record<ViewPreset, [number, number]> = {
      top: [0, 89],
      bottom: [0, -89],
      front: [0, 0],
      back: [180, 0],
      right: [90, 0],
      left: [-90, 0],
      perspective: [35, 28],
    };
    const [yaw, pitch] = views[preset];
    this.setState({ ...s, yaw, pitch }, true);
  }

  /** 画面中央の視線が地面 (y=0) と交わる点。無ければ注視点 */
  groundPointAtCenter(): Vector3 {
    const dir = new Vector3();
    this.camera.getWorldDirection(dir);
    if (dir.y < -0.05) {
      const t = -this.camera.position.y / dir.y;
      if (t > 0 && t < 200) return this.camera.position.clone().addScaledVector(dir, t);
    }
    return this.target.clone().setY(0);
  }
}
