/**
 * iOS Safari は viewport の user-scalable=no を無視してピンチでページ全体を拡大するため、
 * パネルやボタンの上で 2 本指を使うと画面が拡大されたままになる。
 * Safari 独自の gesture イベントを止めて、ページの拡大を防ぐ (3D ビューのピンチはアプリ側で処理する)。
 */
export function preventPageZoom(): void {
  const stop = (e: Event) => e.preventDefault();
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, stop, { passive: false });
  }
}
