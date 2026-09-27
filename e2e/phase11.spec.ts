import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  closeSheet,
  createFromTemplate,
  entities,
  evalApp,
  gameState,
  openApp,
  screenPos,
  selection,
  startPlay,
  stableBox,
  teleportNear,
  waitSheetClosed,
  waitViewSettled,
} from './helpers';

/**
 * Phase 11: スマホで実際にゲームを作る流れ (置く → 設定 → イベント → Play → 保存 → 書き出し)、
 * 完成版サンプル「ポケット城の冒険」を最後まで遊ぶ、問題チェック、タッチ操作・インスペクターの改善
 */

const IGNORE = /GPU stall|swiftshader|WebGL|KHR_parallel|Manifest|favicon/i;
let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  await openApp(page, errors);
});

test.afterEach(() => {
  expect(errors.filter((e) => !IGNORE.test(e))).toEqual([]);
});

const idByName = (page: Page, name: string) =>
  evalApp(page, (app, n) => (Object.values(app.editor.sceneData.entities) as any[]).find((e) => e.name === n)?.id as string, name);

const rtIdByName = (page: Page, name: string) =>
  evalApp(page, (app, n) => (Object.values(app.play.runtime.sceneData.entities) as any[]).find((e) => e.name === n)?.id as string, name);

