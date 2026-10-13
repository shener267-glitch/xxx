import type { Vec3 } from '../core/types';

/**
 * Project HEMO: 実験室の寸法と置いてある物の定義 (Three.js に依存しない純粋なデータ)。
 * 単体テストから Node 上で検証できる。
 */

/** 部屋の大きさ (m)。床は X/Z が ±half の正方形、壁の高さは height */
export const ROOM = { halfX: 6, halfZ: 6, height: 4 } as const;

export type PropShape = 'box' | 'cylinder' | 'sphere';

export interface PropDef {
  id: string;
  label: string;
  shape: PropShape;
  /** box: 幅・高さ・奥行き / cylinder: 直径・高さ・直径 / sphere: 直径 ×3 */
  size: Vec3;
  color: string;
  /** 床の上での位置 (x, z) と向き (度) */
  x: number;
  z: number;
  rotationY: number;
}

/** 実験室に最初から置いてある物 (選択・移動できる) */
export const PROP_DEFS: PropDef[] = [
  { id: 'crate-a', label: '木箱 A', shape: 'box', size: [0.9, 0.9, 0.9], color: '#b5834a', x: -2.2, z: -1.4, rotationY: 20 },
  { id: 'crate-b', label: '木箱 B', shape: 'box', size: [0.7, 0.7, 0.7], color: '#9c6f3d', x: -1.2, z: -2.2, rotationY: -12 },
  { id: 'barrel', label: 'ドラム缶', shape: 'cylinder', size: [0.7, 1.0, 0.7], color: '#3f6fa8', x: 2.4, z: -2.1, rotationY: 0 },
  { id: 'ball', label: 'ボール', shape: 'sphere', size: [0.6, 0.6, 0.6], color: '#d2493f', x: 1.0, z: 1.3, rotationY: 0 },
  { id: 'bench', label: '実験台', shape: 'box', size: [2.4, 0.5, 0.8], color: '#7b8794', x: 0, z: -4.8, rotationY: 0 },
];

/** 床に置いたときの中心の位置 (高さ = 高さの半分) */
export function propRestPosition(def: PropDef): Vec3 {
  return [def.x, def.size[1] / 2, def.z];
}

/** 物の外側の半径 (壁からの余白の計算用) */
export function propRadius(def: PropDef): number {
  return Math.max(def.size[0], def.size[2]) / 2;
}

/** 物の中心が壁にめり込まないように部屋の中へ収める */
export function clampToRoom(x: number, z: number, margin: number): [number, number] {
  const mx = Math.max(0, ROOM.halfX - margin);
  const mz = Math.max(0, ROOM.halfZ - margin);
  return [Math.min(mx, Math.max(-mx, x)), Math.min(mz, Math.max(-mz, z))];
}

/** カメラの初期位置 */
export const HOME_VIEW = { target: [0, 1, 0] as Vec3, yaw: 20, pitch: 22, distance: 11 };
