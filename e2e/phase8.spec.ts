import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { closeSheet, enterNumber, evalApp, openApp, stableBox } from './helpers';

/**
 * Phase 8: デバッグコンソール・性能表示・オブジェクト検索・カメラ (プレビュー / 切り替え)・タイムライン・シーン切り替え
 */

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  await openApp(page, errors);
});

test.afterEach(() => {
  // テストでわざと出したエラーのログは除く
  expect(errors.filter((e) => !/GPU stall|swiftshader|WebGL|KHR_parallel|テストのエラー/i.test(e))).toEqual([]);
});

async function setRange(page: Page, testId: string, value: number): Promise<void> {
  await page.getByTestId(testId).evaluate((el, v) => {
    const input = el as HTMLInputElement;
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

test('デバッグコンソール: エラーの場所からオブジェクトを選ぶ・絞り込み・検索・消去・性能', async ({ page }) => {
  const cube = await evalApp(page, (app) => (Object.values(app.editor.sceneData.entities) as any[]).find((e) => e.kind === 'mesh' && e.mesh.shape === 'cube').id as string);
  // Play 中にオブジェクトでエラーが起きたことにする (ランタイムのエラー報告)
  await page.getByTestId('play').tap();
  await expect.poll(() => evalApp(page, (app) => app.play.runtime?.time ?? 0)).toBeGreaterThan(0.05);
  await evalApp(page, (app, id) => {
    const r = app.play.runtime;
    r.report('テストのエラー (自動回転)', 'error', r.sceneData.entities[id], new Error('テストのエラーの詳細'));
    r.report('テストの警告', 'warn');
  }, cube);
  await page.getByTestId('stop').tap();

  // 3D ビューの左上にお知らせ → タップでコンソール (エラーだけ)
  await expect(page.getByTestId('error-chip')).toBeVisible();
  await expect(page.getByTestId('error-chip')).toContainText('エラー 1');
  await page.getByTestId('error-chip').tap();
  await expect(page.getByTestId('console')).toBeVisible();
  await expect(page.getByTestId('error-chip')).toBeHidden();
  await expect(page.getByTestId('console-level-error')).toHaveAttribute('aria-pressed', 'true');
  const rows = page.getByTestId('log-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('テストのエラー');
  await expect(rows.first()).toContainText('場所: Play / キューブ');
  // 開くと詳細と「このオブジェクトを選ぶ」
  await rows.first().locator('.log-head').tap();
  await expect(page.getByTestId('console').locator('.log-detail')).toContainText('テストのエラーの詳細');
  await page.getByTestId('log-select').tap();
  await expect(page.getByTestId('console')).toBeHidden();
  expect(await evalApp(page, (app) => app.editor.selection.active)).toBe(cube);
  await expect(page.getByTestId('sheet')).not.toHaveAttribute('data-state', 'closed');
  await closeSheet(page);

  // メニューから開く: すべて・検索・消去
  await page.getByTestId('main-menu').tap();
  await page.getByTestId('menu-console').tap();
  await page.getByTestId('console-level-all').tap();
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
  await page.getByTestId('console-search').fill('警告');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-level', 'warn');
  await page.getByTestId('console-search').fill('');
  await page.getByTestId('console-clear').tap();
  await expect(rows).toHaveCount(0);
  await expect(page.getByTestId('log-list')).toContainText('ログはまだありません');

  // 性能: FPS・描画の回数・オブジェクトの数
  await page.getByTestId('console-tab-perf').tap();
  await expect.poll(() => page.getByTestId('perf-fps').textContent(), { timeout: 10_000 }).toMatch(/^\d+$/);
  const objects = await evalApp(page, (app) => Object.keys(app.editor.sceneData.entities).length);
  await expect(page.getByTestId('perf-objects')).toHaveText(String(objects));
  await expect(page.getByTestId('perf-graph')).toBeVisible();
  await page.getByTestId('console-close').tap();
  await expect(page.getByTestId('console')).toBeHidden();
});

test('オブジェクトの検索: 種類・動作で探し、選ぶとカメラが向く', async ({ page }) => {
  await page.getByTestId('add').tap();
  await page.getByTestId('add-game-enemy').tap();
  const enemy = await evalApp(page, (app) => app.editor.selection.active as string);
  // 離れた場所に置く
  await evalApp(page, (app, id) => {
    const e = app.editor.scene.get(id);
    app.editor.scene.setTransform(id, { ...e.transform, position: [8, e.transform.position[1], -6] });
    app.editor.selection.clear();
  }, enemy);
  await page.getByTestId('tab-scene').tap();
  const search = page.getByTestId('scene-search');
  // 「ライト」で太陽光などのライトが見つかる
  await search.fill('ライト');
  const lights = await evalApp(page, (app) => (Object.values(app.editor.sceneData.entities) as any[]).filter((e) => e.kind === 'light').map((e) => e.id));
  for (const id of lights) await expect(page.getByTestId(`row-${id}`)).toBeVisible();
  await expect(page.locator('.tree-row')).toHaveCount(lights.length);
  // 動作の名前 (敵) で探す
  await search.fill('敵');
  await expect(page.locator('.tree-row')).toHaveCount(1);
  const before = await evalApp(page, (app) => app.viewport.camera.getState().target);
  await page.getByTestId(`row-${enemy}`).tap();
  expect(await evalApp(page, (app) => app.editor.selection.active)).toBe(enemy);
  // カメラが敵の方へ動く
  await expect.poll(() => evalApp(page, (app) => app.viewport.camera.getState().target[0]), { timeout: 5000 }).toBeGreaterThan(before[0] + 4);
  await search.fill('ないもの');
  await expect(page.getByText('一致するオブジェクトはありません', { exact: false })).toBeVisible();
});

test('カメラ: このカメラから見る・Play 中に切り替える・シーン切り替え (道具)', async ({ page }) => {
  // 2 台目のカメラ
  await page.getByTestId('add').tap();
  await page.getByTestId('add-camera').tap();
  const cam = await evalApp(page, (app) => app.editor.selection.active as string);
  await page.getByTestId('tab-inspector').tap();
  await page.getByTestId('insp-camera-preview').scrollIntoViewIfNeeded();
  await page.getByTestId('insp-camera-preview').tap();
  await expect(page.getByTestId('camera-preview-banner')).toHaveClass(/show/);
  expect(await evalApp(page, (app) => app.viewport.previewCameraId)).toBe(cam);
  // カメラの視点ではギズモを出さない
  await evalApp(page, (app) => app.viewport.renderNow());
  expect(await evalApp(page, (app) => app.viewport.gizmo.attached)).toBe(false);
  await page.getByTestId('camera-preview-exit').tap();
  await expect(page.getByTestId('camera-preview-banner')).not.toHaveClass(/show/);
  expect(await evalApp(page, (app) => app.viewport.previewCameraId)).toBeNull();

  // 2 つ目のシーン
  const first = await evalApp(page, (app) => app.editor.sceneData.id);
  await evalApp(page, (app) => app.editor.selection.clear());
  await page.getByTestId('tab-scene').tap();
  await page.getByTestId('scene-switch').tap();
  await page.getByTestId('scene-new').tap();
  await expect.poll(() => evalApp(page, (app) => app.editor.project.scenes.length)).toBe(2);
  const second = await evalApp(page, (app) => app.editor.sceneData.id);
  await evalApp(page, (app, id) => app.editor.setActiveScene(id), first);
  await expect.poll(() => evalApp(page, (app) => app.editor.sceneData.id)).toBe(first);
  await closeSheet(page);

  // Play → デバッグの道具
  await page.getByTestId('play').tap();
  await expect.poll(() => evalApp(page, (app) => app.play.runtime?.time ?? 0)).toBeGreaterThan(0.05);
  await page.getByTestId('play-console').tap();
  await expect(page.getByTestId('console')).toBeVisible();
  await page.getByTestId('console-tab-tools').tap();
  await page.getByTestId('tool-camera').selectOption(cam);
  await page.getByTestId('tool-camera-go').tap();
  await expect.poll(() => evalApp(page, (app) => app.play.runtime.activeCameraId)).toBe(cam);
  expect(await evalApp(page, (app) => app.play.runtime.getCameraMode())).toBe('game');
  // ふだんのカメラに戻す
  await page.getByTestId('tool-camera').selectOption('');
  await page.getByTestId('tool-camera-go').tap();
  await expect.poll(() => evalApp(page, (app) => app.play.runtime.activeCameraId)).toBeNull();
  // シーン切り替え
  await page.getByTestId('tool-scene').selectOption(second);
  await page.getByTestId('tool-scene-go').tap();
  await expect.poll(() => evalApp(page, (app) => app.play.runtime?.sceneData.id)).toBe(second);
  await page.getByTestId('console-close').tap();
  await page.getByTestId('stop').tap();
  expect(await evalApp(page, (app) => app.editor.sceneData.id)).toBe(first);
});

test('タイムライン: カメラと動作を並べる・プレビュー・自動再生・スキップ・終わったとき', async ({ page }) => {
  await page.getByTestId('add').tap();
  await page.getByTestId('add-camera').tap();
  const cam = await evalApp(page, (app) => app.editor.selection.active as string);
  await evalApp(page, (app) => app.editor.selection.clear());

  await page.getByTestId('tab-events').tap();
  await page.getByTestId('ev-mode-timelines').tap();
  await page.getByTestId('tl-add').tap();
  await expect(page.getByTestId('tl-name')).toHaveValue('タイムライン1');
  // 0 秒: カメラを切り替える
  await page.getByTestId('tl-add-camera').tap();
  await page.getByTestId('ev-param-target').selectOption(cam);
  await page.getByTestId('ev-form-ok').tap();
  // 2 秒: お知らせ
  await page.getByTestId('tl-add-item').tap();
  await page.getByTestId('ev-type-message').tap();
  await enterNumber(page, 'tl-item-time', '2');
  await page.getByTestId('ev-param-text').fill('はじまり');
  await page.getByTestId('ev-form-ok').tap();
  // 4 秒: スコア +10
  await page.getByTestId('tl-add-item').tap();
  await page.getByTestId('ev-type-score').tap();
  await enterNumber(page, 'tl-item-time', '4');
  await page.getByTestId('ev-form-ok').tap();
  const tl = await evalApp(page, (app) => app.editor.sceneData.timelines[0]);
  expect(tl.items.map((i: any) => [i.time, i.action.type])).toEqual([
    [0, 'camera'],
    [2, 'message'],
    [4, 'score'],
  ]);
  await expect(page.getByTestId('tl-item-1')).toContainText('2.0秒');
  await expect(page.getByTestId('tl-marker-0')).toBeVisible();

  // スライダーでプレビュー: カメラの視点になる
  await setRange(page, 'tl-scrub', 1);
  await expect(page.getByTestId('tl-time')).toHaveText('1.0 秒');
  expect(await evalApp(page, (app) => app.viewport.previewCameraId)).toBe(cam);
  // 動作を編集 (時刻を 3 秒に)
  await page.getByTestId('tl-item-2').tap();
  await enterNumber(page, 'tl-item-time', '3');
  await page.getByTestId('ev-form-ok').tap();
  expect(await evalApp(page, (app) => app.editor.sceneData.timelines[0].items.find((i: any) => i.action.type === 'score').time)).toBe(3);
  // Undo / Redo
  await page.getByTestId('undo').tap();
  expect(await evalApp(page, (app) => app.editor.sceneData.timelines[0].items.find((i: any) => i.action.type === 'score').time)).toBe(4);
  await page.getByTestId('redo').tap();

  // 自動で再生
  await page.getByTestId('tl-autoplay').tap();
  expect(await evalApp(page, (app) => app.editor.sceneData.timelines[0].autoplay)).toBe(true);
  // イベント一覧に戻るとプレビューをやめる
  await page.getByTestId('ev-mode-rules').tap();
  expect(await evalApp(page, (app) => app.viewport.previewCameraId)).toBeNull();
  await closeSheet(page);

  // Play: 始まるとカメラが切り替わり、黒帯が出て、プレイヤーは動けない
  await page.getByTestId('play').tap();
  await expect.poll(() => evalApp(page, (app) => app.play.runtime?.timeline.current?.name ?? null)).toBe('タイムライン1');
  await expect.poll(() => evalApp(page, (app) => app.play.runtime.activeCameraId)).toBe(cam);
  await expect(page.getByTestId('runtime-overlay').getByTestId('game-ui')).toHaveClass(/cutscene/);
  expect(await evalApp(page, (app) => app.play.runtime.input.consumeJump === app.play.runtime.inputImpl.consumeJump)).toBe(false);
  // 時間が進むとスコアが増える
  await expect.poll(() => evalApp(page, (app) => app.play.runtime.state.score), { timeout: 20_000 }).toBe(10);
  // 途中でもう一度再生 (前のものは「終わった」にならない) してスキップ
  await evalApp(page, (app) => app.play.runtime.timeline.play(app.play.runtime.sceneData.timelines[0].id));
  await stableBox(page, 'timeline-skip');
  await page.getByTestId('timeline-skip').tap();
  await expect.poll(() => evalApp(page, (app) => app.play.runtime.timeline.current)).toBeNull();
  // 終わったらカメラを戻す・終わりのイベント
  expect(await evalApp(page, (app) => app.play.runtime.activeCameraId)).toBeNull();
  expect(await evalApp(page, (app) => app.play.runtime.eventLog.filter((e: any) => e.event === 'timeline-end').length)).toBe(1);
  await expect(page.getByTestId('runtime-overlay').getByTestId('game-ui')).not.toHaveClass(/cutscene/);
  await page.getByTestId('stop').tap();
});

test('イベントからタイムラインを再生・カメラを切り替える', async ({ page }) => {
  await page.getByTestId('add').tap();
  await page.getByTestId('add-camera').tap();
  const cam = await evalApp(page, (app) => app.editor.selection.active as string);
  await evalApp(page, (app) => app.editor.selection.clear());
  await page.getByTestId('tab-events').tap();
  // タイムラインを作る (中身は 0 秒のお知らせだけ)
  await page.getByTestId('ev-mode-timelines').tap();
  await page.getByTestId('tl-add').tap();
  await page.getByTestId('tl-add-item').tap();
  await page.getByTestId('ev-type-message').tap();
  await page.getByTestId('ev-form-ok').tap();
  await enterNumber(page, 'tl-duration', '1');
  await page.getByTestId('tl-back').tap();
  await expect(page.getByTestId('tl-card-0')).toContainText('1 秒');
  // イベント: ゲームが始まったとき → タイムラインを再生、タイムラインが終わったとき → カメラを切り替える
  await page.getByTestId('ev-mode-rules').tap();
  await page.getByTestId('ev-add').tap();
  await page.getByTestId('ev-type-start').tap();
  await page.getByTestId('ev-add-action-0').tap();
  await page.getByTestId('ev-type-timeline').tap();
  const tlId = await evalApp(page, (app) => app.editor.sceneData.timelines[0].id);
  await page.getByTestId('ev-param-timeline').selectOption(tlId);
  await page.getByTestId('ev-form-ok').tap();
  await page.getByTestId('ev-add').tap();
  await page.getByTestId('ev-type-timelineEnd').tap();
  await page.getByTestId('ev-form-ok').tap();
  await page.getByTestId('ev-add-action-1').tap();
  await page.getByTestId('ev-type-camera').tap();
  await page.getByTestId('ev-param-target').selectOption(cam);
  await page.getByTestId('ev-form-ok').tap();
  await expect(page.getByTestId('ev-actions-1-0')).toContainText('カメラを「カメラ');
  await closeSheet(page);

  await page.getByTestId('play').tap();
  await expect.poll(() => evalApp(page, (app) => app.play.runtime?.eventLog.map((e: any) => e.event) ?? []), { timeout: 20_000 }).toContain('timeline-end');
  await expect.poll(() => evalApp(page, (app) => app.play.runtime.activeCameraId), { timeout: 10_000 }).toBe(cam);
  await page.getByTestId('stop').tap();
});
