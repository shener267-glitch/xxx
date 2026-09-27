import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { enterNumber, entity, evalApp, openApp, reloadApp, selection } from './helpers';

/**
 * Phase 2: マテリアル・ライティング・物理
 */

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  await openApp(page, errors);
});

test.afterEach(() => {
  expect(errors.filter((e) => !/GPU stall|swiftshader|WebGL/i.test(e))).toEqual([]);
});

async function addCube(page: Page): Promise<string> {
  await page.getByTestId('add').tap();
  await page.getByTestId('add-cube').tap();
  await expect(page.getByTestId('add-sheet')).toHaveCount(0);
  return (await selection(page))[0];
}

async function material(page: Page, id: string) {
  return evalApp(page, (app, eid) => ({ ...app.editor.scene.get(eid).mesh.material }), id);
}

/** 小さな PNG 画像を作る */
async function makePng(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 8, 8);
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(8, 8, 8, 8);
    return c.toDataURL('image/png').split(',')[1];
  });
  return Buffer.from(b64, 'base64');
}

async function openSection(page: Page, testId: string): Promise<void> {
  const sec = page.getByTestId(testId);
  if (await sec.evaluate((el) => el.classList.contains('collapsed'))) await sec.locator('.section-toggle').tap();
}

test('マテリアルのプリセット・模様・UV', async ({ page }) => {
  const id = await addCube(page);
  await page.getByTestId('tab-inspector').tap();
  await page.getByTestId('insp-preset').selectOption('metal');
  let m = await material(page, id);
  expect(m.preset).toBe('metal');
  expect(m.metalness).toBe(1);
  // プリセットは1回の Undo で戻る
  await page.getByTestId('undo').tap();
  m = await material(page, id);
  expect(m.preset).toBe('standard');
  expect(m.metalness).toBe(0);

  await page.getByTestId('insp-preset').selectOption('wood');
  m = await material(page, id);
  expect(m.pattern).toBe('wood');
  await page.getByTestId('insp-pattern').selectOption('brick');
  expect((await material(page, id)).pattern).toBe('brick');

  await openSection(page, 'sec-uv');
  await enterNumber(page, 'insp-uvScale-u', '4');
  await enterNumber(page, 'insp-uvScale-v', '2');
  expect((await material(page, id)).uvScale).toEqual([4, 2]);

  // ガラス・水も作成できる (描画エラーが出ない)
  await page.getByTestId('insp-preset').selectOption('glass');
  expect((await material(page, id)).opacity).toBeLessThan(1);
  await page.getByTestId('insp-preset').selectOption('water');
  expect((await material(page, id)).preset).toBe('water');
  await evalApp(page, (app) => app.viewport.renderNow());
});

test('画像テクスチャの読み込みと保存', async ({ page }) => {
  const id = await addCube(page);
  await page.getByTestId('tab-inspector').tap();
  await page.getByTestId('insp-texture').tap();
  const png = await makePng(page);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('tex-import').tap()]);
  await chooser.setFiles({ name: 'checker.png', mimeType: 'image/png', buffer: png });
  await expect.poll(async () => (await material(page, id)).texture).not.toBeNull();
  const assets = await evalApp(page, (app) => app.editor.project.assets);
  expect(assets).toHaveLength(1);
  expect(assets[0]).toMatchObject({ type: 'image', name: 'checker' });
  await expect(page.getByTestId('insp-texture')).toContainText('checker');

  // 保存して再読み込みしても画像が残っている (IndexedDB)
  await page.getByTestId('save').tap();
  await expect(page.getByTestId('save')).toHaveAttribute('data-state', 'saved');
  await reloadApp(page);
  const texId = (await material(page, id)).texture;
  expect(texId).toBe(assets[0].id);
  const size = await evalApp(page, async (app, aid) => (await app.assets.getBlob(aid))?.size ?? 0, texId);
  expect(size).toBeGreaterThan(0);

  // アセットを埋め込んだプロジェクトを書き出し → 別プロジェクトとして読み込み
  const text = await evalApp(page, (app) => app.projects.exportProjectText());
  expect(text).toContain('embeddedAssets');
  const imported = await evalApp(page, async (app, t) => {
    const p = await app.projects.importProjectText(t);
    return { id: p.id, assets: p.assets.length };
  }, text);
  expect(imported.assets).toBe(1);
  const size2 = await evalApp(page, async (app, aid) => (await app.assets.getBlob(aid))?.size ?? 0, texId);
  expect(size2).toBe(size);

  // テクスチャを外す
  await page.evaluate((eid) => (window as unknown as { __pocket: { editor: { selection: { set(ids: string[]): void } } } }).__pocket.editor.selection.set([eid]), id);
  await page.getByTestId('tab-inspector').tap();
  await page.getByTestId('insp-texture').tap();
  await page.getByTestId('tex-clear').tap();
  expect((await material(page, id)).texture).toBeNull();
});

