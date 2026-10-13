import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Project HEMO Phase 1: 実験室とカメラ (スマホ縦画面) */

async function openHemo(page: Page, errors: string[]): Promise<void> {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('./?mode=hemo');
  await page.waitForFunction(() => !!(window as unknown as { __hemo?: unknown }).__hemo);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hemo = <T>(page: Page, fn: (app: any, arg: any) => T, arg?: unknown): Promise<T> =>
  page.evaluate(
    ([src, a]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const app = (window as any).__hemo;
      // eslint-disable-next-line no-new-func
      return new Function('app', 'arg', `return (${src})(app, arg);`)(app, a);
    },
    [fn.toString(), arg] as const,
  ) as Promise<T>;

/** 画面上でポインター操作 (touch) を合成して指のドラッグを再現する */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, id = 1): Promise<void> {
  await page.evaluate(
    ([f, t, pid]) => {
      const el = document.querySelector('[data-testid="hemo-viewport"]')!;
      const fire = (type: string, x: number, y: number) =>
        el.dispatchEvent(new PointerEvent(type, { pointerId: pid as number, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: true, button: 0 }));
      const a = f as { x: number; y: number };
      const b = t as { x: number; y: number };
      fire('pointerdown', a.x, a.y);
      for (let i = 1; i <= 8; i++) fire('pointermove', a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8);
      fire('pointerup', b.x, b.y);
    },
    [from, to, id] as const,
  );
}

test('HEMO: 実験室が表示され、物を選択して動かし、リセットできる', async ({ page }) => {
  const errors: string[] = [];
  await openHemo(page, errors);
  await expect(page.locator('canvas.viewport-canvas')).toBeVisible();
  await expect(page.getByText('Project HEMO')).toBeVisible();
  expect(await hemo(page, (app) => { app.renderNow(); return app.engine.renderer.info.render.calls; })).toBeGreaterThan(0);

  // タップで選択
  const p = (await hemo(page, (app) => app.screenPos('ball'))) as { x: number; y: number };
  await page.touchscreen.tap(p.x, p.y);
  await expect(page.getByTestId('hemo-selection')).toHaveAttribute('data-selected', 'ball');

  // 選択中の物の上から始めたドラッグは物を動かす (カメラは回らない)
  const camBefore = await hemo(page, (app) => app.cam.getState());
  const posBefore = await hemo(page, (app) => app.lab.props.get('ball').position.x as number);
  await drag(page, p, { x: p.x + 70, y: p.y });
  const posAfter = await hemo(page, (app) => app.lab.props.get('ball').position.x as number);
  expect(posAfter).toBeGreaterThan(posBefore + 0.1);
  expect(await hemo(page, (app) => app.cam.getState())).toEqual(camBefore);

  // リセットで物が戻り、選択も解除される
  await page.getByTestId('hemo-reset').tap();
  expect(await hemo(page, (app) => app.lab.props.get('ball').position.x as number)).toBeCloseTo(posBefore, 5);
  await expect(page.getByTestId('hemo-selection')).toHaveAttribute('data-selected', '');
  expect(errors.filter((e) => !/GPU stall|swiftshader|WebGL/i.test(e))).toEqual([]);
});

test('HEMO: 何もない所のドラッグで視点が回り、視点リセットで戻る', async ({ page }) => {
  const errors: string[] = [];
  await openHemo(page, errors);
  const before = (await hemo(page, (app) => app.cam.getState())) as { yaw: number };
  const box = (await page.getByTestId('hemo-viewport').boundingBox())!;
  const start = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.85 };
  await drag(page, start, { x: start.x + 90, y: start.y });
  const after = (await hemo(page, (app) => app.cam.getState())) as { yaw: number };
  expect(Math.abs(after.yaw - before.yaw)).toBeGreaterThan(5);

  await page.getByTestId('hemo-cam-reset').tap();
  await expect.poll(async () => ((await hemo(page, (app) => app.cam.getState())) as { yaw: number }).yaw, { timeout: 3000 }).toBeCloseTo(before.yaw, 1);
  expect(errors.filter((e) => !/GPU stall|swiftshader|WebGL/i.test(e))).toEqual([]);
});

test('HEMO: ピンチ (2本指) でズームし、フォーカスで選択物に寄る', async ({ page }) => {
  const errors: string[] = [];
  await openHemo(page, errors);
  const d0 = (await hemo(page, (app) => app.cam.getState())) as { distance: number };
  const box = (await page.getByTestId('hemo-viewport').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height * 0.6;
  // 2本の指を近づける (= ズームアウトではなく、指の間隔が狭まるので遠ざかる)
  await page.evaluate(
    ([x, y]) => {
      const el = document.querySelector('[data-testid="hemo-viewport"]')!;
      const fire = (type: string, id: number, px: number, py: number) =>
        el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: px, clientY: py, bubbles: true, cancelable: true, isPrimary: id === 1, button: 0 }));
      const cxx = x as number;
      const cyy = y as number;
      fire('pointerdown', 1, cxx - 100, cyy);
      fire('pointerdown', 2, cxx + 100, cyy);
      for (let i = 1; i <= 6; i++) {
        fire('pointermove', 1, cxx - 100 + i * 12, cyy);
        fire('pointermove', 2, cxx + 100 - i * 12, cyy);
      }
      fire('pointerup', 1, cxx - 28, cyy);
      fire('pointerup', 2, cxx + 28, cyy);
    },
    [cx, cy] as const,
  );
  const d1 = (await hemo(page, (app) => app.cam.getState())) as { distance: number };
  expect(d1.distance).toBeGreaterThan(d0.distance);

  await hemo(page, (app) => app.select('barrel'));
  await page.getByTestId('hemo-focus').tap();
  await expect.poll(async () => ((await hemo(page, (app) => app.cam.getState())) as { distance: number }).distance, { timeout: 3000 }).toBeLessThan(d0.distance);
  expect(errors.filter((e) => !/GPU stall|swiftshader|WebGL/i.test(e))).toEqual([]);
});

test('HEMO: 通常のエディタは今までどおり起動する', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./');
  await page.waitForFunction(() => !!(window as unknown as { __pocket?: unknown }).__pocket);
  expect(await page.evaluate(() => !!(window as unknown as { __hemo?: unknown }).__hemo)).toBe(false);
  expect(errors).toEqual([]);
});
