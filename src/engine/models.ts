import { Box3, Group, Mesh, Vector3 } from 'three';
import type { AnimationClip, Object3D } from 'three';
import type { Vec3 } from '../core/types';
import { resolveAsset } from './textures';

/**
 * 3D モデル (glTF / GLB) の読み込み。
 * - 同じアセットは1回だけ読み込み、置くたびに複製する (ジオメトリ・マテリアルは共有)
 * - スキンメッシュ (骨で動くキャラクター) は SkeletonUtils で骨ごと複製する
 * - GLTFLoader は必要になったときだけ読み込む (起動を軽くするため)
 */

export interface LoadedModel {
  scene: Group;
  animations: AnimationClip[];
  size: Vec3;
  center: Vec3;
  triangles: number;
  skinned: boolean;
}

const cache = new Map<string, Promise<LoadedModel | null>>();
const listeners = new Set<() => void>();

/** モデルの読み込みが完了したとき (再描画が必要) */
export function onModelLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

type LoaderModule = typeof import('three/examples/jsm/loaders/GLTFLoader.js');
type SkeletonModule = typeof import('three/examples/jsm/utils/SkeletonUtils.js');
let loaderPromise: Promise<[LoaderModule, SkeletonModule]> | null = null;

function loadModules(): Promise<[LoaderModule, SkeletonModule]> {
  if (!loaderPromise) {
    loaderPromise = Promise.all([import('three/examples/jsm/loaders/GLTFLoader.js'), import('three/examples/jsm/utils/SkeletonUtils.js')]);
  }
  return loaderPromise;
}

/** モデルの大きさ・中心・三角形の数を調べる */
export function analyzeModel(root: Object3D): { size: Vec3; center: Vec3; triangles: number; skinned: boolean } {
  root.updateMatrixWorld(true);
  const box = new Box3().setFromObject(root);
  const size = box.isEmpty() ? new Vector3(1, 1, 1) : box.getSize(new Vector3());
  const center = box.isEmpty() ? new Vector3() : box.getCenter(new Vector3());
  let triangles = 0;
  let skinned = false;
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    if ((o as Mesh & { isSkinnedMesh?: boolean }).isSkinnedMesh) skinned = true;
    const g = m.geometry;
    triangles += g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
  });
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { size: [r(size.x), r(size.y), r(size.z)], center: [r(center.x), r(center.y), r(center.z)], triangles: Math.round(triangles), skinned };
}

/** データ (ArrayBuffer) から読み込む */
export async function parseModel(data: ArrayBuffer): Promise<LoadedModel> {
  const [{ GLTFLoader }] = await loadModules();
  const loader = new GLTFLoader();
  const gltf = await new Promise<{ scene: Group; animations: AnimationClip[] }>((resolve, reject) => {
    loader.parse(data, '', (g) => resolve(g as unknown as { scene: Group; animations: AnimationClip[] }), (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
  const scene = gltf.scene;
  scene.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
      // モデルの部品は共有しているので、個別に破棄しない
      m.userData.sharedModel = true;
    }
  });
  const info = analyzeModel(scene);
  return { scene, animations: gltf.animations ?? [], ...info };
}

/** アセットのモデルを読み込む (キャッシュ) */
export function loadModel(assetId: string): Promise<LoadedModel | null> {
  let p = cache.get(assetId);
  if (!p) {
    p = (async () => {
      const blob = await resolveAsset(assetId);
      if (!blob) return null;
      const model = await parseModel(await blob.arrayBuffer());
      for (const fn of listeners) fn();
      return model;
    })().catch((err) => {
      console.warn('[PocketEngine] 3D モデルを読み込めませんでした', assetId, err);
      return null;
    });
    cache.set(assetId, p);
  }
  return p;
}

/** 置くための複製 (骨があれば骨ごと) */
export async function instantiateModel(assetId: string): Promise<{ object: Object3D; animations: AnimationClip[] } | null> {
  const model = await loadModel(assetId);
  if (!model) return null;
  const [, SkeletonUtils] = await loadModules();
  const object = model.skinned ? SkeletonUtils.clone(model.scene) : model.scene.clone(true);
  object.traverse((o) => {
    o.userData.sharedModel = true;
  });
  return { object, animations: model.animations };
}

export function invalidateModel(assetId: string): void {
  cache.delete(assetId);
}

/** 読み込み中の目印 (半透明の箱) */
export function modelPlaceholder(): Group {
  return new Group();
}
