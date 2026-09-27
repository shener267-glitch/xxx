import { expect, test } from '@playwright/test';
import { closeSheet, emptyGroundPoint, emptyPoint, enterNumber, entities, entity, entityByName, evalApp, longPress, openApp, reloadApp, screenPos, selection, stableBox, touchDrag, twoFinger, waitSheetClosed } from './helpers';

/**
 * Phase 1 の受け入れテスト (スマートフォン縦画面・タッチ操作)。
 * 各テストは新しいブラウザコンテキスト (保存データ無し) で実行される。
 */

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  await openApp(page, errors);
});

test.afterEach(() => {
  // WebGL のソフトウェア描画に関する警告以外のエラーが無いこと
  expect(errors.filter((e) => !/GPU stall|swiftshader|WebGL/i.test(e))).toEqual([]);
});

/** 追加ボタンから Cube を追加し、その ID を返す */
async function addCube(page: import('@playwright/test').Page): Promise<string> {
  await page.getByTestId('add').tap();
  await page.getByTestId('add-cube').tap();
  await expect(page.getByTestId('add-sheet')).toHaveCount(0);
  const [id] = await selection(page);
  expect(id).toBeTruthy();
  return id;
}

test('1-2. 起動して 3D ビューが表示される', async ({ page }) => {
  const canvas = page.locator('canvas.viewport-canvas');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  expect(box.width).toBeGreaterThan(300);
  expect(box.height).toBeGreaterThan(300);
  // 実際に WebGL で描画されている
  const calls = await evalApp(page, (app) => {
    app.viewport.renderNow();
    return app.engine.renderer.info.render.calls;
  });
  expect(calls).toBeGreaterThan(0);
  await expect(page.locator('#boot-screen')).toHaveCount(0);
  // 主要 UI
  for (const id of ['play', 'undo', 'redo', 'add', 'tool-translate', 'tab-scene', 'tab-inspector', 'tab-assets', 'tab-settings']) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  // サンプルシーン
  const list = await entities(page);
  expect(list.map((e) => e.name)).toEqual(expect.arrayContaining(['地面', '太陽光', 'メインカメラ', 'キューブ']));
});

test('3-4. Cube を追加し、タップで選択・選択解除できる', async ({ page }) => {
  const before = (await entities(page)).length;
  const id = await addCube(page);
  const list = await entities(page);
  expect(list).toHaveLength(before + 1);
  const cube = list.find((e) => e.id === id)!;
  expect(cube.kind).toBe('mesh');
  expect(cube.name).toBe('キューブ 2');
  await expect(page.getByTestId('context-bar')).toHaveClass(/show/);

  // 何もない所をタップ → 選択解除
  const empty = await emptyPoint(page);
  await page.touchscreen.tap(empty.x, empty.y);
  await expect.poll(() => selection(page)).toEqual([]);
  await expect(page.getByTestId('context-bar')).not.toHaveClass(/show/);

  // Cube をタップ → 選択
  const p = await screenPos(page, id);
  await page.touchscreen.tap(p.x, p.y);
  await expect.poll(() => selection(page)).toEqual([id]);
  await expect(page.getByTestId('ctx-name')).toContainText('キューブ 2');
});

