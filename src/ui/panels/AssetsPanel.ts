import type { AssetEntry, AssetType, PrefabEntry } from '../../core/types';
import type { AppContext } from '../context';
import { formatSize, openAssetDetail, openPrefabDetail, placeAsset, placePrefab, TYPE_ICONS, TYPE_LABELS } from '../assetDialogs';
import { button, h, rafThrottle } from '../dom';
import { icon } from '../icons';
import { addFromCatalog, catalogGrid } from '../menus';
import { actionSheet, confirmDialog, promptDialog, toast } from '../overlays';
import { openImportFromProject } from '../importFromProject';

/**
 * アセットタブ: 読み込んだファイル (3D モデル・画像・音声・フォント) と部品 (Prefab)、基本オブジェクト。
 * - 検索・種類で絞り込み・フォルダ
 * - カードをタップで詳細 (プレビュー・置く・名前変更・移動・削除)
 * - カードの ⠿ (PC はカード全体) をドラッグして 3D ビューに落とすとその場所に置く
 */

type Filter = 'all' | AssetType | 'prefab';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'すべて' },
  { id: 'model', label: '3D モデル' },
  { id: 'image', label: '画像' },
  { id: 'audio', label: '音声' },
  { id: 'font', label: 'フォント' },
  { id: 'prefab', label: '部品' },
];

type Item = { kind: 'asset'; asset: AssetEntry } | { kind: 'prefab'; prefab: PrefabEntry };

export class AssetsPanel {
  readonly el: HTMLElement;
  private folder = '';
  private filter: Filter = 'all';
  private query = '';
  private body: HTMLElement;
  private search: HTMLInputElement;
  private chips: HTMLElement;
  private schedule = rafThrottle(() => this.render());

  constructor(private ctx: AppContext) {
    this.search = h('input', {
      class: 'text-input',
      attrs: { type: 'search', placeholder: 'アセットを検索', 'aria-label': 'アセットを検索', 'data-testid': 'asset-search', enterkeyhint: 'search' },
    });
    this.search.addEventListener('input', () => {
      this.query = this.search.value.trim();
      this.render();
    });
    this.chips = h('div', { class: 'chip-row', attrs: { role: 'tablist' } });
    this.body = h('div', { class: 'asset-body' });
    this.el = h(
      'div',
      { class: 'panel assets-panel', attrs: { 'data-testid': 'assets-panel' } },
      h(
        'div',
        { class: 'asset-toolbar' },
        this.search,
        button({ icon: 'upload', label: '読み込む', class: 'primary small', testId: 'asset-import', onClick: () => this.importFiles() }),
        button({ icon: 'folder', title: '新しいフォルダ', class: 'icon-btn small secondary', testId: 'asset-new-folder', onClick: () => this.newFolder() }),
        button({ icon: 'more', title: 'アセットの管理', class: 'icon-btn small secondary', testId: 'asset-menu', onClick: () => this.manageMenu() }),
      ),
      this.chips,
      this.body,
    );
    for (const type of ['assets-changed', 'project-changed'] as const) ctx.editor.events.on(type, this.schedule);
    this.render();
  }

  // ------------------------------------------------------------------

  private items(): Item[] {
    const p = this.ctx.editor.project;
    const q = this.query.toLowerCase();
    const inFolder = (f: string) => q !== '' || f === this.folder;
    const match = (name: string) => q === '' || name.toLowerCase().includes(q);
    const out: Item[] = [];
    if (this.filter !== 'prefab') {
      for (const a of p.assets) {
        if ((this.filter === 'all' || a.type === this.filter) && inFolder(a.folder) && match(a.name)) out.push({ kind: 'asset', asset: a });
      }
    }
    if (this.filter === 'all' || this.filter === 'prefab') {
      for (const pf of p.prefabs) if (inFolder(pf.folder) && match(pf.name)) out.push({ kind: 'prefab', prefab: pf });
    }
    return out.sort((a, b) => {
      const an = a.kind === 'asset' ? a.asset.name : a.prefab.name;
      const bn = b.kind === 'asset' ? b.asset.name : b.prefab.name;
      return an.localeCompare(bn, 'ja');
    });
  }

