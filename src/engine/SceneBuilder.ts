import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  SphereGeometry,
  SpotLight,
} from 'three';
import type { Light, Material } from 'three';
import type { QualityLevel } from '../core/settings';
import { safeScale } from '../core/transformMath';
import type { EntityData, PrimitiveShape } from '../core/types';
import { createMaterial, disposeMaterial, materialSignature, updateMaterial } from './materials';

/**
 * EntityData から Three.js のオブジェクトを生成・更新する。
 * エディタ (editor: true) では、カメラ・ライトなど見えない物に
 * 「選択用の代理表示 (プロキシ)」を追加する。Play Mode では生成しない。
 */

export interface EntityUserData {
  entityId: string;
  /** 形状・種類が変わったかを判定するための署名 */
  signature: string;
  proxyKey: string;
  content: Object3D | null;
  proxy: Object3D | null;
  picker: Mesh | null;
  /** レイキャストで選択判定に使うメッシュ */
  pickTargets: Object3D[];
}

export type EntityObject = Group & { userData: EntityUserData };

export function isEntityObject(o: Object3D | null | undefined): o is EntityObject {
  return !!o && typeof (o.userData as Partial<EntityUserData>).entityId === 'string';
}

/** オブジェクトから所属するエンティティのコンテナを探す */
export function findEntityObject(o: Object3D | null): EntityObject | null {
  let cur: Object3D | null = o;
  while (cur) {
    if (isEntityObject(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

// ------------------------------------------------------------------
// 共有ジオメトリ (同じ形状は1つのジオメトリを使い回してメモリを節約)
// ------------------------------------------------------------------

const geometryCache = new Map<PrimitiveShape, BufferGeometry>();
let waterGeometry: BufferGeometry | null = null;

/** 波を表現するための細かく分割した平面 */
export function getWaterGeometry(): BufferGeometry {
  if (!waterGeometry) {
    waterGeometry = new PlaneGeometry(1, 1, 64, 64);
    waterGeometry.rotateX(-Math.PI / 2);
  }
  return waterGeometry;
}

export function getGeometry(shape: PrimitiveShape): BufferGeometry {
  let g = geometryCache.get(shape);
  if (g) return g;
  switch (shape) {
    case 'cube':
      g = new BoxGeometry(1, 1, 1);
      break;
    case 'sphere':
      g = new SphereGeometry(0.5, 40, 20);
      break;
    case 'plane':
      g = new PlaneGeometry(1, 1);
      g.rotateX(-Math.PI / 2);
      break;
    case 'cylinder':
      g = new CylinderGeometry(0.5, 0.5, 1, 40);
      break;
    case 'cone':
      g = new ConeGeometry(0.5, 1, 40);
      break;
    case 'capsule':
      g = new CapsuleGeometry(0.5, 1, 8, 24);
      break;
  }
  geometryCache.set(shape, g);
  return g;
}

// ------------------------------------------------------------------
// エディタ用プロキシ
// ------------------------------------------------------------------

const proxyGrayMat = new MeshBasicMaterial({ color: 0xaab3c0 });
const proxyLineMat = new LineBasicMaterial({ color: 0xaab3c0, transparent: true, opacity: 0.8 });
const pickerMat = new MeshBasicMaterial({ visible: false });
const pickerSphere = new SphereGeometry(0.45, 8, 6);
const pickerBox = new BoxGeometry(0.9, 0.7, 0.9);

function lines(points: number[], material = proxyLineMat): LineSegments {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(points, 3));
  const l = new LineSegments(g, material);
  l.userData.ownGeometry = true;
  return l;
}

function tinted<T extends Object3D>(o: T): T {
  o.userData.tint = true;
  return o;
}

function markNoShadow(o: Object3D): void {
  o.traverse((c) => {
    c.castShadow = false;
    c.receiveShadow = false;
  });
}

function createCameraProxy(e: EntityData): { proxy: Object3D; picker: Mesh } {
  const g = new Group();
  const body = new Mesh(new BoxGeometry(0.34, 0.26, 0.3), proxyGrayMat);
  body.userData.ownGeometry = true;
  const lens = new Mesh(new ConeGeometry(0.12, 0.2, 16, 1, true), proxyGrayMat);
  lens.userData.ownGeometry = true;
  lens.rotation.x = Math.PI / 2;
  lens.position.z = -0.22;
  // 視錐台 (撮影範囲) を線で表示
  const fov = MathUtils.degToRad(e.camera?.fov ?? 60);
  const d = 1.4;
  const hh = Math.tan(fov / 2) * d;
  const hw = hh * (16 / 9);
  const p = [
    [-hw, hh, -d],
    [hw, hh, -d],
    [hw, -hh, -d],
    [-hw, -hh, -d],
  ];
  const pts: number[] = [];
  for (const c of p) pts.push(0, 0, 0, c[0], c[1], c[2]);
  for (let i = 0; i < 4; i++) {
    const a = p[i];
    const b = p[(i + 1) % 4];
    pts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }
  // 上方向を示す三角
  pts.push(-hw * 0.3, hh * 1.1, -d, 0, hh * 1.4, -d, 0, hh * 1.4, -d, hw * 0.3, hh * 1.1, -d);
  g.add(body, lens, lines(pts));
  const picker = new Mesh(pickerBox, pickerMat);
  g.add(picker);
  markNoShadow(g);
  return { proxy: g, picker };
}

function createLightProxy(e: EntityData): { proxy: Object3D; picker: Mesh } {
  const g = new Group();
  const color = new Color(e.light?.color ?? '#ffffff');
  const mat = new MeshBasicMaterial({ color });
  const bulb = new Mesh(new SphereGeometry(0.16, 16, 10), mat);
  bulb.userData.ownGeometry = true;
  bulb.userData.ownMaterial = true;
  bulb.userData.tint = true;
  g.add(bulb);
  const type = e.light?.type;
  if (type === 'directional' || type === 'spot') {
    // 照射方向 (-Z) を矢印で表示
    const len = type === 'directional' ? 1.6 : 1.2;
    const pts = [0, 0, 0, 0, 0, -len, 0, 0, -len, 0.1, 0, -len + 0.2, 0, 0, -len, -0.1, 0, -len + 0.2];
    if (type === 'directional') {
      for (const [x, y] of [
        [0.25, 0],
        [-0.25, 0],
        [0, 0.25],
        [0, -0.25],
      ]) {
        pts.push(x, y, 0, x, y, -len * 0.6);
      }
    }
    g.add(tinted(lines(pts, new LineBasicMaterial({ color }))));
  } else {
    // 周囲に光る放射線
    const pts: number[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      pts.push(Math.cos(a) * 0.24, Math.sin(a) * 0.24, 0, Math.cos(a) * 0.38, Math.sin(a) * 0.38, 0);
    }
    g.add(tinted(lines(pts, new LineBasicMaterial({ color }))));
  }
  const picker = new Mesh(pickerSphere, pickerMat);
  g.add(picker);
  markNoShadow(g);
  return { proxy: g, picker };
}

function createEmptyProxy(): { proxy: Object3D; picker: Mesh } {
  const g = new Group();
  const s = 0.3;
  g.add(lines([-s, 0, 0, s, 0, 0, 0, -s, 0, 0, s, 0, 0, 0, -s, 0, 0, s]));
  const picker = new Mesh(new SphereGeometry(0.3, 8, 6), pickerMat);
  picker.userData.ownGeometry = true;
  g.add(picker);
  return { proxy: g, picker };
}

// ------------------------------------------------------------------
// ライト
// ------------------------------------------------------------------

function createLight(e: EntityData, shadowMapSize: number): Object3D {
  const l = e.light!;
  switch (l.type) {
    case 'directional': {
      const light = new DirectionalLight();
      light.target.position.set(0, 0, -1);
      light.add(light.target);
      const cam = light.shadow.camera;
      cam.left = -18;
      cam.right = 18;
      cam.top = 18;
      cam.bottom = -18;
      cam.near = 0.5;
      cam.far = 80;
      light.shadow.mapSize.set(shadowMapSize, shadowMapSize);
      light.shadow.bias = -0.0004;
      light.shadow.normalBias = 0.03;
      return light;
    }
    case 'point': {
      const light = new PointLight();
      light.shadow.mapSize.set(512, 512);
      light.shadow.bias = -0.002;
      return light;
    }
    case 'spot': {
      const light = new SpotLight();
      light.target.position.set(0, 0, -1);
      light.add(light.target);
      light.shadow.mapSize.set(shadowMapSize / 2, shadowMapSize / 2);
      light.shadow.bias = -0.0008;
      return light;
    }
    case 'hemisphere':
      return new HemisphereLight();
    case 'ambient':
      return new AmbientLight();
  }
}

function updateLight(obj: Object3D, e: EntityData): void {
  const l = e.light!;
  const light = obj as Light;
  light.color.set(l.color);
  light.intensity = l.intensity;
  if (obj instanceof HemisphereLight) obj.groundColor.set(l.groundColor);
  if (obj instanceof PointLight) {
    obj.distance = l.distance;
    obj.decay = 2;
    obj.castShadow = l.castShadow;
  }
  if (obj instanceof SpotLight) {
    obj.distance = l.distance;
    obj.decay = 2;
    obj.angle = MathUtils.degToRad(MathUtils.clamp(l.angle, 1, 89));
    obj.penumbra = MathUtils.clamp(l.penumbra, 0, 1);
    obj.castShadow = l.castShadow;
  }
  if (obj instanceof DirectionalLight) obj.castShadow = l.castShadow;
}

// ------------------------------------------------------------------
// SceneBuilder
// ------------------------------------------------------------------

export interface SceneBuilderOptions {
  /** エディタ用のプロキシ表示を作るか */
  editor: boolean;
  quality?: QualityLevel;
}

const SHADOW_MAP_SIZE: Record<QualityLevel, number> = { low: 512, medium: 1024, high: 2048 };

export class SceneBuilder {
  private shadowMapSize: number;
  quality: QualityLevel;

  constructor(private opts: SceneBuilderOptions) {
    this.quality = opts.quality ?? 'medium';
    this.shadowMapSize = SHADOW_MAP_SIZE[this.quality];
  }

  /** 画質を変更する (以後に作り直すマテリアル・影に反映) */
  setQuality(q: QualityLevel): void {
    this.quality = q;
    this.shadowMapSize = SHADOW_MAP_SIZE[q];
  }

  create(e: EntityData): EntityObject {
    const obj = new Group() as unknown as EntityObject;
    obj.name = e.name;
    obj.userData = { entityId: e.id, signature: '', proxyKey: '', content: null, proxy: null, picker: null, pickTargets: [] };
    this.apply(obj, e);
    return obj;
  }

  private signature(e: EntityData): string {
    switch (e.kind) {
      case 'mesh':
        return `mesh:${e.mesh?.shape}:${e.mesh ? materialSignature(e.mesh.material, e.mesh.shape, { quality: this.quality }) : ''}`;
      case 'light':
        return `light:${e.light?.type}:${e.light?.type === 'directional' || e.light?.type === 'spot' ? this.shadowMapSize : ''}`;
      case 'camera':
        return 'camera';
      default:
        return 'empty';
    }
  }

  applyTransform(obj: Object3D, e: EntityData): void {
    const t = e.transform;
    obj.position.set(t.position[0], t.position[1], t.position[2]);
    obj.rotation.set(
      MathUtils.degToRad(t.rotation[0]),
      MathUtils.degToRad(t.rotation[1]),
      MathUtils.degToRad(t.rotation[2]),
      'XYZ',
    );
    obj.scale.set(safeScale(t.scale[0]), safeScale(t.scale[1]), safeScale(t.scale[2]));
  }

  /** エンティティのデータをオブジェクトへ反映する */
  apply(obj: EntityObject, e: EntityData): void {
    obj.name = e.name;
    obj.visible = e.visible;
    this.applyTransform(obj, e);

    const ud = obj.userData;
    const sig = this.signature(e);
    if (ud.signature !== sig) {
      this.rebuildContent(obj, e);
      ud.signature = sig;
      ud.proxyKey = '';
    }
    if (this.opts.editor) {
      // カメラのプロキシ (視錐台) は画角に依存するため、画角が変わったら作り直す
      const proxyKey = e.kind === 'camera' ? `camera:${e.camera?.fov}` : sig;
      if (ud.proxyKey !== proxyKey) {
        this.rebuildProxy(obj, e);
        ud.proxyKey = proxyKey;
      }
      if (e.kind === 'light' && e.light && ud.proxy) {
        ud.proxy.traverse((o) => {
          const m = (o as Mesh).material as MeshBasicMaterial | undefined;
          if (m && o.userData.tint) m.color.set(e.light!.color);
        });
      }
    }

    const content = ud.content;
    if (e.kind === 'mesh' && e.mesh && content instanceof Mesh) {
      updateMaterial(content.material as Material, e.mesh.material);
      content.castShadow = e.mesh.castShadow;
      content.receiveShadow = e.mesh.receiveShadow;
    } else if (e.kind === 'light' && e.light && content) {
      updateLight(content, e);
    } else if (e.kind === 'camera' && e.camera && content instanceof PerspectiveCamera) {
      content.fov = e.camera.fov;
      content.near = Math.max(0.01, e.camera.near);
      content.far = Math.max(content.near + 0.1, e.camera.far);
      content.updateProjectionMatrix();
    }
  }

  private rebuildContent(obj: EntityObject, e: EntityData): void {
    const ud = obj.userData;
    if (ud.content) {
      obj.remove(ud.content);
      disposeObject(ud.content);
    }
    ud.content = null;

    if (e.kind === 'mesh' && e.mesh) {
      const geometry = e.mesh.material.preset === 'water' && e.mesh.shape === 'plane' ? getWaterGeometry() : getGeometry(e.mesh.shape);
      const mesh = new Mesh(geometry, createMaterial(e.mesh.material, e.mesh.shape, { quality: this.quality }));
      mesh.userData.ownMaterial = true;
      ud.content = mesh;
    } else if (e.kind === 'light' && e.light) {
      ud.content = createLight(e, this.shadowMapSize);
    } else if (e.kind === 'camera' && e.camera) {
      ud.content = new PerspectiveCamera(e.camera.fov, 16 / 9, e.camera.near, e.camera.far);
    }
    if (ud.content) {
      ud.content.userData.isContent = true;
      obj.add(ud.content);
    }
    this.updatePickTargets(obj);
  }

  private rebuildProxy(obj: EntityObject, e: EntityData): void {
    const ud = obj.userData;
    if (ud.proxy) {
      obj.remove(ud.proxy);
      disposeObject(ud.proxy);
    }
    ud.proxy = null;
    ud.picker = null;
    let made: { proxy: Object3D; picker: Mesh } | null = null;
    if (e.kind === 'camera') made = createCameraProxy(e);
    else if (e.kind === 'light') made = createLightProxy(e);
    else if (e.kind === 'empty') made = createEmptyProxy();
    if (made) {
      made.proxy.userData.isProxy = true;
      ud.proxy = made.proxy;
      ud.picker = made.picker;
      obj.add(made.proxy);
    }
    this.updatePickTargets(obj);
  }

  private updatePickTargets(obj: EntityObject): void {
    const ud = obj.userData;
    ud.pickTargets = [];
    if (ud.content instanceof Mesh) ud.pickTargets.push(ud.content);
    if (ud.picker) ud.pickTargets.push(ud.picker);
  }

  dispose(obj: EntityObject): void {
    const ud = obj.userData;
    if (ud.content) disposeObject(ud.content);
    if (ud.proxy) disposeObject(ud.proxy);
    ud.content = null;
    ud.proxy = null;
    ud.picker = null;
    ud.pickTargets = [];
  }
}

/** 個別に作ったジオメトリ・マテリアル・シャドウマップを解放する (共有物は解放しない) */
export function disposeObject(root: Object3D): void {
  root.traverse((o) => {
    if ((o as Light).isLight) (o as Light).dispose();
    if (o instanceof Mesh || o instanceof LineSegments) {
      if (o.userData.ownGeometry) o.geometry.dispose();
      if (o.userData.ownMaterial || o instanceof LineSegments) {
        const mats = (Array.isArray(o.material) ? o.material : [o.material]) as Material[];
        for (const m of mats) if (m !== proxyLineMat && m !== pickerMat && m !== proxyGrayMat) disposeMaterial(m);
      }
    }
  });
}
