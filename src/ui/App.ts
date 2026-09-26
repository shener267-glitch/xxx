import { AssetService } from '../app/AssetService';
import { PlayController } from '../app/PlayController';
import { ProjectService } from '../app/ProjectService';
import { Editor } from '../core/Editor';
import { logger } from '../core/logger';
import type { EditorSettings } from '../core/settings';
import { saveSettings } from '../core/settings';
import type { ProjectData } from '../core/types';
import { EditorViewport } from '../engine/EditorViewport';
import { EngineRenderer } from '../engine/EngineRenderer';
import { renderThumbnail } from '../engine/thumbnail';
import type { Storage } from '../storage/ProjectRepository';
import { BottomSheet } from './BottomSheet';
import { placeAsset } from './assetDialogs';
import type { AppContext, SheetState, TabId } from './context';
import { h } from './dom';
import { openAddSheet, openEntityMenu, openMainMenu, showHelp } from './menus';
import { toast } from './overlays';
import { AssetsPanel } from './panels/AssetsPanel';
import { EventsPanel } from './panels/EventsPanel';
import { InspectorPanel } from './panels/InspectorPanel';
import { ScenePanel } from './panels/ScenePanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { PlayHUD } from './PlayHUD';
import { openProjectsModal } from './ProjectsModal';
import { installShortcuts } from './shortcuts';
import { ToolBar } from './ToolBar';
import { TerrainBrushBar } from './TerrainBrushBar';
import { TopBar } from './TopBar';
import { UIPreview } from './UIPreview';
import { ViewportOverlay } from './ViewportOverlay';

/**
 * エディタ全体の組み立て。
 *
 * 画面構成 (縦画面):
 *   上部バー / 3D ビュー (+ 浮かぶ操作ボタン) / ツールバー / タブバー
 *   タブを押すと 3D ビューの上にボトムシートが重なって表示される。
 */
export class App implements AppContext {
  readonly editor: Editor;
  readonly engine: EngineRenderer;
  readonly viewport: EditorViewport;
  readonly projects: ProjectService;
  readonly assets: AssetService;
  readonly play: PlayController;
  readonly sheet: BottomSheet;
  readonly root: HTMLElement;
  readonly uiPreview: UIPreview;

  constructor(mount: HTMLElement, project: ProjectData, storage: Storage, settings: EditorSettings) {
    this.editor = new Editor(project, settings);
    const ed = this.editor;
    // エンジンがテクスチャなどを読む前にアセットの取得方法を登録する
    this.assets = new AssetService(storage.assets, ed);

    const viewportEl = h('div', { class: 'viewport', attrs: { 'data-testid': 'viewport' } });
    const runtimeOverlay = h('div', { class: 'runtime-overlay', attrs: { 'data-testid': 'runtime-overlay' } });
    runtimeOverlay.hidden = true;
    const main = h('main', { class: 'main' }, viewportEl, runtimeOverlay);
    this.root = h('div', { class: 'app' });
    mount.appendChild(this.root);

    this.engine = new EngineRenderer(viewportEl, { quality: settings.quality, shadows: settings.shadows });
    this.viewport = new EditorViewport(ed, this.engine, viewportEl, {
      onTap: (x, y, additive) => {
        // 画面の UI (文字・ボタンなど) のプレビューを優先して選ぶ
        const id = this.uiPreview.hitTest(x, y) ?? this.viewport.pick(x, y);
        if (id) ed.select(id, additive);
        else if (!additive && !ed.multiSelect) ed.selection.clear();
      },
      onDoubleTap: (x, y) => {
        const id = this.viewport.pick(x, y);
        if (id) {
          ed.select(id);
          ed.requestFocus([id]);
        } else {
          ed.requestFocus([]);
        }
      },
      onLongPress: (x, y) => {
        if (navigator.vibrate) navigator.vibrate(12);
        const id = this.viewport.pick(x, y);
        if (id) this.openEntityMenu(id);
        else this.showAddSheet({ x, y });
      },
    });
    this.projects = new ProjectService(storage.projects, ed, () => this.viewport, this.assets);
    // 3D モデルの小さな画像はエンジンのレンダラーで作る
    this.assets.thumbnailer = (obj) => renderThumbnail(this.engine.renderer, obj);
    this.play = new PlayController(ed, this.viewport, runtimeOverlay);
    this.sheet = new BottomSheet(this.root, main);

    const topbar = new TopBar(this);
    const toolbar = new ToolBar(this);
    const overlay = new ViewportOverlay(this);
    const brushBar = new TerrainBrushBar(this);
    const hud = new PlayHUD(this);
    this.uiPreview = new UIPreview(this);
    main.append(this.uiPreview.el, overlay.el, brushBar.el, hud.el, this.sheet.el);

    this.sheet.addPanel('scene', new ScenePanel(this).el);
    this.sheet.addPanel('inspector', new InspectorPanel(this).el);
    this.sheet.addPanel('events', new EventsPanel(this).el);
    const assetsPanel = new AssetsPanel(this);
    this.sheet.addPanel('assets', assetsPanel.el);
    this.sheet.addPanel('settings', new SettingsPanel(this).el);

    this.root.append(topbar.el, main, toolbar.el, this.sheet.tabbar);

    // エディタ設定は端末に保存
    ed.events.on('settings-changed', () => saveSettings(ed.settings));
    ed.events.on('mode-changed', (mode) => {
      this.root.classList.toggle('playing', mode === 'play');
    });

    installShortcuts(this);
    this.installFileDrop(assetsPanel);
    logger.subscribe((entry) => {
      if (entry.level === 'error' && !entry.source?.startsWith('Play')) toast(entry.message, 'error', 4000);
    });
  }

  /** PC: ファイルをウィンドウにドラッグして読み込む (3D ビューに落とすとその場所に置く) */
  private installFileDrop(panel: AssetsPanel): void {
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e) || this.editor.mode === 'play') return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      this.root.classList.add('file-over');
    });
    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) this.root.classList.remove('file-over');
    });
    window.addEventListener('drop', (e) => {
      this.root.classList.remove('file-over');
      if (!hasFiles(e) || this.editor.mode === 'play') return;
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      const overViewport = !!(e.target as Element | null)?.closest?.('[data-testid="viewport"]');
      const at = { x: e.clientX, y: e.clientY };
      void this.assets.importFiles(files, panel.currentFolder).then(({ added, errors }) => {
        errors.forEach((m) => toast(m, 'error', 4000));
        if (added.length === 0) return;
        toast(`${added.length} 個のアセットを読み込みました`, 'success', 1800);
        if (overViewport) for (const a of added) if (a.type === 'model' || a.type === 'image') placeAsset(this, a, at);
      });
    });
  }

  openTab(tab: TabId, state?: SheetState): void {
    this.sheet.open(tab, state);
  }

  closeSheet(): void {
    this.sheet.setState('closed');
  }

  showAddSheet(at?: { x: number; y: number }): void {
    openAddSheet(this, at);
  }

  openEntityMenu(id: string): void {
    openEntityMenu(this, id);
  }

  openMainMenu(): void {
    openMainMenu(this);
  }

  openProjects(): void {
    openProjectsModal(this);
  }

  showHelp(): void {
    showHelp();
  }
}
