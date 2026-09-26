import * as A from '../../core/actions';
import { BUILTIN_MUSIC, BUILTIN_PREFIX, BUILTIN_SFX, builtinSoundLabel, isBuiltinSound } from '../../core/sounds';
import type { EntityData, GameSettings, UIAnchor, UIButtonAction, UIElementData } from '../../core/types';
import { AudioEngine } from '../../runtime/AudioEngine';
import { resolveAsset } from '../../engine/textures';
import type { AppContext } from '../context';
import { button, h } from '../dom';
import { icon } from '../icons';
import { actionSheet, confirmDialog, toast } from '../overlays';
import { ColorField, fieldRow, NumberField, Select, Slider, TextArea, TextField, Toggle } from '../widgets';

/**
 * Phase 3 のゲーム用 Inspector 項目 (UI 要素・効果音の選択・BGM・ゲーム設定)。
 * InspectorPanel から呼ばれる。
 */

export interface InspectorKit {
  ctx: AppContext;
  bind(fn: () => void): void;
  section(title: string, iconName: string, body: HTMLElement[], opts?: { collapsed?: boolean; testId?: string }): HTMLElement;
}

// ------------------------------------------------------------------
// 音の試聴 (エディタ用。ボタンを押したときに作る)
// ------------------------------------------------------------------

let previewAudio: AudioEngine | null = null;
let previewTimer: ReturnType<typeof setTimeout> | null = null;

function preview(source: string | null, music: boolean): void {
  if (!source) return;
  if (!previewAudio) previewAudio = new AudioEngine(resolveAsset);
  previewAudio.unlock();
  if (!music) {
    previewAudio.play(source);
    return;
  }
  // 音楽は数秒だけ流す (もう一度押すと止める)
  if (previewAudio.currentMusic === source) {
    previewAudio.stopMusic();
    return;
  }
  previewAudio.playMusic(source, 1);
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => previewAudio?.stopMusic(), 6000);
}

export function stopPreview(): void {
  previewAudio?.stopMusic();
}

/** 効果音 / 音楽の選択欄 (組み込みの音 + 音声アセット + 読み込み) */
export function soundField(
  kit: InspectorKit,
  opts: { kind: 'sfx' | 'music'; title: string; testId?: string; get: () => string | null; set: (v: string | null) => void },
): HTMLElement {
  const assets = kit.ctx.assets;
  const label = h('span', { class: 'tex-name' });
  const pick = h(
    'button',
    {
      class: 'tex-field',
      attrs: { type: 'button', 'data-testid': opts.testId },
      on: {
        click: () => {
          const current = opts.get();
          const builtin = opts.kind === 'music' ? BUILTIN_MUSIC : BUILTIN_SFX;
          const audios = assets.byType('audio');
          actionSheet(opts.title, [
            {
              label: '音声ファイルを読み込む…',
              icon: 'upload',
              testId: `${opts.testId}-import`,
              onSelect: () => {
                void assets.pickAndImport('audio', '', false).then(({ added, errors }) => {
                  errors.forEach((e) => toast(e, 'error', 3500));
                  if (added[0]) opts.set(added[0].id);
                });
              },
            },
            { label: 'なし', icon: 'x', checked: !current, testId: `${opts.testId}-none`, onSelect: () => opts.set(null) },
            'separator',
            ...builtin.map((s) => ({
              label: s.label,
              hint: '組み込み',
              icon: opts.kind === 'music' ? 'music' : 'volume',
              checked: current === `${BUILTIN_PREFIX}${s.id}`,
              testId: `${opts.testId}-${s.id}`,
              onSelect: () => opts.set(`${BUILTIN_PREFIX}${s.id}`),
            })),
            ...(audios.length > 0 ? (['separator'] as const) : []),
            ...audios.map((a) => ({ label: a.name, icon: 'music', checked: a.id === current, onSelect: () => opts.set(a.id) })),
          ]);
        },
      },
    },
    h('span', { class: 'tex-thumb', html: icon(opts.kind === 'music' ? 'music' : 'volume', 18) }),
    label,
  );
  const play = button({ icon: 'play', title: '試聴', class: 'icon-btn small secondary', testId: opts.testId ? `${opts.testId}-preview` : undefined, onClick: () => preview(opts.get(), opts.kind === 'music') });
  kit.bind(() => {
    const v = opts.get();
    label.textContent = !v ? 'なし' : isBuiltinSound(v) ? `${builtinSoundLabel(v)} (組み込み)` : (assets.find(v)?.name ?? '(見つかりません)');
    play.disabled = !v;
  });
  return h('div', { class: 'inline' }, pick, play);
}

