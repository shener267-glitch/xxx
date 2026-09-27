import type { Vec3 } from '../core/types';

/**
 * ゲームの進行状態 (スコア・お金・HP・残機・持ち物・変数・時間)。
 * DOM や描画に依存しないので単体テストできる。UI は change イベントで表示を更新する。
 */

export type GameStatus = 'playing' | 'gameover' | 'clear';
export type VarValue = number | string | boolean;

export interface SaveData {
  version: 1;
  sceneId: string;
  savedAt: number;
  position: Vec3 | null;
  score: number;
  money: number;
  hp: number;
  maxHp: number;
  lives: number;
  elapsed: number;
  inventory: Record<string, number>;
  variables: Record<string, VarValue>;
}

export class GameState {
  score = 0;
  money = 0;
  hp = 0;
  maxHp = 0;
  lives = 1;
  /** 経過時間 (秒) */
  elapsed = 0;
  /** 制限時間 (秒, 0 = なし) */
  timeLimit = 0;
  status: GameStatus = 'playing';
  /** 終了画面に表示するメッセージ */
  endMessage = '';
  /** 復活地点 (セーブポイント) */
  checkpoint: Vec3 | null = null;
  readonly inventory = new Map<string, number>();
  readonly variables = new Map<string, VarValue>();
  private listeners = new Set<() => void>();
  private dirty = false;

  /** 表示の更新が必要になったとき (1フレームにまとめて通知) */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  markDirty(): void {
    this.dirty = true;
  }

  /** 溜まった変更を通知する (毎フレーム呼ぶ) */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    for (const fn of this.listeners) fn();
  }

  get ended(): boolean {
    return this.status !== 'playing';
  }

  /** 残り時間 (制限時間が無い場合は null) */
  get remaining(): number | null {
    return this.timeLimit > 0 ? Math.max(0, this.timeLimit - this.elapsed) : null;
  }

  /** 時間を進める。制限時間を過ぎたら true */
  tick(dt: number): boolean {
    if (this.ended) return false;
    const before = Math.floor(this.elapsed);
    this.elapsed += dt;
    if (Math.floor(this.elapsed) !== before) this.dirty = true;
    return this.timeLimit > 0 && this.elapsed >= this.timeLimit;
  }

  addScore(n: number): void {
    this.score = Math.max(0, Math.round((this.score + n) * 100) / 100);
    this.dirty = true;
  }

  addMoney(n: number): boolean {
    const next = Math.round((this.money + n) * 100) / 100;
    if (next < 0) return false;
    this.money = next;
    this.dirty = true;
    return true;
  }

  setHp(hp: number, maxHp = this.maxHp): void {
    this.maxHp = Math.max(0, maxHp);
    this.hp = Math.max(0, Math.min(this.maxHp, hp));
    this.dirty = true;
  }

  addItem(name: string, count = 1): void {
    const n = (this.inventory.get(name) ?? 0) + count;
    if (n <= 0) this.inventory.delete(name);
    else this.inventory.set(name, n);
    this.dirty = true;
  }

  hasItem(name: string, count = 1): boolean {
    return (this.inventory.get(name) ?? 0) >= count;
  }

  /** 持ち物を使う (足りなければ false) */
  useItem(name: string, count = 1): boolean {
    if (!this.hasItem(name, count)) return false;
    this.addItem(name, -count);
    return true;
  }

  getVar(name: string): VarValue | undefined {
    return this.variables.get(name);
  }

  setVar(name: string, value: VarValue): void {
    this.variables.set(name, value);
    this.dirty = true;
  }

  /** 数値の変数に足す (未定義なら 0 から) */
  addVar(name: string, n: number): number {
    const cur = this.variables.get(name);
    const next = (typeof cur === 'number' ? cur : Number(cur) || 0) + n;
    this.setVar(name, next);
    return next;
  }

  end(status: Exclude<GameStatus, 'playing'>, message = ''): boolean {
    if (this.ended) return false;
    this.status = status;
    this.endMessage = message;
    this.dirty = true;
    return true;
  }

  toSave(sceneId: string, position: Vec3 | null): SaveData {
    return {
      version: 1,
      sceneId,
      savedAt: Date.now(),
      position,
      score: this.score,
      money: this.money,
      hp: this.hp,
      maxHp: this.maxHp,
      lives: this.lives,
      elapsed: this.elapsed,
      inventory: Object.fromEntries(this.inventory),
      variables: Object.fromEntries(this.variables),
    };
  }

  /** セーブデータから状態を戻す (壊れた値は無視) */
  load(data: SaveData): void {
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    this.score = num(data.score, 0);
    this.money = num(data.money, 0);
    this.maxHp = num(data.maxHp, this.maxHp);
    this.hp = Math.min(this.maxHp, num(data.hp, this.maxHp));
    this.lives = Math.max(1, num(data.lives, this.lives));
    this.elapsed = num(data.elapsed, 0);
    this.checkpoint = Array.isArray(data.position) && data.position.length === 3 ? ([...data.position] as Vec3) : null;
    this.inventory.clear();
    for (const [k, v] of Object.entries(data.inventory ?? {})) if (typeof v === 'number' && v > 0) this.inventory.set(k, v);
    this.variables.clear();
    for (const [k, v] of Object.entries(data.variables ?? {})) {
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') this.variables.set(k, v);
    }
    this.dirty = true;
  }
}

/** 秒を「m:ss」に */
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * UI の文字の {score} などを現在の値に置き換える。
 * 使える記号: {score} {money} {hp} {maxHp} {lives} {time} {timer} {var:名前} {item:名前}
 */
export function formatUIText(text: string, s: GameState): string {
  if (!text.includes('{')) return text;
  return text.replace(/\{([^{}]+)\}/g, (all, raw: string) => {
    const key = raw.trim();
    switch (key) {
      case 'score':
        return String(s.score);
      case 'money':
        return String(s.money);
      case 'hp':
        return String(Math.ceil(s.hp));
      case 'maxHp':
        return String(s.maxHp);
      case 'lives':
        return String(s.lives);
      case 'time':
        return formatTime(s.elapsed);
      case 'timer':
        return formatTime(s.remaining ?? s.elapsed);
      default:
        break;
    }
    if (key.startsWith('var:')) {
      const v = s.getVar(key.slice(4).trim());
      return v === undefined ? '0' : String(v);
    }
    if (key.startsWith('item:')) return String(s.inventory.get(key.slice(5).trim()) ?? 0);
    return all;
  });
}

/** ゲージの値と最大値 */
export function barValue(source: string, max: number, s: GameState): { value: number; max: number } {
  const key = source.trim();
  let value = 0;
  let autoMax = 100;
  if (key === 'hp') {
    value = s.hp;
    autoMax = s.maxHp || 100;
  } else if (key === 'timer') {
    value = s.remaining ?? s.elapsed;
    autoMax = s.timeLimit || 60;
  } else if (key === 'score') {
    value = s.score;
  } else if (key === 'money') {
    value = s.money;
  } else if (key.startsWith('var:')) {
    const v = s.getVar(key.slice(4).trim());
    value = typeof v === 'number' ? v : Number(v) || 0;
  } else if (key.startsWith('item:')) {
    value = s.inventory.get(key.slice(5).trim()) ?? 0;
    autoMax = 10;
  }
  const m = max > 0 ? max : autoMax;
  return { value, max: m };
}
