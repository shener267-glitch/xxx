import {
  AmbientLight,
  Box3,
  Box3Helper,
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  RepeatWrapping,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
} from 'three';
import type { BufferGeometry, Raycaster, Texture } from 'three';
import type { QualityLevel } from '../core/settings';
import { clampToRoom, PROP_DEFS, propRadius, propRestPosition, ROOM } from './lab';
import type { PropDef } from './lab';

/**
 * Project HEMO の実験室 (床・壁・照明・置いてある物)。
 * 見た目だけを持ち、保存や物理は別のモジュールが担当する。
 */

/** 床のタイル模様 (画像ファイル不要)。DOM が無い環境 (テスト) では作らない */
function floorTexture(): Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#9aa1ab';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#a7aeb8';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillRect(64, 64, 64, 64);
  ctx.strokeStyle = 'rgba(40,46,56,0.55)';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, 128, 128);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(ROOM.halfX, ROOM.halfZ);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function propGeometry(def: PropDef): BufferGeometry {
  const [w, h, d] = def.size;
  if (def.shape === 'cylinder') return new CylinderGeometry(w / 2, w / 2, h, 24);
  if (def.shape === 'sphere') return new SphereGeometry(w / 2, 24, 16);
  return new BoxGeometry(w, h, d);
}

export class LabScene {
  readonly scene = new Scene();
  /** 選択・移動できる物 (キーは PropDef.id) */
  readonly props = new Map<string, Mesh>();
  readonly sun: DirectionalLight;
  private selectionBox: Box3Helper;
  private _selectedId: string | null = null;
  private owned: { dispose(): void }[] = [];

  constructor(quality: QualityLevel = 'medium') {
    this.scene.background = new Color('#171a20');

    // --- 照明 ---
    this.scene.add(new AmbientLight('#ffffff', 0.35));
    this.scene.add(new HemisphereLight('#dfe8ff', '#4a4e57', 1.0));
    const sun = new DirectionalLight('#fff4e0', 2.2);
    sun.position.set(4, 7, 3);
    sun.castShadow = true;
    const mapSize = quality === 'high' ? 2048 : quality === 'medium' ? 1024 : 512;
    sun.shadow.mapSize.set(mapSize, mapSize);
    const s = sun.shadow.camera;
    s.left = -8;
    s.right = 8;
    s.top = 8;
    s.bottom = -8;
    s.near = 1;
    s.far = 20;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.sun = sun;
    this.scene.add(sun);
    const lamp = new PointLight('#cfe3ff', 14, 16, 2);
    lamp.position.set(0, ROOM.height - 0.4, 0);
    this.scene.add(lamp);

    // --- 床と壁 (壁は内側だけ描くので、部屋の外から見ても視界を邪魔しない) ---
    const tex = floorTexture();
    if (tex) this.owned.push(tex);
    const floorMat = new MeshStandardMaterial({ color: tex ? '#ffffff' : '#9aa1ab', map: tex, roughness: 0.85, metalness: 0.0 });
    const floorGeo = new PlaneGeometry(ROOM.halfX * 2, ROOM.halfZ * 2);
    this.owned.push(floorMat, floorGeo);
    const floor = new Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.name = 'floor';
    this.scene.add(floor);

    const wallMat = new MeshStandardMaterial({ color: '#c9ced6', roughness: 0.95 });
    this.owned.push(wallMat);
    const walls: { name: string; w: number; pos: [number, number, number]; rotY: number }[] = [
      { name: 'wall-back', w: ROOM.halfX * 2, pos: [0, ROOM.height / 2, -ROOM.halfZ], rotY: 0 },
      { name: 'wall-left', w: ROOM.halfZ * 2, pos: [-ROOM.halfX, ROOM.height / 2, 0], rotY: Math.PI / 2 },
      { name: 'wall-right', w: ROOM.halfZ * 2, pos: [ROOM.halfX, ROOM.height / 2, 0], rotY: -Math.PI / 2 },
    ];
    for (const w of walls) {
      const geo = new PlaneGeometry(w.w, ROOM.height);
      this.owned.push(geo);
      const m = new Mesh(geo, wallMat);
      m.name = w.name;
      m.position.set(...w.pos);
      m.rotation.y = w.rotY;
      m.receiveShadow = true;
      this.scene.add(m);
    }

    // --- 置いてある物 ---
    for (const def of PROP_DEFS) {
      const geo = propGeometry(def);
      const mat = new MeshStandardMaterial({ color: def.color, roughness: 0.65, metalness: def.id === 'barrel' ? 0.35 : 0.05 });
      this.owned.push(geo, mat);
      const mesh = new Mesh(geo, mat);
      mesh.name = def.label;
      mesh.userData.propId = def.id;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.props.set(def.id, mesh);
      this.scene.add(mesh);
    }
    this.resetProps();

    // --- 選択枠 ---
    this.selectionBox = new Box3Helper(new Box3(), new Color('#6aa8ff'));
    this.selectionBox.visible = false;
    this.selectionBox.name = '__selection';
    this.scene.add(this.selectionBox);
  }

  get selectedId(): string | null {
    return this._selectedId;
  }

  def(id: string): PropDef | undefined {
    return PROP_DEFS.find((d) => d.id === id);
  }

  /** 物を最初の位置・向きに戻す (選択も解除) */
  reset(): void {
    this.resetProps();
    this.select(null);
  }

  private resetProps(): void {
    for (const def of PROP_DEFS) {
      const mesh = this.props.get(def.id);
      if (!mesh) continue;
      mesh.position.set(...propRestPosition(def));
      mesh.rotation.set(0, (def.rotationY * Math.PI) / 180, 0);
    }
    this.scene.updateMatrixWorld(true);
  }

  select(id: string | null): void {
    this._selectedId = id && this.props.has(id) ? id : null;
    this.updateSelectionBox();
  }

  updateSelectionBox(): void {
    const mesh = this._selectedId ? this.props.get(this._selectedId) : undefined;
    if (!mesh) {
      this.selectionBox.visible = false;
      return;
    }
    mesh.updateWorldMatrix(true, false);
    this.selectionBox.box.setFromObject(mesh);
    this.selectionBox.visible = true;
  }

  /** 物を床の上で動かす (壁にめり込まない範囲に収める) */
  moveProp(id: string, x: number, z: number): void {
    const mesh = this.props.get(id);
    const def = this.def(id);
    if (!mesh || !def) return;
    const [cx, cz] = clampToRoom(x, z, propRadius(def) + 0.05);
    mesh.position.x = cx;
    mesh.position.z = cz;
    mesh.updateMatrixWorld();
    if (id === this._selectedId) this.updateSelectionBox();
  }

  /** 光線が最初に当たった物の ID */
  pick(raycaster: Raycaster): string | null {
    const hits = raycaster.intersectObjects([...this.props.values()], false);
    const id = hits[0]?.object.userData.propId;
    return typeof id === 'string' ? id : null;
  }

  /** 物のワールド座標での箱 (フォーカス用) */
  boundsOf(id: string): Box3 | null {
    const mesh = this.props.get(id);
    if (!mesh) return null;
    mesh.updateWorldMatrix(true, false);
    return new Box3().setFromObject(mesh);
  }

  dispose(): void {
    for (const o of this.owned) o.dispose();
    this.owned = [];
  }
}
