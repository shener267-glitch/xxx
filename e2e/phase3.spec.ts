import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { enterNumber, evalApp, openApp, reloadApp, stableBox } from './helpers';

/**
 * Phase 3: プレイヤー・敵・NPC・アイテム・HP・UI・音・タイトル/終了画面
 */

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  await openApp(page, errors);
});

test.afterEach(() => {
  expect(errors.filter((e) => !/GPU stall|swiftshader|WebGL/i.test(e))).toEqual([]);
});

/** テンプレートから新しいプロジェクトを作る (UI 操作) */
async function createFromTemplate(page: Page, id: 'coins' | 'adventure'): Promise<void> {
  await page.getByTestId('main-menu').tap();
  await page.getByTestId('menu-projects').tap();
  await page.getByTestId('project-template').tap();
  await page.getByTestId(`template-${id}`).tap();
  await page.getByTestId('prompt-ok').tap();
  await expect.poll(() => evalApp(page, (app) => Object.values(app.editor.sceneData.entities).some((e: any) => e.components.some((c: any) => c.type === 'player')))).toBe(true);
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
}

async function startPlay(page: Page): Promise<void> {
  await page.getByTestId('play').tap();
  await expect(page.getByTestId('play-hud')).toBeVisible();
  // 物理 (cannon-es) の読み込みと最初のフレームを待つ
  await expect.poll(() => evalApp(page, (app) => !!app.play.runtime?.physics && app.play.runtime.time > 0.05), { timeout: 20_000 }).toBe(true);
}

/** Play 中のプレイヤーを名前で指定したオブジェクトの近くへ移動する */
async function teleportNear(page: Page, name: string, offset: [number, number, number] = [0, 0.3, 0]): Promise<void> {
  await evalApp(
    page,
    (app, arg) => {
      const r = app.play.runtime;
      const target = (Object.values(r.sceneData.entities) as any[]).find((e) => e.name === arg.name);
      const p = r.worldPosition(target.id);
      r.physics.teleport(r.playerId, [p.x + arg.offset[0], p.y + arg.offset[1], p.z + arg.offset[2]]);
    },
    { name, offset },
  );
}

async function openSection(page: Page, testId: string): Promise<void> {
  const sec = page.getByTestId(testId);
  if (await sec.evaluate((el) => el.classList.contains('collapsed'))) await sec.locator('.section-toggle').tap();
}

/** ボトムシートを閉じる (アニメーション中に押すと見出しに当たるので、位置が落ち着いてから) */
async function closeSheet(page: Page): Promise<void> {
  await stableBox(page, 'sheet-close');
  await page.getByTestId('sheet-close').tap();
  await expect(page.getByTestId('sheet')).toHaveAttribute('data-state', 'closed');
}

const state = (page: Page) =>
  evalApp(page, (app) => {
    const r = app.play.runtime;
    return {
      score: r.state.score,
      money: r.state.money,
      hp: r.state.hp,
      lives: r.state.lives,
      status: r.state.status,
      inventory: Object.fromEntries(r.state.inventory),
      events: r.eventLog.map((e: { event: string }) => e.event),
    };
  });

/** 画面の左側を指で押したまま動かす (仮想ジョイスティック) */
async function holdJoystick(page: Page, dx: number, dy: number, ms: number): Promise<void> {
  const box = (await page.getByTestId('runtime-overlay').boundingBox())!;
  const x = box.x + box.width * 0.2;
  const y = box.y + box.height * 0.7;
  const s = await page.context().newCDPSession(page);
  await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 7 }] });
  for (let i = 1; i <= 4; i++) {
    await s.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 4, y: y + (dy * i) / 4, id: 7 }] });
  }
  await page.waitForTimeout(ms);
  await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await s.detach();
}

