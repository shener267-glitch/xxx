import type { Editor } from '../core/Editor';
import { logger } from '../core/logger';
import type { AssetEntry, AssetType } from '../core/types';
import { createId, uniqueName } from '../core/util';
import { invalidateAssetTexture, setAssetResolver } from '../engine/textures';
import type { AssetStore } from '../storage/ProjectRepository';

/**
 * アセット (画像・音声・3D モデル・フォント) の読み込みと管理。
 * メタ情報はプロジェクトデータ (project.assets)、ファイル本体は AssetStore に保存する。
 */

const EXT_TYPES: Record<string, AssetType> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  glb: 'model',
  gltf: 'model',
  ttf: 'font',
  otf: 'font',
  woff: 'font',
  woff2: 'font',
};

export const ACCEPT: Record<AssetType | 'all', string> = {
  image: 'image/*,.png,.jpg,.jpeg,.gif,.webp,.svg',
  audio: 'audio/*,.mp3,.wav,.ogg,.m4a',
  model: '.glb,.gltf',
  font: '.ttf,.otf,.woff,.woff2',
  all: 'image/*,audio/*,.glb,.gltf,.ttf,.otf,.woff,.woff2',
};

/** 1ファイルの上限 (スマホのストレージを圧迫しないため) */
const MAX_FILE_SIZE = 30 * 1024 * 1024;
/** 取り込み時に画像を縮小する最大サイズ */
const MAX_IMAGE_SIZE = 2048;

export function detectAssetType(name: string, mime: string): AssetType | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (EXT_TYPES[ext]) return EXT_TYPES[ext];
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.includes('font')) return 'font';
  if (mime === 'model/gltf-binary' || mime === 'model/gltf+json') return 'model';
  return null;
}

/** 大きな画像を縮小して容量を減らす (透過のある PNG / WebP は PNG のまま) */
async function shrinkImage(file: Blob, name: string): Promise<Blob> {
  if (file.type === 'image/svg+xml' || file.type === 'image/gif' || name.toLowerCase().endsWith('.svg')) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const max = Math.max(img.naturalWidth, img.naturalHeight);
    if (max <= MAX_IMAGE_SIZE) return file;
    const scale = MAX_IMAGE_SIZE / max;
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    const keepAlpha = file.type === 'image/png' || file.type === 'image/webp';
    const out = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, keepAlpha ? 'image/png' : 'image/jpeg', 0.9));
    return out ?? file;
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('ファイルを読み込めませんでした'));
    r.readAsDataURL(blob);
  });
}

export async function dataUrlToBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  return res.blob();
}

export class AssetService {
  /** 読み込み済み Blob のキャッシュ (同じファイルを何度も DB から読まない) */
  private cache = new Map<string, Blob>();

  constructor(
    readonly store: AssetStore,
    private editor: Editor,
  ) {
    // エンジン (テクスチャ・モデル・音声) からアセットを取得できるようにする
    setAssetResolver((id) => this.getBlob(id));
    editor.events.on('project-changed', () => {
      // 別のプロジェクトを開いたらキャッシュを捨てる
      if (this.cachedProject !== editor.project.id) {
        this.cache.clear();
        for (const u of this.urls.values()) URL.revokeObjectURL(u);
        this.urls.clear();
        this.cachedProject = editor.project.id;
      }
    });
    this.cachedProject = editor.project.id;
  }

  private cachedProject: string;
  private urls = new Map<string, string>();

  /** プレビュー表示用の URL (Blob から作ってキャッシュ) */
  async objectUrl(id: string): Promise<string | null> {
    const cached = this.urls.get(id);
    if (cached) return cached;
    const blob = await this.getBlob(id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.urls.set(id, url);
    return url;
  }

  get list(): AssetEntry[] {
    return this.editor.project.assets;
  }

  find(id: string | null | undefined): AssetEntry | undefined {
    return id ? this.list.find((a) => a.id === id) : undefined;
  }

  byType(type: AssetType): AssetEntry[] {
    return this.list.filter((a) => a.type === type);
  }

  async getBlob(id: string): Promise<Blob | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const blob = await this.store.get(this.editor.project.id, id);
    if (blob) this.cache.set(id, blob);
    return blob;
  }

