import { describe, expect, it } from 'vitest';
import type { EventRule } from '../src/core/events';
import { compare, createBlock, createRule, missingParam, parseValue, sanitizeRules, sanitizeVariables, summarize } from '../src/core/events';
import { createProject } from '../src/core/project';
import { parseProjectJson } from '../src/core/serialization';
import type { Vec3 } from '../src/core/types';
import type { EventHost } from '../src/runtime/EventSystem';
import { EventSystem } from '../src/runtime/EventSystem';
import { GameState } from '../src/runtime/GameState';

/** テスト用のゲーム本体 (呼ばれた操作を記録する) */
class FakeHost implements EventHost {
  state = new GameState();
  playerId: string | null = 'p';
  time = 0;
  calls: string[] = [];
  overlapping = new Set<string>();
  alive = new Set(['p', 'coin', 'enemy', 'ui']);
  talkResolve: (() => void) | null = null;
  exists(id: string) {
    return this.alive.has(id);
  }
  overlaps(a: string, b: string) {
    return this.overlapping.has(`${a}|${b}`);
  }
  distance() {
    return 2;
  }
  damage(t: string, n: number) {
    this.calls.push(`damage:${t}:${n}`);
    return true;
  }
  heal(t: string, n: number) {
    this.calls.push(`heal:${t}:${n}`);
    return true;
  }
  playSound(src: string) {
    this.calls.push(`sound:${src}`);
  }
  playMusic(src: string | null) {
    this.calls.push(`music:${src}`);
  }
  toast(msg: string) {
    this.calls.push(`toast:${msg}`);
  }
  talk(name: string, text: string) {
    this.calls.push(`talk:${name}:${text}`);
    return new Promise<void>((r) => (this.talkResolve = r));
  }
  setUIText(id: string, text: string) {
    this.calls.push(`text:${id}:${text}`);
  }
  setVisible(id: string, v: boolean) {
    this.calls.push(`visible:${id}:${v}`);
  }
  destroy(id: string) {
    this.alive.delete(id);
    this.calls.push(`destroy:${id}`);
  }
  moveBy(id: string, o: Vec3, s: number) {
    this.calls.push(`move:${id}:${o.join(',')}:${s}`);
  }
  teleport(id: string, dest: string) {
    this.calls.push(`teleport:${id}:${dest}`);
  }
  spawn(id: string, at: string | null) {
    this.calls.push(`spawn:${id}:${at}`);
    return 'new';
  }
  launch(id: string, v: Vec3) {
    this.calls.push(`launch:${id}:${v.join(',')}`);
  }
  changeScene(id: string) {
    this.calls.push(`scene:${id}`);
  }
  hour = 12;
  getHour() {
    return this.hour;
  }
  setHour(h: number) {
    this.hour = h;
    this.calls.push(`hour:${h}`);
  }
  setWeather(type: string, lightning: boolean) {
    this.calls.push(`weather:${type}:${lightning}`);
  }
  playAnimation(id: string, clip: string) {
    this.calls.push(`anim:${id}:${clip}`);
  }
  stopAnimation(id: string) {
    this.calls.push(`animstop:${id}`);
  }
  spawnEffect(preset: string, at: string, scale: number) {
    this.calls.push(`effect:${preset}:${at}:${scale}`);
  }
  setParticles(id: string, on: boolean) {
    this.calls.push(`particles:${id}:${on}`);
  }
  gameClear(m: string) {
    this.calls.push(`clear:${m}`);
  }
  gameOver(m: string) {
    this.calls.push(`over:${m}`);
  }
  log(m: string) {
    this.calls.push(`log:${m}`);
  }
}

function rule(trigger: ReturnType<typeof createBlock>, actions: ReturnType<typeof createBlock>[], conditions: ReturnType<typeof createBlock>[] = []): EventRule {
  const r = createRule('テスト', trigger);
  r.actions = actions;
  r.conditions = conditions;
  return r;
}

const tick = (sys: EventSystem, host: FakeHost, dt: number, n = 1) => {
  for (let i = 0; i < n; i++) {
    host.time += dt;
    sys.update(dt);
  }
};

