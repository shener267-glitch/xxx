import type { Editor } from '../core/Editor';
import type { GameBuildInput, GameIcons } from '../core/gameExport';
import { gameFileBase, gameSingleHtml, gameTitle, gameZipEntries, PLAYER_FILE } from '../core/gameExport';
import { clone } from '../core/util';
import { createZip } from '../core/zip';
import { downloadBlob } from '../storage/fileio';
import type { AssetService } from './AssetService';

/**
 * ゲームの書き出し (エディタ側)。
 * ゲームの本体 (player/pocket-player.js) とアセットの中身・アイコンを集めて、
 * ZIP または 1 つの HTML にする。「新しいタブで遊ぶ」もここで作る HTML を使う。
 */

export type GameExportMode = 'zip' | 'html';

export interface GameExportResult {
  filename: string;
  size: number;
  /** 中身が見つからなかったアセットの名前 */
  missing: string[];
}

/** ゲームの本体の場所 (エディタと同じ場所の player/) */
export function playerUrl(): string {
  return new URL(`player/${PLAYER_FILE}`, document.baseURI).href;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めませんでした'));
    img.src = url;
  });
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('アイコンを作れませんでした'));
      void blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject);
    }, 'image/png');
  });
}

export class GameExporter {
  private playerJs: string | null = null;

  constructor(
    private editor: Editor,
    private assets: AssetService,
  ) {}

  /** ゲームの本体を読み込む (1 回だけ) */
  async loadPlayer(): Promise<string> {
    if (this.playerJs) return this.playerJs;
    let res: Response;
    try {
      res = await fetch(playerUrl(), { cache: 'no-cache' });
    } catch {
      throw new Error('ゲームの本体 (pocket-player.js) を読み込めませんでした。通信状態を確認してください');
    }
    if (!res.ok) throw new Error(`ゲームの本体 (pocket-player.js) が見つかりません (${res.status})`);
    const text = await res.text();
    if (!text.includes('__POCKET_GAME__')) throw new Error('ゲームの本体 (pocket-player.js) が正しくありません');
    this.playerJs = text;
    return text;
  }

  /** アイコン (ゲームのアイコン画像、無ければタイトルの 1 文字目から作る) */
  async makeIcons(): Promise<GameIcons | null> {
    const g = this.editor.project.game;
    let img: HTMLImageElement | null = null;
    let url: string | null = null;
    if (g.icon) {
      const blob = await this.assets.getBlob(g.icon);
      if (blob) {
        url = URL.createObjectURL(blob);
        img = await loadImage(url).catch(() => null);
      }
    }
    try {
      const draw = (size: number) => {
        const c = document.createElement('canvas');
        c.width = size;
        c.height = size;
        const ctx = c.getContext('2d');
        if (!ctx) return null;
        if (img) {
          // 正方形に切り抜く (中央)
          const s = Math.min(img.naturalWidth, img.naturalHeight);
          ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
        } else {
          const grad = ctx.createLinearGradient(0, 0, size, size);
          grad.addColorStop(0, g.titleBackground);
          grad.addColorStop(1, '#000000');
          ctx.fillStyle = g.titleBackground;
          ctx.fillRect(0, 0, size, size);
          ctx.globalAlpha = 0.45;
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, size, size);
          ctx.globalAlpha = 1;
          const ch = [...gameTitle(g, this.editor.project.name)][0] ?? 'G';
          ctx.fillStyle = '#ffffff';
          ctx.font = `900 ${Math.round(size * 0.5)}px system-ui, -apple-system, 'Hiragino Sans', 'Noto Sans JP', sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(ch, size / 2, size * 0.54);
        }
        return c;
      };
      const small = draw(192);
      const large = draw(512);
      if (!small || !large) return null;
      return { small: await canvasPng(small), large: await canvasPng(large) };
    } catch {
      return null;
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  /** 書き出しに必要なものを集める */
  async collect(): Promise<{ input: GameBuildInput; missing: string[] }> {
    const project = clone(this.editor.project);
    const [playerJs, icons] = await Promise.all([this.loadPlayer(), this.makeIcons()]);
    const assets: GameBuildInput['assets'] = new Map();
    const missing: string[] = [];
    for (const a of project.assets) {
      const blob = await this.assets.getBlob(a.id);
      if (!blob) {
        missing.push(a.name);
        continue;
      }
      assets.set(a.id, { mime: blob.type || a.mime, bytes: new Uint8Array(await blob.arrayBuffer()) });
    }
    return { input: { project, assets, playerJs, icons }, missing };
  }

  async build(mode: GameExportMode): Promise<{ blob: Blob; filename: string; missing: string[] }> {
    const { input, missing } = await this.collect();
    const base = gameFileBase(input.project);
    if (mode === 'html') {
      return { blob: new Blob([gameSingleHtml(input)], { type: 'text/html;charset=utf-8' }), filename: `${base}.html`, missing };
    }
    const zip = await createZip(gameZipEntries(input));
    return { blob: new Blob([zip as BlobPart], { type: 'application/zip' }), filename: `${base}.zip`, missing };
  }

  /** 書き出してダウンロードする */
  async export(mode: GameExportMode): Promise<GameExportResult> {
    const { blob, filename, missing } = await this.build(mode);
    downloadBlob(filename, blob);
    return { filename, size: blob.size, missing };
  }

  /** 書き出した状態のゲームを新しいタブで遊ぶ (win は操作の直後に開いておいたタブ) */
  async preview(win: Window | null): Promise<boolean> {
    const { blob } = await this.build('html');
    const url = URL.createObjectURL(blob);
    // 新しいタブが読み込み終わるまで URL を解放しない
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if (win && !win.closed) {
      win.location.href = url;
      return true;
    }
    return window.open(url, '_blank') !== null;
  }

  /** 書き出したときのおおよその大きさ (バイト) */
  estimateSize(): number {
    const assetBytes = this.editor.project.assets.reduce((n, a) => n + a.size, 0);
    const dataBytes = JSON.stringify(this.editor.project).length;
    return Math.round(assetBytes * 1.34 + dataBytes + (this.playerJs?.length ?? 1_000_000));
  }
}
