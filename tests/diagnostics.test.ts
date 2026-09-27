import { beforeAll, describe, expect, it } from 'vitest';
import { registerBuiltinComponents } from '../src/components/builtin';
import { createEntity, entityRole } from '../src/core/catalog';
import { checkProject, countProblems } from '../src/core/diagnostics';
import { explainError } from '../src/core/errorHints';
import { createBlock, createRule } from '../src/core/events';
import { createProject } from '../src/core/project';
import { createProjectFromTemplate, TEMPLATES } from '../src/core/templates';
import type { EntityData, ProjectData } from '../src/core/types';

beforeAll(() => registerBuiltinComponents());

function put(p: ProjectData, kind: Parameters<typeof createEntity>[0], name: string, edit?: (e: EntityData) => void): EntityData {
  const scene = p.scenes[0];
  const e = createEntity(kind, name);
  edit?.(e);
  scene.entities[e.id] = e;
  scene.roots.push(e.id);
  return e;
}

const titles = (p: ProjectData) => checkProject(p).map((i) => i.title);

describe('問題チェック', () => {
  it('新しいプロジェクトとテンプレートには問題がない', () => {
    expect(checkProject(createProject('新しいゲーム', true))).toEqual([]);
    for (const t of TEMPLATES) {
      const issues = checkProject(createProjectFromTemplate(t.id, t.defaultName)).filter((i) => i.level !== 'info');
      expect(issues, t.id).toEqual([]);
    }
  });

  it('敵がいるのにプレイヤーがいない → 置けば直る', () => {
    const p = createProject('t', false);
    put(p, 'game-enemy', '敵');
    const issue = checkProject(p).find((i) => i.title === 'プレイヤーがいません');
    expect(issue?.level).toBe('warn');
    expect(issue?.fix?.kind).toBe('add-player');
    put(p, 'game-player', 'プレイヤー');
    expect(titles(p)).not.toContain('プレイヤーがいません');
    // 2 人目
    put(p, 'game-player', 'プレイヤー2');
    expect(titles(p)).toContain('プレイヤーが 2 人います');
  });

  it('ライトが無い', () => {
    const p = createProject('t', false);
    const scene = p.scenes[0];
    for (const e of Object.values(scene.entities)) {
      if (e.kind === 'light') {
        delete scene.entities[e.id];
        scene.roots = scene.roots.filter((id) => id !== e.id);
      }
    }
    const issue = checkProject(p).find((i) => i.title === 'ライトがありません');
    expect(issue?.fix?.kind).toBe('add-light');
  });

  it('ゴールに必要な持ち物が手に入らない / 名前の無い持ち物', () => {
    const p = createProject('t', false);
    put(p, 'game-player', 'プレイヤー');
    const goal = put(p, 'game-goal', 'ゴール', (e) => {
      e.components.find((c) => c.type === 'goal')!.props.requireItem = '金の鍵';
    });
    const issue = checkProject(p).find((i) => i.entityId === goal.id);
    expect(issue?.title).toContain('金の鍵');
    // イベントでもらえるなら OK
    const rule = createRule('ごほうび', createBlock('trigger', 'start'));
    rule.actions.push(createBlock('action', 'item', { item: '金の鍵', count: 1 }));
    p.scenes[0].events.push(rule);
    expect(checkProject(p).some((i) => i.entityId === goal.id)).toBe(false);
    // 名前の無い持ち物
    put(p, 'game-key', '鍵', (e) => {
      e.components.find((c) => c.type === 'item')!.props.itemName = ' ';
    });
    expect(titles(p)).toContain('「鍵」の持ち物の名前がありません');
  });

  it('イベント: 未選択・消えたオブジェクト・無い変数・空の「なら」', () => {
    const p = createProject('t', false);
    const scene = p.scenes[0];
    const coin = put(p, 'game-coin', 'コイン');
    const a = createRule('未選択', createBlock('trigger', 'touch', { a: 'player', b: '' }));
    a.actions.push(createBlock('action', 'score', { value: 10 }));
    const b = createRule('消えた', createBlock('trigger', 'pickup', { target: coin.id }));
    b.actions.push(createBlock('action', 'setVar', { name: 'ない変数', mode: 'set', value: '1' }));
    const c = createRule('空', createBlock('trigger', 'start'));
    scene.events.push(a, b, c);
    // コインを消す
    delete scene.entities[coin.id];
    scene.roots = scene.roots.filter((id) => id !== coin.id);
    const issues = checkProject(p);
    const byRule = (id: string) => issues.filter((i) => i.ruleId === id);
    expect(byRule(a.id)[0]).toMatchObject({ level: 'error', title: 'イベント「未選択」: 「なにに」が選ばれていません' });
    expect(byRule(b.id).map((i) => i.title)).toEqual(expect.arrayContaining(['イベント「消えた」が消えたオブジェクトを使っています', '変数「ない変数」がありません']));
    expect(byRule(c.id)[0].level).toBe('info');
    // エラーが先に並ぶ
    expect(issues[0].level).toBe('error');
    const n = countProblems(issues);
    expect(n.errors).toBeGreaterThanOrEqual(2);
    // 無効にしたイベントは調べない
    a.enabled = false;
    expect(checkProject(p).some((i) => i.ruleId === a.id)).toBe(false);
  });

  it('消えたアセット (モデル・テクスチャ・BGM) / 押しても何も起きないボタン', () => {
    const p = createProject('t', false);
    const scene = p.scenes[0];
    put(p, 'cube', '箱', (e) => (e.mesh!.material.texture = 'a_missing'));
    const btn = put(p, 'ui-button', 'ボタン', (e) => (e.ui!.action = 'none'));
    scene.music = { source: 'a_gone', volume: 1 };
    const t = titles(p);
    expect(t).toContain('「箱」の画像 (テクスチャ) がありません');
    expect(t).toContain('BGM の音声ファイルが見つかりません');
    expect(t).toContain('ボタン「ボタン」を押しても何も起きません');
    // 「ボタンが押されたとき」のイベントがあれば OK
    const rule = createRule('押した', createBlock('trigger', 'click', { target: btn.id }));
    rule.actions.push(createBlock('action', 'score', { value: 1 }));
    scene.events.push(rule);
    expect(titles(p)).not.toContain('ボタン「ボタン」を押しても何も起きません');
    // 組み込みの音は OK
    scene.music = { source: 'builtin:happy', volume: 1 };
    expect(titles(p)).not.toContain('BGM の音声ファイルが見つかりません');
  });

  it('シーンを指定するとそのシーンだけ調べる', () => {
    const p = createProject('t', false);
    put(p, 'game-enemy', '敵');
    const other = createProject('u', false).scenes[0];
    other.id = 'scene_other';
    p.scenes.push(other);
    expect(checkProject(p, other.id)).toEqual([]);
    expect(checkProject(p, p.scenes[0].id).length).toBeGreaterThan(0);
  });
});

