import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { closeSheet, createFromTemplate, evalApp, gameState, openApp, reloadApp, startPlay, teleportNear } from './helpers';

/**
 * Phase 4: ノーコードのイベント (いつ → もし → なら)・変数・タイマー・シーン切り替え
 */

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  await openApp(page, errors);
});

test.afterEach(() => {
  expect(errors.filter((e) => !/GPU stall|swiftshader|WebGL/i.test(e))).toEqual([]);
});

const events = (page: Page) => evalApp(page, (app) => JSON.parse(JSON.stringify(app.editor.sceneData.events)));

/** 種類を選んで、必要ならフォームで決定する */
async function pickType(page: Page, type: string): Promise<void> {
  await page.getByTestId(`ev-type-${type}`).scrollIntoViewIfNeeded();
  await page.getByTestId(`ev-type-${type}`).tap();
}

test('イベントタブで「ボタンが押されたとき → 変数を増やす・UI の文字を変える」を作って Play で動く', async ({ page }) => {
  // UI: ボタンと文字を追加
  await page.getByTestId('add').tap();
  await page.getByTestId('add-ui-button').tap();
  const button = await evalApp(page, (app) => app.editor.selection.active);
  await page.getByTestId('add').tap();
  await page.getByTestId('add-ui-text').tap();
  const label = await evalApp(page, (app) => app.editor.selection.active);
  await evalApp(page, (app) => app.editor.selection.clear());

  await page.getByTestId('tab-events').tap();
  await expect(page.getByTestId('events-panel')).toBeVisible();
  // いつ: ボタンが押されたとき
  await page.getByTestId('ev-add').tap();
  await pickType(page, 'click');
  await page.getByTestId('ev-param-target').selectOption(button);
  await page.getByTestId('ev-form-ok').tap();
  await expect.poll(async () => (await events(page)).length).toBe(1);
  await expect(page.getByTestId('ev-trigger-0')).toContainText('ボタン');

  // なら: 変数「押した数」を 1 増やす (新しい変数をその場で作る)
  await page.getByTestId('ev-add-action-0').tap();
  await pickType(page, 'setVar');
  page.once('dialog', () => undefined);
  await page.getByTestId('ev-param-name').selectOption('__new');
  await page.getByTestId('prompt-input').fill('押した数');
  await page.getByTestId('prompt-ok').tap();
  await expect(page.getByTestId('ev-param-name')).toHaveValue('押した数');
  await page.getByTestId('ev-form-ok').tap();
  expect(await evalApp(page, (app) => app.editor.project.variables.map((v: { name: string }) => v.name))).toEqual(['押した数']);

  // なら: UI の文字を「押した回数: {var:押した数}」にする
  await page.getByTestId('ev-add-action-0').tap();
  await pickType(page, 'setText');
  await page.getByTestId('ev-param-target').selectOption(label);
  await page.getByTestId('ev-param-text').fill('押した回数: {var:押した数}');
  await page.getByTestId('ev-form-ok').tap();
  const ev = (await events(page))[0];
  expect(ev.trigger).toMatchObject({ type: 'click', params: { target: button } });
  expect(ev.actions.map((a: { type: string }) => a.type)).toEqual(['setVar', 'setText']);
  await expect(page.getByTestId('ev-actions-0-1')).toContainText('押した回数');

  // Undo で動作の追加を取り消し → Redo で戻す
  await page.getByTestId('undo').tap();
  expect((await events(page))[0].actions).toHaveLength(1);
  await page.getByTestId('redo').tap();
  expect((await events(page))[0].actions).toHaveLength(2);
  await closeSheet(page);

  // Play: ゲーム内のボタンを2回押す
  await page.getByTestId('play').tap();
  await expect(page.getByTestId('game-ui')).toBeVisible();
  const gameButton = page.getByTestId('game-ui').locator('.g-custom .g-ui-button');
  const gameText = page.getByTestId('game-ui').locator('.g-custom .g-ui-text');
  await gameButton.tap();
  await expect(gameText).toHaveText('押した回数: 1');
  await gameButton.tap();
  await expect(gameText).toHaveText('押した回数: 2');
  expect(await evalApp(page, (app) => app.play.runtime.state.getVar('押した数'))).toBe(2);
  await page.getByTestId('stop').tap();
});

