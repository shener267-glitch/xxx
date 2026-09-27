import { DoubleSide, Mesh, MeshBasicMaterial, RingGeometry, Vector3 } from 'three';
import type { Ray, Scene } from 'three';
import { setEntityValue } from '../core/actions';
import type { Editor } from '../core/Editor';
import { applyBrush, heightAt, roundHeights } from '../core/terrain';
import type { BrushTool } from '../core/terrain';
import type { TerrainData } from '../core/types';
import { clone } from '../core/util';
import type { SceneBridge } from './SceneBridge';
import { raycastTerrainObject, refreshTerrainMesh } from './terrainMesh';

/**
 * 地形のブラシ編集 (エディタ)。
 * ブラシモード中は 1 本指のドラッグで地形を盛る・下げる・なめらかにする・平らにする。
 * なぞっている間は作業用のコピーを変えて見た目だけ更新し、指を離したときに 1 回の Undo 単位として保存する。
 */

export interface BrushSettings {
  tool: BrushTool;
  /** 半径 (m) */
  radius: number;
  /** 強さ 0〜1 */
  strength: number;
}

interface Stroke {
  id: string;
  work: TerrainData;
  /** 平らにする高さ (なぞり始めの地点の高さ) */
  target: number;
  x: number;
  y: number;
  last: number;
  changed: boolean;
}

export class TerrainBrush {
  /** 編集中の地形 (null = ブラシモードではない) */
  target: string | null = null;
  settings: BrushSettings = { tool: 'raise', radius: 3, strength: 0.5 };
  onChange: (() => void) | null = null;
  private stroke: Stroke | null = null;
  private sized = false;
  private raf = 0;
  private cursor: Mesh<RingGeometry, MeshBasicMaterial>;

