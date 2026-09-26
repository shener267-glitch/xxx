import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import type * as CANNON from 'cannon-es';
import type { EntityData, PhysicsSettings, Vec3 } from '../core/types';
import type { BodyType, ColliderShape } from '../engine/colliderShapes';
import { computeColliderShape, readCollider, readRigidbody } from '../engine/colliderShapes';

/**
 * 物理演算 (cannon-es) のラッパー。
 * cannon-es は物理を使うシーンを Play したときだけ読み込む (エディタの起動を軽くするため)。
 */

type CannonModule = typeof CANNON;

export interface PhysicsBody {
  entityId: string;
  body: CANNON.Body;
  object: Object3D;
  type: BodyType;
  trigger: boolean;
  useGravity: boolean;
  /** 静的・キネマティックな物体が動いたか判定するための前回のワールド行列 */
  lastMatrix: Matrix4;
}

export interface ContactEvent {
  a: string;
  b: string;
  /** どちらかがトリガー (すり抜け判定) */
  trigger: boolean;
}

const FIXED_STEP = 1 / 60;
const _pos = new Vector3();
const _quat = new Quaternion();
const _scale = new Vector3();
const _m = new Matrix4();

let modulePromise: Promise<CannonModule> | null = null;

export function loadPhysicsModule(): Promise<CannonModule> {
  if (!modulePromise) modulePromise = import('cannon-es');
  return modulePromise;
}

export class PhysicsWorld {
  readonly world: CANNON.World;
  readonly bodies = new Map<string, PhysicsBody>();
  private byBodyId = new Map<number, string>();
  private gravity: Vec3;
  onContactBegin: (e: ContactEvent) => void = () => {};
  onContactEnd: (e: ContactEvent) => void = () => {};

  private constructor(
    private C: CannonModule,
    settings: PhysicsSettings,
  ) {
    this.gravity = [...settings.gravity];
    this.world = new C.World({ gravity: new C.Vec3(...settings.gravity) });
    this.world.broadphase = new C.SAPBroadphase(this.world);
    this.world.allowSleep = true;
    (this.world.solver as CANNON.GSSolver).iterations = 8;
    this.world.defaultContactMaterial.friction = 0.4;
    this.world.defaultContactMaterial.restitution = 0.1;
    this.world.addEventListener('beginContact', (e: { bodyA: CANNON.Body | null; bodyB: CANNON.Body | null }) => this.emit(e, true));
    this.world.addEventListener('endContact', (e: { bodyA: CANNON.Body | null; bodyB: CANNON.Body | null }) => this.emit(e, false));
  }

  static async create(settings: PhysicsSettings): Promise<PhysicsWorld> {
    const C = await loadPhysicsModule();
    return new PhysicsWorld(C, settings);
  }

  private emit(e: { bodyA: CANNON.Body | null; bodyB: CANNON.Body | null }, begin: boolean): void {
    if (!e.bodyA || !e.bodyB) return;
    const a = this.byBodyId.get(e.bodyA.id);
    const b = this.byBodyId.get(e.bodyB.id);
    if (!a || !b) return;
    const ev: ContactEvent = { a, b, trigger: e.bodyA.isTrigger || e.bodyB.isTrigger };
    if (begin) this.onContactBegin(ev);
    else this.onContactEnd(ev);
  }

  private createShape(shape: ColliderShape): { shapes: CANNON.Shape[]; offsets: CANNON.Vec3[] } {
    const C = this.C;
    const o = new C.Vec3(...shape.offset);
    switch (shape.kind) {
      case 'sphere':
        return { shapes: [new C.Sphere(Math.max(0.01, shape.radius))], offsets: [o] };
      case 'cylinder':
        return {
          shapes: [new C.Cylinder(Math.max(0.01, shape.radiusTop), Math.max(0.01, shape.radiusBottom), Math.max(0.02, shape.height), 16)],
          offsets: [o],
        };
      case 'capsule': {
        // カプセル = 円柱 + 上下の球
        const r = Math.max(0.01, shape.radius);
        const h = shape.height;
        const shapes: CANNON.Shape[] = [new C.Sphere(r), new C.Sphere(r)];
        const offsets = [new C.Vec3(o.x, o.y + h / 2, o.z), new C.Vec3(o.x, o.y - h / 2, o.z)];
        if (h > 0.01) {
          shapes.push(new C.Cylinder(r, r, h, 12));
          offsets.push(o);
        }
        return { shapes, offsets };
      }
      default:
        return {
          shapes: [new C.Box(new C.Vec3(Math.max(0.005, shape.half[0]), Math.max(0.005, shape.half[1]), Math.max(0.005, shape.half[2])))],
          offsets: [o],
        };
    }
  }

  /** エンティティに物理ボディを作る。物理コンポーネントが無ければ何もしない */
  addEntity(e: EntityData, object: Object3D): PhysicsBody | null {
    const rb = readRigidbody(e.components.find((c) => c.type === 'rigidbody'));
    const col = readCollider(e.components.find((c) => c.type === 'collider'));
    if (!rb && !col) return null;
    const C = this.C;
    object.updateWorldMatrix(true, false);
    object.matrixWorld.decompose(_pos, _quat, _scale);
    const shape = computeColliderShape(e, [_scale.x, _scale.y, _scale.z], col);
    const type: BodyType = rb ? rb.type : 'static';
    const trigger = col?.trigger === true;
    const body = new C.Body({
      mass: type === 'dynamic' ? (rb?.mass ?? 1) : 0,
      type: type === 'dynamic' ? C.Body.DYNAMIC : type === 'kinematic' ? C.Body.KINEMATIC : C.Body.STATIC,
      position: new C.Vec3(_pos.x, _pos.y, _pos.z),
      quaternion: new C.Quaternion(_quat.x, _quat.y, _quat.z, _quat.w),
      linearDamping: rb?.linearDamping ?? 0.05,
      angularDamping: 0.1,
      fixedRotation: rb?.lockRotation ?? false,
      isTrigger: trigger,
      material: new C.Material({ friction: rb?.friction ?? 0.4, restitution: rb?.bounciness ?? 0.1 }),
    });
    const { shapes, offsets } = this.createShape(shape);
    shapes.forEach((s, i) => body.addShape(s, offsets[i]));
    body.updateMassProperties();
    this.world.addBody(body);
    const info: PhysicsBody = {
      entityId: e.id,
      body,
      object,
      type,
      trigger,
      useGravity: rb?.useGravity ?? true,
      lastMatrix: object.matrixWorld.clone(),
    };
    this.bodies.set(e.id, info);
    this.byBodyId.set(body.id, e.id);
    return info;
  }

