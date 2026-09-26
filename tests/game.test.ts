import { beforeAll, describe, expect, it } from 'vitest';
import { registerBuiltinComponents } from '../src/components/builtin';
import { splitPages } from '../src/components/gameplay';
import { getComponentDef } from '../src/components/registry';
import { CATALOG, createEntity, defaultGameSettings } from '../src/core/catalog';
import { createProject } from '../src/core/project';
import { parseProjectJson, sanitizeProject } from '../src/core/serialization';
import { createProjectFromTemplate, TEMPLATES } from '../src/core/templates';
import { resolveBodySpec } from '../src/engine/colliderShapes';
import { barValue, formatTime, formatUIText, GameState } from '../src/runtime/GameState';

beforeAll(() => registerBuiltinComponents());

describe('GameState', () => {
  it('スコア・お金・持ち物・変数を扱える', () => {
    const s = new GameState();
    s.addScore(10);
    s.addScore(5.5);
    expect(s.score).toBe(15.5);
    expect(s.addMoney(30)).toBe(true);
    // お金は足りなければ減らせない
    expect(s.addMoney(-50)).toBe(false);
    expect(s.money).toBe(30);
    expect(s.addMoney(-20)).toBe(true);
    expect(s.money).toBe(10);
    s.addItem('鍵');
    s.addItem('鍵', 2);
    expect(s.hasItem('鍵', 3)).toBe(true);
    expect(s.useItem('鍵', 2)).toBe(true);
    expect(s.useItem('鍵', 2)).toBe(false);
    expect(s.inventory.get('鍵')).toBe(1);
    s.useItem('鍵');
    expect(s.inventory.has('鍵')).toBe(false);
    expect(s.addVar('倒した数', 1)).toBe(1);
    expect(s.addVar('倒した数', 2)).toBe(3);
    s.setVar('名前', 'たろう');
    expect(s.getVar('名前')).toBe('たろう');
  });

  it('HP は 0〜最大値に収まる', () => {
    const s = new GameState();
    s.setHp(150, 100);
    expect(s.hp).toBe(100);
    s.setHp(-5);
    expect(s.hp).toBe(0);
  });

  it('制限時間を過ぎると tick が true を返し、終了は1回だけ', () => {
    const s = new GameState();
    s.timeLimit = 2;
    expect(s.tick(1.5)).toBe(false);
    expect(s.remaining).toBeCloseTo(0.5);
    expect(s.tick(1)).toBe(true);
    expect(s.end('gameover', '時間切れ')).toBe(true);
    expect(s.end('clear')).toBe(false);
    expect(s.status).toBe('gameover');
    // 終了後は時間が進まない
    expect(s.tick(1)).toBe(false);
  });

  it('変更は flush でまとめて通知される', () => {
    const s = new GameState();
    let n = 0;
    s.onChange(() => n++);
    s.addScore(1);
    s.addMoney(1);
    s.addItem('石');
    expect(n).toBe(0);
    s.flush();
    expect(n).toBe(1);
    s.flush();
    expect(n).toBe(1);
  });

  it('セーブデータで状態を往復できる (壊れた値は無視)', () => {
    const s = new GameState();
    s.setHp(40, 100);
    s.addScore(120);
    s.addMoney(7);
    s.lives = 2;
    s.addItem('鍵');
    s.setVar('flag', true);
    const data = s.toSave('scene1', [1, 2, 3]);
    const t = new GameState();
    t.setHp(100, 100);
    t.load(JSON.parse(JSON.stringify(data)));
    expect(t.score).toBe(120);
    expect(t.money).toBe(7);
    expect(t.hp).toBe(40);
    expect(t.lives).toBe(2);
    expect(t.checkpoint).toEqual([1, 2, 3]);
    expect(t.hasItem('鍵')).toBe(true);
    expect(t.getVar('flag')).toBe(true);
    const u = new GameState();
    u.load({ ...data, score: 'x' as unknown as number, inventory: { 石: -1, 鍵: 2 }, variables: { a: {} as unknown as number } });
    expect(u.score).toBe(0);
    expect([...u.inventory]).toEqual([['鍵', 2]]);
    expect(u.variables.size).toBe(0);
  });
});

describe('UI の文字と記号', () => {
  it('{score} などを現在の値に置き換える', () => {
    const s = new GameState();
    s.addScore(30);
    s.addMoney(5);
    s.setHp(80, 100);
    s.lives = 3;
    s.addItem('鍵', 2);
    s.setVar('ステージ', 2);
    s.elapsed = 75;
    expect(formatUIText('スコア: {score} お金: {money}', s)).toBe('スコア: 30 お金: 5');
    expect(formatUIText('HP {hp}/{maxHp} 残り{lives}', s)).toBe('HP 80/100 残り3');
    expect(formatUIText('{time} / {var:ステージ} / {item:鍵} / {item:剣}', s)).toBe('1:15 / 2 / 2 / 0');
    expect(formatUIText('{unknown} そのまま', s)).toBe('{unknown} そのまま');
    s.timeLimit = 100;
    expect(formatUIText('{timer}', s)).toBe('0:25');
  });

  it('時間の表示', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(59.9)).toBe('0:59');
    expect(formatTime(125)).toBe('2:05');
  });

  it('ゲージの値と最大値', () => {
    const s = new GameState();
    s.setHp(30, 120);
    expect(barValue('hp', 0, s)).toEqual({ value: 30, max: 120 });
    expect(barValue('hp', 50, s)).toEqual({ value: 30, max: 50 });
    s.setVar('体力', 7);
    expect(barValue('var:体力', 10, s)).toEqual({ value: 7, max: 10 });
    s.timeLimit = 60;
    s.elapsed = 15;
    expect(barValue('timer', 0, s)).toEqual({ value: 45, max: 60 });
  });
});

