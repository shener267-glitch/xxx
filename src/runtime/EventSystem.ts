import type { EventBlock, EventRule, VarValue } from '../core/events';
import { compare, parseValue } from '../core/events';
import type { Vec3 } from '../core/types';
import type { GameState } from './GameState';
import { formatUIText } from './GameState';

/**
 * イベント (「いつ」→「もし」→「なら / そうでなければ」) を実行する。
 * ゲーム本体 (GameRuntime) とは EventHost を通してだけやり取りするので、単体テストできる。
 */

export interface EventHost {
  readonly state: GameState;
  readonly playerId: string | null;
  /** ゲームの経過時間 (秒) */
  readonly time: number;
  exists(entityId: string): boolean;
  overlaps(a: string, b: string, margin?: number): boolean;
  distance(a: string, b: string): number;
  damage(target: string, amount: number): boolean;
  heal(target: string, amount: number): boolean;
  playSound(source: string, volume: number): void;
  playMusic(source: string | null): void;
  toast(message: string, seconds: number): void;
  talk(name: string, text: string): Promise<void>;
  setUIText(entityId: string, text: string): void;
  setVisible(entityId: string, visible: boolean): void;
  destroy(entityId: string): void;
  moveBy(entityId: string, offset: Vec3, seconds: number): void;
  teleport(entityId: string, destId: string): void;
  spawn(entityId: string, atId: string | null): string | null;
  launch(entityId: string, velocity: Vec3): void;
  changeScene(sceneId: string): void;
  gameClear(message: string): void;
  gameOver(message: string): void;
  log(message: string, level: 'info' | 'warn' | 'error'): void;
}

interface Run {
  rule: EventRule;
  actions: EventBlock[];
  index: number;
  wait: number;
  /** 会話ウィンドウなど、閉じられるまで待っている */
  blocked: boolean;
}

interface GameEvent {
  event: string;
  entityId: string;
  data?: unknown;
}

/** 1フレームで実行する動作の上限 (無限ループ対策) */
const MAX_ACTIONS_PER_FRAME = 200;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const vec = (v: unknown): Vec3 => (Array.isArray(v) && v.length === 3 ? [num(v[0]), num(v[1]), num(v[2])] : [0, 0, 0]);

export class EventSystem {
  private rules: EventRule[];
  private spent = new Set<string>();
  private fired = new Set<string>();
  private timers = new Map<string, number>();
  private touching = new Map<string, boolean>();
  private condState = new Map<string, boolean>();
  private runs: Run[] = [];
  private queue: GameEvent[] = [];
  private changedVars = new Set<string>();
  private budget = MAX_ACTIONS_PER_FRAME;
  private warnedLoop = false;
  /** 実行した動作の記録 (デバッグ用) */
  readonly log: string[] = [];

  constructor(
    rules: EventRule[],
    private host: EventHost,
  ) {
    this.rules = rules.filter((r) => r.enabled);
  }

  get ruleCount(): number {
    return this.rules.length;
  }

  /** 「プレイヤー」などの参照を実際のエンティティ ID にする */
  private resolve(id: unknown): string {
    const v = str(id);
    return v === 'player' ? (this.host.playerId ?? '') : v;
  }

  // ------------------------------------------------------------------
  // 入口
  // ------------------------------------------------------------------

  start(): void {
    for (const r of this.rules) if (r.trigger.type === 'start') this.fire(r);
  }

  /** ゲーム内の出来事 (runtime.emit) */
  onGameEvent(event: string, entityId: string, data?: unknown): void {
    this.queue.push({ event, entityId, data });
  }

  onKey(key: string): void {
    this.queue.push({ event: 'key', entityId: '', data: key });
  }

  /** 毎フレーム呼ぶ (ゲームが止まっている間は呼ばない) */
  update(dt: number): void {
    this.budget = MAX_ACTIONS_PER_FRAME;
    const h = this.host;
    for (const r of this.rules) {
      if (this.spent.has(r.id)) continue;
      const t = r.trigger;
      switch (t.type) {
        case 'after':
          if (!this.fired.has(r.id) && h.time >= num(t.params.seconds, 3)) {
            this.fired.add(r.id);
            this.fire(r);
          }
          break;
        case 'every': {
          const interval = Math.max(0.05, num(t.params.seconds, 5));
          const acc = (this.timers.get(r.id) ?? 0) + dt;
          if (acc >= interval) {
            this.timers.set(r.id, acc - interval);
            this.fire(r);
          } else {
            this.timers.set(r.id, acc);
          }
          break;
        }
        case 'touch':
        case 'leave': {
          const a = this.resolve(t.params.a);
          const b = this.resolve(t.params.b);
          if (!a || !b || a === b) break;
          const now = h.exists(a) && h.exists(b) && h.overlaps(a, b, 0.05);
          const before = this.touching.get(r.id) ?? false;
          this.touching.set(r.id, now);
          if (t.type === 'touch' ? now && !before : !now && before) this.fire(r);
          break;
        }
        case 'condition': {
          const ok = r.conditions.length > 0 && this.check(r.conditions);
          const before = this.condState.get(r.id) ?? false;
          this.condState.set(r.id, ok);
          if (ok && !before) this.run(r, r.actions, true);
          break;
        }
        default:
          break;
      }
    }
    this.flushQueue();
    this.advanceRuns(dt);
  }

