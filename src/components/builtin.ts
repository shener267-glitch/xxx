import { MathUtils, Vector3 } from 'three';
import type { Vec3 } from '../core/types';
import { registerEffectComponents } from './effects';
import { registerGameplayComponents } from './gameplay';
import { registerPhysicsComponents } from './physics';
import { registerComponent } from './registry';

/**
 * Phase 1 の組み込みコンポーネント。
 * Play Mode の動作確認ができる最小限の「動き」を提供する。
 */

const asVec3 = (v: unknown): Vec3 =>
  Array.isArray(v) && v.length === 3 ? [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0] : [0, 0, 0];

let registered = false;

export function registerBuiltinComponents(): void {
  if (registered) return;
  registered = true;
  registerPhysicsComponents();
  registerGameplayComponents();
  registerEffectComponents();

  registerComponent({
    type: 'rotator',
    label: '自動回転',
    icon: 'rotate',
    description: 'Play 中にオブジェクトを回転させ続けます',
    category: 'motion',
    defaults: () => ({ speed: [0, 90, 0] }),
    schema: [{ key: 'speed', label: '回転速度 (度/秒)', type: 'vec3', step: 5 }],
    create(ctx, props) {
      const speed = asVec3(props.speed).map((d) => MathUtils.degToRad(d));
      return {
        update(dt) {
          ctx.object.rotation.x += speed[0] * dt;
          ctx.object.rotation.y += speed[1] * dt;
          ctx.object.rotation.z += speed[2] * dt;
        },
      };
    },
  });

  registerComponent({
    type: 'oscillator',
    label: '往復運動',
    icon: 'wave',
    description: '指定した軸に沿って行ったり来たりします',
    category: 'motion',
    defaults: () => ({ axis: 'y', amplitude: 1, frequency: 0.5 }),
    schema: [
      {
        key: 'axis',
        label: '軸',
        type: 'select',
        options: [
          { value: 'x', label: 'X (左右)' },
          { value: 'y', label: 'Y (上下)' },
          { value: 'z', label: 'Z (前後)' },
        ],
      },
      { key: 'amplitude', label: '振れ幅', type: 'number', min: 0, step: 0.1, unit: 'm' },
      { key: 'frequency', label: '速さ (往復/秒)', type: 'number', min: 0, step: 0.05 },
    ],
    create(ctx, props) {
      const base = new Vector3();
      const axis = props.axis === 'x' || props.axis === 'z' ? props.axis : 'y';
      const amplitude = Number(props.amplitude) || 0;
      const frequency = Number(props.frequency) || 0;
      return {
        start() {
          base.copy(ctx.object.position);
        },
        update(_dt, time) {
          ctx.object.position[axis] = base[axis] + Math.sin(time * Math.PI * 2 * frequency) * amplitude;
        },
      };
    },
  });
}
