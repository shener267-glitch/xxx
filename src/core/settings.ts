/**
 * エディタ設定 (プロジェクトとは別に端末ごとに保存する)。
 */
export type PlayCameraMode = 'game' | 'firstPerson' | 'thirdPerson';
export type QualityLevel = 'low' | 'medium' | 'high';

export interface EditorSettings {
  showGrid: boolean;
  snapEnabled: boolean;
  snapMove: number;
  snapRotate: number;
  snapScale: number;
  gizmoSize: number;
  /** 1本指ドラッグ (何もない所) でカメラを回転する */
  oneFingerOrbit: boolean;
  quality: QualityLevel;
  shadows: boolean;
  showFps: boolean;
  autosave: boolean;
  playCamera: PlayCameraMode;
  /** Play 終了時に Play 中の変更 (位置など) をシーンに残す */
  playKeepChanges: boolean;
  showHints: boolean;
}

export const DEFAULT_SETTINGS: EditorSettings = {
  showGrid: true,
  snapEnabled: false,
  snapMove: 0.5,
  snapRotate: 15,
  snapScale: 0.1,
  gizmoSize: 1.25,
  oneFingerOrbit: true,
  quality: 'medium',
  shadows: true,
  showFps: false,
  autosave: true,
  playCamera: 'game',
  playKeepChanges: false,
  showHints: true,
};

const KEY = 'pocket-engine:settings';

export function loadSettings(): EditorSettings {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS };
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<EditorSettings>;
    const out = { ...DEFAULT_SETTINGS };
    // 型が一致する項目だけを採用する (古い/壊れた設定への耐性)
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof EditorSettings)[]) {
      if (typeof parsed[key] === typeof DEFAULT_SETTINGS[key]) {
        (out as Record<string, unknown>)[key] = parsed[key];
      }
    }
    return out;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: EditorSettings): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 容量不足やプライベートモードでは保存できないことがある (致命的ではない)
  }
}