async function skipOpening(page: Page): Promise<void> {
  // オープニングのタイムライン (自動再生) をスキップする
  await expect(page.getByTestId('timeline-skip')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('timeline-skip').tap();
  await expect(page.getByTestId('timeline-skip')).toHaveCount(0);
}

test('サンプル「ポケット城の冒険」: NPC・スイッチで門・鍵で塔・シーン切り替え・ボス・宝箱でクリア', async ({ page }) => {
  await createFromTemplate(page, 'castle');
  expect(await evalApp(page, (app) => app.editor.project.scenes.map((s: any) => s.name))).toEqual(['森の村と城', '塔の中']);
  // 問題チェック: 完成版なので注意は出ない
  await expect(page.getByTestId('problem-chip')).toBeHidden();

  await startPlay(page);
  await skipOpening(page);

  // 案内人と話す → 目的が変わる
  await teleportNear(page, '案内人', [0, 0, 1.6]);
  await expect(page.getByTestId('game-action')).toHaveText('話す');
  await page.getByTestId('game-action').tap();
  await expect(page.getByTestId('game-dialog-text')).toContainText('ようこそ');
  for (let i = 0; i < 6 && (await page.getByTestId('game-dialog').count()) > 0; i++) await page.getByTestId('game-dialog').tap();
  await expect(page.getByTestId('game-dialog')).toHaveCount(0);
  await expect(page.getByTestId('game-ui')).toContainText('東の森のスイッチ');

  // 門は閉じている (通れない) → スイッチを踏むと門が上がり、当たり判定も一緒に動く
  const gate = await rtIdByName(page, '城の門');
  const gateY0 = await evalApp(page, (app, id) => app.play.runtime.worldPosition(id).y, gate);
  await teleportNear(page, 'スイッチ', [0, 0.9, 0]);
  await expect(page.getByTestId('game-toast')).toContainText('城の門が開いた', { timeout: 10_000 });
  await expect.poll(() => evalApp(page, (app, id) => app.play.runtime.worldPosition(id).y, gate), { timeout: 10_000 }).toBeGreaterThan(gateY0 + 3);
  await expect.poll(() => evalApp(page, (app, id) => app.play.runtime.physics.bodies.get(id).body.position.y, gate)).toBeGreaterThan(gateY0 + 3);
  expect(await evalApp(page, (app) => app.play.runtime.state.getVar('門'))).toBe(1);
  await expect(page.getByTestId('game-ui')).toContainText('塔の鍵');

  // 鍵が無いと塔の扉は開かない
  await teleportNear(page, '塔の扉', [0, 0, 0.5]);
  await expect(page.getByTestId('game-toast')).toContainText('鍵がかかっている', { timeout: 10_000 });
  // 鍵を拾う → 塔の扉で次のシーンへ (スコア・持ち物を引き継ぐ)
  await teleportNear(page, '塔の鍵');
  await expect.poll(async () => (await gameState(page)).inventory).toEqual({ 塔の鍵: 1 });
  await teleportNear(page, 'コイン1');
  await expect.poll(async () => (await gameState(page)).score).toBe(10);
  await teleportNear(page, '塔の扉', [0, 0, 0.5]);
  await expect.poll(() => evalApp(page, (app) => app.play.runtime?.sceneData.name), { timeout: 15_000 }).toBe('塔の中');
  await expect.poll(() => evalApp(page, (app) => !!app.play.runtime?.physics && app.play.runtime.time > 0.1), { timeout: 15_000 }).toBe(true);
  const st = await gameState(page);
  expect(st.score).toBe(10);
  expect(st.inventory).toEqual({ 塔の鍵: 1 });

  // 紋章が無いと宝箱は開かない
  await teleportNear(page, '宝箱', [0, 0, 0.85]);
  await expect(page.getByTestId('game-dialog-text')).toContainText('王家の紋章', { timeout: 10_000 });
  for (let i = 0; i < 4 && (await page.getByTestId('game-dialog').count()) > 0; i++) await page.getByTestId('game-dialog').tap();
  await expect(page.getByTestId('game-clear')).toHaveCount(0);

  // ボスを倒すと紋章をもらえる → 宝箱でクリア
  const boss = await rtIdByName(page, 'ボス スライム');
  await evalApp(page, (app, id) => app.play.runtime.damage(id, 9999, app.play.runtime.playerId), boss);
  await expect.poll(async () => (await gameState(page)).inventory['王家の紋章']).toBe(1);
  await expect.poll(async () => (await gameState(page)).score).toBe(110);
  await teleportNear(page, '頂上の床', [-3, 2, 0]);
  await teleportNear(page, '宝箱', [0, 0.2, 0]);
  await expect(page.getByTestId('game-clear')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('game-clear')).toContainText('宝物を手に入れた');
});

test('サンプル: HP が無くなり残機も無くなるとゲームオーバー → もう一度あそぶ', async ({ page }) => {
  await createFromTemplate(page, 'castle');
  await startPlay(page);
  await skipOpening(page);
  // 残機 1 でトゲに触れ続ける
  await evalApp(page, (app) => {
    const r = app.play.runtime;
    r.state.lives = 1;
    r.damage(r.playerId, 9999);
  });
  await expect(page.getByTestId('game-over')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('game-over')).toContainText('やられてしまった');
  await page.getByTestId('game-retry').tap();
  await expect(page.getByTestId('game-over')).toHaveCount(0);
  await expect.poll(async () => (await gameState(page)).lives).toBe(3);
});

test('スマホで作る流れ: 置く → ひな形でイベント → Play → 保存 → 書き出し', async ({ page }) => {
  // 空のシーンから始める
  await page.getByTestId('main-menu').tap();
  await page.getByTestId('menu-projects').tap();
  await page.getByTestId('project-template').tap();
  await page.getByTestId('template-empty').tap();
  await page.getByTestId('prompt-ok').tap();
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);

  // 置く: 追加シートの「種類へ移動」でゲーム用オブジェクトへ
  const add = async (kind: string) => {
    await page.getByTestId('add').tap();
    await page.getByTestId('add-nav-game').tap();
    await page.getByTestId(`add-${kind}`).tap();
    await expect(page.getByTestId('add-sheet')).toHaveCount(0);
  };
  await add('game-player');
  await add('game-door');
  await add('game-switch');
  // 最近使ったものに出る
  await page.getByTestId('add').tap();
  await expect(page.getByTestId('add-recent-game-switch')).toBeVisible();
  await page.getByTestId('add-recent-game-door').tap();
  await expect(page.getByTestId('add-sheet')).toHaveCount(0);
  expect((await entities(page)).filter((e) => e.name.startsWith('ドア')).length).toBe(2);
  // 置いた物は重ならない場所 (画面の中央付近) に置かれる
  const door = await idByName(page, 'ドア');
  const sw = await idByName(page, 'スイッチ');
  const [dp, sp] = await Promise.all([evalApp(page, (app, id) => app.editor.scene.get(id).transform.position, door), evalApp(page, (app, id) => app.editor.scene.get(id).transform.position, sw)]);
  expect(Math.hypot(dp[0] - sp[0], dp[2] - sp[2])).toBeGreaterThan(0.5);

  // イベント: ひな形「スイッチでドアを開ける」(名前からスイッチとドアを選んでおく)
  await page.getByTestId('tab-events').tap();
  await page.getByTestId('ev-template').tap();
  await page.getByTestId('ev-tpl-switch-door').tap();
  await expect(page.getByTestId('ev-tpl-modal')).toBeVisible();
  await expect(page.getByTestId('ev-tpl-field-switch')).toHaveValue(sw);
  await expect(page.getByTestId('ev-tpl-field-door')).toHaveValue(door);
  await page.getByTestId('ev-tpl-ok').tap();
  await expect(page.getByTestId('ev-card-0')).toContainText('スイッチ');
  const rule = await evalApp(page, (app) => app.editor.sceneData.events[0]);
  expect(rule.trigger).toMatchObject({ type: 'touch', params: { a: 'player', b: sw } });
  expect(rule.actions.find((a: any) => a.type === 'move' && a.params.target === door)).toBeTruthy();
  // Undo 1 回で元に戻り、Redo で戻る
  await page.getByTestId('undo').tap();
  expect(await evalApp(page, (app) => app.editor.sceneData.events.length)).toBe(0);
  await page.getByTestId('redo').tap();
  expect(await evalApp(page, (app) => app.editor.sceneData.events.length)).toBe(1);
  await closeSheet(page);
  await expect(page.getByTestId('problem-chip')).toBeHidden();

  // Play: スイッチを踏むとドアが開く
  await startPlay(page);
  const y0 = await evalApp(page, (app, id) => app.play.runtime.worldPosition(id).y, door);
  await teleportNear(page, 'スイッチ', [0, 0.9, 0]);
  await expect.poll(() => evalApp(page, (app, id) => app.play.runtime.worldPosition(id).y, door), { timeout: 10_000 }).toBeGreaterThan(y0 + 2);
  await page.getByTestId('stop').tap();
  await expect(page.getByTestId('play-hud')).toBeHidden();

  // 保存
  await page.getByTestId('save').tap();
  await expect(page.getByTestId('save')).toHaveAttribute('data-state', 'saved');

  // 書き出し (1 つの HTML)
  await page.getByTestId('main-menu').tap();
  await page.getByTestId('menu-export-game').tap();
  await expect(page.getByTestId('game-export-modal')).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('ge-export-html').tap()]);
  expect(download.suggestedFilename()).toMatch(/\.html$/);
});

