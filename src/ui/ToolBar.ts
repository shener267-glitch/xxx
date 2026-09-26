import type { Tool } from '../core/Editor';
import type { AppContext } from './context';
import { button, h } from './dom';

const TOOLS: { id: Tool; label: string; icon: string; key: string }[] = [
  { id: 'select', label: '選択', icon: 'pointer', key: 'Q' },
  { id: 'translate', label: '移動', icon: 'move', key: 'W' },
  { id: 'rotate', label: '回転', icon: 'rotate', key: 'E' },
  { id: 'scale', label: '拡大', icon: 'scale', key: 'R' },
];

/**
 * 下部の主要操作バー: 変形ツールの切り替えと「追加」ボタン。
 * 親指が届きやすい位置に最もよく使う操作をまとめる。
 */
export class ToolBar {
  readonly el: HTMLElement;
  private buttons = new Map<Tool, HTMLButtonElement>();

  constructor(private ctx: AppContext) {
    const ed = ctx.editor;
    const seg = h('div', { class: 'segmented tools', attrs: { role: 'radiogroup', 'aria-label': 'ツール' } });
    for (const t of TOOLS) {
      const b = button({
        icon: t.icon,
        label: t.label,
        title: `${t.label} (${t.key})`,
        class: 'seg-btn',
        testId: `tool-${t.id}`,
        onClick: () => ed.setTool(t.id),
      });
      b.setAttribute('role', 'radio');
      this.buttons.set(t.id, b);
      seg.appendChild(b);
    }
    this.el = h(
      'div',
      { class: 'toolbar' },
      seg,
      button({ icon: 'plus', label: '追加', class: 'add-btn', testId: 'add', onClick: () => ctx.showAddSheet() }),
    );
    ed.events.on('tool-changed', () => this.update());
    this.update();
  }

  private update(): void {
    for (const [id, b] of this.buttons) {
      const active = id === this.ctx.editor.tool;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', String(active));
    }
  }
}
