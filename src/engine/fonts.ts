import { resolveAsset } from './textures';

/**
 * フォントアセット (TTF / OTF / WOFF) を CSS のフォントとして使えるようにする。
 * フォント名は「pe-font-<アセットID>」。
 */

const loaded = new Map<string, Promise<boolean>>();

export function fontFamily(assetId: string): string {
  return `pe-font-${assetId}`;
}

/** CSS の font-family の値 (読み込めなければ標準のフォント) */
export function fontStack(assetId: string | null | undefined): string {
  return assetId ? `"${fontFamily(assetId)}", var(--font, system-ui, sans-serif)` : '';
}

/** データからフォントを読み込んで登録する */
export async function registerFont(assetId: string, data: ArrayBuffer): Promise<boolean> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return false;
  const face = new FontFace(fontFamily(assetId), data);
  await face.load();
  document.fonts.add(face);
  return true;
}

/** アセットのフォントを使えるようにする (1回だけ読み込む) */
export function ensureFont(assetId: string): Promise<boolean> {
  let p = loaded.get(assetId);
  if (!p) {
    p = (async () => {
      const blob = await resolveAsset(assetId);
      if (!blob) return false;
      return registerFont(assetId, await blob.arrayBuffer());
    })().catch(() => false);
    loaded.set(assetId, p);
  }
  return p;
}