test('5. 移動・回転・拡大縮小 (ドラッグ / ギズモ / 数値入力)', async ({ page }) => {
  const id = await addCube(page);
  const start = await entity(page, id);

  // (a) 選択中のオブジェクトを指でドラッグ → 地面に沿って移動
  const p = await screenPos(page, id);
  await touchDrag(page, p, { x: p.x + 70, y: p.y + 30 });
  const moved = await entity(page, id);
  expect(Math.hypot(moved.position[0] - start.position[0], moved.position[2] - start.position[2])).toBeGreaterThan(0.2);
  expect(moved.position[1]).toBeCloseTo(start.position[1], 3);
  // Undo で戻る
  await page.getByTestId('undo').tap();
  await expect.poll(async () => (await entity(page, id)).position).toEqual(start.position);

  // (b) ギズモの X 矢印をドラッグ → X だけ変化
  const handle = await evalApp(page, (app, eid) => {
    app.viewport.renderNow();
    const tc = app.viewport.gizmo.controls;
    const obj = app.viewport.getObject(eid);
    const origin = obj.getWorldPosition(obj.position.clone());
    const pickers = tc._gizmo.picker.translate.children.filter((c: any) => c.name === 'X');
    const cam = app.viewport.camera.camera;
    const rect = app.engine.canvas.getBoundingClientRect();
    const toScreen = (v: any) => {
      const q = v.clone().project(cam);
      return { x: rect.left + ((q.x + 1) / 2) * rect.width, y: rect.top + ((1 - q.y) / 2) * rect.height };
    };
    for (const pk of pickers) {
      pk.updateWorldMatrix(true, false);
      pk.geometry.computeBoundingBox();
      const c = pk.geometry.boundingBox.getCenter(origin.clone()).applyMatrix4(pk.matrixWorld);
      if (c.x > origin.x) {
        const tip = origin.clone();
        tip.x += 1;
        return { handle: toScreen(c), origin: toScreen(origin), tip: toScreen(tip) };
      }
    }
    return null;
  }, id);
  expect(handle).not.toBeNull();
  const h = handle!;
  const len = Math.hypot(h.tip.x - h.origin.x, h.tip.y - h.origin.y);
  const dir = { x: (h.tip.x - h.origin.x) / len, y: (h.tip.y - h.origin.y) / len };
  await touchDrag(page, h.handle, { x: h.handle.x + dir.x * 60, y: h.handle.y + dir.y * 60 });
  const g = await entity(page, id);
  expect(g.position[0]).toBeGreaterThan(start.position[0] + 0.2);
  expect(g.position[1]).toBeCloseTo(start.position[1], 3);
  expect(g.position[2]).toBeCloseTo(start.position[2], 3);

  // (c) Inspector の数値入力 (テンキー) で位置・回転・サイズ
  await page.getByTestId('tab-inspector').tap();
  await enterNumber(page, 'insp-position-x', '-3');
  await enterNumber(page, 'insp-rotation-y', '45');
  await enterNumber(page, 'insp-scale-x', '2');
  const t = await entity(page, id);
  expect(t.position[0]).toBe(-3);
  expect(t.rotation[1]).toBe(45);
  // 縦横比固定 (既定) なので全軸が 2 倍
  expect(t.scale).toEqual([2, 2, 2]);

  // (d) 回転ツールに切り替えるとギズモも回転モードになる
  // シートを開いている間はツールバーが隠れるので、選択中の操作バーで切り替える
  await page.getByTestId('ctx-tool-rotate').tap();
  expect(await evalApp(page, (app) => app.viewport.gizmo.controls.mode)).toBe('rotate');
  await expect(page.getByTestId('ctx-tool-rotate')).toHaveAttribute('aria-checked', 'true');
  // シートを閉じればツールバーでも切り替えられる
  await closeSheet(page);
  await page.getByTestId('tool-scale').tap();
  expect(await evalApp(page, (app) => app.viewport.gizmo.controls.mode)).toBe('scale');

  // Undo を重ねると元に戻る
  for (let i = 0; i < 4; i++) await page.getByTestId('undo').tap();
  const back = await entity(page, id);
  expect(back.rotation).toEqual([0, 0, 0]);
  expect(back.scale).toEqual([1, 1, 1]);
});

