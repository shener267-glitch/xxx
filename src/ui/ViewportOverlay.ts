import { Vector3 } from 'three';
import * as A from '../core/actions';
import { entityIcon } from '../core/catalog';
import { createId } from '../core/util';
import type { ViewPreset } from '../engine/EditorCamera';
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
    this.contextBar = h(
      'div',
      { class: 'context-bar', attrs: { 'data-testid': 'context-bar' } },
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
      button({ icon: 'duplicate', title: '複製', class: 'ctx-btn', testId: 'ctx-duplicate', onClick: () => A.duplicateEntities(ed) }),
      button({
        icon: 'copy',
        title: 'コピー',
        class: 'ctx-btn',
        testId: 'ctx-copy',
        onClick: () => {
          const n = A.copyEntities(ed);
          if (n) toast(`${n}個をコピーしました`, 'info', 1200);
        },
      }),
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

    this.el = h('div', { class: 'viewport-overlay' }, this.axisSvg, rail, this.banner, this.hint, this.contextBar);

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
