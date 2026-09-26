import type { Editor } from '../core/Editor';
import { logger } from '../core/logger';
import type { Object3D } from 'three';
import type { AssetEntry, AssetInfo, AssetType } from '../core/types';
import { createId, uniqueName } from '../core/util';
import { invalidateAssetTexture, setAssetResolver } from '../engine/textures';
import { registerFont } from '../engine/fonts';
import { invalidateModel, parseModel } from '../engine/models';
import { audioDuration, imageThumbnail } from '../engine/thumbnail';
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

/** フォルダのパスを正規化する ('a / b/' → 'a/b') */
export function normalizeFolder(path: string): string {
  return path
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .join('/')
    .slice(0, 200);
}

export class AssetService {
  /** 読み込み済み Blob のキャッシュ (同じファイルを何度も DB から読まない) */
  private cache = new Map<string, Blob>();
  /** 3D モデルの小さな画像を作る関数 (エンジンのレンダラーを使う。App が設定する) */
  thumbnailer: ((object: Object3D) => string | null) | null = null;

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
    // 種類ごとに中身を確認し、一覧用の情報と小さな画像を作る
    const id = createId('a');
    let info: AssetInfo | undefined;
    let thumb: string | undefined;
    if (type === 'image') {
      const t = await imageThumbnail(blob);
      if (!t.thumb) throw new Error(`「${file.name}」は画像として読み込めませんでした`);
      info = { width: t.width, height: t.height };
      thumb = t.thumb;
    } else if (type === 'model') {
      let model;
      try {
        model = await parseModel(await blob.arrayBuffer());
      } catch (err) {
        const hint = file.name.toLowerCase().endsWith('.gltf') ? ' (.gltf は外部ファイルを参照していると読めません。.glb を使ってください)' : '';
        throw new Error(`「${file.name}」を 3D モデルとして読み込めませんでした${hint}`, { cause: err });
      }
      info = { modelSize: model.size, modelCenter: model.center, animations: model.animations.map((a) => a.name), triangles: model.triangles };
      try {
        thumb = this.thumbnailer?.(model.scene) ?? undefined;
      } catch {
        thumb = undefined;
      }
    } else if (type === 'audio') {
      info = { duration: await audioDuration(blob) };
    } else if (type === 'font') {
      try {
        await registerFont(id, await blob.arrayBuffer());
      } catch (err) {
        throw new Error(`「${file.name}」はフォントとして読み込めませんでした`, { cause: err });
      }
    }
    const entry: AssetEntry = {
      id,
      name: uniqueName(file.name.replace(/\.[^.]+$/, '') || 'アセット', this.list.map((a) => a.name)),
      type,
      folder: normalizeFolder(folder),
      mime: blob.type || file.type,
      size: blob.size,
      createdAt: Date.now(),
      ...(thumb ? { thumb } : {}),
      ...(info ? { info } : {}),
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
    a.folder = normalizeFolder(folder);
    this.changed();
  }

  // ------------------------------------------------------------------
  // フォルダ
  // ------------------------------------------------------------------

  /** すべてのフォルダ (途中の階層も含む) */
  folders(): string[] {
    const p = this.editor.project;
    const set = new Set<string>();
    const add = (path: string) => {
      const parts = normalizeFolder(path).split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
    };
    for (const a of p.assets) add(a.folder);
    for (const f of p.prefabs) add(f.folder);
    for (const f of p.assetFolders) add(f);
    return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
  }

  /** 直下のフォルダ */
  subfolders(parent: string): string[] {
    const base = normalizeFolder(parent);
    return this.folders().filter((f) => {
      if (base === '') return !f.includes('/');
      return f.startsWith(`${base}/`) && !f.slice(base.length + 1).includes('/');
    });
  }

  createFolder(path: string): string | null {
    const f = normalizeFolder(path);
    if (!f) return null;
    const p = this.editor.project;
    if (!p.assetFolders.includes(f)) p.assetFolders.push(f);
    this.changed();
    return f;
  }

  /** フォルダの名前を変える (中身も移す) */
  renameFolder(from: string, to: string): boolean {
    const a = normalizeFolder(from);
    const b = normalizeFolder(to);
    if (!a || !b || a === b) return false;
    const p = this.editor.project;
    const move = (path: string) => (path === a ? b : path.startsWith(`${a}/`) ? b + path.slice(a.length) : path);
    for (const x of p.assets) x.folder = move(x.folder);
    for (const x of p.prefabs) x.folder = move(x.folder);
    p.assetFolders = [...new Set(p.assetFolders.map(move))];
    this.changed();
    return true;
  }

  /** フォルダを消す (中身は1つ上のフォルダへ移す) */
  deleteFolder(path: string): void {
    const a = normalizeFolder(path);
    if (!a) return;
    const parent = a.includes('/') ? a.slice(0, a.lastIndexOf('/')) : '';
    const p = this.editor.project;
    const move = (f: string) => (f === a ? parent : f.startsWith(`${a}/`) ? parent + (parent ? '/' : '') + f.slice(a.length + 1) : f);
    for (const x of p.assets) x.folder = move(x.folder);
    for (const x of p.prefabs) x.folder = move(x.folder);
    p.assetFolders = [...new Set(p.assetFolders.filter((f) => f !== a).map(move))].filter(Boolean);
    this.changed();
  }

  // ------------------------------------------------------------------
  // 使用箇所・削除
  // ------------------------------------------------------------------

  /** プロジェクトの中でこのアセットを使っている数 */
  usages(id: string): number {
    const p = this.editor.project;
    let n = 0;
    const scan = (v: unknown) => {
      if (v === id) n++;
      else if (Array.isArray(v)) v.forEach(scan);
      else if (v && typeof v === 'object') Object.values(v).forEach(scan);
    };
    for (const scene of p.scenes) {
      scan(scene.entities);
      scan(scene.music);
      scan(scene.events);
    }
    for (const pf of p.prefabs) scan(pf.entities);
    scan(p.game);
    return n;
  }

  /** アセットを削除する。使っている場所 (テクスチャ・UI・音など) の参照は外す */
  async remove(id: string): Promise<void> {
    const p = this.editor.project;
    const idx = p.assets.findIndex((a) => a.id === id);
    if (idx < 0) return;
    p.assets.splice(idx, 1);
    const clear = (obj: unknown) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (v === id) (obj as Record<string, unknown>)[k] = k === 'sound' || k === 'source' ? '' : null;
        else if (v && typeof v === 'object') clear(v);
      }
    };
    for (const scene of p.scenes) {
      clear(scene.entities);
      clear(scene.events);
      if (scene.music.source === id) scene.music.source = null;
    }
    for (const pf of p.prefabs) clear(pf.entities);
    clear(p.game);
    this.cache.delete(id);
    const url = this.urls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(id);
    invalidateAssetTexture(id);
    invalidateModel(id);
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
