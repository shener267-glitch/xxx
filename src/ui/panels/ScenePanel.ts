import * as A from '../../core/actions';
import { searchEntities } from '../../core/search';
import { entityIcon } from '../../core/catalog';
import type { EntityData } from '../../core/types';
import type { AppContext } from '../context';
import { button, clear, h, onLongPress, rafThrottle } from '../dom';
import { icon } from '../icons';
import { openSceneMenu, openSceneSwitcher, renameEntityPrompt } from '../menus';

/**
 * Scene タブ: オブジェクトの階層一覧。
 * 検索・表示/非表示・ロック・名前変更・親子関係の確認ができる。
 */
export class ScenePanel {
  readonly el: HTMLElement;
  private tree: HTMLElement;
  private sceneLabel: HTMLElement;
  private search: HTMLInputElement;
  private multiBtn: HTMLButtonElement;
  private collapsed = new Set<string>();
  private query = '';
  private rows = new Map<string, HTMLElement>();
  private scheduleRebuild = rafThrottle(() => this.rebuild());
  private scheduleSelection = rafThrottle(() => this.updateSelection(true));

  constructor(private ctx: AppContext) {
    const ed = ctx.editor;
    this.sceneLabel = h('span', { class: 'scene-name' });
    this.search = h('input', {
      class: 'search-input',
      attrs: { type: 'search', placeholder: '名前・種類・動作で検索', 'aria-label': 'オブジェクトを検索', 'data-testid': 'scene-search', enterkeyhint: 'search' },
      on: {
        input: () => {
          this.query = this.search.value.trim().toLowerCase();
          this.rebuild();
        },
      },
    });
    this.multiBtn = button({
      icon: 'checkSquare',
      title: '複数選択モード',
      class: 'icon-btn toggle-btn',
      testId: 'scene-multi',
      onClick: () => ed.setMultiSelect(!ed.multiSelect),
    });
    this.tree = h('div', { class: 'tree', attrs: { role: 'tree', 'data-testid': 'scene-tree' } });

    this.el = h(
      'div',
      { class: 'panel scene-panel' },
      h(
        'div',
        { class: 'panel-toolbar' },
        h(
          'button',
          {
            class: 'scene-switch',
            attrs: { type: 'button', 'data-testid': 'scene-switch' },
            on: { click: () => openSceneSwitcher(ctx) },
          },
          h('span', { html: icon('layers', 18) }),
          this.sceneLabel,
          h('span', { class: 'chev', html: icon('chevronDown', 16) }),
        ),
        button({ icon: 'plus', title: 'オブジェクトを追加', class: 'icon-btn', onClick: () => ctx.showAddSheet(), testId: 'scene-add' }),
        button({ icon: 'more', title: 'シーンのメニュー', class: 'icon-btn', onClick: () => openSceneMenu(ctx), testId: 'scene-menu' }),
      ),
      h('div', { class: 'search-row' }, h('span', { class: 'search-icon', html: icon('search', 18) }), this.search, this.multiBtn),
      this.tree,
    );

    const ev = ed.events;
    ev.on('scene-loaded', () => {
      this.collapsed.clear();
      this.scheduleRebuild();
    });
    ev.on('entity-added', this.scheduleRebuild);
    ev.on('entity-removed', this.scheduleRebuild);
    ev.on('hierarchy-changed', this.scheduleRebuild);
    ev.on('entity-changed', (c) => {
      if (!c.transformOnly) this.scheduleRebuild();
    });
    ev.on('selection-changed', this.scheduleSelection);
    ev.on('project-changed', () => this.updateHeader());
    ev.on('environment-changed', this.scheduleRebuild);
    ev.on('tool-changed', () => {
      this.multiBtn.classList.toggle('active', ed.multiSelect);
      this.el.classList.toggle('multi', ed.multiSelect);
    });
    this.updateHeader();
    this.rebuild();
  }

  private updateHeader(): void {
    this.sceneLabel.textContent = this.ctx.editor.sceneData.name;
  }

  private rebuild(): void {
    const model = this.ctx.editor.scene;
    const scroll = this.tree.scrollTop;
    clear(this.tree);
    this.rows.clear();
    this.updateHeader();

    if (model.count === 0) {
      this.tree.appendChild(
        h(
          'div',
          { class: 'empty-state' },
          h('div', { html: icon('box', 36) }),
          h('p', { text: 'シーンは空です' }),
          button({ icon: 'plus', label: 'オブジェクトを追加', class: 'primary', onClick: () => this.ctx.showAddSheet() }),
        ),
      );
      return;
    }

    if (this.query) {
      // 検索時は一致したものを親のパス付きで平らに表示
      const hits = searchEntities(model.ordered(), this.query);
      if (hits.length === 0) {
        this.tree.appendChild(h('div', { class: 'empty-state small', text: `「${this.search.value}」に一致するオブジェクトはありません (名前・種類・動作・タグで探せます)` }));
      }
      for (const e of hits) {
        const path = model
          .ancestors(e.id)
          .reverse()
          .map((id) => model.get(id)?.name)
          .join(' / ');
        this.tree.appendChild(this.row(e, 0, path));
      }
    } else {
      const visit = (ids: string[], depth: number, parentHidden: boolean) => {
        for (const id of ids) {
          const e = model.get(id);
          if (!e) continue;
          this.tree.appendChild(this.row(e, depth, undefined, parentHidden));
          if (e.children.length > 0 && !this.collapsed.has(id)) visit(e.children, depth + 1, parentHidden || !e.visible);
        }
      };
      visit(model.data.roots, 0, false);
    }
    this.tree.scrollTop = scroll;
    this.updateSelection(false);
  }

