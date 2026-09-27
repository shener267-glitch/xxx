import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { closeSheet, evalApp, openApp } from './helpers';

/**
 * Phase 9: プロジェクト / シーンの保存・読み込み、パッケージ (.pocket.zip)、バックアップ、保存領域、
 * シーンの管理、他のプロジェクトからアセット・部品を取り込む、使われていないアセットの整理
 */

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  await openApp(page, errors);
});

test.afterEach(() => {
  expect(errors.filter((e) => !/GPU stall|swiftshader|WebGL|KHR_parallel/i.test(e))).toEqual([]);
});

/** PNG をブラウザで作る */
async function pngFile(page: Page, name: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 32;
    const g = c.getContext('2d')!;
    g.fillStyle = '#e04040';
    g.fillRect(0, 0, 32, 32);
    return c.toDataURL('image/png').split(',')[1];
  });
  return { name, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') };
}

async function importImage(page: Page, name: string): Promise<void> {
  await page.getByTestId('tab-assets').tap();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('asset-import').tap()]);
  await chooser.setFiles(await pngFile(page, `${name}.png`));
  await expect.poll(() => evalApp(page, (app, n) => app.editor.project.assets.some((a: any) => a.name === n), name)).toBe(true);
  await closeSheet(page);
}

const projectCount = (page: Page) => evalApp(page, async (app) => (await app.projects.list()).length);
const entityCount = (page: Page) => evalApp(page, (app) => Object.keys(app.editor.sceneData.entities).length);

async function menu(page: Page, testId: string): Promise<void> {
  await page.getByTestId('main-menu').tap();
  await page.getByTestId(testId).tap();
}

test('パッケージ: .pocket.zip で書き出して読み込むと、アセットの本体も戻る', async ({ page }) => {
  await importImage(page, '赤');
  await evalApp(page, (app) => app.projects.save());
  const name = await evalApp(page, (app) => app.editor.project.name);
  const [download] = await Promise.all([page.waitForEvent('download'), menu(page, 'menu-export-zip')]);
  expect(download.suggestedFilename()).toMatch(/\.pocket\.zip$/);
  const path = await download.path();
  const bytes = readFileSync(path!);
  expect(bytes.subarray(0, 2).toString()).toBe('PK');

  const before = await projectCount(page);
  const oldId = await evalApp(page, (app) => app.editor.project.id);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), menu(page, 'menu-import')]);
  await chooser.setFiles({ name: download.suggestedFilename(), mimeType: 'application/zip', buffer: bytes });
  await expect.poll(() => projectCount(page)).toBe(before + 1);
  // 読み込んだプロジェクト (別の ID) が開き、画像の本体も読める
  await expect.poll(() => evalApp(page, (app) => app.editor.project.id)).not.toBe(oldId);
  expect(await evalApp(page, (app) => app.editor.project.name)).toBe(name);
  const size = await evalApp(page, async (app) => {
    const a = app.editor.project.assets.find((x: any) => x.name === '赤');
    const blob = await app.assets.getBlob(a.id);
    return blob ? blob.size : 0;
  });
  expect(size).toBeGreaterThan(50);
});

test('プロジェクト一覧: すべてバックアップ (.zip) を読み込むと全部追加される・保存領域の表示', async ({ page }) => {
  // もう 1 つプロジェクトを作る
  await page.getByTestId('main-menu').tap();
  await page.getByTestId('menu-projects').tap();
  await page.getByTestId('project-new').tap();
  await page.getByTestId('prompt-ok').tap();
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  await expect.poll(() => projectCount(page)).toBe(2);

  await page.getByTestId('main-menu').tap();
  await page.getByTestId('menu-projects').tap();
  const modal = page.getByTestId('projects-modal');
  await expect(modal.getByTestId('storage-summary')).toBeVisible();
  await expect(modal.getByTestId('storage-text')).toContainText('IndexedDB');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('project-export-all').tap()]);
  expect(download.suggestedFilename()).toMatch(/^pocket-engine-backup-\d{8}\.zip$/);
  const bytes = readFileSync((await download.path())!);

  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('project-import').tap()]);
  await chooser.setFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: bytes });
  await expect.poll(() => projectCount(page)).toBe(4);
  // 一覧にも表示される
  await expect(page.getByTestId('project-list').locator('.project-card')).toHaveCount(4);
});

