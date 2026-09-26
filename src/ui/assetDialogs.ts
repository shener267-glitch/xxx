import * as A from '../core/actions';
import { canPlaceAsset, entityFromAsset } from '../core/assetPlacement';
import type { ScatterOptions, ScatterPattern } from '../core/prefabs';
import { DEFAULT_SCATTER, prefabEntityCount, scatterPlacements } from '../core/prefabs';
import type { AssetEntry, EntityData, PrefabEntry } from '../core/types';
import { clone, createId } from '../core/util';
import { ensureFont, fontStack } from '../engine/fonts';
import { renderThumbnail } from '../engine/thumbnail';
import { AudioEngine } from '../runtime/AudioEngine';
import { resolveAsset } from '../engine/textures';
import type { AppContext } from './context';
import { button, h } from './dom';
import { icon } from './icons';
import { actionSheet, confirmDialog, openModal, promptDialog, toast } from './overlays';
import { fieldRow, NumberField, Select, Toggle } from './widgets';

/**
 * アセット・部品 (Prefab) の詳細画面と、置く・大量配置・Prefab 作成などの操作。
 */

export const TYPE_LABELS: Record<string, string> = { model: '3D モデル', image: '画像', audio: '音声', font: 'フォント', prefab: '部品 (Prefab)' };
export const TYPE_ICONS: Record<string, string> = { model: 'box', image: 'image', audio: 'music', font: 'font', prefab: 'duplicate' };

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ------------------------------------------------------------------
// 置く
// ------------------------------------------------------------------

/** アセットを置く (at = 画面座標。省略すると画面中央) */
export function placeAsset(ctx: AppContext, a: AssetEntry, at?: { x: number; y: number }): string | null {
  const ground = ctx.viewport.placementPoint(at);
  const e = entityFromAsset(a, ground);
  if (!e) {
    toast('このアセットは 3D ビューに置けません', 'warn');
    return null;
  }
  const [id] = A.addEntityTrees(ctx.editor, [[e]], `「${a.name}」を置く`);
  if (id) toast(`「${a.name}」を置きました`, 'success', 1400);
  return id ?? null;
}

export function placePrefab(ctx: AppContext, p: PrefabEntry, at?: { x: number; y: number }): string | null {
  const ground = ctx.viewport.placementPoint(at);
  const id = A.placePrefab(ctx.editor, p.id, ground);
  if (id) toast(`部品「${p.name}」を置きました`, 'success', 1400);
  return id;
}

// ------------------------------------------------------------------
// フォルダ選択
// ------------------------------------------------------------------

export function pickFolder(ctx: AppContext, current: string, onPick: (folder: string) => void): void {
  const folders = ctx.assets.folders();
  actionSheet('フォルダへ移動', [
    { label: '(一番上)', icon: 'folder', checked: current === '', testId: 'folder-pick-root', onSelect: () => onPick('') },
    ...folders.map((f) => ({ label: f, icon: 'folder', checked: f === current, testId: `folder-pick-${f}`, onSelect: () => onPick(f) })),
    'separator',
    {
      label: '新しいフォルダ…',
      icon: 'plus',
      testId: 'folder-pick-new',
      onSelect: () => {
        void promptDialog('新しいフォルダ', '', { okLabel: '作成', placeholder: '例: キャラクター/敵' }).then((name) => {
          const f = name ? ctx.assets.createFolder(name) : null;
          if (f) onPick(f);
        });
      },
    },
  ]);
}

// ------------------------------------------------------------------
// アセットの詳細
// ------------------------------------------------------------------

let preview: AudioEngine | null = null;

