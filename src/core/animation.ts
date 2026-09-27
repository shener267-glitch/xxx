import type { TransformData, Vec3 } from './types';
import { createId } from './util';

/**
 * キーフレームアニメーション (位置・回転・大きさ)。
 * キーはその時刻の「ローカルのトランスフォーム」をそのまま記録する
 * (エディタでオブジェクトを動かして「今の姿勢を記録」するだけで作れるように)。
 */

export type AnimLoop = 'loop' | 'once' | 'pingpong';
export type AnimEasing = 'linear' | 'smooth';

export interface AnimKey {
  /** 秒 */
  t: number;
  p: Vec3;
  /** 度 */
  r: Vec3;
  s: Vec3;
}

export interface AnimClip {
  id: string;
  name: string;
  /** 秒 */
  duration: number;
  loop: AnimLoop;
  easing: AnimEasing;
  keys: AnimKey[];
}

export type AnimPreset = 'bob' | 'spin' | 'pulse' | 'swing' | 'door' | 'hop' | 'slide';

export const ANIM_PRESETS: { id: AnimPreset; label: string }[] = [
  { id: 'bob', label: '上下にふわふわ' },
  { id: 'spin', label: 'くるくる回る' },
  { id: 'pulse', label: 'ドキドキ (拡大縮小)' },
  { id: 'swing', label: 'ゆらゆら揺れる' },
  { id: 'hop', label: 'ぴょんと跳ねる' },
  { id: 'slide', label: '左右に往復' },
  { id: 'door', label: '扉が開く (1回)' },
];

export const LOOP_LABELS: Record<AnimLoop, string> = { loop: 'くり返す', once: '1回だけ', pingpong: '行って戻る' };

const v3 = (v: Vec3): Vec3 => [v[0], v[1], v[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

export function keyFromTransform(t: number, tr: TransformData): AnimKey {
  return { t, p: v3(tr.position), r: v3(tr.rotation), s: v3(tr.scale) };
}

/** プリセットからクリップを作る (base = 今のトランスフォーム) */
export function presetClip(preset: AnimPreset, base: TransformData, name?: string): AnimClip {
  const k = (t: number, dp: Vec3 = [0, 0, 0], dr: Vec3 = [0, 0, 0], ks = 1): AnimKey => ({
    t,
    p: add(base.position, dp),
    r: add(base.rotation, dr),
    s: mul(base.scale, ks),
  });
  const label = name ?? ANIM_PRESETS.find((p) => p.id === preset)?.label ?? 'アニメーション';
  const clip = (duration: number, keys: AnimKey[], loop: AnimLoop = 'loop', easing: AnimEasing = 'smooth'): AnimClip => ({ id: createId('anim'), name: label, duration, loop, easing, keys });
  switch (preset) {
    case 'spin':
      return clip(2, [k(0), k(1, [0, 0, 0], [0, 180, 0]), k(2, [0, 0, 0], [0, 360, 0])], 'loop', 'linear');
    case 'pulse':
      return clip(1, [k(0), k(0.5, [0, 0, 0], [0, 0, 0], 1.15), k(1)]);
    case 'swing':
      return clip(2, [k(0, [0, 0, 0], [0, 0, -12]), k(1, [0, 0, 0], [0, 0, 12]), k(2, [0, 0, 0], [0, 0, -12])]);
    case 'hop':
      return clip(0.8, [k(0), k(0.35, [0, 1, 0]), k(0.7), k(0.8)]);
    case 'slide':
      return clip(3, [k(0, [-2, 0, 0]), k(1.5, [2, 0, 0]), k(3, [-2, 0, 0])]);
    case 'door':
      return clip(1, [k(0), k(1, [0, 0, 0], [0, 90, 0])], 'once');
    default:
      return clip(2, [k(0), k(1, [0, 0.4, 0]), k(2)]);
  }
}

export function emptyClip(name: string, base: TransformData): AnimClip {
  return { id: createId('anim'), name, duration: 2, loop: 'loop', easing: 'smooth', keys: [keyFromTransform(0, base)] };
}

const ease = (x: number, mode: AnimEasing) => (mode === 'smooth' ? x * x * (3 - 2 * x) : x);
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** 再生位置 (経過時間) をクリップ内の時刻に変換する。1回だけのクリップは最後で止まる */
export function clipTime(clip: AnimClip, elapsed: number): number {
  const d = Math.max(0.01, clip.duration);
  if (clip.loop === 'once') return Math.min(d, Math.max(0, elapsed));
  if (clip.loop === 'pingpong') {
    const m = ((elapsed % (2 * d)) + 2 * d) % (2 * d);
    return m <= d ? m : 2 * d - m;
  }
  return ((elapsed % d) + d) % d;
}

/** 指定時刻の姿勢 (キーが無ければ null) */
export function sampleClip(clip: AnimClip, t: number): { p: Vec3; r: Vec3; s: Vec3 } | null {
  const keys = clip.keys;
  if (keys.length === 0) return null;
  if (keys.length === 1 || t <= keys[0].t) return { p: v3(keys[0].p), r: v3(keys[0].r), s: v3(keys[0].s) };
  const last = keys[keys.length - 1];
  if (t >= last.t) return { p: v3(last.p), r: v3(last.r), s: v3(last.s) };
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t < t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.t - a.t;
  const x = span > 0 ? ease((t - a.t) / span, clip.easing) : 1;
  return { p: lerp3(a.p, b.p, x), r: lerp3(a.r, b.r, x), s: lerp3(a.s, b.s, x) };
}

/** キーを時刻順に並べ、同じ時刻のキーは後のもので置き換える */
export function normalizeKeys(keys: AnimKey[]): AnimKey[] {
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const out: AnimKey[] = [];
  for (const k of sorted) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.t - k.t) < 1e-4) out[out.length - 1] = k;
    else out.push(k);
  }
  return out;
}

// ------------------------------------------------------------------
// 検証
// ------------------------------------------------------------------

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const vec = (v: unknown, d: Vec3): Vec3 => (Array.isArray(v) && v.length === 3 ? [num(v[0], d[0]), num(v[1], d[1]), num(v[2], d[2])] : v3(d));

export function sanitizeClips(raw: unknown): AnimClip[] {
  if (!Array.isArray(raw)) return [];
  const out: AnimClip[] = [];
  for (const c of raw) {
    if (typeof c !== 'object' || c === null) continue;
    const o = c as Record<string, unknown>;
    const keys = Array.isArray(o.keys)
      ? o.keys
          .filter((k): k is Record<string, unknown> => typeof k === 'object' && k !== null)
          .map((k) => ({ t: Math.max(0, num(k.t, 0)), p: vec(k.p, [0, 0, 0]), r: vec(k.r, [0, 0, 0]), s: vec(k.s, [1, 1, 1]) }))
      : [];
    out.push({
      id: typeof o.id === 'string' ? o.id : createId('anim'),
      name: typeof o.name === 'string' && o.name.trim() ? o.name.slice(0, 60) : `アニメ${out.length + 1}`,
      duration: Math.min(600, Math.max(0.05, num(o.duration, 2))),
      loop: o.loop === 'once' || o.loop === 'pingpong' ? o.loop : 'loop',
      easing: o.easing === 'linear' ? 'linear' : 'smooth',
      keys: normalizeKeys(keys),
    });
  }
  return out;
}