test('テンプレート: ジョイスティックで移動・ジャンプ・コインでスコア・敵でダメージ', async ({ page }) => {
  await createFromTemplate(page, 'coins');
  await startPlay(page);
  await expect(page.getByTestId('game-score')).toContainText('0');
  await expect(page.getByTestId('game-hp')).toBeVisible();
  await expect(page.getByTestId('game-timer')).toContainText('3:00');
  expect(await evalApp(page, (app) => app.play.runtime.cameraMode)).toBe('thirdPerson');

  // ジョイスティックを上に倒す → 前 (-Z) へ進む
  const z0 = await evalApp(page, (app) => app.play.runtime.worldPosition(app.play.runtime.playerId).z);
  await holdJoystick(page, 0, -60, 1200);
  const z1 = await evalApp(page, (app) => app.play.runtime.worldPosition(app.play.runtime.playerId).z);
  expect(z1).toBeLessThan(z0 - 0.3);

  // ジャンプボタン
  await expect.poll(() => evalApp(page, (app) => app.play.runtime.isGrounded(app.play.runtime.playerId)), { timeout: 10_000 }).toBe(true);
  const y0 = await evalApp(page, (app) => app.play.runtime.worldPosition(app.play.runtime.playerId).y);
  await page.getByTestId('game-jump').tap();
  await expect.poll(() => evalApp(page, (app) => app.play.runtime.worldPosition(app.play.runtime.playerId).y)).toBeGreaterThan(y0 + 0.2);
  expect((await state(page)).events).toContain('jump');

  // コインを拾う → スコア +10 (HUD にも反映)
  await teleportNear(page, 'コイン1');
  await expect.poll(async () => (await state(page)).score).toBe(10);
  await expect(page.getByTestId('game-score')).toContainText('10');
  expect(await evalApp(page, (app) => app.play.runtime.audio.history)).toContain('builtin:coin');

  // 敵に触れる → HP が減る
  await teleportNear(page, '敵1', [0.75, 0.2, 0]);
  await expect.poll(async () => (await state(page)).hp, { timeout: 10_000 }).toBeLessThan(100);
  await expect(page.getByTestId('game-hp')).not.toContainText('100/100');

  // Stop でエディタに戻り、シーンは元のまま (コインが残っている)
  await page.getByTestId('stop').tap();
  await expect(page.getByTestId('play-hud')).toBeHidden();
  expect(await evalApp(page, (app) => (Object.values(app.editor.sceneData.entities) as any[]).some((e) => e.name === 'コイン1'))).toBe(true);
});

test('残機が無くなるとゲームオーバー → もう一度', async ({ page }) => {
  await createFromTemplate(page, 'coins');
  await startPlay(page);
  expect((await state(page)).lives).toBe(3);
  // 倒れる → 残機が減って復活
  await evalApp(page, (app) => app.play.runtime.damage(app.play.runtime.playerId, Infinity));
  await expect.poll(async () => (await state(page)).lives).toBe(2);
  expect((await state(page)).hp).toBe(100);
  await expect(page.getByTestId('game-lives')).toContainText('2');
  await evalApp(page, (app) => app.play.runtime.damage(app.play.runtime.playerId, Infinity));
  await evalApp(page, (app) => app.play.runtime.damage(app.play.runtime.playerId, Infinity));
  await expect(page.getByTestId('game-over')).toBeVisible();
  expect((await state(page)).status).toBe('gameover');
  // もう一度 → 新しいゲーム
  await page.getByTestId('game-retry').tap();
  await expect(page.getByTestId('game-over')).toHaveCount(0);
  await expect.poll(async () => (await state(page)).lives).toBe(3);
  expect((await state(page)).status).toBe('playing');
  await page.getByTestId('stop').tap();
  expect(await evalApp(page, (app) => app.editor.mode)).toBe('edit');
});

