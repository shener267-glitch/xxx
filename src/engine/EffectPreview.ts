import type { Object3D } from 'three';
import type { Editor } from '../core/Editor';
import type { QualityLevel } from '../core/settings';
import { MAX_PARTICLES, ParticleEmitter, settingsFromProps } from './particles';
import type { SceneBridge } from './SceneBridge';

/**
 * エディタでのパーティクルのプレビュー。
 * 選択中のオブジェクト (または「エフェクトのプレビュー」ON のときはすべて) の粒を動かす。
 */
export class EffectPreview {
  private items = new Map<string, { emitter: ParticleEmitter; sig: string; idle: number }>();

  constructor(
    private editor: Editor,
    private bridge: SceneBridge,
    private root: Object3D,
  ) {}

  /** シーンのデータに合わせて発生源を作り直す */
  sync(quality: QualityLevel, viewportHeight: number): void {
    const seen = new Set<string>();
    for (const e of Object.values(this.editor.sceneData.entities)) {
      const c = e.components.find((x) => x.enabled && x.type === 'particles');
      if (!c) continue;
      seen.add(e.id);
      const sig = `${JSON.stringify(c.props)}:${quality}`;
      const cur = this.items.get(e.id);
      if (cur && cur.sig === sig) continue;
      cur?.emitter.dispose();
      const emitter = new ParticleEmitter(settingsFromProps(c.props), MAX_PARTICLES[quality]);
      emitter.setViewportHeight(viewportHeight);
      emitter.points.visible = false;
      this.root.add(emitter.points);
      this.items.set(e.id, { emitter, sig, idle: 0 });
    }
    for (const [id, it] of this.items) {
      if (seen.has(id)) continue;
      it.emitter.dispose();
      this.items.delete(id);
    }
  }

  setViewportHeight(h: number): void {
    for (const it of this.items.values()) it.emitter.setViewportHeight(h);
  }

  /** 動かしたものがあれば true (再描画が必要) */
  update(dt: number, isActive: (id: string) => boolean): boolean {
    let any = false;
    for (const [id, it] of this.items) {
      const obj = this.bridge.get(id);
      const e = this.editor.scene.get(id);
      const active = !!obj && !!e && e.visible && isActive(id);
      it.emitter.points.visible = active;
      if (!active || !obj) continue;
      any = true;
      obj.updateWorldMatrix(true, false);
      // 一度だけ出る種類 (爆発など) は、少し間をあけてくり返し見せる
      if (it.emitter.alive === 0) {
        it.idle += dt;
        if (it.idle > 0.8) {
          it.idle = 0;
          it.emitter.burst();
        }
      }
      it.emitter.update(dt, obj.matrixWorld);
    }
    return any;
  }

  dispose(): void {
    for (const it of this.items.values()) it.emitter.dispose();
    this.items.clear();
  }
}
