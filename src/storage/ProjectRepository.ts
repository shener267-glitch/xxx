import { countEntities } from '../core/project';
import { sanitizeProject } from '../core/serialization';
import type { ProjectData, ProjectMeta } from '../core/types';
import { clone } from '../core/util';

/**
 * プロジェクトの保存先。
 * 通常は IndexedDB (大容量) を使い、使えない環境では localStorage にフォールバックする。
 * すべてブラウザ内で完結し、サーバーには一切送信しない。
 */
export interface ProjectRepository {
  readonly kind: 'indexeddb' | 'localstorage' | 'memory';
  list(): Promise<ProjectMeta[]>;
  load(id: string): Promise<ProjectData | null>;
  save(project: ProjectData, thumbnail?: string | null): Promise<ProjectMeta>;
  remove(id: string): Promise<void>;
}

function makeMeta(p: ProjectData, thumbnail: string | null): ProjectMeta {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    sceneCount: p.scenes.length,
    entityCount: countEntities(p),
    thumbnail,
  };
}

const sortMeta = (list: ProjectMeta[]) => list.sort((a, b) => b.updatedAt - a.updatedAt);

// ------------------------------------------------------------------
// IndexedDB
// ------------------------------------------------------------------

const DB_NAME = 'pocket-engine';
const DB_VERSION = 2;

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

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
      // v1 の assets ストア (未使用) は形式が違うので作り直す。
      // キーは「プロジェクト ID:アセット ID」とし、プロジェクト単位でまとめて削除できるようにする
      if (e.oldVersion < 2 && db.objectStoreNames.contains('assets')) db.deleteObjectStore('assets');
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'key' });
      // 自動バックアップ (Phase 9)
      if (!db.objectStoreNames.contains('backups')) db.createObjectStore('backups', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB を開けませんでした'));
    req.onblocked = () => reject(new Error('他のタブがデータベースを使用中です'));
  });
}

export class IndexedDbRepository implements ProjectRepository {
  readonly kind = 'indexeddb' as const;
  constructor(private db: IDBDatabase) {}

  async list(): Promise<ProjectMeta[]> {
    const tx = this.db.transaction('meta', 'readonly');
    const all = await promisify(tx.objectStore('meta').getAll() as IDBRequest<ProjectMeta[]>);
    return sortMeta(all);
  }

  async load(id: string): Promise<ProjectData | null> {
    const tx = this.db.transaction('projects', 'readonly');
    const raw = await promisify(tx.objectStore('projects').get(id));
    return raw ? sanitizeProject(raw) : null;
  }

  async save(project: ProjectData, thumbnail: string | null = null): Promise<ProjectMeta> {
    const data = clone(project);
    // サムネイルが渡されなかった場合は既存のものを維持する
    let thumb = thumbnail;
    if (thumb === null) {
      const prev = await promisify(this.db.transaction('meta', 'readonly').objectStore('meta').get(project.id)) as ProjectMeta | undefined;
      thumb = prev?.thumbnail ?? null;
    }
    const meta = makeMeta(data, thumb);
    const tx = this.db.transaction(['projects', 'meta'], 'readwrite');
    tx.objectStore('projects').put(data);
    tx.objectStore('meta').put(meta);
    await txDone(tx);
    return meta;
  }

  async remove(id: string): Promise<void> {
    const tx = this.db.transaction(['projects', 'meta'], 'readwrite');
    tx.objectStore('projects').delete(id);
    tx.objectStore('meta').delete(id);
    await txDone(tx);
  }
}

// ------------------------------------------------------------------
// localStorage (フォールバック)
// ------------------------------------------------------------------

const LS_PREFIX = 'pocket-engine:project:';
const LS_META = 'pocket-engine:meta';

export class LocalStorageRepository implements ProjectRepository {
  readonly kind = 'localstorage' as const;

  private readMeta(): ProjectMeta[] {
    try {
      const raw = localStorage.getItem(LS_META);
      return raw ? (JSON.parse(raw) as ProjectMeta[]) : [];
    } catch {
      return [];
    }
  }

  async list(): Promise<ProjectMeta[]> {
    return sortMeta(this.readMeta());
  }

  async load(id: string): Promise<ProjectData | null> {
    const raw = localStorage.getItem(LS_PREFIX + id);
    return raw ? sanitizeProject(JSON.parse(raw)) : null;
  }

  async save(project: ProjectData, thumbnail: string | null = null): Promise<ProjectMeta> {
    const metas = this.readMeta();
    const prev = metas.find((m) => m.id === project.id);
    const meta = makeMeta(project, thumbnail ?? prev?.thumbnail ?? null);
    try {
      localStorage.setItem(LS_PREFIX + project.id, JSON.stringify(project));
      localStorage.setItem(LS_META, JSON.stringify([meta, ...metas.filter((m) => m.id !== project.id)]));
    } catch {
      throw new Error('保存容量が不足しています。不要なプロジェクトを削除してください');
    }
    return meta;
  }

  async remove(id: string): Promise<void> {
    localStorage.removeItem(LS_PREFIX + id);
    localStorage.setItem(LS_META, JSON.stringify(this.readMeta().filter((m) => m.id !== id)));
  }
}

// ------------------------------------------------------------------
// メモリ (保存不可の環境用。リロードで消える)
// ------------------------------------------------------------------

export class MemoryRepository implements ProjectRepository {
  readonly kind = 'memory' as const;
  private projects = new Map<string, { data: ProjectData; meta: ProjectMeta }>();

