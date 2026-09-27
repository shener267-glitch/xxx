import { GameExporter } from '../app/GameExporter';
import type { GameExportMode } from '../app/GameExporter';
import * as A from '../core/actions';
import { gameTitle } from '../core/gameExport';
import { logger } from '../core/logger';
import type { GameOrientation, GameQuality, GameSettings } from '../core/types';
import { formatBytes } from '../storage/fileio';
import type { AppContext } from './context';
import { button, h } from './dom';
import { icon } from './icons';
import { actionSheet, openModal, toast } from './overlays';
import { fieldRow, TextField, Toggle } from './widgets';

/**
 * 「ゲームを書き出す」画面 (Phase 10)。
 * ゲームの名前・アイコン・作者・バージョン・開始シーン・画面の向き・画質を決めて、
 * ZIP (GitHub Pages 用) / 1 つの HTML で書き出す。書き出す前に新しいタブで遊んで確かめられる。
 */

const exporters = new WeakMap<AppContext, GameExporter>();

export function gameExporter(ctx: AppContext): GameExporter {
  let ex = exporters.get(ctx);
  if (!ex) {
    ex = new GameExporter(ctx.editor, ctx.assets);
    exporters.set(ctx, ex);
  }
  return ex;
}

function segmented<T extends string>(testId: string, options: [T, string][], get: () => T, set: (v: T) => void): { el: HTMLElement; refresh: () => void } {
  const buttons = options.map(([value, label]) =>
    h('button', {
      class: 'seg-btn',
      text: label,
      attrs: { type: 'button', 'data-testid': `${testId}-${value}`, 'data-value': value },
      on: { click: () => set(value) },
    }),
  );
  const refresh = () => {
    const cur = get();
    for (const b of buttons) b.classList.toggle('active', b.dataset.value === cur);
  };
  refresh();
  return { el: h('div', { class: 'segmented ge-seg', attrs: { 'data-testid': testId } }, buttons), refresh };
}

/** 書き出して結果をお知らせする */
export async function exportGame(ctx: AppContext, mode: GameExportMode): Promise<boolean> {
  const t = toast(mode === 'zip' ? 'ゲームを書き出しています…' : 'HTML を作っています…', 'info', 30_000);
  try {
    const r = await gameExporter(ctx).export(mode);
    t.close();
    if (r.missing.length) toast(`${r.missing.length} 個のアセットの中身が見つからなかったため、入れずに書き出しました`, 'warn', 4000);
    else toast(`「${r.filename}」を書き出しました (${formatBytes(r.size)})`, 'success', 2500);
    return true;
  } catch (err) {
    t.close();
    logger.error('ゲームを書き出せませんでした', '書き出し', err);
    toast(err instanceof Error ? err.message : 'ゲームを書き出せませんでした', 'error', 4000);
    return false;
  }
}

/** 書き出した状態のゲームを新しいタブで遊ぶ */
export async function previewGame(ctx: AppContext): Promise<void> {
  // ポップアップのブロックを避けるため、タップの直後にタブを開いておく
  const win = window.open('', '_blank');
  try {
    if (!(await gameExporter(ctx).preview(win))) toast('新しいタブを開けませんでした (ポップアップを許可してください)', 'warn', 3500);
  } catch (err) {
    win?.close();
    logger.error('ゲームを開けませんでした', '書き出し', err);
    toast(err instanceof Error ? err.message : 'ゲームを開けませんでした', 'error', 4000);
  }
}

