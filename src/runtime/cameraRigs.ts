import { Euler, MathUtils, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { RuntimeInput } from './RuntimeInput';

/**
 * Play 中のカメラ制御。
 * - GameCameraRig: シーン内のメインカメラをそのまま使う
 * - FirstPersonRig: 一人称で歩き回る
 * - ThirdPersonRig: プレイヤーを後ろから追いかけ、ジョイスティックで動かす
 */
export interface CameraRig {
  readonly camera: PerspectiveCamera;
  update(dt: number, input: RuntimeInput): void;
  setAspect(aspect: number): void;
  dispose?(): void;
}

export class GameCameraRig implements CameraRig {
  constructor(readonly camera: PerspectiveCamera) {}

  update(): void {
    // メインカメラの動きはコンポーネント (自動回転など) に任せる
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}

const WALK_SPEED = 3;
const RUN_SPEED = 6.5;
const LOOK_SENSITIVITY = 0.25;

/** 一人称で追いかける対象 (プレイヤー操作コンポーネントが動かす) */
export interface FollowTarget {
  object: Object3D;
  /** 目の高さ (オブジェクトの中心からの高さ) */
  eyeHeight: number;
}

export class FirstPersonRig implements CameraRig {
  readonly camera: PerspectiveCamera;
  private yaw = 0;
  private pitch = 0;

  constructor(
    start: { position: Vector3; quaternion: Quaternion; fov?: number },
    private follow: FollowTarget | null = null,
  ) {
    this.camera = new PerspectiveCamera(start.fov ?? 70, 1, 0.05, 1000);
    this.camera.position.copy(start.position);
    const e = new Euler().setFromQuaternion(start.quaternion, 'YXZ');
    this.yaw = MathUtils.radToDeg(e.y);
    this.pitch = follow ? 0 : MathUtils.radToDeg(e.x);
    if (follow) {
      // プレイヤーの向いている方向から始める
      const q = new Quaternion();
      follow.object.getWorldQuaternion(q);
      const fwd = new Vector3(0, 0, 1).applyQuaternion(q);
      this.yaw = MathUtils.radToDeg(Math.atan2(-fwd.x, -fwd.z)) + 180;
      this.placeAtTarget();
    }
    this.apply();
  }

  private placeAtTarget(): void {
    if (!this.follow) return;
    this.follow.object.updateWorldMatrix(true, false);
    this.camera.position.setFromMatrixPosition(this.follow.object.matrixWorld);
    this.camera.position.y += this.follow.eyeHeight;
  }

  private apply(): void {
    this.camera.quaternion.setFromEuler(new Euler(MathUtils.degToRad(this.pitch), MathUtils.degToRad(this.yaw), 0, 'YXZ'));
  }

  update(dt: number, input: RuntimeInput): void {
    const look = input.consumeLook();
    this.yaw -= look.x * LOOK_SENSITIVITY;
    this.pitch = MathUtils.clamp(this.pitch - look.y * LOOK_SENSITIVITY, -85, 85);
    this.apply();
    if (this.follow) {
      // 移動はプレイヤー操作コンポーネントが行う。カメラは目の位置に付いていく
      this.placeAtTarget();
      input.consumeZoom();
      return;
    }
    const speed = input.running ? RUN_SPEED : WALK_SPEED;
    const yaw = MathUtils.degToRad(this.yaw);
    // 水平方向のみ移動 (高さは一定)
    const forward = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    this.camera.position.addScaledVector(forward, input.move.y * speed * dt);
    this.camera.position.addScaledVector(right, input.move.x * speed * dt);
    input.consumeZoom();
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}

export class ThirdPersonRig implements CameraRig {
  readonly camera: PerspectiveCamera;
  private yaw: number;
  private pitch = 18;
  private distance = 7;
  private focus = new Vector3();

  /**
   * @param controlTarget true ならジョイスティックで対象を動かす (プレイヤー操作コンポーネントが無い場合)
   */
  constructor(
    private target: Object3D,
    startYawDeg = 0,
    private controlTarget = true,
  ) {
    this.camera = new PerspectiveCamera(60, 1, 0.05, 1000);
    this.yaw = startYawDeg;
    this.target.updateWorldMatrix(true, false);
    this.focus.setFromMatrixPosition(this.target.matrixWorld);
    this.place();
  }

  private place(): void {
    const yaw = MathUtils.degToRad(this.yaw);
    const pitch = MathUtils.degToRad(this.pitch);
    const offset = new Vector3(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)).multiplyScalar(this.distance);
    const lookAt = this.focus.clone().add(new Vector3(0, 0.8, 0));
    this.camera.position.copy(lookAt).add(offset);
    this.camera.lookAt(lookAt);
  }

  update(dt: number, input: RuntimeInput): void {
    const look = input.consumeLook();
    this.yaw -= look.x * 0.3;
    this.pitch = MathUtils.clamp(this.pitch + look.y * 0.25, -10, 75);
    this.distance = MathUtils.clamp(this.distance * Math.exp(input.consumeZoom() * 0.0015), 2, 30);

    const mx = input.move.x;
    const my = input.move.y;
    const amount = Math.hypot(mx, my);
    if (this.controlTarget && amount > 0.01) {
      const speed = input.running ? RUN_SPEED : WALK_SPEED;
      const yaw = MathUtils.degToRad(this.yaw);
      // カメラの向きを基準に移動方向を決める
      const forward = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const right = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      const dir = forward.multiplyScalar(my).add(right.multiplyScalar(mx));
      const t = this.target;
      t.updateWorldMatrix(true, false);
      const world = new Vector3().setFromMatrixPosition(t.matrixWorld).addScaledVector(dir, speed * dt);
      if (t.parent) {
        t.parent.updateWorldMatrix(true, false);
        world.applyMatrix4(new Matrix4().copy(t.parent.matrixWorld).invert());
      }
      t.position.copy(world);
      // 進行方向を向かせる (滑らかに回転)
      const targetYaw = Math.atan2(dir.x, dir.z);
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), targetYaw);
      t.quaternion.slerp(q, Math.min(1, dt * 10));
    }
    this.target.updateWorldMatrix(true, false);
    const pos = new Vector3().setFromMatrixPosition(this.target.matrixWorld);
    // カメラは少し遅れて追従する
    this.focus.lerp(pos, Math.min(1, dt * 8));
    this.place();
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