test('バックアップ: 今すぐ・この状態に戻す (戻す前もバックアップ)・コピーとして開く', async ({ page }) => {
  const count0 = await entityCount(page);
  await menu(page, 'menu-backups');
  await expect(page.getByTestId('backups-modal')).toBeVisible();
  await page.getByTestId('backup-now').tap();
  await expect(page.getByTestId('backup-row-0')).toBeVisible();
  await expect(page.getByTestId('backup-row-0')).toContainText('手動');
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);

  // 変更する (キューブを 2 つ追加)
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('add').tap();
    await page.getByTestId('add-cube').tap();
  }
  expect(await entityCount(page)).toBe(count0 + 2);

  // バックアップの状態に戻す
  await menu(page, 'menu-backups');
  await page.getByTestId('backup-row-0').tap();
  await page.getByTestId('backup-restore').tap();
  await page.getByTestId('confirm-ok').tap();
  await expect.poll(() => entityCount(page)).toBe(count0);
  // 戻す前の状態もバックアップされている
  const reasons = await evalApp(page, async (app) => (await app.projects.listBackups()).map((b: any) => b.reason));
  expect(reasons).toContain('before-restore');
  expect(reasons).toContain('manual');

  // 「戻す前」のバックアップをコピーとして開く → キューブ 2 つ多い別のプロジェクト
  const projects0 = await projectCount(page);
  await menu(page, 'menu-backups');
  const rows = page.locator('.backup-row');
  const n = await rows.count();
  let idx = -1;
  for (let i = 0; i < n; i++) if ((await rows.nth(i).textContent())?.includes('戻す前')) idx = i;
  expect(idx).toBeGreaterThanOrEqual(0);
  await rows.nth(idx).tap();
  await page.getByTestId('backup-copy').tap();
  await expect.poll(() => projectCount(page)).toBe(projects0 + 1);
  expect(await evalApp(page, (app) => app.editor.project.name)).toContain('(復元)');
  expect(await entityCount(page)).toBe(count0 + 2);
});

test('自動バックアップ: 保存のときに作られ、設定で止められる', async ({ page }) => {
  await evalApp(page, (app) => app.projects.save());
  await expect.poll(() => evalApp(page, async (app) => (await app.projects.listBackups()).length)).toBe(1);
  expect(await evalApp(page, async (app) => (await app.projects.listBackups())[0].reason)).toBe('auto');
  // 10 分たっていないので増えない
  await page.getByTestId('add').tap();
  await page.getByTestId('add-cube').tap();
  await evalApp(page, (app) => app.projects.save());
  expect(await evalApp(page, async (app) => (await app.projects.listBackups()).length)).toBe(1);
  // 設定の切り替え
  await page.getByTestId('tab-settings').tap();
  await page.getByTestId('set-auto-backup').tap();
  expect(await evalApp(page, (app) => app.editor.settings.autoBackup)).toBe(false);
});

