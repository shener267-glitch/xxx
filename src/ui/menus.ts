import { Matrix4 } from 'three';
import * as A from '../core/actions';
import type { CatalogItem, CreateKind } from '../core/catalog';
import { CATALOG, entityIcon } from '../core/catalog';
import { logger } from '../core/logger';
import type { Vec3 } from '../core/types';
import type { AppContext } from './context';
import { h } from './dom';
import { icon } from './icons';
import type { ActionItem } from './overlays';
import { makePrefab, openMassPlace } from './assetDialogs';
import { actionSheet, confirmDialog, openModal, promptDialog, toast } from './overlays';

/**
 * 各所から呼ばれるメニュー (アクションシート / モーダル)。
 */

// ------------------------------------------------------------------
// 追加
// ------------------------------------------------------------------

const CATEGORY_LABELS: Record<CatalogItem['category'], string> = {
  shape: '3D オブジェクト',
  camera: 'カメラ',
  light: 'ライト',
  other: 'その他',
  game: 'ゲーム用オブジェクト',
  ui: '画面 UI (文字・ボタン・画像)',
  effect: 'エフェクト (パーティクル)',
};

/** カタログのカード一覧 (追加シートと Assets 画面で共用) */
export function catalogGrid(onPick: (kind: CreateKind) => void, testPrefix = 'add'): HTMLElement {
  const root = h('div', { class: 'catalog' });
  for (const cat of ['shape', 'game', 'ui', 'effect', 'light', 'camera', 'other'] as const) {
    const items = CATALOG.filter((c) => c.category === cat);
    root.appendChild(h('div', { class: 'catalog-title', text: CATEGORY_LABELS[cat] }));
    root.appendChild(
      h(
        'div',
        { class: 'catalog-grid' },
        items.map((item) =>
          h(
            'button',
            {
              class: `catalog-item cat-${cat}`,
              attrs: { type: 'button', 'data-testid': `${testPrefix}-${item.kind}`, title: item.description },
              on: { click: () => onPick(item.kind) },
            },
            h('span', { class: 'catalog-icon', html: icon(item.icon, 28) }),
            h('span', { class: 'catalog-label', text: item.label }),
            h('span', { class: 'catalog-en', text: item.english }),
          ),
        ),
      ),
    );
  }
  return root;
}

export function addFromCatalog(ctx: AppContext, kind: CreateKind, at?: { x: number; y: number }): string | null {
  const vp = ctx.viewport;
  const ground = vp.placementPoint(at);
  const probe = kind;
  let position: Vec3 | undefined;
  if (['cube', 'sphere', 'plane', 'cylinder', 'cone', 'capsule'].includes(probe)) {
    const y = probe === 'plane' ? 0 : probe === 'capsule' ? 1 : 0.5;
    position = [ground[0], y, ground[2]];
  } else if (kind === 'empty') {
    position = [ground[0], 0, ground[2]];
  }
  const id = A.addEntity(ctx.editor, kind, { position });
  if (id) {
    const name = ctx.editor.scene.get(id)?.name ?? '';
    toast(`${name}を追加しました`, 'success', 1400);
  }
  return id;
}

export function openAddSheet(ctx: AppContext, at?: { x: number; y: number }): void {
  const modal = openModal({
    title: at ? 'ここに追加' : 'オブジェクトを追加',
    className: 'add-sheet',
    testId: 'add-sheet',
    content: catalogGrid((kind) => {
      modal.close();
      addFromCatalog(ctx, kind, at);
    }),
  });
}

// ------------------------------------------------------------------
// エンティティ
// ------------------------------------------------------------------

export async function renameEntityPrompt(ctx: AppContext, id: string): Promise<void> {
  const e = ctx.editor.scene.get(id);
  if (!e) return;
  const name = await promptDialog('名前を変更', e.name, { placeholder: 'オブジェクト名' });
  if (name !== null && name.trim()) A.renameEntity(ctx.editor, id, name);
}

