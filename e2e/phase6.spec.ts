import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { makeTestGlb } from '../tests/fixtures/glb';
import { closeSheet, enterNumber, evalApp, openApp, stableBox, touchDrag } from './helpers';

/**
 * Phase 6: アセット (3D モデル・画像・音声)・フォルダ・検索・部品 (Prefab)・大量配置
 */

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  await openApp(page, errors);
});

test.afterEach(() => {
  expect(errors.filter((e) => !/GPU stall|swiftshader|WebGL/i.test(e))).toEqual([]);
});

interface FilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

const glbFile = (name = 'ロボット.glb'): FilePayload => ({ name, mimeType: 'model/gltf-binary', buffer: Buffer.from(makeTestGlb()) });

/** 無音の短い WAV (0.5 秒) */
function wavFile(name: string): FilePayload {
  const rate = 8000;
  const samples = rate / 2;
  const buf = Buffer.alloc(44 + samples);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples, 40);
  buf.fill(128, 44);
  return { name, mimeType: 'audio/wav', buffer: buf };
}

/** 横長 (2:1) の PNG をブラウザの canvas で作る */
async function pngFile(page: Page, name: string): Promise<FilePayload> {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 32;
    const g = c.getContext('2d')!;
    g.fillStyle = '#3cb371';
    g.fillRect(0, 0, 64, 32);
    g.fillStyle = '#fff';
    g.fillRect(8, 8, 16, 16);
    return c.toDataURL('image/png').split(',')[1];
  });
  return { name, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') };
}

/** アセットタブを開く (既に開いていれば何もしない。開いているタブを押すと閉じるため) */
async function openAssets(page: Page): Promise<void> {
  const open = (await page.getByTestId('sheet').getAttribute('data-state')) !== 'closed' && (await page.getByTestId('assets-panel').isVisible());
  if (!open) await page.getByTestId('tab-assets').tap();
  await expect(page.getByTestId('assets-panel')).toBeVisible();
  await stableBox(page, 'sheet');
}

/** 「読み込む」ボタンからファイルを取り込む */
async function importFiles(page: Page, files: FilePayload[]): Promise<void> {
  const before = await evalApp(page, (app) => app.editor.project.assets.length);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('asset-import').tap()]);
  await chooser.setFiles(files);
  await expect.poll(() => evalApp(page, (app) => app.editor.project.assets.length), { timeout: 20_000 }).toBe(before + files.length);
}

const assetByName = (page: Page, name: string) =>
  evalApp(page, (app, n) => {
    const a = app.editor.project.assets.find((x: any) => x.name === n);
    return a ? { id: a.id as string, type: a.type as string, folder: a.folder as string, info: a.info, thumb: !!a.thumb } : null;
  }, name);

const selected = (page: Page) => evalApp(page, (app) => app.editor.selection.active as string);

const countKind = (page: Page, kind: string) =>
  evalApp(page, (app, k) => (Object.values(app.editor.sceneData.entities) as any[]).filter((e) => e.kind === k).length, kind);