  private flushQueue(): void {
    const events = this.queue;
    this.queue = [];
    const vars = [...this.changedVars];
    this.changedVars.clear();
    for (const ev of events) {
      for (const r of this.rules) {
        if (this.spent.has(r.id)) continue;
        if (this.matches(r.trigger, ev)) this.fire(r);
      }
    }
    for (const name of vars) {
      for (const r of this.rules) {
        if (!this.spent.has(r.id) && r.trigger.type === 'varChanged' && str(r.trigger.params.name) === name) this.fire(r);
      }
    }
  }

  private matches(t: EventBlock, ev: GameEvent): boolean {
    const target = str(t.params.target);
    const same = !target || this.resolve(target) === ev.entityId;
    switch (t.type) {
      case 'pickup':
        return ev.event === 'pickup' && same;
      case 'defeated':
        return ev.event === 'defeated' && same;
      case 'talk':
        return ev.event === 'talk' && same;
      case 'click':
        return ev.event === 'ui-click' && same;
      case 'damaged':
        return ev.event === 'damage' && !!ev.entityId && ev.entityId === this.host.playerId;
      case 'jump':
        return ev.event === 'jump';
      case 'key':
        return ev.event === 'key' && String(ev.data).toLowerCase() === str(t.params.key).toLowerCase();
      default:
        return false;
    }
  }

  // ------------------------------------------------------------------
  // 条件
  // ------------------------------------------------------------------

  private check(conditions: EventBlock[]): boolean {
    return conditions.every((c) => {
      try {
        return this.checkOne(c);
      } catch (err) {
        this.host.log(`条件の判定でエラー: ${c.type}`, 'warn');
        void err;
        return false;
      }
    });
  }

  private checkOne(c: EventBlock): boolean {
    const s = this.host.state;
    const p = c.params;
    const opv = str(p.op) || '>=';
    switch (c.type) {
      case 'var':
        return compare(s.getVar(str(p.name)), opv, parseValue(p.value));
      case 'score':
        return compare(s.score, opv, num(p.value));
      case 'money':
        return compare(s.money, opv, num(p.value));
      case 'hp':
        return compare(s.hp, opv, num(p.value));
      case 'time':
        return compare(s.elapsed, opv, num(p.value));
      case 'item':
        return s.hasItem(str(p.item), Math.max(1, num(p.count, 1)));
      case 'exists': {
        const id = this.resolve(p.target);
        const alive = !!id && this.host.exists(id);
        return p.not === true ? !alive : alive;
      }
      case 'near': {
        const a = this.resolve(p.a);
        const b = this.resolve(p.b);
        if (!a || !b || !this.host.exists(a) || !this.host.exists(b)) return false;
        return this.host.distance(a, b) <= num(p.distance, 3);
      }
      case 'random':
        return Math.random() * 100 < num(p.percent, 50);
      default:
        // 知らない条件は満たさないものとする
        return false;
    }
  }

  // ------------------------------------------------------------------
  // 動作
  // ------------------------------------------------------------------

  private fire(r: EventRule): void {
    if (this.spent.has(r.id)) return;
    const ok = this.check(r.conditions);
    this.run(r, ok ? r.actions : r.elseActions, ok);
  }

  private run(r: EventRule, actions: EventBlock[], passed: boolean): void {
    if (passed && r.once) this.spent.add(r.id);
    if (actions.length === 0) return;
    const run: Run = { rule: r, actions, index: 0, wait: 0, blocked: false };
    this.runs.push(run);
    this.step(run);
  }

  private advanceRuns(dt: number): void {
    for (const run of [...this.runs]) {
      if (run.blocked) continue;
      if (run.wait > 0) {
        run.wait -= dt;
        if (run.wait > 0) continue;
        run.wait = 0;
      }
      this.step(run);
    }
    this.runs = this.runs.filter((r) => r.index < r.actions.length || r.blocked || r.wait > 0);
  }

