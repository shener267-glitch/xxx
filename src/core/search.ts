import { getComponentDef } from '../components/registry';
import { entityTypeLabel, KIND_LABELS } from './catalog';
import type { EntityData } from './types';

/**
 * オブジェクトの検索。名前だけでなく、種類 (「カメラ」「ライト」など)・動作 (コンポーネント)・タグでも探せる。
 * 空白で区切ると「すべてを含むもの」(例: 「敵 動く」)。
 */

/** 検索に使う文字 (小文字) */
export function searchText(e: EntityData): string {
  const parts = [e.name, entityTypeLabel(e), KIND_LABELS[e.kind], ...e.tags];
  for (const c of e.components) {
    parts.push(c.type);
    const def = getComponentDef(c.type);
    if (def) parts.push(def.label);
  }
  if (e.kind === 'camera' && e.camera?.main) parts.push('メインカメラ');
  if (e.kind === 'model') parts.push('モデル');
  if (e.prefab) parts.push('部品', 'prefab');
  return parts.join(' ').toLowerCase();
}

export function matchesQuery(e: EntityData, query: string): boolean {
  const tokens = query.toLowerCase().split(/[\s　]+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const text = searchText(e);
  return tokens.every((t) => text.includes(t));
}

/** 名前が一致するものを先に並べる */
export function searchEntities(list: EntityData[], query: string): EntityData[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  const hits = list.filter((e) => matchesQuery(e, q));
  const byName = (e: EntityData) => (e.name.toLowerCase().includes(q) ? 0 : 1);
  return hits.map((e, i) => ({ e, i })).sort((a, b) => byName(a.e) - byName(b.e) || a.i - b.i).map((x) => x.e);
}