test('6. Scene と Inspector が機能する', async ({ page }) => {
  const id = await addCube(page);
  await page.getByTestId('tab-scene').tap();
  const row = page.getByTestId(`row-${id}`);
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/active/);

  // 名前変更 (行のメニューから)
  await page.getByTestId(`more-${id}`).tap();
  await page.getByTestId('menu-rename').tap();
  await page.getByTestId('prompt-input').fill('ドア');
  await page.getByTestId('prompt-ok').tap();
  await expect(row).toContainText('ドア');
  expect((await entity(page, id)).name).toBe('ドア');

  // 検索
  await page.getByTestId('scene-search').fill('ドア');
  await expect(page.locator('.tree-row')).toHaveCount(1);
  await page.getByTestId('scene-search').fill('');

  // 表示 / 非表示・ロック
  await page.getByTestId(`vis-${id}`).tap();
  expect((await entity(page, id)).visible).toBe(false);
  await page.getByTestId(`vis-${id}`).tap();
  expect((await entity(page, id)).visible).toBe(true);
  // ロックは行のメニューから。ロック中の行だけに鍵が出る
  await expect(page.getByTestId(`lock-${id}`)).toHaveCount(0);
  await page.getByTestId(`more-${id}`).tap();
  await page.getByTestId('menu-lock').tap();
  expect((await entity(page, id)).locked).toBe(true);
  await expect(page.getByTestId(`lock-${id}`)).toBeVisible();

  // ロック中は 3D ビューでタップしても選択されない
  await page.getByTestId('sheet-close').tap();
  const empty = await emptyPoint(page);
  await page.touchscreen.tap(empty.x, empty.y);
  const p = await screenPos(page, id);
  await page.touchscreen.tap(p.x, p.y);
  expect(await selection(page)).not.toContain(id);
  await page.getByTestId('tab-scene').tap();
  await page.getByTestId(`lock-${id}`).tap();
  expect((await entity(page, id)).locked).toBe(false);

  // 行をタップして選択 → Inspector に反映
  await page.getByTestId(`row-${id}`).tap();
  await page.getByTestId('tab-inspector').tap();
  await expect(page.getByTestId('insp-name')).toHaveValue('ドア');

  // Inspector で名前を変えると Scene 一覧にも反映
  await page.getByTestId('insp-name').fill('宝箱');
  await page.getByTestId('insp-name').press('Enter');
  await expect.poll(async () => (await entity(page, id)).name).toBe('宝箱');

  // 色 (HEX)
  await page.getByTestId('insp-color').tap();
  await page.getByTestId('color-hex').fill('#FF3366');
  await page.getByTestId('color-ok').tap();
  expect((await entity(page, id)).color).toBe('#ff3366');

  // 色 (RGB) — テンキーで R を 0 に
  await page.getByTestId('insp-color').tap();
  await page.getByTestId('color-r').locator('..').tap();
  await page.getByTestId('numpad').locator('[data-key="0"]').tap();
  await page.getByTestId('numpad-ok').tap();
  await page.getByTestId('color-ok').tap();
  expect((await entity(page, id)).color).toBe('#003366');

  // 複製・削除 (Inspector 下部のボタン)
  const count = (await entities(page)).length;
  await page.getByTestId('insp-duplicate').tap();
  expect((await entities(page)).length).toBe(count + 1);
  await page.getByTestId('insp-delete').tap();
  expect((await entities(page)).length).toBe(count);
});

