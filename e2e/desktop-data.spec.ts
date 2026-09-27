import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { evalApp, openApp } from './helpers';

/**
 * Phase 9 (PC): マウスでシーンの管理・パッケージの書き出しと読み込み・バックアップ
 */
test('シーンの管理とパッケージ (マウス)', async ({ page }) => {
  const errors: string[] = [];
  await openApp(page, errors);

  // シーンを増やして並べ替える
  await page.getByTestId('tb-title').click();
  await page.getByTestId('scene-manage').click();
  await page.getByTestId('sm-new').click();
  await expect(page.getByTestId('scene-manager').locator('.scene-item')).toHaveCount(2);
  await page.getByTestId('scene-down-0').click();
  expect(await evalApp(page, (app) => app.editor.project.scenes.map((s: any) => s.name))).toEqual(['シーン2', 'シーン1']);
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);

  // バックアップを作る
  await page.getByTestId('main-menu').click();
  await page.getByTestId('menu-backups').click();
  await page.getByTestId('backup-now').click();
  await expect(page.getByTestId('backup-row-0')).toContainText('手動');
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);

  // .pocket.zip で書き出して読み込む
  await page.getByTestId('main-menu').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('menu-export-zip').click()]);
  expect(download.suggestedFilename()).toMatch(/\.pocket\.zip$/);
  const bytes = readFileSync((await download.path())!);
  const oldId = await evalApp(page, (app) => app.editor.project.id);
  await page.getByTestId('main-menu').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('menu-import').click()]);
  await chooser.setFiles({ name: 'game.pocket.zip', mimeType: 'application/zip', buffer: bytes });
  await expect.poll(() => evalApp(page, (app) => app.editor.project.id)).not.toBe(oldId);
  // シーンの順番も戻る
  expect(await evalApp(page, (app) => app.editor.project.scenes.map((s: any) => s.name))).toEqual(['シーン2', 'シーン1']);
  expect(errors.filter((e) => !/GPU stall|swiftshader|WebGL|KHR_parallel/i.test(e))).toEqual([]);
});