test('問題チェック: 原因と直し方を表示し、その場で直せる / イベントの未選択を知らせる', async ({ page }) => {
  // 空のシーン (プレイヤーなし) に敵を置く
  await page.getByTestId('main-menu').tap();
  await page.getByTestId('menu-projects').tap();
  await page.getByTestId('project-template').tap();
  await page.getByTestId('template-empty').tap();
  await page.getByTestId('prompt-ok').tap();
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  await expect(page.getByTestId('problem-chip')).toBeHidden();
  await page.getByTestId('add').tap();
  await page.getByTestId('add-nav-game').tap();
  await page.getByTestId('add-game-enemy').tap();
  await expect(page.getByTestId('problem-chip')).toBeVisible();
  await expect(page.getByTestId('problem-chip')).toContainText('注意 1');
  await page.getByTestId('problem-chip').tap();
  await expect(page.getByTestId('console')).toBeVisible();
  await expect(page.getByTestId('console-tab-check')).toHaveClass(/active/);
  const issue = page.getByTestId('issue').filter({ hasText: 'プレイヤーがいません' });
  await expect(issue).toContainText('プレイヤー」を置いてください');
  await issue.getByTestId('issue-fix-add-player').tap();
  await expect(page.getByTestId('check-ok')).toBeVisible();
  expect((await entities(page)).some((e) => e.name === 'プレイヤー')).toBe(true);
  await page.getByTestId('console-close').tap();
  await expect(page.getByTestId('problem-chip')).toBeHidden();

  // 対象を選んでいないイベント → エラーとして数え、イベントを開ける
  await evalApp(page, (app) => {
    const rules = [...app.editor.sceneData.events, { id: 'ev_test', name: '未完成', enabled: true, once: false, trigger: { type: 'touch', params: { a: 'player', b: '' } }, conditions: [], actions: [{ type: 'score', params: { value: 1 } }], elseActions: [] }];
    app.editor.sceneData.events = rules;
    app.editor.events.emit('history-changed', undefined);
  });
  await expect(page.getByTestId('problem-chip')).toContainText('問題 1');
  await page.getByTestId('problem-chip').tap();
  await page.getByTestId('issue').filter({ hasText: '未完成' }).getByTestId('issue-open-event').tap();
  await expect(page.getByTestId('events-panel')).toBeVisible();
  // 選び直しが必要な部品は赤く示す
  await expect(page.getByTestId('ev-trigger-0')).toHaveClass(/broken/);

  // Play を始めるとエラーがあることを知らせる (Play は続ける)
  await closeSheet(page);
  await page.getByTestId('play').tap();
  await expect(page.locator('.toast').filter({ hasText: '動かない設定が 1 件' })).toBeVisible();
  await expect(page.getByTestId('play-hud')).toBeVisible();
  await page.getByTestId('stop').tap();
});

