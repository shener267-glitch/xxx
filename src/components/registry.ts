import type { Object3D } from 'three';
import type { EntityData } from '../core/types';

/**
 * ゲームロジック用コンポーネントのレジストリ。
 *
 * 新しい動作 (Rigidbody / Trigger / プレイヤー操作 / スクリプトなど) は
 * ComponentDef を registerComponent() で登録するだけで、
 * Inspector の UI と Play Mode の実行の両方に自動的に反映される。
 */

export type PropType = 'number' | 'vec3' | 'boolean' | 'select' | 'color' | 'string';

export interface PropSchema {
  key: string;
  label: string;
  type: PropType;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; label: string }[];
}

/** Play 中にコンポーネントから使えるランタイム機能 */
export interface RuntimeAPI {
  /** 経過時間 (秒) */
  readonly time: number;
  findObjectByName(name: string): Object3D | null;
  log(message: string): void;
}

export interface ComponentContext {
  entity: EntityData;
  object: Object3D;
  runtime: RuntimeAPI;
}

export interface ComponentInstance {
  start?(): void;
  update?(dt: number, time: number): void;
  destroy?(): void;
}

export interface ComponentDef {
  type: string;
  label: string;
  icon: string;
  description: string;
  category: 'motion' | 'physics' | 'gameplay' | 'script';
  defaults(): Record<string, unknown>;
  schema: PropSchema[];
  /** 同じエンティティに複数付けられるか */
  allowMultiple?: boolean;
  create?(ctx: ComponentContext, props: Record<string, unknown>): ComponentInstance;
}

const registry = new Map<string, ComponentDef>();

export function registerComponent(def: ComponentDef): void {
  registry.set(def.type, def);
}

export function getComponentDef(type: string): ComponentDef | undefined {
  return registry.get(type);
}

export function listComponentDefs(): ComponentDef[] {
  return [...registry.values()];
}