/** 画像アセットの選択欄 */
export function imageField(kit: InspectorKit, opts: { title: string; testId?: string; get: () => string | null; set: (v: string | null) => void }): HTMLElement {
  const assets = kit.ctx.assets;
  const thumb = h('span', { class: 'tex-thumb' });
  const label = h('span', { class: 'tex-name' });
  const btn = h(
    'button',
    {
      class: 'tex-field',
      attrs: { type: 'button', 'data-testid': opts.testId },
      on: {
        click: () => {
          const current = opts.get();
          const images = assets.byType('image');
          actionSheet(opts.title, [
            {
              label: '画像を読み込む…',
              icon: 'upload',
              testId: `${opts.testId}-import`,
              onSelect: () => {
                void assets.pickAndImport('image', '', false).then(({ added, errors }) => {
                  errors.forEach((e) => toast(e, 'error', 3500));
                  if (added[0]) opts.set(added[0].id);
                });
              },
            },
            ...(current ? [{ label: '画像を外す', icon: 'x', testId: `${opts.testId}-clear`, onSelect: () => opts.set(null) }] : []),
            ...(images.length > 0 ? (['separator'] as const) : []),
            ...images.map((a) => ({ label: a.name, icon: 'image', checked: a.id === current, onSelect: () => opts.set(a.id) })),
          ]);
        },
      },
    },
    thumb,
    label,
  );
  kit.bind(() => {
    const a = assets.find(opts.get());
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

// ------------------------------------------------------------------
// UI 要素
// ------------------------------------------------------------------

const ANCHORS: { value: UIAnchor; label: string }[] = [
  { value: 'top-left', label: '左上' },
  { value: 'top', label: '上' },
  { value: 'top-right', label: '右上' },
  { value: 'left', label: '左' },
  { value: 'center', label: '中央' },
  { value: 'right', label: '右' },
  { value: 'bottom-left', label: '左下' },
  { value: 'bottom', label: '下' },
  { value: 'bottom-right', label: '右下' },
];

const ACTIONS: { value: UIButtonAction; label: string }[] = [
  { value: 'none', label: 'なし (イベントで使う)' },
  { value: 'jump', label: 'ジャンプ' },
  { value: 'action', label: 'アクション (攻撃・話す)' },
  { value: 'pause', label: '一時停止メニュー' },
  { value: 'restart', label: '最初からやり直す' },
  { value: 'title', label: 'タイトルへ' },
];

const BAR_SOURCES = [
  { value: 'hp', label: 'HP' },
  { value: 'timer', label: '残り時間' },
  { value: 'score', label: 'スコア' },
  { value: 'money', label: 'お金' },
  { value: 'custom', label: '変数・持ち物 (名前を指定)' },
];

export function uiElementSection(kit: InspectorKit, e: EntityData): HTMLElement {
  const ed = kit.ctx.editor;
  const id = e.id;
  const cur = (): UIElementData | undefined => ed.scene.get(id)?.ui;
  const set = <K extends keyof UIElementData>(key: K, value: UIElementData[K], label: string, merge = true) =>
    A.setEntityValue(ed, [id], `ui.${key}`, value, { label, mergeKey: merge ? `ui.${key}` : undefined });
  const type = e.ui?.type ?? 'text';
  const rows: HTMLElement[] = [];

  if (type === 'text' || type === 'button') {
    const text = new TextArea({ title: '文字', testId: 'ui-text', rows: 2, onChange: (v) => set('text', v, '文字を変更', false) });
    kit.bind(() => text.set(cur()?.text ?? ''));
    rows.push(fieldRow('文字', text.el, { stacked: true, hint: '{score} {money} {hp} {timer} {var:名前} {item:名前} で値を表示' }));
  }
  if (type === 'image') {
    rows.push(fieldRow('画像', imageField(kit, { title: 'UI の画像', testId: 'ui-image', get: () => cur()?.image ?? null, set: (v) => set('image', v, '画像を変更', false) })));
  }
  if (type === 'bar') {
    const custom = new TextField({ title: '名前', testId: 'ui-bar-name', placeholder: 'var:体力 / item:鍵', onChange: (v) => set('barValue', v.trim() || 'hp', 'ゲージの値を変更', false) });
    const src = new Select({
      options: BAR_SOURCES,
      title: 'ゲージの値',
      testId: 'ui-bar-source',
      onChange: (v) => set('barValue', v === 'custom' ? 'var:値' : v, 'ゲージの値を変更', false),
    });
    const customRow = fieldRow('変数・持ち物', custom.el, { hint: 'var:名前 または item:名前' });
    kit.bind(() => {
      const v = cur()?.barValue ?? 'hp';
      const preset = BAR_SOURCES.some((b) => b.value === v) ? v : 'custom';
      src.set(preset);
      customRow.hidden = preset !== 'custom';
      custom.set(v);
    });
    const max = new NumberField({ step: 1, min: 0, title: '最大値', testId: 'ui-bar-max', onChange: (v) => set('barMax', v, 'ゲージの最大値を変更') });
    kit.bind(() => max.set(cur()?.barMax ?? 0));
    rows.push(fieldRow('表示する値', src.el), customRow, fieldRow('最大値', max.el, { hint: '0 = 自動 (最大 HP など)' }));
  }
  if (type === 'button') {
    const action = new Select({ options: ACTIONS, title: '押したときの動作', testId: 'ui-action', onChange: (v) => set('action', v, 'ボタンの動作を変更', false) });
    kit.bind(() => action.set(cur()?.action ?? 'none'));
    rows.push(fieldRow('押したとき', action.el));
  }

  // 配置
  const grid = h('div', { class: 'anchor-grid', attrs: { role: 'radiogroup', 'aria-label': '画面上の位置' } });
  const anchorBtns = ANCHORS.map((a) => {
    const b = h('button', {
      class: 'anchor-cell',
      attrs: { type: 'button', title: a.label, 'aria-label': a.label, 'data-testid': `ui-anchor-${a.value}` },
      on: { click: () => set('anchor', a.value, '配置を変更', false) },
    });
    grid.appendChild(b);
    return { a, b };
  });
  kit.bind(() => {
    const v = cur()?.anchor;
    for (const { a, b } of anchorBtns) b.classList.toggle('active', a.value === v);
  });
  const x = new NumberField({ step: 1, title: '横のずれ', testId: 'ui-x', onChange: (v) => set('x', v, '位置を変更') });
  const y = new NumberField({ step: 1, title: '縦のずれ', testId: 'ui-y', onChange: (v) => set('y', v, '位置を変更') });
  kit.bind(() => {
    x.set(cur()?.x ?? 0);
    y.set(cur()?.y ?? 0);
  });
  const w = new NumberField({ step: 1, min: 0, title: '幅', testId: 'ui-width', onChange: (v) => set('width', v, '大きさを変更') });
  const hgt = new NumberField({ step: 1, min: 0, title: '高さ', testId: 'ui-height', onChange: (v) => set('height', v, '大きさを変更') });
  kit.bind(() => {
    w.set(cur()?.width ?? 0);
    hgt.set(cur()?.height ?? 0);
  });
  rows.push(
    fieldRow('画面上の位置', grid, { hint: '基準の場所' }),
    fieldRow('ずれ (横 / 縦)', h('div', { class: 'inline two' }, x.el, y.el), { hint: 'px' }),
    fieldRow('幅 / 高さ', h('div', { class: 'inline two' }, w.el, hgt.el), { hint: '0 = 自動' }),
  );

  // 見た目
  if (type !== 'image') {
    const color = new ColorField({ title: type === 'bar' ? 'ゲージの色' : '文字の色', testId: 'ui-color', onChange: (v) => set('color', v, '色を変更') });
    kit.bind(() => color.set(cur()?.color ?? '#ffffff'));
    rows.push(fieldRow(type === 'bar' ? 'ゲージの色' : '文字の色', color.el));
  }
  if (type === 'text' || type === 'button') {
    const size = new NumberField({ step: 1, min: 4, max: 200, title: '文字の大きさ', testId: 'ui-font-size', onChange: (v) => set('fontSize', v, '文字の大きさを変更') });
    kit.bind(() => size.set(cur()?.fontSize ?? 20));
    rows.push(fieldRow('文字の大きさ', size.el, { hint: 'px' }));
  }
  if (type !== 'image') {
    const bg = new ColorField({ title: '背景の色', testId: 'ui-bg', onChange: (v) => set('background', v, '背景の色を変更') });
    kit.bind(() => bg.set(cur()?.background ?? '#000000'));
    const op = new Slider({ min: 0, max: 1, step: 0.05, title: '背景の濃さ', testId: 'ui-bg-opacity', onChange: (v) => set('backgroundOpacity', v, '背景の濃さを変更') });
    kit.bind(() => op.set(cur()?.backgroundOpacity ?? 0));
    rows.push(fieldRow('背景の色', bg.el), fieldRow('背景の濃さ', op.el, { hint: '0 = 透明' }));
  }
  const radius = new NumberField({ step: 1, min: 0, max: 200, title: '角の丸み', testId: 'ui-radius', onChange: (v) => set('radius', v, '角の丸みを変更') });
  kit.bind(() => radius.set(cur()?.radius ?? 0));
  rows.push(fieldRow('角の丸み', radius.el, { hint: 'px' }));

  return kit.section('画面の UI', 'font', rows, { testId: 'sec-ui' });
}

// ------------------------------------------------------------------
// シーン: BGM
// ------------------------------------------------------------------

export function musicSection(kit: InspectorKit): HTMLElement {
  const ed = kit.ctx.editor;
  const field = soundField(kit, {
    kind: 'music',
    title: 'BGM (音楽)',
    testId: 'scene-music',
    get: () => ed.sceneData.music.source,
    set: (v) => A.setMusic(ed, { source: v }, v ? 'BGM を設定' : 'BGM を外す'),
  });
  const vol = new Slider({ min: 0, max: 1, step: 0.05, title: 'BGM の音量', testId: 'scene-music-volume', onChange: (v) => A.setMusic(ed, { volume: v }, 'BGM の音量を変更', 'volume') });
  kit.bind(() => vol.set(ed.sceneData.music.volume));
  return kit.section('BGM (音楽)', 'music', [fieldRow('音楽', field), fieldRow('音量', vol.el)], { collapsed: true, testId: 'sec-music' });
}

// ------------------------------------------------------------------
// プロジェクト: ゲーム設定
// ------------------------------------------------------------------

export function gameSettingsSection(kit: InspectorKit): HTMLElement {
  const ed = kit.ctx.editor;
  const g = () => ed.project.game;
  const set = (patch: Partial<GameSettings>, label: string, key?: string) => A.setGameSettings(ed, patch, label, key);

  const title = new TextField({ title: 'ゲームのタイトル', testId: 'gs-title', maxLength: 60, onChange: (v) => set({ title: v }, 'タイトルを変更') });
  kit.bind(() => title.set(g().title));
  const subtitle = new TextField({ title: 'サブタイトル', testId: 'gs-subtitle', maxLength: 100, onChange: (v) => set({ subtitle: v }, 'サブタイトルを変更') });
  kit.bind(() => subtitle.set(g().subtitle));
  const bg = new ColorField({ title: 'タイトル画面の色', testId: 'gs-title-bg', onChange: (v) => set({ titleBackground: v }, 'タイトル画面の色を変更', 'titleBg') });
  kit.bind(() => bg.set(g().titleBackground));
  const image = imageField(kit, { title: 'タイトル画像', testId: 'gs-title-image', get: () => g().titleImage, set: (v) => set({ titleImage: v }, 'タイトル画像を変更') });
  const limit = new NumberField({ step: 5, min: 0, max: 86400, title: '制限時間 (秒)', testId: 'gs-time-limit', onChange: (v) => set({ timeLimit: Math.max(0, v) }, '制限時間を変更', 'limit') });
  kit.bind(() => limit.set(g().timeLimit));
  const result = new Select<'gameover' | 'clear'>({
    options: [
      { value: 'gameover', label: 'ゲームオーバー' },
      { value: 'clear', label: 'クリア (時間まで生き残る)' },
    ],
    title: '時間切れのとき',
    testId: 'gs-time-up',
    onChange: (v) => set({ timeUpResult: v }, '時間切れの結果を変更'),
  });
  kit.bind(() => result.set(g().timeUpResult));
  const hud = new Toggle({ title: 'HUD を表示', testId: 'gs-show-hud', onChange: (v) => set({ showHud: v }, v ? 'HUD を表示' : 'HUD を非表示') });
  kit.bind(() => hud.set(g().showHud));
  const clearMsg = new TextField({ title: 'クリアのメッセージ', testId: 'gs-clear-message', onChange: (v) => set({ clearMessage: v }, 'メッセージを変更') });
  kit.bind(() => clearMsg.set(g().clearMessage));
  const overMsg = new TextField({ title: 'ゲームオーバーのメッセージ', testId: 'gs-over-message', onChange: (v) => set({ gameOverMessage: v }, 'メッセージを変更') });
  kit.bind(() => overMsg.set(g().gameOverMessage));
  const fromTitle = new Toggle({ title: 'タイトル画面から Play', testId: 'play-from-title', onChange: (v) => ed.updateSettings({ playFromTitle: v }) });
  kit.bind(() => fromTitle.set(ed.settings.playFromTitle));
  const clearSave = button({
    icon: 'trash',
    label: 'セーブデータを消す',
    class: 'secondary small',
    testId: 'gs-clear-save',
    onClick: () => {
      void confirmDialog('この端末に保存された「つづきから」のデータを消します。', { title: 'セーブデータを消しますか？', okLabel: '消す', danger: true }).then((ok) => {
        if (!ok) return;
        try {
          localStorage.removeItem(`pocket-engine:save:${ed.project.id}`);
          toast('セーブデータを消しました', 'success', 1500);
        } catch {
          toast('セーブデータを消せませんでした', 'error');
        }
      });
    },
  });

  return kit.section(
    'ゲーム設定',
    'gamepad',
    [
      fieldRow('タイトル', title.el),
      fieldRow('サブタイトル', subtitle.el),
      fieldRow('タイトル画面の色', bg.el),
      fieldRow('タイトル画像', image),
      fieldRow('制限時間', limit.el, { hint: '秒 (0 = なし)' }),
      fieldRow('時間切れのとき', result.el),
      fieldRow('HUD を表示', hud.el, { hint: 'HP・スコアなど' }),
      fieldRow('クリアの文字', clearMsg.el),
      fieldRow('ゲームオーバーの文字', overMsg.el),
      fieldRow('タイトルから Play', fromTitle.el, { hint: 'Play でタイトル画面を表示' }),
      h('div', { class: 'button-row' }, clearSave),
    ],
    { collapsed: true, testId: 'sec-game' },
  );
}
