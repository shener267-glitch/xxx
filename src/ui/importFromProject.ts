import { logger } from '../core/logger';
import type { ProjectData } from '../core/types';
import { formatBytes } from '../storage/fileio';
import { TYPE_ICONS, TYPE_LABELS } from './assetDialogs';
import type { AppContext } from './context';
import { h } from './dom';
import { icon } from './icons';
import { actionSheet, openModal, toast } from './overlays';

/**
 * 他のプロジェクトのアセット・部品 (Prefab) を選んで取り込む。
 */
export async function openImportFromProject(ctx: AppContext): Promise<void> {
  const current = ctx.editor.project.id;
  const metas = (await ctx.projects.list()).filter((m) => m.id !== current);
  if (metas.length === 0) {
    toast('ほかのプロジェクトがありません', 'info', 1600);
    return;
  }
  actionSheet(
    'どのプロジェクトから取り込みますか？',
    metas.map((m) => ({
      label: m.name,
      icon: 'folder',
      testId: `ifp-project-${m.id}`,
      onSelect: () => {
        void ctx.projects.repo.load(m.id).then((p) => (p ? pickItems(ctx, p) : toast('プロジェクトを読めませんでした', 'error')));
      },
    })),
    { testId: 'ifp-projects' },
  );
}

function pickItems(ctx: AppContext, src: ProjectData): void {
  if (src.assets.length === 0 && src.prefabs.length === 0) {
    toast(`「${src.name}」にはアセットも部品もありません`, 'info', 1800);
    return;
  }
  const checked = new Set<string>();
  const row = (id: string, label: string, sub: string, iconName: string, thumb?: string) => {
    const box = h('input', { attrs: { type: 'checkbox', 'data-testid': `ifp-item-${label}` } });
    box.addEventListener('change', () => (box.checked ? checked.add(id) : checked.delete(id)));
    return h(
      'label',
      { class: 'ifp-row' },
      box,
      thumb ? h('img', { class: 'ifp-thumb', attrs: { src: thumb, alt: '' } }) : h('span', { class: 'ifp-thumb', html: icon(iconName, 20) }),
      h('span', { class: 'ifp-name' }, h('b', { text: label }), h('small', { text: sub })),
    );
  };
  const assetRows = src.assets.map((a) => row(`a:${a.id}`, a.name, `${TYPE_LABELS[a.type]} ・ ${formatBytes(a.size)}`, TYPE_ICONS[a.type] ?? 'box', a.thumb));
  const prefabRows = src.prefabs.map((p) => row(`p:${p.id}`, p.name, '部品 (Prefab) ・ 使っているアセットも取り込みます', 'duplicate', p.thumb));
  openModal({
    title: `「${src.name}」から取り込む`,
    testId: 'ifp-modal',
    content: h(
      'div',
      { class: 'ifp' },
      assetRows.length ? h('div', { class: 'catalog-title', text: 'アセット' }) : null,
      ...assetRows,
      prefabRows.length ? h('div', { class: 'catalog-title', text: '部品 (Prefab)' }) : null,
      ...prefabRows,
    ),
    actions: [
      { label: 'キャンセル' },
      {
        label: '取り込む',
        kind: 'primary',
        testId: 'ifp-ok',
        onClick: () => {
          const ids = [...checked];
          if (ids.length === 0) {
            toast('取り込むものを選んでください', 'warn', 1600);
            return false;
          }
          const assets = ids.filter((x) => x.startsWith('a:')).map((x) => x.slice(2));
          const prefabs = ids.filter((x) => x.startsWith('p:')).map((x) => x.slice(2));
          ctx.assets.importFromProject(src, assets, prefabs).then(
            (r) => toast(`アセット ${r.assets} 個・部品 ${r.prefabs} 個を取り込みました`, 'success', 2000),
            (err) => {
              logger.error('取り込みに失敗しました', 'アセット', err);
              toast('取り込みに失敗しました', 'error', 3000);
            },
          );
        },
      },
    ],
  });
}
