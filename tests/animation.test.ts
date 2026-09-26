import { Matrix4 } from 'three';
import { describe, expect, it } from 'vitest';
import type { AnimClip } from '../src/core/animation';
import { clipTime, normalizeKeys, presetClip, sampleClip, sanitizeClips } from '../src/core/animation';
import { defaultTransform } from '../src/core/catalog';
import { ParticleEmitter, particleSettings, settingsFromProps } from '../src/engine/particles';

const clip = (keys: AnimClip['keys'], loop: AnimClip['loop'] = 'loop', easing: AnimClip['easing'] = 'linear'): AnimClip => ({ id: 'a', name: 'a', duration: 2, loop, easing, keys });
const key = (t: number, y: number) => ({ t, p: [0, y, 0] as [number, number, number], r: [0, 0, 0] as [number, number, number], s: [1, 1, 1] as [number, number, number] });

describe('キーフレームアニメーション', () => {
  it('キーの間を補間する (直線 / なめらか)', () => {
    const c = clip([key(0, 0), key(1, 2), key(2, 0)]);
    expect(sampleClip(c, 0.5)!.p[1]).toBeCloseTo(1);
    expect(sampleClip(c, 1.5)!.p[1]).toBeCloseTo(1);
    expect(sampleClip(c, -1)!.p[1]).toBe(0);
    expect(sampleClip(c, 5)!.p[1]).toBe(0);
    const smooth = clip([key(0, 0), key(1, 2)], 'loop', 'smooth');
    expect(sampleClip(smooth, 0.25)!.p[1]).toBeLessThan(0.5);
    expect(sampleClip(smooth, 0.5)!.p[1]).toBeCloseTo(1);
    expect(sampleClip(clip([]), 1)).toBeNull();
  });

  it('くり返し・1回だけ・行って戻る', () => {
    expect(clipTime(clip([], 'loop'), 5.5)).toBeCloseTo(1.5);
    expect(clipTime(clip([], 'once'), 5.5)).toBe(2);
    expect(clipTime(clip([], 'pingpong'), 2.5)).toBeCloseTo(1.5);
    expect(clipTime(clip([], 'pingpong'), 3.5)).toBeCloseTo(0.5);
  });

  it('プリセットは今の位置を基準に作られる', () => {
    const base = defaultTransform();
    base.position = [3, 1, -2];
    const hop = presetClip('hop', base);
    expect(hop.keys[0].p).toEqual([3, 1, -2]);
    expect(Math.max(...hop.keys.map((k) => k.p[1]))).toBe(2);
    const door = presetClip('door', base);
    expect(door.loop).toBe('once');
    expect(door.keys[door.keys.length - 1].r[1]).toBe(90);
  });

  it('キーの並べ替えと同じ時刻の置き換え', () => {
    const keys = normalizeKeys([key(1, 1), key(0, 0), key(1, 5)]);
    expect(keys.map((k) => [k.t, k.p[1]])).toEqual([
      [0, 0],
      [1, 5],
    ]);
  });

  it('壊れたデータを修復する', () => {
    const fixed = sanitizeClips([{ name: '', duration: -1, loop: 'x', keys: [{ t: 'a' }, { t: 1, p: [1, 2] }] }, 'junk']);
    expect(fixed).toHaveLength(1);
    expect(fixed[0].duration).toBe(0.05);
    expect(fixed[0].loop).toBe('loop');
    expect(fixed[0].keys).toEqual([
      { t: 0, p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] },
      { t: 1, p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] },
    ]);
    expect(fixed[0].name).toBe('アニメ1');
  });
});

describe('パーティクル', () => {
  it('プロパティから設定を作る (量・大きさ・色)', () => {
    const s = settingsFromProps({ preset: 'smoke', amount: 2, size: 3, customColor: true, color: '#ff0000' });
    const base = particleSettings('smoke');
    expect(s.rate).toBe(base.rate * 2);
    expect(s.size).toBeCloseTo(base.size * 3);
    expect(s.color).toBe('#ff0000');
    expect(settingsFromProps({ preset: 'unknown' }).preset).toBe('fire');
  });

  it('連続して出し、上限を超えない。止めると粒が消えて終わる', () => {
    const e = new ParticleEmitter(particleSettings('fire', { rate: 100, lifetime: 0.5 }), 20);
    const m = new Matrix4();
    for (let i = 0; i < 10; i++) e.update(0.1, m);
    expect(e.alive).toBeGreaterThan(0);
    expect(e.alive).toBeLessThanOrEqual(20);
    e.stopped = true;
    for (let i = 0; i < 20; i++) e.update(0.1, m);
    expect(e.alive).toBe(0);
    expect(e.finished).toBe(true);
    e.dispose();
  });

  it('爆発は一度にまとめて出て、しばらくすると終わる', () => {
    const e = new ParticleEmitter(particleSettings('explosion'), 400);
    e.update(0.016, new Matrix4());
    expect(e.alive).toBe(90);
    for (let i = 0; i < 100; i++) e.update(0.05, new Matrix4());
    expect(e.finished).toBe(true);
    e.burst(10);
    e.update(0.016, new Matrix4());
    expect(e.alive).toBe(10);
    e.dispose();
  });
});
