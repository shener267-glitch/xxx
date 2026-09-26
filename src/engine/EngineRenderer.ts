import { ACESFilmicToneMapping, PCFShadowMap, SRGBColorSpace, WebGLRenderer } from 'three';
import type { Camera, Scene } from 'three';
import type { QualityLevel } from '../core/settings';

export type ResizeListener = (width: number, height: number) => void;

/**
 * WebGL レンダラーとキャンバスの管理。
 * スマートフォンでは WebGL コンテキスト数に制限があるため、
 * エディタと Play Mode で1つのレンダラーを共有する。
 */
export class EngineRenderer {
  readonly renderer: WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  width = 1;
  height = 1;
  private listeners = new Set<ResizeListener>();
  private observer: ResizeObserver;
  private quality: QualityLevel;

  constructor(
    private container: HTMLElement,
    opts: { quality: QualityLevel; shadows: boolean },
  ) {
    this.quality = opts.quality;
    this.renderer = new WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.shadowMap.enabled = opts.shadows;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'viewport-canvas';
    this.canvas.setAttribute('aria-label', '3Dビュー');
    container.appendChild(this.canvas);
    this.applyPixelRatio();

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();

    this.canvas.addEventListener('webglcontextlost', (e) => {
      // 画面ロック等でコンテキストが失われた場合、復帰を待つ
      e.preventDefault();
    });
  }

  static isSupported(): boolean {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      return false;
    }
  }

  onResize(fn: ResizeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  resize(): void {
    const w = Math.max(1, Math.floor(this.container.clientWidth));
    const h = Math.max(1, Math.floor(this.container.clientHeight));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    for (const fn of this.listeners) fn(w, h);
  }

  /** 画質に応じて解像度 (ピクセル比) を切り替える。スマホでは描画負荷に直結する */
  setQuality(q: QualityLevel): void {
    if (this.quality === q) return;
    this.quality = q;
    this.applyPixelRatio();
    for (const fn of this.listeners) fn(this.width, this.height);
  }

  private applyPixelRatio(): void {
    const dpr = window.devicePixelRatio || 1;
    const ratio = this.quality === 'low' ? 1 : this.quality === 'medium' ? Math.min(dpr, 1.5) : Math.min(dpr, 2.5);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.width, this.height, false);
  }

  setShadows(on: boolean): void {
    if (this.renderer.shadowMap.enabled === on) return;
    this.renderer.shadowMap.enabled = on;
    this.renderer.shadowMap.needsUpdate = true;
  }

  render(scene: Scene, camera: Camera): void {
    this.renderer.render(scene, camera);
  }

  /** 現在の描画内容から小さなサムネイル画像 (JPEG の dataURL) を作る */
  captureThumbnail(render: () => void, width = 240, height = 150): string | null {
    try {
      render();
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const src = this.canvas;
      // 中央をアスペクト比を保って切り出す
      const scale = Math.max(width / src.width, height / src.height);
      const sw = width / scale;
      const sh = height / scale;
      ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, width, height);
      return c.toDataURL('image/jpeg', 0.72);
    } catch {
      return null;
    }
  }

  dispose(): void {
    this.observer.disconnect();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