export function openGameExportModal(ctx: AppContext): void {
  const ed = ctx.editor;
  const g = () => ed.project.game;
  const set = (patch: Partial<GameSettings>, label: string, key?: string) => A.setGameSettings(ed, patch, label, key);
  const refreshers: (() => void)[] = [];

  // 見た目 (アイコンと名前)
  const iconBox = h('span', { class: 'ge-icon', attrs: { 'data-testid': 'ge-icon-preview' } });
  const nameEl = h('b', { class: 'ge-name' });
  const subEl = h('span', { class: 'ge-sub' });
  let iconUrl: string | null = null;
  const refreshHeader = () => {
    const game = g();
    nameEl.textContent = gameTitle(game, ed.project.name);
    subEl.textContent = [game.author ? `作: ${game.author}` : '', game.version ? `v${game.version}` : ''].filter(Boolean).join(' ・ ') || 'Pocket Engine のゲーム';
    iconBox.style.background = game.titleBackground;
    const a = ctx.assets.find(game.icon);
    iconBox.style.backgroundImage = '';
    iconBox.textContent = a ? '' : ([...gameTitle(game, ed.project.name)][0] ?? 'G');
    if (a) {
      void ctx.assets.getBlob(a.id).then((blob) => {
        if (!blob) return;
        if (iconUrl) URL.revokeObjectURL(iconUrl);
        iconUrl = URL.createObjectURL(blob);
        iconBox.style.backgroundImage = `url("${iconUrl}")`;
      });
    }
  };
  refreshers.push(refreshHeader);

  const title = new TextField({ title: 'ゲームの名前', testId: 'ge-title', maxLength: 60, onChange: (v) => set({ title: v }, 'ゲームの名前を変更') });
  const author = new TextField({ title: '作者', testId: 'ge-author', maxLength: 60, placeholder: '(なし)', onChange: (v) => set({ author: v }, '作者を変更') });
  const version = new TextField({ title: 'バージョン', testId: 'ge-version', maxLength: 20, onChange: (v) => set({ version: v }, 'バージョンを変更') });
  const desc = new TextField({ title: '説明', testId: 'ge-description', maxLength: 300, placeholder: '(サブタイトルを使う)', onChange: (v) => set({ description: v }, '説明を変更') });
  refreshers.push(() => {
    title.set(g().title);
    author.set(g().author);
    version.set(g().version);
    desc.set(g().description);
  });

  // アイコン (画像アセットから選ぶ)
  const iconBtn = h('button', {
    class: 'tex-field',
    attrs: { type: 'button', 'data-testid': 'ge-icon' },
    on: {
      click: () => {
        const images = ctx.assets.byType('image');
        actionSheet('ゲームのアイコン', [
          {
            label: '画像を読み込む…',
            icon: 'upload',
            testId: 'ge-icon-import',
            onSelect: () => {
              void ctx.assets.pickAndImport('image', '', false).then(({ added, errors }) => {
                errors.forEach((e) => toast(e, 'error', 3500));
                if (added[0]) set({ icon: added[0].id }, 'アイコンを変更');
              });
            },
          },
          { label: 'タイトルの 1 文字目から作る', icon: 'font', testId: 'ge-icon-auto', checked: !g().icon, onSelect: () => set({ icon: null }, 'アイコンを変更') },
          ...(images.length ? (['separator'] as const) : []),
          ...images.map((a) => ({ label: a.name, icon: 'image', checked: a.id === g().icon, onSelect: () => set({ icon: a.id }, 'アイコンを変更') })),
        ]);
      },
    },
  });
  refreshers.push(() => {
    const a = ctx.assets.find(g().icon);
    iconBtn.replaceChildren(h('span', { class: 'tex-thumb', html: a ? '' : icon('font', 18) }), h('span', { class: 'tex-name', text: a ? a.name : 'タイトルから作る' }));
    const thumb = iconBtn.firstElementChild as HTMLElement;
    if (a?.thumb) thumb.style.backgroundImage = `url(${a.thumb})`;
  });

  // 開始シーン
  const sceneSel = h('select', { class: 'select', attrs: { 'aria-label': '最初のシーン', 'data-testid': 'ge-start-scene' } });
  sceneSel.addEventListener('change', () => A.setStartScene(ed, sceneSel.value));
  refreshers.push(() => {
    sceneSel.replaceChildren(...ed.project.scenes.map((s) => h('option', { text: s.name, props: { value: s.id } })));
    sceneSel.value = ed.project.startSceneId;
  });

  const orientation = segmented<GameOrientation>(
    'ge-orientation',
    [
      ['any', '自由'],
      ['portrait', '縦'],
      ['landscape', '横'],
    ],
    () => g().orientation,
    (v) => set({ orientation: v }, '画面の向きを変更'),
  );
  const quality = segmented<GameQuality>(
    'ge-quality',
    [
      ['auto', '自動'],
      ['low', '低'],
      ['medium', '中'],
      ['high', '高'],
    ],
    () => g().quality,
    (v) => set({ quality: v }, '画質を変更'),
  );
  refreshers.push(orientation.refresh, quality.refresh);
  const fromTitle = new Toggle({ title: 'タイトル画面から始める', testId: 'ge-start-title', onChange: (v) => set({ startFromTitle: v }, v ? 'タイトル画面から始める' : 'すぐにゲームを始める') });
  refreshers.push(() => fromTitle.set(g().startFromTitle));

  const size = h('span', { class: 'ge-size', attrs: { 'data-testid': 'ge-size' } });
  const exporter = gameExporter(ctx);
  refreshers.push(() => {
    size.textContent = `おおよそ ${formatBytes(exporter.estimateSize())} ・ アセット ${ed.project.assets.length} 個 ・ シーン ${ed.project.scenes.length} 個`;
  });

  const refresh = () => refreshers.forEach((fn) => fn());
  refresh();
  const unsub = ed.events.on('project-changed', refresh);
  const unsubHistory = ed.events.on('history-changed', refresh);

  const busy = (b: HTMLButtonElement, fn: () => Promise<unknown>) => async () => {
    if (b.disabled) return;
    b.disabled = true;
    try {
      await fn();
    } finally {
      b.disabled = false;
    }
  };
  const zipBtn = button({ icon: 'download', label: 'ZIP で書き出す', class: 'primary', testId: 'ge-export-zip', onClick: () => undefined });
  zipBtn.addEventListener('click', busy(zipBtn, () => exportGame(ctx, 'zip')));
  const htmlBtn = button({ icon: 'download', label: 'HTML 1 つで書き出す', class: 'secondary', testId: 'ge-export-html', onClick: () => undefined });
  htmlBtn.addEventListener('click', busy(htmlBtn, () => exportGame(ctx, 'html')));
  const previewBtn = button({ icon: 'play', label: '新しいタブで遊ぶ', class: 'secondary', testId: 'ge-preview', onClick: () => void previewGame(ctx) });

  openModal({
    title: 'ゲームを書き出す',
    testId: 'game-export-modal',
    className: 'game-export',
    onClose: () => {
      unsub();
      unsubHistory();
      if (iconUrl) URL.revokeObjectURL(iconUrl);
    },
    content: h(
      'div',
      { class: 'ge' },
      h('div', { class: 'ge-card' }, iconBox, h('div', { class: 'ge-card-text' }, nameEl, subEl)),
      h(
        'div',
        { class: 'ge-fields' },
        fieldRow('名前', title.el),
        fieldRow('アイコン', iconBtn, { hint: '正方形の画像がおすすめ' }),
        fieldRow('作者', author.el),
        fieldRow('バージョン', version.el),
        fieldRow('説明', desc.el),
        fieldRow('最初のシーン', sceneSel),
        fieldRow('画面の向き', orientation.el),
        fieldRow('画質', quality.el, { hint: '遊ぶ人が設定画面で変えられます' }),
        fieldRow('タイトル画面', fromTitle.el, { hint: 'OFF: すぐにゲームが始まる' }),
      ),
      h('div', { class: 'ge-actions' }, previewBtn, zipBtn, htmlBtn),
      size,
      h(
        'div',
        { class: 'ge-help' },
        h('b', { html: `${icon('globe', 16)} GitHub Pages で公開するには` }),
        h(
          'ol',
          {},
          h('li', { text: '「ZIP で書き出す」で保存して、ZIP を展開します' }),
          h('li', { text: '中身 (index.html など) を GitHub のリポジトリに置きます' }),
          h('li', { text: 'Settings → Pages でブランチを選ぶと、表示された URL で遊べます' }),
        ),
        h('p', { text: '1 つの HTML は、ファイルを開くだけで遊べます (メールやチャットで渡すとき向け)。どちらもインターネットにつながっていなくても動きます。' }),
      ),
    ),
  });
}
