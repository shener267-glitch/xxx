import { expect, test } from '@playwright/test';
import { entities, evalApp, openApp, screenPos, selection, waitSheetClosed } from './helpers';

/**
 * 公開環境 (GitHub Pages) 向けの短い動作確認。
 * PE_REMOTE_URL を指定すると公開 URL に対して実行できる。
 */
test('スモーク: 起動 → Cube 追加 → 選択 → Play/Stop → 保存', async ({ page }) => {
  const errors: string[] = [];
  await openApp(page, errors);
  await expect(page.locator('canvas.viewport-canvas')).toBeVisible();
  expect(await evalApp(page, (app) => {
    app.viewport.renderNow();
    return app.engine.renderer.info.render.calls;
  })).toBeGreaterThan(0);

  const before = (await entities(page)).length;
  await page.getByTestId('add').tap();
  await page.getByTestId('add-cube').tap();
  expect((await entities(page)).length).toBe(before + 1);
  const [id] = await selection(page);
  await page.getByTestId('tab-scene').tap();
  await page.getByTestId('sheet-close').tap();
  // シートを閉じると 3D ビューの中心が戻るので、落ち着いてから位置を求める
  await waitSheetClosed(page);
  const p = await screenPos(page, id);
  await page.touchscreen.tap(p.x, p.y);
  await expect.poll(() => selection(page)).toEqual([id]);

  await page.getByTestId('play').tap();
  await expect(page.getByTestId('play-hud')).toBeVisible();
  await page.getByTestId('stop').tap();
  await expect(page.getByTestId('play-hud')).toBeHidden();

  await page.getByTestId('save').tap();
  await expect(page.getByTestId('save')).toHaveAttribute('data-state', 'saved');
  expect(errors.filter((e) => !/GPU stall|swiftshader|WebGL/i.test(e))).toEqual([]);
});

test('スモーク: 書き出したゲームの本体 (player/pocket-player.js) が配信されている', async ({ page, request }) => {
  await page.goto('./');
  const url = new URL('player/pocket-player.js', page.url()).href;
  const res = await request.get(url);
  expect(res.status()).toBe(200);
  const js = await res.text();
  expect(js).toContain('__POCKET_GAME__');
  expect(js.length).toBeGreaterThan(100_000);
});
