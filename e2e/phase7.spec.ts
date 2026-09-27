import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { closeSheet, enterNumber, evalApp, openApp, openSection, waitSheetClosed } from './helpers';

/**
 * Phase 7: 地形・昼夜・空・雲・雷・ポストエフェクト
 */

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  await openApp(page, errors);
});

test.afterEach(() => {
  expect(errors.filter((e) => !/GPU stall|swiftshader|WebGL|KHR_parallel/i.test(e))).toEqual([]);
});

const maxHeight = (page: Page, id: string) => evalApp(page, (app, i) => Math.max(...app.editor.scene.get(i).terrain.heights), id);

/** 範囲入力 (スライダー) の値を変える */
async function setRange(page: Page, testId: string, value: number): Promise<void> {
  await page.getByTestId(testId).evaluate((el, v) => {
    const input = el as HTMLInputElement;
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/** CDP のタッチで地形の上をなぞる (指を止めてブラシを効かせる) */
async function stroke(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, ms = 900): Promise<void> {
  const s = await page.context().newCDPSession(page);
  await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await s.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, id: 1 }] });
    await page.waitForTimeout(ms / steps);
  }
  await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await s.detach();
}

test('地形: 追加・ブラシで盛る/下げる・Undo・作り直す・物を上に置く', async ({ page }) => {
  await page.getByTestId('add').tap();
  await page.getByTestId('add-terrain-flat').tap();
  const id = await evalApp(page, (app) => app.editor.selection.active as string);
  expect(await evalApp(page, (app, i) => app.editor.scene.get(i).kind, id)).toBe('terrain');
  expect(await maxHeight(page, id)).toBe(0);
  // 上から見る (ブラシでなぞりやすく)
  await evalApp(page, (app) => app.viewport.camera.setState({ target: [0, 0, 0], yaw: 0, pitch: 60, distance: 30 }));

  // Inspector → ブラシ
  await page.getByTestId('tab-inspector').tap();
  await expect(page.getByTestId('sec-terrain')).toBeVisible();
  await page.getByTestId('terrain-brush').tap();
  await waitSheetClosed(page);
  await expect(page.getByTestId('brush-bar')).toHaveClass(/show/);
  await expect(page.getByTestId('brush-tool-raise')).toHaveAttribute('aria-pressed', 'true');
  // ブラシ中はギズモを出さない
  expect(await evalApp(page, (app) => app.viewport.gizmo.attached)).toBe(false);

  const vp = (await page.getByTestId('viewport').boundingBox())!;
  const center = await evalApp(page, (app) => {
    app.viewport.renderNow();
    return app.viewport.screenPosition(app.editor.selection.active);
  });
  const c = center ?? { x: vp.x + vp.width / 2, y: vp.y + vp.height * 0.45 };
  await stroke(page, { x: c.x - 30, y: c.y }, { x: c.x + 30, y: c.y });
  await expect.poll(() => maxHeight(page, id)).toBeGreaterThan(0.5);
  const raised = await maxHeight(page, id);

  // 1 回の Undo でなぞった分が戻る
  await page.getByTestId('undo').tap();
  expect(await maxHeight(page, id)).toBe(0);
  await page.getByTestId('redo').tap();
  expect(await maxHeight(page, id)).toBe(raised);

  // 下げる
  await page.getByTestId('brush-tool-lower').tap();
  await expect(page.getByTestId('brush-tool-lower')).toHaveAttribute('aria-pressed', 'true');
  const minBefore = await evalApp(page, (app, i) => Math.min(...app.editor.scene.get(i).terrain.heights), id);
  await stroke(page, { x: c.x - 80, y: c.y + 60 }, { x: c.x - 60, y: c.y + 60 });
  await expect.poll(() => evalApp(page, (app, i) => Math.min(...app.editor.scene.get(i).terrain.heights), id)).toBeLessThan(minBefore - 0.3);

  // 大きさのスライダー
  await setRange(page, 'brush-size', 6);
  expect(await evalApp(page, (app) => app.viewport.terrainBrush.settings.radius)).toBe(6);

  // 完了
  await page.getByTestId('brush-done').tap();
  await expect(page.getByTestId('brush-bar')).not.toHaveClass(/show/);
  expect(await evalApp(page, (app) => app.viewport.terrainBrush.active)).toBe(false);

  // 作り直す: 山 (高さ 12m)
  await page.getByTestId('tab-inspector').tap();
  await openSection(page, 'sec-terrain-gen');
  await page.getByTestId('terrain-gen-type').selectOption('mountains');
  await enterNumber(page, 'terrain-gen-height', '12');
  await page.getByTestId('terrain-generate').tap();
  await expect.poll(() => maxHeight(page, id)).toBeCloseTo(12, 1);
  await expect(page.getByTestId('terrain-range')).toContainText('12.0 m');
  // 分割数を変える
  await page.getByTestId('terrain-res').selectOption('32');
  expect(await evalApp(page, (app, i) => app.editor.scene.get(i).terrain.heights.length, id)).toBe(33 * 33);
  await closeSheet(page);

  // キューブを置くと地形の表面に乗る
  await evalApp(page, (app) => app.editor.selection.clear());
  await page.getByTestId('add').tap();
  await page.getByTestId('add-cube').tap();
  const cube = await evalApp(page, (app) => {
    const e = app.editor.scene.get(app.editor.selection.active);
    return { y: e.transform.position[1], surface: app.viewport.surfaceHeight(e.transform.position[0], e.transform.position[2]) };
  });
  expect(cube.y).toBeCloseTo(cube.surface + 0.5, 2);
});

