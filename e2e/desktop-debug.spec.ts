import { expect, test } from '@playwright/test';
import { openApp } from './helpers';

/**
 * Phase 8 (PC): ` キー (または F8) でデバッグコンソールを開く / 閉じる。PC では画面の右側に出る
 */
test('デバッグコンソール (キーボード)', async ({ page }) => {
  const errors: string[] = [];
  await openApp(page, errors);
  await page.locator('body').click({ position: { x: 5, y: 400 } });
  await page.keyboard.press('F8');
  await expect(page.getByTestId('console')).toBeVisible();
  const box = (await page.getByTestId('console').boundingBox())!;
  // 右側に縦長で出る
  expect(box.x).toBeGreaterThan(600);
  expect(box.height).toBeGreaterThan(600);
  await page.getByTestId('console-tab-perf').click();
  await expect.poll(() => page.getByTestId('perf-fps').textContent(), { timeout: 10_000 }).toMatch(/^\d+$/);
  await page.keyboard.press('F8');
  await expect(page.getByTestId('console')).toBeHidden();
  expect(errors.filter((e) => !/GPU stall|swiftshader|WebGL|KHR_parallel/i.test(e))).toEqual([]);
});