test('シーンの管理: 並べ替え・開始シーン・名前変更・削除', async ({ page }) => {
  await page.getByTestId('tb-title').tap();
  await page.getByTestId('scene-manage').tap();
  await expect(page.getByTestId('scenes-modal')).toBeVisible();
  await page.getByTestId('sm-new').tap();
  await page.getByTestId('sm-new').tap();
  await expect(page.getByTestId('scene-manager').locator('.scene-item')).toHaveCount(3);
  const names = () => evalApp(page, (app) => app.editor.project.scenes.map((s: any) => s.name));
  expect(await names()).toEqual(['シーン1', 'シーン2', 'シーン3']);
  // 3 番目を前へ
  await page.getByTestId('scene-up-2').tap();
  expect(await names()).toEqual(['シーン1', 'シーン3', 'シーン2']);
  // 2 番目 (シーン3) を開始シーンに
  await page.getByTestId('scene-more-1').tap();
  await page.getByTestId('sm-start').tap();
  const start = await evalApp(page, (app) => app.editor.project.scenes.find((s: any) => s.id === app.editor.project.startSceneId).name);
  expect(start).toBe('シーン3');
  await expect(page.getByTestId('scene-item-1')).toContainText('開始');
  // 名前変更
  await page.getByTestId('scene-more-2').tap();
  await page.getByTestId('sm-rename').tap();
  await page.getByTestId('prompt-input').fill('ボスの部屋');
  await page.getByTestId('prompt-ok').tap();
  await expect(page.getByTestId('scene-item-2')).toContainText('ボスの部屋');
  // 削除
  await page.getByTestId('scene-more-2').tap();
  await page.getByTestId('sm-delete').tap();
  await page.getByTestId('confirm-ok').tap();
  expect(await names()).toEqual(['シーン1', 'シーン3']);
  // 開く
  await page.getByTestId('scene-open-1').tap();
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  expect(await evalApp(page, (app) => app.editor.sceneData.name)).toBe('シーン3');
});

test('アセット: 他のプロジェクトから画像と部品を取り込む・使われていないものを整理', async ({ page }) => {
  // 元のプロジェクト: 画像と、その画像を貼った部品
  await importImage(page, '葉っぱ');
  await evalApp(page, async (app) => {
    const a = app.editor.project.assets.find((x: any) => x.name === '葉っぱ');
    const e = Object.values(app.editor.sceneData.entities).find((x: any) => x.kind === 'mesh') as any;
    e.mesh.material.texture = a.id;
  });
  const meshId = await evalApp(page, (app) => (Object.values(app.editor.sceneData.entities).find((x: any) => x.kind === 'mesh') as any).id);
  await evalApp(page, (app, id) => app.editor.selection.set([id]), meshId);
  await page.getByTestId('ctx-more').tap();
  await page.getByTestId('menu-prefab').tap();
  await page.getByTestId('prompt-input').fill('葉っぱの箱');
  await page.getByTestId('prompt-ok').tap();
  await expect.poll(() => evalApp(page, (app) => app.editor.project.prefabs.length)).toBe(1);
  await evalApp(page, (app) => app.projects.save());
  const srcId = await evalApp(page, (app) => app.editor.project.id);

  // 新しいプロジェクトへ
  await evalApp(page, (app) => app.projects.createNew('取り込み先', true));
  await expect.poll(() => evalApp(page, (app) => app.editor.project.name)).toBe('取り込み先');
  await page.getByTestId('tab-assets').tap();
  await page.getByTestId('asset-menu').tap();
  await page.getByTestId('asset-from-project').tap();
  await page.getByTestId(`ifp-project-${srcId}`).tap();
  await expect(page.getByTestId('ifp-modal')).toBeVisible();
  await page.getByTestId('ifp-item-葉っぱの箱').check();
  await page.getByTestId('ifp-ok').tap();
  await expect.poll(() => evalApp(page, (app) => app.editor.project.prefabs.map((p: any) => p.name))).toEqual(['葉っぱの箱']);
  // 部品が使っている画像も一緒に取り込まれ、本体も読める
  await expect.poll(() => evalApp(page, (app) => app.editor.project.assets.map((a: any) => a.name))).toEqual(['葉っぱ']);
  const size = await evalApp(page, async (app) => (await app.assets.getBlob(app.editor.project.assets[0].id))?.size ?? 0);
  expect(size).toBeGreaterThan(50);

  // 画像は部品で使われているので「使われていない」にはならない。もう 1 枚読み込むとそれは整理される
  await closeSheet(page);
  await importImage(page, '未使用');
  await page.getByTestId('tab-assets').tap();
  await page.getByTestId('asset-menu').tap();
  await page.getByTestId('asset-cleanup').tap();
  await expect(page.getByTestId('confirm-ok')).toBeVisible();
  await expect(page.locator('.modal').last()).toContainText('1 個');
  await page.getByTestId('confirm-ok').tap();
  await expect.poll(() => evalApp(page, (app) => app.editor.project.assets.map((a: any) => a.name))).toEqual(['葉っぱ']);
});