test('タッチ: 小さな物は指の近くでも選べる・同じ場所をもう一度タップで奥の物を選ぶ', async ({ page }) => {
  // UI で追加して、位置と大きさを決める (大きな箱の中に小さな箱、離れた所に小さな球)
  const addAt = async (kind: string, pos: number[], scale: number) => {
    await page.getByTestId('add').tap();
    await page.getByTestId(`add-${kind}`).tap();
    await expect(page.getByTestId('add-sheet')).toHaveCount(0);
    const [id] = await selection(page);
    await evalApp(page, (app, a) => {
      const e = app.editor.scene.get(a.id);
      app.editor.scene.setTransform(a.id, { ...e.transform, position: a.pos, scale: [a.s, a.s, a.s] });
    }, { id, pos, s: scale });
    return id as string;
  };
  const big = await addAt('cube', [0, 1, 0], 2);
  const small = await addAt('cube', [0, 1, 0], 0.6);
  const ball = await addAt('sphere', [3, 0.3, 2], 0.25);
  await evalApp(page, (app) => app.editor.selection.clear());
  await evalApp(page, (app, ids) => app.editor.requestFocus(ids), [big, ball]);
  await waitViewSettled(page);

  // 1 回目: 手前の大きな箱 → 同じ場所をもう一度: 中の小さな箱
  const c = await screenPos(page, big);
  await page.touchscreen.tap(c.x, c.y);
  await expect.poll(() => selection(page)).toEqual([big]);
  await page.waitForTimeout(450);
  await page.touchscreen.tap(c.x, c.y);
  await expect.poll(() => selection(page)).toEqual([small]);
  await expect(page.locator('.toast').filter({ hasText: '重なっている物' })).toBeVisible();

  // 小さな球: 少しずれた所を押しても選べる
  const b = await screenPos(page, ball);
  await page.waitForTimeout(450);
  await page.touchscreen.tap(b.x + 12, b.y);
  await expect.poll(() => selection(page)).toEqual([ball]);
});