test('地形の当たり判定: Play で物が地形の上に落ちて止まる', async ({ page }) => {
  await page.getByTestId('add').tap();
  await page.getByTestId('add-terrain-hills').tap();
  const terrain = await evalApp(page, (app) => app.editor.selection.active as string);
  // 地形の上に物理の箱を置く
  await evalApp(page, (app) => app.editor.selection.clear());
  await page.getByTestId('add').tap();
  await page.getByTestId('add-sphere').tap();
  const ball = await evalApp(page, (app) => app.editor.selection.active as string);
  await page.getByTestId('tab-inspector').tap();
  await enterNumber(page, 'insp-position-y', '15');
  await page.getByTestId('insp-add-component').scrollIntoViewIfNeeded();
  await page.getByTestId('insp-add-component').tap();
  await page.getByTestId('add-comp-rigidbody').tap();
  await closeSheet(page);
  const xz = await evalApp(page, (app, i) => app.editor.scene.get(i).transform.position, ball);
  const surface = await evalApp(page, (app, p) => app.viewport.surfaceHeight(p[0], p[2]), xz);

  await page.getByTestId('play').tap();
  await expect.poll(() => evalApp(page, (app) => !!app.play.runtime?.physics), { timeout: 15_000 }).toBe(true);
  // 地形の当たり判定がある
  expect(await evalApp(page, (app, t) => app.play.runtime.physics.bodies.has(t), terrain)).toBe(true);
  // 球が落ちて表面で止まる (半径 0.5)
  await expect
    .poll(async () => {
      const y = await evalApp(page, (app, i) => app.play.runtime.objects.get(i).position.y, ball);
      const v = await evalApp(page, (app, i) => app.play.runtime.physics.getVelocity(i), ball);
      return y < 10 && Math.abs(v[1]) < 0.2 ? 'rest' : 'moving';
    }, { timeout: 20_000 })
    .toBe('rest');
  const y = await evalApp(page, (app, i) => app.play.runtime.objects.get(i).position.y, ball);
  // 斜面を転がることがあるので、今いる場所の表面と比べる
  const here = await evalApp(page, (app, i) => {
    const p = app.play.runtime.objects.get(i).position;
    return app.play.runtime.groundHeightAt(p.x, p.z);
  }, ball);
  expect(here).not.toBeNull();
  expect(y).toBeGreaterThan(here - 0.2);
  expect(y).toBeLessThan(here + 1.0);
  void surface;
  await page.getByTestId('stop').tap();
});