test('3D モデル: GLB を読み込み、詳細を確認して置き、Play でアニメーションする', async ({ page }) => {
  await openAssets(page);
  await importFiles(page, [glbFile()]);
  const asset = await assetByName(page, 'ロボット');
  expect(asset).toMatchObject({ type: 'model', folder: '', thumb: true, info: { modelSize: [1, 2, 1], animations: ['Idle', 'Walk'], triangles: 12 } });
  await expect(page.getByTestId('asset-card-ロボット').locator('img')).toHaveCount(1);

  // 詳細: 情報とプレビュー
  await page.getByTestId('asset-card-ロボット').tap();
  const detail = page.getByTestId('asset-detail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('Idle、Walk');
  await expect(detail).toContainText('1.00 × 2.00 × 1.00 m');
  await page.getByTestId('asset-place').tap();
  await expect(detail).toHaveCount(0);

  // 置いたモデル (底が地面の上・選択される・ミニ画像は非同期で読み込まれる)
  const id = await selected(page);
  const e = await evalApp(page, (app, i) => app.editor.scene.get(i), id);
  expect(e.kind).toBe('model');
  expect(e.model.asset).toBe(asset!.id);
  expect(e.model.size).toEqual([1, 2, 1]);
  expect(e.transform.position[1]).toBeCloseTo(0, 5);
  await expect.poll(() => evalApp(page, (app, i) => !!app.viewport.bridge.get(i)?.userData.content?.userData.loaded && !!app.viewport.bridge.get(i).userData.content.getObjectByProperty('isMesh', true), id), { timeout: 15_000 }).toBe(true);
  expect(await detailUsage(page, 'ロボット')).toBe('1 か所');

  // Inspector でアニメーションを選ぶ
  await page.getByTestId('tab-inspector').tap();
  await page.getByTestId('model-animation').scrollIntoViewIfNeeded();
  await page.getByTestId('model-animation').selectOption('Walk');
  expect(await evalApp(page, (app, i) => app.editor.scene.get(i).model.animation, id)).toBe('Walk');
  await closeSheet(page);

  // Play: モデルが読み込まれ、アニメーションが再生される
  await page.getByTestId('play').tap();
  await expect(page.getByTestId('play-hud')).toBeVisible();
  await expect.poll(() => evalApp(page, (app, i) => app.play.runtime?.getController(i, 'modelAnim')?.current ?? null, id), { timeout: 20_000 }).toBe('Walk');
  const moving = await evalApp(page, (app, i) => {
    const r = app.play.runtime;
    const obj = r.objects.get(i);
    let mesh: any = null;
    obj.traverse((o: any) => {
      if (o.isMesh && !mesh) mesh = o;
    });
    return mesh ? mesh.position.x : null;
  }, id);
  expect(moving).not.toBeNull();
  await page.getByTestId('stop').tap();
  await expect(page.getByTestId('play-hud')).toBeHidden();

  // 保存して開き直してもモデルが表示される
  await page.getByTestId('save').tap();
  await expect(page.getByTestId('save')).toHaveAttribute('data-state', 'saved');
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__pocket);
  await expect.poll(() => evalApp(page, (app, i) => !!app.viewport.bridge.get(i)?.userData.content?.userData.loaded, id), { timeout: 15_000 }).toBe(true);
});

/** 詳細画面の「使用数」 */
async function detailUsage(page: Page, name: string): Promise<string> {
  await openAssets(page);
  await page.getByTestId(`asset-card-${name}`).tap();
  const row = page.getByTestId('asset-detail').locator('.asset-info-row', { hasText: '使用数' });
  const text = (await row.locator('b').textContent()) ?? '';
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('asset-detail')).toHaveCount(0);
  return text;
}

