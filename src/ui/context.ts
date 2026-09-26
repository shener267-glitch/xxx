import type { AssetService } from '../app/AssetService';
import type { PlayController } from '../app/PlayController';
import type { ProjectService } from '../app/ProjectService';
import type { Editor } from '../core/Editor';
import type { EditorViewport } from '../engine/EditorViewport';

export type TabId = 'scene' | 'inspector' | 'events' | 'assets' | 'settings';
export type SheetState = 'closed' | 'half' | 'full';

/** 各 UI 部品が共有するアプリの機能 */
export interface AppContext {
  editor: Editor;
  viewport: EditorViewport;
  projects: ProjectService;
  assets: AssetService;
  play: PlayController;
  openTab(tab: TabId, state?: SheetState): void;
  closeSheet(): void;
  /** 画面座標を指定するとその地面の位置に追加する */
  showAddSheet(at?: { x: number; y: number }): void;
  openEntityMenu(id: string): void;
  openMainMenu(): void;
  openProjects(): void;
  showHelp(): void;
}
