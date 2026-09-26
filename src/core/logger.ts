/**
 * ログ収集。Phase 6 のデバッグコンソールはここに溜まったログを表示する。
 */
export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  time: number;
  level: LogLevel;
  message: string;
  /** エラー発生箇所 (例: 'Play / キューブ / 自動回転') */
  source?: string;
  detail?: string;
}

type LogListener = (entry: LogEntry) => void;

class Logger {
  readonly entries: LogEntry[] = [];
  private listeners = new Set<LogListener>();
  private max = 500;

  log(level: LogLevel, message: string, source?: string, detail?: unknown): LogEntry {
    const entry: LogEntry = {
      time: Date.now(),
      level,
      message,
      source,
      detail: detail instanceof Error ? (detail.stack ?? detail.message) : detail !== undefined ? String(detail) : undefined,
    };
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
}

export const logger = new Logger();
