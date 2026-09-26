import { createEntity, defaultModel } from './catalog';
import type { AssetEntry, EntityData, Vec3 } from './types';
import { createId } from './util';

/**
 * アセットを 3D ビューに置くときのオブジェクトを作る。
 * - 3D モデル → モデルのオブジェクト (大きすぎる / 小さすぎるモデルは 2m 前後に合わせる)
 * - 画像 → 画像を貼った板 (縦長・横長に合わせる)
 * - 音声 → 効果音を鳴らすオブジェクト
 */

export function canPlaceAsset(a: AssetEntry): boolean {
  return a.type === 'model' || a.type === 'image' || a.type === 'audio';
}

export function entityFromAsset(a: AssetEntry, ground: Vec3): EntityData | null {
  switch (a.type) {
    case 'model': {
      const e = createEntity('empty', a.name);
      e.kind = 'model';
      const size = a.info?.modelSize ?? [1, 1, 1];
      const center = a.info?.modelCenter ?? [0, 0.5, 0];
      e.model = { ...defaultModel(a.id), size: [...size] as Vec3, center: [...center] as Vec3 };
      const max = Math.max(...size);
      const k = max > 20 || max < 0.05 ? 2 / Math.max(1e-4, max) : 1;
      const s = Math.round(k * 1000) / 1000;
      e.transform.scale = [s, s, s];
      // モデルの底が地面に来るように置く
      const bottom = center[1] - size[1] / 2;
      e.transform.position = [ground[0], Math.round((ground[1] - bottom * s) * 1000) / 1000, ground[2]];
      e.components = [];
      return e;
    }
    case 'image': {
      const e = createEntity('plane', a.name);
      const w = a.info?.width || 1;
      const h = a.info?.height || 1;
      const aspect = w / h;
      const height = aspect >= 1 ? 2 / aspect : 2;
      const width = aspect >= 1 ? 2 : 2 * aspect;
      e.transform.rotation = [90, 0, 0];
      e.transform.scale = [Math.round(width * 100) / 100, 1, Math.round(height * 100) / 100];
      e.transform.position = [ground[0], Math.round((ground[1] + height / 2) * 100) / 100, ground[2]];
      const m = e.mesh!.material;
      m.preset = 'unlit';
      m.color = '#ffffff';
      m.texture = a.id;
      e.mesh!.castShadow = false;
      return e;
    }
    case 'audio': {
      const e = createEntity('empty', a.name);
      e.transform.position = [...ground];
      e.components.push({ id: createId('c'), type: 'sound', enabled: true, props: { sound: a.id, volume: 1, delay: 0, repeat: 0 } });
      return e;
    }
    default:
      return null;
  }
}
