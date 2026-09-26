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
import type { Storage } from '../storage/ProjectRepository';
import { BottomSheet } from './BottomSheet';
import type { AppContext, SheetState, TabId } from './context';
import { h } from './dom';
import { openAddSheet, openEntityMenu, openMainMenu, showHelp } from './menus';
import { toast } from './overlays';
import { AssetsPanel } from './panels/AssetsPanel';
import { InspectorPanel } from './panels/InspectorPanel';
import { ScenePanel } from './panels/ScenePanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { PlayHUD } from './PlayHUD';
import { openProjectsModal } from './ProjectsModal';
import { installShortcuts } from './shortcuts';
import { ToolBar } from './ToolBar';
import { TopBar } from './TopBar';
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
        const id = this.viewport.pick(x, y);
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
    this.play = new PlayController(ed, this.viewport, runtimeOverlay);
    this.sheet = new BottomSheet(this.root, main);

    const topbar = new TopBar(this);
    const toolbar = new ToolBar(this);
    const overlay = new ViewportOverlay(this);
    const hud = new PlayHUD(this);
    main.append(overlay.el, hud.el, this.sheet.el);

    this.sheet.addPanel('scene', new ScenePanel(this).el);
    this.sheet.addPanel('inspector', new InspectorPanel(this).el);
    this.sheet.addPanel('assets', new AssetsPanel(this).el);
    this.sheet.addPanel('settings', new SettingsPanel(this).el);

    this.root.append(topbar.el, main, toolbar.el, this.sheet.tabbar);

    // エディタ設定は端末に保存
    ed.events.on('settings-changed', () => saveSettings(ed.settings));
    ed.events.on('mode-changed', (mode) => {
      this.root.classList.toggle('playing', mode === 'play');
    });

    installShortcuts(this);
    logger.subscribe((entry) => {
      if (entry.level === 'error' && !entry.source?.startsWith('Play')) toast(entry.message, 'error', 4000);
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
