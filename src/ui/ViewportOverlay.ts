import { Vector3 } from 'three';
import * as A from '../core/actions';
import { entityIcon } from '../core/catalog';
import { createId } from '../core/util';
import type { ViewPreset } from '../engine/EditorCamera';
import { checkProject, countProblems } from '../core/diagnostics';
import { debounce } from '../core/util';
import { logger } from '../core/logger';
import type { AppContext } from './context';
import { button, h, setIcon } from './dom';
import { icon } from './icons';
import type { ActionItem } from './overlays';
import { actionSheet, promptDialog, toast } from './overlays';

/**
 * 3D ビューの上に重ねる UI。
 * - 右上: 軸ギズモ (タップで上・前・横からの視点に切り替え)
 * - 右側: スナップ・座標系・複数選択・フォーカス・カメラ位置保存
 * - 下部: 選択中オブジェクトの操作バー (複製・削除など)
 */
export class ViewportOverlay {
  readonly el: HTMLElement;
  private axisSvg: SVGSVGElement;
  private snapBtn: HTMLButtonElement;
  private spaceBtn: HTMLButtonElement;
  private multiBtn: HTMLButtonElement;
  private contextBar: HTMLElement;
  private ctxTools: HTMLButtonElement[] = [];
  private ctxName: HTMLElement;
  private ctxIcon: HTMLElement;
  private banner: HTMLElement;
  private hint: HTMLElement;