test('空・霧・天候・露出の設定', async ({ page }) => {
  await page.getByTestId('tab-inspector').tap();
  const env = () => evalApp(page, (app) => JSON.parse(JSON.stringify(app.editor.sceneData.environment)));
  await page.getByTestId('env-sky').selectOption('physical');
  expect((await env()).sky.type).toBe('physical');
  await page.getByTestId('env-sky').selectOption('color');
  expect((await env()).sky.type).toBe('color');
  await page.getByTestId('undo').tap();
  expect((await env()).sky.type).toBe('physical');

  await openSection(page, 'sec-fog');
  await page.getByTestId('env-fog').tap();
  expect((await env()).fog.enabled).toBe(true);
  await openSection(page, 'sec-weather');
  await page.getByTestId('env-weather').selectOption('snow');
  expect((await env()).weather.type).toBe('snow');
  expect(await evalApp(page, (app) => !!app.viewport.scene.fog)).toBe(true);

  // Play で天候が表示される
  await page.getByTestId('play').tap();
  await expect(page.getByTestId('play-hud')).toBeVisible();
  await page.waitForTimeout(500);
  expect(await evalApp(page, (app) => !!app.play.runtime.scene.getObjectByName('__weather'))).toBe(true);
  await page.getByTestId('stop').tap();
  await expect(page.getByTestId('play-hud')).toBeHidden();
});

test('物理: Rigidbody で落下し、Stop で元に戻る', async ({ page }) => {
  const id = await addCube(page);
  await page.getByTestId('tab-inspector').tap();
  await enterNumber(page, 'insp-position-y', '4');
  await page.getByTestId('insp-add-component').scrollIntoViewIfNeeded();
  await page.getByTestId('insp-add-component').tap();
  await page.getByTestId('add-comp-rigidbody').tap();
  await expect(page.getByTestId('comp-rigidbody')).toBeVisible();

  // 地面に当たり判定を付ける
  const ground = await evalApp(page, (app) => (Object.values(app.editor.sceneData.entities) as any[]).find((e) => e.name === '地面').id);
  await page.evaluate((g) => (window as unknown as { __pocket: { editor: { selection: { set(ids: string[]): void } } } }).__pocket.editor.selection.set([g]), ground);
  await expect(page.getByTestId('insp-name')).toHaveValue('地面');
  await page.getByTestId('insp-add-component').scrollIntoViewIfNeeded();
  await page.getByTestId('insp-add-component').tap();
  await page.getByTestId('add-comp-collider').tap();
  await expect(page.getByTestId('comp-collider')).toBeVisible();

  await page.getByTestId('play').tap();
  await expect.poll(() => evalApp(page, (app) => !!app.play.runtime?.physics), { timeout: 15_000 }).toBe(true);
  await expect
    .poll(() => evalApp(page, (app, eid) => app.play.runtime.objects.get(eid).position.y, id), { timeout: 15_000 })
    .toBeLessThan(0.7);
  const y = await evalApp(page, (app, eid) => app.play.runtime.objects.get(eid).position.y, id);
  expect(y).toBeGreaterThan(0.3);
  await page.getByTestId('stop').tap();
  expect((await entity(page, id)).position[1]).toBe(4);
});

test('物理 OFF と重力設定', async ({ page }) => {
  const id = await addCube(page);
  await page.getByTestId('tab-inspector').tap();
  await enterNumber(page, 'insp-position-y', '3');
  await page.getByTestId('insp-add-component').scrollIntoViewIfNeeded();
  await page.getByTestId('insp-add-component').tap();
  await page.getByTestId('add-comp-rigidbody').tap();
  // シーン設定で物理を OFF → 落ちない
  await page.evaluate(() => (window as unknown as { __pocket: { editor: { selection: { clear(): void } } } }).__pocket.editor.selection.clear());
  await openSection(page, 'sec-physics');
  await page.getByTestId('phys-enabled').tap();
  expect(await evalApp(page, (app) => app.editor.sceneData.physics.enabled)).toBe(false);
  await page.getByTestId('play').tap();
  await page.waitForTimeout(800);
  expect(await evalApp(page, (app, eid) => app.play.runtime.objects.get(eid).position.y, id)).toBe(3);
  expect(await evalApp(page, (app) => app.play.runtime.physics)).toBeNull();
  await page.getByTestId('stop').tap();

  // 物理 ON・重力を上向きに → 上へ飛んでいく
  await page.getByTestId('phys-enabled').tap();
  await enterNumber(page, 'phys-gravity-y', '5');
  expect(await evalApp(page, (app) => app.editor.sceneData.physics.gravity)).toEqual([0, 5, 0]);
  await page.getByTestId('play').tap();
  await expect
    .poll(() => evalApp(page, (app, eid) => app.play.runtime?.objects.get(eid).position.y ?? 0, id), { timeout: 15_000 })
    .toBeGreaterThan(3.5);
  await page.getByTestId('stop').tap();
});
