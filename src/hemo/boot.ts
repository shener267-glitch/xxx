import './hemo.css';
import { loadSettings } from '../core/settings';
import { HemoApp } from './HemoApp';

/** `?mode=hemo` のときだけ main.ts から動的に読み込まれる (通常のバンドルは増えない) */
export function isHemoMode(): boolean {
  try {
    return new URLSearchParams(location.search).get('mode') === 'hemo' || location.hash === '#hemo';
  } catch {
    return false;
  }
}

export function bootHemo(root: HTMLElement): HemoApp {
  const app = new HemoApp(root, loadSettings().quality);
  // デバッグ・自動テスト用
  (window as unknown as { __hemo: HemoApp }).__hemo = app;
  return app;
}