describe('ゲーム用オブジェクト', () => {
  it('カタログのゲーム用オブジェクトは既定値の入ったコンポーネントを持つ', () => {
    for (const item of CATALOG.filter((c) => c.category === 'game')) {
      const e = createEntity(item.kind);
      expect(e.components.length).toBeGreaterThan(0);
      for (const c of e.components) {
        const def = getComponentDef(c.type);
        expect(def, c.type).toBeTruthy();
        for (const key of Object.keys(def!.defaults())) expect(c.props).toHaveProperty(key);
      }
    }
    const player = createEntity('game-player');
    expect(player.components.map((c) => c.type)).toEqual(['player', 'health']);
  });

  it('UI のオブジェクトは kind = ui', () => {
    for (const item of CATALOG.filter((c) => c.category === 'ui')) {
      const e = createEntity(item.kind);
      expect(e.kind).toBe('ui');
      expect(e.ui).toBeTruthy();
    }
    expect(createEntity('ui-score').ui!.text).toContain('{score}');
  });

  it('物理ボディの種類を自動で決める', () => {
    const player = createEntity('game-player');
    expect(resolveBodySpec(player, { autoColliders: true })?.rb).toMatchObject({ type: 'dynamic', lockRotation: true, friction: 0 });
    const enemy = createEntity('game-enemy');
    expect(resolveBodySpec(enemy, { autoColliders: false })?.rb?.type).toBe('dynamic');
    const npc = createEntity('game-npc');
    expect(resolveBodySpec(npc, { autoColliders: false })).toEqual({ rb: null, collider: null });
    // 拾うもの・セーブポイントは固体にしない
    expect(resolveBodySpec(createEntity('game-coin'), { autoColliders: true })).toBeNull();
    expect(resolveBodySpec(createEntity('game-savepoint'), { autoColliders: true })).toBeNull();
    // 条件の無いゴールは通り抜け、条件付き (鍵が必要) は固体
    const goal = createEntity('game-goal');
    expect(resolveBodySpec(goal, { autoColliders: true })).toBeNull();
    goal.components[0].props.requireItem = '鍵';
    expect(resolveBodySpec(goal, { autoColliders: true })).toEqual({ rb: null, collider: null });
    // 普通のメッシュは autoColliders のときだけ固体
    const cube = createEntity('cube');
    expect(resolveBodySpec(cube, { autoColliders: false })).toBeNull();
    expect(resolveBodySpec(cube, { autoColliders: true })).toEqual({ rb: null, collider: null });
    const water = createEntity('water');
    expect(resolveBodySpec(water, { autoColliders: true })).toBeNull();
  });

  it('セリフをページに分ける', () => {
    expect(splitPages('こんにちは\n\nさようなら')).toEqual(['こんにちは', 'さようなら']);
    expect(splitPages('A|B | |C')).toEqual(['A', 'B', 'C']);
    expect(splitPages('1行目\n2行目')).toEqual(['1行目\n2行目']);
    expect(splitPages('   ')).toEqual([]);
  });
});

describe('テンプレートと保存データ', () => {
  it('すべてのテンプレートが正しいプロジェクトになり、保存形式で往復できる', () => {
    for (const t of TEMPLATES) {
      const p = createProjectFromTemplate(t.id, t.defaultName);
      const restored = parseProjectJson(JSON.stringify(p));
      expect(restored).toEqual(p);
      if (t.id === 'coins' || t.id === 'adventure') {
        const ents = Object.values(p.scenes[0].entities);
        expect(ents.some((e) => e.components.some((c) => c.type === 'player'))).toBe(true);
        expect(ents.some((e) => e.components.some((c) => c.type === 'goal'))).toBe(true);
        expect(ents.some((e) => e.kind === 'ui')).toBe(true);
        expect(p.scenes[0].music.source).toMatch(/^builtin:/);
        expect(p.game.title).toBe(t.defaultName);
      }
    }
  });

  it('Phase 2 以前のデータ (ゲーム設定・BGM・UI なし) も読み込める', () => {
    const p = createProject('古いデータ') as unknown as Record<string, unknown>;
    delete p.game;
    const scenes = p.scenes as Record<string, unknown>[];
    delete scenes[0].music;
    const phys = scenes[0].physics as Record<string, unknown>;
    delete phys.autoColliders;
    const restored = sanitizeProject(JSON.parse(JSON.stringify(p)));
    expect(restored.game).toEqual(defaultGameSettings('古いデータ'));
    expect(restored.scenes[0].music).toEqual({ source: null, volume: 0.6 });
    expect(restored.scenes[0].physics.autoColliders).toBe(true);
  });

  it('UI の値を検証・修復する', () => {
    const p = createProject('UI');
    const ui = createEntity('ui-button', 'ボタン');
    p.scenes[0].entities[ui.id] = ui;
    p.scenes[0].roots.push(ui.id);
    const raw = JSON.parse(JSON.stringify(p));
    Object.assign(raw.scenes[0].entities[ui.id].ui, { anchor: 'nowhere', fontSize: 9999, backgroundOpacity: 5, action: 'explode', type: 'button' });
    const fixed = sanitizeProject(raw).scenes[0].entities[ui.id].ui!;
    expect(fixed.anchor).toBe('bottom-right');
    expect(fixed.fontSize).toBe(200);
    expect(fixed.backgroundOpacity).toBe(1);
    expect(fixed.action).toBe('none');
  });
});
