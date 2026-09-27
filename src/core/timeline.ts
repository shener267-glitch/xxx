import type { EventBlock } from './events';
import { createBlock, getBlockDef, sanitizeRules } from './events';
import type { TimelineData, TimelineItem } from './types';
import { createId } from './util';

/**
 * タイムライン (カットシーン)。決まった時刻にイベントの「動作」を実行する。
 * カメラの切り替え・会話・移動・アニメーションなど、イベントで使える動作はすべて使える。
 */

export const MAX_TIMELINE_SECONDS = 600;

export function createTimeline(name = 'タイムライン'): TimelineData {
  return { id: createId('tl'), name, duration: 8, autoplay: false, lockPlayer: true, skippable: true, restoreCamera: true, items: [] };
}

export function createTimelineItem(time: number, action: EventBlock): TimelineItem {
  return { id: createId('ti'), time: clampTime(time), action };
}

export function clampTime(t: number): number {
  const v = Number.isFinite(t) ? t : 0;
  return Math.round(Math.max(0, Math.min(MAX_TIMELINE_SECONDS, v)) * 100) / 100;
}

/** 時刻の順に並べる (同じ時刻なら元の順) */
export function sortedItems(tl: TimelineData): TimelineItem[] {
  return tl.items.map((it, i) => ({ it, i })).sort((a, b) => a.it.time - b.it.time || a.i - b.i).map((x) => x.it);
}

/** (from, to] の間に実行する動作。from < 0 なら 0 秒のものも含む */
export function itemsBetween(tl: TimelineData, from: number, to: number): TimelineItem[] {
  return sortedItems(tl).filter((it) => it.time > from && it.time <= to);
}

/** その時刻に使っているカメラ (エディタのプレビュー用)。'player' = ふだんのカメラ、null = 指定なし */
export function cameraAt(tl: TimelineData, t: number): string | null {
  let cam: string | null = null;
  for (const it of sortedItems(tl)) {
    if (it.time > t) break;
    if (it.action.type === 'camera') cam = String(it.action.params.target ?? '') || null;
  }
  return cam;
}

/** いちばん最後の動作の時刻 (長さの目安) */
export function lastItemTime(tl: TimelineData): number {
  return tl.items.reduce((m, it) => Math.max(m, it.time), 0);
}

/** 壊れたデータを直す (未知の動作は残す) */
export function sanitizeTimelines(raw: unknown): TimelineData[] {
  if (!Array.isArray(raw)) return [];
  const out: TimelineData[] = [];
  const ids = new Set<string>();
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const id = typeof o.id === 'string' && o.id && !ids.has(o.id) ? o.id : createId('tl');
    ids.add(id);
    const items: TimelineItem[] = [];
    if (Array.isArray(o.items)) {
      for (const it of o.items) {
        if (!it || typeof it !== 'object') continue;
        const x = it as Record<string, unknown>;
        // 動作の修復はイベントと同じ仕組みを使う (1 つの動作を持つルールとして直す)
        const fixed = sanitizeRules([{ id: 'tmp', name: '', trigger: { type: 'start', params: {} }, actions: [x.action] }])[0]?.actions[0];
        if (!fixed) continue;
        items.push({ id: typeof x.id === 'string' && x.id ? x.id : createId('ti'), time: clampTime(Number(x.time)), action: fixed });
      }
    }
    const dur = Number(o.duration);
    out.push({
      id,
      name: typeof o.name === 'string' && o.name.trim() ? o.name.slice(0, 60) : 'タイムライン',
      duration: Number.isFinite(dur) && dur > 0 ? Math.min(MAX_TIMELINE_SECONDS, dur) : 8,
      autoplay: o.autoplay === true,
      lockPlayer: o.lockPlayer !== false,
      skippable: o.skippable !== false,
      restoreCamera: o.restoreCamera !== false,
      items,
    });
  }
  return out;
}

/** 動作の種類が存在するか (エディタの表示用) */
export function isKnownAction(block: EventBlock): boolean {
  return !!getBlockDef('action', block.type);
}

export { createBlock };
