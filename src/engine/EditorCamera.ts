import { Box3, MathUtils, PerspectiveCamera, Sphere, Vector3 } from 'three';
import type { CameraStateData, Vec3 } from '../core/types';

/**
 * エディタ用のオービットカメラ。
 * 注視点 (target) を中心に、水平角 (yaw)・見下ろし角 (pitch)・距離で位置を決める。
 * タッチ / マウスの入力は ViewportInput が解釈してこのクラスのメソッドを呼ぶ。
 */

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

export type ViewPreset = 'top' | 'bottom' | 'front' | 'back' | 'right' | 'left' | 'perspective';

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

  /** カメラが動いたときに呼ばれる (再描画要求用) */
  onChange: () => void = () => {};

  constructor(aspect = 1) {
    this.camera = new PerspectiveCamera(55, aspect, 0.05, 2000);
    this.update();
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
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
    if (!this.anim) return false;
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
    const worldPerPx = (2 * this.distance * Math.tan(MathUtils.degToRad(this.camera.fov / 2))) / Math.max(1, viewportHeight);
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

  /** 境界球が画面に収まるようにカメラを寄せる */
  focusSphere(sphere: Sphere, animate = true): void {
    const r = Math.max(0.25, sphere.radius);
    const fov = MathUtils.degToRad(this.camera.fov);
    const fitH = r / Math.sin(fov / 2);
    const fitW = r / Math.sin(Math.atan(Math.tan(fov / 2) * this.camera.aspect));
    const dist = Math.max(fitH, fitW) * 1.15;
    const c = sphere.center;
    this.setState({ target: [c.x, c.y, c.z], yaw: this.yaw, pitch: this.pitch, distance: dist }, animate);
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