test('6b. 複数選択・グループ化・親子関係・複数シーン', async ({ page }) => {
  const a = await addCube(page);
  const b = await addCube(page);
  // 複数選択モードでタップ追加
  await page.getByTestId('rail-multi').tap();
  await expect(page.getByTestId('multi-banner')).toHaveClass(/show/);
  const pa = await screenPos(page, a);
  await page.touchscreen.tap(pa.x, pa.y);
  await expect.poll(async () => (await selection(page)).sort()).toEqual([a, b].sort());
  await page.getByTestId('rail-multi').tap();

  // グループ化
  await page.getByTestId('ctx-more').tap();
  await page.getByTestId('menu-group').tap();
  // メニューの処理は閉じるアニメーションの次のフレームで実行される
  await expect.poll(async () => (await selection(page)).length).toBe(1);
  const [group] = await selection(page);
  const g = await entity(page, group);
  expect(g.children.sort()).toEqual([a, b].sort());
  expect((await entity(page, a)).parent).toBe(group);

  // 親をルートに戻す (親の変更)
  await page.getByTestId('tab-scene').tap();
  await page.getByTestId(`more-${a}`).tap();
  await page.getByTestId('menu-parent').tap();
  await page.getByTestId('parent-root').tap();
  expect((await entity(page, a)).parent).toBeNull();

  // コピー & ペースト
  const n = (await entities(page)).length;
  await page.getByTestId(`more-${a}`).tap();
  await page.getByTestId('menu-copy').tap();
  await page.getByTestId(`more-${a}`).tap();
  await page.getByTestId('menu-paste').tap();
  expect((await entities(page)).length).toBe(n + 1);

  // 新しいシーンを作って切り替え
  const firstScene = await evalApp(page, (app) => app.editor.sceneData.id);
  await page.getByTestId('scene-switch').tap();
  await page.getByTestId('scene-new').tap();
  const second = await evalApp(page, (app) => ({ id: app.editor.sceneData.id, count: app.editor.scene.count, scenes: app.editor.project.scenes.length }));
  expect(second.id).not.toBe(firstScene);
  expect(second.scenes).toBe(2);
  expect(second.count).toBe(4); // 地面・太陽光・環境光・カメラ
  await page.getByTestId('tb-title').tap();
  await page.getByTestId('scene-switcher').getByText('シーン1').tap();
  expect(await evalApp(page, (app) => app.editor.sceneData.id)).toBe(firstScene);
});

test('7. Play / Stop が機能し、停止で元に戻る', async ({ page }) => {
  const cube = (await entityByName(page, 'キューブ'))!;
  const player = (await entityByName(page, 'プレイヤー'))!;
  await page.getByTestId('play').tap();
  await expect(page.getByTestId('play-hud')).toBeVisible();
  await expect(page.getByTestId('tool-translate')).toBeHidden();
  expect(await evalApp(page, (app) => app.editor.mode)).toBe('play');

  // 自動回転コンポーネントが動いている (シェーダーの準備が終わって実行が始まってから測る)
  await expect.poll(() => evalApp(page, (app) => app.play.runtime.time), { timeout: 15_000 }).toBeGreaterThan(0.05);
  const rot0 = await evalApp(page, (app, id) => app.play.runtime.objects.get(id).rotation.y, cube.id);
  await expect
    .poll(async () => Math.abs((await evalApp(page, (app, id) => app.play.runtime.objects.get(id).rotation.y, cube.id)) - rot0), { timeout: 10_000 })
    .toBeGreaterThan(0.1);

  // 三人称: 画面左側のジョイスティックでプレイヤーを動かす
  await page.getByTestId('play-mode-thirdPerson').tap();
  const pos0 = await evalApp(page, (app, id) => app.play.runtime.objects.get(id).position.toArray(), player.id);
  const vp = (await page.getByTestId('viewport').boundingBox())!;
  const from = { x: vp.x + 80, y: vp.y + vp.height - 160 };
  const s = await page.context().newCDPSession(page);
  await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  await s.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x, y: from.y - 60, id: 1 }] });
  await page.waitForTimeout(700);
  await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const pos1 = await evalApp(page, (app, id) => app.play.runtime.objects.get(id).position.toArray(), player.id);
  expect(Math.hypot(pos1[0] - pos0[0], pos1[2] - pos0[2])).toBeGreaterThan(0.5);

  // 一人称
  await page.getByTestId('play-mode-firstPerson').tap();
  expect(await evalApp(page, (app) => app.play.runtime.cameraMode)).toBe('firstPerson');

  // 停止 → エディタに戻り、データは Play 前のまま
  await page.getByTestId('stop').tap();
  await expect(page.getByTestId('play-hud')).toBeHidden();
  await expect(page.getByTestId('tool-translate')).toBeVisible();
  expect(await evalApp(page, (app) => app.editor.mode)).toBe('edit');
  expect((await entity(page, player.id)).position).toEqual(player.position);
  expect((await entity(page, cube.id)).rotation).toEqual(cube.rotation);
});

