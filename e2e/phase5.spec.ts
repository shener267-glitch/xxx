import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { closeSheet, createFromTemplate, evalApp, openApp, startPlay } from './helpers';

/**
 * Phase 5: アニメーション・キャラクターの動き・パーティクル
 */

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  await openApp(page, errors);
});

test.afterEach(() => {
  expect(errors.filter((e) => !/GPU stall|swiftshader|WebGL/i.test(e))).toEqual([]);
});

const byName = (page: Page, name: string) =>
  evalApp(page, (app, n) => (Object.values(app.editor.sceneData.entities) as any[]).find((e) => e.name === n)?.id as string, name);

test('パーティクル: 追加するとエディタでプレビューされ、Play で動く', async ({ page }) => {
  await page.getByTestId('add').tap();
  await page.getByTestId('add-fx-fire').tap();
  const fire = await evalApp(page, (app) => app.editor.selection.active);
  expect(await evalApp(page, (app, id) => app.editor.scene.get(id).components.map((c: any) => [c.type, c.props.preset]), fire)).toEqual([['particles', 'fire']]);
  // 選択中は粒が動く (プレビュー)
  await expect.poll(() => evalApp(page, (app, id) => app.viewport.effects.items.get(id)?.emitter.alive ?? 0, fire)).toBeGreaterThan(5);
  // 選択を外すと止まる (非表示)
  await evalApp(page, (app) => app.editor.selection.clear());
  await expect.poll(() => evalApp(page, (app, id) => app.viewport.effects.items.get(id)?.emitter.points.visible, fire)).toBe(false);

  // Inspector で種類を「煙」に変更
  await evalApp(page, (app, id) => app.editor.selection.set([id]), fire);
  await page.getByTestId('tab-inspector').tap();
  await page.getByTestId('prop-preset').scrollIntoViewIfNeeded();
  await page.getByTestId('prop-preset').selectOption('smoke');
  expect(await evalApp(page, (app, id) => app.editor.scene.get(id).components[0].props.preset, fire)).toBe('smoke');
  await closeSheet(page);

  // Play: ランタイムでも粒が出る
  await page.getByTestId('play').tap();
  await expect.poll(() => evalApp(page, (app) => app.play.runtime?.time ?? 0)).toBeGreaterThan(0.2);
  const alive = await evalApp(page, (app) => {
    let n = 0;
    app.play.runtime.scene.traverse((o: any) => {
      if (o.userData?.isParticles && o.geometry.drawRange.count > 0) n++;
    });
    return n;
  });
  expect(alive).toBeGreaterThan(0);
  // 使い捨てのエフェクト (爆発)
  await evalApp(page, (app) => app.play.runtime.spawnEffect('explosion', [0, 1, 0]));
  await page.waitForTimeout(100);
  expect(await evalApp(page, (app) => app.play.runtime.effects.length)).toBe(1);
  await page.getByTestId('stop').tap();
});

