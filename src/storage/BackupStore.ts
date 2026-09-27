import type { ProjectData } from '../core/types';

/**
 * プロジェクトのバックアップ (その時点のプロジェクトのデータを丸ごと保存)。
 * - 自動: 保存のときに、前のバックアップから時間がたっていれば作る
 * - 手動: 「今すぐバックアップ」
 * - 復元の前にも、今の状態をバックアップしておく (元に戻せるように)
 * アセットのファイル本体は共有しているので含めない (プロジェクトの書き出し ZIP には含める)。
 */

export type BackupReason = 'auto' | 'manual' | 'before-restore' | 'before-import';

export interface BackupInfo {
  key: string;
  projectId: string;
  projectName: string;
  time: number;
  reason: BackupReason;
  /** JSON の大きさ (バイト) */
  size: number;
  sceneCount: number;
}

interface BackupRecord extends BackupInfo {
  data: string;
}

export interface BackupStore {
  readonly persistent: boolean;
  list(projectId?: string): Promise<BackupInfo[]>;
  load(key: string): Promise<ProjectData | null>;
  add(project: ProjectData, reason: BackupReason): Promise<BackupInfo>;
  remove(key: string): Promise<void>;
  /** プロジェクトのバックアップをすべて消す */
  removeProject(projectId: string): Promise<void>;
  /** 古いものを消して max 個にする (手動のものは残しやすいよう後で消す) */
  prune(projectId: string, max: number): Promise<number>;
}

export const MAX_BACKUPS = 12;
/** 自動バックアップの間隔 */
export const AUTO_BACKUP_INTERVAL_MS = 10 * 60 * 1000;

function toRecord(project: ProjectData, reason: BackupReason): BackupRecord {
  const data = JSON.stringify(project);
  const time = Date.now();
  return {
    key: `${project.id}:${time.toString(36).padStart(10, '0')}:${Math.random().toString(36).slice(2, 6)}`,
    projectId: project.id,
    projectName: project.name,
    time,
    reason,
    size: data.length,
    sceneCount: project.scenes.length,
    data,
  };
}

function info(r: BackupRecord): BackupInfo {
  const { key, projectId, projectName, time, reason, size, sceneCount } = r;
  return { key, projectId, projectName, time, reason, size, sceneCount };
}

/** 消す順番: 古い自動 → 古い手動 */
function pruneOrder(list: BackupInfo[], max: number): BackupInfo[] {
  if (list.length <= max) return [];
  const byOld = [...list].sort((a, b) => a.time - b.time);
  const auto = byOld.filter((b) => b.reason !== 'manual');
  const manual = byOld.filter((b) => b.reason === 'manual');
  return [...auto, ...manual].slice(0, list.length - max);
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB エラー'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB トランザクションエラー'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB トランザクションが中断されました'));
  });
}

export class IndexedDbBackupStore implements BackupStore {
  readonly persistent = true;
  constructor(private db: IDBDatabase) {}

  async list(projectId?: string): Promise<BackupInfo[]> {
    const tx = this.db.transaction('backups', 'readonly');
    const store = tx.objectStore('backups');
    const all = (await promisify(projectId ? store.getAll(IDBKeyRange.bound(`${projectId}:`, `${projectId}:￿`)) : store.getAll())) as BackupRecord[];
    return all.map(info).sort((a, b) => b.time - a.time);
  }

  async load(key: string): Promise<ProjectData | null> {
    const tx = this.db.transaction('backups', 'readonly');
    const rec = (await promisify(tx.objectStore('backups').get(key))) as BackupRecord | undefined;
    return rec ? (JSON.parse(rec.data) as ProjectData) : null;
  }

  async add(project: ProjectData, reason: BackupReason): Promise<BackupInfo> {
    const rec = toRecord(project, reason);
    const tx = this.db.transaction('backups', 'readwrite');
    tx.objectStore('backups').put(rec);
    await txDone(tx);
    return info(rec);
  }

  async remove(key: string): Promise<void> {
    const tx = this.db.transaction('backups', 'readwrite');
    tx.objectStore('backups').delete(key);
    await txDone(tx);
  }

  async removeProject(projectId: string): Promise<void> {
    const tx = this.db.transaction('backups', 'readwrite');
    tx.objectStore('backups').delete(IDBKeyRange.bound(`${projectId}:`, `${projectId}:￿`));
    await txDone(tx);
  }

  async prune(projectId: string, max: number): Promise<number> {
    const drop = pruneOrder(await this.list(projectId), max);
    for (const b of drop) await this.remove(b.key);
    return drop.length;
  }
}

/** IndexedDB が使えないとき (メモリのみ。ページを閉じると消える) */
export class MemoryBackupStore implements BackupStore {
  readonly persistent = false;
  private records = new Map<string, BackupRecord>();

  async list(projectId?: string): Promise<BackupInfo[]> {
    return [...this.records.values()].filter((r) => !projectId || r.projectId === projectId).map(info).sort((a, b) => b.time - a.time);
  }

  async load(key: string): Promise<ProjectData | null> {
    const r = this.records.get(key);
    return r ? (JSON.parse(r.data) as ProjectData) : null;
  }

  async add(project: ProjectData, reason: BackupReason): Promise<BackupInfo> {
    const rec = toRecord(project, reason);
    this.records.set(rec.key, rec);
    return info(rec);
  }

  async remove(key: string): Promise<void> {
    this.records.delete(key);
  }

  async removeProject(projectId: string): Promise<void> {
    for (const [k, r] of this.records) if (r.projectId === projectId) this.records.delete(k);
  }

  async prune(projectId: string, max: number): Promise<number> {
    const drop = pruneOrder(await this.list(projectId), max);
    for (const b of drop) this.records.delete(b.key);
    return drop.length;
  }
}
