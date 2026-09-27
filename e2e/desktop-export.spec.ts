import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { readZip } from '../src/core/zip';
import { evalApp, openApp } from './helpers';

/**
 * Phase 10 (PC): ゲームを書き出して、PC のブラウザでキーボードで遊ぶ。
 * 縦向きのゲームは横長の画面の中央に縦長の枠で表示する。
 */
test('書き出したゲームを PC で遊ぶ (キーボード・縦長の枠・Esc で一時停止)', async ({ page, context }) => {
  const errors: string[] = [];
  await openApp(page, errors);
  // コインあつめのテンプレート (プレイヤーあり)
  await page.getByTestId('main-menu').click();
  await page.getByTestId('menu-projects').click();
  await page.getByTestId('project-template').click();
  await page.getByTestId('template-coins').click();
  await page.getByTestId('prompt-ok').click();
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);

  await page.getByTestId('main-menu').click();
  await page.getByTestId('menu-export-game').click();
  await page.getByTestId('ge-orientation-portrait').click();
  expect(await evalApp(page, (app) => app.editor.project.game.orientation)).toBe('portrait');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('ge-export-zip').click()]);
  const files = await readZip(new Uint8Array(readFileSync((await download.path())!)));

  await context.route('http://pc-game.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/game\//, '') || 'index.html';
    const body = files.get(path);
    if (!body) return route.fulfill({ status: 404 });
    const type = path.endsWith('.html') ? 'text/html' : path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
    await route.fulfill({ status: 200, contentType: type, body: Buffer.from(body) });
  });
  const game = await context.newPage();
  const gameErrors: string[] = [];
  game.on('pageerror', (e) => gameErrors.push(e.message));
  await game.goto('http://pc-game.test/game/');
  await expect(game.getByTestId('game-title')).toBeVisible({ timeout: 30_000 });
  // 横長の画面 → 縦長の枠
  await expect(game.getByTestId('player')).toHaveClass(/frame-portrait/);
  const box = (await game.getByTestId('player').boundingBox())!;
  expect(box.width).toBeLessThan(box.height);
  expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThan(4);
  await expect(game.getByTestId('player-rotate')).toBeHidden();

  await game.getByTestId('game-start').click();
  await expect
    .poll(() => game.evaluate(() => {
      const rt = (window as any).__pocketPlayer.runtime;
      return rt.phase === 'playing' && !!rt.physics && rt.time > 0.3;
    }), { timeout: 30_000 })
    .toBe(true);
  // W キーで前へ進む (ゲームの時間で 1 秒押し続ける)
  const pos = () => game.evaluate(() => (window as any).__pocketPlayer.runtime.player.position.toArray() as number[]);
  const before = await pos();
  const t0 = await game.evaluate(() => (window as any).__pocketPlayer.runtime.time as number);
  await game.keyboard.down('w');
  await expect.poll(() => game.evaluate(() => (window as any).__pocketPlayer.runtime.time as number), { timeout: 20_000 }).toBeGreaterThan(t0 + 1);
  await game.keyboard.up('w');
  const after = await pos();
  expect(Math.hypot(after[0] - before[0], after[2] - before[2])).toBeGreaterThan(0.5);
  // Esc で一時停止メニュー
  await game.keyboard.press('Escape');
  await expect(game.getByTestId('game-pause-menu')).toBeVisible();
  await game.getByTestId('game-resume').click();
  await expect(game.getByTestId('game-pause-menu')).toHaveCount(0);
  expect(await game.evaluate(() => (window as any).__pocketPlayer.runtime.paused)).toBe(false);
  expect(gameErrors).toEqual([]);
  expect(errors.filter((e) => !/GPU stall|swiftshader|WebGL|KHR_parallel/i.test(e))).toEqual([]);
});
