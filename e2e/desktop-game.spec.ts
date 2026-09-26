import { expect, test } from '@playwright/test';
import { evalApp, openApp } from './helpers';

/**
 * Phase 3 (PC): キーボードでプレイヤーを操作する
 */

test('キーボード: WASD で移動・Space でジャンプ・E で攻撃', async ({ page }) => {
  const errors: string[] = [];
  await openApp(page, errors);
  await evalApp(page, (app) => app.projects.createFromTemplate('coins', 'PC テスト'));
  await expect.poll(() => evalApp(page, (app) => app.editor.project.name)).toBe('PC テスト');
  await page.getByTestId('play').click();
  await expect.poll(() => evalApp(page, (app) => !!app.play.runtime?.physics && app.play.runtime.time > 0.05), { timeout: 20_000 }).toBe(true);
  const pos = () => evalApp(page, (app) => {
    const p = app.play.runtime.worldPosition(app.play.runtime.playerId);
    return [p.x, p.y, p.z];
  });

  // W で前へ
  const p0 = await pos();
  await page.keyboard.down('w');
  await page.waitForTimeout(900);
  await page.keyboard.up('w');
  expect((await pos())[2]).toBeLessThan(p0[2] - 0.3);

  // D で右へ (Shift で走る)
  const p1 = await pos();
  await page.keyboard.down('Shift');
  await page.keyboard.down('d');
  await page.waitForTimeout(700);
  await page.keyboard.up('d');
  await page.keyboard.up('Shift');
  expect((await pos())[0]).toBeGreaterThan(p1[0] + 0.3);

  // Space でジャンプ
  await expect.poll(() => evalApp(page, (app) => app.play.runtime.isGrounded(app.play.runtime.playerId)), { timeout: 10_000 }).toBe(true);
  const y0 = (await pos())[1];
  await page.keyboard.press('Space');
  await expect.poll(async () => (await pos())[1]).toBeGreaterThan(y0 + 0.2);

  // 敵の前で E → 攻撃が当たって敵の HP が減る
  await evalApp(page, (app) => {
    const r = app.play.runtime;
    const enemy = (Object.values(r.sceneData.entities) as any[]).find((e) => e.name === '敵2');
    // 敵の -Z 側にプレイヤーを置き、敵の方 (+Z) を向かせる
    const p = r.worldPosition(enemy.id);
    r.physics.teleport(r.playerId, [p.x, p.y + 0.4, p.z - 1.2]);
    r.physics.setRotation(r.playerId, [0, 0, 0, 1]);
    r.getObject(r.playerId).quaternion.set(0, 0, 0, 1);
    (window as any).__enemyId = enemy.id;
  });
  await page.waitForTimeout(100);
  await page.keyboard.press('e');
  await expect
    .poll(() => evalApp(page, (app) => app.play.runtime.eventLog.map((e: { event: string }) => e.event)), { timeout: 10_000 })
    .toContain('attack-hit');
  const enemyHp = await evalApp(page, (app) => app.play.runtime.getHealth((window as any).__enemyId));
  expect(enemyHp === null || enemyHp.hp < enemyHp.maxHp).toBe(true);

  await page.getByTestId('stop').click();
  expect(errors.filter((e) => !/GPU stall|swiftshader|WebGL/i.test(e))).toEqual([]);
});
