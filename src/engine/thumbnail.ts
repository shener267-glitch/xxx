import { AmbientLight, Box3, Color, DirectionalLight, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderTarget } from 'three';
import type { Object3D, WebGLRenderer } from 'three';

/**
 * 3D モデルや Prefab の小さな画像 (アセット一覧用) を作る。
 * 画面用のレンダラーを使い、別の描画先に描いてから画像にする (WebGL をもう1つ作らない)。
 */
export function renderThumbnail(renderer: WebGLRenderer, object: Object3D, size = 128, background = '#2a303a'): string | null {
  const scene = new Scene();
  scene.background = new Color(background);
  scene.add(new AmbientLight(0xffffff, 0.9));
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  const parent = object.parent;
  scene.add(object);
  object.updateMatrixWorld(true);
  const box = new Box3().setFromObject(object);
  const target = new WebGLRenderTarget(size, size);
  target.texture.colorSpace = SRGBColorSpace;
  try {
    const camera = new PerspectiveCamera(35, 1, 0.01, 1000);
    if (!box.isEmpty()) {
      const center = box.getCenter(new Vector3());
      const radius = Math.max(0.05, box.getSize(new Vector3()).length() / 2);
      const dist = radius / Math.sin((35 * Math.PI) / 360);
      camera.position.copy(center).add(new Vector3(0.9, 0.7, 1.1).normalize().multiplyScalar(dist));
      camera.near = dist / 100;
      camera.far = dist * 10;
      camera.updateProjectionMatrix();
      camera.lookAt(center);
    }
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const pixels = new Uint8Array(size * size * 4);
    renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
    renderer.setRenderTarget(prevTarget);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    // WebGL は下から上の順なので上下を反転する
    for (let y = 0; y < size; y++) {
      img.data.set(pixels.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return null;
  } finally {
    target.dispose();
    scene.remove(object);
    if (parent) parent.add(object);
  }
}

/** 画像の小さな版 (data URL) と元の大きさ */
export async function imageThumbnail(blob: Blob, size = 128): Promise<{ thumb: string | null; width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth;
    const hgt = img.naturalHeight;
    const scale = Math.min(1, size / Math.max(w, hgt, 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(hgt * scale));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return { thumb: c.toDataURL('image/png'), width: w, height: hgt };
  } catch {
    return { thumb: null, width: 0, height: 0 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 音声の長さ (秒) */
export function audioDuration(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    const done = (v: number) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(v) ? v : 0);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 4000);
    a.src = url;
  });
}