test('8. 保存・読み込み (IndexedDB / ファイル書き出し・読み込み)', async ({ page }) => {
  const id = await addCube(page);
  await page.getByTestId('tab-inspector').tap();
  await page.getByTestId('insp-name').fill('セーブテスト');
  await page.getByTestId('insp-name').press('Enter');
  await enterNumber(page, 'insp-position-z', '2.5');
  await page.getByTestId('save').tap();
  await expect(page.getByTestId('save')).toHaveAttribute('data-state', 'saved');

  // 再読み込みしても残っている
  await reloadApp(page);
  const restored = await entityByName(page, 'セーブテスト');
  expect(restored).toBeTruthy();
  expect(restored!.id).toBe(id);
  expect(restored!.position[2]).toBe(2.5);

  // ゲーム名を変更してからファイルに書き出し
  // (ヘッドレス Chromium は日本語のダウンロード名を "download" にしてしまうため英字名で確認)
  await page.getByTestId('tab-settings').tap();
  await page.getByTestId('set-project-name').fill('MyGame');
  await page.getByTestId('set-project-name').press('Enter');
  await expect.poll(() => evalApp(page, (app) => app.editor.project.name)).toBe('MyGame');
  await page.getByTestId('main-menu').tap();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('menu-export').tap()]);
  expect(download.suggestedFilename()).toBe('MyGame.pocket.json');
  const path = await download.path();
  const fs = await import('node:fs');
  const json = JSON.parse(fs.readFileSync(path!, 'utf8'));
  expect(json.format).toBe('pocket-engine-project');
  expect(json.name).toBe('MyGame');

  // 別のプロジェクトを作ってから、書き出したファイルを読み込む
  await page.getByTestId('main-menu').tap();
  await page.getByTestId('menu-projects').tap();
  await page.getByTestId('project-new').tap();
  await page.getByTestId('prompt-input').fill('別のゲーム');
  await page.getByTestId('prompt-ok').tap();
  await expect.poll(() => evalApp(page, (app) => app.editor.project.name)).toBe('別のゲーム');
  expect(await entityByName(page, 'セーブテスト')).toBeUndefined();

  await page.getByTestId('main-menu').tap();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByText('プロジェクトを読み込み').tap()]);
  await chooser.setFiles({ name: 'game.pocket.json', mimeType: 'application/json', buffer: fs.readFileSync(path!) });
  await expect.poll(async () => (await entityByName(page, 'セーブテスト'))?.position[2]).toBe(2.5);

  // プロジェクト一覧に 3 つある (元・別・読み込み)
  await page.getByTestId('main-menu').tap();
  await page.getByTestId('menu-projects').tap();
  await expect(page.locator('.project-card')).toHaveCount(3);
});

test('9. Undo / Redo', async ({ page }) => {
  const before = (await entities(page)).length;
  const id = await addCube(page);
  await expect(page.getByTestId('undo')).toBeEnabled();
  await page.getByTestId('undo').tap();
  expect((await entities(page)).length).toBe(before);
  await expect(page.getByTestId('redo')).toBeEnabled();
  await page.getByTestId('redo').tap();
  expect((await entities(page)).map((e) => e.id)).toContain(id);
  expect(await selection(page)).toEqual([id]);
  // 削除も元に戻せる
  await page.getByTestId('ctx-delete').tap();
  expect((await entities(page)).map((e) => e.id)).not.toContain(id);
  await page.getByTestId('undo').tap();
  expect((await entities(page)).map((e) => e.id)).toContain(id);
});

