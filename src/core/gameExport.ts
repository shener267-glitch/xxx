import type { GameSettings, ProjectData } from './types';
import { clone } from './util';
import type { ZipEntry } from './zip';
import { textBytes } from './zip';

/**
 * ゲームの書き出し (Phase 10)。エディタなしで動く「遊ぶだけ」のゲームを作る。
 *
 * ZIP (GitHub Pages などにそのまま置ける):
 *   index.html             ゲームのページ (相対パスのみ・file:// で開いても動く)
 *   pocket-player.js       ゲームの本体 (エンジン + ランタイム。エディタは含まない)
 *   game-data.js           プロジェクトのデータとアセット (window.__POCKET_GAME__ = {...})
 *   icon-192.png / icon-512.png / manifest.webmanifest   ホーム画面に追加したときのアイコン
 *   .nojekyll / README.txt
 *
 * 1 つの HTML: 上のすべて (アイコンも) を index.html 1 つにまとめる (メールやチャットで渡しやすい)。
 *
 * アセットは base64 でデータに埋め込むため、サーバーが無くても (file:// でも) 読み込める。
 */

export const GAME_GLOBAL = '__POCKET_GAME__';
export const GAME_FORMAT = 'pocket-engine-game';
export const PLAYER_FILE = 'pocket-player.js';
export const DATA_FILE = 'game-data.js';

export interface ExportedAsset {
  mime: string;
  /** base64 */
  data: string;
}

export interface ExportedGame {
  format: typeof GAME_FORMAT;
  version: 1;
  exportedAt: number;
  project: ProjectData;
  /** アセット ID → 中身 */
  assets: Record<string, ExportedAsset>;
}

export interface GameIcons {
  /** 192×192 の PNG */
  small: Uint8Array;
  /** 512×512 の PNG */
  large: Uint8Array;
}

export interface GameBuildInput {
  project: ProjectData;
  /** アセット ID → 中身 (本体が見つからないアセットは入れない) */
  assets: Map<string, { mime: string; bytes: Uint8Array }>;
  /** ゲームの本体 (pocket-player.js の中身) */
  playerJs: string;
  icons: GameIcons | null;
  exportedAt?: number;
}

// ------------------------------------------------------------------
// base64
// ------------------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ------------------------------------------------------------------
// データ
// ------------------------------------------------------------------

/** 遊ぶのに要らないデータ (エディタ用のサムネイルなど) を除いたプロジェクト */
export function gameProject(project: ProjectData): ProjectData {
  const p = clone(project);
  for (const a of p.assets) delete a.thumb;
  for (const f of p.prefabs) delete f.thumb;
  return p;
}

export function exportedGame(input: GameBuildInput): ExportedGame {
  const assets: Record<string, ExportedAsset> = {};
  for (const [id, a] of input.assets) assets[id] = { mime: a.mime, data: toBase64(a.bytes) };
  return { format: GAME_FORMAT, version: 1, exportedAt: input.exportedAt ?? Date.now(), project: gameProject(input.project), assets };
}

/** <script> の中に安全に書ける JSON (</script> や行区切り文字で壊れない) */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** game-data.js の中身 */
export function gameDataScript(game: ExportedGame): string {
  return `window.${GAME_GLOBAL}=${scriptSafeJson(game)};\n`;
}

/** game-data.js の中身を読む (テスト・読み込み用) */
export function parseGameDataScript(text: string): ExportedGame {
  const prefix = `window.${GAME_GLOBAL}=`;
  const start = text.indexOf(prefix);
  if (start < 0) throw new Error('ゲームのデータではありません');
  const json = text.slice(start + prefix.length).trim().replace(/;$/, '');
  const game = JSON.parse(json) as ExportedGame;
  if (game.format !== GAME_FORMAT) throw new Error('ゲームのデータではありません');
  return game;
}

