import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readZip } from '../src/core/zip';
import { createFromTemplate, evalApp, openApp, openSection } from './helpers';

/**
 * Phase 10: ゲームの書き出し (ZIP / 1 つの HTML)、書き出したゲームが単体で動くこと、
 * タイトル画面・設定画面 (画質・全画面)・一時停止・画面の向き、新しいタブで遊ぶ、全画面でテストプレイ
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

/** 書き出したゲームのページのエラーを集める */
function watchErrors(page: Page): string[] {
  const list: string[] = [];
  page.on('pageerror', (e) => list.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') list.push(m.text());
  });
  return list;
}

async function openExport(page: Page): Promise<void> {
  await page.getByTestId('main-menu').tap();
  await page.getByTestId('menu-export-game').tap();
  await expect(page.getByTestId('game-export-modal')).toBeVisible();
}

/** ZIP の中身を「GitHub Pages と同じサブパス」の URL で配信する (ネットワークには出ない) */
async function serveZip(context: BrowserContext, files: Map<string, Uint8Array>, base: string): Promise<string[]> {
  const requested: string[] = [];
  const types: Record<string, string> = { html: 'text/html', js: 'text/javascript', png: 'image/png', webmanifest: 'application/manifest+json', txt: 'text/plain' };
  await context.route('http://game.test/**', async (route) => {
    const url = new URL(route.request().url());
    requested.push(url.pathname);
    let path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : null;
    if (path === '') path = 'index.html';
    const body = path !== null ? files.get(decodeURIComponent(path)) : undefined;
    if (!body) return route.fulfill({ status: 404, body: 'not found' });
    const ext = path!.split('.').pop() ?? '';
    await route.fulfill({ status: 200, contentType: types[ext] ?? 'application/octet-stream', body: Buffer.from(body) });
  });
  return requested;
}

async function waitTitle(game: Page): Promise<void> {
  await expect(game.getByTestId('game-title')).toBeVisible({ timeout: 30_000 });
}

async function startGame(game: Page): Promise<void> {
  await game.getByTestId('game-start').tap();
  await expect(game.getByTestId('game-title')).toHaveCount(0);
  await expect
    .poll(() => game.evaluate(() => {
      const rt = (window as any).__pocketPlayer?.runtime;
      return !!rt && rt.phase === 'playing' && rt.time > 0.2;
    }), { timeout: 30_000 })
    .toBe(true);
}