describe('EventSystem', () => {
  it('ゲーム開始時に動作を順に実行する', () => {
    const host = new FakeHost();
    const sys = new EventSystem([rule(createBlock('trigger', 'start'), [createBlock('action', 'score', { value: 5 }), createBlock('action', 'message', { text: 'スコア{score}' })])], host);
    sys.start();
    expect(host.state.score).toBe(5);
    expect(host.calls).toContain('toast:スコア5');
  });

  it('条件を満たすと「なら」、満たさないと「そうでなければ」', () => {
    const host = new FakeHost();
    const r = rule(createBlock('trigger', 'start'), [createBlock('action', 'sound', { sound: 'builtin:win' })], [createBlock('condition', 'score', { op: '>=', value: 10 })]);
    r.elseActions = [createBlock('action', 'sound', { sound: 'builtin:lose' })];
    new EventSystem([r], host).start();
    expect(host.calls).toEqual(['sound:builtin:lose']);
    host.calls = [];
    host.state.addScore(10);
    new EventSystem([r], host).start();
    expect(host.calls).toEqual(['sound:builtin:win']);
  });

  it('○秒ごと・○秒たったとき', () => {
    const host = new FakeHost();
    const sys = new EventSystem(
      [rule(createBlock('trigger', 'every', { seconds: 1 }), [createBlock('action', 'score', { value: 1 })]), rule(createBlock('trigger', 'after', { seconds: 2.5 }), [createBlock('action', 'money', { value: 3 })])],
      host,
    );
    tick(sys, host, 0.25, 12); // 3 秒
    expect(host.state.score).toBe(3);
    expect(host.state.money).toBe(3);
    tick(sys, host, 0.25, 8);
    expect(host.state.money).toBe(3); // 「たったとき」は1回だけ
  });

  it('触れたとき・離れたときは変化した瞬間だけ', () => {
    const host = new FakeHost();
    const sys = new EventSystem(
      [
        rule(createBlock('trigger', 'touch', { a: 'player', b: 'coin' }), [createBlock('action', 'score', { value: 1 })]),
        rule(createBlock('trigger', 'leave', { a: 'player', b: 'coin' }), [createBlock('action', 'money', { value: 1 })]),
      ],
      host,
    );
    tick(sys, host, 0.1);
    host.overlapping.add('p|coin');
    tick(sys, host, 0.1, 5);
    expect(host.state.score).toBe(1);
    host.overlapping.clear();
    tick(sys, host, 0.1, 3);
    expect(host.state.money).toBe(1);
  });

  it('ゲーム内の出来事 (拾った・倒した・ボタン・キー・ダメージ) に反応する', () => {
    const host = new FakeHost();
    const sys = new EventSystem(
      [
        rule(createBlock('trigger', 'pickup', { target: 'coin' }), [createBlock('action', 'score', { value: 1 })]),
        rule(createBlock('trigger', 'pickup', { target: '' }), [createBlock('action', 'score', { value: 10 })]),
        rule(createBlock('trigger', 'defeated', { target: 'enemy' }), [createBlock('action', 'setVar', { name: '倒した', mode: 'add', value: '1' })]),
        rule(createBlock('trigger', 'click', { target: 'ui' }), [createBlock('action', 'visible', { target: 'ui', visible: false })]),
        rule(createBlock('trigger', 'key', { key: 'q' }), [createBlock('action', 'launch', { target: 'player', velocity: [0, 5, 0] })]),
        rule(createBlock('trigger', 'damaged'), [createBlock('action', 'toast' as never)]),
      ],
      host,
    );
    sys.onGameEvent('pickup', 'coin');
    sys.onGameEvent('pickup', 'other');
    sys.onGameEvent('defeated', 'enemy');
    sys.onGameEvent('ui-click', 'ui');
    sys.onKey('q');
    sys.onGameEvent('damage', 'enemy'); // プレイヤー以外のダメージは対象外
    tick(sys, host, 0.016);
    expect(host.state.score).toBe(21);
    expect(host.state.getVar('倒した')).toBe(1);
    expect(host.calls).toContain('visible:ui:false');
    expect(host.calls).toContain('launch:p:0,5,0');
  });

  it('条件を満たしたとき (成立した瞬間だけ) と 1回だけ', () => {
    const host = new FakeHost();
    const r = rule(createBlock('trigger', 'condition'), [createBlock('action', 'money', { value: 1 })], [createBlock('condition', 'score', { op: '>=', value: 5 })]);
    const once = rule(createBlock('trigger', 'every', { seconds: 0.1 }), [createBlock('action', 'setVar', { name: 'n', mode: 'add', value: '1' })]);
    once.once = true;
    const sys = new EventSystem([r, once], host);
    tick(sys, host, 0.1, 3);
    expect(host.state.money).toBe(0);
    host.state.addScore(5);
    tick(sys, host, 0.1, 3);
    expect(host.state.money).toBe(1);
    host.state.addScore(-5);
    tick(sys, host, 0.1);
    host.state.addScore(5);
    tick(sys, host, 0.1);
    expect(host.state.money).toBe(2);
    expect(host.state.getVar('n')).toBe(1);
  });

  it('待つ・会話は完了してから次の動作へ進む', async () => {
    const host = new FakeHost();
    const sys = new EventSystem(
      [
        rule(createBlock('trigger', 'start'), [
          createBlock('action', 'score', { value: 1 }),
          createBlock('action', 'wait', { seconds: 1 }),
          createBlock('action', 'dialog', { name: '村人', text: 'やあ' }),
          createBlock('action', 'score', { value: 1 }),
        ]),
      ],
      host,
    );
    sys.start();
    expect(host.state.score).toBe(1);
    tick(sys, host, 0.5);
    expect(host.calls.some((c) => c.startsWith('talk'))).toBe(false);
    tick(sys, host, 0.6);
    expect(host.calls).toContain('talk:村人:やあ');
    tick(sys, host, 0.5, 3);
    expect(host.state.score).toBe(1);
    host.talkResolve?.();
    await Promise.resolve();
    tick(sys, host, 0.1);
    expect(host.state.score).toBe(2);
  });

  it('変数が変わったとき・変数の比較・反転', () => {
    const host = new FakeHost();
    const sys = new EventSystem(
      [
        rule(createBlock('trigger', 'start'), [createBlock('action', 'setVar', { name: 'ドア', mode: 'toggle' })]),
        rule(createBlock('trigger', 'varChanged', { name: 'ドア' }), [createBlock('action', 'message', { text: '変わった' })], [createBlock('condition', 'var', { name: 'ドア', op: '==', value: 'true' })]),
      ],
      host,
    );
    sys.start();
    expect(host.state.getVar('ドア')).toBe(true);
    tick(sys, host, 0.1);
    expect(host.calls).toContain('toast:変わった');
  });

  it('無限ループは1フレームの上限で止まる', () => {
    const host = new FakeHost();
    const loop = rule(createBlock('trigger', 'start'), Array.from({ length: 500 }, () => createBlock('action', 'score', { value: 1 })));
    const sys = new EventSystem([loop], host);
    sys.start();
    expect(host.state.score).toBe(200);
    expect(host.calls.some((c) => c.startsWith('log:'))).toBe(true);
    tick(sys, host, 0.016, 2);
    expect(host.state.score).toBe(500);
  });

  it('知らない動作・条件は無視し、無効なイベントは実行しない', () => {
    const host = new FakeHost();
    const r1 = rule(createBlock('trigger', 'start'), [{ type: 'future-action', params: {} }, createBlock('action', 'score', { value: 1 })]);
    const r2 = rule(createBlock('trigger', 'start'), [createBlock('action', 'score', { value: 100 })]);
    r2.enabled = false;
    const r3 = rule(createBlock('trigger', 'start'), [createBlock('action', 'score', { value: 1000 })], [{ type: 'future-condition', params: {} }]);
    new EventSystem([r1, r2, r3], host).start();
    expect(host.state.score).toBe(1);
  });

  it('オブジェクト・シーン・ゲーム終了の動作', () => {
    const host = new FakeHost();
    new EventSystem(
      [
        rule(createBlock('trigger', 'start'), [
          createBlock('action', 'destroy', { target: 'enemy' }),
          createBlock('action', 'move', { target: 'coin', offset: [0, 1, 0], seconds: 2 }),
          createBlock('action', 'teleport', { target: 'player', dest: 'coin' }),
          createBlock('action', 'spawn', { target: 'enemy', at: 'player' }),
          createBlock('action', 'hp', { target: 'player', value: -15 }),
          createBlock('action', 'item', { item: '鍵', count: 2 }),
          createBlock('action', 'item', { item: '鍵', count: -1 }),
          createBlock('action', 'anim', { target: 'coin', clip: '回転' }),
          createBlock('action', 'anim', { target: 'coin', mode: 'stop' }),
          createBlock('action', 'effect', { preset: 'confetti', target: 'player', scale: 2 }),
          createBlock('action', 'particles', { target: 'enemy', mode: 'stop' }),
          createBlock('action', 'scene', { scene: 's2' }),
          createBlock('action', 'clear', { message: 'やった' }),
        ]),
      ],
      host,
    ).start();
    expect(host.calls).toEqual([
      'destroy:enemy',
      'move:coin:0,1,0:2',
      'teleport:p:coin',
      'spawn:enemy:p',
      'damage:p:15',
      'anim:coin:回転',
      'animstop:coin',
      'effect:confetti:p:2',
      'particles:enemy:false',
      'scene:s2',
      'clear:やった',
    ]);
    expect(host.state.inventory.get('鍵')).toBe(1);
  });
});

