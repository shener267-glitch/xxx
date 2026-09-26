import { expect, test } from '@playwright/test';
import { entities, evalApp, openApp, screenPos, selection } from './helpers';

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
  const p = await screenPos(page, id);
  await page.getByTestId('tab-scene').tap();
  await page.getByTestId('sheet-close').tap();
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