  private changed(): void {
    this.editor.markDirty();
    this.editor.events.emit('assets-changed', undefined);
  }

  /** ファイルを取り込んでアセットとして登録する */
  async importFile(file: File, folder = ''): Promise<AssetEntry> {
    const type = detectAssetType(file.name, file.type);
    if (!type) throw new Error(`「${file.name}」は対応していない形式です`);
    if (file.size > MAX_FILE_SIZE) throw new Error(`「${file.name}」は大きすぎます (30MB まで)`);
    const blob = type === 'image' ? await shrinkImage(file, file.name) : file;
    const entry: AssetEntry = {
      id: createId('a'),
      name: uniqueName(file.name.replace(/\.[^.]+$/, '') || 'アセット', this.list.map((a) => a.name)),
      type,
      folder,
      mime: blob.type || file.type,
      size: blob.size,
      createdAt: Date.now(),
    };
    await this.store.put(this.editor.project.id, entry.id, blob);
    this.cache.set(entry.id, blob);
    this.editor.project.assets.push(entry);
    this.changed();
    logger.info(`アセット「${entry.name}」を読み込みました`, 'アセット');
    return entry;
  }

  async importFiles(files: File[], folder = ''): Promise<{ added: AssetEntry[]; errors: string[] }> {
    const added: AssetEntry[] = [];
    const errors: string[] = [];
    for (const f of files) {
      try {
        added.push(await this.importFile(f, folder));
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    return { added, errors };
  }

  /** ファイル選択ダイアログから取り込む */
  pickAndImport(type: AssetType | 'all', folder = '', multiple = true): Promise<{ added: AssetEntry[]; errors: string[] }> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = ACCEPT[type];
      input.multiple = multiple;
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', () => {
        const files = [...(input.files ?? [])];
        input.remove();
        if (files.length === 0) resolve({ added: [], errors: [] });
        else void this.importFiles(files, folder).then(resolve);
      });
      input.addEventListener('cancel', () => {
        input.remove();
        resolve({ added: [], errors: [] });
      });
      input.click();
    });
  }

  rename(id: string, name: string): void {
    const a = this.find(id);
    const trimmed = name.trim().slice(0, 120);
    if (!a || !trimmed) return;
    a.name = trimmed;
    this.changed();
  }

  move(id: string, folder: string): void {
    const a = this.find(id);
    if (!a) return;
    a.folder = folder;
    this.changed();
  }

  /** アセットを削除する。参照しているマテリアル等は参照を外す */
  async remove(id: string): Promise<void> {
    const p = this.editor.project;
    const idx = p.assets.findIndex((a) => a.id === id);
    if (idx < 0) return;
    p.assets.splice(idx, 1);
    for (const scene of p.scenes) {
      for (const e of Object.values(scene.entities)) {
        if (e.mesh?.material.texture === id) e.mesh.material.texture = null;
      }
    }
    this.cache.delete(id);
    const url = this.urls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(id);
    invalidateAssetTexture(id);
    await this.store.remove(p.id, id);
    this.changed();
    // 表示中のシーンを更新
    this.editor.events.emit('scene-loaded', this.editor.sceneData);
  }

  /** 書き出し用: すべてのアセットを dataURL にする */
  async embedAll(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const a of this.list) {
      const blob = await this.getBlob(a.id);
      if (blob) out[a.id] = await blobToDataUrl(blob);
      else logger.warn(`アセット「${a.name}」の本体が見つかりません`, '書き出し');
    }
    return out;
  }

  /** 読み込み用: 埋め込まれたアセットを保存する */
  async restoreEmbedded(projectId: string, embedded: Record<string, string>): Promise<void> {
    for (const [id, url] of Object.entries(embedded)) {
      if (typeof url !== 'string' || !url.startsWith('data:')) continue;
      await this.store.put(projectId, id, await dataUrlToBlob(url));
    }
  }
}
