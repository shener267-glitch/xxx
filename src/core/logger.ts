/**
 * ログ収集。デバッグコンソールはここに溜まったログを表示する。
 */
export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  time: number;
  level: LogLevel;
  message: string;
  /** エラー発生箇所 (例: 'Play / キューブ / 自動回転') */
  source?: string;
  detail?: string;
  /** 関係するオブジェクト (コンソールから選択できる) */
  entityId?: string;
  /** 通し番号 */
  seq: number;
}

export interface LogOptions {
  entityId?: string;
}

type LogListener = (entry: LogEntry) => void;

class Logger {
  readonly entries: LogEntry[] = [];
  private listeners = new Set<LogListener>();
  private clearListeners = new Set<() => void>();
  private max = 500;
  private seq = 0;
  /** まだコンソールで見ていないエラーの数 */
  unreadErrors = 0;

  log(level: LogLevel, message: string, source?: string, detail?: unknown, opts: LogOptions = {}): LogEntry {
    const entry: LogEntry = {
      time: Date.now(),
      level,
      message,
      source,
      detail: detail instanceof Error ? (detail.stack ?? detail.message) : detail !== undefined && detail !== '' ? String(detail) : undefined,
      entityId: opts.entityId,
      seq: ++this.seq,
    };
    if (level === 'error') this.unreadErrors++;
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.shift();
    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    consoleFn(`[PocketEngine]${source ? ` [${source}]` : ''} ${message}`, detail ?? '');
    for (const fn of this.listeners) {
      try {
        fn(entry);
      } catch {
        // リスナーのエラーは無視 (ログ処理で無限ループしないため)
      }
    }
    return entry;
  }

  info(message: string, source?: string) {
    return this.log('info', message, source);
  }
  warn(message: string, source?: string, detail?: unknown) {
    return this.log('warn', message, source, detail);
  }
  error(message: string, source?: string, detail?: unknown) {
    return this.log('error', message, source, detail);
  }

  subscribe(fn: LogListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** すべて消す */
  clear(): void {
    this.entries.length = 0;
    this.unreadErrors = 0;
    for (const fn of this.clearListeners) fn();
  }

  onClear(fn: () => void): () => void {
    this.clearListeners.add(fn);
    return () => this.clearListeners.delete(fn);
  }

  /** エラーを見たことにする */
  markRead(): void {
    if (this.unreadErrors === 0) return;
    this.unreadErrors = 0;
    for (const fn of this.clearListeners) fn();
  }

  /** テキストにする (コピー用) */
  toText(entries: LogEntry[] = this.entries): string {
    const lv: Record<LogLevel, string> = { info: '情報', warn: '警告', error: 'エラー' };
    return entries
      .map((e) => {
        const t = new Date(e.time);
        const hh = [t.getHours(), t.getMinutes(), t.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':');
        return `${hh} [${lv[e.level]}]${e.source ? ` (${e.source})` : ''} ${e.message}${e.detail ? `\n${e.detail}` : ''}`;
      })
      .join('\n');
  }
}

export const logger = new Logger();
