import { Matrix4 } from 'three';
import type { PropSchema } from '../../components/registry';
import { getComponentDef, listComponentDefs } from '../../components/registry';
import * as A from '../../core/actions';
import { entityIcon, entityTypeLabel, LIGHT_LABELS, SHAPE_LABELS } from '../../core/catalog';
import type { EntityData, PrimitiveShape, Vec3 } from '../../core/types';
import { deepEqual, getPath } from '../../core/util';
import type { AppContext } from '../context';
import { button, clear, h, rafThrottle } from '../dom';
import { icon } from '../icons';
import { openParentPicker } from '../menus';
import { actionSheet, toast } from '../overlays';
import { ColorField, fieldRow, NumberField, section, Select, Slider, TextField, Toggle, Vec3Field } from '../widgets';

type Refresher = () => void;

/**
 * Inspector タブ: 選択中オブジェクトの詳細を表示・編集する。
 * 何も選択していないときはシーンの設定を表示する。
 * 複数選択時は共通の項目だけを表示し、変更は全員に適用する (値が異なる欄は「—」表示)。
 */
export class InspectorPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private refreshers: Refresher[] = [];
  private structureKey = '';
  private uniformScale = true;
  private scheduleUpdate = rafThrottle(() => this.update());

  constructor(private ctx: AppContext) {
    this.body = h('div', { class: 'inspector-body' });
    this.el = h('div', { class: 'panel inspector-panel', attrs: { 'data-testid': 'inspector' } }, this.body);
    const ev = ctx.editor.events;
    for (const type of ['selection-changed', 'entity-changed', 'scene-loaded', 'environment-changed', 'hierarchy-changed', 'project-changed', 'entity-removed'] as const) {
      ev.on(type, this.scheduleUpdate);
    }
    this.update();
  }

  // ------------------------------------------------------------------
  // 選択の取得と共通値
  // ------------------------------------------------------------------

  private get ids(): string[] {
    const model = this.ctx.editor.scene;
    return this.ctx.editor.selection.ids.filter((id) => model.has(id));
  }

  private get entities(): EntityData[] {
    return this.ctx.editor.selectedEntities();
  }

  /** 全員で同じ値ならその値、違えば null */
  private common<T>(get: (e: EntityData) => T): T | null {
    const list = this.entities;
    if (list.length === 0) return null;
    const first = get(list[0]);
    for (let i = 1; i < list.length; i++) if (!deepEqual(get(list[i]), first)) return null;
    return first;
  }

  private commonPath<T>(path: string): T | null {
    return this.common((e) => getPath(e, path) as T);
  }

  private set(path: string, value: unknown, label: string, merge = true): void {
    A.setEntityValue(this.ctx.editor, this.ids, path, value, { label, mergeKey: merge ? path : undefined });
  }

  private bind(fn: Refresher): void {
    this.refreshers.push(fn);
    fn();
  }

  private computeKey(): string {
    const list = this.entities;
    if (list.length === 0) return `scene:${this.ctx.editor.sceneData.id}`;
    return list
      .map((e) =>
        [e.id, e.kind, e.mesh?.shape, e.mesh?.material.preset, e.light?.type, e.components.map((c) => `${c.id}:${c.type}`).join(',')].join('|'),
      )
      .join('/');
  }

  update(): void {
    const key = this.computeKey();
    if (key !== this.structureKey) {
      this.structureKey = key;
      this.build();
    } else {
      for (const r of this.refreshers) r();
    }
  }

  private build(): void {
    const scroll = this.el.scrollTop;
    clear(this.body);
    this.refreshers = [];
    const list = this.entities;
    if (list.length === 0) this.buildScene();
    else this.buildEntities(list);
    // 同じオブジェクトの再構築ではスクロール位置を保つ
    this.el.scrollTop = scroll;
  }

  // ------------------------------------------------------------------
  // シーン設定 (未選択時)
  // ------------------------------------------------------------------

  private buildScene(): void {
    const ed = this.ctx.editor;
    const hint = h(
      'div',
      { class: 'hint-card' },
      h('span', { html: icon('hand', 22) }),
      h('p', { text: '3D ビューやシーン一覧でオブジェクトをタップすると、ここで位置・回転・サイズ・色などを編集できます。' }),
    );

    const nameField = new TextField({ title: 'シーン名', testId: 'scene-name', onChange: (v) => A.renameScene(ed, ed.sceneData.id, v) });
    this.bind(() => nameField.set(ed.sceneData.name));

    const bg = new ColorField({ title: '背景色', testId: 'scene-bg', onChange: (hex) => A.setEnvironment(ed, { background: hex }) });
    this.bind(() => bg.set(ed.sceneData.environment.background));

    const playerSelect = h('select', {
      class: 'select',
      attrs: { 'aria-label': 'プレイヤー', 'data-testid': 'scene-player' },
      on: { change: () => A.setPlayer(ed, playerSelect.value || null) },
    });
    this.bind(() => {
      clear(playerSelect);
      playerSelect.appendChild(h('option', { text: '(なし)', props: { value: '' } }));
      for (const e of ed.scene.ordered()) {
        if (e.kind !== 'mesh') continue;
        playerSelect.appendChild(h('option', { text: e.name, props: { value: e.id } }));
      }
      playerSelect.value = ed.sceneData.playerId ?? '';
    });

    const stats = h('div', { class: 'stats-grid' });
    this.bind(() => {
      const all = Object.values(ed.sceneData.entities);
      const count = (k: EntityData['kind']) => all.filter((e) => e.kind === k).length;
      clear(stats);
      for (const [label, n] of [
        ['オブジェクト', all.length],
        ['メッシュ', count('mesh')],
        ['ライト', count('light')],
        ['カメラ', count('camera')],
      ] as const) {
        stats.appendChild(h('div', { class: 'stat' }, h('b', { text: String(n) }), h('span', { text: label })));
      }
    });

    this.body.append(
      hint,
      section('シーン設定', 'layers', [
        fieldRow('シーン名', nameField.el),
        fieldRow('背景色', bg.el),
        fieldRow('プレイヤー', playerSelect, { hint: '三人称カメラで操作する対象' }),
      ]),
      section('統計', 'info', [stats]),
    );
  }

  // ------------------------------------------------------------------
  // オブジェクト
  // ------------------------------------------------------------------

  private buildEntities(list: EntityData[]): void {
    const ed = this.ctx.editor;
    const single = list.length === 1 ? list[0] : null;
    this.body.appendChild(this.header(list));
    this.body.appendChild(this.transformSection());

    const kinds = new Set(list.map((e) => e.kind));
    const kind = kinds.size === 1 ? list[0].kind : null;
    if (kind === 'mesh') {
      this.body.appendChild(this.meshSection());
      this.body.appendChild(this.materialSection(list));
    } else if (kind === 'light') {
      this.body.appendChild(this.lightSection(list));
    } else if (kind === 'camera') {
      this.body.appendChild(this.cameraSection(single));
    }
    if (single) {
      this.body.appendChild(this.componentsSection(single));
      this.body.appendChild(this.hierarchySection(single));
    }

    this.body.appendChild(
      h(
        'div',
        { class: 'inspector-actions' },
        button({ icon: 'duplicate', label: '複製', class: 'secondary', onClick: () => A.duplicateEntities(ed, this.ids), testId: 'insp-duplicate' }),
        button({ icon: 'trash', label: '削除', class: 'danger-outline', onClick: () => A.deleteEntities(ed, this.ids), testId: 'insp-delete' }),
      ),
    );
  }

  private header(list: EntityData[]): HTMLElement {
    const ed = this.ctx.editor;
    const single = list.length === 1 ? list[0] : null;
    const iconEl = h('span', { class: 'insp-icon' });
    const typeEl = h('div', { class: 'insp-type' });
    let title: HTMLElement;
    if (single) {
      const name = new TextField({ title: '名前', testId: 'insp-name', onChange: (v) => A.renameEntity(ed, single.id, v) });
      title = name.el;
      this.bind(() => {
        const e = ed.scene.get(single.id);
        if (e) name.set(e.name);
      });
    } else {
      title = h('div', { class: 'insp-multi-title', text: `${list.length}個を選択中` });
    }
    const vis = h('button', {
      class: 'btn icon-btn',
      attrs: { type: 'button', 'data-testid': 'insp-visible' },
      on: {
        click: () => {
          const v = this.common((e) => e.visible);
          A.setVisible(ed, this.ids, v === null ? true : !v);
        },
      },
    });
    const lock = h('button', {
      class: 'btn icon-btn',
      attrs: { type: 'button', 'data-testid': 'insp-lock' },
      on: {
        click: () => {
          const v = this.common((e) => e.locked);
          A.setLocked(ed, this.ids, v === null ? true : !v);
        },
      },
    });
    this.bind(() => {
      const entities = this.entities;
      if (entities.length === 0) return;
      iconEl.innerHTML = icon(entityIcon(entities[0]), 24);
      typeEl.textContent = single ? entityTypeLabel(entities[0]) : entities.map((e) => e.name).join('、');
      const visible = this.common((e) => e.visible);
      vis.innerHTML = icon(visible === false ? 'eyeOff' : 'eye', 20);
      vis.classList.toggle('off', visible === false);
      vis.title = visible === false ? '表示する' : '非表示にする';
      const locked = this.common((e) => e.locked);
      lock.innerHTML = icon(locked ? 'lock' : 'unlock', 20);
      lock.classList.toggle('on', !!locked);
      lock.title = locked ? 'ロック解除' : 'ロック';
    });
    return h('div', { class: 'insp-header' }, iconEl, h('div', { class: 'insp-title' }, title, typeEl), vis, lock);
  }

  private transformSection(): HTMLElement {
    const ed = this.ctx.editor;
    const vecRow = (label: string, part: 'position' | 'rotation' | 'scale', step: number, extra?: HTMLElement) => {
      const field = new Vec3Field({
        title: label,
        step,
        precision: part === 'rotation' ? 2 : 3,
        testId: `insp-${part}`,
        onChange: (axis, v) => {
          if (part === 'scale' && this.uniformScale) {
            this.setUniformScale(axis, v);
            return;
          }
          this.set(`transform.${part}.${axis}`, v, `${label}を変更`);
        },
      });
      this.bind(() => field.set([0, 1, 2].map((i) => this.commonPath<number>(`transform.${part}.${i}`))));
      const reset = button({
        icon: 'reset',
        title: `${label}をリセット`,
        class: 'icon-btn small ghost',
        onClick: () => A.resetTransform(ed, this.ids, part),
      });
      return h(
        'div',
        { class: 'transform-row' },
        h('div', { class: 'transform-label' }, h('span', { text: label }), h('div', { class: 'transform-tools' }, extra ?? null, reset)),
        field.el,
      );
    };
    const link = button({
      icon: this.uniformScale ? 'link' : 'unlink',
      title: '縦横比を固定',
      class: `icon-btn small ghost ${this.uniformScale ? 'active' : ''}`,
      testId: 'insp-uniform',
      onClick: () => {
        this.uniformScale = !this.uniformScale;
        link.classList.toggle('active', this.uniformScale);
        link.innerHTML = icon(this.uniformScale ? 'link' : 'unlink', 22);
        toast(this.uniformScale ? '縦横比を固定して拡大縮小します' : '各軸を個別に変更します', 'info', 1400);
      },
    });
    return section('トランスフォーム', 'move', [vecRow('位置', 'position', 0.1), vecRow('回転', 'rotation', 5), vecRow('サイズ', 'scale', 0.1, link)], {
      testId: 'sec-transform',
    });
  }

  /** 縦横比を保って拡大縮小 (変更した軸の倍率を全軸に掛ける) */
  private setUniformScale(axis: 0 | 1 | 2, v: number): void {
    A.updateEntities(
      this.ctx.editor,
      this.ids,
      (e) => {
        const old = e.transform.scale;
        const base = old[axis];
        if (Math.abs(base) < 1e-6) {
          e.transform.scale = [v, v, v];
          return;
        }
        const k = v / base;
        e.transform.scale = old.map((s) => Math.round(s * k * 1e4) / 1e4) as Vec3;
      },
      'サイズを変更',
      'transform.scale',
    );
  }

  private meshSection(): HTMLElement {
    const shapeOptions = (Object.keys(SHAPE_LABELS) as PrimitiveShape[]).map((s) => ({ value: s, label: SHAPE_LABELS[s] }));
    const shape = new Select<PrimitiveShape>({
      options: shapeOptions,
      title: '形状',
      testId: 'insp-shape',
      onChange: (v) => this.set('mesh.shape', v, '形状を変更', false),
    });
    this.bind(() => shape.set(this.commonPath<PrimitiveShape>('mesh.shape')));
    const cast = new Toggle({ title: '影を落とす', onChange: (v) => this.set('mesh.castShadow', v, '影の設定を変更', false) });
    this.bind(() => cast.set(this.commonPath<boolean>('mesh.castShadow')));
    const receive = new Toggle({ title: '影を受ける', onChange: (v) => this.set('mesh.receiveShadow', v, '影の設定を変更', false) });
    this.bind(() => receive.set(this.commonPath<boolean>('mesh.receiveShadow')));
    return section('メッシュ', 'cube', [fieldRow('形状', shape.el), fieldRow('影を落とす', cast.el), fieldRow('影を受ける', receive.el)]);
  }

  private materialSection(list: EntityData[]): HTMLElement {
    const preset = new Select<'standard' | 'unlit'>({
      options: [
        { value: 'standard', label: '標準 (光の影響を受ける)' },
        { value: 'unlit', label: 'アンリット (光の影響なし)' },
      ],
      title: 'マテリアルの種類',
      testId: 'insp-preset',
      onChange: (v) => this.set('mesh.material.preset', v, 'マテリアルを変更', false),
    });
    this.bind(() => preset.set(this.commonPath<'standard' | 'unlit'>('mesh.material.preset')));

    const color = new ColorField({ title: '色', testId: 'insp-color', onChange: (hex) => this.set('mesh.material.color', hex, '色を変更') });
    this.bind(() => color.set(this.commonPath<string>('mesh.material.color')));

    const slider = (path: string, label: string, min: number, max: number, step: number, testId?: string) => {
      const s = new Slider({ min, max, step, title: label, testId, onChange: (v) => this.set(path, v, `${label}を変更`) });
      this.bind(() => s.set(this.commonPath<number>(path)));
      return s.el;
    };
    const wire = new Toggle({ title: 'ワイヤーフレーム', onChange: (v) => this.set('mesh.material.wireframe', v, '表示方法を変更', false) });
    this.bind(() => wire.set(this.commonPath<boolean>('mesh.material.wireframe')));

    const standard = list.every((e) => e.mesh?.material.preset !== 'unlit');
    const rows: HTMLElement[] = [fieldRow('種類', preset.el), fieldRow('色', color.el)];
    if (standard) {
      const emissive = new ColorField({ title: '発光色', onChange: (hex) => this.set('mesh.material.emissive', hex, '発光色を変更') });
      this.bind(() => emissive.set(this.commonPath<string>('mesh.material.emissive')));
      rows.push(
        fieldRow('粗さ', slider('mesh.material.roughness', '粗さ', 0, 1, 0.01, 'insp-roughness'), { hint: '0 でツルツル' }),
        fieldRow('金属感', slider('mesh.material.metalness', '金属感', 0, 1, 0.01, 'insp-metalness')),
        fieldRow('発光色', emissive.el),
        fieldRow('発光の強さ', slider('mesh.material.emissiveIntensity', '発光の強さ', 0, 10, 0.1)),
      );
    }
    rows.push(fieldRow('不透明度', slider('mesh.material.opacity', '不透明度', 0, 1, 0.01, 'insp-opacity')), fieldRow('ワイヤーフレーム', wire.el));
    return section('マテリアル', 'palette', rows, { testId: 'sec-material' });
  }

  private lightSection(list: EntityData[]): HTMLElement {
    const types = new Set(list.map((e) => e.light!.type));
    const type = types.size === 1 ? list[0].light!.type : null;
    const rows: HTMLElement[] = [];
    rows.push(fieldRow('種類', h('div', { class: 'readonly-value', text: type ? LIGHT_LABELS[type] : '複数の種類' })));
    const color = new ColorField({ title: 'ライトの色', testId: 'insp-light-color', onChange: (hex) => this.set('light.color', hex, 'ライトの色を変更') });
    this.bind(() => color.set(this.commonPath<string>('light.color')));
    rows.push(fieldRow(type === 'hemisphere' ? '空の色' : '色', color.el));
    if (type === 'hemisphere') {
      const ground = new ColorField({ title: '地面の色', onChange: (hex) => this.set('light.groundColor', hex, '地面の色を変更') });
      this.bind(() => ground.set(this.commonPath<string>('light.groundColor')));
      rows.push(fieldRow('地面の色', ground.el));
    }
    const maxIntensity = type === 'point' ? 100 : type === 'spot' ? 300 : 10;
    const intensity = new Slider({
      min: 0,
      max: maxIntensity,
      step: maxIntensity / 200,
      title: '明るさ',
      testId: 'insp-intensity',
      onChange: (v) => this.set('light.intensity', v, '明るさを変更'),
    });
    this.bind(() => intensity.set(this.commonPath<number>('light.intensity')));
    rows.push(fieldRow('明るさ', intensity.el));
    if (type === 'point' || type === 'spot') {
      const dist = new NumberField({ step: 0.5, min: 0, title: '届く距離', onChange: (v) => this.set('light.distance', v, '届く距離を変更') });
      this.bind(() => dist.set(this.commonPath<number>('light.distance')));
      rows.push(fieldRow('届く距離', dist.el, { hint: '0 で無限' }));
    }
    if (type === 'spot') {
      const angle = new Slider({ min: 1, max: 89, step: 1, title: '照射角', onChange: (v) => this.set('light.angle', v, '照射角を変更') });
      this.bind(() => angle.set(this.commonPath<number>('light.angle')));
      const pen = new Slider({ min: 0, max: 1, step: 0.01, title: '縁のぼかし', onChange: (v) => this.set('light.penumbra', v, 'ぼかしを変更') });
      this.bind(() => pen.set(this.commonPath<number>('light.penumbra')));
      rows.push(fieldRow('照射角', angle.el), fieldRow('縁のぼかし', pen.el));
    }
    if (type === 'directional' || type === 'point' || type === 'spot') {
      const shadow = new Toggle({ title: '影を作る', testId: 'insp-light-shadow', onChange: (v) => this.set('light.castShadow', v, '影の設定を変更', false) });
      this.bind(() => shadow.set(this.commonPath<boolean>('light.castShadow')));
      rows.push(fieldRow('影を作る', shadow.el, { hint: type === 'point' ? '負荷が高め' : undefined }));
    }
    if (type === 'directional') {
      rows.push(h('p', { class: 'field-note', text: '太陽光は「回転」で光の向きが変わります。' }));
    }
    return section('ライト', 'sun', rows);
  }

  private cameraSection(single: EntityData | null): HTMLElement {
    const ed = this.ctx.editor;
    const fov = new Slider({ min: 10, max: 120, step: 1, title: '画角', testId: 'insp-fov', onChange: (v) => this.set('camera.fov', v, '画角を変更') });
    this.bind(() => fov.set(this.commonPath<number>('camera.fov')));
    const near = new NumberField({ step: 0.05, min: 0.01, title: '近クリップ', onChange: (v) => this.set('camera.near', v, '描画範囲を変更') });
    this.bind(() => near.set(this.commonPath<number>('camera.near')));
    const far = new NumberField({ step: 10, min: 1, title: '遠クリップ', onChange: (v) => this.set('camera.far', v, '描画範囲を変更') });
    this.bind(() => far.set(this.commonPath<number>('camera.far')));
    const rows = [fieldRow('画角 (度)', fov.el), fieldRow('描画開始距離', near.el), fieldRow('描画終了距離', far.el)];
    if (single) {
      const main = new Toggle({
        title: 'メインカメラ',
        testId: 'insp-main-camera',
        onChange: (v) => {
          if (v) A.setMainCamera(ed, single.id);
          else A.setEntityValue(ed, [single.id], 'camera.main', false, { label: 'メインカメラを解除' });
        },
      });
      this.bind(() => main.set(!!ed.scene.get(single.id)?.camera?.main));
      rows.push(
        fieldRow('メインカメラ', main.el, { hint: 'Play 時にこのカメラで表示' }),
        h(
          'div',
          { class: 'button-row' },
          button({
            icon: 'target',
            label: '今の視点に合わせる',
            class: 'secondary',
            testId: 'insp-align-camera',
            onClick: () => {
              A.alignEntityToWorld(ed, single.id, new Matrix4().copy(this.ctx.viewport.camera.camera.matrixWorld));
              toast('カメラを現在の視点に合わせました', 'success', 1400);
            },
          }),
        ),
      );
    }
    return section('カメラ', 'camera', rows);
  }

  private componentsSection(e: EntityData): HTMLElement {
    const ed = this.ctx.editor;
    const cards: HTMLElement[] = [];
    for (const comp of e.components) {
      const def = getComponentDef(comp.type);
      const enabled = new Toggle({ title: '有効', onChange: (v) => A.setComponentEnabled(ed, e.id, comp.id, v) });
      this.bind(() => enabled.set(ed.scene.get(e.id)?.components.find((c) => c.id === comp.id)?.enabled ?? false));
      const remove = button({ icon: 'trash', title: '削除', class: 'icon-btn small ghost', onClick: () => A.removeComponent(ed, e.id, comp.id) });
      const props: HTMLElement[] = [];
      if (def) {
        for (const schema of def.schema) props.push(this.componentProp(e.id, comp.id, schema));
      } else {
        props.push(h('p', { class: 'field-note warn', text: `不明なコンポーネント「${comp.type}」です (新しいバージョンで作られた可能性があります)` }));
      }
      cards.push(
        h(
          'div',
          { class: 'component-card', attrs: { 'data-testid': `comp-${comp.type}` } },
          h(
            'div',
            { class: 'component-header' },
            h('span', { html: icon(def?.icon ?? 'box', 18) }),
            h('span', { class: 'component-title', text: def?.label ?? comp.type }),
            enabled.el,
            remove,
          ),
          def ? h('p', { class: 'component-desc', text: def.description }) : null,
          props,
        ),
      );
    }
    const add = button({
      icon: 'plus',
      label: '動作を追加',
      class: 'secondary wide',
      testId: 'insp-add-component',
      onClick: () => {
        const defs = listComponentDefs();
        actionSheet(
          '動作を追加',
          defs.map((d) => ({
            label: d.label,
            icon: d.icon,
            hint: d.description,
            disabled: !d.allowMultiple && e.components.some((c) => c.type === d.type),
            testId: `add-comp-${d.type}`,
            onSelect: () => A.addComponent(ed, e.id, d.type),
          })),
        );
      },
    });
    const note = h('p', { class: 'field-note', text: '動作は Play 中に実行されます。物理・イベント・プレイヤー操作などは今後のアップデートで追加されます。' });
    return section('動作 (コンポーネント)', 'sparkles', [...cards, add, note], { testId: 'sec-components' });
  }

  private componentProp(entityId: string, compId: string, schema: PropSchema): HTMLElement {
    const ed = this.ctx.editor;
    const get = () => ed.scene.get(entityId)?.components.find((c) => c.id === compId)?.props[schema.key];
    const setVal = (v: unknown) => A.setComponentProp(ed, entityId, compId, schema.key, v);
    const label = schema.unit ? `${schema.label} (${schema.unit})` : schema.label;
    switch (schema.type) {
      case 'vec3': {
        const f = new Vec3Field({
          title: schema.label,
          step: schema.step ?? 0.1,
          onChange: (axis, v) => {
            const cur = get();
            const arr: Vec3 = Array.isArray(cur) && cur.length === 3 ? ([...cur] as Vec3) : [0, 0, 0];
            arr[axis] = v;
            setVal(arr);
          },
        });
        this.bind(() => {
          const v = get();
          f.set(Array.isArray(v) ? (v as Vec3) : [0, 0, 0]);
        });
        return fieldRow(label, f.el, { stacked: true });
      }
      case 'number': {
        const f = new NumberField({ step: schema.step ?? 0.1, min: schema.min, max: schema.max, title: schema.label, onChange: setVal });
        this.bind(() => f.set(Number(get()) || 0));
        return fieldRow(label, f.el);
      }
      case 'boolean': {
        const t = new Toggle({ title: schema.label, onChange: setVal });
        this.bind(() => t.set(!!get()));
        return fieldRow(label, t.el);
      }
      case 'select': {
        const s = new Select({ options: schema.options ?? [], title: schema.label, onChange: setVal });
        this.bind(() => s.set(String(get() ?? '')));
        return fieldRow(label, s.el);
      }
      case 'color': {
        const c = new ColorField({ title: schema.label, onChange: setVal });
        this.bind(() => c.set(String(get() ?? '#ffffff')));
        return fieldRow(label, c.el);
      }
      default: {
        const t = new TextField({ title: schema.label, onChange: setVal });
        this.bind(() => t.set(String(get() ?? '')));
        return fieldRow(label, t.el);
      }
    }
  }

  private hierarchySection(e: EntityData): HTMLElement {
    const ed = this.ctx.editor;
    const parentName = h('span', { class: 'readonly-value' });
    const children = h('span', { class: 'readonly-value' });
    this.bind(() => {
      const cur = ed.scene.get(e.id);
      if (!cur) return;
      parentName.textContent = cur.parent ? (ed.scene.get(cur.parent)?.name ?? '?') : '(ルート)';
      children.textContent = `${cur.children.length}個`;
    });
    const change = button({ icon: 'parent', label: '変更', class: 'secondary small', testId: 'insp-parent', onClick: () => openParentPicker(this.ctx, [e.id]) });
    const rows: HTMLElement[] = [fieldRow('親', h('div', { class: 'inline' }, parentName, change)), fieldRow('子', children)];
    if (e.kind === 'mesh') {
      const player = new Toggle({
        title: 'プレイヤー',
        testId: 'insp-player',
        onChange: (v) => A.setPlayer(ed, v ? e.id : null),
      });
      this.bind(() => player.set(ed.sceneData.playerId === e.id));
      rows.push(fieldRow('プレイヤー', player.el, { hint: '三人称カメラで操作する' }));
    }
    return section('階層・ゲーム設定', 'group', rows, { collapsed: false });
  }
}