describe('イベントのデータ', () => {
  it('要約の文章', () => {
    const ctx = { entityName: (id: string) => `「${id}」`, sceneName: () => 'ステージ2', soundName: (s: string) => s };
    expect(summarize('trigger', createBlock('trigger', 'touch', { a: 'player', b: 'coin' }), ctx)).toBe('プレイヤーが「coin」に触れたとき');
    expect(summarize('condition', createBlock('condition', 'score', { op: '>=', value: 50 }), ctx)).toBe('スコアが 50 以上');
    expect(summarize('action', createBlock('action', 'score', { value: -5 }), ctx)).toBe('スコアを 5 減らす');
    expect(summarize('action', createBlock('action', 'scene', { scene: 's2' }), ctx)).toBe('シーン「ステージ2」へ移動');
    expect(summarize('action', { type: 'nope', params: {} }, ctx)).toContain('不明');
  });

  it('必須の項目のチェック', () => {
    expect(missingParam('trigger', createBlock('trigger', 'touch', { a: 'player', b: '' }))).toBe('なにに');
    expect(missingParam('trigger', createBlock('trigger', 'pickup', { target: '' }))).toBeNull();
    expect(missingParam('action', createBlock('action', 'scene'))).toBe('シーン');
  });

  it('値の変換と比較', () => {
    expect(parseValue('10')).toBe(10);
    expect(parseValue('はい')).toBe(true);
    expect(parseValue('abc')).toBe('abc');
    expect(compare(5, '>=', 5)).toBe(true);
    expect(compare(undefined, '==', 0)).toBe(true);
    expect(compare('abc', '==', 'abc')).toBe(true);
    expect(compare('10', '>', 5)).toBe(true);
    expect(compare('abc', '>', 5)).toBe(false);
  });

  it('壊れたイベント・変数のデータを修復する', () => {
    const rules = sanitizeRules([
      { id: 'a', name: 'x', trigger: { type: 'every', params: { seconds: -5 } }, actions: [{ type: 'score', params: { value: 'bad' } }, 'junk'], conditions: null },
      { id: 'a', trigger: null },
      'junk',
    ]);
    expect(rules).toHaveLength(2);
    expect(rules[0].trigger.params.seconds).toBe(0.1);
    expect(rules[0].actions).toEqual([{ type: 'score', params: { value: 10 } }]);
    expect(rules[0].conditions).toEqual([]);
    expect(rules[1].id).not.toBe('a');
    expect(rules[1].trigger.type).toBe('start');
    const vars = sanitizeVariables([{ name: ' 体力 ', initial: 5 }, { name: '体力', initial: 1 }, { name: '' }, { name: 'フラグ', initial: {} }]);
    expect(vars.map((v) => [v.name, v.initial])).toEqual([
      ['体力', 5],
      ['フラグ', 0],
    ]);
  });

  it('イベント・変数はプロジェクトの保存形式で往復できる', () => {
    const p = createProject('イベント');
    const r = createRule('テスト', createBlock('trigger', 'every', { seconds: 2 }));
    r.actions.push(createBlock('action', 'move', { target: 'x', offset: [1, 2, 3], seconds: 1 }));
    p.scenes[0].events = [r];
    p.variables = [{ id: 'v1', name: '体力', initial: 3 }];
    expect(parseProjectJson(JSON.stringify(p))).toEqual(p);
  });
});

