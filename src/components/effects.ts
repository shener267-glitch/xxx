import { MathUtils, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { AnimClip } from '../core/animation';
import { clipTime, sampleClip, sanitizeClips } from '../core/animation';
import { MAX_PARTICLES, PARTICLE_PRESETS, ParticleEmitter, sceneRoot, settingsFromProps } from '../engine/particles';
import { registerComponent } from './registry';

/**
 * Phase 5: パーティクル・キーフレームアニメーション・キャラクターの動き。
 */

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** アニメーションの操作口 (イベントの「アニメーションを再生」から使う) */
export interface AnimationHandle {
  play(name: string): boolean;
  stop(): void;
  readonly current: string | null;
}

/** パーティクルの操作口 */
export interface ParticleHandle {
  play(): void;
  stop(): void;
  burst(n?: number): void;
}

/** 3D モデルに入っているアニメーション */
export interface ModelAnimHandle {
  readonly clips: string[];
  readonly current: string | null;
  play(name: string, opts?: { once?: boolean; fade?: number }): boolean;
  stop(): void;
}

/** 状態に合うモデルのアニメーション名を探す */
export function findStateClip(clips: string[], state: CharacterState): string | null {
  const patterns: Record<CharacterState, RegExp[]> = {
    idle: [/idle/i, /wait/i, /stand/i, /待機/],
    walk: [/walk/i, /歩/],
    run: [/run/i, /sprint/i, /走/, /walk/i],
    jump: [/jump/i, /ジャンプ/],
    fall: [/fall/i, /jump/i],
  };
  for (const re of patterns[state]) {
    const hit = clips.find((c) => re.test(c));
    if (hit) return hit;
  }
  return null;
}

export interface CharacterAnimHandle {
  readonly state: CharacterState;
}

export type CharacterState = 'idle' | 'walk' | 'run' | 'jump' | 'fall';

export function registerEffectComponents(): void {
  // ------------------------------------------------------------------
  // パーティクル
  // ------------------------------------------------------------------
  registerComponent({
    type: 'particles',
    label: 'パーティクル (エフェクト)',
    icon: 'sparkles',
    description: '炎・煙・火花・爆発・雨・雪などの粒を出します。エディタでは選択中 (または「エフェクトのプレビュー」ON) のときに動きます',
    category: 'effect',
    defaults: () => ({ preset: 'fire', amount: 1, size: 1, speed: 1, areaScale: 1, playOnStart: true, customColor: false, color: '#ffd35a', colorEnd: '#ff3b12' }),
    schema: [
      {
        key: 'preset',
        label: '種類',
        type: 'select',
        options: Object.entries(PARTICLE_PRESETS).map(([value, p]) => ({ value, label: p.label })),
      },
      { key: 'amount', label: '量', type: 'number', min: 0.05, max: 5, step: 0.1, hint: '倍率' },
      { key: 'size', label: '大きさ', type: 'number', min: 0.05, max: 10, step: 0.1, hint: '倍率' },
      { key: 'speed', label: '勢い', type: 'number', min: 0, max: 10, step: 0.1, hint: '倍率' },
      { key: 'areaScale', label: '範囲 (雨・雪)', type: 'number', min: 0.1, max: 20, step: 0.5, hint: '倍率', advanced: true },
      { key: 'playOnStart', label: '最初から出す', type: 'boolean', hint: 'OFF ならイベントで出す' },
      { key: 'customColor', label: '色を変える', type: 'boolean', advanced: true },
      { key: 'color', label: '出始めの色', type: 'color', advanced: true },
      { key: 'colorEnd', label: '消える前の色', type: 'color', advanced: true },
    ],
    create(ctx, props) {
      const rt = ctx.runtime;
      const settings = settingsFromProps(props);
      const emitter = new ParticleEmitter(settings, MAX_PARTICLES[rt.quality]);
      emitter.setViewportHeight(rt.viewportHeight);
      emitter.stopped = props.playOnStart === false;
      const handle: ParticleHandle = {
        play: () => {
          emitter.stopped = false;
          if (settings.burst > 0) emitter.burst();
        },
        stop: () => {
          emitter.stopped = true;
        },
        burst: (n) => emitter.burst(n),
      };
      let added = false;
      return {
        start() {
          rt.registerController(ctx.entity.id, 'particles', handle);
        },
        update(dt) {
          if (!added) {
            // 粒はワールド座標で動かすので、シーンの直下に置く
            sceneRoot(ctx.object).add(emitter.points);
            added = true;
          }
          if (rt.isDestroyed(ctx.entity.id) || !isShown(ctx.object)) emitter.stopped = true;
          ctx.object.updateWorldMatrix(true, false);
          emitter.update(dt, ctx.object.matrixWorld);
        },
        destroy() {
          emitter.dispose();
        },
      };
    },
  });

  // ------------------------------------------------------------------
  // キーフレームアニメーション
  // ------------------------------------------------------------------
  registerComponent({
    type: 'animation',
    label: 'アニメーション',
    icon: 'film',
    description: 'キーフレーム (位置・回転・大きさ) で動かします。オブジェクトを動かして「今の姿勢を記録」するだけで作れます',
    category: 'motion',
    defaults: () => ({ clips: [], autoplay: '', speed: 1 }),
    schema: [
      { key: 'clips', label: 'アニメーション', type: 'clips' },
      { key: 'speed', label: '再生の速さ', type: 'number', min: 0, max: 10, step: 0.1, hint: '倍率' },
    ],
    create(ctx, props) {
      const rt = ctx.runtime;
      const id = ctx.entity.id;
      const clips = sanitizeClips(props.clips);
      const speed = Math.max(0, num(props.speed, 1));
      let clip: AnimClip | null = null;
      let elapsed = 0;
      const apply = (c: AnimClip, t: number) => {
        const pose = sampleClip(c, clipTime(c, t));
        if (!pose) return;
        const o = ctx.object;
        o.position.set(pose.p[0], pose.p[1], pose.p[2]);
        o.rotation.set(MathUtils.degToRad(pose.r[0]), MathUtils.degToRad(pose.r[1]), MathUtils.degToRad(pose.r[2]), 'XYZ');
        o.scale.set(pose.s[0] || 1e-4, pose.s[1] || 1e-4, pose.s[2] || 1e-4);
      };
      const handle: AnimationHandle = {
        play(name) {
          const c = clips.find((x) => x.name === name) ?? (name ? undefined : clips[0]);
          if (!c) return false;
          clip = c;
          elapsed = 0;
          rt.emit('anim-start', id, { clip: c.name });
          return true;
        },
        stop() {
          clip = null;
        },
        get current() {
          return clip?.name ?? null;
        },
      };
      return {
        start() {
          rt.registerController(id, 'animation', handle);
          const auto = typeof props.autoplay === 'string' ? props.autoplay : '';
          if (auto) handle.play(auto);
        },
        update(dt) {
          if (!clip) return;
          elapsed += dt * speed;
          apply(clip, elapsed);
          if (clip.loop === 'once' && elapsed >= clip.duration) {
            const name = clip.name;
            clip = null;
            rt.emit('anim-end', id, { clip: name });
          }
        },
      };
    },
  });

  // ------------------------------------------------------------------
  // キャラクターの動き (歩く・走る・ジャンプ)
  // ------------------------------------------------------------------
  registerComponent({
    type: 'charAnim',
    label: 'キャラクターの動き',
    icon: 'person',
    description: '移動の速さに合わせて、待機・歩く・走る・ジャンプ・着地の動きを自動で付けます (当たり判定には影響しません)',
    category: 'motion',
    defaults: () => ({ intensity: 1, runSpeed: 5, lean: true }),
    schema: [
      { key: 'intensity', label: '動きの大きさ', type: 'number', min: 0, max: 3, step: 0.1, hint: '倍率' },
      { key: 'runSpeed', label: '「走る」になる速さ', type: 'number', min: 0.5, max: 50, step: 0.5, unit: 'm/秒', advanced: true },
      { key: 'lean', label: '走るとき前に傾く', type: 'boolean', advanced: true },
    ],
    create(ctx, props) {
      const rt = ctx.runtime;
      const id = ctx.entity.id;
      const k = Math.max(0, num(props.intensity, 1));
      const runSpeed = Math.max(0.5, num(props.runSpeed, 5));
      const lean = props.lean !== false;
      const content = (ctx.object.userData.content as Object3D | null) ?? null;
      const base = content ? { p: content.position.clone(), s: content.scale.clone() } : null;
      const last = new Vector3();
      const cur = new Vector3();
      let speed = 0;
      let vy = 0;
      let phase = 0;
      let squash = 0;
      let state: CharacterState = 'idle';
      let airborne = false;
      let t = 0;
      const handle: CharacterAnimHandle = {
        get state() {
          return state;
        },
      };
      let model: ModelAnimHandle | undefined;
      return {
        start() {
          rt.worldPosition(id, last);
          rt.registerController(id, 'charAnim', handle);
          // 骨のアニメーションを持つ 3D モデルなら、状態に合うアニメーションを再生する
          model = rt.getController<ModelAnimHandle>(id, 'modelAnim');
          if (model && model.clips.length > 0) {
            const idle = findStateClip(model.clips, 'idle');
            if (idle) model.play(idle);
          }
        },
        update(dt) {
          if (!content || !base || dt <= 0) return;
          t += dt;
          rt.worldPosition(id, cur);
          const hs = Math.hypot(cur.x - last.x, cur.z - last.z) / dt;
          const nvy = (cur.y - last.y) / dt;
          last.copy(cur);
          speed += (hs - speed) * Math.min(1, dt * 10);
          vy += (nvy - vy) * Math.min(1, dt * 12);
          const body = rt.physics?.bodies.get(id);
          const grounded = body ? rt.isGrounded(id) : Math.abs(vy) < 0.3;
          const prev = state;
          if (!grounded && vy > 0.8) state = 'jump';
          else if (!grounded && vy < -1.5) state = 'fall';
          else if (speed > runSpeed) state = 'run';
          else if (speed > 0.4) state = 'walk';
          else state = 'idle';
          if ((prev === 'jump' || prev === 'fall') && state !== 'jump' && state !== 'fall' && airborne) squash = 1;
          airborne = state === 'jump' || state === 'fall';
          if (prev !== state) {
            rt.emit('char-state', id, { state });
            if (model) {
              const clip = findStateClip(model.clips, state);
              if (clip) model.play(clip, { once: state === 'jump' });
            }
          }
          // モデルのアニメーションがある場合は、見た目の揺れは付けない
          if (model && model.clips.length > 0) return;

          // 足の運び (歩く・走るの速さに合わせる)
          phase += dt * (state === 'run' ? 14 : state === 'walk' ? 9 : 2);
          let bob = 0;
          let sy = 1;
          let tiltZ = 0;
          let tiltX = 0;
          switch (state) {
            case 'walk':
              bob = Math.abs(Math.sin(phase)) * 0.06;
              tiltZ = Math.sin(phase) * 0.05;
              break;
            case 'run':
              bob = Math.abs(Math.sin(phase)) * 0.1;
              tiltZ = Math.sin(phase) * 0.06;
              tiltX = lean ? 0.18 : 0;
              break;
            case 'jump':
              sy = 1.12;
              break;
            case 'fall':
              sy = 1.05;
              break;
            default:
              sy = 1 + Math.sin(t * 2.2) * 0.015;
          }
          // 着地のつぶれ
          if (squash > 0) {
            squash = Math.max(0, squash - dt * 6);
            sy *= 1 - squash * 0.18;
          }
          const syk = 1 + (sy - 1) * k;
          const sxz = 1 / Math.sqrt(Math.max(0.3, syk));
          content.scale.set(base.s.x * sxz, base.s.y * syk, base.s.z * sxz);
          content.position.set(base.p.x, base.p.y + bob * k, base.p.z);
          content.rotation.set(tiltX * k, 0, tiltZ * k);
        },
        destroy() {
          if (content && base) {
            content.position.copy(base.p);
            content.scale.copy(base.s);
            content.rotation.set(0, 0, 0);
          }
        },
      };
    },
  });
}

/** 親をたどって全部表示されているか */
function isShown(o: Object3D): boolean {
  let cur: Object3D | null = o;
  while (cur) {
    if (!cur.visible) return false;
    cur = cur.parent;
  }
  return true;
}