  constructor(private ctx: AppContext) {
    const ed = ctx.editor;
    this.axisSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.axisSvg.setAttribute('viewBox', '-40 -40 80 80');
    this.axisSvg.classList.add('axis-gizmo');
    this.axisSvg.setAttribute('data-testid', 'axis-gizmo');
    // 軸の丸をタップするとその方向からの視点にする
    this.axisSvg.addEventListener('click', (e) => {
      const node = (e.target as Element).closest<SVGGElement>('.axis-node');
      if (node?.dataset.view) this.ctx.viewport.camera.setView(node.dataset.view as ViewPreset);
    });

    this.snapBtn = button({
      icon: 'magnet',
      title: 'スナップ (グリッドに吸着)',
      class: 'rail-btn',
      testId: 'rail-snap',
      onClick: () => {
        ed.updateSettings({ snapEnabled: !ed.settings.snapEnabled });
        toast(ed.settings.snapEnabled ? `スナップ ON (${ed.settings.snapMove}m / ${ed.settings.snapRotate}°)` : 'スナップ OFF', 'info', 1200);
      },
    });
    this.spaceBtn = button({
      icon: 'globe',
      title: '座標系: ワールド',
      class: 'rail-btn',
      testId: 'rail-space',
      onClick: () => {
        ed.setSpace(ed.space === 'world' ? 'local' : 'world');
        toast(ed.space === 'world' ? '座標系: ワールド (世界の向き)' : '座標系: ローカル (物の向き)', 'info', 1200);
      },
    });
    this.multiBtn = button({
      icon: 'checkSquare',
      title: '複数選択モード',
      class: 'rail-btn',
      testId: 'rail-multi',
      onClick: () => ed.setMultiSelect(!ed.multiSelect),
    });
    const rail = h(
      'div',
      { class: 'rail' },
      this.snapBtn,
      this.spaceBtn,
      this.multiBtn,
      button({
        icon: 'focus',
        title: 'フォーカス (選択物 / 全体)',
        class: 'rail-btn',
        testId: 'rail-focus',
        onClick: () => ed.requestFocus(),
      }),
      button({ icon: 'video', title: '視点・カメラ位置の保存', class: 'rail-btn', testId: 'rail-camera', onClick: () => this.openCameraMenu() }),
    );

    // 選択中の操作バー
    this.ctxIcon = h('span', { class: 'ctx-icon' });
    this.ctxName = h('span', { class: 'ctx-name' });
    // シートを開いている間はツールバーが隠れるので、移動・回転・拡大をここで切り替える
    const toolButtons = (['translate', 'rotate', 'scale'] as const).map((tool) =>
      button({
        icon: tool === 'translate' ? 'move' : tool === 'rotate' ? 'rotate' : 'scale',
        title: tool === 'translate' ? '移動' : tool === 'rotate' ? '回転' : '拡大縮小',
        class: 'ctx-btn ctx-tool',
        testId: `ctx-tool-${tool}`,
        onClick: () => ed.setTool(tool),
      }),
    );
    this.ctxTools = toolButtons;
    this.contextBar = h(
      'div',
      { class: 'context-bar', attrs: { 'data-testid': 'context-bar' } },
      h('div', { class: 'ctx-tools', attrs: { role: 'radiogroup', 'aria-label': 'ツール' } }, toolButtons),
      h(
        'button',
        {
          class: 'ctx-chip',
          attrs: { type: 'button', 'data-testid': 'ctx-name', title: 'インスペクターを開く' },
          on: { click: () => ctx.openTab('inspector') },
        },
        this.ctxIcon,
        this.ctxName,
      ),
      button({ icon: 'focus', title: 'カメラを寄せる', class: 'ctx-btn', testId: 'ctx-focus', onClick: () => ed.requestFocus() }),
      button({ icon: 'duplicate', title: '複製', class: 'ctx-btn', testId: 'ctx-duplicate', onClick: () => A.duplicateEntities(ed) }),
      button({ icon: 'trash', title: '削除', class: 'ctx-btn ctx-danger', testId: 'ctx-delete', onClick: () => A.deleteEntities(ed) }),
      button({
        icon: 'more',
        title: 'その他の操作',
        class: 'ctx-btn',
        testId: 'ctx-more',
        onClick: () => {
          const id = ed.selection.active;
          if (id) ctx.openEntityMenu(id);
        },
      }),
    );

    this.banner = h(
      'div',
      { class: 'multi-banner', attrs: { 'data-testid': 'multi-banner' } },
      h('span', { html: icon('checkSquare', 18) }),
      h('span', { class: 'multi-text' }),
      h('button', { class: 'btn small primary', text: '完了', attrs: { type: 'button' }, on: { click: () => ed.setMultiSelect(false) } }),
    );

    this.hint = h('div', { class: 'vp-hint', text: 'タップで選択 ・ ドラッグで回転 ・ 2本指で移動 ・ ピンチでズーム' });

    // エラーが出たら左上に知らせる (タップでコンソール)
    const errorChip = h('button', {
      class: 'error-chip',
      attrs: { type: 'button', 'data-testid': 'error-chip', hidden: '' },
      on: { click: () => ctx.console.show('log', 'error') },
    });
    const updateChip = () => {
      const n = logger.unreadErrors;
      errorChip.hidden = n === 0 || ctx.console.isOpen;
      errorChip.innerHTML = `${icon('alert', 16)}<span>エラー ${n}</span>`;
    };
    logger.subscribe(() => updateChip());
    logger.onClear(() => updateChip());
    ctx.console.onChange(updateChip);

    // 「このカメラから見る」中の表示
    const previewText = h('span', { class: 'multi-text' });
    const previewBanner = h(
      'div',
      { class: 'multi-banner camera-banner', attrs: { 'data-testid': 'camera-preview-banner' } },
      h('span', { html: icon('camera', 18) }),
      previewText,
      h('button', {
        class: 'btn small primary',
        text: '戻る',
        attrs: { type: 'button', 'data-testid': 'camera-preview-exit' },
        on: { click: () => ctx.viewport.setPreviewCamera(null) },
      }),
    );
    const updatePreview = () => {
      const id = ctx.viewport.previewCameraId;
      previewBanner.classList.toggle('show', id !== null);
      previewText.textContent = id ? `カメラ「${ed.scene.get(id)?.name ?? ''}」の視点` : '';
    };
    ctx.viewport.onPreviewCameraChange(updatePreview);

    // 問題チェック: 直した方がよい設定があれば知らせる (タップでチェックの一覧)
    const problemChip = h('button', {
      class: 'problem-chip',
      attrs: { type: 'button', 'data-testid': 'problem-chip', hidden: '' },
      on: { click: () => ctx.console.show('check') },
    });
    const updateProblems = debounce(() => {
      const c = countProblems(checkProject(ed.project, ed.sceneData.id));
      const n = c.errors + c.warnings;
      problemChip.hidden = n === 0;
      problemChip.classList.toggle('has-error', c.errors > 0);
      problemChip.innerHTML = `${icon('alert', 16)}<span>${c.errors > 0 ? '問題' : '注意'} ${n}</span>`;
      problemChip.title = c.errors > 0 ? `エラー ${c.errors} 件・注意 ${c.warnings} 件` : `注意 ${c.warnings} 件`;
    }, 300);
    for (const type of ['history-changed', 'scene-loaded', 'assets-changed', 'project-changed'] as const) ed.events.on(type, updateProblems);
    updateProblems();
    // Play を始めたときにエラーがあれば知らせる (Play は続ける)
    ed.events.on('mode-changed', (mode) => {
      if (mode !== 'play') return;
      const c = countProblems(checkProject(ed.project, ed.sceneData.id));
      if (c.errors > 0) toast(`動かない設定が ${c.errors} 件あります (メニュー →「デバッグ」→「チェック」で確認)`, 'warn', 4000);
    });

    this.el = h(
      'div',
      { class: 'viewport-overlay' },
      this.axisSvg,
      rail,
      this.banner,
      previewBanner,
      this.hint,
      this.contextBar,
      h('div', { class: 'vp-chips' }, errorChip, problemChip),
    );

    const ev = ed.events;
    ev.on('selection-changed', () => this.updateContext());
    ev.on('entity-changed', (c) => {
      if (!c.transformOnly && ed.selection.has(c.id)) this.updateContext();
    });
    ev.on('tool-changed', () => this.updateToggles());
    ev.on('settings-changed', () => this.updateToggles());
    ev.on('scene-loaded', () => this.updateContext());
    ctx.viewport.onRender(() => this.updateAxis());
    this.updateToggles();
    this.updateContext();
    this.updateAxis();

    // 何もない所で重ねてテキストを長押ししないよう、ヒントは最初の操作で薄くする
    ctx.viewport.engine.canvas.addEventListener('pointerdown', () => this.hint.classList.add('faded'), { once: true });
  }