  render(): void {
    const assets = this.ctx.assets;
    // フォルダが消えていたら一番上へ
    if (this.folder && !assets.folders().includes(this.folder)) this.folder = '';
    this.chips.replaceChildren(
      ...FILTERS.map((f) =>
        h('button', {
          class: `chip${this.filter === f.id ? ' active' : ''}`,
          text: f.label,
          attrs: { type: 'button', role: 'tab', 'aria-selected': String(this.filter === f.id), 'data-testid': `asset-filter-${f.id}` },
          on: {
            click: () => {
              this.filter = f.id;
              this.render();
            },
          },
        }),
      ),
    );
    const parts: HTMLElement[] = [];
    if (!this.query) parts.push(this.breadcrumb());
    const grid = h('div', { class: 'asset-grid', attrs: { 'data-testid': 'asset-grid' } });
    if (!this.query) {
      for (const f of assets.subfolders(this.folder)) {
        const name = f.split('/').pop()!;
        grid.appendChild(
          h(
            'button',
            {
              class: 'asset-card folder',
              attrs: { type: 'button', 'data-testid': `asset-folder-${name}` },
              on: {
                click: () => {
                  this.folder = f;
                  this.render();
                },
              },
            },
            h('span', { class: 'asset-thumb', html: icon('folder', 34) }),
            h('span', { class: 'asset-name', text: name }),
          ),
        );
      }
    }
    const items = this.items();
    for (const it of items) grid.appendChild(this.card(it));
    parts.push(grid);
    if (grid.children.length === 0) {
      parts.push(
        h(
          'div',
          { class: 'hint-card' },
          h('span', { html: icon('upload', 22) }),
          h('p', {
            text: this.query
              ? `「${this.query}」に一致するものはありません`
              : '「読み込む」から 3D モデル (GLB)・画像・音声・フォントを追加できます。PC ではファイルをこの画面にドラッグしても読み込めます。オブジェクトのメニューの「部品にする」で Prefab も作れます。',
          }),
        ),
      );
    }
    parts.push(
      h('div', { class: 'catalog-title', text: '基本オブジェクト' }),
      h('p', { class: 'field-note', text: 'タップすると画面の中央に置きます' }),
      catalogGrid((kind) => {
        if (addFromCatalog(this.ctx, kind)) this.ctx.openTab('inspector', 'half');
      }, 'asset'),
    );
    this.body.replaceChildren(...parts);
  }

  private breadcrumb(): HTMLElement {
    const crumbs: HTMLElement[] = [];
    const go = (f: string) => {
      this.folder = f;
      this.render();
    };
    crumbs.push(h('button', { class: 'crumb', text: 'アセット', attrs: { type: 'button', 'data-testid': 'asset-crumb-root' }, on: { click: () => go('') } }));
    const segs = this.folder ? this.folder.split('/') : [];
    segs.forEach((seg, i) => {
      const path = segs.slice(0, i + 1).join('/');
      crumbs.push(h('span', { class: 'crumb-sep', text: '›' }), h('button', { class: 'crumb', text: seg, attrs: { type: 'button' }, on: { click: () => go(path) } }));
    });
    const bar = h('div', { class: 'breadcrumb', attrs: { 'data-testid': 'asset-breadcrumb' } }, crumbs);
    if (this.folder) {
      bar.appendChild(
        button({
          icon: 'more',
          title: 'フォルダのメニュー',
          class: 'icon-btn small ghost',
          testId: 'asset-folder-menu',
          onClick: () => this.folderMenu(),
        }),
      );
    }
    return bar;
  }

  private folderMenu(): void {
    const assets = this.ctx.assets;
    const current = this.folder;
    actionSheet(current, [
      {
        label: '名前を変更',
        icon: 'edit',
        onSelect: () => {
          const name = current.split('/').pop()!;
          void promptDialog('フォルダの名前', name, { okLabel: '変更' }).then((n) => {
            if (!n?.trim()) return;
            const parent = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '';
            const next = parent ? `${parent}/${n.trim()}` : n.trim();
            if (assets.renameFolder(current, next)) {
              this.folder = next;
              this.render();
            }
          });
        },
      },
      {
        label: 'フォルダを削除 (中身は1つ上へ)',
        icon: 'trash',
        danger: true,
        testId: 'asset-folder-delete',
        onSelect: () => {
          void confirmDialog(`フォルダ「${current}」を削除しますか？ 中のアセットは1つ上のフォルダへ移ります。`, { title: 'フォルダを削除', okLabel: '削除', danger: true }).then((ok) => {
            if (!ok) return;
            assets.deleteFolder(current);
            this.folder = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '';
            this.render();
          });
        },
      },
    ]);
  }