test('インスペクター: 項目へ移動・動作を先に表示・詳しい設定 / シーン一覧の役割', async ({ page }) => {
  await createFromTemplate(page, 'castle');
  const player = await idByName(page, 'プレイヤー');
  await evalApp(page, (app, id) => app.editor.select(id), player);
  await page.getByTestId('tab-inspector').tap();
  const chips = page.getByTestId('insp-jump').locator('.jump-chip');
  await expect(chips.first()).toHaveText('位置');
  // ゲーム用オブジェクトは「動作」が 2 番目
  await expect(chips.nth(1)).toHaveText('動作');
  await page.getByTestId('jump-sec-material').tap();
  await expect(page.getByTestId('sec-material')).toBeInViewport();
  // 「詳しい設定」を開くと、あまり使わない項目が出る
  await page.getByTestId('jump-sec-components').tap();
  const adv = page.getByTestId('adv-player');
  await expect(adv).toContainText('詳しい設定');
  await adv.scrollIntoViewIfNeeded();
  await adv.tap();
  await expect(adv).toContainText('しまう');
  await expect(page.getByTestId('comp-player').getByText('走る速さ')).toBeVisible();

  // シーン一覧: 役割の表示、シーン名から切り替え
  await page.getByTestId('tab-scene').tap();
  await expect(page.getByTestId(`row-${player}`).locator('.role-chip')).toHaveText('プレイヤー');
  const guard = await idByName(page, '番兵');
  await expect(page.getByTestId(`row-${guard}`).locator('.role-chip')).toHaveText('敵');
  // 一覧で選ぶと、見えていない物でもカメラが向く
  await page.getByTestId(`row-${guard}`).tap();
  await waitViewSettled(page);
  const vis = await evalApp(page, (app) => app.viewport.visibleClientRect());
  const gp = await screenPos(page, guard);
  expect(gp.y).toBeLessThan(vis.bottom);
  expect(gp.y).toBeGreaterThan(vis.top);
  await stableBox(page, 'scene-switch');
  await page.getByTestId('scene-switch').tap();
  await expect(page.getByTestId('scene-switcher')).toBeVisible();
  await page.keyboard.press('Escape');
  await waitSheetClosed(page).catch(() => undefined);
});

test('地面に置く: 大きくして地面に埋まった箱を、下の面にそろえる (1 回の Undo で戻る)', async ({ page }) => {
  await page.getByTestId('add').tap();
  await page.getByTestId('add-cube').tap();
  await expect(page.getByTestId('add-sheet')).toHaveCount(0);
  const [id] = await selection(page);
  // サイズを 4 倍にすると中心から大きくなり、下半分が地面に埋まる
  await evalApp(page, (app, eid) => {
    const e = app.editor.scene.get(eid);
    app.editor.scene.setTransform(eid, { ...e.transform, scale: [4, 4, 4] });
  }, id);
  const y0 = (await evalApp(page, (app, eid) => app.editor.scene.get(eid).transform.position[1], id)) as number;
  await page.getByTestId('tab-inspector').tap();
  await page.getByTestId('insp-drop').tap();
  // 高さ 4 の箱の中心は 2 (底が地面 y=0)
  await expect.poll(() => evalApp(page, (app, eid) => app.editor.scene.get(eid).transform.position[1], id)).toBeCloseTo(2, 2);
  await page.getByTestId('undo').tap();
  await expect.poll(() => evalApp(page, (app, eid) => app.editor.scene.get(eid).transform.position[1], id)).toBeCloseTo(y0, 3);
  // メニューからも使える
  await closeSheet(page);
  await page.getByTestId('ctx-more').tap();
  await page.getByTestId('menu-drop').tap();
  await expect.poll(() => evalApp(page, (app, eid) => app.editor.scene.get(eid).transform.position[1], id)).toBeCloseTo(2, 2);
});