test('ZIP で書き出して、GitHub Pages と同じサブパスで単体で遊べる', async ({ page, context }) => {
  await createFromTemplate(page, 'coins');
  await openExport(page);
  // 名前・作者・バージョン・向き・画質
  await page.getByTestId('ge-title').fill('テストゲーム');
  await page.getByTestId('ge-title').press('Enter');
  await page.getByTestId('ge-author').fill('たろう');
  await page.getByTestId('ge-author').press('Enter');
  await page.getByTestId('ge-version').fill('2.0.1');
  await page.getByTestId('ge-version').press('Enter');
  await page.getByTestId('ge-orientation-portrait').tap();
  await page.getByTestId('ge-quality-low').tap();
  await expect(page.getByTestId('ge-quality-low')).toHaveClass(/active/);
  const game = await evalApp(page, (app) => app.editor.project.game);
  expect(game).toMatchObject({ title: 'テストゲーム', author: 'たろう', version: '2.0.1', orientation: 'portrait', quality: 'low' });
  await expect(page.getByTestId('ge-size')).toContainText(/おおよそ [\d.]+ (KB|MB)/);
  // 元に戻せる (画面にもすぐ反映)
  await evalApp(page, (app) => app.editor.undo());
  await expect.poll(() => evalApp(page, (app) => app.editor.project.game.quality)).toBe('auto');
  await expect(page.getByTestId('ge-quality-auto')).toHaveClass(/active/);
  await page.getByTestId('ge-quality-low').tap();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('ge-export-zip').tap()]);
  expect(download.suggestedFilename()).toBe('テストゲーム.zip');
  const files = await readZip(new Uint8Array(readFileSync((await download.path())!)));
  expect([...files.keys()].sort()).toEqual(['.nojekyll', 'README.txt', 'game-data.js', 'icon-192.png', 'icon-512.png', 'index.html', 'manifest.webmanifest', 'pocket-player.js'].sort());
  // アイコンは本物の PNG
  expect(Buffer.from(files.get('icon-192.png')!.subarray(1, 4)).toString()).toBe('PNG');
  // エディタのコードは入っていない
  const player = Buffer.from(files.get('pocket-player.js')!).toString();
  expect(player).not.toContain('デバッグコンソール');
  expect(player).not.toContain('プロジェクト一覧');

  // 別のサイト (GitHub Pages と同じくリポジトリ名のサブパス) で開く
  const requested = await serveZip(context, files, '/my-game/');
  const gamePage = await context.newPage();
  const gameErrors = watchErrors(gamePage);
  await gamePage.goto('http://game.test/my-game/');
  await waitTitle(gamePage);
  await expect(gamePage).toHaveTitle('テストゲーム');
  await expect(gamePage.getByTestId('game-title-text')).toHaveText('テストゲーム');
  await expect(gamePage.getByTestId('game-credit')).toHaveText('作: たろう ・ v2.0.1');
  // 相対パスだけで読み込む
  expect(requested.every((p) => p.startsWith('/my-game/'))).toBe(true);
  expect(requested).toContain('/my-game/pocket-player.js');
  expect(requested).toContain('/my-game/game-data.js');

  // 全画面で遊ぶ (タイトル画面のボタン)
  await expect(gamePage.getByTestId('player-fullscreen')).toHaveText('全画面で遊ぶ');
  await gamePage.getByTestId('player-fullscreen').tap();
  await expect.poll(() => gamePage.evaluate(() => !!document.fullscreenElement)).toBe(true);

  // 設定画面: 画質 (書き出しの設定が初期値) を変えると保存される
  await gamePage.getByTestId('game-open-settings').tap();
  await expect(gamePage.getByTestId('player-quality-low')).toHaveAttribute('aria-pressed', 'true');
  await gamePage.getByTestId('player-quality-high').tap();
  await expect(gamePage.getByTestId('player-quality-high')).toHaveAttribute('aria-pressed', 'true');
  expect(await gamePage.evaluate(() => (window as any).__pocketPlayer.runtime.quality)).toBe('high');
  // 設定画面から全画面をやめる
  await expect(gamePage.getByTestId('player-fullscreen')).toHaveText('全画面をやめる');
  await gamePage.getByTestId('player-fullscreen').tap();
  await expect.poll(() => gamePage.evaluate(() => !!document.fullscreenElement)).toBe(false);
  await expect(gamePage.getByTestId('player-fullscreen')).toHaveText('全画面で遊ぶ');
  await gamePage.getByTestId('game-settings-back').tap();
  await waitTitle(gamePage);

  // ゲームを始める → 一時停止 → タイトルへ
  await startGame(gamePage);
  await expect(gamePage.getByTestId('game-ui')).toBeVisible();
  const coins = await gamePage.evaluate(() => Object.values((window as any).__pocketPlayer.runtime.sceneData.entities).filter((e: any) => /コイン/.test(e.name)).length);
  expect(coins).toBeGreaterThan(0);
  await gamePage.getByTestId('game-pause').tap();
  await expect(gamePage.getByTestId('game-pause-menu')).toBeVisible();
  expect(await gamePage.evaluate(() => (window as any).__pocketPlayer.runtime.paused)).toBe(true);
  await gamePage.getByTestId('game-to-title').tap();
  await waitTitle(gamePage);

  // 画質の設定は次に開いたときも残る
  await gamePage.reload();
  await waitTitle(gamePage);
  expect(await gamePage.evaluate(() => (window as any).__pocketPlayer.runtime.quality)).toBe('high');
  expect(gameErrors.filter((e) => !IGNORE.test(e))).toEqual([]);
});