export function openAssetDetail(ctx: AppContext, a: AssetEntry): void {
  const assets = ctx.assets;
  const view = h('div', { class: 'asset-preview', attrs: { 'data-testid': 'asset-preview' } });
  switch (a.type) {
    case 'image': {
      const img = h('img', { attrs: { alt: a.name } });
      void assets.objectUrl(a.id).then((url) => url && (img.src = url));
      view.appendChild(img);
      break;
    }
    case 'model':
      view.appendChild(a.thumb ? h('img', { attrs: { src: a.thumb, alt: a.name } }) : h('span', { html: icon('box', 48) }));
      break;
    case 'audio':
      view.appendChild(
        button({
          icon: 'play',
          label: '再生',
          class: 'secondary',
          testId: 'asset-play',
          onClick: () => {
            preview ??= new AudioEngine(resolveAsset);
            preview.unlock();
            preview.play(a.id);
          },
        }),
      );
      break;
    case 'font': {
      const sample = h('div', { class: 'font-sample', text: 'あいうえお ABC 123\nゲームをつくろう！' });
      sample.style.fontFamily = fontStack(a.id);
      void ensureFont(a.id);
      view.appendChild(sample);
      break;
    }
  }
  const info: [string, string][] = [
    ['種類', TYPE_LABELS[a.type] ?? a.type],
    ['大きさ', formatSize(a.size)],
    ['フォルダ', a.folder || '(一番上)'],
    ['使用数', `${assets.usages(a.id)} か所`],
  ];
  if (a.info?.width) info.push(['画像のサイズ', `${a.info.width} × ${a.info.height}`]);
  if (a.info?.duration) info.push(['長さ', `${a.info.duration.toFixed(1)} 秒`]);
  if (a.info?.modelSize) info.push(['モデルの大きさ', a.info.modelSize.map((v) => v.toFixed(2)).join(' × ') + ' m']);
  if (a.info?.triangles) info.push(['三角形の数', a.info.triangles.toLocaleString()]);
  if (a.info?.animations?.length) info.push(['アニメーション', a.info.animations.join('、')]);
  const table = h(
    'div',
    { class: 'asset-info' },
    info.map(([k, v]) => h('div', { class: 'asset-info-row' }, h('span', { text: k }), h('b', { text: v }))),
  );
  const buttons: HTMLElement[] = [];
  let modal: { close(): void } | null = null;
  const close = () => modal?.close();
  if (canPlaceAsset(a)) {
    buttons.push(button({ icon: 'plus', label: a.type === 'audio' ? '効果音として置く' : 'シーンに置く', class: 'primary', testId: 'asset-place', onClick: () => (close(), placeAsset(ctx, a)) }));
  }
  if (a.type === 'audio') {
    buttons.push(
      button({
        icon: 'music',
        label: 'BGM にする',
        class: 'secondary',
        testId: 'asset-bgm',
        onClick: () => {
          close();
          A.setMusic(ctx.editor, { source: a.id }, 'BGM を設定');
          toast(`「${a.name}」をこのシーンの BGM にしました`, 'success');
        },
      }),
    );
  }
  buttons.push(
    button({
      icon: 'edit',
      label: '名前を変更',
      class: 'secondary',
      testId: 'asset-rename',
      onClick: () => {
        void promptDialog('名前を変更', a.name, { okLabel: '変更' }).then((name) => {
          if (name?.trim()) {
            assets.rename(a.id, name);
            close();
          }
        });
      },
    }),
    button({
      icon: 'folder',
      label: 'フォルダへ移動',
      class: 'secondary',
      testId: 'asset-move',
      onClick: () =>
        pickFolder(ctx, a.folder, (f) => {
          assets.move(a.id, f);
          close();
        }),
    }),
    button({
      icon: 'trash',
      label: '削除',
      class: 'danger-outline',
      testId: 'asset-delete',
      onClick: () => {
        const n = assets.usages(a.id);
        const msg = n > 0 ? `「${a.name}」は ${n} か所で使われています。削除すると、使っている場所からも外れます。` : `「${a.name}」を削除しますか？`;
        void confirmDialog(msg, { title: 'アセットを削除', okLabel: '削除', danger: true }).then(async (ok) => {
          if (!ok) return;
          close();
          await assets.remove(a.id);
          toast(`「${a.name}」を削除しました`, 'info');
        });
      },
    }),
  );
  modal = openModal({
    title: a.name,
    content: h('div', { class: 'asset-detail' }, view, table, h('div', { class: 'asset-actions' }, buttons)),
    testId: 'asset-detail',
  });
}

// ------------------------------------------------------------------
// 部品 (Prefab)
// ------------------------------------------------------------------

/** 選択中のオブジェクトから部品を作る (名前を聞き、小さな画像も作る) */
export async function makePrefab(ctx: AppContext, id: string): Promise<PrefabEntry | null> {
  const e = ctx.editor.scene.get(id);
  if (!e) return null;
  const name = await promptDialog('部品 (Prefab) の名前', e.name, { okLabel: '作成', maxLength: 100 });
  if (!name?.trim()) return null;
  const p = A.createPrefabFromEntity(ctx.editor, id, name.trim());
  if (!p) return null;
  // 小さな画像 (3D ビューのオブジェクトを複製して描く)
  const obj = ctx.viewport.bridge.get(id);
  if (obj) {
    const copy = obj.clone(true);
    copy.traverse((o) => {
      if (o.userData.isProxy) o.visible = false;
    });
    copy.position.set(0, 0, 0);
    const thumb = renderThumbnail(ctx.viewport.engine.renderer, copy);
    if (thumb) {
      const target = ctx.editor.project.prefabs.find((x) => x.id === p.id);
      if (target) target.thumb = thumb;
      ctx.editor.events.emit('assets-changed', undefined);
    }
  }
  toast(`部品「${p.name}」を作りました。アセットタブから何度でも置けます`, 'success', 2500);
  return p;
}

