import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import type { TransformData, Vec3 } from './types';
import { roundTo } from './util';

/**
 * TransformData (度数法) と Three.js の行列との相互変換。
 * 親子付け変更時に「見た目の位置を保ったまま」ローカル座標を再計算するために使う。
 */

const _pos = new Vector3();
const _quat = new Quaternion();
const _scale = new Vector3();
const _euler = new Euler();

export function transformToMatrix(t: TransformData, out = new Matrix4()): Matrix4 {
  _pos.set(t.position[0], t.position[1], t.position[2]);
  _euler.set(
    MathUtils.degToRad(t.rotation[0]),
    MathUtils.degToRad(t.rotation[1]),
    MathUtils.degToRad(t.rotation[2]),
    'XYZ',
  );
  _quat.setFromEuler(_euler);
  _scale.set(t.scale[0], t.scale[1], t.scale[2]);
  return out.compose(_pos, _quat, _scale);
}

export function matrixToTransform(m: Matrix4): TransformData {
  m.decompose(_pos, _quat, _scale);
  _euler.setFromQuaternion(_quat, 'XYZ');
  return {
    position: vec3Round([_pos.x, _pos.y, _pos.z]),
    rotation: vec3Round([
      MathUtils.radToDeg(_euler.x),
      MathUtils.radToDeg(_euler.y),
      MathUtils.radToDeg(_euler.z),
    ]),
    scale: vec3Round([_scale.x, _scale.y, _scale.z]),
  };
}

export function vec3Round(v: Vec3, digits = 4): Vec3 {
  return [roundTo(v[0], digits), roundTo(v[1], digits), roundTo(v[2], digits)];
}

/** 拡大率が 0 になると行列が退化するため、最小値を保証する */
export function safeScale(v: number): number {
  if (!Number.isFinite(v)) return 1;
  if (Math.abs(v) < 0.0001) return v < 0 ? -0.0001 : 0.0001;
  return v;
}