  /** 待ちが入るまで順に実行する */
  private step(run: Run): void {
    while (run.index < run.actions.length && run.wait <= 0 && !run.blocked) {
      if (this.budget-- <= 0) {
        if (!this.warnedLoop) {
          this.warnedLoop = true;
          this.host.log('イベントの動作が多すぎるため、続きは次のフレームで実行します (くり返しに注意)', 'warn');
        }
        return;
      }
      const action = run.actions[run.index++];
      try {
        this.exec(action, run);
      } catch (err) {
        this.host.log(`イベント「${run.rule.name}」の動作「${action.type}」でエラーが発生しました: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    }
    if (run.index >= run.actions.length && !run.blocked && run.wait <= 0) {
      this.runs = this.runs.filter((r) => r !== run);
    }
  }

  private setVar(name: string, value: VarValue): void {
    if (!name) return;
    this.host.state.setVar(name, value);
    this.changedVars.add(name);
  }

  private exec(a: EventBlock, run: Run): void {
    const h = this.host;
    const s = h.state;
    const p = a.params;
    this.log.push(a.type);
    if (this.log.length > 100) this.log.shift();
    switch (a.type) {
      case 'setVar': {
        const name = str(p.name);
        const value = parseValue(p.value);
        const cur = s.getVar(name);
        if (p.mode === 'set') this.setVar(name, value);
        else if (p.mode === 'toggle') this.setVar(name, !(cur === true || cur === 1 || cur === 'true'));
        else {
          const delta = typeof value === 'number' ? value : Number(value) || 0;
          const base = typeof cur === 'number' ? cur : Number(cur) || 0;
          this.setVar(name, Math.round((base + (p.mode === 'sub' ? -delta : delta)) * 1000) / 1000);
        }
        break;
      }
      case 'score':
        s.addScore(num(p.value));
        break;
      case 'money':
        s.addMoney(num(p.value));
        break;
      case 'hp': {
        const target = this.resolve(p.target);
        const v = num(p.value);
        if (!target) break;
        if (v >= 0) h.heal(target, v);
        else h.damage(target, -v);
        break;
      }
      case 'item': {
        const name = str(p.item).trim();
        const count = Math.round(num(p.count, 1));
        if (!name || count === 0) break;
        if (count > 0) s.addItem(name, count);
        else s.useItem(name, Math.min(-count, s.inventory.get(name) ?? 0));
        break;
      }
      case 'sound':
        h.playSound(str(p.sound), num(p.volume, 1));
        break;
      case 'music':
        h.playMusic(str(p.source) || null);
        break;
      case 'message':
        h.toast(formatUIText(str(p.text), s), num(p.seconds, 2));
        break;
      case 'dialog': {
        run.blocked = true;
        void h.talk(str(p.name), formatUIText(str(p.text), s)).finally(() => {
          run.blocked = false;
        });
        break;
      }
      case 'setText': {
        const id = this.resolve(p.target);
        if (id) h.setUIText(id, str(p.text));
        break;
      }
      case 'visible': {
        const id = this.resolve(p.target);
        if (id) h.setVisible(id, p.visible !== false);
        break;
      }
      case 'destroy': {
        const id = this.resolve(p.target);
        if (id) h.destroy(id);
        break;
      }
      case 'move': {
        const id = this.resolve(p.target);
        if (id) h.moveBy(id, vec(p.offset), Math.max(0, num(p.seconds, 1)));
        break;
      }
      case 'teleport': {
        const id = this.resolve(p.target);
        const dest = this.resolve(p.dest);
        if (id && dest) h.teleport(id, dest);
        break;
      }
      case 'spawn': {
        const id = this.resolve(p.target);
        if (id) h.spawn(id, this.resolve(p.at) || null);
        break;
      }
      case 'launch': {
        const id = this.resolve(p.target);
        if (id) h.launch(id, vec(p.velocity));
        break;
      }
      case 'wait':
        run.wait = Math.max(0, num(p.seconds, 1));
        break;
      case 'scene': {
        const id = str(p.scene);
        if (id) h.changeScene(id);
        break;
      }
      case 'clear':
        h.gameClear(str(p.message));
        break;
      case 'gameover':
        h.gameOver(str(p.message));
        break;
      default:
        // 知らない動作 (新しいバージョンのデータなど) は飛ばす
        break;
    }
  }
}