test('テンプレートのイベント: スコア 100 でお知らせ・敵を倒した数・条件と「ちがえば」', async ({ page }) => {
  await createFromTemplate(page, 'coins');
  await startPlay(page);
  expect(await evalApp(page, (app) => app.play.runtime.events.ruleCount)).toBe(2);
  // 変数の初期値
  expect(await evalApp(page, (app) => app.play.runtime.state.getVar('倒した数'))).toBe(0);
  await evalApp(page, (app) => app.play.runtime.state.addScore(100));
  await expect(page.getByTestId('game-toast')).toContainText('スコア 100 達成');
  await expect(page.getByTestId('game-ui').locator('.g-custom .g-ui-text')).toHaveText('ゴール (黄色い柱) へ向かおう！');
  // 敵を倒す → 倒した数 +1、スコア +20 (敵自体のスコアは 0)
  await evalApp(page, (app) => {
    const r = app.play.runtime;
    const enemy = (Object.values(r.sceneData.entities) as any[]).find((e) => e.name === '敵1');
    r.damage(enemy.id, Infinity);
  });
  await expect.poll(() => evalApp(page, (app) => app.play.runtime.state.getVar('倒した数'))).toBe(1);
  expect((await gameState(page)).score).toBe(120);
  await page.getByTestId('stop').tap();

  // ぼうけん: 鍵を持たずに村長と話す → 「ちがえば」で目的が変わる。鍵を拾う → 目的が変わる
  await createFromTemplate(page, 'adventure');
  await startPlay(page);
  const goal = page.getByTestId('game-ui').locator('.g-custom .g-ui-text');
  await teleportNear(page, '村長', [0, 0, 1.6]);
  await expect(page.getByTestId('game-action')).toHaveText('話す');
  await page.getByTestId('game-action').tap();
  for (let i = 0; i < 3; i++) await page.getByTestId('game-dialog').tap();
  await expect(goal).toHaveText('東の森で鍵を探そう');
  await teleportNear(page, '鍵');
  await expect(goal).toHaveText('北の扉を開けよう！');
  // 鍵を持って話す → 「なら」の会話が出る
  await teleportNear(page, '村長', [0, 0, 1.6]);
  await expect(page.getByTestId('game-action')).toHaveText('話す');
  await page.getByTestId('game-action').tap();
  for (let i = 0; i < 3; i++) await page.getByTestId('game-dialog').tap();
  await expect(page.getByTestId('game-dialog-text')).toContainText('鍵を見つけてくれたか');
  await page.getByTestId('game-dialog').tap();
  await expect(page.getByTestId('game-dialog')).toHaveCount(0);
  await page.getByTestId('stop').tap();
});

