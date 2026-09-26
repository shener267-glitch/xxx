import { expect } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';

/**
 * E2E テスト用ヘルパー。
 * アプリは window.__pocket に App インスタンスを公開しているので、
 * 内部状態の確認にはそれを使う (操作自体は実際のタッチ / クリックで行う)。
 */

export interface Pt {
  x: number;
  y: number;
}

export interface EntitySummary {
  id: string;
  name: string;
  kind: string;
  parent: string | null;
  children: string[];
  visible: boolean;
  locked: boolean;
  position: number[];
  rotation: number[];
  scale: number[];
  color?: string;
}

/** 新しい状態でアプリを開き、初回の操作ガイドを閉じる */
export async function openApp(page: Page, errors: string[] = []): Promise<void> {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('./');
  await page.waitForFunction(() => !!(window as unknown as { __pocket?: unknown }).__pocket);
  const help = page.getByTestId('help-close');
  await help.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
  if (await help.isVisible()) await help.click();
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
}

export async function reloadApp(page: Page): Promise<void> {
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as { __pocket?: unknown }).__pocket);
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
}

/** アプリ内部の状態を取得するための evaluate ラッパー */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function evalApp<T>(page: Page, fn: (app: any, arg: any) => T, arg?: unknown): Promise<T> {
  return page.evaluate(
    ([src, a]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const app = (window as any).__pocket;
      // eslint-disable-next-line no-new-func
      return new Function('app', 'arg', `return (${src})(app, arg);`)(app, a);
    },
    [fn.toString(), arg] as const,
  ) as Promise<T>;
}

export async function entities(page: Page): Promise<EntitySummary[]> {
  return evalApp(page, (app) =>
    app.editor.scene.ordered().map((e: any) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      parent: e.parent,
      children: [...e.children],
      visible: e.visible,
      locked: e.locked,
      position: [...e.transform.position],
      rotation: [...e.transform.rotation],
      scale: [...e.transform.scale],
      color: e.mesh?.material.color,
    })),
  );
}

export async function entity(page: Page, id: string): Promise<EntitySummary> {
  const list = await entities(page);
  const e = list.find((x) => x.id === id);
  if (!e) throw new Error(`entity ${id} not found`);
  return e;
}

export async function entityByName(page: Page, name: string): Promise<EntitySummary | undefined> {
  return (await entities(page)).find((e) => e.name === name);
}

export async function selection(page: Page): Promise<string[]> {
  return evalApp(page, (app) => [...app.editor.selection.ids]);
}

/** エンティティの画面上の位置 (描画を最新にしてから計算) */
export async function screenPos(page: Page, id: string): Promise<Pt> {
  const p = await evalApp(page, (app, eid) => {
    app.viewport.renderNow();
    return app.viewport.screenPosition(eid);
  }, id);
  if (!p) throw new Error(`entity ${id} is off screen`);
  return p as Pt;
}

// ------------------------------------------------------------------
// タッチ操作 (CDP でマルチタッチを送る)
// ------------------------------------------------------------------

async function cdp(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/**
 * 指を離す前に少し止める。動かしながら離すと Chrome がフリング (慣性スクロール) と判定し、
 * 直後のタップが「フリングを止める操作」として吸収されてクリックにならないことがあるため。
 */
async function settleBeforeRelease(page: Page): Promise<void> {
  await page.waitForTimeout(150);
}

export async function touchDrag(page: Page, from: Pt, to: Pt, steps = 12): Promise<void> {
  const s = await cdp(page);
  await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await s.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, id: 1 }],
    });
  }
  await settleBeforeRelease(page);
  await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await s.detach();
}

/** 2本指操作。a/b の開始点から終了点へ同時に動かす */
export async function twoFinger(page: Page, a: [Pt, Pt], b: [Pt, Pt], steps = 12): Promise<void> {
  const s = await cdp(page);
  await s.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: a[0].x, y: a[0].y, id: 1 },
      { x: b[0].x, y: b[0].y, id: 2 },
    ],
  });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await s.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: a[0].x + (a[1].x - a[0].x) * t, y: a[0].y + (a[1].y - a[0].y) * t, id: 1 },
        { x: b[0].x + (b[1].x - b[0].x) * t, y: b[0].y + (b[1].y - b[0].y) * t, id: 2 },
      ],
    });
  }
  await settleBeforeRelease(page);
  await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await s.detach();
}

/** 長押し */
export async function longPress(page: Page, p: Pt, ms = 800): Promise<void> {
  const s = await cdp(page);
  await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 1 }] });
  await page.waitForTimeout(ms);
  await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await s.detach();
}

