/**
 * 画面の更新の速さ (FPS) を測る。
 * エディタは変化があるときだけ描画するので、描画回数ではなくブラウザのフレーム (requestAnimationFrame) を数える。
 * 使うとき (コンソールや FPS 表示を開いているとき) だけ動かす。
 */
export class PerfMonitor {
  /** 直近の FPS (0.5 秒ごとに更新) */
  fps = 0;
  /** 1 フレームにかかった時間の平均 (ms) */
  frameMs = 0;
  /** いちばん遅かったフレーム (ms) */
  worstMs = 0;
  /** FPS の履歴 (古い順、最大 60 個 = 30 秒) */
  readonly history: number[] = [];
  private raf = 0;
  private users = 0;
  private last = 0;
  private windowStart = 0;
  private frames = 0;
  private worst = 0;
  private listeners = new Set<() => void>();

  /** 使い始める (戻り値の関数で終わる) */
  acquire(): () => void {
    this.users++;
    if (this.users === 1) {
      this.last = 0;
      this.windowStart = 0;
      this.frames = 0;
      this.raf = requestAnimationFrame(this.tick);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.users--;
      if (this.users === 0) cancelAnimationFrame(this.raf);
    };
  }

  get running(): boolean {
    return this.users > 0;
  }

  onUpdate(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    if (this.last) {
      const dt = now - this.last;
      if (dt > this.worst) this.worst = dt;
    }
    this.last = now;
    if (!this.windowStart) this.windowStart = now;
    this.frames++;
    const elapsed = now - this.windowStart;
    if (elapsed >= 500) {
      this.fps = Math.round((this.frames * 1000) / elapsed);
      this.frameMs = Math.round((elapsed / this.frames) * 10) / 10;
      this.worstMs = Math.round(this.worst);
      this.history.push(this.fps);
      if (this.history.length > 60) this.history.shift();
      this.frames = 0;
      this.worst = 0;
      this.windowStart = now;
      for (const fn of this.listeners) fn();
    }
  };
}

export const perfMonitor = new PerfMonitor();

/** 使用中の JS のメモリ (MB)。取得できないブラウザでは null */
export function jsHeapMB(): number | null {
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? Math.round(mem.usedJSHeapSize / 1048576) : null;
}
