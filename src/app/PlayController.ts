import { Quaternion, Vector3 } from 'three';
import { commitTransforms } from '../core/actions';
import type { Editor } from '../core/Editor';
import { logger } from '../core/logger';
import type { PlayCameraMode } from '../core/settings';
import type { TransformData } from '../core/types';
import { clone, deepEqual } from '../core/util';
import type { EditorViewport } from '../engine/EditorViewport';
import type { RuntimeStats } from '../runtime/GameRuntime';
import { GameRuntime } from '../runtime/GameRuntime';

export interface PlayListener {
  onStart?(runtime: GameRuntime): void;
  onStop?(): void;
  onStats?(stats: RuntimeStats): void;
  onMessage?(message: string, level: 'info' | 'warn' | 'error'): void;
  onCameraMode?(mode: PlayCameraMode): void;
}

/**
 * エディタ ⇔ Play Mode の切り替え。
 *
 * Play 開始時にプロジェクトを丸ごと複製してランタイムに渡すため、
 * Play 中の変化はエディタのデータに影響しない (Stop で自動的に元に戻る)。
 * 設定「Play 中の変更を保持」が ON の場合のみ、位置などを Undo 可能な形で反映する。
 */
export class PlayController {
  runtime: GameRuntime | null = null;
  private listeners = new Set<PlayListener>();
  /** Play 開始時点のトランスフォーム (変更保持の差分計算用) */
  private startTransforms = new Map<string, TransformData>();

  constructor(
    private editor: Editor,
    private viewport: EditorViewport,
    private overlay: HTMLElement,
  ) {}

  subscribe(l: PlayListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get playing(): boolean {
    return this.runtime !== null;
  }

  play(): boolean {
    if (this.runtime) return false;
    const ed = this.editor;
    try {
      this.viewport.storeCameraState();
      const project = clone(ed.project);
      const cam = this.viewport.camera.camera;
      cam.updateMatrixWorld();
      const fallbackView = { position: cam.position.clone(), quaternion: cam.quaternion.clone() as Quaternion };
      // プレイヤー未設定なら、選択中のメッシュを三人称の対象にする
      const selected = ed.activeEntity;
      const playerId = ed.sceneData.playerId ?? (selected?.kind === 'mesh' ? selected.id : null);

      this.startTransforms.clear();
      for (const e of Object.values(ed.sceneData.entities)) this.startTransforms.set(e.id, clone(e.transform));

      this.viewport.suspend();
      ed.setMode('play');
      this.overlay.hidden = false;
      const runtime = new GameRuntime({
        engine: this.viewport.engine,
        project,
        sceneId: ed.sceneData.id,
        overlay: this.overlay,
        cameraMode: ed.settings.playCamera,
        fallbackView: { position: fallbackView.position as Vector3, quaternion: fallbackView.quaternion },
        playerId,
        onStats: (s) => this.listeners.forEach((l) => l.onStats?.(s)),
        onMessage: (m, level) => this.listeners.forEach((l) => l.onMessage?.(m, level)),
      });
      this.runtime = runtime;
      runtime.start();
      this.listeners.forEach((l) => l.onStart?.(runtime));
      this.listeners.forEach((l) => l.onCameraMode?.(runtime.cameraMode));
      return true;
    } catch (err) {
      logger.error('Play を開始できませんでした', 'Play', err);
      this.stop();
      return false;
    }
  }

  stop(): void {
    const runtime = this.runtime;
    this.runtime = null;
    let changes: Map<string, TransformData> | null = null;
    if (runtime) {
      try {
        if (this.editor.settings.playKeepChanges) changes = runtime.exportTransforms();
        runtime.dispose();
      } catch (err) {
        logger.error('Play の終了処理でエラーが発生しました', 'Play', err);
      }
    }
    this.overlay.hidden = true;
    this.editor.setMode('edit');
    this.viewport.resume();
    if (changes) this.applyChanges(changes);
    this.listeners.forEach((l) => l.onStop?.());
  }

  private applyChanges(changes: Map<string, TransformData>): void {
    const model = this.editor.scene;
    const before = new Map<string, TransformData>();
    for (const [id, t] of changes) {
      const start = this.startTransforms.get(id);
      if (!start || !model.has(id) || deepEqual(start, t)) continue;
      before.set(id, clone(model.require(id).transform));
      model.setTransform(id, t);
    }
    if (before.size > 0) commitTransforms(this.editor, before, 'Play 中の変更を反映');
  }

  togglePause(): boolean {
    if (!this.runtime) return false;
    this.runtime.setPaused(!this.runtime.paused);
    return this.runtime.paused;
  }

  setCameraMode(mode: PlayCameraMode): void {
    if (!this.runtime) return;
    const actual = this.runtime.setCameraMode(mode);
    this.editor.updateSettings({ playCamera: mode });
    this.listeners.forEach((l) => l.onCameraMode?.(actual));
  }
}
