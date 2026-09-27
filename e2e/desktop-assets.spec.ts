import { expect, test } from '@playwright/test';
import { makeTestGlb } from '../tests/fixtures/glb';
import { evalApp, openApp } from './helpers';

/**
 * Phase 6 (PC): ファイルを 3D ビューにドラッグ&ドロップすると、読み込んでその場所に置く。
 * カードはマウスでカード全体をドラッグできる。
 */

test('ファイルのドロップ: 3D ビューに GLB を落とすと読み込んで置く', async ({ page }) => {
  const errors: string[] = [];
  await openApp(page, errors);
  const vp = (await page.getByTestId('viewport').boundingBox())!;
  const at = { x: vp.x + vp.width * 0.4, y: vp.y + vp.height * 0.6 };
  // 起動直後はカメラが動いているので、止まるまで待つ
  const groundAt = () => evalApp(page, (app, p) => app.viewport.groundPointAt(p.x, p.y), at);
  let prev = await groundAt();
  await expect
    .poll(async () => {
      const cur = await groundAt();
      const still = Math.abs(cur.x - prev.x) + Math.abs(cur.z - prev.z) < 1e-3;
      prev = cur;
      return still;
    }, { intervals: [300] })
    .toBe(true);
  // 置いた後は PC のサイドパネルが開いて 3D ビューがずれるので、落とす前の位置で比べる
  const ground = await groundAt();
  const bytes = [...makeTestGlb()];
  await page.evaluate(
    ({ bytes, at }) => {
      const file = new File([new Uint8Array(bytes)], 'ドロップ.glb', { type: 'model/gltf-binary' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.elementFromPoint(at.x, at.y)!;
      const opts = { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, dataTransfer: dt };
      target.dispatchEvent(new DragEvent('dragover', opts));
      target.dispatchEvent(new DragEvent('drop', opts));
    },
    { bytes, at },
  );
  await expect.poll(() => evalApp(page, (app) => app.editor.project.assets.map((a: any) => a.name)), { timeout: 20_000 }).toEqual(['ドロップ']);
  await expect.poll(() => evalApp(page, (app) => (Object.values(app.editor.sceneData.entities) as any[]).filter((e) => e.kind === 'model').length)).toBe(1);
  const id = await evalApp(page, (app) => app.editor.selection.active);
  const pos = await evalApp(page, (app, i) => app.editor.scene.get(i).transform.position, id);
  expect(pos[0]).toBeCloseTo(ground.x, 0);
  expect(pos[2]).toBeCloseTo(ground.z, 0);

  // マウスでカード全体をドラッグして、もう 1 つ置く
  await page.getByTestId('tab-assets').click();
  const card = (await page.getByTestId('asset-card-ドロップ').boundingBox())!;
  const vp2 = (await page.getByTestId('viewport').boundingBox())!;
  const drop = { x: Math.max(vp2.x, 0) + 200, y: vp2.y + vp2.height * 0.3 };
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 3);
  await page.mouse.down();
  await page.mouse.move(card.x + card.width / 2 + 30, card.y, { steps: 4 });
  await expect(page.getByTestId('drag-ghost')).toBeVisible();
  await page.mouse.move(drop.x, drop.y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => evalApp(page, (app) => (Object.values(app.editor.sceneData.entities) as any[]).filter((e) => e.kind === 'model').length)).toBe(2);
  expect(errors.filter((e) => !/GPU stall|swiftshader|WebGL/i.test(e))).toEqual([]);
});
