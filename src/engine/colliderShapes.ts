import type { ComponentData, EntityData, Vec3 } from '../core/types';

/**
 * 当たり判定 (コライダー) の形状を決める。
 * 物理エンジン (runtime) とエディタのコライダー表示の両方で使う純粋な関数。
 */

export type ColliderShapeKind = 'auto' | 'box' | 'sphere' | 'capsule' | 'cylinder';

export type ColliderShape =
  | { kind: 'box'; half: Vec3; offset: Vec3 }
  | { kind: 'sphere'; radius: number; offset: Vec3 }
  | { kind: 'cylinder'; radiusTop: number; radiusBottom: number; height: number; offset: Vec3 }
  | { kind: 'capsule'; radius: number; height: number; offset: Vec3 };

export type BodyType = 'dynamic' | 'kinematic' | 'static';

export interface RigidbodyProps {
  type: BodyType;
  mass: number;
  friction: number;
  bounciness: number;
  linearDamping: number;
  lockRotation: boolean;
  useGravity: boolean;
}

export interface ColliderProps {
  shape: ColliderShapeKind;
  trigger: boolean;
  size: Vec3;
  offset: Vec3;
}

const v3 = (v: unknown, d: Vec3): Vec3 =>
  Array.isArray(v) && v.length === 3 ? [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0] : [...d];
const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function readRigidbody(c: ComponentData | undefined): RigidbodyProps | null {
  if (!c || !c.enabled) return null;
  const p = c.props;
  const type = p.type === 'static' || p.type === 'kinematic' ? p.type : 'dynamic';
  return {
    type,
    mass: Math.max(0.01, n(p.mass, 1)),
    friction: Math.max(0, n(p.friction, 0.4)),
    bounciness: Math.max(0, Math.min(1, n(p.bounciness, 0.1))),
    linearDamping: Math.max(0, Math.min(1, n(p.linearDamping, 0.05))),
    lockRotation: p.lockRotation === true,
    useGravity: p.useGravity !== false,
  };
}

export function readCollider(c: ComponentData | undefined): ColliderProps | null {
  if (!c || !c.enabled) return null;
  const p = c.props;
  const shape = (['auto', 'box', 'sphere', 'capsule', 'cylinder'] as const).includes(p.shape as ColliderShapeKind)
    ? (p.shape as ColliderShapeKind)
    : 'auto';
  return { shape, trigger: p.trigger === true, size: v3(p.size, [1, 1, 1]), offset: v3(p.offset, [0, 0, 0]) };
}

export function hasPhysics(e: EntityData): boolean {
  return e.components.some((c) => c.enabled && (c.type === 'rigidbody' || c.type === 'collider'));
}

/**
 * エンティティとワールドでの拡大率から形状を計算する。
 * 基本図形は 1m (半径 0.5m) を基準に作られているので、その大きさに合わせる。
 */
export function computeColliderShape(e: EntityData, worldScale: Vec3, collider: ColliderProps | null): ColliderShape {
  const sx = Math.abs(worldScale[0]) || 1;
  const sy = Math.abs(worldScale[1]) || 1;
  const sz = Math.abs(worldScale[2]) || 1;
  const size = collider?.size ?? [1, 1, 1];
  const offset: Vec3 = collider ? [collider.offset[0] * sx, collider.offset[1] * sy, collider.offset[2] * sz] : [0, 0, 0];
  let kind = collider?.shape ?? 'auto';
  const meshShape = e.kind === 'mesh' ? e.mesh?.shape : undefined;
  if (kind === 'auto') {
    switch (meshShape) {
      case 'sphere':
        kind = 'sphere';
        break;
      case 'cylinder':
      case 'cone':
        kind = 'cylinder';
        break;
      case 'capsule':
        kind = 'capsule';
        break;
      default:
        kind = 'box';
    }
  }
  const W = size[0] * sx;
  const H = size[1] * sy;
  const D = size[2] * sz;
  switch (kind) {
    case 'sphere':
      return { kind: 'sphere', radius: 0.5 * Math.max(W, H, D), offset };
    case 'cylinder':
      return {
        kind: 'cylinder',
        radiusTop: meshShape === 'cone' && collider?.shape !== 'cylinder' ? 0.02 : 0.5 * Math.max(W, D),
        radiusBottom: 0.5 * Math.max(W, D),
        height: Math.max(0.02, H),
        offset,
      };
    case 'capsule': {
      // カプセルの基準形状は 半径 0.5・全高 2
      const radius = 0.5 * Math.max(W, D);
      const total = meshShape === 'capsule' ? 2 * H : Math.max(H, radius * 2);
      return { kind: 'capsule', radius, height: Math.max(0, total - radius * 2), offset };
    }
    default: {
      // 平面は薄い箱として扱う
      const thin = meshShape === 'plane' && (collider?.shape ?? 'auto') === 'auto';
      return { kind: 'box', half: [W / 2, thin ? 0.02 : H / 2, D / 2], offset: thin ? [offset[0], offset[1] - 0.02, offset[2]] : offset };
    }
  }
}