test('アセット画面: 画像・音声の読み込み、絞り込み・検索・フォルダ・名前変更・削除', async ({ page }) => {
  await openAssets(page);
  await importFiles(page, [await pngFile(page, '看板.png'), wavFile('ボタン音.wav'), glbFile('木.glb')]);
  expect(await assetByName(page, '看板')).toMatchObject({ type: 'image', info: { width: 64, height: 32 }, thumb: true });
  const snd = await assetByName(page, 'ボタン音');
  expect(snd?.type).toBe('audio');
  expect(snd?.info.duration).toBeCloseTo(0.5, 1);

  // 種類で絞り込み
  await page.getByTestId('asset-filter-image').tap();
  await expect(page.getByTestId('asset-grid').locator('.asset-card')).toHaveCount(1);
  await expect(page.getByTestId('asset-card-看板')).toBeVisible();
  await page.getByTestId('asset-filter-audio').tap();
  await expect(page.getByTestId('asset-card-ボタン音')).toBeVisible();
  await expect(page.getByTestId('asset-card-看板')).toHaveCount(0);
  await page.getByTestId('asset-filter-all').tap();
  await expect(page.getByTestId('asset-grid').locator('.asset-card')).toHaveCount(3);

  // 検索
  await page.getByTestId('asset-search').fill('看');
  await expect(page.getByTestId('asset-grid').locator('.asset-card')).toHaveCount(1);
  await page.getByTestId('asset-search').fill('ない名前');
  await expect(page.getByTestId('asset-grid').locator('.asset-card')).toHaveCount(0);
  await expect(page.getByTestId('assets-panel')).toContainText('一致するものはありません');
  await page.getByTestId('asset-search').fill('');

  // フォルダを作る → 中は空
  await page.getByTestId('asset-new-folder').tap();
  await page.getByTestId('prompt-input').fill('背景');
  await page.getByTestId('prompt-ok').tap();
  await expect(page.getByTestId('asset-breadcrumb')).toContainText('背景');
  await expect(page.getByTestId('asset-grid').locator('.asset-card')).toHaveCount(0);
  await page.getByTestId('asset-crumb-root').tap();
  await expect(page.getByTestId('asset-folder-背景')).toBeVisible();

  // 画像をフォルダへ移動
  await page.getByTestId('asset-card-看板').tap();
  await page.getByTestId('asset-move').tap();
  await page.getByTestId('folder-pick-背景').tap();
  await expect(page.getByTestId('asset-detail')).toHaveCount(0);
  expect((await assetByName(page, '看板'))?.folder).toBe('背景');
  await expect(page.getByTestId('asset-card-看板')).toHaveCount(0);
  await page.getByTestId('asset-folder-背景').tap();
  await expect(page.getByTestId('asset-card-看板')).toBeVisible();
  // 検索はフォルダをまたいで探す
  await page.getByTestId('asset-crumb-root').tap();
  await page.getByTestId('asset-search').fill('看板');
  await expect(page.getByTestId('asset-card-看板')).toBeVisible();
  await page.getByTestId('asset-search').fill('');

  // 画像を置く → 板 (縦横比 2:1)
  await page.getByTestId('asset-folder-背景').tap();
  await page.getByTestId('asset-card-看板').tap();
  await page.getByTestId('asset-place').tap();
  const board = await selected(page);
  const b = await evalApp(page, (app, i) => app.editor.scene.get(i), board);
  expect(b.kind).toBe('mesh');
  expect(b.mesh.material.texture).toBe((await assetByName(page, '看板'))!.id);
  expect(b.transform.scale[0] / b.transform.scale[2]).toBeCloseTo(2, 1);

  // 音声を置く → 効果音のオブジェクト
  await openAssets(page);
  await page.getByTestId('asset-crumb-root').tap();
  await page.getByTestId('asset-card-ボタン音').tap();
  await page.getByTestId('asset-place').tap();
  const sid = await selected(page);
  expect(await evalApp(page, (app, i) => app.editor.scene.get(i).components.find((c: any) => c.type === 'sound')?.props.sound, sid)).toBe(snd!.id);

  // 名前を変更
  await openAssets(page);
  await page.getByTestId('asset-card-木').tap();
  await page.getByTestId('asset-rename').tap();
  await page.getByTestId('prompt-input').fill('大きな木');
  await page.getByTestId('prompt-ok').tap();
  await expect(page.getByTestId('asset-card-大きな木')).toBeVisible();

  // 使っている画像を削除 → 確認 → 参照が外れる
  await page.getByTestId('asset-folder-背景').tap();
  await page.getByTestId('asset-card-看板').tap();
  await expect(page.getByTestId('asset-detail')).toContainText('1 か所');
  await page.getByTestId('asset-delete').tap();
  await expect(page.getByTestId('confirm-ok')).toBeVisible();
  await expect(page.locator('.modal').last()).toContainText('1 か所');
  await page.getByTestId('confirm-ok').tap();
  await expect.poll(() => assetByName(page, '看板')).toBeNull();
  expect(await evalApp(page, (app, i) => app.editor.scene.get(i).mesh.material.texture, board)).toBeNull();

  // 空になったフォルダを削除
  await expect(page.getByTestId('asset-breadcrumb')).toContainText('背景');
  await page.getByTestId('asset-folder-menu').tap();
  await page.getByTestId('asset-folder-delete').tap();
  await page.getByTestId('confirm-ok').tap();
  await expect(page.getByTestId('asset-folder-背景')).toHaveCount(0);
  expect(await evalApp(page, (app) => app.editor.project.assetFolders)).toEqual([]);
});