  private row(e: EntityData, depth: number, path?: string, parentHidden = false): HTMLElement {
    const ed = this.ctx.editor;
    const hasChildren = e.children.length > 0;
    const expander = hasChildren
      ? h('button', {
          class: `tree-expander ${this.collapsed.has(e.id) ? 'collapsed' : ''}`.trim(),
          attrs: { type: 'button', 'aria-label': this.collapsed.has(e.id) ? '展開' : '折りたたむ' },
          html: icon('chevronDown', 16),
          on: {
            click: (ev) => {
              ev.stopPropagation();
              if (this.collapsed.has(e.id)) this.collapsed.delete(e.id);
              else this.collapsed.add(e.id);
              this.rebuild();
            },
          },
        })
      : h('span', { class: 'tree-expander-space' });

    const isPlayer = ed.sceneData.playerId === e.id;
    const isMainCam = e.kind === 'camera' && e.camera?.main;
    const nameEl = h(
      'span',
      { class: 'tree-name' },
      h('span', { class: 'tree-name-text', text: e.name }),
      path ? h('small', { class: 'tree-path', text: path }) : null,
    );
    const badges = h(
      'span',
      { class: 'tree-badges' },
      isPlayer ? h('span', { class: 'badge', title: 'プレイヤー', html: icon('person', 14) }) : null,
      isMainCam ? h('span', { class: 'badge', title: 'メインカメラ', html: icon('video', 14) }) : null,
      e.components.length > 0 ? h('span', { class: 'badge', title: '動作あり', html: icon('sparkles', 14) }) : null,
    );

    const eye = h('button', {
      class: `tree-btn ${e.visible ? '' : 'off'}`.trim(),
      attrs: { type: 'button', 'aria-label': e.visible ? '非表示にする' : '表示する', 'data-testid': `vis-${e.id}` },
      html: icon(e.visible ? 'eye' : 'eyeOff', 18),
      on: {
        click: (ev) => {
          ev.stopPropagation();
          A.toggleVisible(ed, e.id);
        },
      },
    });
    const lock = h('button', {
      class: `tree-btn ${e.locked ? 'on' : ''}`.trim(),
      attrs: { type: 'button', 'aria-label': e.locked ? 'ロック解除' : 'ロック', 'data-testid': `lock-${e.id}` },
      html: icon(e.locked ? 'lock' : 'unlock', 18),
      on: {
        click: (ev) => {
          ev.stopPropagation();
          A.toggleLocked(ed, e.id);
        },
      },
    });
    const more = h('button', {
      class: 'tree-btn',
      attrs: { type: 'button', 'aria-label': 'メニュー', 'data-testid': `more-${e.id}` },
      html: icon('more', 18),
      on: {
        click: (ev) => {
          ev.stopPropagation();
          this.ctx.openEntityMenu(e.id);
        },
      },
    });

    const row = h(
      'div',
      {
        class: `tree-row ${e.visible && !parentHidden ? '' : 'hidden-entity'} ${e.locked ? 'locked' : ''}`.trim(),
        style: `--depth:${depth}`,
        attrs: { role: 'treeitem', 'data-id': e.id, 'data-testid': `row-${e.id}`, tabindex: 0, 'aria-label': e.name },
        on: {
          click: (ev) => {
            const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
            ed.select(e.id, additive);
            // 検索結果から選んだら、そのオブジェクトにカメラを向ける
            if (this.query && !additive) ed.requestFocus([e.id]);
          },
          dblclick: (ev) => {
            // 目・鍵などのボタンを素早く2回押した場合は名前変更にしない
            if ((ev.target as HTMLElement).closest('button')) return;
            void renameEntityPrompt(this.ctx, e.id);
          },
          keydown: (ev) => {
            if (ev.key === 'Enter') ed.select(e.id);
            if (ev.key === 'F2') void renameEntityPrompt(this.ctx, e.id);
          },
        },
      },
      h('span', { class: 'tree-check', html: icon('check', 14) }),
      expander,
      h('span', { class: 'tree-icon', html: icon(entityIcon(e), 18) }),
      nameEl,
      badges,
      eye,
      lock,
      more,
    );
    onLongPress(row, () => this.ctx.openEntityMenu(e.id));
    this.rows.set(e.id, row);
    return row;
  }

  private updateSelection(scrollIntoView: boolean): void {
    const sel = this.ctx.editor.selection;
    for (const [id, row] of this.rows) {
      row.classList.toggle('selected', sel.has(id));
      row.classList.toggle('active', sel.active === id);
      row.setAttribute('aria-selected', String(sel.has(id)));
    }
    if (!scrollIntoView || !sel.active) return;
    // 折りたたまれた親の中で選ばれたら展開する
    const model = this.ctx.editor.scene;
    const hiddenParents = model.ancestors(sel.active).filter((id) => this.collapsed.has(id));
    if (hiddenParents.length > 0) {
      hiddenParents.forEach((id) => this.collapsed.delete(id));
      this.rebuild();
    }
    const row = this.rows.get(sel.active);
    if (row && this.el.offsetParent !== null) row.scrollIntoView({ block: 'nearest' });
  }
}