export function openParentPicker(ctx: AppContext, ids: string[]): void {
  const model = ctx.editor.scene;
  const list = h('div', { class: 'parent-list' });
  const modal = openModal({ title: '親を選択', content: list, testId: 'parent-picker' });
  const choose = (parent: string | null) => {
    modal.close();
    if (A.setParent(ctx.editor, ids, parent)) toast('親を変更しました', 'success', 1400);
  };
  list.appendChild(
    h(
      'button',
      { class: 'parent-row root', attrs: { type: 'button', 'data-testid': 'parent-root' }, on: { click: () => choose(null) } },
      h('span', { html: icon('layers', 18) }),
      h('span', { text: 'ルート (親なし)' }),
    ),
  );
  for (const e of model.ordered()) {
    const invalid = ids.some((id) => model.isAncestorOrSelf(id, e.id));
    list.appendChild(
      h(
        'button',
        {
          class: 'parent-row',
          style: `--depth:${model.depth(e.id)}`,
          attrs: { type: 'button', 'data-testid': `parent-${e.id}` },
          props: { disabled: invalid },
          on: { click: () => choose(e.id) },
        },
        h('span', { html: icon(entityIcon(e), 18) }),
        h('span', { text: e.name }),
      ),
    );
  }
}

/** オブジェクトの操作メニュー (長押し・「…」ボタン) */
export function openEntityMenu(ctx: AppContext, id: string): void {
  const ed = ctx.editor;
  const e = ed.scene.get(id);
  if (!e) return;
  if (!ed.selection.has(id)) ed.selection.set([id]);
  const ids = [...ed.selection.ids];
  const multi = ids.length > 1;
  const items: (ActionItem | 'separator')[] = [
    { label: '名前を変更', icon: 'edit', onSelect: () => void renameEntityPrompt(ctx, id), testId: 'menu-rename' },
    { label: '複製', icon: 'duplicate', shortcut: 'Ctrl+D', onSelect: () => A.duplicateEntities(ed, ids), testId: 'menu-duplicate' },
    {
      label: 'コピー',
      icon: 'copy',
      shortcut: 'Ctrl+C',
      onSelect: () => {
        const n = A.copyEntities(ed, ids);
        toast(`${n}個をコピーしました`, 'info', 1200);
      },
      testId: 'menu-copy',
    },
    { label: '貼り付け', icon: 'paste', shortcut: 'Ctrl+V', disabled: !A.hasClipboard(), onSelect: () => A.pasteEntities(ed), testId: 'menu-paste' },
    'separator',
    { label: multi ? `${ids.length}個をグループ化` : 'グループ化', icon: 'group', shortcut: 'Ctrl+G', onSelect: () => A.groupEntities(ed, ids), testId: 'menu-group' },
    ...(e.children.length > 0 && !multi
      ? [{ label: 'グループ解除', icon: 'ungroup', onSelect: () => A.ungroupEntity(ed, id), testId: 'menu-ungroup' } as ActionItem]
      : []),
    { label: '親を変更…', icon: 'parent', onSelect: () => openParentPicker(ctx, ids), testId: 'menu-parent' },
    ...(!multi
      ? [
          { label: '上へ移動 (並び順)', icon: 'arrowUp', onSelect: () => A.moveInSiblings(ed, id, -1) } as ActionItem,
          { label: '下へ移動 (並び順)', icon: 'arrowDown', onSelect: () => A.moveInSiblings(ed, id, 1) } as ActionItem,
        ]
      : []),
    'separator',
    { label: 'フォーカス', icon: 'focus', shortcut: 'F', onSelect: () => ed.requestFocus(ids) },
    {
      label: e.visible ? '非表示にする' : '表示する',
      icon: e.visible ? 'eyeOff' : 'eye',
      onSelect: () => A.setVisible(ed, ids, !e.visible),
      testId: 'menu-visible',
    },
    {
      label: e.locked ? 'ロック解除' : 'ロック (誤操作防止)',
      icon: e.locked ? 'unlock' : 'lock',
      onSelect: () => A.setLocked(ed, ids, !e.locked),
      testId: 'menu-lock',
    },
  ];
  if (!multi && e.kind !== 'ui') {
    items.push(
      'separator',
      { label: '部品 (Prefab) にする', icon: 'duplicate', testId: 'menu-prefab', onSelect: () => void makePrefab(ctx, id) },
      {
        label: '並べて置く (大量配置)…',
        icon: 'grid',
        testId: 'menu-scatter',
        onSelect: () => openMassPlace(ctx, { name: e.name, template: ed.scene.subtree(id), prefabId: e.prefab }),
      },
    );
    const linked = e.prefab ? ed.project.prefabs.find((p) => p.id === e.prefab) : undefined;
    if (linked) {
      items.push({
        label: `部品「${linked.name}」に反映`,
        icon: 'upload',
        testId: 'menu-prefab-update',
        onSelect: () => {
          if (A.updatePrefabFromEntity(ed, id)) toast(`部品「${linked.name}」を更新しました`, 'success', 1500);
        },
      });
    }
  }
  if (!multi && e.kind === 'mesh') {
    const isPlayer = ed.sceneData.playerId === id;
    items.push({
      label: isPlayer ? 'プレイヤー設定を解除' : 'プレイヤーにする (三人称で操作)',
      icon: 'person',
      checked: isPlayer,
      onSelect: () => A.setPlayer(ed, isPlayer ? null : id),
    });
  }
  if (!multi && e.kind === 'camera') {
    items.push(
      { label: 'メインカメラにする', icon: 'video', checked: !!e.camera?.main, onSelect: () => A.setMainCamera(ed, id) },
      {
        label: '現在の視点に合わせる',
        icon: 'target',
        onSelect: () => A.alignEntityToWorld(ed, id, new Matrix4().copy(ctx.viewport.camera.camera.matrixWorld)),
      },
    );
  }
  items.push('separator', {
    label: multi ? `${ids.length}個を削除` : '削除',
    icon: 'trash',
    danger: true,
    shortcut: 'Del',
    onSelect: () => A.deleteEntities(ed, ids),
    testId: 'menu-delete',
  });
  actionSheet(multi ? `${ids.length}個を選択中` : e.name, items, { testId: 'entity-menu' });
}

