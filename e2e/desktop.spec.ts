import { expect, test } from '@playwright/test';
import { emptyPoint, entities, entity, evalApp, openApp, screenPos, selection } from './helpers';

/**
 * PC (マウス・キーボード) での操作確認。
 */

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('マウスで選択・カメラ操作・ショートカット', async ({ page }) => {
  // 横長の画面ではパネルが右側に浮かぶ (画面を固定分割しない)
  await page.getByTestId('tab-inspector').click();
  await expect(page.locator('.app')).toHaveClass(/layout-side/);
  const sheet = (await page.getByTestId('sheet').boundingBox())!;
  const vp = (await page.getByTestId('viewport').boundingBox())!;
  expect(sheet.x).toBeGreaterThan(vp.x + vp.width / 2);

  // クリックで選択
  const cube = (await entities(page)).find((e) => e.name === 'キューブ')!;
  const p = await screenPos(page, cube.id);
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => selection(page)).toEqual([cube.id]);
  await expect(page.getByTestId('insp-name')).toHaveValue('キューブ');

  // 左ドラッグ (何もない所) でカメラ回転、ホイールでズーム
  const cam0 = await evalApp(page, (app) => app.viewport.camera.getState());
  const e = await emptyPoint(page);
  await page.mouse.move(e.x, e.y);
  await page.mouse.down();
  await page.mouse.move(e.x + 120, e.y + 10, { steps: 8 });
  await page.mouse.up();
  const cam1 = await evalApp(page, (app) => app.viewport.camera.getState());
  expect(Math.abs(cam1.yaw - cam0.yaw)).toBeGreaterThan(10);
  await page.mouse.move(vp.x + vp.width / 2, vp.y + vp.height / 2);
  await page.mouse.wheel(0, -400);
  const cam2 = await evalApp(page, (app) => app.viewport.camera.getState());
  expect(cam2.distance).toBeLessThan(cam1.distance);

  // ショートカット (カメラが動いたので位置を取り直す)
  const p2 = await screenPos(page, cube.id);
  await page.mouse.click(p2.x, p2.y);
  await expect.poll(() => selection(page)).toEqual([cube.id]);
  await page.keyboard.press('e');
  expect(await evalApp(page, (app) => app.editor.tool)).toBe('rotate');
  await page.keyboard.press('w');
  const count = (await entities(page)).length;
  await page.keyboard.press('Control+d');
  expect((await entities(page)).length).toBe(count + 1);
  await page.keyboard.press('Control+z');
  expect((await entities(page)).length).toBe(count);
  await page.keyboard.press('Control+y');
  expect((await entities(page)).length).toBe(count + 1);
  await page.keyboard.press('Delete');
  expect((await entities(page)).length).toBe(count);

  // 数値欄はクリックで直接入力できる (四則演算も可)
  await page.mouse.click(p2.x, p2.y);
  await expect.poll(() => selection(page)).toEqual([cube.id]);
  await page.getByTestId('insp-position-y').locator('..').click();
  await page.getByTestId('insp-position-y').fill('1+1.5');
  await page.getByTestId('insp-position-y').press('Enter');
  expect((await entity(page, cube.id)).position[1]).toBe(2.5);

  // 数値欄の左右ドラッグ (スクラブ)
  const field = (await page.getByTestId('insp-position-x').locator('..').boundingBox())!;
  const before = (await entity(page, cube.id)).position[0];
  await page.mouse.move(field.x + field.width / 2, field.y + field.height / 2);
  await page.mouse.down();
  await page.mouse.move(field.x + field.width / 2 + 60, field.y + field.height / 2, { steps: 6 });
  await page.mouse.up();
  expect((await entity(page, cube.id)).position[0]).toBeGreaterThan(before);

  // P キーで Play、Esc で停止
  await page.mouse.click(e.x, e.y);
  await page.keyboard.press('p');
  await expect(page.getByTestId('play-hud')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('play-hud')).toBeHidden();
});