test('1 つの HTML で書き出して、ファイルを開くだけで遊べる (サーバーなし)・画面の向きの案内', async ({ page, context }) => {
  await createFromTemplate(page, 'adventure');
  await openExport(page);
  await page.getByTestId('ge-orientation-landscape').tap();
  // タイトル画面なしですぐに始める
  await page.getByTestId('ge-start-title').tap();
  expect(await evalApp(page, (app) => app.editor.project.game.startFromTitle)).toBe(false);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('ge-export-html').tap()]);
  expect(download.suggestedFilename()).toMatch(/\.html$/);
  const html = readFileSync((await download.path())!, 'utf8');
  expect(html).not.toMatch(/<script src=/);
  const dir = mkdtempSync(join(tmpdir(), 'pocket-game-'));
  const file = join(dir, 'game.html');
  writeFileSync(file, html);

  const gamePage = await context.newPage();
  const gameErrors = watchErrors(gamePage);
  const external: string[] = [];
  gamePage.on('request', (r) => {
    if (!/^(file|data|blob):/.test(r.url())) external.push(r.url());
  });
  await gamePage.goto(pathToFileURL(file).href);
  // タイトル画面なしで始まる
  await expect
    .poll(() => gamePage.evaluate(() => {
      const rt = (window as any).__pocketPlayer?.runtime;
      return !!rt && rt.phase === 'playing' && rt.time > 0.2;
    }), { timeout: 30_000 })
    .toBe(true);
  await expect(gamePage.getByTestId('game-title')).toHaveCount(0);
  // 縦向きのスマホで横向きのゲーム → 回転の案内
  await expect(gamePage.getByTestId('player-rotate')).toBeVisible();
  await gamePage.setViewportSize({ width: 844, height: 390 });
  await expect(gamePage.getByTestId('player-rotate')).toBeHidden();
  // NPC と会話できる (イベント・UI も動く)
  expect(await gamePage.evaluate(() => (window as any).__pocketPlayer.runtime.hasPlayer)).toBe(true);
  expect(external).toEqual([]);
  expect(gameErrors.filter((e) => !IGNORE.test(e))).toEqual([]);
});

test('新しいタブで遊ぶ・全画面でテストプレイ・ゲーム設定からも書き出せる', async ({ page, context }) => {
  await createFromTemplate(page, 'coins');
  // 新しいタブ
  await page.getByTestId('main-menu').tap();
  const [tab] = await Promise.all([context.waitForEvent('page'), page.getByTestId('menu-preview-game').tap()]);
  const tabErrors = watchErrors(tab);
  await waitTitle(tab);
  await startGame(tab);
  expect(tabErrors.filter((e) => !IGNORE.test(e))).toEqual([]);
  await tab.close();

  // 全画面でテストプレイ (タイトル画面から)
  await page.getByTestId('main-menu').tap();
  await page.getByTestId('menu-play-fullscreen').tap();
  await expect(page.getByTestId('play-hud')).toBeVisible();
  await expect(page.getByTestId('game-title')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('stop').tap();
  await expect(page.getByTestId('play-hud')).toBeHidden();
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(false);

  // ゲーム設定 (インスペクター) からアイコン・作者を設定して書き出し画面を開く
  await evalApp(page, (app) => app.editor.selection.clear());
  await page.getByTestId('tab-inspector').tap();
  await openSection(page, 'sec-game');
  await page.getByTestId('gs-author').fill('はなこ');
  await page.getByTestId('gs-author').press('Enter');
  await expect.poll(() => evalApp(page, (app) => app.editor.project.game.author)).toBe('はなこ');
  await page.getByTestId('gs-export').tap();
  await expect(page.getByTestId('game-export-modal')).toBeVisible();
  await expect(page.getByTestId('ge-author')).toHaveValue('はなこ');
});