// ------------------------------------------------------------------
// シーン
// ------------------------------------------------------------------

export function openSceneSwitcher(ctx: AppContext): void {
  const ed = ctx.editor;
  const items: (ActionItem | 'separator')[] = ed.project.scenes.map((s) => ({
    label: s.name,
    icon: 'layers',
    checked: s.id === ed.sceneData.id,
    hint: s.id === ed.project.startSceneId ? '開始シーン' : `${Object.keys(s.entities).length}個`,
    onSelect: () => ed.setActiveScene(s.id),
  }));
  items.push('separator', {
    label: '新しいシーン',
    icon: 'plus',
    testId: 'scene-new',
    onSelect: () => {
      const s = A.createScene(ed);
      toast(`${s.name}を作成しました`, 'success', 1400);
    },
  });
  actionSheet('シーンを切り替え', items, { testId: 'scene-switcher' });
}

export function openSceneMenu(ctx: AppContext): void {
  const ed = ctx.editor;
  const scene = ed.sceneData;
  actionSheet(scene.name, [
    {
      label: 'シーン名を変更',
      icon: 'edit',
      onSelect: async () => {
        const name = await promptDialog('シーン名', scene.name);
        if (name) A.renameScene(ed, scene.id, name);
      },
    },
    { label: 'シーンを複製', icon: 'duplicate', onSelect: () => A.duplicateScene(ed, scene.id) },
    {
      label: '開始シーンに設定',
      icon: 'play',
      checked: ed.project.startSceneId === scene.id,
      onSelect: () => A.setStartScene(ed, scene.id),
    },
    'separator',
    { label: 'シーンを書き出し (.json)', icon: 'download', onSelect: () => ctx.projects.exportScene() },
    {
      label: 'シーンを読み込み',
      icon: 'upload',
      onSelect: () => {
        ctx.projects.importScene().then(
          (ok) => ok && toast('シーンを読み込みました', 'success'),
          (err) => toast(err instanceof Error ? err.message : '読み込みに失敗しました', 'error', 3500),
        );
      },
    },
    'separator',
    {
      label: 'シーンを削除',
      icon: 'trash',
      danger: true,
      disabled: ed.project.scenes.length <= 1,
      onSelect: async () => {
        if (await confirmDialog(`「${scene.name}」を削除しますか？この操作は元に戻せません。`, { okLabel: '削除', danger: true })) {
          A.deleteScene(ed, scene.id);
        }
      },
    },
  ]);
}

// ------------------------------------------------------------------
// メインメニュー
// ------------------------------------------------------------------

