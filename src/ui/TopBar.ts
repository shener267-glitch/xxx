import type { SaveState } from '../app/ProjectService';
import type { AppContext } from './context';
import { button, h } from './dom';
import { icon } from './icons';
import { openSceneSwitcher } from './menus';
import { toast } from './overlays';

const SAVE_LABEL: Record<SaveState, string> = {
  saved: '保存済み',
  dirty: '未保存',
  saving: '保存中…',
  error: '保存失敗',
};

/**
 * 画面上部のバー: メニュー / プロジェクト・シーン名 / 保存状態 / Undo・Redo / Play。
 */
export class TopBar {
  readonly el: HTMLElement;
  private projectName: HTMLElement;
  private sceneName: HTMLElement;
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;
  private saveBtn: HTMLButtonElement;
  private playBtn: HTMLButtonElement;

  constructor(private ctx: AppContext) {
    const ed = ctx.editor;
    this.projectName = h('span', { class: 'tb-project' });
    this.sceneName = h('span', { class: 'tb-scene' });
    this.undoBtn = button({ icon: 'undo', title: '元に戻す', class: 'icon-btn', testId: 'undo', onClick: () => ed.undo() });
    this.redoBtn = button({ icon: 'redo', title: 'やり直す', class: 'icon-btn', testId: 'redo', onClick: () => ed.redo() });
    this.saveBtn = button({
      icon: 'save',
      title: '保存',
      class: 'icon-btn save-btn',
      testId: 'save',
      onClick: async () => {
        if (await ctx.projects.save()) toast('保存しました', 'success', 1400);
      },
    });
    this.playBtn = button({
      icon: 'play',
      label: 'Play',
      class: 'play-btn',
      testId: 'play',
      onClick: () => {
        if (!ctx.play.playing) ctx.play.play();
      },
    });

    this.el = h(
      'header',
      { class: 'topbar' },
      button({ icon: 'menu', title: 'メニュー', class: 'icon-btn', testId: 'main-menu', onClick: () => ctx.openMainMenu() }),
      h(
        'button',
        {
          class: 'tb-title',
          attrs: { type: 'button', 'aria-label': 'シーンを切り替え', 'data-testid': 'tb-title' },
          on: { click: () => openSceneSwitcher(ctx) },
        },
        this.projectName,
        h('span', { class: 'tb-scene-row' }, this.sceneName, h('span', { html: icon('chevronDown', 14) })),
      ),
      h('div', { class: 'tb-spacer' }),
      this.saveBtn,
      this.undoBtn,
      this.redoBtn,
      this.playBtn,
    );

    ed.events.on('history-changed', () => this.updateHistory());
    ed.events.on('project-changed', () => this.updateTitle());
    ed.events.on('scene-loaded', () => this.updateTitle());
    ctx.projects.onState((s) => this.updateSave(s));
    this.updateHistory();
    this.updateTitle();
    this.updateSave(ctx.projects.state);
  }

  private updateHistory(): void {
    const h = this.ctx.editor.history;
    this.undoBtn.disabled = !h.canUndo;
    this.redoBtn.disabled = !h.canRedo;
    this.undoBtn.title = h.undoLabel ? `元に戻す: ${h.undoLabel}` : '元に戻す';
    this.redoBtn.title = h.redoLabel ? `やり直す: ${h.redoLabel}` : 'やり直す';
  }

  private updateTitle(): void {
    const ed = this.ctx.editor;
    this.projectName.textContent = ed.project.name;
    this.sceneName.textContent = ed.sceneData.name;
    document.title = `${ed.project.name} - Pocket Engine`;
  }

  private updateSave(s: SaveState): void {
    this.saveBtn.dataset.state = s;
    this.saveBtn.title = `保存 (${SAVE_LABEL[s]})`;
    this.saveBtn.setAttribute('aria-label', `保存 (${SAVE_LABEL[s]})`);
  }
}
