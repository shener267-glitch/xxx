import { Matrix4 } from 'three';
import type { PropSchema } from '../../components/registry';
import { getComponentDef, listComponentDefs } from '../../components/registry';
import * as A from '../../core/actions';
import { entityIcon, entityRole, entityTypeLabel, LIGHT_LABELS, MATERIAL_PRESETS, PATTERN_LABELS, SHAPE_LABELS } from '../../core/catalog';
import type { EntityData, EnvironmentData, MaterialPattern, MaterialPreset, PrimitiveShape, SkyType, Vec3, WeatherType } from '../../core/types';
import { deepEqual, getPath } from '../../core/util';
import type { AppContext } from '../context';
import { button, clear, h, rafThrottle } from '../dom';
import { icon } from '../icons';
import { openParentPicker } from '../menus';
import { actionSheet, toast } from '../overlays';
import { ColorField, fieldRow, NumberField, section as sectionWidget, Select, Slider, TextArea, TextField, Toggle, Vec3Field } from '../widgets';
import type { InspectorKit } from './gameInspector';
import { gameSettingsSection, modelSection, musicSection, soundField, uiElementSection } from './gameInspector';
import { clipsEditor } from './animEditor';
import { terrainSection } from './terrainInspector';

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
  /** セクションの開閉状態 (再構築しても保つ) */
  private collapsed = new Map<string, boolean>();
  /** 「詳しい設定」を開いているコンポーネント (オブジェクト ID:コンポーネント ID) */
  private openAdvanced = new Set<string>();
  private scheduleUpdate = rafThrottle(() => this.update());
  private kit: InspectorKit;

  constructor(private ctx: AppContext) {
    this.kit = { ctx, bind: (fn) => this.bind(fn), section: (t, i, b, o) => this.section(t, i, b, o) };
    this.body = h('div', { class: 'inspector-body' });
    this.el = h('div', { class: 'panel inspector-panel', attrs: { 'data-testid': 'inspector' } }, this.body);
    const ev = ctx.editor.events;
    for (const type of ['selection-changed', 'entity-changed', 'scene-loaded', 'environment-changed', 'hierarchy-changed', 'project-changed', 'entity-removed', 'assets-changed'] as const) {
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

  /** 開閉状態を記憶するセクション */
  private section(
    title: string,
    iconName: string,
    body: HTMLElement[],
    opts: { collapsed?: boolean; testId?: string } = {},
  ): HTMLElement {
    const key = opts.testId ?? title;
    return sectionWidget(title, iconName, body, {
      ...opts,
      collapsed: this.collapsed.get(key) ?? opts.collapsed,
      onToggle: (c) => this.collapsed.set(key, c),
    });
  }

  private bind(fn: Refresher): void {
    this.refreshers.push(fn);
    fn();
  }

  private computeKey(): string {
    const list = this.entities;
    if (list.length === 0) {
      const sd = this.ctx.editor.sceneData;
      const env = sd.environment;
      return `scene:${sd.id}:${env.sky.type}:${env.fog.enabled}:${env.weather.type}:${env.time.enabled}:${env.clouds.enabled}:${env.post.bloom.enabled}:${env.post.dof.enabled}`;
    }
    return list
      .map((e) =>
        [e.id, e.kind, e.mesh?.shape, e.mesh?.material.preset, e.light?.type, e.ui?.type, e.model?.asset, e.terrain?.resolution, e.components.map((c) => `${c.id}:${c.type}`).join(',')].join('|'),
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
    this.el.onscroll = null;
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

    const jump = h('nav', { class: 'insp-jump', attrs: { 'aria-label': '項目へ移動', 'data-testid': 'insp-jump' } });
    this.body.append(
      hint,
      h('div', { class: 'insp-sticky' }, jump),
      this.section('シーン設定', 'layers', [
        fieldRow('シーン名', nameField.el),
        fieldRow('プレイヤー', playerSelect, { hint: '三人称カメラで操作する対象' }),
      ]),
      gameSettingsSection(this.kit),
      musicSection(this.kit),
      ...this.environmentSections(),
      this.physicsSection(),
      this.section('統計', 'info', [stats]),
    );
    this.fillJumpBar(jump);
  }

  /** 空・霧・映り込み・天候 */
  private environmentSections(): HTMLElement[] {
    const ed = this.ctx.editor;
    const env = () => ed.sceneData.environment;
    const setEnv = (patch: Partial<EnvironmentData>, label: string, key?: string) => A.setEnvironment(ed, patch, label, key);
    const colorRow = (label: string, get: () => string, set: (hex: string) => void, testId?: string) => {
      const f = new ColorField({ title: label, testId, onChange: set });
      this.bind(() => f.set(get()));
      return fieldRow(label, f.el);
    };
    const sliderRow = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, testId?: string, hint?: string) => {
      const f = new Slider({ min, max, step, title: label, testId, onChange: set });
      this.bind(() => f.set(get()));
      return fieldRow(label, f.el, { hint });
    };

    // 空
    const skyType = new Select<SkyType>({
      options: [
        { value: 'gradient', label: 'グラデーションの空' },
        { value: 'physical', label: 'リアルな空 (太陽光と連動)' },
        { value: 'color', label: '単色の背景' },
      ],
      title: '空の種類',
      testId: 'env-sky',
      onChange: (v) => setEnv({ sky: { ...env().sky, type: v } }, '空の種類を変更'),
    });
    this.bind(() => skyType.set(env().sky.type));
    const skyRows: HTMLElement[] = [fieldRow('空の種類', skyType.el)];
    const t = env().sky.type;
    if (t === 'color') {
      skyRows.push(colorRow('背景色', () => env().background, (hex) => setEnv({ background: hex }, '背景色を変更', 'bg'), 'scene-bg'));
    } else if (t === 'gradient') {
      skyRows.push(
        colorRow('空の上', () => env().sky.topColor, (hex) => setEnv({ sky: { ...env().sky, topColor: hex } }, '空の色を変更', 'skyTop')),
        colorRow('地平線', () => env().sky.horizonColor, (hex) => setEnv({ sky: { ...env().sky, horizonColor: hex } }, '空の色を変更', 'skyHorizon')),
        colorRow('地面側', () => env().sky.bottomColor, (hex) => setEnv({ sky: { ...env().sky, bottomColor: hex } }, '空の色を変更', 'skyBottom')),
      );
    } else {
      skyRows.push(sliderRow('かすみ', 1, 20, 0.5, () => env().sky.turbidity, (v) => setEnv({ sky: { ...env().sky, turbidity: v } }, '空のかすみを変更', 'turbidity'), undefined, '大きいほど白っぽい空'));
      skyRows.push(h('p', { class: 'field-note', text: '太陽の位置は「太陽光」オブジェクトの回転で変わります。' }));
    }
    const refl = new Toggle({ title: '映り込み', testId: 'env-reflections', onChange: (v) => setEnv({ reflections: v }, v ? '映り込みを有効化' : '映り込みを無効化') });
    this.bind(() => refl.set(env().reflections));
    skyRows.push(
      fieldRow('映り込み', refl.el, { hint: '金属やガラスに空が映る' }),
      sliderRow('明るさ (露出)', 0.2, 2.5, 0.05, () => env().exposure, (v) => setEnv({ exposure: v }, '明るさを変更', 'exposure'), 'env-exposure'),
    );

    // 霧
    const fogOn = new Toggle({ title: '霧', testId: 'env-fog', onChange: (v) => setEnv({ fog: { ...env().fog, enabled: v } }, v ? '霧を有効化' : '霧を無効化') });
    this.bind(() => fogOn.set(env().fog.enabled));
    const fogRows: HTMLElement[] = [fieldRow('霧を出す', fogOn.el)];
    if (env().fog.enabled) {
      const near = new NumberField({ step: 1, min: 0, title: '霧の開始距離', onChange: (v) => setEnv({ fog: { ...env().fog, near: v } }, '霧を変更', 'fogNear') });
      this.bind(() => near.set(env().fog.near));
      const far = new NumberField({ step: 5, min: 1, title: '霧の終了距離', onChange: (v) => setEnv({ fog: { ...env().fog, far: v } }, '霧を変更', 'fogFar') });
      this.bind(() => far.set(env().fog.far));
      fogRows.push(
        colorRow('霧の色', () => env().fog.color, (hex) => setEnv({ fog: { ...env().fog, color: hex } }, '霧の色を変更', 'fogColor')),
        fieldRow('始まる距離', near.el),
        fieldRow('真っ白になる距離', far.el),
      );
    }

    // 天候
    const weather = new Select<WeatherType>({
      options: [
        { value: 'none', label: '晴れ (なし)' },
        { value: 'rain', label: '雨' },
        { value: 'snow', label: '雪' },
      ],
      title: '天候',
      testId: 'env-weather',
      onChange: (v) => setEnv({ weather: { ...env().weather, type: v } }, '天候を変更'),
    });
    this.bind(() => weather.set(env().weather.type));
    const weatherRows: HTMLElement[] = [fieldRow('天候', weather.el)];
    if (env().weather.type !== 'none') {
      weatherRows.push(
        sliderRow('強さ', 0.05, 1, 0.05, () => env().weather.intensity, (v) => setEnv({ weather: { ...env().weather, intensity: v } }, '天候の強さを変更', 'weather')),
      );
      if (env().weather.type === 'rain') {
        const bolt = new Toggle({ title: '雷', testId: 'env-lightning', onChange: (v) => setEnv({ weather: { ...env().weather, lightning: v } }, v ? '雷を有効化' : '雷を無効化') });
        this.bind(() => bolt.set(env().weather.lightning));
        weatherRows.push(fieldRow('雷', bolt.el, { hint: 'ときどき稲妻が光って雷の音がする' }));
      }
      weatherRows.push(h('p', { class: 'field-note', text: '天候は Play 中に表示されます (設定の「エフェクトのプレビュー」で編集中も表示)。' }));
    }

    // 時刻・昼と夜
    const tod = () => env().time;
    const setTime = (patch: Partial<EnvironmentData['time']>, label: string, key?: string) => setEnv({ time: { ...tod(), ...patch } }, label, key);
    const timeOn = new Toggle({ title: '時刻を使う', testId: 'env-time', onChange: (v) => setTime({ enabled: v }, v ? '時刻 (昼夜) を有効化' : '時刻 (昼夜) を無効化') });
    this.bind(() => timeOn.set(tod().enabled));
    const timeRows: HTMLElement[] = [fieldRow('時刻で空と光を変える', timeOn.el, { hint: '太陽が動き、夕焼け・夜・星・月になる' })];
    if (tod().enabled) {
      const clock = h('span', { class: 'readonly-value', attrs: { 'data-testid': 'env-clock' } });
      this.bind(() => (clock.textContent = formatClock(tod().hour)));
      const cycle = new Toggle({ title: '時間を進める', testId: 'env-cycle', onChange: (v) => setTime({ cycle: v }, '時間の進み方を変更') });
      this.bind(() => cycle.set(tod().cycle));
      const minutes = new NumberField({ step: 0.5, min: 0.1, max: 1440, title: '1 日の長さ (分)', testId: 'env-day-minutes', onChange: (v) => setTime({ dayMinutes: v }, '1 日の長さを変更', 'dayMinutes') });
      this.bind(() => minutes.set(tod().dayMinutes));
      const stars = new Toggle({ title: '星', testId: 'env-stars', onChange: (v) => setTime({ stars: v }, '星の表示を変更') });
      this.bind(() => stars.set(tod().stars));
      const moon = new Toggle({ title: '月', testId: 'env-moon', onChange: (v) => setTime({ moon: v }, '月の表示を変更') });
      this.bind(() => moon.set(tod().moon));
      timeRows.push(
        sliderRow('時刻', 0, 24, 0.25, () => tod().hour, (v) => setTime({ hour: v % 24 }, '時刻を変更', 'hour'), 'env-hour'),
        fieldRow('いまの時刻', clock),
        fieldRow('Play 中に時間を進める', cycle.el),
        fieldRow('1 日の長さ', minutes.el, { hint: '実際の時間で何分か' }),
        sliderRow('太陽の通り道の向き', 0, 360, 5, () => tod().sunDirection, (v) => setTime({ sunDirection: v }, '太陽の向きを変更', 'sunDirection'), 'env-sun-dir', '度'),
        fieldRow('星', stars.el),
        fieldRow('月', moon.el),
        h('p', { class: 'field-note', text: '「太陽光」オブジェクトの向きと明るさは時刻で決まります (夜は月の光になります)。イベントの「時刻を変える」「夜になったとき」でも使えます。' }),
      );
    }

    // 雲
    const clouds = () => env().clouds;
    const setClouds = (patch: Partial<EnvironmentData['clouds']>, label: string, key?: string) => setEnv({ clouds: { ...clouds(), ...patch } }, label, key);
    const cloudOn = new Toggle({ title: '雲', testId: 'env-clouds', onChange: (v) => setClouds({ enabled: v }, v ? '雲を有効化' : '雲を無効化') });
    this.bind(() => cloudOn.set(clouds().enabled));
    const cloudRows: HTMLElement[] = [fieldRow('雲を出す', cloudOn.el)];
    if (clouds().enabled) {
      const height = new NumberField({ step: 5, min: 5, max: 2000, title: '雲の高さ (m)', testId: 'env-cloud-height', onChange: (v) => setClouds({ height: v }, '雲の高さを変更', 'cloudHeight') });
      this.bind(() => height.set(clouds().height));
      cloudRows.push(
        sliderRow('量', 0, 1, 0.05, () => clouds().amount, (v) => setClouds({ amount: v }, '雲の量を変更', 'cloudAmount'), 'env-cloud-amount'),
        sliderRow('流れる速さ', 0, 30, 0.5, () => clouds().speed, (v) => setClouds({ speed: v }, '雲の速さを変更', 'cloudSpeed'), 'env-cloud-speed', 'm/秒'),
        fieldRow('高さ', height.el, { hint: 'm' }),
        colorRow('色', () => clouds().color, (hex) => setClouds({ color: hex }, '雲の色を変更', 'cloudColor'), 'env-cloud-color'),
      );
    }

    // ポストエフェクト
    const post = () => env().post;
    const setPost = (patch: Partial<EnvironmentData['post']>, label: string, key?: string) => setEnv({ post: { ...post(), ...patch } }, label, key);
    const bloomOn = new Toggle({ title: '光のにじみ', testId: 'env-bloom', onChange: (v) => setPost({ bloom: { ...post().bloom, enabled: v } }, v ? '光のにじみを有効化' : '光のにじみを無効化') });
    this.bind(() => bloomOn.set(post().bloom.enabled));
    const dofOn = new Toggle({ title: '被写界深度', testId: 'env-dof', onChange: (v) => setPost({ dof: { ...post().dof, enabled: v } }, v ? '被写界深度を有効化' : '被写界深度を無効化') });
    this.bind(() => dofOn.set(post().dof.enabled));
    const postRows: HTMLElement[] = [fieldRow('光のにじみ (ブルーム)', bloomOn.el, { hint: '明るい所・光る物がふわっと光る' })];
    if (post().bloom.enabled) {
      postRows.push(
        sliderRow('にじみの強さ', 0, 3, 0.05, () => post().bloom.strength, (v) => setPost({ bloom: { ...post().bloom, strength: v } }, 'にじみを変更', 'bloomStrength'), 'env-bloom-strength'),
        sliderRow('光り始める明るさ', 0, 1, 0.05, () => post().bloom.threshold, (v) => setPost({ bloom: { ...post().bloom, threshold: v } }, 'にじみを変更', 'bloomThreshold'), 'env-bloom-threshold', '小さいほど多く光る'),
        sliderRow('にじみの広さ', 0, 1, 0.05, () => post().bloom.radius, (v) => setPost({ bloom: { ...post().bloom, radius: v } }, 'にじみを変更', 'bloomRadius')),
      );
    }
    postRows.push(fieldRow('被写界深度 (ぼかし)', dofOn.el, { hint: 'ピントの合っていない所をぼかす (Play のみ)' }));
    if (post().dof.enabled) {
      const auto = new Toggle({ title: 'プレイヤーにピント', testId: 'env-dof-auto', onChange: (v) => setPost({ dof: { ...post().dof, autoFocus: v } }, 'ピントを変更') });
      this.bind(() => auto.set(post().dof.autoFocus));
      const focus = new NumberField({ step: 0.5, min: 0.1, max: 1000, title: 'ピントの距離 (m)', testId: 'env-dof-focus', onChange: (v) => setPost({ dof: { ...post().dof, focus: v } }, 'ピントを変更', 'dofFocus') });
      this.bind(() => focus.set(post().dof.focus));
      postRows.push(
        fieldRow('プレイヤーにピントを合わせる', auto.el),
        fieldRow('ピントの距離', focus.el, { hint: 'プレイヤーがいないとき (m)' }),
        sliderRow('ぼかしの強さ', 0, 1, 0.05, () => post().dof.blur, (v) => setPost({ dof: { ...post().dof, blur: v } }, 'ぼかしを変更', 'dofBlur'), 'env-dof-blur'),
      );
    }
    postRows.push(
      sliderRow('周辺を暗く', 0, 1, 0.05, () => post().vignette, (v) => setPost({ vignette: v }, '周辺減光を変更', 'vignette'), 'env-vignette'),
      sliderRow('あざやかさ', -1, 1, 0.05, () => post().saturation, (v) => setPost({ saturation: v }, '色あいを変更', 'saturation'), 'env-saturation', '-1 で白黒'),
      sliderRow('コントラスト', -1, 1, 0.05, () => post().contrast, (v) => setPost({ contrast: v }, '色あいを変更', 'contrast'), 'env-contrast'),
      sliderRow('色味', -1, 1, 0.05, () => post().warmth, (v) => setPost({ warmth: v }, '色あいを変更', 'warmth'), 'env-warmth', '- 寒い / + 暖かい'),
      h('p', { class: 'field-note', text: '画面全体の効果は Play 中に表示されます (編集中は設定の「エフェクトのプレビュー」で確認)。画質「低」では使いません。' }),
    );
    return [
      this.section('空・明るさ', 'sun', skyRows, { testId: 'sec-sky' }),
      this.section('霧', 'cloud', fogRows, { collapsed: !env().fog.enabled, testId: 'sec-fog' }),
      this.section('天候', 'cloud', weatherRows, { collapsed: env().weather.type === 'none', testId: 'sec-weather' }),
      this.section('時刻・昼と夜', 'moon', timeRows, { collapsed: !env().time.enabled, testId: 'sec-time' }),
      this.section('雲', 'cloud', cloudRows, { collapsed: !env().clouds.enabled, testId: 'sec-clouds' }),
      this.section('画面の効果', 'sparkles', postRows, { collapsed: true, testId: 'sec-post' }),
    ];
  }

  private physicsSection(): HTMLElement {
    const ed = this.ctx.editor;
    const phys = () => ed.sceneData.physics;
    const on = new Toggle({ title: '物理', testId: 'phys-enabled', onChange: (v) => A.setPhysicsSettings(ed, { enabled: v }, v ? '物理を有効化' : '物理を無効化') });
    this.bind(() => on.set(phys().enabled));
    const gravity = new Vec3Field({
      title: '重力',
      step: 0.5,
      testId: 'phys-gravity',
      onChange: (axis, v) => {
        const g = [...phys().gravity] as Vec3;
        g[axis] = v;
        A.setPhysicsSettings(ed, { gravity: g }, '重力を変更', 'gravity');
      },
    });
    this.bind(() => gravity.set(phys().gravity));
    return this.section(
      '物理',
      'zap',
      [
        fieldRow('物理演算', on.el, { hint: 'Play 中に落下・衝突を計算' }),
        fieldRow('重力 (m/s²)', gravity.el, { stacked: true }),
        h('p', { class: 'field-note', text: 'オブジェクトに「物理 (Rigidbody)」や「当たり判定 (Collider)」の動作を追加すると、落下や衝突をします。地球の重力は Y = -9.81 です。' }),
      ],
      { collapsed: true, testId: 'sec-physics' },
    );
  }

  // ------------------------------------------------------------------
  // オブジェクト
  // ------------------------------------------------------------------

  private buildEntities(list: EntityData[]): void {
    const ed = this.ctx.editor;
    const single = list.length === 1 ? list[0] : null;
    const jump = h('nav', { class: 'insp-jump', attrs: { 'aria-label': '項目へ移動', 'data-testid': 'insp-jump' } });
    this.body.appendChild(h('div', { class: 'insp-sticky' }, this.header(list), jump));
    const kinds = new Set(list.map((e) => e.kind));
    const kind = kinds.size === 1 ? list[0].kind : null;
    // 画面の UI は 3D の位置を持たない
    if (kind !== 'ui') this.body.appendChild(this.transformSection());
    // プレイヤー・敵・アイテムなどゲームの仕組みを持つ物は、見た目より先に「動作」を出す
    const role = single ? entityRole(single, ed.sceneData.playerId === single.id) : null;
    const gameFirst = !!single && !!role && ['player', 'enemy', 'npc', 'item', 'goal', 'hazard'].includes(role.tone);
    if (gameFirst && single) this.body.appendChild(this.componentsSection(single));

    if (kind === 'ui' && single) {
      this.body.appendChild(uiElementSection(this.kit, single));
    } else if (kind === 'model' && single) {
      this.body.appendChild(modelSection(this.kit, single));
    } else if (kind === 'terrain' && single) {
      for (const sec of terrainSection(this.kit, single)) this.body.appendChild(sec);
    } else if (kind === 'mesh') {
      this.body.appendChild(this.meshSection());
      this.body.appendChild(this.materialSection(list));
    } else if (kind === 'light') {
      this.body.appendChild(this.lightSection(list));
    } else if (kind === 'camera') {
      this.body.appendChild(this.cameraSection(single));
    }
    if (single) {
      if (!gameFirst) this.body.appendChild(this.componentsSection(single));
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
    this.fillJumpBar(jump);
  }

  /** 見出しの下の「項目へ移動」ボタン (長い Inspector をスクロールせずに目的の項目へ) */
  private fillJumpBar(bar: HTMLElement): void {
    const sections = [...this.body.querySelectorAll<HTMLElement>('section.section')].filter((sec) => !sec.parentElement?.closest('section.section'));
    if (sections.length < 3) {
      bar.hidden = true;
      return;
    }
    const chips = sections.map((sec) => {
      const title = sec.dataset.title ?? '';
      return h('button', {
        class: 'jump-chip',
        text: shortSectionTitle(title),
        attrs: { type: 'button', 'data-testid': `jump-${sec.dataset.testid ?? title}` },
        on: {
          click: () => {
            if (sec.classList.contains('collapsed')) (sec.querySelector('.section-toggle') as HTMLButtonElement | null)?.click();
            this.el.scrollTo({ top: Math.max(0, this.el.scrollTop + offsetInPanel(sec)), behavior: 'smooth' });
          },
        },
      });
    });
    bar.replaceChildren(...chips);
    // 見出し (固定表示) の下端から測った、項目の上端の位置
    const offsetInPanel = (sec: HTMLElement) => {
      const sticky = (this.body.querySelector('.insp-sticky') as HTMLElement | null)?.getBoundingClientRect().bottom ?? this.el.getBoundingClientRect().top;
      return sec.getBoundingClientRect().top - sticky - 6;
    };
    // スクロール位置に合わせて、今見ている項目のボタンを強調する
    const highlight = () => {
      if (this.el.offsetParent === null) return;
      let current = 0;
      sections.forEach((sec, i) => {
        if (offsetInPanel(sec) <= 12) current = i;
      });
      chips.forEach((c, i) => c.classList.toggle('active', i === current));
    };
    this.el.onscroll = rafThrottle(highlight);
    chips[0]?.classList.add('active');
    requestAnimationFrame(highlight);
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
    // 大きさを変えて地面に埋まった / 浮いた物を、下の面にそろえる
    const drop = button({
      icon: 'arrowDown',
      title: '地面に置く (下にそろえる)',
      class: 'icon-btn small ghost',
      testId: 'insp-drop',
      onClick: () => {
        if (!this.ctx.viewport.dropToGround(this.ids)) toast('すでに地面の上にあります', 'info', 1400);
      },
    });
    return this.section('トランスフォーム', 'move', [vecRow('位置', 'position', 0.1, drop), vecRow('回転', 'rotation', 5), vecRow('サイズ', 'scale', 0.1, link)], {
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
    return this.section('メッシュ', 'cube', [fieldRow('形状', shape.el), fieldRow('影を落とす', cast.el), fieldRow('影を受ける', receive.el)]);
  }

  private materialSection(list: EntityData[]): HTMLElement {
    const ed = this.ctx.editor;
    const preset = new Select<MaterialPreset>({
      options: MATERIAL_PRESETS.map((p) => ({ value: p.preset, label: `${p.label} — ${p.description}` })),
      title: 'マテリアルの種類',
      testId: 'insp-preset',
      onChange: (v) => A.applyMaterialPreset(ed, this.ids, v),
    });
    this.bind(() => preset.set(this.commonPath<MaterialPreset>('mesh.material.preset')));

    const color = new ColorField({ title: '色', testId: 'insp-color', onChange: (hex) => this.set('mesh.material.color', hex, '色を変更') });
    this.bind(() => color.set(this.commonPath<string>('mesh.material.color')));

    const pattern = new Select<MaterialPattern>({
      options: (Object.keys(PATTERN_LABELS) as MaterialPattern[]).map((p) => ({ value: p, label: PATTERN_LABELS[p] })),
      title: '模様',
      testId: 'insp-pattern',
      onChange: (v) => this.set('mesh.material.pattern', v, '模様を変更', false),
    });
    this.bind(() => pattern.set(this.commonPath<MaterialPattern>('mesh.material.pattern')));

    const slider = (path: string, label: string, min: number, max: number, step: number, testId?: string) => {
      const s = new Slider({ min, max, step, title: label, testId, onChange: (v) => this.set(path, v, `${label}を変更`) });
      this.bind(() => s.set(this.commonPath<number>(path)));
      return s.el;
    };
    const wire = new Toggle({ title: 'ワイヤーフレーム', onChange: (v) => this.set('mesh.material.wireframe', v, '表示方法を変更', false) });
    this.bind(() => wire.set(this.commonPath<boolean>('mesh.material.wireframe')));

    const lit = list.every((e) => e.mesh?.material.preset !== 'unlit');
    const rows: HTMLElement[] = [
      fieldRow('種類', preset.el, { stacked: true }),
      fieldRow('色', color.el),
      fieldRow('模様', pattern.el),
      fieldRow('画像', this.textureField(), { hint: 'テクスチャ' }),
    ];
    if (lit) {
      const emissive = new ColorField({ title: '発光色', onChange: (hex) => this.set('mesh.material.emissive', hex, '発光色を変更') });
      this.bind(() => emissive.set(this.commonPath<string>('mesh.material.emissive')));
      rows.push(
        fieldRow('粗さ', slider('mesh.material.roughness', '粗さ', 0, 1, 0.01, 'insp-roughness'), { hint: '0 でツルツル' }),
        fieldRow('金属感', slider('mesh.material.metalness', '金属感', 0, 1, 0.01, 'insp-metalness')),
        fieldRow('映り込み', slider('mesh.material.envIntensity', '映り込み', 0, 3, 0.05, 'insp-env'), { hint: '周囲の反射の強さ' }),
        fieldRow('発光色', emissive.el),
        fieldRow('発光の強さ', slider('mesh.material.emissiveIntensity', '発光の強さ', 0, 10, 0.1)),
      );
    }
    rows.push(fieldRow('不透明度', slider('mesh.material.opacity', '不透明度', 0, 1, 0.01, 'insp-opacity')), fieldRow('ワイヤーフレーム', wire.el));
    const uvSection = this.uvSection();
    return h('div', null, this.section('マテリアル', 'palette', rows, { testId: 'sec-material' }), uvSection);
  }

  /** 画像テクスチャの選択 (読み込み・既存アセットから選択・外す) */
  private textureField(): HTMLElement {
    const assets = this.ctx.assets;
    const thumb = h('span', { class: 'tex-thumb' });
    const label = h('span', { class: 'tex-name' });
    const btn = h(
      'button',
      {
        class: 'tex-field',
        attrs: { type: 'button', 'data-testid': 'insp-texture' },
        on: {
          click: () => {
            const images = assets.byType('image');
            const current = this.commonPath<string | null>('mesh.material.texture');
            const setTex = (id: string | null) => this.set('mesh.material.texture', id, id ? 'テクスチャを設定' : 'テクスチャを外す', false);
            actionSheet('画像テクスチャ', [
              {
                label: '画像を読み込む…',
                icon: 'upload',
                testId: 'tex-import',
                onSelect: () => {
                  void assets.pickAndImport('image', '', false).then(({ added, errors }) => {
                    errors.forEach((e) => toast(e, 'error', 3500));
                    if (added[0]) setTex(added[0].id);
                  });
                },
              },
              ...(current ? [{ label: 'テクスチャを外す', icon: 'x', testId: 'tex-clear', onSelect: () => setTex(null) }] : []),
              ...(images.length > 0 ? (['separator'] as const) : []),
              ...images.map((a) => ({ label: a.name, icon: 'image', checked: a.id === current, onSelect: () => setTex(a.id) })),
            ]);
          },
        },
      },
      thumb,
      label,
    );
    this.bind(() => {
      const id = this.commonPath<string | null>('mesh.material.texture');
      const a = assets.find(id);
      label.textContent = a ? a.name : 'なし';
      thumb.style.backgroundImage = '';
      thumb.innerHTML = a ? '' : icon('image', 18);
      if (a) {
        void assets.objectUrl(a.id).then((url) => {
          if (url) thumb.style.backgroundImage = `url(${url})`;
        });
      }
    });
    return btn;
  }

  /** テクスチャの配置 (繰り返し・ずれ・回転) */
  private uvSection(): HTMLElement {
    const pair = (path: string, title: string, step: number) => {
      const fields = (['U', 'V'] as const).map(
        (axis, i) =>
          new NumberField({
            label: axis,
            step,
            title: `${title} ${axis}`,
            testId: `insp-${path.split('.').pop()}-${axis.toLowerCase()}`,
            onChange: (v) => this.set(`mesh.material.${path}.${i}`, v, `${title}を変更`),
          }),
      );
      this.bind(() => fields.forEach((f, i) => f.set(this.commonPath<number>(`mesh.material.${path}.${i}`))));
      return h('div', { class: 'vec3-field' }, fields.map((f) => f.el));
    };
    const rot = new NumberField({ step: 5, title: 'テクスチャの回転', onChange: (v) => this.set('mesh.material.uvRotation', v, 'テクスチャの回転を変更') });
    this.bind(() => rot.set(this.commonPath<number>('mesh.material.uvRotation')));
    return this.section(
      'テクスチャの配置 (UV)',
      'grid',
      [
        fieldRow('繰り返し', pair('uvScale', '繰り返し', 0.1), { stacked: true }),
        fieldRow('ずれ', pair('uvOffset', 'ずれ', 0.05), { stacked: true }),
        fieldRow('回転 (度)', rot.el),
        h('p', { class: 'field-note', text: '模様や画像の大きさ・向きを調整します。大きな床は「繰り返し」を増やすと細かくなります。' }),
      ],
      { collapsed: true, testId: 'sec-uv' },
    );
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
    return this.section('ライト', 'sun', rows);
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
          button({
            icon: 'eye',
            label: 'このカメラから見る',
            class: 'secondary',
            testId: 'insp-camera-preview',
            onClick: () => {
              this.ctx.viewport.setPreviewCamera(single.id);
              this.ctx.closeSheet();
            },
          }),
        ),
        h('p', { class: 'field-note', text: 'カメラを何台も置いて、イベントの「カメラを切り替える」やタイムラインで切り替えられます。' }),
      );
    }
    return this.section('カメラ', 'camera', rows);
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
        const basic = def.schema.filter((sc) => !sc.advanced);
        const advanced = def.schema.filter((sc) => sc.advanced);
        for (const schema of basic) props.push(this.componentProp(e.id, comp.id, schema));
        if (advanced.length > 0) {
          const key = `${e.id}:${comp.id}`;
          const box = h('div', { class: 'advanced-props' }, advanced.map((schema) => this.componentProp(e.id, comp.id, schema)));
          const toggle = h('button', {
            class: 'advanced-toggle',
            attrs: { type: 'button', 'data-testid': `adv-${comp.type}` },
            on: {
              click: () => {
                const open = !this.openAdvanced.has(key);
                if (open) this.openAdvanced.add(key);
                else this.openAdvanced.delete(key);
                sync();
              },
            },
          });
          const sync = () => {
            const open = this.openAdvanced.has(key);
            box.hidden = !open;
            toggle.innerHTML = `${icon(open ? 'chevronUp' : 'chevronDown', 16)}<span>${open ? '詳しい設定をしまう' : `詳しい設定 (${advanced.length})`}</span>`;
            toggle.setAttribute('aria-expanded', String(open));
          };
          sync();
          props.push(toggle, box);
        }
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
    const note = h(
      'p',
      { class: 'field-note' },
      '動作は Play 中に自動で実行されます。「触れたらドアが開く」のような仕組みは ',
      h('button', { class: 'link-btn', text: 'イベント', attrs: { type: 'button', 'data-testid': 'insp-open-events' }, on: { click: () => this.ctx.openTab('events') } }),
      ' タブで作れます。',
    );
    return this.section('動作 (コンポーネント)', 'sparkles', [...cards, add, note], { testId: 'sec-components' });
  }

  private componentProp(entityId: string, compId: string, schema: PropSchema): HTMLElement {
    const ed = this.ctx.editor;
    const get = () => ed.scene.get(entityId)?.components.find((c) => c.id === compId)?.props[schema.key];
    const setVal = (v: unknown) => A.setComponentProp(ed, entityId, compId, schema.key, v);
    const label = schema.unit ? `${schema.label} (${schema.unit})` : schema.label;
    const hint = schema.hint;
    switch (schema.type) {
      case 'clips':
        return clipsEditor(this.kit, entityId, compId);
      case 'text': {
        const t = new TextArea({ title: schema.label, testId: `prop-${schema.key}`, onChange: setVal });
        this.bind(() => t.set(String(get() ?? '')));
        return fieldRow(label, t.el, { stacked: true, hint });
      }
      case 'sound': {
        const field = soundField(this.kit, {
          kind: 'sfx',
          title: schema.label,
          testId: `prop-${schema.key}`,
          get: () => {
            const v = get();
            return typeof v === 'string' && v ? v : null;
          },
          set: (v) => setVal(v ?? ''),
        });
        return fieldRow(label, field, { hint });
      }
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
        const f = new NumberField({ step: schema.step ?? 0.1, min: schema.min, max: schema.max, title: schema.label, testId: `prop-${schema.key}`, onChange: setVal });
        this.bind(() => f.set(Number(get()) || 0));
        return fieldRow(label, f.el, { hint });
      }
      case 'boolean': {
        const t = new Toggle({ title: schema.label, testId: `prop-${schema.key}`, onChange: setVal });
        this.bind(() => t.set(!!get()));
        return fieldRow(label, t.el, { hint });
      }
      case 'select': {
        const s = new Select({ options: schema.options ?? [], title: schema.label, testId: `prop-${schema.key}`, onChange: setVal });
        this.bind(() => s.set(String(get() ?? '')));
        return fieldRow(label, s.el, { hint });
      }
      case 'color': {
        const c = new ColorField({ title: schema.label, onChange: setVal });
        this.bind(() => c.set(String(get() ?? '#ffffff')));
        return fieldRow(label, c.el);
      }
      default: {
        const t = new TextField({ title: schema.label, testId: `prop-${schema.key}`, onChange: setVal });
        this.bind(() => t.set(String(get() ?? '')));
        return fieldRow(label, t.el, { hint });
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
    return this.section('階層・ゲーム設定', 'group', rows, { collapsed: false });
  }
}

const SHORT_TITLES: Record<string, string> = {
  トランスフォーム: '位置',
  メッシュ: '形',
  マテリアル: '見た目',
  'テクスチャの配置 (UV)': '模様',
  '動作 (コンポーネント)': '動作',
  '階層・ゲーム設定': '階層',
  シーン設定: 'シーン',
  ゲーム設定: 'ゲーム',
  '空・明るさ': '空',
  '時刻・昼と夜': '時刻',
  画面の効果: '効果',
};

function shortSectionTitle(title: string): string {
  return SHORT_TITLES[title] ?? (title.length > 6 ? `${title.slice(0, 6)}…` : title);
}

/** 時刻 (0〜24) を「10:30」の形にする */
export function formatClock(hour: number): string {
  const total = Math.round((((hour % 24) + 24) % 24) * 60);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}