  async list(): Promise<ProjectMeta[]> {
    return sortMeta([...this.projects.values()].map((p) => p.meta));
  }
  async load(id: string): Promise<ProjectData | null> {
    const p = this.projects.get(id);
    return p ? clone(p.data) : null;
  }
  async save(project: ProjectData, thumbnail: string | null = null): Promise<ProjectMeta> {
    const prev = this.projects.get(project.id);
    const meta = makeMeta(project, thumbnail ?? prev?.meta.thumbnail ?? null);
    this.projects.set(project.id, { data: clone(project), meta });
    return meta;
  }
  async remove(id: string): Promise<void> {
    this.projects.delete(id);
  }
}

export interface Storage {
  projects: ProjectRepository;
  assets: AssetStore;
  db: IDBDatabase | null;
}

export async function createStorage(): Promise<Storage> {
  try {
    if (typeof indexedDB !== 'undefined') {
      const db = await openDatabase();
      return { projects: new IndexedDbRepository(db), assets: new IndexedDbAssetStore(db), db };
    }
  } catch (err) {
    console.warn('[PocketEngine] IndexedDB が使えないため localStorage を使用します', err);
  }
  try {
    const k = 'pocket-engine:probe';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    // localStorage は容量が小さく Blob を保存できないため、アセットはメモリのみ
    return { projects: new LocalStorageRepository(), assets: new MemoryAssetStore(), db: null };
  } catch {
    return { projects: new MemoryRepository(), assets: new MemoryAssetStore(), db: null };
  }
}

// ------------------------------------------------------------------
// アセット (画像・音声・3Dモデルなどのファイル本体)
// ------------------------------------------------------------------

export interface AssetStore {
  readonly persistent: boolean;
  put(projectId: string, assetId: string, blob: Blob): Promise<void>;
  get(projectId: string, assetId: string): Promise<Blob | null>;
  remove(projectId: string, assetId: string): Promise<void>;
  /** プロジェクトのアセットをすべて削除 */
  removeProject(projectId: string): Promise<void>;
  /** プロジェクトのアセットを別のプロジェクトへ複製 */
  copyProject(fromId: string, toId: string): Promise<void>;
}

const assetKey = (projectId: string, assetId: string) => `${projectId}:${assetId}`;

export class IndexedDbAssetStore implements AssetStore {
  readonly persistent = true;
  constructor(private db: IDBDatabase) {}

  async put(projectId: string, assetId: string, blob: Blob): Promise<void> {
    const tx = this.db.transaction('assets', 'readwrite');
    tx.objectStore('assets').put({ key: assetKey(projectId, assetId), projectId, assetId, blob });
    await txDone(tx);
  }

  async get(projectId: string, assetId: string): Promise<Blob | null> {
    const tx = this.db.transaction('assets', 'readonly');
    const rec = (await promisify(tx.objectStore('assets').get(assetKey(projectId, assetId)))) as { blob: Blob } | undefined;
    return rec?.blob ?? null;
  }

  async remove(projectId: string, assetId: string): Promise<void> {
    const tx = this.db.transaction('assets', 'readwrite');
    tx.objectStore('assets').delete(assetKey(projectId, assetId));
    await txDone(tx);
  }

  private range(projectId: string): IDBKeyRange {
    return IDBKeyRange.bound(`${projectId}:`, `${projectId}:\uffff`);
  }

  async removeProject(projectId: string): Promise<void> {
    const tx = this.db.transaction('assets', 'readwrite');
    tx.objectStore('assets').delete(this.range(projectId));
    await txDone(tx);
  }

  async copyProject(fromId: string, toId: string): Promise<void> {
    const read = this.db.transaction('assets', 'readonly');
    const recs = (await promisify(read.objectStore('assets').getAll(this.range(fromId)))) as { assetId: string; blob: Blob }[];
    if (recs.length === 0) return;
    const tx = this.db.transaction('assets', 'readwrite');
    const store = tx.objectStore('assets');
    for (const r of recs) store.put({ key: assetKey(toId, r.assetId), projectId: toId, assetId: r.assetId, blob: r.blob });
    await txDone(tx);
  }
}

export class MemoryAssetStore implements AssetStore {
  readonly persistent = false;
  private blobs = new Map<string, Blob>();

  async put(projectId: string, assetId: string, blob: Blob): Promise<void> {
    this.blobs.set(assetKey(projectId, assetId), blob);
  }
  async get(projectId: string, assetId: string): Promise<Blob | null> {
    return this.blobs.get(assetKey(projectId, assetId)) ?? null;
  }
  async remove(projectId: string, assetId: string): Promise<void> {
    this.blobs.delete(assetKey(projectId, assetId));
  }
  async removeProject(projectId: string): Promise<void> {
    for (const k of [...this.blobs.keys()]) if (k.startsWith(`${projectId}:`)) this.blobs.delete(k);
  }
  async copyProject(fromId: string, toId: string): Promise<void> {
    for (const [k, v] of [...this.blobs]) {
      if (k.startsWith(`${fromId}:`)) this.blobs.set(`${toId}:${k.slice(fromId.length + 1)}`, v);
    }
  }
}

/** ストレージ使用量の目安 (対応ブラウザのみ) */
export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
    }
  } catch {
    // 非対応
  }
  return null;
}

/** 保存データが自動削除されにくくなるよう永続化を要求する */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    // 非対応
  }
  return false;
}

const LAST_KEY = 'pocket-engine:last-project';

export function getLastProjectId(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export function setLastProjectId(id: string): void {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    // 無視
  }
}