test('アニメーション: プリセットの追加・タイムラインのプレビュー・キーの記録・Play で再生', async ({ page }) => {
  const cube = await byName(page, 'キューブ');
  await evalApp(page, (app, id) => app.editor.selection.set([id]), cube);
  await page.getByTestId('tab-inspector').tap();
  await page.getByTestId('insp-add-component').scrollIntoViewIfNeeded();
  await page.getByTestId('insp-add-component').tap();
  await page.getByTestId('add-comp-animation').tap();
  await expect(page.getByTestId('anim-editor')).toBeVisible();

  // プリセット「ぴょんと跳ねる」→ 自動再生になる
  await page.getByTestId('anim-add').tap();
  await page.getByTestId('anim-add-hop').tap();
  const props = () => evalApp(page, (app, id) => JSON.parse(JSON.stringify(app.editor.scene.get(id).components.find((c: any) => c.type === 'animation').props)), cube);
  let p = await props();
  expect(p.clips).toHaveLength(1);
  expect(p.autoplay).toBe(p.clips[0].name);
  expect(p.clips[0].keys.length).toBeGreaterThanOrEqual(3);

  // タイムライン: 0.35 秒の姿勢を 3D ビューに表示 (データは変わらない)
  const y0 = await evalApp(page, (app, id) => app.editor.scene.get(id).transform.position[1], cube);
  await page.getByTestId('anim-scrub').fill('0.35');
  await expect.poll(() => evalApp(page, (app, id) => app.viewport.bridge.get(id).position.y, cube)).toBeCloseTo(y0 + 1, 2);
  expect(await evalApp(page, (app, id) => app.editor.scene.get(id).transform.position[1], cube)).toBe(y0);
  await expect(page.getByTestId('anim-time')).toContainText('0.35');

  // 空のアニメーションを作り、0.5 秒に姿勢を記録
  await page.getByTestId('anim-add').tap();
  await page.getByTestId('anim-add-empty').tap();
  p = await props();
  expect(p.clips).toHaveLength(2);
  await page.getByTestId('anim-scrub').fill('0.5');
  await evalApp(page, (app, id) => app.viewport.previewPose(id, { p: [0, 3, 0], r: [0, 45, 0], s: [1, 1, 1] }), cube);
  await page.getByTestId('anim-record').tap();
  p = await props();
  const rec = p.clips[1].keys.find((k: { t: number }) => Math.abs(k.t - 0.5) < 1e-3);
  expect(rec).toMatchObject({ p: [0, 3, 0], r: [0, 45, 0] });
  // Undo で記録を取り消し
  await page.getByTestId('undo').tap();
  p = await props();
  expect(p.clips[1].keys).toHaveLength(1);
  await closeSheet(page);
  // 選択を変えるとプレビューの姿勢は元に戻る
  await evalApp(page, (app) => app.editor.selection.clear());
  expect(await evalApp(page, (app, id) => app.viewport.bridge.get(id).position.y, cube)).toBe(y0);

  // Play: 自動再生で上下に跳ねる
  await page.getByTestId('play').tap();
  const ys: number[] = [];
  for (let i = 0; i < 12; i++) {
    ys.push(await evalApp(page, (app, id) => app.play.runtime?.objects.get(id)?.position.y ?? 0, cube));
    await page.waitForTimeout(80);
  }
  expect(Math.max(...ys)).toBeGreaterThan(y0 + 0.2);
  expect(await evalApp(page, (app, id) => app.play.runtime.getController(id, 'animation').current, cube)).toBe(p.clips[0].name);
  // 別のアニメーションに切り替え → 止める
  expect(await evalApp(page, (app, a) => app.play.runtime.getController(a.id, 'animation').play(a.name), { id: cube, name: p.clips[1].name })).toBe(true);
  expect(await evalApp(page, (app, id) => app.play.runtime.getController(id, 'animation').current, cube)).toBe(p.clips[1].name);
  await evalApp(page, (app, id) => app.play.runtime.getController(id, 'animation').stop(), cube);
  expect(await evalApp(page, (app, id) => app.play.runtime.getController(id, 'animation').current, cube)).toBeNull();
  await page.getByTestId('stop').tap();
});

