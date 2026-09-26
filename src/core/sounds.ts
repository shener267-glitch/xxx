/**
 * 組み込みの効果音・音楽 (ファイル不要。Web Audio で合成する)。
 * 音の指定は「builtin:名前」または音声アセットの ID。
 */

export interface SoundInfo {
  id: string;
  label: string;
}

export const BUILTIN_SFX: SoundInfo[] = [
  { id: 'coin', label: 'コイン' },
  { id: 'item', label: 'アイテム' },
  { id: 'jump', label: 'ジャンプ' },
  { id: 'hit', label: '攻撃' },
  { id: 'damage', label: 'ダメージ' },
  { id: 'explosion', label: '爆発' },
  { id: 'powerup', label: 'パワーアップ' },
  { id: 'heal', label: '回復' },
  { id: 'save', label: 'セーブ' },
  { id: 'click', label: 'クリック' },
  { id: 'talk', label: '会話' },
  { id: 'win', label: 'クリア' },
  { id: 'lose', label: 'ゲームオーバー' },
];

export const BUILTIN_MUSIC: SoundInfo[] = [
  { id: 'happy', label: 'たのしい' },
  { id: 'adventure', label: 'ぼうけん' },
  { id: 'calm', label: 'おだやか' },
  { id: 'tension', label: 'きんちょう' },
];

export const BUILTIN_PREFIX = 'builtin:';

export function isBuiltinSound(source: string | null | undefined): boolean {
  return typeof source === 'string' && source.startsWith(BUILTIN_PREFIX);
}

export function builtinSoundId(source: string): string {
  return source.slice(BUILTIN_PREFIX.length);
}

/** 表示用の名前 (アセット名は呼び出し側で解決する) */
export function builtinSoundLabel(source: string | null | undefined): string | null {
  if (!source || !isBuiltinSound(source)) return null;
  const id = builtinSoundId(source);
  return (BUILTIN_SFX.find((s) => s.id === id) ?? BUILTIN_MUSIC.find((s) => s.id === id))?.label ?? id;
}