test('部品 (Prefab): 作成・置く・複製・反映・並べて置く・削除', async ({ page }) => {
  // 立方体を置いて色を変え、部品にする
  await page.getByTestId('add').tap();
  await page.getByTestId('add-cube').tap();
  const cube = await selected(page);
  await evalApp(page, (app, i) => {
    const e = app.editor.scene.get(i);
    app.editor.scene.applyProps(i, { mesh: { ...e.mesh, material: { ...e.mesh.material, color: '#ff0000' } } });
  }, cube);
  await page.getByTestId('ctx-more').tap();
  await page.getByTestId('menu-prefab').tap();
  await page.getByTestId('prompt-input').fill('赤い箱');
  await page.getByTestId('prompt-ok').tap();
  await expect.poll(() => evalApp(page, (app) => app.editor.project.prefabs.map((p: any) => p.name))).toEqual(['赤い箱']);
  const pf = await evalApp(page, (app) => ({ id: app.editor.project.prefabs[0].id, thumb: !!app.editor.project.prefabs[0].thumb }));
  expect(pf.thumb).toBe(true);
  // 元のオブジェクトは部品とつながる
  expect(await evalApp(page, (app, i) => app.editor.scene.get(i).prefab, cube)).toBe(pf.id);

  // アセットタブの「部品」から置く
  await openAssets(page);
  await page.getByTestId('asset-filter-prefab').tap();
  await expect(page.getByTestId('asset-grid').locator('.asset-card')).toHaveCount(1);
  await page.getByTestId('asset-card-赤い箱').tap();
  await expect(page.getByTestId('prefab-detail')).toContainText('1 個');
  await page.getByTestId('prefab-place').tap();
  const placed = await selected(page);
  expect(placed).not.toBe(cube);
  const pe = await evalApp(page, (app, i) => app.editor.scene.get(i), placed);
  expect(pe.prefab).toBe(pf.id);
  expect(pe.name).toBe('赤い箱');
  expect(pe.mesh.material.color).toBe('#ff0000');

  // 取り消し / やり直し
  await page.getByTestId('undo').tap();
  expect(await evalApp(page, (app, i) => !!app.editor.scene.get(i), placed)).toBe(false);
  await page.getByTestId('redo').tap();
  expect(await evalApp(page, (app, i) => !!app.editor.scene.get(i), placed)).toBe(true);

  // 元のオブジェクトを青くして「部品に反映」
  await evalApp(page, (app, i) => {
    app.editor.selection.set([i]);
    const e = app.editor.scene.get(i);
    app.editor.scene.applyProps(i, { mesh: { ...e.mesh, material: { ...e.mesh.material, color: '#0000ff' } } });
  }, cube);
  await closeSheet(page);
  await page.getByTestId('ctx-more').tap();
  await page.getByTestId('menu-prefab-update').tap();
  expect(await evalApp(page, (app) => {
    const p = app.editor.project.prefabs[0];
    return p.entities[p.root].mesh.material.color;
  })).toBe('#0000ff');

  // 複製
  await openAssets(page);
  await page.getByTestId('asset-filter-prefab').tap();
  await page.getByTestId('asset-card-赤い箱').tap();
  await page.getByTestId('prefab-duplicate').tap();
  await expect(page.getByTestId('asset-card-赤い箱 コピー')).toBeVisible();
  expect(await evalApp(page, (app) => app.editor.project.prefabs.length)).toBe(2);

  // 並べて置く: 格子 3 × 4 → 12 個をグループにまとめる
  await page.getByTestId('asset-card-赤い箱').tap();
  await page.getByTestId('prefab-scatter').tap();
  await expect(page.getByTestId('scatter-modal')).toBeVisible();
  await page.getByTestId('scatter-pattern').selectOption('grid');
  await enterNumber(page, 'scatter-rows', '3');
  await enterNumber(page, 'scatter-cols', '4');
  await expect(page.getByTestId('scatter-summary')).toContainText('12 個');
  const before = await countKind(page, 'mesh');
  await page.getByTestId('scatter-ok').tap();
  await expect(page.getByTestId('scatter-modal')).toHaveCount(0);
  await expect.poll(() => countKind(page, 'mesh')).toBe(before + 12);
  const group = await selected(page);
  const g = await evalApp(page, (app, i) => {
    const e = app.editor.scene.get(i);
    return { kind: e.kind, name: e.name, children: e.children.map((c: string) => app.editor.scene.get(c).prefab) };
  }, group);
  expect(g.kind).toBe('empty');
  expect(g.name).toBe('赤い箱 (12)');
  expect(g.children).toEqual(Array(12).fill(pf.id));
  // 1 回の取り消しで全部消える
  await page.getByTestId('undo').tap();
  await expect.poll(() => countKind(page, 'mesh')).toBe(before);
  await page.getByTestId('redo').tap();
  await expect.poll(() => countKind(page, 'mesh')).toBe(before + 12);

  // 円形に 8 個 (オブジェクトのメニューから、グループにしない)
  await evalApp(page, (app, i) => app.editor.selection.set([i]), cube);
  await page.getByTestId('ctx-more').tap();
  await page.getByTestId('menu-scatter').tap();
  await page.getByTestId('scatter-pattern').selectOption('circle');
  await enterNumber(page, 'scatter-count', '8');
  await expect(page.getByTestId('scatter-summary')).toContainText('8 個');
  await page.getByTestId('scatter-group').tap();
  await page.getByTestId('scatter-ok').tap();
  await expect.poll(() => countKind(page, 'mesh')).toBe(before + 20);
  expect(await evalApp(page, (app) => app.editor.selection.ids.length)).toBe(8);

  // 部品を削除しても、置いたオブジェクトは残る
  await openAssets(page);
  await page.getByTestId('asset-filter-prefab').tap();
  await page.getByTestId('asset-card-赤い箱 コピー').tap();
  await page.getByTestId('prefab-delete').tap();
  await page.getByTestId('confirm-ok').tap();
  await expect(page.getByTestId('asset-card-赤い箱 コピー')).toHaveCount(0);
  expect(await evalApp(page, (app) => app.editor.project.prefabs.map((p: any) => p.name))).toEqual(['赤い箱']);
  expect(await countKind(page, 'mesh')).toBe(before + 20);
});

