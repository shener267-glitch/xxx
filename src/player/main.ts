import gameCss from '../styles/game.css?inline';
import playerCss from './player.css?inline';
import { registerBuiltinComponents } from '../components/builtin';
import type { ExportedGame } from '../core/gameExport';
import { fromBase64, GAME_FORMAT, GAME_GLOBAL } from '../core/gameExport';
import { logger } from '../core/logger';
import { sanitizeProject } from '../core/serialization';
import { EngineRenderer } from '../engine/EngineRenderer';
import { setAssetResolver } from '../engine/textures';
import { h } from '../ui/dom';
import { StandalonePlayer } from './StandalonePlayer';

/**
 * 書き出したゲームのエントリーポイント (pocket-player.js)。
 * game-data.js が入れた window.__POCKET_GAME__ を読んでゲームを始める。
 * エディタのコードは含まない。
 */

function injectCss(): void {
  const style = document.createElement('style');
  style.textContent = `${playerCss}\n${gameCss}`;
  document.head.appendChild(style);
}

function showFatal(root: HTMLElement, title: string, message: string): void {
  root.replaceChildren(
    h(
      'div',
      { class: 'pg-fatal', attrs: { 'data-testid': 'player-error' } },
      h('h1', { text: title }),
      h('p', { text: message }),
      h('button', { text: '再読み込み', attrs: { type: 'button' }, on: { click: () => location.reload() } }),
    ),
  );
}

/** アセットの中身 (base64) を必要になったときに Blob にする */
function installAssets(game: ExportedGame): void {
  const cache = new Map<string, Blob>();
  setAssetResolver(async (id) => {
    const hit = cache.get(id);
    if (hit) return hit;
    const a = game.assets[id];
    if (!a) return null;
    const blob = new Blob([fromBase64(a.data) as BlobPart], { type: a.mime });
    cache.set(id, blob);
    return blob;
  });
}

function boot(): void {
  injectCss();
  const root = document.getElementById('game') ?? document.body.appendChild(document.createElement('div'));
  const raw = (window as unknown as Record<string, unknown>)[GAME_GLOBAL] as ExportedGame | undefined;
  if (!raw || raw.format !== GAME_FORMAT || !raw.project) {
    showFatal(root, 'ゲームのデータがありません', 'game-data.js を読み込めませんでした。書き出した ZIP の中身をすべて同じフォルダに置いてください。');
    return;
  }
  if (!EngineRenderer.isSupported()) {
    showFatal(root, '3D 表示に対応していません', 'このブラウザでは WebGL が使えないため遊べません。最新の Chrome / Safari / Edge / Firefox でお試しください。');
    return;
  }
  let player: StandalonePlayer;
  try {
    registerBuiltinComponents();
    const project = sanitizeProject(raw.project);
    installAssets(raw);
    root.replaceChildren();
    player = new StandalonePlayer(root, project);
    player.start();
  } catch (err) {
    logger.error('ゲームを開始できませんでした', 'ゲーム', err);
    showFatal(root, 'ゲームを開始できませんでした', err instanceof Error ? err.message : String(err));
    return;
  }
  // 動作確認・自動テスト用
  (window as unknown as { __pocketPlayer: unknown }).__pocketPlayer = player;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