test('NPC と会話・鍵を拾って扉を開けるとクリア', async ({ page }) => {
  await createFromTemplate(page, 'adventure');
  await startPlay(page);

  // 村長の近くに行くとアクションボタンが「話す」になる
  await teleportNear(page, '村長', [0, 0, 1.6]);
  await expect(page.getByTestId('game-action')).toHaveText('話す');
  await page.getByTestId('game-action').tap();
  await expect(page.getByTestId('game-dialog')).toBeVisible();
  await expect(page.getByTestId('game-dialog-text')).toContainText('ようこそ');
  // 会話中はゲームが止まる
  const t = await evalApp(page, (app) => app.play.runtime.time);
  await page.waitForTimeout(300);
  expect(await evalApp(page, (app) => app.play.runtime.time)).toBe(t);
  for (let i = 0; i < 3; i++) await page.getByTestId('game-dialog').tap();
  await expect(page.getByTestId('game-dialog')).toHaveCount(0);
  expect((await state(page)).events).toContain('talk');

  // 鍵なしでは扉を通れない
  await teleportNear(page, '扉', [0, 0, 0.6]);
  await expect(page.getByTestId('game-toast')).toContainText('鍵が必要です');
  expect((await state(page)).status).toBe('playing');

  // 鍵を拾う → 持ち物に入る
  await teleportNear(page, '鍵');
  await expect.poll(async () => (await state(page)).inventory).toEqual({ 鍵: 1 });
  await expect(page.getByTestId('game-inventory')).toContainText('鍵');

  // 扉に触れる → クリア画面
  await teleportNear(page, '扉', [0, 0, 0.6]);
  await expect(page.getByTestId('game-clear')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('game-clear')).toContainText('ぼうけんクリア');
  await page.getByTestId('game-exit').tap();
  await expect(page.getByTestId('play-hud')).toBeHidden();
});

test('画面の UI: 追加・Inspector で編集・プレビューをタップで選択・Play で表示', async ({ page }) => {
  // スコア表示を追加
  await page.getByTestId('add').tap();
  await page.getByTestId('add-ui-score').tap();
  await expect(page.getByTestId('add-sheet')).toHaveCount(0);
  const id = await evalApp(page, (app) => app.editor.selection.active);
  expect(await evalApp(page, (app, eid) => app.editor.scene.get(eid).kind, id)).toBe('ui');
  // エディタ上にプレビューされる
  const preview = page.getByTestId('ui-preview').locator('.g-ui');
  await expect(preview).toHaveText('スコア: 0');

  // Inspector: 文字と配置を変更 (1回の Undo で戻る)
  await page.getByTestId('tab-inspector').tap();
  await expect(page.getByTestId('sec-ui')).toBeVisible();
  await page.getByTestId('ui-text').fill('得点 {score} 点');
  await page.getByTestId('ui-text').blur();
  await expect(preview).toHaveText('得点 0 点');
  await page.getByTestId('ui-anchor-center').tap();
  expect(await evalApp(page, (app, eid) => app.editor.scene.get(eid).ui.anchor, id)).toBe('center');
  await enterNumber(page, 'ui-font-size', '32');
  expect(await evalApp(page, (app, eid) => app.editor.scene.get(eid).ui.fontSize, id)).toBe(32);
  await page.getByTestId('undo').tap();
  expect(await evalApp(page, (app, eid) => app.editor.scene.get(eid).ui.fontSize, id)).toBe(22);
  await closeSheet(page);

  // 選択を外してから、プレビューをタップすると選択できる
  await evalApp(page, (app) => app.editor.selection.clear());
  await expect(preview).not.toHaveClass(/selected/);
  const box = (await preview.boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => evalApp(page, (app) => app.editor.selection.active)).toBe(id);

  // ボタンを追加して動作を「ジャンプ」に
  await page.getByTestId('add').tap();
  await page.getByTestId('add-ui-button').tap();
  const btnId = await evalApp(page, (app) => app.editor.selection.active);
  await page.getByTestId('tab-inspector').tap();
  await page.getByTestId('ui-action').selectOption('jump');
  expect(await evalApp(page, (app, eid) => app.editor.scene.get(eid).ui.action, btnId)).toBe('jump');
  await closeSheet(page);

  // Play: UI が表示され、値が反映される。ボタンを押すとイベントが起きる
  await page.getByTestId('play').tap();
  await expect(page.getByTestId('game-ui')).toBeVisible();
  const text = page.getByTestId('game-ui').locator('.g-custom .g-ui-text');
  await expect(text).toHaveText('得点 0 点');
  await evalApp(page, (app) => app.play.runtime.state.addScore(25));
  await expect(text).toHaveText('得点 25 点');
  await page.getByTestId('game-ui').locator('.g-custom .g-ui-button').tap();
  await expect.poll(() => evalApp(page, (app) => app.play.runtime.eventLog.map((e: { event: string }) => e.event))).toContain('ui-click');
  await page.getByTestId('stop').tap();
});