test('ドラッグして置く: カードのつまみを 3D ビューへドラッグすると指の位置に置かれる', async ({ page }) => {
  await openAssets(page);
  await importFiles(page, [glbFile('岩.glb')]);
  const handle = await stableBox(page, 'asset-drag-岩');
  const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  const vp = await page.getByTestId('viewport').boundingBox();
  const to = { x: vp!.x + vp!.width * 0.5, y: vp!.y + 150 };
  const before = await countKind(page, 'model');
  await touchDrag(page, from, to, 16);
  await expect.poll(() => countKind(page, 'model')).toBe(before + 1);
  // シートは閉じ、置いたモデルが選択される
  await expect(page.getByTestId('sheet')).toHaveAttribute('data-state', 'closed');
  const id = await selected(page);
  const pos = await evalApp(page, (app, i) => app.editor.scene.get(i).transform.position, id);
  const expected = await evalApp(page, (app, p) => app.viewport.groundPointAt(p.x, p.y), to);
  expect(pos[0]).toBeCloseTo(expected.x, 0);
  expect(pos[2]).toBeCloseTo(expected.z, 0);
  await expect(page.getByTestId('drag-ghost')).toHaveCount(0);

  // シートの上で離したら置かない
  await openAssets(page);
  const h2 = await stableBox(page, 'asset-drag-岩');
  await touchDrag(page, { x: h2.x + h2.width / 2, y: h2.y + h2.height / 2 }, { x: h2.x - 60, y: h2.y + 20 }, 10);
  await page.waitForTimeout(200);
  expect(await countKind(page, 'model')).toBe(before + 1);
});
