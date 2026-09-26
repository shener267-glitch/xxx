import { BRUSH_TOOLS } from '../core/terrain';
import type { AppContext } from './context';
import { button, h } from './dom';
import { icon } from './icons';

/**
 * 地形ブラシの操作バー (ブラシモード中だけ 3D ビューの下に出る)。
 * 道具 (盛る・下げる・なめらか・平らに)・大きさ・強さ・完了。
 */
export class TerrainBrushBar {
  readonly el: HTMLElement;
  private tools: HTMLButtonElement[];
  private size: HTMLInputElement;
  private strength: HTMLInputElement;
  private sizeText: HTMLElement;
  private strengthText: HTMLElement;

  constructor(private ctx: AppContext) {
    const brush = ctx.viewport.terrainBrush;
    this.tools = BRUSH_TOOLS.map((t) =>
      h(
        'button',
        {
          class: 'brush-tool',
          attrs: { type: 'button', 'data-testid': `brush-tool-${t.value}`, 'aria-pressed': 'false' },
          on: { click: () => brush.setSettings({ tool: t.value }) },
        },
        h('span', { html: icon(t.icon, 18) }),
        h('span', { text: t.label }),
      ),
    );
    const range = (testId: string, min: number, max: number, step: number, label: string, onInput: (v: number) => void) => {
      const input = h('input', { class: 'range', attrs: { type: 'range', min, max, step, 'aria-label': label, 'data-testid': testId } });
      input.addEventListener('input', () => onInput(Number(input.value)));
      return input;
    };
    this.size = range('brush-size', 0.5, 20, 0.5, 'ブラシの大きさ', (v) => brush.setSettings({ radius: v }));
    this.strength = range('brush-strength', 0.05, 1, 0.05, 'ブラシの強さ', (v) => brush.setSettings({ strength: v }));
    this.sizeText = h('span', { class: 'brush-value' });
    this.strengthText = h('span', { class: 'brush-value' });
    this.el = h(
      'div',
      { class: 'brush-bar', attrs: { 'data-testid': 'brush-bar', role: 'toolbar', 'aria-label': '地形ブラシ' } },
      h('div', { class: 'brush-row' }, ...this.tools),
      h(
        'div',
        { class: 'brush-row sliders' },
        h('label', { class: 'brush-slider' }, h('span', { text: '大きさ' }), this.size, this.sizeText),
        h('label', { class: 'brush-slider' }, h('span', { text: '強さ' }), this.strength, this.strengthText),
        button({ icon: 'check', label: '完了', class: 'primary small', testId: 'brush-done', onClick: () => brush.stop() }),
      ),
    );
    ctx.viewport.onBrushChange(() => this.update());
    // 選択が変わった・Play を始めたなどでブラシを終える
    ctx.editor.events.on('selection-changed', () => {
      if (brush.active && ctx.editor.selection.active !== brush.target) brush.stop();
    });
    ctx.editor.events.on('scene-loaded', () => brush.active && brush.stop());
    ctx.editor.events.on('mode-changed', () => brush.active && brush.stop());
    ctx.editor.events.on('entity-removed', (id) => {
      if (id === brush.target) brush.stop();
    });
    this.update();
  }

  private update(): void {
    const brush = this.ctx.viewport.terrainBrush;
    const s = brush.settings;
    this.el.classList.toggle('show', brush.active);
    document.querySelector('.app')?.classList.toggle('brushing', brush.active);
    BRUSH_TOOLS.forEach((t, i) => {
      this.tools[i].classList.toggle('active', s.tool === t.value);
      this.tools[i].setAttribute('aria-pressed', String(s.tool === t.value));
    });
    this.size.value = String(s.radius);
    this.strength.value = String(s.strength);
    this.sizeText.textContent = `${s.radius}m`;
    this.strengthText.textContent = `${Math.round(s.strength * 100)}%`;
  }
}
