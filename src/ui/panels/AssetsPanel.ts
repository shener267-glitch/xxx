import type { AppContext } from '../context';
import { h } from '../dom';
import { icon } from '../icons';
import { addFromCatalog, catalogGrid } from '../menus';

/**
 * Assets タブ。
 * Phase 1 では組み込みの基本オブジェクト (図形・ライト・カメラ) のライブラリを提供する。
 * Phase 5 で 3D モデル・画像・音声などの読み込み、フォルダ、Prefab をここに追加する。
 */
export class AssetsPanel {
  readonly el: HTMLElement;

  constructor(ctx: AppContext) {
    const upcoming: [string, string][] = [
      ['box', '3Dモデル (glTF)'],
      ['image', '画像・テクスチャ'],
      ['music', '音楽・効果音'],
      ['font', 'フォント'],
      ['film', 'アニメーション'],
      ['duplicate', 'Prefab'],
    ];
    this.el = h(
      'div',
      { class: 'panel assets-panel' },
      h('div', { class: 'panel-intro' }, h('b', { text: '基本オブジェクト' }), h('span', { text: 'タップすると画面の中央に配置します' })),
      catalogGrid((kind) => {
        if (addFromCatalog(ctx, kind)) ctx.openTab('inspector', 'half');
      }, 'asset'),
      h(
        'div',
        { class: 'upcoming' },
        h('div', { class: 'catalog-title', text: '今後のアップデートで対応' }),
        h(
          'div',
          { class: 'upcoming-grid' },
          upcoming.map(([ic, label]) => h('div', { class: 'upcoming-item' }, h('span', { html: icon(ic, 20) }), h('span', { text: label }))),
        ),
        h('p', { class: 'field-note', text: 'ファイルの読み込み・フォルダ分け・検索・プレビュー・Prefab の保存と大量配置は Phase 5 で追加予定です。' }),
      ),
    );
  }
}
