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
import { buildPackage, readPackage } from '../core/projectPackage';
import type { AssetReader } from '../core/projectPackage';
import { sanitizeProject } from '../core/serialization';
import { isZip } from '../core/zip';
import type { BackupInfo, BackupReason, BackupStore } from '../storage/BackupStore';
import { AUTO_BACKUP_INTERVAL_MS, MAX_BACKUPS, MemoryBackupStore } from '../storage/BackupStore';
import { downloadBlob, downloadText, pickFile, pickTextFile, safeFileName } from '../storage/fileio';
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

  /** プロジェクトごとの最後の自動バックアップの時刻 */
  private lastBackup = new Map<string, number>();

  constructor(
    readonly repo: ProjectRepository,
    private editor: Editor,
    private viewport: () => EditorViewport | null,
    private assets: AssetService,
    readonly backups: BackupStore = new MemoryBackupStore(),
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
        await this.autoBackup(project);
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
    await this.backups.removeProject(id).catch(() => undefined);
  }

  // ------------------------------------------------------------------
  // バックアップ
  // ------------------------------------------------------------------

  /** 保存のたびに呼ぶ: 前の自動バックアップから時間がたっていればバックアップする */
  private async autoBackup(project: ProjectData): Promise<void> {
    if (!this.editor.settings.autoBackup) return;
    const now = Date.now();
    let last = this.lastBackup.get(project.id);
    if (last === undefined) {
      const list = await this.backups.list(project.id).catch(() => []);
      last = list[0]?.time ?? 0;
    }
    if (now - last < AUTO_BACKUP_INTERVAL_MS) {
      this.lastBackup.set(project.id, last);
      return;
    }
    try {
      await this.backups.add(project, 'auto');
      await this.backups.prune(project.id, MAX_BACKUPS);
      this.lastBackup.set(project.id, now);
    } catch (err) {
      logger.warn('自動バックアップに失敗しました', 'バックアップ', err);
    }
  }

  /** 今の状態をバックアップする */
  async backupNow(reason: BackupReason = 'manual'): Promise<BackupInfo> {
    await this.save({ silent: true, thumbnail: false });
    const info = await this.backups.add(clone(this.editor.project), reason);
    await this.backups.prune(this.editor.project.id, MAX_BACKUPS);
    this.lastBackup.set(this.editor.project.id, info.time);
    return info;
  }

  listBackups(projectId = this.editor.project.id): Promise<BackupInfo[]> {
    return this.backups.list(projectId);
  }

  removeBackup(key: string): Promise<void> {
    return this.backups.remove(key);
  }

  /**
   * バックアップから戻す。
   * - 'replace': 今のプロジェクトをバックアップの状態に戻す (戻す前の状態もバックアップしておく)
   * - 'copy': 別のプロジェクトとして開く
   */
  async restoreBackup(key: string, mode: 'replace' | 'copy'): Promise<ProjectData | null> {
    const data = await this.backups.load(key);
    if (!data) return null;
    const p = sanitizeProject(data);
    if (this.editor.dirty) await this.save({ silent: true });
    if (mode === 'replace') {
      if (p.id !== this.editor.project.id) await this.open(p.id);
      await this.backups.add(clone(this.editor.project), 'before-restore');
      await this.backups.prune(p.id, MAX_BACKUPS);
      this.editor.loadProject(p);
      this.editor.setDirty(true);
      await this.save({ silent: true });
    } else {
      const fromId = p.id;
      p.id = createId('p');
      p.name = `${p.name} (復元)`;
      p.createdAt = Date.now();
      await this.assets.store.copyProject(fromId, p.id);
      this.editor.loadProject(p);
      await this.save({ silent: true });
    }
    return p;
  }

  // ------------------------------------------------------------------
  // パッケージ (.pocket.zip: データ + アセットのファイル本体)
  // ------------------------------------------------------------------

  private readAsset: AssetReader = async (projectId, assetId) => {
    const blob = projectId === this.editor.project.id ? await this.assets.getBlob(assetId) : await this.assets.store.get(projectId, assetId);
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  };

  /** 今のプロジェクトをパッケージにする */
  async buildPackage(): Promise<{ data: Uint8Array; missing: string[] }> {
    await this.save({ silent: true, thumbnail: false });
    const missing: string[] = [];
    const data = await buildPackage([clone(this.editor.project)], this.readAsset, missing);
    return { data, missing };
  }

  /** 保存済みのプロジェクト (開いていないもの) を書き出す */
  async exportPackageOf(id: string): Promise<string[]> {
    if (id === this.editor.project.id) return this.exportPackage();
    const p = await this.repo.load(id);
    if (!p) throw new Error('プロジェクトが見つかりません');
    const missing: string[] = [];
    const data = await buildPackage([p], this.readAsset, missing);
    downloadBlob(`${safeFileName(p.name)}.pocket.zip`, new Blob([data as BlobPart], { type: 'application/zip' }));
    return missing;
  }

  async exportPackage(): Promise<string[]> {
    const { data, missing } = await this.buildPackage();
    downloadBlob(`${safeFileName(this.editor.project.name)}.pocket.zip`, new Blob([data as BlobPart], { type: 'application/zip' }));
    return missing;
  }

  /** すべてのプロジェクトを 1 つのファイルにまとめる (端末の変更・データ消失に備える) */
  async buildAllPackage(): Promise<{ data: Uint8Array; count: number; missing: string[] }> {
    if (this.editor.dirty) await this.save({ silent: true, thumbnail: false });
    const projects: ProjectData[] = [];
    for (const m of await this.repo.list()) {
      const p = m.id === this.editor.project.id ? clone(this.editor.project) : await this.repo.load(m.id);
      if (p) projects.push(p);
    }
    const missing: string[] = [];
    const data = await buildPackage(projects, this.readAsset, missing);
    return { data, count: projects.length, missing };
  }

  async exportAllPackage(): Promise<number> {
    const { data, count } = await this.buildAllPackage();
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    downloadBlob(`pocket-engine-backup-${stamp}.zip`, new Blob([data as BlobPart], { type: 'application/zip' }));
    return count;
  }

  /**
   * パッケージを読み込む。中のプロジェクトはすべて新しいプロジェクトとして追加し (既存のものは上書きしない)、
   * 1 つだけなら開く。追加したプロジェクトを返す
   */
  async importPackage(data: Uint8Array): Promise<ProjectData[]> {
    const items = await readPackage(data);
    if (this.editor.dirty) await this.save({ silent: true });
    const added: ProjectData[] = [];
    for (const { project, assets } of items) {
      project.id = createId('p');
      for (const a of project.assets) {
        const body = assets.get(a.id);
        if (body) await this.assets.store.put(project.id, a.id, new Blob([body as BlobPart], { type: a.mime || 'application/octet-stream' }));
      }
      await this.repo.save(project, null);
      added.push(project);
    }
    if (added.length === 1) {
      this.editor.loadProject(added[0]);
      setLastProjectId(added[0].id);
      this.setState('saved');
    }
    return added;
  }

  /** ファイルを選んで読み込む (.zip パッケージ・.json のどちらも) */
  async importFromFile(): Promise<ProjectData[] | null> {
    const file = await pickFile('.zip,.json,application/zip,application/json');
    if (!file) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (isZip(bytes)) return this.importPackage(bytes);
    return [await this.importProjectText(new TextDecoder().decode(bytes))];
  }

  // ------------------------------------------------------------------
  // 保存領域
  // ------------------------------------------------------------------

  /** このプロジェクトの大きさ (データ + アセット) の目安 (バイト) */
  projectSize(p: ProjectData = this.editor.project): number {
    return JSON.stringify(p).length + p.assets.reduce((n, a) => n + (a.size || 0), 0);
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
