import { logger } from '../core/logger';
import type { BackupInfo } from '../storage/BackupStore';
import { formatBytes } from '../storage/fileio';
import { isPersisted, requestPersistence, storageEstimate } from '../storage/ProjectRepository';
import type { AppContext } from './context';
import { button, h } from './dom';
import { icon } from './icons';
import { actionSheet, confirmDialog, openModal, toast } from './overlays';

/**
 * データの管理: バックアップの一覧と復元、保存領域の表示、パッケージの読み込み / 書き出し。
 */

const REASON: Record<BackupInfo['reason'], string> = {
  auto: '自動',
  manual: '手動',
  'before-restore': '戻す前',
  'before-import': '読み込み前',
};

function when(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** バックアップの一覧 (projectId を省略すると今のプロジェクト) */
export function openBackupsModal(ctx: AppContext, projectId = ctx.editor.project.id, projectName = ctx.editor.project.name): void {
  const isCurrent = projectId === ctx.editor.project.id;
  const list = h('div', { class: 'backup-list', attrs: { 'data-testid': 'backup-list' } });
  const render = async () => {
    let items: BackupInfo[] = [];
    try {
      items = await ctx.projects.listBackups(projectId);
    } catch (err) {
      logger.error('バックアップの一覧を読めませんでした', 'バックアップ', err);
    }
    list.replaceChildren(
      ...(items.length
        ? items.map((b, i) =>
            h(
              'button',
              { class: 'backup-row', attrs: { type: 'button', 'data-testid': `backup-row-${i}` }, on: { click: () => rowMenu(b) } },
              h('span', { class: 'backup-icon', html: icon(b.reason === 'manual' ? 'save' : 'reset', 18) }),
              h('span', { class: 'backup-when', text: when(b.time) }),
              h('span', { class: 'backup-sub', text: `${REASON[b.reason]} ・ シーン ${b.sceneCount} ・ ${formatBytes(b.size)}` }),
            ),
          )
        : [h('div', { class: 'empty-state small', text: 'バックアップはまだありません。保存すると 10 分ごとに自動で作られます。' })]),
    );
  };
  const rowMenu = (b: BackupInfo) => {
    actionSheet(when(b.time), [
      {
        label: 'この状態に戻す',
        icon: 'reset',
        testId: 'backup-restore',
        disabled: !isCurrent,
        hint: isCurrent ? '戻す前の状態もバックアップされます' : 'プロジェクトを開いてから使えます',
        onSelect: async () => {
          if (!(await confirmDialog(`プロジェクトを ${when(b.time)} の状態に戻しますか？ (今の状態もバックアップしておきます)`, { title: 'バックアップから戻す', okLabel: '戻す' })))
            return;
          await ctx.projects.restoreBackup(b.key, 'replace');
          modal.close();
          toast('バックアップの状態に戻しました', 'success', 2000);
        },
      },
      {
        label: 'コピーとして開く',
        icon: 'duplicate',
        testId: 'backup-copy',
        onSelect: async () => {
          const p = await ctx.projects.restoreBackup(b.key, 'copy');
          modal.close();
          if (p) toast(`「${p.name}」として開きました`, 'success', 2000);
        },
      },
      {
        label: '削除',
        icon: 'trash',
        danger: true,
        testId: 'backup-delete',
        onSelect: async () => {
          await ctx.projects.removeBackup(b.key);
          void render();
        },
      },
    ]);
  };
  const modal = openModal({
    title: `バックアップ: ${projectName}`,
    testId: 'backups-modal',
    content: h(
      'div',
      { class: 'backups' },
      h('p', { class: 'field-note', text: '保存するたびに、前のバックアップから 10 分以上たっていれば自動でバックアップします (最大 12 個)。' }),
      isCurrent
        ? h(
            'div',
            { class: 'button-row' },
            button({
              icon: 'save',
              label: '今すぐバックアップ',
              class: 'primary',
              testId: 'backup-now',
              onClick: async () => {
                await ctx.projects.backupNow('manual');
                toast('バックアップしました', 'success', 1400);
                void render();
              },
            }),
          )
        : null,
      list,
    ),
  });
  void render();
}

/** 保存領域の使用量と「データを保護する」 */
export function storageSummary(ctx: AppContext): HTMLElement {
  const text = h('span', { class: 'storage-text', attrs: { 'data-testid': 'storage-text' } });
  const bar = h('span', { class: 'storage-bar-fill' });
  const persistBtn = button({
    icon: 'lock',
    label: 'データを保護する',
    class: 'secondary small',
    testId: 'storage-persist',
    onClick: async () => {
      const ok = await requestPersistence();
      toast(ok ? 'ブラウザがデータを勝手に消さないように設定しました' : 'このブラウザでは保護を設定できませんでした (ホーム画面に追加すると保護されやすくなります)', ok ? 'success' : 'warn', 3000);
      void update();
    },
  });
  const el = h(
    'div',
    { class: 'storage-summary', attrs: { 'data-testid': 'storage-summary' } },
    h('div', { class: 'storage-row' }, h('span', { html: icon('folder', 16) }), text),
    h('span', { class: 'storage-bar' }, bar),
    persistBtn,
  );
  const update = async () => {
    const where = { indexeddb: 'この端末のブラウザ (IndexedDB)', localstorage: 'localStorage (容量が小さい)', memory: 'メモリ (保存されません)' }[ctx.projects.repo.kind];
    const [est, persisted] = await Promise.all([storageEstimate(), isPersisted()]);
    if (est && est.quota > 0) {
      text.textContent = `${where}: ${formatBytes(est.usage)} / ${formatBytes(est.quota)}${persisted ? ' ・ 保護中' : ''}`;
      bar.style.width = `${Math.min(100, (est.usage / est.quota) * 100).toFixed(1)}%`;
    } else {
      text.textContent = `${where}${persisted ? ' ・ 保護中' : ''}`;
      bar.style.width = '0%';
    }
    persistBtn.hidden = persisted || ctx.projects.repo.kind !== 'indexeddb';
  };
  void update();
  return el;
}

/** ファイル (.zip / .json) から読み込む (結果をお知らせ) */
export async function importProjectsFromFile(ctx: AppContext): Promise<boolean> {
  try {
    const added = await ctx.projects.importFromFile();
    if (!added) return false;
    if (added.length === 1) toast(`「${added[0].name}」を読み込みました`, 'success', 2000);
    else toast(`${added.length} 個のプロジェクトを読み込みました (プロジェクト一覧から開けます)`, 'success', 3000);
    return true;
  } catch (err) {
    logger.error('読み込みに失敗しました', 'プロジェクト', err);
    toast(err instanceof Error ? err.message : '読み込みに失敗しました', 'error', 3500);
    return false;
  }
}

/** 今のプロジェクトを .pocket.zip で書き出す */
export async function exportProjectZip(ctx: AppContext): Promise<void> {
  try {
    const missing = await ctx.projects.exportPackage();
    if (missing.length) toast(`${missing.length} 個のアセットの本体が見つかりませんでした`, 'warn', 3000);
    else toast('プロジェクトを書き出しました (.pocket.zip)', 'success', 1800);
  } catch (err) {
    logger.error('書き出しに失敗しました', 'プロジェクト', err);
    toast('書き出しに失敗しました', 'error', 3000);
  }
}

/** すべてのプロジェクトを 1 つの .zip にまとめる */
export async function exportAllProjects(ctx: AppContext): Promise<void> {
  try {
    const n = await ctx.projects.exportAllPackage();
    toast(`${n} 個のプロジェクトをまとめて書き出しました`, 'success', 2200);
  } catch (err) {
    logger.error('書き出しに失敗しました', 'プロジェクト', err);
    toast('書き出しに失敗しました', 'error', 3000);
  }
}