test('タイトル画面・設定・BGM・効果音の選択・セーブポイントから「つづきから」', async ({ page }) => {
  await createFromTemplate(page, 'coins');
  // シーンの BGM を組み込みの「おだやか」に変更
  await evalApp(page, (app) => app.editor.selection.clear());
  await page.getByTestId('tab-inspector').tap();
  await openSection(page, 'sec-music');
  await page.getByTestId('scene-music').tap();
  await page.getByTestId('scene-music-calm').tap();
  expect(await evalApp(page, (app) => app.editor.sceneData.music.source)).toBe('builtin:calm');
  // ゲーム設定: タイトル画面から Play
  await openSection(page, 'sec-game');
  await page.getByTestId('gs-title').fill('テストゲーム');
  await page.getByTestId('gs-title').press('Enter');
  expect(await evalApp(page, (app) => app.editor.project.game.title)).toBe('テストゲーム');
  await page.getByTestId('play-from-title').tap();
  expect(await evalApp(page, (app) => app.editor.settings.playFromTitle)).toBe(true);

  // コインの効果音を選ぶ
  const coin = await evalApp(page, (app) => (Object.values(app.editor.sceneData.entities) as any[]).find((e) => e.name === 'コイン1').id);
  await evalApp(page, (app, cid) => app.editor.selection.set([cid]), coin);
  await page.getByTestId('prop-sound').scrollIntoViewIfNeeded();
  await page.getByTestId('prop-sound').tap();
  await page.getByTestId('prop-sound-powerup').tap();
  expect(await evalApp(page, (app, cid) => app.editor.scene.get(cid).components.find((c: any) => c.type === 'item').props.sound, coin)).toBe('builtin:powerup');
  await closeSheet(page);

  // タイトル画面 → 設定 → 戻る → はじめる
  await page.getByTestId('play').tap();
  await expect(page.getByTestId('game-title')).toBeVisible();
  await expect(page.getByTestId('game-title-text')).toHaveText('テストゲーム');
  await expect(page.getByTestId('game-continue')).toHaveCount(0);
  expect(await evalApp(page, (app) => app.play.runtime.phase)).toBe('title');
  await page.getByTestId('game-open-settings').tap();
  await expect(page.getByTestId('game-settings')).toBeVisible();
  await page.getByTestId('game-vol-music').fill('30');
  expect(await evalApp(page, (app) => app.play.runtime.audio.getVolumes().music)).toBeCloseTo(0.3);
  await page.getByTestId('game-settings-back').tap();
  await page.getByTestId('game-start').tap();
  await expect(page.getByTestId('game-title')).toHaveCount(0);
  await expect.poll(() => evalApp(page, (app) => !!app.play.runtime?.physics && app.play.runtime.phase === 'playing'), { timeout: 20_000 }).toBe(true);
  expect(await evalApp(page, (app) => app.play.runtime.audio.currentMusic)).toBe('builtin:calm');

  // コイン → 選んだ効果音。セーブポイントで端末に保存
  await teleportNear(page, 'コイン1');
  await expect.poll(async () => (await state(page)).score).toBe(10);
  expect(await evalApp(page, (app) => app.play.runtime.audio.history)).toContain('builtin:powerup');
  await teleportNear(page, 'セーブポイント', [0, 0.9, 0]);
  await expect(page.getByTestId('game-toast')).toContainText('セーブしました');
  const saved = await evalApp(page, (app) => JSON.parse(localStorage.getItem(`pocket-engine:save:${app.editor.project.id}`) ?? 'null'));
  expect(saved.score).toBe(10);

  // 一度止めて、もう一度 Play → 「つづきから」でスコアが戻る
  await page.getByTestId('stop').tap();
  await page.getByTestId('play').tap();
  await expect(page.getByTestId('game-continue')).toBeVisible();
  await page.getByTestId('game-continue').tap();
  await expect.poll(async () => (await state(page)).score).toBe(10);
  await page.getByTestId('stop').tap();

  // ゲーム設定・BGM は保存・再読み込みしても残る
  await page.getByTestId('save').tap();
  await expect(page.getByTestId('save')).toHaveAttribute('data-state', 'saved');
  await reloadApp(page);
  expect(await evalApp(page, (app) => [app.editor.project.game.title, app.editor.sceneData.music.source])).toEqual(['テストゲーム', 'builtin:calm']);
});