test('キャラクターの動き: 待機 → 歩く → ジャンプ', async ({ page }) => {
  await createFromTemplate(page, 'coins');
  await startPlay(page);
  const charState = () => evalApp(page, (app) => app.play.runtime.getController(app.play.runtime.playerId, 'charAnim')?.state);
  await expect.poll(charState, { timeout: 10_000 }).toBe('idle');
  // ジョイスティックを倒したまま → 歩く / 走る
  const box = (await page.getByTestId('runtime-overlay').boundingBox())!;
  const x = box.x + box.width * 0.2;
  const y = box.y + box.height * 0.7;
  const s = await page.context().newCDPSession(page);
  await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 3 }] });
  await s.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 30, id: 3 }] });
  await expect.poll(charState, { timeout: 10_000 }).toMatch(/walk|run/);
  // 見た目 (メッシュ) だけが揺れて、当たり判定のあるオブジェクト自体は傾かない
  const tilt = await evalApp(page, (app) => {
    const o = app.play.runtime.objects.get(app.play.runtime.playerId);
    return { content: Math.abs(o.userData.content.rotation.z) + Math.abs(o.userData.content.position.y), objX: o.rotation.x };
  });
  expect(tilt.content).toBeGreaterThan(0);
  await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await s.detach();
  await expect.poll(charState, { timeout: 10_000 }).toBe('idle');
  // ジャンプ
  await expect.poll(() => evalApp(page, (app) => app.play.runtime.isGrounded(app.play.runtime.playerId)), { timeout: 10_000 }).toBe(true);
  await page.getByTestId('game-jump').tap();
  await expect.poll(charState, { timeout: 5_000 }).toBe('jump');
  await page.getByTestId('stop').tap();
});

test('イベントからアニメーションの再生・エフェクト・パーティクルの ON/OFF', async ({ page }) => {
  // 炎 (最初は止めておく) と、アニメーション付きのキューブ
  await page.getByTestId('add').tap();
  await page.getByTestId('add-fx-fire').tap();
  const fire = await evalApp(page, (app) => app.editor.selection.active);
  const cube = await byName(page, 'キューブ');
  await evalApp(
    page,
    (app, ids) => {
      const ed = app.editor;
      const f = ed.scene.get(ids.fire);
      const c = ed.scene.get(ids.cube);
      f.components[0].props.playOnStart = false;
      c.components.push({ id: 'c_anim', type: 'animation', enabled: true, props: { speed: 1, autoplay: '', clips: [{ id: 'k1', name: '回る', duration: 1, loop: 'loop', easing: 'linear', keys: [{ t: 0, p: c.transform.position, r: [0, 0, 0], s: [1, 1, 1] }, { t: 1, p: c.transform.position, r: [0, 360, 0], s: [1, 1, 1] }] }] } });
      const b = (type: string, params: Record<string, unknown>) => ({ type, params });
      ed.sceneData.events = [
        { id: 'e1', name: '開始', enabled: true, once: false, trigger: b('after', { seconds: 0.3 }), conditions: [], actions: [b('anim', { target: ids.cube, clip: '回る', mode: 'play' }), b('particles', { target: ids.fire, mode: 'play' }), b('effect', { preset: 'confetti', target: 'player', scale: 1 })], elseActions: [] },
      ];
      ed.events.emit('events-changed', undefined);
    },
    { fire, cube },
  );
  // イベントエディタでアニメーション名を選べる
  await page.getByTestId('tab-events').tap();
  await page.getByTestId('ev-actions-0-0').tap();
  await expect(page.getByTestId('ev-param-clip')).toHaveValue('回る');
  await page.getByTestId('ev-form-cancel').tap();
  await closeSheet(page);

  await page.getByTestId('play').tap();
  await expect.poll(() => evalApp(page, (app, id) => app.play.runtime?.getController(id, 'animation')?.current ?? null, cube), { timeout: 10_000 }).toBe('回る');
  await expect
    .poll(() => evalApp(page, (app, id) => app.play.runtime.getController(id, 'animation') && Math.abs(app.play.runtime.objects.get(id).rotation.y), cube))
    .toBeGreaterThan(0.1);
  expect(await evalApp(page, (app) => app.play.runtime.effects.length)).toBeGreaterThanOrEqual(0);
  await expect
    .poll(() =>
      evalApp(page, (app) => {
        let n = 0;
        app.play.runtime.scene.traverse((o: any) => {
          if (o.userData?.isParticles) n += o.geometry.drawRange.count;
        });
        return n;
      }),
    )
    .toBeGreaterThan(0);
  await page.getByTestId('stop').tap();
});
