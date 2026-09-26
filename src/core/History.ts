/**
 * Undo / Redo のためのコマンド履歴。
 * すべての編集操作は Command として実行し、ここに積む。
 */

export interface Command {
  /** 履歴表示用のラベル (例: 'キューブを追加') */
  readonly label: string;
  execute(): void;
  undo(): void;
  /**
   * 直前のコマンドと統合できるなら統合して true を返す。
   * (スライダーのドラッグなど連続した変更を1回の Undo にまとめるため)
   */
  mergeWith?(next: Command): boolean;
  /** 統合の結果、変更が無くなった場合に true */
  isNoop?(): boolean;
}

export interface HistoryEntry {
  command: Command;
  selectionBefore: string[];
  selectionAfter: string[];
  time: number;
}

export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(public limit = 100) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.command.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.command.label ?? null;
  }

  get size(): number {
    return this.undoStack.length;
  }

  peek(): HistoryEntry | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }

  /** 実行済みのコマンドを積む。mergeWindowMs 以内なら直前と統合を試みる */
  push(entry: HistoryEntry, mergeWindowMs = 0): void {
    this.redoStack.length = 0;
    const last = this.peek();
    if (last && mergeWindowMs > 0 && entry.time - last.time <= mergeWindowMs && last.command.mergeWith?.(entry.command)) {
      last.time = entry.time;
      last.selectionAfter = entry.selectionAfter;
      if (last.command.isNoop?.()) this.undoStack.pop();
      return;
    }
    if (entry.command.isNoop?.()) return;
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
  }

  undo(): HistoryEntry | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    entry.command.undo();
    this.redoStack.push(entry);
    return entry;
  }

  redo(): HistoryEntry | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    entry.command.execute();
    this.undoStack.push(entry);
    return entry;
  }

  /** 直前のエントリを統合対象から外す (次の変更を別の Undo 単位にする) */
  seal(): void {
    const last = this.peek();
    if (last) last.time = -Infinity;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
