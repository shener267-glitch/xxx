import type { EventBlock } from '../core/events';
import { itemsBetween } from '../core/timeline';
import type { TimelineData } from '../core/types';

/**
 * タイムライン (カットシーン) の再生。時刻になった動作をイベントの仕組みで実行する。
 * 会話などでゲームが止まっている間は進まない (ランタイムが update を呼ばない)。
 */
export interface TimelineHost {
  /** 動作を順に実行する (待つ・会話もイベントと同じように動く) */
  runActions(actions: EventBlock[], name: string): void;
  switchCamera(id: string | null, seconds: number): void;
  /** カットシーンの表示 (操作ボタンを隠す・上下の黒帯・スキップボタン) */
  setCutscene(on: boolean, opts: { lockPlayer: boolean; skippable: boolean; onSkip: () => void }): void;
  emit(event: string, id: string): void;
}

export class TimelinePlayer {
  private cur: { tl: TimelineData; t: number } | null = null;

  constructor(
    private host: TimelineHost,
    private list: TimelineData[],
  ) {}

  /** 再生中のタイムライン */
  get current(): TimelineData | null {
    return this.cur?.tl ?? null;
  }

  get time(): number {
    return this.cur ? Math.max(0, this.cur.t) : 0;
  }

  /** 再生中はプレイヤーを操作できない */
  get lockPlayer(): boolean {
    return !!this.cur?.tl.lockPlayer;
  }

  play(id: string): boolean {
    const tl = this.list.find((t) => t.id === id);
    if (!tl) return false;
    if (this.cur) this.finish(false);
    // 0 秒の動作も実行するため、少し前から始める
    this.cur = { tl, t: -1 };
    this.host.setCutscene(true, { lockPlayer: tl.lockPlayer, skippable: tl.skippable, onSkip: () => this.skip() });
    this.host.emit('timeline-start', tl.id);
    this.advance(0);
    return true;
  }

  /** ゲーム開始時に「自動で再生」のものを再生する */
  playAutoplay(): void {
    const tl = this.list.find((t) => t.autoplay);
    if (tl) this.play(tl.id);
  }

  update(dt: number): void {
    if (this.cur) this.advance(dt);
  }

  private advance(dt: number): void {
    const cur = this.cur!;
    const from = cur.t;
    const to = Math.max(0, from) + dt;
    cur.t = to;
    const due = itemsBetween(cur.tl, from, to);
    if (due.length > 0) this.host.runActions(due.map((i) => i.action), `タイムライン「${cur.tl.name}」`);
    // 動作の中で別のタイムラインが始まった・止められた場合
    if (this.cur !== cur) return;
    if (to >= cur.tl.duration) this.finish(true);
  }

  /** 残りを飛ばして終える */
  skip(): void {
    if (this.cur) this.finish(true);
  }

  private finish(emitEnd: boolean): void {
    const tl = this.cur!.tl;
    this.cur = null;
    this.host.setCutscene(false, { lockPlayer: false, skippable: false, onSkip: () => undefined });
    if (tl.restoreCamera) this.host.switchCamera(null, 0);
    if (emitEnd) this.host.emit('timeline-end', tl.id);
  }

  stop(): void {
    this.cur = null;
  }
}