export function openPrefabDetail(ctx: AppContext, p: PrefabEntry): void {
  const ed = ctx.editor;
  let modal: { close(): void } | null = null;
  const close = () => modal?.close();
  const view = h('div', { class: 'asset-preview' }, p.thumb ? h('img', { attrs: { src: p.thumb, alt: p.name } }) : h('span', { html: icon('duplicate', 48) }));
  const placed = Object.values(ed.sceneData.entities).filter((e) => e.prefab === p.id).length;
  const info = h(
    'div',
    { class: 'asset-info' },
    [
      ['種類', '部品 (Prefab)'],
      ['オブジェクトの数', `${prefabEntityCount(p)} 個`],
      ['このシーンに置いた数', `${placed} 個`],
      ['フォルダ', p.folder || '(一番上)'],
    ].map(([k, v]) => h('div', { class: 'asset-info-row' }, h('span', { text: k }), h('b', { text: v }))),
  );
  const setList = (fn: (list: PrefabEntry[]) => PrefabEntry[], label: string) => A.setPrefabs(ed, fn(clone(ed.project.prefabs)), label);
  modal = openModal({
    title: p.name,
    testId: 'prefab-detail',
    content: h(
      'div',
      { class: 'asset-detail' },
      view,
      info,
      h(
        'div',
        { class: 'asset-actions' },
        button({ icon: 'plus', label: 'シーンに置く', class: 'primary', testId: 'prefab-place', onClick: () => (close(), placePrefab(ctx, p)) }),
        button({
          icon: 'grid',
          label: '並べて置く (大量配置)',
          class: 'secondary',
          testId: 'prefab-scatter',
          onClick: () => {
            close();
            const template = A.prefabTemplate(p).map((e) => clone(e));
            template[0].name = p.name;
            openMassPlace(ctx, { name: p.name, template, prefabId: p.id });
          },
        }),
        button({
          icon: 'duplicate',
          label: '複製',
          class: 'secondary',
          testId: 'prefab-duplicate',
          onClick: () => {
            close();
            setList((list) => {
              const src = list.find((x) => x.id === p.id)!;
              const names = list.map((x) => x.name);
              let name = `${src.name} コピー`;
              let i = 2;
              while (names.includes(name)) name = `${src.name} コピー${i++}`;
              return [...list, { ...clone(src), id: createId('pf'), name, createdAt: Date.now() }];
            }, '部品を複製');
          },
        }),
        button({
          icon: 'edit',
          label: '名前を変更',
          class: 'secondary',
          testId: 'prefab-rename',
          onClick: () => {
            void promptDialog('名前を変更', p.name, { okLabel: '変更' }).then((name) => {
              if (!name?.trim()) return;
              close();
              setList((list) => list.map((x) => (x.id === p.id ? { ...x, name: name.trim() } : x)), '部品の名前を変更');
            });
          },
        }),
        button({
          icon: 'folder',
          label: 'フォルダへ移動',
          class: 'secondary',
          onClick: () =>
            pickFolder(ctx, p.folder, (f) => {
              close();
              setList((list) => list.map((x) => (x.id === p.id ? { ...x, folder: f } : x)), '部品を移動');
            }),
        }),
        button({
          icon: 'trash',
          label: '削除',
          class: 'danger-outline',
          testId: 'prefab-delete',
          onClick: () => {
            void confirmDialog(`部品「${p.name}」を削除しますか？ (置いたオブジェクトは残ります)`, { title: '部品を削除', okLabel: '削除', danger: true }).then((ok) => {
              if (!ok) return;
              close();
              setList((list) => list.filter((x) => x.id !== p.id), '部品を削除');
            });
          },
        }),
      ),
    ),
  });
}

// ------------------------------------------------------------------
// 大量配置
// ------------------------------------------------------------------