test('プレイヤー操作コンポーネントを後から付けて遊べる (物理 OFF でも動く)', async ({ page }) => {
  // サンプルシーンの「プレイヤー」(球) に「プレイヤー操作」を付け、物理を OFF にする
  const pid = await evalApp(page, (app) => (Object.values(app.editor.sceneData.entities) as any[]).find((e) => e.name === 'プレイヤー').id);
  await evalApp(page, (app, id) => app.editor.selection.set([id]), pid);
  await page.getByTestId('tab-inspector').tap();
  await page.getByTestId('insp-add-component').scrollIntoViewIfNeeded();
  await page.getByTestId('insp-add-component').tap();
  await page.getByTestId('add-comp-player').tap();
  await expect(page.getByTestId('comp-player')).toBeVisible();
  await page.getByTestId('prop-camera').selectOption('scene');
  await evalApp(page, (app) => app.editor.selection.clear());
  await openSection(page, 'sec-physics');
  await page.getByTestId('phys-enabled').tap();
  await closeSheet(page);

  await page.getByTestId('play').tap();
  await expect(page.getByTestId('game-jump')).toBeVisible();
  await expect.poll(() => evalApp(page, (app) => app.play.runtime?.time ?? 0)).toBeGreaterThan(0.05);
  expect(await evalApp(page, (app) => [app.play.runtime.physics, app.play.runtime.cameraMode, app.play.runtime.playerId])).toEqual([null, 'game', pid]);
  // 物理なしでもジョイスティックで移動・ジャンプできる
  const x0 = await evalApp(page, (app, id) => app.play.runtime.objects.get(id).position.x, pid);
  await holdJoystick(page, 60, 0, 900);
  expect(await evalApp(page, (app, id) => app.play.runtime.objects.get(id).position.x, pid)).toBeGreaterThan(x0 + 0.2);
  const y0 = await evalApp(page, (app, id) => app.play.runtime.objects.get(id).position.y, pid);
  await page.getByTestId('game-jump').tap();
  await expect.poll(() => evalApp(page, (app, id) => app.play.runtime.objects.get(id).position.y, pid)).toBeGreaterThan(y0 + 0.1);
  await expect.poll(() => evalApp(page, (app, id) => app.play.runtime.objects.get(id).position.y, pid), { timeout: 10_000 }).toBeCloseTo(y0, 3);
  await page.getByTestId('stop').tap();
  // 停止後は元の位置に戻る
  expect((await evalApp(page, (app, id) => app.editor.scene.get(id).transform.position, pid))[0]).toBe(1.5);
});