test('タイマー・触れたとき・動かす・複製・かくす・待つ', async ({ page }) => {
  await createFromTemplate(page, 'coins');
  // イベントを直接組み立てて設定 (UI の作り方は別のテストで確認済み)
  const ids = await evalApp(page, (app) => {
    const byName = (n: string) => (Object.values(app.editor.sceneData.entities) as any[]).find((e) => e.name === n).id;
    return { spike: byName('トゲ'), wall: byName('壁'), coin: byName('コイン2'), guide: byName('説明'), stand: byName('台') };
  });
  await evalApp(
    page,
    (app, ids) => {
      const b = (type: string, params: Record<string, unknown>) => ({ type, params });
      const rule = (name: string, trigger: unknown, actions: unknown[]) => ({ id: `ev_${name}`, name, enabled: true, once: false, trigger, conditions: [], actions, elseActions: [] });
      const events = [
        rule('タイマー', b('every', { seconds: 0.5 }), [b('money', { value: 1 })]),
        rule('トゲ', b('touch', { a: 'player', b: ids.spike }), [b('message', { text: 'トゲに触れた', seconds: 2 })]),
        rule('開始', b('start', {}), [
          b('move', { target: ids.wall, offset: [0, 3, 0], seconds: 0.5 }),
          b('spawn', { target: ids.coin, at: ids.stand }),
          b('visible', { target: ids.guide, visible: false }),
          b('wait', { seconds: 1 }),
          b('score', { value: 7 }),
        ]),
      ];
      app.editor.sceneData.events = events;
      app.editor.events.emit('events-changed', undefined);
    },
    ids,
  );
  const wallY0 = await evalApp(page, (app, id) => app.editor.scene.get(id).transform.position[1], ids.wall);
  await startPlay(page);
  // 動かす (0.5 秒で 3 上へ)
  await expect.poll(() => evalApp(page, (app, id) => app.play.runtime.objects.get(id).position.y, ids.wall)).toBeCloseTo(wallY0 + 3, 1);
  // 複製: 台の場所にコインが1つ増えている
  const spawned = await evalApp(page, (app) => {
    const r = app.play.runtime;
    const ev = r.eventLog.find((e: { event: string }) => e.event === 'spawned');
    return ev ? { name: r.getEntity(ev.entityId).name, dist: r.worldPosition(ev.entityId).distanceTo(r.worldPosition((Object.values(r.sceneData.entities) as any[]).find((e) => e.name === '台').id)) } : null;
  });
  expect(spawned).toMatchObject({ name: 'コイン2' });
  expect(spawned!.dist).toBeLessThan(0.5);
  // かくす (UI)
  await expect(page.getByTestId('game-ui').locator('.g-custom .g-ui-text')).toBeHidden();
  // 待つ → 1 秒後にスコア +7
  await expect.poll(async () => (await gameState(page)).score, { timeout: 10_000 }).toBe(7);
  // タイマー: お金が増えていく
  await expect.poll(async () => (await gameState(page)).money, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  // トゲに触れる
  await teleportNear(page, 'トゲ', [0.6, 0.4, 0]);
  await expect(page.getByTestId('game-toast')).toContainText('トゲに触れた');
  await page.getByTestId('stop').tap();
  // エディタのデータは変わっていない
  expect(await evalApp(page, (app, id) => app.editor.scene.get(id).transform.position[1], ids.wall)).toBe(wallY0);
});

test('シーン切り替え: スコアと持ち物を引き継いで次のシーンへ', async ({ page }) => {
  await createFromTemplate(page, 'coins');
  // 2つ目のシーンを追加
  const first = await evalApp(page, (app) => app.editor.sceneData.id);
  await page.getByTestId('tab-scene').tap();
  await page.getByTestId('scene-switch').tap();
  await page.getByTestId('scene-new').tap();
  await expect.poll(() => evalApp(page, (app) => app.editor.project.scenes.length)).toBe(2);
  const second = await evalApp(page, (app) => app.editor.sceneData.id);
  expect(second).not.toBe(first);
  await evalApp(page, (app) => app.editor.setActiveScene(app.editor.project.scenes[0].id));
  await expect.poll(() => evalApp(page, (app) => app.editor.sceneData.id)).toBe(first);

  // イベント: コインを拾ったら次のシーンへ (UI で作成)
  await page.getByTestId('tab-events').tap();
  await page.getByTestId('ev-add').tap();
  await pickType(page, 'pickup');
  await page.getByTestId('ev-form-ok').tap();
  const index = (await events(page)).length - 1;
  await page.getByTestId(`ev-add-action-${index}`).tap();
  await pickType(page, 'scene');
  // シーン未選択では決定できない
  await page.getByTestId('ev-form-ok').tap();
  await expect(page.getByTestId('ev-form-modal')).toBeVisible();
  await page.getByTestId('ev-param-scene').selectOption(second);
  await page.getByTestId('ev-form-ok').tap();
  await expect(page.getByTestId(`ev-actions-${index}-0`)).toContainText('へ移動');
  await closeSheet(page);

  await startPlay(page);
  await evalApp(page, (app) => app.play.runtime.state.addItem('宝石', 2));
  await teleportNear(page, 'コイン1');
  // 新しいシーンに切り替わり、スコア (10) と持ち物を引き継ぐ
  await expect.poll(() => evalApp(page, (app) => app.play.runtime?.sceneData.id), { timeout: 15_000 }).toBe(second);
  const st = await gameState(page);
  expect(st.score).toBe(10);
  expect(st.inventory).toEqual({ 宝石: 2 });
  await page.getByTestId('stop').tap();
  // Stop するとエディタは元のシーンのまま
  expect(await evalApp(page, (app) => app.editor.sceneData.id)).toBe(first);
});

test('変数の管理 (追加・初期値・削除) と保存', async ({ page }) => {
  await page.getByTestId('tab-events').tap();
  await page.getByTestId('ev-vars').tap();
  await expect(page.getByTestId('ev-vars-modal')).toBeVisible();
  await page.getByTestId('ev-var-add').tap();
  await page.getByTestId('prompt-input').fill('ステージ');
  await page.getByTestId('prompt-ok').tap();
  await expect(page.getByTestId('ev-var-initial-0')).toBeVisible();
  await page.getByTestId('ev-var-initial-0').fill('3');
  await page.getByTestId('ev-var-initial-0').press('Enter');
  expect(await evalApp(page, (app) => app.editor.project.variables.map((v: { name: string; initial: unknown }) => [v.name, v.initial]))).toEqual([['ステージ', 3]]);
  await page.getByTestId('ev-vars-close').tap();
  await expect(page.getByTestId('ev-vars')).toContainText('変数 (1)');

  // 保存して読み込み直しても残る
  await page.getByTestId('save').tap();
  await expect(page.getByTestId('save')).toHaveAttribute('data-state', 'saved');
  await reloadApp(page);
  expect(await evalApp(page, (app) => app.editor.project.variables.map((v: { name: string }) => v.name))).toEqual(['ステージ']);

  // Play では初期値が入っている
  await page.getByTestId('play').tap();
  await expect.poll(() => evalApp(page, (app) => app.play.runtime?.state.getVar('ステージ'))).toBe(3);
  await page.getByTestId('stop').tap();
});