test('昼と夜: 時刻・星・月・太陽光の向き、雲、Play で時間が進み「夜になったとき」', async ({ page }) => {
  // 何も選ばない → Inspector はシーンの設定
  await evalApp(page, (app) => app.editor.selection.clear());
  await page.getByTestId('tab-inspector').tap();
  await openSection(page, 'sec-time');
  await page.getByTestId('env-time').tap();
  await expect(page.getByTestId('env-hour')).toBeVisible();
  const env = () => evalApp(page, (app) => app.editor.sceneData.environment);
  expect((await env()).time.enabled).toBe(true);

  // 昼 (12 時): 太陽光は明るく、星は見えない
  await setRange(page, 'env-hour', 12);
  await expect(page.getByTestId('env-clock')).toHaveText('12:00');
  const sun = await evalApp(page, (app) => {
    let l: any = null;
    app.viewport.bridge.root.traverse((o: any) => {
      if (o.isDirectionalLight && !l) l = o;
    });
    app.viewport.renderNow();
    return { intensity: l.intensity, base: l.userData.baseIntensity, stars: app.viewport.env.stars?.material.uniforms.uOpacity.value ?? 0, sunY: app.viewport.env.sunDirection.y };
  });
  expect(sun.intensity).toBeCloseTo(sun.base, 1);
  expect(sun.stars).toBe(0);
  expect(sun.sunY).toBeGreaterThan(0.8);

  // 夜 (22 時): 星が出て、太陽光は月の光 (弱い) になる
  await setRange(page, 'env-hour', 22);
  await expect(page.getByTestId('env-clock')).toHaveText('22:00');
  const night = await evalApp(page, (app) => {
    let l: any = null;
    app.viewport.bridge.root.traverse((o: any) => {
      if (o.isDirectionalLight && !l) l = o;
    });
    app.viewport.renderNow();
    return { intensity: l.intensity, base: l.userData.baseIntensity, stars: app.viewport.env.stars.material.uniforms.uOpacity.value, moon: !!app.viewport.env.moon, bg: app.viewport.scene.background?.isTexture };
  });
  expect(night.intensity).toBeLessThan(night.base * 0.2);
  expect(night.stars).toBeGreaterThan(0.9);
  expect(night.moon).toBe(true);
  // 星を消す
  await page.getByTestId('env-stars').tap();
  expect(await evalApp(page, (app) => app.viewport.env.stars)).toBeNull();

  // 雲
  await openSection(page, 'sec-clouds');
  await page.getByTestId('env-clouds').tap();
  await expect(page.getByTestId('env-cloud-amount')).toBeVisible();
  await setRange(page, 'env-cloud-amount', 0.8);
  expect((await env()).clouds).toMatchObject({ enabled: true, amount: 0.8 });
  expect(await evalApp(page, (app) => !!app.viewport.env.clouds)).toBe(true);

  // 時刻を 18.5 時にし、時間を進める (1 日 = 0.2 分 → 1 秒で約 2 時間)
  await setRange(page, 'env-hour', 18.5);
  await page.getByTestId('env-cycle').tap();
  await enterNumber(page, 'env-day-minutes', '0.2');
  expect((await env()).time).toMatchObject({ hour: 18.5, cycle: true, dayMinutes: 0.2 });
  // Undo / Redo
  await page.getByTestId('undo').tap();
  expect((await env()).time.dayMinutes).not.toBe(0.2);
  await page.getByTestId('redo').tap();
  expect((await env()).time.dayMinutes).toBe(0.2);
  await closeSheet(page);

  await page.getByTestId('play').tap();
  await expect.poll(() => evalApp(page, (app) => app.play.runtime?.time ?? 0)).toBeGreaterThan(0.05);
  // 時間が進んで夜 (19 時) になる
  await expect.poll(() => evalApp(page, (app) => app.play.runtime.eventLog.map((e: any) => e.event)), { timeout: 20_000 }).toContain('night');
  const h = await evalApp(page, (app) => app.play.runtime.getHour());
  expect(h >= 19 || h < 5).toBe(true);
  // Play 中の時刻は保存しない (編集データは 18.5 のまま)
  await page.getByTestId('stop').tap();
  expect((await env()).time.hour).toBe(18.5);
});

