import { logger } from '../core/logger';
import type { ProjectMeta } from '../core/types';
import { TEMPLATES } from '../core/templates';
import type { AppContext } from './context';
import { button, clear, h } from './dom';
import { icon } from './icons';
import { exportAllProjects, importProjectsFromFile, openBackupsModal, storageSummary } from './dataManager';
import { actionSheet, confirmDialog, openModal, promptDialog, toast } from './overlays';

function formatDate(t: number): string {
  const d = new Date(t);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今日 ${time}`;
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${time}`;
}

/**
 * プロジェクト一覧 (新規作成・開く・複製・削除・読み込み)。
 */
export function openProjectsModal(ctx: AppContext): void {
  const list = h('div', { class: 'project-list', attrs: { 'data-testid': 'project-list' } });
  const content = h(
    'div',
    { class: 'projects' },
    h(
      'div',
      { class: 'button-row' },
      button({
        icon: 'plus',
        label: '新しいプロジェクト',
        class: 'primary',
        testId: 'project-new',
        onClick: async () => {
          const name = await promptDialog('新しいプロジェクト', '新しいゲーム', { okLabel: '作成' });
          if (!name) return;
          modal.close();
          await ctx.projects.createNew(name.trim() || '新しいゲーム');
          toast(`「${name}」を作成しました`, 'success');
        },
      }),
      button({
        icon: 'gamepad',
        label: 'テンプレートから作成',
        class: 'secondary',
        testId: 'project-template',
        onClick: () => {
          actionSheet(
            'テンプレートを選ぶ',
            TEMPLATES.map((t) => ({
              label: t.label,
              hint: t.description,
              icon: t.icon,
              testId: `template-${t.id}`,
              onSelect: () => {
                void (async () => {
                  const name = await promptDialog('新しいプロジェクト', t.defaultName, { okLabel: '作成' });
                  if (!name) return;
                  modal.close();
                  await ctx.projects.createFromTemplate(t.id, name.trim() || t.defaultName);
                  toast(`「${name}」を作成しました。Play で遊べます`, 'success', 2500);
                })();
              },
            })),
          );
        },
      }),
      button({
        icon: 'upload',
        label: 'ファイルから読み込み',
        class: 'secondary',
        testId: 'project-import',
        onClick: async () => {
          if (await importProjectsFromFile(ctx)) {
            if (ctx.editor.project.id !== openedId) modal.close();
            else void load();
          }
        },
      }),
      button({
        icon: 'download',
        label: 'すべてバックアップ (.zip)',
        class: 'secondary',
        testId: 'project-export-all',
        onClick: () => void exportAllProjects(ctx),
      }),
    ),
    list,
    storageSummary(ctx),
    h('p', { class: 'field-note', text: '.pocket.zip (アセットを含む) と .json のどちらも読み込めます。すべてバックアップした .zip を読み込むと、中のプロジェクトがすべて追加されます。' }),
  );
  const openedId = ctx.editor.project.id;
  const modal = openModal({ title: 'プロジェクト', content, className: 'projects-modal', testId: 'projects-modal' });

  const render = (metas: ProjectMeta[]) => {
    clear(list);
    const currentId = ctx.editor.project.id;
    if (metas.length === 0) {
      list.appendChild(h('div', { class: 'empty-state small', text: '保存されたプロジェクトはありません' }));
    }
    for (const m of metas) {
      const isCurrent = m.id === currentId;
      const card = h(
        'div',
        { class: `project-card ${isCurrent ? 'current' : ''}`.trim(), attrs: { 'data-testid': `project-${m.id}` } },
        h(
          'button',
          {
            class: 'project-open',
            attrs: { type: 'button' },
            on: {
              click: async () => {
                if (isCurrent) {
                  modal.close();
                  return;
                }
                modal.close();
                if (await ctx.projects.open(m.id)) toast(`「${m.name}」を開きました`, 'success', 1500);
              },
            },
          },
          h('div', { class: 'project-thumb', style: m.thumbnail ? `background-image:url(${m.thumbnail})` : '' }, m.thumbnail ? null : h('span', { html: icon('cube', 32) })),
          h(
            'div',
            { class: 'project-info' },
            h('div', { class: 'project-name' }, h('span', { text: m.name }), isCurrent ? h('span', { class: 'tag', text: '編集中' }) : null),
            h('div', { class: 'project-meta', text: `${formatDate(m.updatedAt)} ・ シーン ${m.sceneCount} ・ オブジェクト ${m.entityCount}` }),
          ),
        ),
        button({
          icon: 'more',
          title: 'メニュー',
          class: 'icon-btn ghost',
          testId: `project-menu-${m.id}`,
          onClick: () =>
            actionSheet(m.name, [
              {
                label: '書き出し (.pocket.zip)',
                icon: 'download',
                testId: 'pm-export',
                onSelect: async () => {
                  try {
                    const missing = await ctx.projects.exportPackageOf(m.id);
                    toast(missing.length ? `${missing.length} 個のアセットが見つかりませんでした` : '書き出しました', missing.length ? 'warn' : 'success', 2000);
                  } catch (err) {
                    logger.error('書き出しに失敗しました', 'プロジェクト', err);
                    toast('書き出しに失敗しました', 'error', 3000);
                  }
                },
              },
              {
                label: 'バックアップ',
                icon: 'reset',
                testId: 'pm-backups',
                onSelect: () => openBackupsModal(ctx, m.id, m.name),
              },
              {
                label: '複製',
                icon: 'duplicate',
                onSelect: async () => {
                  const name = await promptDialog('複製したプロジェクトの名前', `${m.name} コピー`);
                  if (!name) return;
                  modal.close();
                  if (!isCurrent) await ctx.projects.open(m.id);
                  await ctx.projects.duplicateCurrent(name);
                  toast(`「${name}」を作成しました`, 'success');
                },
              },
              {
                label: '削除',
                icon: 'trash',
                danger: true,
                disabled: isCurrent,
                hint: isCurrent ? '編集中は削除できません' : undefined,
                onSelect: async () => {
                  if (!(await confirmDialog(`「${m.name}」を削除しますか？この操作は元に戻せません。`, { okLabel: '削除', danger: true }))) return;
                  await ctx.projects.remove(m.id);
                  toast('削除しました', 'info');
                  void ctx.projects.list().then(render);
                },
              },
            ]),
        }),
      );
      list.appendChild(card);
    }
  };

  // 開いた時点の状態を保存してから一覧を表示 (サムネイル更新のため)
  const load = async () => {
    try {
      if (ctx.editor.dirty) await ctx.projects.save({ silent: true });
      render(await ctx.projects.list());
    } catch (err) {
      logger.error('プロジェクト一覧を読み込めませんでした', 'プロジェクト', err);
    }
  };
  void load();
}