/** インラインの <script> に入れられるようにする (文字列・正規表現の中の </script> を <\/script にする) */
export function inlineScript(js: string): string {
  return js.replace(/<\/script/gi, '<\\/script');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function gameTitle(game: GameSettings, fallback = 'ゲーム'): string {
  return game.title.trim() || fallback;
}

/** ホーム画面に追加したときの設定 */
export function webManifest(project: ProjectData, icons: boolean): string {
  const g = project.game;
  const title = gameTitle(g, project.name);
  const manifest: Record<string, unknown> = {
    name: title,
    short_name: title.slice(0, 12),
    description: g.description || g.subtitle,
    start_url: './',
    scope: './',
    display: 'fullscreen',
    orientation: g.orientation === 'any' ? 'any' : g.orientation,
    background_color: g.titleBackground,
    theme_color: g.titleBackground,
    lang: 'ja',
  };
  if (icons) {
    manifest.icons = [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ];
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

interface HtmlParts {
  /** アイコン (ファイル名か data URL) */
  icon: string | null;
  manifest: boolean;
  /** 外部ファイル: <script src>、インライン: 中身 */
  scripts: { src: string } | { inline: string[] };
}

export function gameHtml(project: ProjectData, parts: HtmlParts): string {
  const g = project.game;
  const title = escapeHtml(gameTitle(g, project.name));
  const desc = escapeHtml(g.description || g.subtitle || title);
  const color = /^#[0-9a-f]{6}$/i.test(g.titleBackground) ? g.titleBackground : '#1b2a4a';
  const head = [
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />',
    `<meta name="theme-color" content="${color}" />`,
    `<meta name="description" content="${desc}" />`,
    '<meta name="mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
    `<meta name="apple-mobile-web-app-title" content="${title}" />`,
    '<meta name="generator" content="Pocket Engine" />',
    g.author ? `<meta name="author" content="${escapeHtml(g.author)}" />` : '',
    `<title>${title}</title>`,
    parts.icon ? `<link rel="icon" type="image/png" href="${parts.icon}" />` : '',
    parts.icon ? `<link rel="apple-touch-icon" href="${parts.icon}" />` : '',
    parts.manifest ? '<link rel="manifest" href="manifest.webmanifest" />' : '',
    `<style>html,body{margin:0;height:100%;background:${color};overflow:hidden}#game{position:fixed;inset:0}` +
      `.pg-boot{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#fff;` +
      `font-family:system-ui,-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif}.pg-boot b{font-size:24px}.pg-boot span{opacity:.7;font-size:14px}</style>`,
  ].filter(Boolean);
  const scripts =
    'src' in parts.scripts
      ? [`<script src="${DATA_FILE}"></script>`, `<script src="${parts.scripts.src}"></script>`]
      : parts.scripts.inline.map((js) => `<script>${inlineScript(js)}</script>`);
  return [
    '<!doctype html>',
    '<html lang="ja">',
    '<head>',
    ...head.map((l) => `  ${l}`),
    '</head>',
    '<body>',
    `  <div id="game"><div class="pg-boot" data-testid="player-boot"><b>${title}</b><span>読み込み中…</span></div></div>`,
    '  <noscript>このゲームを遊ぶには JavaScript を有効にしてください。</noscript>',
    ...scripts.map((s) => `  ${s}`),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function readme(project: ProjectData): string {
  const g = project.game;
  return [
    `${gameTitle(g, project.name)}${g.version ? ` (v${g.version})` : ''}`,
    g.author ? `作: ${g.author}` : '',
    '',
    'Pocket Engine で作ったゲームです。',
    '',
    '■ 遊び方',
    '  index.html をブラウザで開きます (インターネットにつながっていなくても遊べます)。',
    '',
    '■ GitHub Pages で公開する',
    '  1. このフォルダの中身 (index.html など) をリポジトリに置きます',
    '  2. リポジトリの Settings → Pages → Branch で、そのブランチとフォルダを選んで保存します',
    '  3. 表示された URL を開くと遊べます (スマホではホーム画面に追加するとアプリのように遊べます)',
    '',
    '  ほかの静的なウェブサーバー (Netlify・Cloudflare Pages など) にもそのまま置けます。',
    '',
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');
}

/** ZIP に入れるファイル (GitHub Pages などに置ける形) */
export function gameZipEntries(input: GameBuildInput): ZipEntry[] {
  const game = exportedGame(input);
  const entries: ZipEntry[] = [
    { name: 'index.html', data: textBytes(gameHtml(input.project, { icon: input.icons ? 'icon-192.png' : null, manifest: true, scripts: { src: PLAYER_FILE } })) },
    { name: PLAYER_FILE, data: textBytes(input.playerJs) },
    { name: DATA_FILE, data: textBytes(gameDataScript(game)) },
    { name: 'manifest.webmanifest', data: textBytes(webManifest(input.project, !!input.icons)) },
    { name: '.nojekyll', data: new Uint8Array() },
    { name: 'README.txt', data: textBytes(readme(input.project)) },
  ];
  if (input.icons) {
    entries.push({ name: 'icon-192.png', data: input.icons.small }, { name: 'icon-512.png', data: input.icons.large });
  }
  return entries;
}

/** 1 つの HTML ファイルにまとめたゲーム */
export function gameSingleHtml(input: GameBuildInput): string {
  const game = exportedGame(input);
  const icon = input.icons ? `data:image/png;base64,${toBase64(input.icons.small)}` : null;
  return gameHtml(input.project, { icon, manifest: false, scripts: { inline: [gameDataScript(game), input.playerJs] } });
}

/** 書き出すファイル名 (拡張子なし) */
export function gameFileBase(project: ProjectData): string {
  const t = gameTitle(project.game, project.name);
  return t.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'game';
}
