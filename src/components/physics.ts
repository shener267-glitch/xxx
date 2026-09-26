import { registerComponent } from './registry';

/**
 * 物理のコンポーネント定義。
 * 実際の計算は runtime/PhysicsWorld が行うため、ここでは設定項目だけを定義する。
 */

let registered = false;

export function registerPhysicsComponents(): void {
  if (registered) return;
  registered = true;

  registerComponent({
    type: 'rigidbody',
    label: '物理 (Rigidbody)',
    icon: 'zap',
    description: '重力で落ちたり、ぶつかって転がったりします',
    category: 'physics',
    defaults: () => ({ type: 'dynamic', mass: 1, friction: 0.4, bounciness: 0.1, linearDamping: 0.05, lockRotation: false, useGravity: true }),
    schema: [
      {
        key: 'type',
        label: '種類',
        type: 'select',
        options: [
          { value: 'dynamic', label: '動く (重力・衝突で動く)' },
          { value: 'kinematic', label: '動かす (動作・イベントで動かす)' },
          { value: 'static', label: '固定 (動かない壁・床)' },
        ],
      },
      { key: 'mass', label: '重さ', type: 'number', min: 0.01, step: 0.1, unit: 'kg' },
      { key: 'friction', label: '摩擦', type: 'number', min: 0, max: 2, step: 0.05 },
      { key: 'bounciness', label: '跳ね返り', type: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'linearDamping', label: '空気抵抗', type: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'lockRotation', label: '回転しない', type: 'boolean' },
      { key: 'useGravity', label: '重力を受ける', type: 'boolean' },
    ],
  });

  registerComponent({
    type: 'collider',
    label: '当たり判定 (Collider)',
    icon: 'box',
    description: 'ぶつかる範囲を決めます。「すり抜け」にするとトリガー (通過したことの検出) になります',
    category: 'physics',
    defaults: () => ({ shape: 'auto', trigger: false, size: [1, 1, 1], offset: [0, 0, 0] }),
    schema: [
      {
        key: 'shape',
        label: '形',
        type: 'select',
        options: [
          { value: 'auto', label: '自動 (見た目に合わせる)' },
          { value: 'box', label: '箱' },
          { value: 'sphere', label: '球' },
          { value: 'capsule', label: 'カプセル' },
          { value: 'cylinder', label: '円柱' },
        ],
      },
      { key: 'trigger', label: 'すり抜け (トリガー)', type: 'boolean' },
      { key: 'size', label: '大きさ (倍率)', type: 'vec3', step: 0.1 },
      { key: 'offset', label: '中心のずれ', type: 'vec3', step: 0.1 },
    ],
  });
}
