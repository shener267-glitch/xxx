import { Quaternion, Vector3 } from 'three';
import { commitTransforms } from '../core/actions';
import type { Editor } from '../core/Editor';
import { logger } from '../core/logger';
import type { PlayCameraMode } from '../core/settings';
import type { ProjectData, TransformData } from '../core/types';
import { clone, deepEqual } from '../core/util';
import type { EditorViewport } from '../engine/EditorViewport';
import type { RuntimeRequest, RuntimeStats } from '../runtime/GameRuntime';
import type { SaveData } from '../runtime/GameState';
import { GameRuntime } from '../runtime/GameRuntime';

export interface PlayListener {
  onStart?(runtime: GameRuntime): void;
  onStop?(): void;
  onStats?(stats: RuntimeStats): void;
  onMessage?(message: string, level: 'info' | 'warn' | 'error'): void;
  onCameraMode?(mode: PlayCameraMode): void;
  onPause?(paused: boolean): void;
}

/** エディタの Play で上部に表示するボタン列の高さ (ゲーム画面の UI をその下に置く) */
const HUD_TOP_INSET = 58;

interface Session {
  sceneId: string;
  fallbackView: { position: Vector3; quaternion: Quaternion };
  playerId: string | null;
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
  private session: Session | null = null;

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

  play(opts: { showTitle?: boolean } = {}): boolean {
    if (this.runtime) return false;
    const ed = this.editor;
    try {
      this.viewport.storeCameraState();
      const cam = this.viewport.camera.camera;
      cam.updateMatrixWorld();
      // プレイヤー未設定なら、選択中のメッシュを三人称の対象にする
      const selected = ed.activeEntity;
      this.session = {
        sceneId: ed.sceneData.id,
        fallbackView: { position: cam.position.clone(), quaternion: cam.quaternion.clone() as Quaternion },
        playerId: ed.sceneData.playerId ?? (selected?.kind === 'mesh' ? selected.id : null),
      };

      this.startTransforms.clear();
      for (const e of Object.values(ed.sceneData.entities)) this.startTransforms.set(e.id, clone(e.transform));

      this.viewport.suspend();
      ed.setMode('play');
      this.overlay.hidden = false;
      this.launch(clone(ed.project), opts.showTitle ?? ed.settings.playFromTitle, false);
      return true;
    } catch (err) {
      logger.error('Play を開始できませんでした', 'Play', err);
      this.stop();
      return false;
    }
  }

  /** ランタイムを作って開始する (Play・やり直し・タイトルへ で共通) */
  private launch(project: ProjectData, showTitle: boolean, continueFromSave: boolean, scene?: { id: string; carry: SaveData }): GameRuntime {
    const ed = this.editor;
    const session = this.session!;
    const runtime = new GameRuntime({
      engine: this.viewport.engine,
      project,
      sceneId: scene?.id ?? session.sceneId,
      carryState: scene?.carry ?? null,
      overlay: this.overlay,
      cameraMode: ed.settings.playCamera,
      quality: ed.settings.quality,
      fallbackView: session.fallbackView,
      playerId: session.playerId,
      showTitle,
      continueFromSave,
      topInset: HUD_TOP_INSET,
      saveKey: `pocket-engine:save:${project.id}`,
      onStats: (s) => this.listeners.forEach((l) => l.onStats?.(s)),
      onMessage: (m, level) => this.listeners.forEach((l) => l.onMessage?.(m, level)),
      onRequest: (kind, sceneId) => this.handleRequest(kind, sceneId),
      onPauseChange: (p) => this.listeners.forEach((l) => l.onPause?.(p)),
    });
    this.runtime = runtime;
    runtime.start().catch((err) => logger.error('Play の開始中にエラーが発生しました', 'Play', err));
    this.listeners.forEach((l) => l.onStart?.(runtime));
    this.listeners.forEach((l) => l.onCameraMode?.(runtime.cameraMode));
    return runtime;
  }

  private handleRequest(kind: RuntimeRequest, sceneId?: string): void {
    // ボタンのクリック処理やイベントの実行の途中でランタイムを破棄しないよう、次のタスクで行う
    setTimeout(() => {
      if (!this.runtime) return;
      if (kind === 'exit') this.stop();
      else if (kind === 'scene' && sceneId) this.changeScene(sceneId);
      else this.restart(kind === 'title');
    }, 0);
  }

  /** Play 中のシーン切り替え (スコア・持ち物・変数などは引き継ぐ) */
  private changeScene(sceneId: string): void {
    const old = this.runtime;
    if (!old || !this.session) return;
    const carry = old.carryOverState();
    try {
      old.dispose();
    } catch (err) {
      logger.warn('シーン切り替え時の終了処理でエラーが発生しました', 'Play', err);
    }
    this.runtime = null;
    try {
      this.launch(clone(this.editor.project), false, false, { id: sceneId, carry });
    } catch (err) {
      logger.error('シーンを切り替えられませんでした', 'Play', err);
      this.stop();
    }
  }

  /** 最初からやり直す (エディタの状態はそのまま) */
  restart(showTitle = false): void {
    if (!this.runtime || !this.session) return;
    try {
      this.runtime.dispose();
    } catch (err) {
      logger.warn('Play の終了処理でエラーが発生しました', 'Play', err);
    }
    this.runtime = null;
    try {
      this.launch(clone(this.editor.project), showTitle, false);
    } catch (err) {
      logger.error('やり直しに失敗しました', 'Play', err);
      this.stop();
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