describe('エラーの言い換え', () => {
  it('よくあるエラーを初心者向けの説明にする', () => {
    expect(explainError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toContain('見つかりませんでした');
    expect(explainError(new DOMException('The quota has been exceeded.', 'QuotaExceededError'))).toContain('保存容量');
    expect(explainError(new Error('Failed to fetch'))).toContain('インターネット');
    expect(explainError(new Error('Unable to decode audio data'))).toContain('音声');
    expect(explainError(new Error('something odd'))).toBeNull();
    expect(explainError(undefined)).toBeNull();
  });
});

describe('一覧の役割の表示', () => {
  it('ゲーム用オブジェクトの役割', () => {
    expect(entityRole(createEntity('game-enemy', '敵'))?.label).toBe('敵');
    expect(entityRole(createEntity('game-coin', 'コイン'))?.label).toBe('コイン');
    expect(entityRole(createEntity('game-key', '鍵'))).toEqual({ label: '鍵', tone: 'item' });
    expect(entityRole(createEntity('game-player', 'P'))?.tone).toBe('player');
    expect(entityRole(createEntity('cube', '箱'))).toBeNull();
    // シーンのプレイヤーに指定された物
    expect(entityRole(createEntity('cube', '箱'), true)?.label).toBe('プレイヤー');
  });
});