/** テンキーで数値を入力する (スマホ用の数値入力) */
export async function enterNumber(page: Page, testId: string, value: string): Promise<void> {
  // 入力欄自体はタップを親要素に通すため、親 (.num-field) をタップする
  await page.getByTestId(testId).locator('..').tap();
  const pad = page.getByTestId('numpad');
  await expect(pad).toBeVisible();
  for (const ch of value) {
    await pad.locator(`[data-key="${ch}"]`).tap();
  }
  await page.getByTestId('numpad-ok').tap();
  await expect(page.getByTestId('numpad')).toHaveCount(0);
}

/** アニメーションが終わって位置が安定するまで待ってから要素の矩形を返す */
export async function stableBox(page: Page, testId: string): Promise<{ x: number; y: number; width: number; height: number }> {
  let prev = await page.getByTestId(testId).boundingBox();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(60);
    const cur = await page.getByTestId(testId).boundingBox();
    if (prev && cur && Math.abs(prev.y - cur.y) < 0.5 && Math.abs(prev.height - cur.height) < 0.5) return cur;
    prev = cur;
  }
  return prev!;
}

/** 3D ビュー内で、オブジェクトが無く地面が見えている点を探す */
export async function emptyGroundPoint(page: Page): Promise<Pt> {
  const p = await evalApp(page, (app) => {
    const r = app.engine.canvas.getBoundingClientRect();
    for (let fy = 0.75; fy >= 0.35; fy -= 0.05) {
      for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        if (!app.viewport.pick(x, y) && app.viewport.groundPointAt(x, y)) return { x, y };
      }
    }
    return null;
  });
  if (!p) throw new Error('empty ground point not found');
  return p as Pt;
}

/** 3D ビュー内の「何もない」点 (UI に覆われておらず、オブジェクトも無い上側の空間) */
export async function emptyPoint(page: Page): Promise<Pt> {
  const p = await evalApp(page, (app) => {
    const canvas = app.engine.canvas;
    const r = canvas.getBoundingClientRect();
    for (let fy = 0.12; fy <= 0.5; fy += 0.04) {
      for (const fx of [0.3, 0.45, 0.2, 0.6, 0.12]) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        if (document.elementFromPoint(x, y) === canvas && !app.viewport.pick(x, y)) return { x, y };
      }
    }
    return null;
  });
  if (!p) throw new Error('empty point not found');
  return p as Pt;
}

// ------------------------------------------------------------------
// ゲーム (Phase 3 以降)
// ------------------------------------------------------------------

/** テンプレートから新しいプロジェクトを作る (UI 操作) */
export async function createFromTemplate(page: Page, id: 'coins' | 'adventure'): Promise<void> {
  await page.getByTestId('main-menu').tap();
  await page.getByTestId('menu-projects').tap();
  await page.getByTestId('project-template').tap();
  await page.getByTestId(`template-${id}`).tap();
  await page.getByTestId('prompt-ok').tap();
  await expect.poll(() => evalApp(page, (app) => Object.values(app.editor.sceneData.entities).some((e: any) => e.components.some((c: any) => c.type === 'player')))).toBe(true);
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
}

export async function startPlay(page: Page): Promise<void> {
  await page.getByTestId('play').tap();
  await expect(page.getByTestId('play-hud')).toBeVisible();
  // 物理 (cannon-es) の読み込みと最初のフレームを待つ
  await expect.poll(() => evalApp(page, (app) => !!app.play.runtime?.physics && app.play.runtime.time > 0.05), { timeout: 20_000 }).toBe(true);
}

/** Play 中のプレイヤーを名前で指定したオブジェクトの近くへ移動する */
export async function teleportNear(page: Page, name: string, offset: [number, number, number] = [0, 0.3, 0]): Promise<void> {
  await evalApp(
    page,
    (app, arg) => {
      const r = app.play.runtime;
      const target = (Object.values(r.sceneData.entities) as any[]).find((e) => e.name === arg.name);
      const p = r.worldPosition(target.id);
      r.physics.teleport(r.playerId, [p.x + arg.offset[0], p.y + arg.offset[1], p.z + arg.offset[2]]);
    },
    { name, offset },
  );
}

export async function openSection(page: Page, testId: string): Promise<void> {
  const sec = page.getByTestId(testId);
  if (await sec.evaluate((el) => el.classList.contains('collapsed'))) await sec.locator('.section-toggle').tap();
}

/** ボトムシートを閉じる (アニメーション中に押すと見出しに当たるので、位置が落ち着いてから) */
export async function closeSheet(page: Page): Promise<void> {
  await stableBox(page, 'sheet-close');
  await page.getByTestId('sheet-close').tap();
  await expect(page.getByTestId('sheet')).toHaveAttribute('data-state', 'closed');
}

export const gameState = (page: Page) =>
  evalApp(page, (app) => {
    const r = app.play.runtime;
    return {
      score: r.state.score,
      money: r.state.money,
      hp: r.state.hp,
      lives: r.state.lives,
      status: r.state.status,
      inventory: Object.fromEntries(r.state.inventory),
      events: r.eventLog.map((e: { event: string }) => e.event),
    };
  });

