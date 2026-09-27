import * as A from '../core/actions';
import type { AppContext } from './context';
import { button, h } from './dom';
import { actionSheet, confirmDialog, openModal, promptDialog, toast } from './overlays';

/**
 * シーンの管理: 一覧 (オブジェクトの数・開始シーン)、開く・名前変更・複製・並べ替え・開始シーン・書き出し・削除。
 */
export function openScenesModal(ctx: AppContext): void {
  const ed = ctx.editor;
  const list = h('div', { class: 'scene-manager', attrs: { 'data-testid': 'scene-manager' } });
  const render = () => {
    const scenes = ed.project.scenes;
    list.replaceChildren(
      ...scenes.map((s, i) => {
        const isStart = s.id === ed.project.startSceneId;
        const isOpen = s.id === ed.sceneData.id;
        const count = Object.keys(s.entities).length;
        return h(
          'div',
          { class: `scene-item${isOpen ? ' current' : ''}`, attrs: { 'data-testid': `scene-item-${i}` } },
          h(
            'button',
            {
              class: 'scene-item-open',
              attrs: { type: 'button', 'data-testid': `scene-open-${i}` },
              on: {
                click: () => {
                  ed.setActiveScene(s.id);
                  modal.close();
                },
              },
            },
            h('span', { class: 'scene-item-num', text: String(i + 1) }),
            h(
              'span',
              { class: 'scene-item-body' },
              h('b', { text: s.name }),
              h('small', { text: `オブジェクト ${count} ・ イベント ${s.events.length}${s.timelines.length ? ` ・ タイムライン ${s.timelines.length}` : ''}` }),
            ),
            isStart ? h('span', { class: 'tag', text: '開始' }) : null,
            isOpen ? h('span', { class: 'tag accent', text: '編集中' }) : null,
          ),
          button({ icon: 'arrowUp', title: '前へ', class: 'icon-btn small ghost', testId: `scene-up-${i}`, onClick: () => A.moveScene(ed, s.id, -1) && render() }),
          button({ icon: 'arrowDown', title: '後ろへ', class: 'icon-btn small ghost', testId: `scene-down-${i}`, onClick: () => A.moveScene(ed, s.id, 1) && render() }),
          button({
            icon: 'more',
            title: 'メニュー',
            class: 'icon-btn small ghost',
            testId: `scene-more-${i}`,
            onClick: () =>
              actionSheet(s.name, [
                {
                  label: '名前を変更',
                  icon: 'edit',
                  testId: 'sm-rename',
                  onSelect: async () => {
                    const name = await promptDialog('シーン名', s.name);
                    if (name && A.renameScene(ed, s.id, name)) render();
                  },
                },
                { label: '複製', icon: 'duplicate', testId: 'sm-duplicate', onSelect: () => (A.duplicateScene(ed, s.id), modal.close()) },
                { label: '開始シーンにする', icon: 'play', checked: isStart, testId: 'sm-start', onSelect: () => (A.setStartScene(ed, s.id), render()) },
                { label: '書き出し (.json)', icon: 'download', onSelect: () => ctx.projects.exportScene(s.id) },
                {
                  label: '削除',
                  icon: 'trash',
                  danger: true,
                  testId: 'sm-delete',
                  disabled: scenes.length <= 1,
                  hint: scenes.length <= 1 ? '最後のシーンは削除できません' : undefined,
                  onSelect: async () => {
                    if (!(await confirmDialog(`シーン「${s.name}」を削除しますか？`, { title: 'シーンを削除', okLabel: '削除', danger: true }))) return;
                    A.deleteScene(ed, s.id);
                    render();
                  },
                },
              ]),
          }),
        );
      }),
    );
  };
  const modal = openModal({
    title: 'シーンの管理',
    testId: 'scenes-modal',
    content: h(
      'div',
      null,
      h('p', { class: 'field-note', text: '「開始」のシーンからゲームが始まります。イベントの「シーンを切り替える」で移動できます。' }),
      list,
      h(
        'div',
        { class: 'button-row' },
        button({
          icon: 'plus',
          label: '新しいシーン',
          class: 'primary',
          testId: 'sm-new',
          onClick: () => {
            const s = A.createScene(ed);
            toast(`${s.name}を作成しました`, 'success', 1400);
            render();
          },
        }),
        button({
          icon: 'upload',
          label: 'シーンを読み込み',
          class: 'secondary',
          onClick: () => {
            ctx.projects.importScene().then(
              (ok) => ok && render(),
              (err) => toast(err instanceof Error ? err.message : '読み込みに失敗しました', 'error', 3000),
            );
          },
        }),
      ),
    ),
  });
  render();
}
