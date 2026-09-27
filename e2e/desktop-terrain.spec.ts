import { expect, test } from '@playwright/test';
import { evalApp, openApp } from './helpers';

/**
 * Phase 7 (PC): マウスで地形をなぞって盛る。ブラシの円がマウスに付いてくる
 */
test('地形ブラシ (マウス)', async ({ page }) => {
  const errors: string[] = [];
  await openApp(page, errors);
  await page.getByTestId('add').click();
  await page.getByTestId('add-terrain-flat').click();
  const id = await evalApp(page, (app) => app.editor.selection.active as string);
  await evalApp(page, (app) => app.viewport.camera.setState({ target: [0, 0, 0], yaw: 0, pitch: 55, distance: 30 }));
  await page.getByTestId('tab-inspector').click();
  await page.getByTestId('terrain-brush').click();
  await expect(page.getByTestId('brush-bar')).toHaveClass(/show/);
  const p = await evalApp(page, (app) => {
    app.viewport.renderNow();
    return app.viewport.screenPosition(app.editor.selection.active);
  });
  // マウスを動かすとブラシの円が出る
  await page.mouse.move(p.x - 40, p.y);
  await expect.poll(() => evalApp(page, (app) => app.viewport.terrainBrush.cursor.visible)).toBe(true);
  // なぞって盛る
  await page.mouse.down();
  for (let i = 0; i <= 10; i++) {
    await page.mouse.move(p.x - 40 + i * 8, p.y);
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
  await expect.poll(() => evalApp(page, (app, i) => Math.max(...app.editor.scene.get(i).terrain.heights), id)).toBeGreaterThan(0.3);
  // Ctrl+Z で戻る
  await page.keyboard.press('Control+z');
  expect(await evalApp(page, (app, i) => Math.max(...app.editor.scene.get(i).terrain.heights), id)).toBe(0);
  await page.getByTestId('brush-done').click();
  expect(errors.filter((e) => !/GPU stall|swiftshader|WebGL|KHR_parallel/i.test(e))).toEqual([]);
});
