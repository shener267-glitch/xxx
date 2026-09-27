import { logger } from '../core/logger';

/**
 * 全画面表示 (エディタの Play と書き出したゲームで共通)。
 * iPad などの Safari は webkit 付きの名前、iPhone の Safari は非対応 (ホーム画面に追加すると全画面になる)。
 */

interface FullscreenDoc {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
}

interface FullscreenEl {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

export function fullscreenSupported(): boolean {
  const d = document as Document & FullscreenDoc;
  return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled);
}

export function isFullscreen(): boolean {
  const d = document as Document & FullscreenDoc;
  return !!(d.fullscreenElement || d.webkitFullscreenElement);
}

/** 全画面にする / 戻す。結果 (全画面かどうか) を返す。対応していなければ何もしない */
export async function setFullscreen(on: boolean, el: HTMLElement = document.documentElement): Promise<boolean> {
  const d = document as Document & FullscreenDoc;
  try {
    if (on && !isFullscreen()) {
      const e = el as HTMLElement & FullscreenEl;
      if (e.requestFullscreen) await e.requestFullscreen({ navigationUI: 'hide' });
      else await e.webkitRequestFullscreen?.();
    } else if (!on && isFullscreen()) {
      if (d.exitFullscreen) await d.exitFullscreen();
      else await d.webkitExitFullscreen?.();
    }
  } catch (err) {
    logger.warn('全画面を切り替えられませんでした', '全画面', err);
  }
  return isFullscreen();
}

export function onFullscreenChange(fn: () => void): () => void {
  document.addEventListener('fullscreenchange', fn);
  document.addEventListener('webkitfullscreenchange', fn);
  return () => {
    document.removeEventListener('fullscreenchange', fn);
    document.removeEventListener('webkitfullscreenchange', fn);
  };
}