describe('時刻と天気のイベント', () => {
  it('夜になったとき・時刻の条件・時刻と天気を変える', () => {
    const host = new FakeHost();
    const night = rule(createBlock('trigger', 'night'), [createBlock('action', 'setTime', { hour: 22 }), createBlock('action', 'weather', { weather: 'storm' })]);
    const c = createBlock('condition', 'clock', { from: 20, to: 4 });
    const every = rule(createBlock('trigger', 'every', { seconds: 1 }), [createBlock('action', 'message', { text: '夜' })], [c]);
    const sys = new EventSystem([night, every], host);
    sys.onGameEvent('morning', '');
    sys.update(0.016);
    expect(host.calls).toEqual([]);
    sys.onGameEvent('night', '');
    sys.update(0.016);
    expect(host.calls).toEqual(['hour:22', 'weather:rain:true']);
    // 22 時は 20 時〜4 時に入る (日をまたぐ指定)
    sys.update(1);
    expect(host.calls.filter((x) => x.startsWith('toast')).length).toBe(1);
    host.hour = 12;
    sys.update(1);
    expect(host.calls.filter((x) => x.startsWith('toast')).length).toBe(1);
    expect(summarize('condition', c, { entityName: () => '', soundName: () => '' } as never)).toBe('時刻が 20時〜4時');
  });
});
