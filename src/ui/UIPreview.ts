import type { EntityData } from '../core/types';
import { GameState } from '../runtime/GameState';
import type { UIItem } from '../runtime/GameUI';
import { buildUIElement, updateUIElement } from '../runtime/GameUI';
import type { AppContext } from './context';
import { h, rafThrottle } from './dom';

/**
 * 編集中の 3D ビューに、ゲーム画面の UI (文字・ボタン・画像・ゲージ) を重ねて表示する。
 * 操作の邪魔にならないようタッチは素通しし、タップ位置の判定だけ提供する (hitTest)。
 */
export class UIPreview {
  readonly el: HTMLElement;
  private items: UIItem[] = [];
  private urls = new Map<string, string>();
  /** プレビュー用の仮の状態 (スコア 0・HP 満タンなど) */
  private state = new GameState();
  private schedule = rafThrottle(() => this.render());

  constructor(private ctx: AppContext) {
    this.state.setHp(100, 100);
    this.state.timeLimit = ctx.editor.project.game.timeLimit;
    this.el = h('div', { class: 'ui-preview game-ui', attrs: { 'data-testid': 'ui-preview', 'aria-hidden': 'true' } });
    const ev = ctx.editor.events;
    for (const type of ['scene-loaded', 'entity-added', 'entity-removed', 'entity-changed', 'hierarchy-changed', 'project-changed', 'assets-changed'] as const) {
      ev.on(type, this.schedule);
    }
    // 選択の変化では作り直さず、強調表示だけ切り替える
    ev.on('selection-changed', () => this.updateSelection());
    this.render();
  }

  private uiEntities(): EntityData[] {
    const scene = this.ctx.editor.scene;
    const visible = (e: EntityData): boolean => {
      let cur: EntityData | undefined = e;
      while (cur) {
        if (!cur.visible) return false;
        cur = cur.parent ? scene.get(cur.parent) : undefined;
      }
      return true;
    };
    return scene.ordered().filter((e) => e.kind === 'ui' && e.ui && visible(e));
  }

  private async imageUrl(assetId: string): Promise<string | null> {
    const cached = this.urls.get(assetId);
    if (cached) return cached;
    const url = await this.ctx.assets.objectUrl(assetId);
    if (url) this.urls.set(assetId, url);
    return url;
  }

  render(): void {
    const list = this.uiEntities();
    this.state.timeLimit = this.ctx.editor.project.game.timeLimit;
    const selected = new Set(this.ctx.editor.selection.ids);
    this.el.replaceChildren();
    this.items = [];
    for (const e of list) {
      const item = buildUIElement(e.id, e.ui!, { topInset: 0, resolveImage: (id) => this.imageUrl(id) });
      item.el.classList.toggle('selected', selected.has(e.id));
      if (e.ui!.type === 'text' && !e.ui!.text.trim()) item.el.classList.add('empty');
      updateUIElement(item, this.state);
      this.el.appendChild(item.el);
      this.items.push(item);
    }
    this.el.hidden = list.length === 0;
  }

  private updateSelection(): void {
    const selected = new Set(this.ctx.editor.selection.ids);
    for (const item of this.items) item.el.classList.toggle('selected', selected.has(item.id));
  }

  /** 画面座標にある UI 要素 (手前から) */
  hitTest(clientX: number, clientY: number): string | null {
    if (this.el.hidden) return null;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const r = this.items[i].el.getBoundingClientRect();
      const pad = 6;
      if (clientX >= r.left - pad && clientX <= r.right + pad && clientY >= r.top - pad && clientY <= r.bottom + pad) return this.items[i].id;
    }
    return null;
  }
}