const PATTERNS: { value: ScatterPattern; label: string }[] = [
  { value: 'grid', label: '格子 (縦 × 横)' },
  { value: 'line', label: '一列' },
  { value: 'circle', label: '円' },
  { value: 'random', label: 'ばらばら (範囲の中)' },
];

let lastScatter: ScatterOptions = { ...DEFAULT_SCATTER };

export function openMassPlace(ctx: AppContext, source: { name: string; template: EntityData[]; prefabId?: string }): void {
  const o: ScatterOptions = { ...lastScatter };
  let group = true;
  const count = h('div', { class: 'field-note', attrs: { 'data-testid': 'scatter-summary' } });
  const rows: Record<string, HTMLElement> = {};
  const num = (key: keyof ScatterOptions, label: string, step: number, min: number, max: number, hint?: string) => {
    const f = new NumberField({ step, min, max, title: label, testId: `scatter-${key}`, onChange: (v) => ((o as unknown as Record<string, number>)[key] = v, update()) });
    f.set(o[key] as number);
    rows[key] = fieldRow(label, f.el, { hint });
    return rows[key];
  };
  const pattern = new Select<ScatterPattern>({ options: PATTERNS, title: '並べ方', testId: 'scatter-pattern', onChange: (v) => ((o.pattern = v), update()) });
  pattern.set(o.pattern);
  const randRot = new Toggle({ title: 'ランダムに向きを変える', testId: 'scatter-rotate', onChange: (v) => ((o.randomRotation = v), update()) });
  randRot.set(o.randomRotation);
  const faceCenter = new Toggle({ title: '中心を向く', onChange: (v) => ((o.faceCenter = v), update()) });
  faceCenter.set(o.faceCenter);
  const groupToggle = new Toggle({ title: 'グループにまとめる', testId: 'scatter-group', onChange: (v) => (group = v) });
  groupToggle.set(group);
  rows.faceCenter = fieldRow('中心を向く', faceCenter.el);
  const body = h(
    'div',
    { class: 'scatter-form', attrs: { 'data-testid': 'scatter-form' } },
    fieldRow('並べ方', pattern.el),
    num('rows', '縦の数', 1, 1, 50),
    num('cols', '横の数', 1, 1, 50),
    num('count', '数', 1, 1, 500),
    num('spacing', '間隔', 0.5, 0.1, 100, 'm'),
    num('radius', '半径', 0.5, 0.1, 500, 'm'),
    num('width', '範囲の幅', 1, 0.5, 1000, 'm'),
    num('depth', '範囲の奥行き', 1, 0.5, 1000, 'm'),
    rows.faceCenter,
    fieldRow('向きをばらばらに', randRot.el),
    num('randomScale', '大きさのばらつき', 0.05, 0, 0.9, '0 = そろえる'),
    fieldRow('グループにまとめる', groupToggle.el, { hint: 'あとでまとめて動かせる' }),
    h('div', { class: 'button-row' }, button({ icon: 'reset', label: '並びを変える', class: 'secondary small', onClick: () => ((o.seed += 1), update()) })),
    count,
  );
  function update(): void {
    const show = (keys: string[]) => {
      for (const [k, el] of Object.entries(rows)) el.hidden = !keys.includes(k);
    };
    const common = ['randomScale'];
    switch (o.pattern) {
      case 'grid':
        show(['rows', 'cols', 'spacing', ...common]);
        break;
      case 'line':
        show(['count', 'spacing', ...common]);
        break;
      case 'circle':
        show(['count', 'radius', 'faceCenter', ...common]);
        break;
      default:
        show(['count', 'width', 'depth', ...common]);
    }
    const n = scatterPlacements(o, [0, 0, 0]).length;
    count.textContent = `${n} 個を置きます (画面の中央のまわり)`;
  }
  update();
  openModal({
    title: `「${source.name}」を並べて置く`,
    content: body,
    testId: 'scatter-modal',
    actions: [
      { label: 'キャンセル' },
      {
        label: '置く',
        kind: 'primary',
        testId: 'scatter-ok',
        onClick: () => {
          lastScatter = { ...o };
          const center = ctx.viewport.placementPoint();
          const placements = scatterPlacements(o, center);
          const ids = A.massPlace(ctx.editor, source.template, placements, { group, groupName: `${source.name} (${placements.length})`, center, prefabId: source.prefabId });
          if (ids.length) toast(`${placements.length} 個を置きました`, 'success', 1800);
        },
      },
    ],
  });
}