  removeEntity(id: string): void {
    const info = this.bodies.get(id);
    if (!info) return;
    this.world.removeBody(info.body);
    this.byBodyId.delete(info.body.id);
    this.bodies.delete(id);
  }

  /** 1フレーム分進める (内部は固定ステップ) */
  step(dt: number): void {
    const C = this.C;
    // 静的・キネマティックな物体は、オブジェクト (イベントやアニメーションで動く) に合わせる
    for (const info of this.bodies.values()) {
      if (info.type === 'dynamic') {
        if (!info.useGravity) {
          const g = this.gravity;
          info.body.applyForce(new C.Vec3(-g[0] * info.body.mass, -g[1] * info.body.mass, -g[2] * info.body.mass));
        }
        continue;
      }
      info.object.updateWorldMatrix(true, false);
      if (info.object.matrixWorld.equals(info.lastMatrix)) {
        if (info.type === 'kinematic') info.body.velocity.set(0, 0, 0);
        continue;
      }
      info.object.matrixWorld.decompose(_pos, _quat, _scale);
      if (info.type === 'kinematic' && dt > 0) {
        // 動いた量から速度を求め、上に乗った物体を押せるようにする
        info.body.velocity.set((_pos.x - info.body.position.x) / dt, (_pos.y - info.body.position.y) / dt, (_pos.z - info.body.position.z) / dt);
      }
      info.body.position.set(_pos.x, _pos.y, _pos.z);
      info.body.quaternion.set(_quat.x, _quat.y, _quat.z, _quat.w);
      info.body.aabbNeedsUpdate = true;
      info.lastMatrix.copy(info.object.matrixWorld);
    }
    this.world.step(FIXED_STEP, dt, 4);
    // 動的な物体の結果をオブジェクトへ反映
    for (const info of this.bodies.values()) {
      if (info.type !== 'dynamic') continue;
      const b = info.body;
      const obj = info.object;
      _pos.set(b.position.x, b.position.y, b.position.z);
      _quat.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      if (obj.parent && obj.parent.parent) {
        // 親がある場合はローカル座標に変換する
        obj.parent.updateWorldMatrix(true, false);
        _m.copy(obj.parent.matrixWorld).invert();
        const world = new Matrix4().compose(_pos, _quat, obj.getWorldScale(_scale));
        world.premultiply(_m).decompose(obj.position, obj.quaternion, _scale);
      } else {
        obj.position.copy(_pos);
        obj.quaternion.copy(_quat);
      }
    }
  }

  // ------------------------------------------------------------------
  // ゲームロジックから使う操作
  // ------------------------------------------------------------------

  setVelocity(id: string, v: Vec3): void {
    const b = this.bodies.get(id)?.body;
    if (!b) return;
    b.wakeUp();
    b.velocity.set(v[0], v[1], v[2]);
  }

  getVelocity(id: string): Vec3 | null {
    const b = this.bodies.get(id)?.body;
    return b ? [b.velocity.x, b.velocity.y, b.velocity.z] : null;
  }

  applyImpulse(id: string, v: Vec3): void {
    const b = this.bodies.get(id)?.body;
    if (!b) return;
    b.wakeUp();
    b.applyImpulse(new this.C.Vec3(v[0], v[1], v[2]));
  }

  /** オブジェクトを瞬間移動させる (リスポーンなど) */
  teleport(id: string, pos: Vec3): void {
    const info = this.bodies.get(id);
    if (!info) return;
    info.body.position.set(pos[0], pos[1], pos[2]);
    info.body.velocity.set(0, 0, 0);
    info.body.angularVelocity.set(0, 0, 0);
    info.body.wakeUp();
  }

  /** 線分と最初に当たったボディのエンティティ ID (自分自身は除外) */
  raycast(from: Vec3, to: Vec3, ignore?: string): { id: string; point: Vec3; distance: number } | null {
    const C = this.C;
    const ignoreBody = ignore ? this.bodies.get(ignore)?.body : undefined;
    let best: { id: string; point: Vec3; distance: number } | null = null;
    this.world.raycastAll(new C.Vec3(...from), new C.Vec3(...to), { skipBackfaces: true }, (r: CANNON.RaycastResult) => {
      if (!r.body || r.body === ignoreBody || r.body.isTrigger) return;
      const id = this.byBodyId.get(r.body.id);
      if (!id) return;
      if (!best || r.distance < best.distance) {
        best = { id, point: [r.hitPointWorld.x, r.hitPointWorld.y, r.hitPointWorld.z], distance: r.distance };
      }
    });
    return best;
  }

  dispose(): void {
    for (const info of this.bodies.values()) this.world.removeBody(info.body);
    this.bodies.clear();
    this.byBodyId.clear();
  }
}