test('10. スマホ縦画面のレイアウトとタッチ操作', async ({ page }) => {
  const vw = page.viewportSize()!;
  expect(vw.height).toBeGreaterThan(vw.width);
  // 横スクロールが発生しない
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // 主要ボタンは指で押せる大きさ
  for (const id of ['tool-select', 'tool-translate', 'tool-rotate', 'tool-scale', 'add', 'play', 'undo', 'tab-scene']) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.height, id).toBeGreaterThanOrEqual(38);
    expect(b.width, id).toBeGreaterThanOrEqual(38);
    expect(b.x + b.width, id).toBeLessThanOrEqual(vw.width + 0.5);
  }

  // ボトムシート: タブで半分 → ハンドルを上にドラッグで全画面 → 下にドラッグで閉じる
  await page.getByTestId('tab-scene').tap();
  await expect(page.getByTestId('sheet')).toHaveAttribute('data-state', 'half');
  const hb = await stableBox(page, 'sheet-handle');
  const grab = { x: hb.x + 40, y: hb.y + 8 };
  await touchDrag(page, grab, { x: grab.x, y: grab.y - 260 });
  await expect(page.getByTestId('sheet')).toHaveAttribute('data-state', 'full');
  const hb2 = await stableBox(page, 'sheet-handle');
  await touchDrag(page, { x: hb2.x + 40, y: hb2.y + 8 }, { x: hb2.x + 40, y: hb2.y + 700 });
  await waitSheetClosed(page);

  // 1本指ドラッグ (何もない所) → カメラ回転
  const cam0 = await evalApp(page, (app) => app.viewport.camera.getState());
  const e = await emptyPoint(page);
  await touchDrag(page, e, { x: e.x + 80, y: e.y });
  const cam1 = await evalApp(page, (app) => app.viewport.camera.getState());
  expect(Math.abs(cam1.yaw - cam0.yaw)).toBeGreaterThan(5);

  // ピンチ → ズーム
  const vp = (await page.getByTestId('viewport').boundingBox())!;
  const c = { x: vp.x + vp.width / 2, y: vp.y + vp.height / 2 };
  await twoFinger(
    page,
    [{ x: c.x - 40, y: c.y }, { x: c.x - 120, y: c.y }],
    [{ x: c.x + 40, y: c.y }, { x: c.x + 120, y: c.y }],
  );
  const cam2 = await evalApp(page, (app) => app.viewport.camera.getState());
  expect(cam2.distance).toBeLessThan(cam1.distance * 0.7);

  // 2本指ドラッグ → 平行移動
  await twoFinger(
    page,
    [{ x: c.x - 40, y: c.y }, { x: c.x - 40, y: c.y + 90 }],
    [{ x: c.x + 40, y: c.y }, { x: c.x + 40, y: c.y + 90 }],
  );
  const cam3 = await evalApp(page, (app) => app.viewport.camera.getState());
  const moved = Math.hypot(cam3.target[0] - cam2.target[0], cam3.target[1] - cam2.target[1], cam3.target[2] - cam2.target[2]);
  expect(moved).toBeGreaterThan(0.2);

  // カメラ位置の保存
  await page.getByTestId('rail-camera').tap();
  await page.getByTestId('cam-save').tap();
  await page.getByTestId('prompt-ok').tap();
  expect(await evalApp(page, (app) => app.editor.sceneData.bookmarks.length)).toBe(1);

  // 長押し (何もない所) → その場所に追加するシート
  await longPress(page, await emptyGroundPoint(page));
  await expect(page.getByTestId('add-sheet')).toBeVisible();
  await page.getByTestId('add-sphere').tap();
  const [sid] = await selection(page);
  expect((await entity(page, sid)).kind).toBe('mesh');

  // 長押し (オブジェクト) → オブジェクトのメニュー
  const sp = await screenPos(page, sid);
  await longPress(page, sp);
  await expect(page.getByTestId('entity-menu')).toBeVisible();
});