  constructor(
    private editor: Editor,
    private bridge: SceneBridge,
    scene: Scene,
    private rayAt: (clientX: number, clientY: number) => Ray,
    private requestRender: () => void,
  ) {
    this.cursor = new Mesh(
      new RingGeometry(0.86, 1, 48),
      new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false, side: DoubleSide }),
    );
    // 中を薄く塗る (どこまで効くか分かりやすく)
    const fill = new Mesh(new RingGeometry(0, 0.86, 48), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthTest: false, side: DoubleSide }));
    fill.renderOrder = 999;
    fill.userData.noPick = true;
    this.cursor.add(fill);
    this.cursor.rotation.x = -Math.PI / 2;
    this.cursor.renderOrder = 999;
    this.cursor.visible = false;
    this.cursor.userData.noPick = true;
    this.cursor.name = '__brushCursor';
    scene.add(this.cursor);
  }

  get active(): boolean {
    return this.target !== null;
  }

  get stroking(): boolean {
    return this.stroke !== null;
  }

  start(id: string): boolean {
    const e = this.editor.scene.get(id);
    if (!e || e.kind !== 'terrain' || !e.terrain) return false;
    // ブラシの大きさは地形の大きさに合わせる (初回のみ)
    if (!this.sized) {
      this.settings.radius = Math.max(1, Math.min(20, Math.round((e.terrain.size * Math.abs(e.transform.scale[0] || 1)) / 12)));
      this.sized = true;
    }
    this.target = id;
    this.onChange?.();
    return true;
  }

  stop(): void {
    if (this.stroke) this.end(false);
    this.target = null;
    this.cursor.visible = false;
    this.requestRender();
    this.onChange?.();
  }

  setSettings(patch: Partial<BrushSettings>): void {
    this.settings = { ...this.settings, ...patch };
    this.updateCursorColor();
    this.onChange?.();
  }

  /** 画面座標の先の地形の点 (ワールド) */
  private hit(clientX: number, clientY: number): Vector3 | null {
    const id = this.target;
    const e = id ? this.editor.scene.get(id) : undefined;
    const obj = id ? this.bridge.get(id) : undefined;
    if (!e?.terrain || !obj) return null;
    return raycastTerrainObject(obj, this.stroke?.work ?? e.terrain, this.rayAt(clientX, clientY));
  }

  /** なぞり始め。地形の上なら true */
  begin(clientX: number, clientY: number): boolean {
    const id = this.target;
    const e = id ? this.editor.scene.get(id) : undefined;
    if (!id || !e?.terrain || e.locked) return false;
    const p = this.hit(clientX, clientY);
    if (!p) return false;
    const work = clone(e.terrain);
    const local = this.toLocal(p);
    this.stroke = { id, work, target: heightAt(work, local.x, local.z), x: clientX, y: clientY, last: performance.now(), changed: false };
    this.showCursor(p);
    this.apply(1 / 30);
    this.raf = requestAnimationFrame(this.tick);
    return true;
  }

  move(clientX: number, clientY: number): void {
    if (!this.stroke) return;
    this.stroke.x = clientX;
    this.stroke.y = clientY;
  }

  /** マウスで指していないときのカーソル表示 */
  hover(clientX: number, clientY: number): void {
    if (!this.active || this.stroke) return;
    const p = this.hit(clientX, clientY);
    if (p) this.showCursor(p);
    else this.cursor.visible = false;
    this.requestRender();
  }

  /** 指を離したとき。cancel なら元に戻す */
  end(cancel: boolean): void {
    const s = this.stroke;
    if (!s) return;
    this.stroke = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    const e = this.editor.scene.get(s.id);
    const obj = this.bridge.get(s.id);
    if (cancel || !s.changed || !e?.terrain) {
      // 見た目を元のデータに戻す
      const content = obj?.userData.content;
      if (content instanceof Mesh && e?.terrain) {
        refreshTerrainMesh(content, e.terrain);
        content.userData.terrainKey = '';
      }
    } else {
      setEntityValue(this.editor, [s.id], 'terrain.heights', roundHeights(s.work.heights), { label: '地形を編集' });
    }
    this.cursor.visible = false;
    this.requestRender();
  }

  private tick = (now: number) => {
    const s = this.stroke;
    if (!s) return;
    const dt = Math.min(0.05, Math.max(0, (now - s.last) / 1000));
    s.last = now;
    this.apply(dt);
    this.raf = requestAnimationFrame(this.tick);
  };

  private apply(dt: number): void {
    const s = this.stroke;
    if (!s || dt <= 0) return;
    const p = this.hit(s.x, s.y);
    if (!p) {
      this.cursor.visible = false;
      return;
    }
    const obj = this.bridge.get(s.id);
    const local = this.toLocal(p);
    const scale = obj ? Math.abs(obj.getWorldScale(new Vector3()).x) || 1 : 1;
    const changed = applyBrush(
      s.work,
      local.x,
      local.z,
      { tool: this.settings.tool, radius: this.settings.radius / scale, strength: this.settings.strength, target: s.target },
      dt,
    );
    if (changed) {
      s.changed = true;
      const content = obj?.userData.content;
      if (content instanceof Mesh) refreshTerrainMesh(content, s.work);
    }
    this.showCursor(p);
    this.requestRender();
  }

  private toLocal(world: Vector3): Vector3 {
    const obj = this.target ? this.bridge.get(this.target) : undefined;
    if (!obj) return world.clone();
    obj.updateWorldMatrix(true, false);
    return world.clone().applyMatrix4(obj.matrixWorld.clone().invert());
  }

  private showCursor(p: Vector3): void {
    this.cursor.visible = true;
    this.cursor.position.copy(p).add(new Vector3(0, 0.05, 0));
    this.cursor.scale.setScalar(this.settings.radius);
    this.updateCursorColor();
  }

  private updateCursorColor(): void {
    const colors: Record<BrushTool, number> = { raise: 0x7dd3fc, lower: 0xfca5a5, smooth: 0xfde68a, flatten: 0xc4b5fd };
    this.cursor.material.color.setHex(colors[this.settings.tool]);
    for (const c of this.cursor.children) ((c as Mesh).material as MeshBasicMaterial).color.setHex(colors[this.settings.tool]);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.cursor.removeFromParent();
    this.cursor.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose();
      (m.material as MeshBasicMaterial | undefined)?.dispose();
    });
  }
}
