import './styles/base.css';
import './styles/layout.css';
import './styles/widgets.css';
import './styles/panels.css';
import { registerBuiltinComponents } from './components/builtin';
import { logger } from './core/logger';
import { createProject } from './core/project';
import { loadSettings } from './core/settings';
import type { ProjectData } from './core/types';
import { EngineRenderer } from './engine/EngineRenderer';
import { createRepository, getLastProjectId, requestPersistence } from './storage/ProjectRepository';
import { App } from './ui/App';
import { h } from './ui/dom';
import { toast } from './ui/overlays';

/**
 * Pocket Engine のエントリーポイント。
 */

const ONBOARD_KEY = 'pocket-engine:onboarded';

function installErrorHandlers(): void {
  let last = 0;
  const report = (message: string, detail: unknown) => {
    logger.log('error', message, 'アプリ', detail);
    // 同じエラーで画面が埋まらないよう間引く
    const now = Date.now();
    if (now - last > 3000) {
      last = now;
      toast(`エラー: ${message}`, 'error', 4000);
    }
  };
  window.addEventListener('error', (e) => {
    // リソース読み込みエラー等は除外
    if (!e.message) return;
    report(e.message, e.error);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    report(r instanceof Error ? r.message : String(r), r);
  });
}

function showFatal(root: HTMLElement, title: string, message: string): void {
  root.innerHTML = '';
  root.appendChild(
    h(
      'div',
      { class: 'fatal' },
      h('h1', { text: title }),
      h('p', { text: message }),
      h('button', { class: 'btn primary', text: '再読み込み', attrs: { type: 'button' }, on: { click: () => location.reload() } }),
    ),
  );
}

function setViewportHeight(): void {
  // iOS Safari のアドレスバー対策: 実際の表示高さを CSS 変数に入れる
  const set = () => document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`);
  set();
  window.addEventListener('resize', set);
  window.visualViewport?.addEventListener('resize', set);
}

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;
  installErrorHandlers();
  setViewportHeight();

  if (!EngineRenderer.isSupported()) {
    showFatal(root, '3D 表示に対応していません', 'このブラウザでは WebGL が使えないため Pocket Engine を起動できません。最新の Chrome / Safari / Edge / Firefox をお試しください。');
    return;
  }

  registerBuiltinComponents();
  const repo = await createRepository();
  if (repo.kind === 'memory') {
    setTimeout(() => toast('この環境では保存できません (プライベートモード等)。書き出しでファイルに保存してください', 'warn', 6000), 800);
  }

  let project: ProjectData | null = null;
  try {
    const lastId = getLastProjectId();
    if (lastId) project = await repo.load(lastId);
    if (!project) {
      const metas = await repo.list();
      if (metas[0]) project = await repo.load(metas[0].id);
    }
  } catch (err) {
    logger.error('前回のプロジェクトを読み込めませんでした', '起動', err);
  }
  const isNew = !project;
  if (!project) project = createProject('はじめてのゲーム', true);

  root.innerHTML = '';
  let app: App;
  try {
    app = new App(root, project, repo, loadSettings());
  } catch (err) {
    logger.error('起動に失敗しました', '起動', err);
    showFatal(root, '起動に失敗しました', err instanceof Error ? err.message : String(err));
    return;
  }
  if (isNew) {
    await app.projects.save({ silent: true, thumbnail: false });
    void requestPersistence();
  }

  // 初回起動時は操作ガイドを表示
  try {
    if (!localStorage.getItem(ONBOARD_KEY)) {
      localStorage.setItem(ONBOARD_KEY, '1');
      app.showHelp();
    }
  } catch {
    // localStorage が使えない環境
  }

  // デバッグ・自動テスト用 (開発者ツールから操作できる)
  (window as unknown as { __pocket: unknown }).__pocket = app;
}

void boot();