export function openMainMenu(ctx: AppContext): void {
  const p = ctx.projects;
  actionSheet(ctx.editor.project.name, [
    { label: 'プロジェクト一覧', icon: 'folder', onSelect: () => ctx.openProjects(), testId: 'menu-projects' },
    {
      label: '保存',
      icon: 'save',
      shortcut: 'Ctrl+S',
      testId: 'menu-save',
      onSelect: async () => {
        if (await p.save()) toast('保存しました', 'success', 1400);
      },
    },
    {
      label: 'プロジェクト名を変更',
      icon: 'edit',
      onSelect: async () => {
        const name = await promptDialog('プロジェクト名', ctx.editor.project.name);
        if (name) A.renameProject(ctx.editor, name);
      },
    },
    'separator',
    { label: 'プロジェクトを書き出し (.json)', icon: 'download', onSelect: () => p.exportProject(), testId: 'menu-export' },
    {
      label: 'プロジェクトを読み込み',
      icon: 'upload',
      onSelect: () => {
        p.importProject().then(
          (proj) => proj && toast(`「${proj.name}」を読み込みました`, 'success'),
          (err) => {
            logger.error('読み込みに失敗しました', 'プロジェクト', err);
            toast(err instanceof Error ? err.message : '読み込みに失敗しました', 'error', 3500);
          },
        );
      },
    },
    'separator',
    { label: '操作ガイド', icon: 'help', onSelect: () => ctx.showHelp() },
    { label: 'Pocket Engine について', icon: 'info', onSelect: () => showAbout() },
  ]);
}

export function showAbout(): void {
  openModal({
    title: 'Pocket Engine について',
    sheet: false,
    content: h(
      'div',
      { class: 'about' },
      h('p', { html: '<b>Pocket Engine</b> v0.1 (Phase 1)' }),
      h('p', { text: 'スマートフォンのブラウザだけで 3D ゲームを作って遊べるゲームエンジンです。データはすべてこの端末のブラウザ内に保存され、外部サーバーには送信されません。' }),
      h('p', { class: 'muted', text: '描画: Three.js (WebGL)' }),
    ),
    actions: [{ label: '閉じる', kind: 'primary' }],
  });
}

export function showHelp(): void {
  const row = (ic: string, title: string, desc: string) =>
    h('div', { class: 'help-row' }, h('span', { class: 'help-icon', html: icon(ic, 22) }), h('div', null, h('b', { text: title }), h('p', { text: desc })));
  openModal({
    title: '操作ガイド',
    className: 'help-modal',
    content: h(
      'div',
      { class: 'help' },
      h('div', { class: 'help-title', text: '3D ビューの操作' }),
      row('hand', '1本指でタップ', 'オブジェクトを選択。何もない所をタップすると選択解除'),
      row('rotate', '1本指でドラッグ', '何もない所: カメラを回転 / 選択中の物: 地面に沿って移動 (移動ツール時)'),
      row('move', '2本指でドラッグ', 'カメラを平行移動。ピンチでズーム、ひねると回転'),
      row('more', '長押し', 'オブジェクトのメニュー (何もない所ならその場所に追加)'),
      row('focus', 'ダブルタップ', 'オブジェクトにカメラを寄せる'),
      h('div', { class: 'help-title', text: '編集' }),
      row('move', '移動・回転・拡大', '下のツールを選び、表示される矢印・輪・箱をドラッグ'),
      row('sliders', 'インスペクター', '位置・回転・サイズ・色などを数値で変更。数値欄は左右ドラッグでも変えられます'),
      row('undo', '元に戻す / やり直し', '上部の矢印ボタン (Ctrl+Z / Ctrl+Y)'),
      h('div', { class: 'help-title', text: 'ゲーム' }),
      row('play', 'Play', '▶ でゲームを実行。■ で停止すると編集前の状態に戻ります'),
      row('gamepad', 'Play 中の操作', '一人称/三人称では画面左側をドラッグで移動、右側で視点。PC は WASD'),
      h('div', { class: 'help-title', text: 'パソコンのショートカット' }),
      h('p', { class: 'muted', text: 'Q/W/E/R: ツール切替  F: フォーカス  Del: 削除  Ctrl+D: 複製  Ctrl+C/V: コピー/貼り付け  Ctrl+G: グループ化  Ctrl+S: 保存  右ドラッグ: 平行移動' }),
    ),
    actions: [{ label: 'はじめる', kind: 'primary', testId: 'help-close' }],
  });
}