  private card(it: Item): HTMLElement {
    const name = it.kind === 'asset' ? it.asset.name : it.prefab.name;
    const type = it.kind === 'asset' ? it.asset.type : 'prefab';
    const thumbSrc = it.kind === 'asset' ? it.asset.thumb : it.prefab.thumb;
    const thumb = h('span', { class: `asset-thumb ${type}` });
    if (thumbSrc) thumb.appendChild(h('img', { attrs: { src: thumbSrc, alt: '', draggable: 'false' } }));
    else thumb.innerHTML = icon(TYPE_ICONS[type] ?? 'box', 30);
    const sub = it.kind === 'asset' ? `${TYPE_LABELS[type]} ・ ${formatSize(it.asset.size)}` : `${TYPE_LABELS.prefab}`;
    const placeable = it.kind === 'prefab' || it.asset.type === 'model' || it.asset.type === 'image';
    const handle = placeable ? h('span', { class: 'drag-handle', html: icon('move', 16), attrs: { 'data-testid': `asset-drag-${name}`, title: 'ドラッグして置く' } }) : null;
    const card = h(
      'div',
      { class: 'asset-card', attrs: { role: 'button', tabindex: '0', 'data-testid': `asset-card-${name}` } },
      thumb,
      h('span', { class: 'asset-name', text: name }),
      h('span', { class: 'asset-sub', text: sub }),
      handle,
    );
    const open = () => (it.kind === 'asset' ? openAssetDetail(this.ctx, it.asset) : openPrefabDetail(this.ctx, it.prefab));
    card.addEventListener('click', (e) => {
      if ((e.target as Element).closest('.drag-handle')) return;
      open();
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') open();
    });
    if (placeable) {
      const place = (x: number, y: number) => (it.kind === 'asset' ? placeAsset(this.ctx, it.asset, { x, y }) : placePrefab(this.ctx, it.prefab, { x, y }));
      this.enableDrag(handle!, name, thumbSrc, place, false);
      this.enableDrag(card, name, thumbSrc, place, true);
    }
    return card;
  }

  /** 3D ビューへドラッグして置く (mouseOnly = カード全体はマウスのときだけ) */
  private enableDrag(el: HTMLElement, name: string, thumb: string | undefined, place: (x: number, y: number) => void, mouseOnly: boolean): void {
    el.addEventListener('pointerdown', (e) => {
      if (mouseOnly && e.pointerType !== 'mouse') return;
      if (!mouseOnly) e.stopPropagation();
      if (e.button !== 0) return;
      const sx = e.clientX;
      const sy = e.clientY;
      let ghost: HTMLElement | null = null;
      const move = (ev: PointerEvent) => {
        if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return;
        if (!ghost) {
          ghost = h('div', { class: 'drag-ghost', attrs: { 'data-testid': 'drag-ghost' } }, thumb ? h('img', { attrs: { src: thumb, alt: '' } }) : null, h('span', { text: name }));
          document.body.appendChild(ghost);
          document.body.classList.add('dragging-asset');
        }
        ghost.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px)`;
        ev.preventDefault();
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (!ghost) return;
        ghost.remove();
        document.body.classList.remove('dragging-asset');
        if (ev.type === 'pointercancel') return;
        // 3D ビューの上 (シートやボタンの上ではない所) で離したら置く
        const target = document.elementFromPoint(ev.clientX, ev.clientY);
        if (target && target.closest('[data-testid="viewport"]')) {
          place(ev.clientX, ev.clientY);
          this.ctx.closeSheet();
        } else {
          toast('3D ビューの上で指を離すと置けます', 'info', 1500);
        }
      };
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  /** アセットの管理 (他のプロジェクトから取り込む・使われていないものを整理) */
  private manageMenu(): void {
    const ctx = this.ctx;
    actionSheet('アセットの管理', [
      { label: '他のプロジェクトから取り込む…', icon: 'upload', testId: 'asset-from-project', onSelect: () => void openImportFromProject(ctx) },
      {
        label: '使われていないアセットを整理…',
        icon: 'trash',
        testId: 'asset-cleanup',
        onSelect: () => {
          const unused = ctx.assets.unused();
          if (unused.length === 0) {
            toast('使われていないアセットはありません', 'info', 1600);
            return;
          }
          const names = unused.slice(0, 8).map((a) => a.name).join('、');
          void confirmDialog(`使われていないアセットが ${unused.length} 個あります (${names}${unused.length > 8 ? ' など' : ''})。削除しますか？`, {
            title: 'アセットの整理',
            okLabel: '削除',
            danger: true,
          }).then(async (ok) => {
            if (!ok) return;
            const n = await ctx.assets.removeUnused();
            toast(`${n} 個のアセットを削除しました`, 'success', 1800);
          });
        },
      },
    ]);
  }

  private importFiles(): void {
    void this.ctx.assets.pickAndImport('all', this.folder, true).then(({ added, errors }) => {
      errors.forEach((e) => toast(e, 'error', 4000));
      if (added.length) toast(`${added.length} 個のアセットを読み込みました`, 'success', 1800);
    });
  }

  private newFolder(): void {
    void promptDialog('新しいフォルダ', '', { okLabel: '作成', placeholder: '例: キャラクター' }).then((name) => {
      if (!name?.trim()) return;
      const path = this.folder ? `${this.folder}/${name.trim()}` : name.trim();
      const f = this.ctx.assets.createFolder(path);
      if (f) {
        this.folder = f;
        this.render();
      }
    });
  }

  /** 外部から (ファイルのドロップなど) 今のフォルダを知るため */
  get currentFolder(): string {
    return this.folder;
  }
}