  private updateToggles(): void {
    const ed = this.ctx.editor;
    const tools = ['translate', 'rotate', 'scale'];
    this.ctxTools.forEach((b, i) => {
      const on = ed.tool === tools[i];
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    this.snapBtn.classList.toggle('active', ed.settings.snapEnabled);
    this.snapBtn.setAttribute('aria-pressed', String(ed.settings.snapEnabled));
    const local = ed.space === 'local';
    setIcon(this.spaceBtn, local ? 'local' : 'globe');
    this.spaceBtn.title = local ? '座標系: ローカル' : '座標系: ワールド';
    this.spaceBtn.classList.toggle('active', local);
    this.multiBtn.classList.toggle('active', ed.multiSelect);
    this.multiBtn.setAttribute('aria-pressed', String(ed.multiSelect));
    this.banner.classList.toggle('show', ed.multiSelect);
    this.updateContext();
  }

  private updateContext(): void {
    const ed = this.ctx.editor;
    const list = ed.selectedEntities();
    const show = list.length > 0;
    this.contextBar.classList.toggle('show', show);
    this.hint.classList.toggle('hidden', show || !ed.settings.showHints);
    const text = this.banner.querySelector('.multi-text');
    if (text) text.textContent = `複数選択: タップで追加・解除 (${list.length}個)`;
    if (!show) return;
    // 画面の UI は 3D の位置を持たないので、移動・回転・拡大とフォーカスは出さない
    this.contextBar.classList.toggle('ui-only', list.every((e) => e.kind === 'ui'));
    const active = ed.activeEntity ?? list[0];
    this.ctxIcon.innerHTML = icon(entityIcon(active), 18);
    this.ctxName.textContent = list.length > 1 ? `${list.length}個を選択` : active.name;
  }

  // ------------------------------------------------------------------
  // 軸ギズモ
  // ------------------------------------------------------------------

  private updateAxis(): void {
    const cam = this.ctx.viewport.camera.camera;
    const axes: { key: ViewPreset; neg: ViewPreset; dir: Vector3; color: string; label: string }[] = [
      { key: 'right', neg: 'left', dir: new Vector3(1, 0, 0), color: '#e5484d', label: 'X' },
      { key: 'top', neg: 'bottom', dir: new Vector3(0, 1, 0), color: '#46a758', label: 'Y' },
      { key: 'front', neg: 'back', dir: new Vector3(0, 0, 1), color: '#3e8bff', label: 'Z' },
    ];
    // カメラの逆回転で軸を画面上の向きに変換
    const inv = cam.quaternion.clone().invert();
    const items: { x: number; y: number; z: number; color: string; label: string; view: ViewPreset; positive: boolean }[] = [];
    for (const a of axes) {
      const p = a.dir.clone().applyQuaternion(inv);
      items.push({ x: p.x * 26, y: -p.y * 26, z: p.z, color: a.color, label: a.label, view: a.key, positive: true });
      items.push({ x: -p.x * 26, y: p.y * 26, z: -p.z, color: a.color, label: '', view: a.neg, positive: false });
    }
    // 奥のものから描く
    items.sort((a, b) => a.z - b.z);
    const svg = this.axisSvg;
    let html = '<circle cx="0" cy="0" r="38" class="axis-bg"/>';
    for (const it of items) {
      if (it.positive) html += `<line x1="0" y1="0" x2="${it.x.toFixed(1)}" y2="${it.y.toFixed(1)}" stroke="${it.color}" stroke-width="2.5"/>`;
    }
    for (const it of items) {
      const r = it.positive ? 8 : 6;
      html += `<g class="axis-node" data-view="${it.view}"><circle cx="${it.x.toFixed(1)}" cy="${it.y.toFixed(1)}" r="${r}" fill="${it.positive ? it.color : 'rgba(20,22,27,0.9)'}" stroke="${it.color}" stroke-width="2"/>`;
      if (it.label) html += `<text x="${it.x.toFixed(1)}" y="${(it.y + 3.5).toFixed(1)}" text-anchor="middle">${it.label}</text>`;
      html += '</g>';
    }
    svg.innerHTML = html;
  }

  // ------------------------------------------------------------------
  // カメラ位置の保存・呼び出し
  // ------------------------------------------------------------------

  private openCameraMenu(): void {
    const ed = this.ctx.editor;
    const cam = this.ctx.viewport.camera;
    const scene = ed.sceneData;
    const items: (ActionItem | 'separator')[] = [
      {
        label: '現在の視点を保存',
        icon: 'bookmark',
        testId: 'cam-save',
        onSelect: async () => {
          const name = await promptDialog('視点の名前', `視点 ${scene.bookmarks.length + 1}`);
          if (!name) return;
          scene.bookmarks.push({ id: createId('b'), name, state: cam.getState() });
          ed.markDirty();
          toast(`「${name}」を保存しました`, 'success', 1400);
        },
      },
    ];
    for (const b of scene.bookmarks) {
      items.push({
        label: b.name,
        icon: 'video',
        hint: 'タップで移動',
        onSelect: () =>
          actionSheet(b.name, [
            { label: 'この視点へ移動', icon: 'video', onSelect: () => cam.setState(b.state, true) },
            {
              label: '現在の視点で上書き',
              icon: 'save',
              onSelect: () => {
                b.state = cam.getState();
                ed.markDirty();
                toast('上書きしました', 'success', 1200);
              },
            },
            {
              label: '削除',
              icon: 'trash',
              danger: true,
              onSelect: () => {
                scene.bookmarks = scene.bookmarks.filter((x) => x.id !== b.id);
                ed.markDirty();
              },
            },
          ]),
      });
    }
    items.push(
      'separator',
      { label: '全体を表示', icon: 'focus', onSelect: () => this.ctx.viewport.focus([]) },
      { label: '上から見る', icon: 'arrowDown', onSelect: () => cam.setView('top') },
      { label: '正面から見る', icon: 'target', onSelect: () => cam.setView('front') },
      { label: '横から見る', icon: 'arrowUp', onSelect: () => cam.setView('right') },
      { label: '斜めから見る', icon: 'cube', onSelect: () => cam.setView('perspective') },
    );
    actionSheet('視点', items, { testId: 'camera-menu' });
  }
}
