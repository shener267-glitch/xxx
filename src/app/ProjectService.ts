import { addSceneData } from '../core/actions';
import type { AssetService } from './AssetService';
import type { Editor } from '../core/Editor';
import { logger } from '../core/logger';
import { createProject } from '../core/project';
import type { TemplateId } from '../core/templates';
import { createProjectFromTemplate } from '../core/templates';
import { parseProjectJson, parseSceneJson, sceneToFile } from '../core/serialization';
import type { ProjectData, ProjectMeta } from '../core/types';
import { clone, createId, debounce } from '../core/util';
import type { EditorViewport } from '../engine/EditorViewport';
import { downloadText, pickTextFile, safeFileName } from '../storage/fileio';
import type { ProjectRepository } from '../storage/ProjectRepository';
import { setLastProjectId } from '../storage/ProjectRepository';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

/**
 * プロジェクトの保存・読み込み・書き出しを担当する。
 * 変更があると数秒後に自動保存し、アプリが裏に回ったとき (スマホで多い) にも保存する。
 */
export class ProjectService {
  state: SaveState = 'saved';
  private listeners = new Set<(s: SaveState) => void>();
  private saving: Promise<void> | null = null;
  private pendingSave = false;
  private autosave = debounce(() => void this.save({ silent: true }), 2500);

  constructor(
    readonly repo: ProjectRepository,
    private editor: Editor,
    private viewport: () => EditorViewport | null,
    private assets: AssetService,
  ) {
    editor.events.on('dirty-changed', (dirty) => {
      if (dirty) {
        this.setState('dirty');
        if (editor.settings.autosave && editor.mode === 'edit') this.autosave();
      }
    });
    editor.events.on('mode-changed', (mode) => {
      if (mode === 'edit' && editor.dirty && editor.settings.autosave) this.autosave();
    });
    // タブ切り替え・アプリ終了時に保存 (モバイルブラウザは予告なくタブを破棄するため)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && editor.dirty && editor.mode === 'edit') {
        this.autosave.cancel();
        void this.save({ silent: true, thumbnail: false });
      }
    });
    window.addEventListener('pagehide', () => {
      if (editor.dirty && editor.mode === 'edit') void this.save({ silent: true, thumbnail: false });
    });
  }

  onState(fn: (s: SaveState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setState(s: SaveState): void {
    if (this.state === s) return;
    this.state = s;
    for (const fn of this.listeners) fn(s);
  }

  /** 現在のプロジェクトを保存する。成功したら true */
  async save(opts: { silent?: boolean; thumbnail?: boolean } = {}): Promise<boolean> {
    if (this.editor.mode === 'play') return false;
    if (this.saving) {
      // 保存中に再度呼ばれたら、完了後にもう一度保存する
      this.pendingSave = true;
      await this.saving;
      return true;
    }
    this.autosave.cancel();
    const vp = this.viewport();
    vp?.storeCameraState();
    const project = this.editor.project;
    project.updatedAt = Date.now();
    const thumb = opts.thumbnail !== false && vp ? vp.captureThumbnail() : null;
    // 保存中の編集で dirty が立った場合に取りこぼさないよう、先に dirty を下ろす
    this.editor.setDirty(false);
    this.setState('saving');
    let ok = true;
    this.saving = (async () => {
      try {
        await this.repo.save(project, thumb);
        setLastProjectId(project.id);
      } catch (err) {
        ok = false;
        this.editor.setDirty(true);
        logger.error(`保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`, '保存', err);
      }
    })();
    await this.saving;
    this.saving = null;
    this.setState(ok ? (this.editor.dirty ? 'dirty' : 'saved') : 'error');
    if (this.pendingSave) {
      this.pendingSave = false;
      if (this.editor.dirty) return this.save(opts);
    }
    return ok;
  }

  list(): Promise<ProjectMeta[]> {
    return this.repo.list();
  }

  /** 別のプロジェクトを開く (現在のものは保存してから) */
  async open(id: string): Promise<boolean> {
    if (id === this.editor.project.id) return true;
    if (this.editor.dirty) await this.save({ silent: true });
    const p = await this.repo.load(id);
    if (!p) {
      logger.error('プロジェクトが見つかりません', 'プロジェクト');
      return false;
    }
    this.editor.loadProject(p);
    setLastProjectId(p.id);
    this.setState('saved');
    return true;
  }

  async createNew(name: string, sample = true): Promise<void> {
    if (this.editor.dirty) await this.save({ silent: true });
    const p = createProject(name, sample);
    this.editor.loadProject(p);
    await this.save({ silent: true });
  }

  /** テンプレート (遊べるゲームの見本) から新しいプロジェクトを作る */
  async createFromTemplate(template: TemplateId, name: string): Promise<void> {
    if (this.editor.dirty) await this.save({ silent: true });
    const p = createProjectFromTemplate(template, name);
    this.editor.loadProject(p);
    await this.save({ silent: true });
  }

  async duplicateCurrent(name: string): Promise<void> {
    await this.save({ silent: true });
    const p = clone(this.editor.project);
    const fromId = p.id;
    p.id = createId('p');
    p.name = name;
    p.createdAt = Date.now();
    await this.assets.store.copyProject(fromId, p.id);
    this.editor.loadProject(p);
    await this.save({ silent: true });
  }

  async remove(id: string): Promise<void> {
    await this.repo.remove(id);
    await this.assets.store.removeProject(id);
  }

  // ------------------------------------------------------------------
  // ファイル書き出し / 読み込み
  // ------------------------------------------------------------------

  /** プロジェクト (アセットを埋め込んだ JSON) の文字列を作る */
  async exportProjectText(): Promise<string> {
    this.viewport()?.storeCameraState();
    const p = this.editor.project;
    const embeddedAssets = p.assets.length > 0 ? await this.assets.embedAll() : undefined;
    return JSON.stringify(embeddedAssets ? { ...p, embeddedAssets } : p);
  }

  async exportProject(): Promise<void> {
    const text = await this.exportProjectText();
    downloadText(`${safeFileName(this.editor.project.name)}.pocket.json`, text);
  }

  /** JSON 文字列からプロジェクトを読み込み、新しいプロジェクトとして開く */
  async importProjectText(text: string): Promise<ProjectData> {
    const p = parseProjectJson(text);
    // 既存プロジェクトを上書きしないよう新しい ID を振る
    p.id = createId('p');
    const raw = JSON.parse(text) as { embeddedAssets?: Record<string, string> };
    if (raw.embeddedAssets && typeof raw.embeddedAssets === 'object') {
      await this.assets.restoreEmbedded(p.id, raw.embeddedAssets);
    }
    if (this.editor.dirty) await this.save({ silent: true });
    this.editor.loadProject(p);
    await this.save({ silent: true });
    return p;
  }

  async importProject(): Promise<ProjectData | null> {
    const file = await pickTextFile();
    if (!file) return null;
    return this.importProjectText(file.text);
  }

  exportScene(sceneId = this.editor.sceneData.id): void {
    this.viewport()?.storeCameraState();
    const scene = this.editor.findScene(sceneId);
    if (!scene) return;
    downloadText(`${safeFileName(scene.name)}.scene.json`, JSON.stringify(sceneToFile(scene)));
  }

  async importScene(): Promise<boolean> {
    const file = await pickTextFile();
    if (!file) return false;
    const scene = parseSceneJson(file.text);
    addSceneData(this.editor, scene, true);
    return true;
  }
}