test('雷雨: 雷が光って回数が増える・イベントで天気と時刻を変える', async ({ page }) => {
  await evalApp(page, (app) => app.editor.selection.clear());
  await page.getByTestId('tab-inspector').tap();
  await openSection(page, 'sec-weather');
  await page.getByTestId('env-weather').selectOption('rain');
  await expect(page.getByTestId('env-lightning')).toBeVisible();
  await page.getByTestId('env-lightning').tap();
  expect(await evalApp(page, (app) => app.editor.sceneData.environment.weather)).toMatchObject({ type: 'rain', lightning: true });
  await closeSheet(page);

  await page.getByTestId('play').tap();
  await expect.poll(() => evalApp(page, (app) => app.play.runtime?.time ?? 0)).toBeGreaterThan(0.05);
  await evalApp(page, (app) => app.play.runtime.env.strikeNow());
  await expect.poll(() => evalApp(page, (app) => app.play.runtime.env.strikes)).toBeGreaterThan(0);

  // イベントの動作: 天気を晴れにする・時刻を変える (Play 中だけ)
  await evalApp(page, (app) => {
    const r = app.play.runtime;
    r.setWeather('none', false);
    r.setHour(6.5);
  });
  expect(await evalApp(page, (app) => app.play.runtime.sceneData.environment.weather.type)).toBe('none');
  expect(await evalApp(page, (app) => app.play.runtime.getHour())).toBeCloseTo(6.5);
  await page.getByTestId('stop').tap();
  expect(await evalApp(page, (app) => app.editor.sceneData.environment.weather.type)).toBe('rain');
});

test('ポストエフェクト: ブルーム・被写界深度・色あい (低画質では使わない)', async ({ page }) => {
  await evalApp(page, (app) => app.editor.selection.clear());
  await page.getByTestId('tab-inspector').tap();
  await openSection(page, 'sec-post');
  await page.getByTestId('env-bloom').tap();
  await expect(page.getByTestId('env-bloom-strength')).toBeVisible();
  await setRange(page, 'env-bloom-strength', 1.5);
  await page.getByTestId('env-dof').tap();
  await expect(page.getByTestId('env-dof-blur')).toBeVisible();
  await setRange(page, 'env-vignette', 0.5);
  await setRange(page, 'env-saturation', -1);
  const post = await evalApp(page, (app) => app.editor.sceneData.environment.post);
  expect(post).toMatchObject({ bloom: { enabled: true, strength: 1.5 }, dof: { enabled: true }, vignette: 0.5, saturation: -1 });
  // 編集中はプレビュー OFF なら使わない
  await evalApp(page, (app) => app.viewport.renderNow());
  expect(await evalApp(page, (app) => app.engine.postActive)).toBe(false);
  await closeSheet(page);

  // Play: すべての効果
  await page.getByTestId('play').tap();
  await expect.poll(() => evalApp(page, (app) => app.engine.postActive), { timeout: 15_000 }).toBe(true);
  expect(await evalApp(page, (app) => app.engine.post.activePasses)).toEqual(['render', 'dof', 'bloom', 'output', 'grade']);
  await page.getByTestId('stop').tap();

  // 低画質では使わない
  await evalApp(page, (app) => app.editor.updateSettings({ quality: 'low' }));
  await page.getByTestId('play').tap();
  await expect.poll(() => evalApp(page, (app) => app.play.runtime?.time ?? 0)).toBeGreaterThan(0.05);
  await page.waitForTimeout(200);
  expect(await evalApp(page, (app) => app.engine.postActive)).toBe(false);
  await page.getByTestId('stop').tap();
  // 編集中のプレビュー (被写界深度なし)
  await evalApp(page, (app) => app.editor.updateSettings({ quality: 'medium', previewEffects: true }));
  await expect
    .poll(() =>
      evalApp(page, (app) => {
        app.viewport.renderNow();
        return app.engine.postActive ? app.engine.post.activePasses : null;
      }),
    )
    .toEqual(['render', 'bloom', 'output', 'grade']);
});
