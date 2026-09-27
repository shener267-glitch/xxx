import * as A from '../../core/actions';
import type { AnimClip, AnimEasing, AnimLoop, AnimPreset } from '../../core/animation';
import { ANIM_PRESETS, clipTime, emptyClip, LOOP_LABELS, normalizeKeys, presetClip, sampleClip, sanitizeClips } from '../../core/animation';
import type { TransformData } from '../../core/types';
import { clone } from '../../core/util';
import { button, h } from '../dom';
import { actionSheet, confirmDialog, promptDialog, toast } from '../overlays';
import { fieldRow, NumberField, Select, Toggle } from '../widgets';
import type { InspectorKit } from './gameInspector';

/**
 * 「アニメーション」コンポーネントの編集欄。
 * - アニメーション (クリップ) の追加 (空 / プリセット)・名前変更・削除・自動再生
 * - 長さ・くり返し・動き方
 * - タイムライン: スライダーで時刻を選ぶと 3D ビューにその時刻の姿勢を表示
 * - 「今の姿勢を記録」: オブジェクトを動かしてから押すと、その時刻のキーになる
 * - プレビュー再生
 */

/** コンポーネントごとに選択中のクリップと時刻を覚えておく (再構築しても保つ) */
const uiState = new Map<string, { clipId: string | null; time: number }>();

export function clipsEditor(kit: InspectorKit, entityId: string, compId: string): HTMLElement {
  const ed = kit.ctx.editor;
  const vp = kit.ctx.viewport;
  const state = uiState.get(compId) ?? { clipId: null, time: 0 };
  uiState.set(compId, state);
  const comp = () => ed.scene.get(entityId)?.components.find((c) => c.id === compId);
  const clips = (): AnimClip[] => sanitizeClips(comp()?.props.clips);
  const autoplay = () => {
    const v = comp()?.props.autoplay;
    return typeof v === 'string' ? v : '';
  };
  const current = () => {
    const list = clips();
    return list.find((c) => c.id === state.clipId) ?? list[0] ?? null;
  };
  const baseTransform = (): TransformData => clone(ed.scene.get(entityId)!.transform);
  const saveClips = (list: AnimClip[], label: string) => A.setComponentProp(ed, entityId, compId, 'clips', list, false, label);
  const updateClip = (fn: (c: AnimClip) => void, label: string) => {
    const list = clips();
    const c = list.find((x) => x.id === current()?.id);
    if (!c) return;
    fn(c);
    c.keys = normalizeKeys(c.keys);
    saveClips(list, label);
  };

  const root = h('div', { class: 'anim-editor', attrs: { 'data-testid': 'anim-editor' } });

  // ---- 再生プレビュー ----
  let raf = 0;
  let playStart = 0;
  const stopPreview = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    playBtn.classList.remove('active');
    vp.previewPose(entityId, null);
  };
  const startPreview = () => {
    const c = current();
    if (!c || c.keys.length === 0) return;
    playStart = performance.now();
    playBtn.classList.add('active');
    const step = (now: number) => {
      const el = (now - playStart) / 1000;
      const pose = sampleClip(c, clipTime(c, el));
      if (pose) vp.previewPose(entityId, pose);
      // くり返しは 2 周まで、1回だけのものは最後まで再生して止める
      const limit = c.loop === 'once' ? c.duration + 0.4 : c.duration * 2;
      if (el < limit) raf = requestAnimationFrame(step);
      else stopPreview();
    };
    raf = requestAnimationFrame(step);
  };

  // ---- 部品 ----
  const clipSelect = h('select', { class: 'select', attrs: { 'aria-label': 'アニメーション', 'data-testid': 'anim-clip' } });
  clipSelect.addEventListener('change', () => {
    state.clipId = clipSelect.value;
    state.time = 0;
    stopPreview();
    refresh();
  });
  const addBtn = button({
    icon: 'plus',
    title: 'アニメーションを追加',
    class: 'icon-btn small secondary',
    testId: 'anim-add',
    onClick: () => {
      const base = baseTransform();
      const names = clips().map((c) => c.name);
      const unique = (n: string) => {
        let name = n;
        let i = 2;
        while (names.includes(name)) name = `${n} ${i++}`;
        return name;
      };
      actionSheet('アニメーションを追加', [
        {
          label: '空のアニメーション (自分で記録)',
          icon: 'film',
          testId: 'anim-add-empty',
          onSelect: () => {
            const c = emptyClip(unique('アニメ'), base);
            state.clipId = c.id;
            state.time = 0;
            saveClips([...clips(), c], 'アニメーションを追加');
          },
        },
        'separator',
        ...ANIM_PRESETS.map((p) => ({
          label: p.label,
          icon: 'sparkles',
          hint: 'プリセット',
          testId: `anim-add-${p.id}`,
          onSelect: () => {
            const c = presetClip(p.id as AnimPreset, base, unique(p.label));
            state.clipId = c.id;
            state.time = 0;
            const list = [...clips(), c];
            saveClips(list, 'アニメーションを追加');
            // 最初のアニメーションは自動再生にしておく
            if (list.length === 1) A.setComponentProp(ed, entityId, compId, 'autoplay', c.name, false, '自動再生を設定');
          },
        })),
      ]);
    },
  });
  const renameBtn = button({
    icon: 'edit',
    title: '名前を変更',
    class: 'icon-btn small secondary',
    testId: 'anim-rename',
    onClick: () => {
      const c = current();
      if (!c) return;
      void promptDialog('アニメーションの名前', c.name, { okLabel: '変更', maxLength: 60 }).then((name) => {
        const n = name?.trim();
        if (!n || n === c.name) return;
        if (clips().some((x) => x.name === n)) {
          toast('同じ名前のアニメーションがあります', 'warn');
          return;
        }
        const wasAuto = autoplay() === c.name;
        updateClip((x) => (x.name = n), 'アニメーション名を変更');
        if (wasAuto) A.setComponentProp(ed, entityId, compId, 'autoplay', n, false, '自動再生を設定');
      });
    },
  });
  const deleteBtn = button({
    icon: 'trash',
    title: '削除',
    class: 'icon-btn small ghost',
    testId: 'anim-delete',
    onClick: () => {
      const c = current();
      if (!c) return;
      void confirmDialog(`アニメーション「${c.name}」を削除しますか？`, { title: '削除', okLabel: '削除', danger: true }).then((ok) => {
        if (!ok) return;
        stopPreview();
        saveClips(
          clips().filter((x) => x.id !== c.id),
          'アニメーションを削除',
        );
        state.clipId = null;
      });
    },
  });

  const auto = new Toggle({
    title: '自動再生',
    testId: 'anim-autoplay',
    onChange: (v) => A.setComponentProp(ed, entityId, compId, 'autoplay', v ? (current()?.name ?? '') : '', false, v ? '自動再生を設定' : '自動再生を解除'),
  });
  const duration = new NumberField({ step: 0.1, min: 0.05, max: 600, title: '長さ (秒)', testId: 'anim-duration', onChange: (v) => updateClip((c) => (c.duration = Math.max(0.05, v)), '長さを変更') });
  const loop = new Select<AnimLoop>({
    options: (Object.keys(LOOP_LABELS) as AnimLoop[]).map((k) => ({ value: k, label: LOOP_LABELS[k] })),
    title: 'くり返し',
    testId: 'anim-loop',
    onChange: (v) => updateClip((c) => (c.loop = v), 'くり返しを変更'),
  });
  const easing = new Select<AnimEasing>({
    options: [
      { value: 'smooth', label: 'なめらか' },
      { value: 'linear', label: '一定の速さ' },
    ],
    title: '動き方',
    testId: 'anim-easing',
    onChange: (v) => updateClip((c) => (c.easing = v), '動き方を変更'),
  });

  // タイムライン
  const timeLabel = h('span', { class: 'anim-time', attrs: { 'data-testid': 'anim-time' } });
  const slider = h('input', { class: 'range anim-slider', attrs: { type: 'range', min: 0, max: 1, step: 0.01, 'aria-label': '時刻', 'data-testid': 'anim-scrub' } });
  const marks = h('div', { class: 'anim-marks' });
  const showTime = (t: number, pose = true) => {
    const c = current();
    state.time = t;
    timeLabel.textContent = `${t.toFixed(2)} 秒`;
    if (pose && c) {
      const p = sampleClip(c, t);
      if (p) vp.previewPose(entityId, p);
    }
  };
  slider.addEventListener('input', () => {
    stopPreview();
    showTime(Number(slider.value));
  });
  const recordBtn = button({
    icon: 'target',
    label: '今の姿勢を記録',
    class: 'primary small',
    testId: 'anim-record',
    onClick: () => {
      const c = current();
      const pose = vp.displayedTransform(entityId);
      if (!c || !pose) return;
      const t = Math.min(c.duration, Math.max(0, state.time));
      updateClip((x) => {
        x.keys = x.keys.filter((k) => Math.abs(k.t - t) > 1e-3);
        x.keys.push({ t, ...pose });
      }, 'キーを記録');
      toast(`${t.toFixed(2)} 秒にキーを記録しました`, 'success', 1200);
    },
  });
  const playBtn = button({
    icon: 'play',
    label: 'プレビュー',
    class: 'secondary small',
    testId: 'anim-preview',
    onClick: () => (raf ? stopPreview() : startPreview()),
  });
  const keyList = h('div', { class: 'anim-keys', attrs: { 'data-testid': 'anim-keys' } });

  const body = h('div', { class: 'anim-body' });
  root.append(
    h('div', { class: 'inline anim-head' }, clipSelect, addBtn, renameBtn, deleteBtn),
    body,
    h('p', { class: 'field-note', text: '使い方: スライダーで時刻を選ぶ → 3D ビューでオブジェクトを動かす → 「今の姿勢を記録」。Play で再生されます。イベントの「アニメーションを再生」でも切り替えられます。' }),
  );

  const refresh = () => {
    const list = clips();
    const c = current();
    clipSelect.replaceChildren(...list.map((x) => h('option', { text: autoplay() === x.name ? `${x.name} (自動再生)` : x.name, props: { value: x.id } })));
    if (list.length === 0) clipSelect.appendChild(h('option', { text: '(アニメーションなし)', props: { value: '' } }));
    clipSelect.value = c?.id ?? '';
    renameBtn.disabled = !c;
    deleteBtn.disabled = !c;
    body.hidden = !c;
    if (!c) return;
    state.clipId = c.id;
    auto.set(autoplay() === c.name);
    duration.set(c.duration);
    loop.set(c.loop);
    easing.set(c.easing);
    slider.max = String(c.duration);
    slider.value = String(Math.min(state.time, c.duration));
    timeLabel.textContent = `${Math.min(state.time, c.duration).toFixed(2)} 秒`;
    marks.replaceChildren(...c.keys.map((k) => h('span', { class: 'anim-mark', attrs: { style: `left:${(k.t / Math.max(0.01, c.duration)) * 100}%` } })));
    keyList.replaceChildren(
      ...c.keys.map((k, i) =>
        h(
          'div',
          { class: 'anim-key' },
          h('button', {
            class: 'anim-key-time',
            text: `${k.t.toFixed(2)} 秒`,
            attrs: { type: 'button', 'data-testid': `anim-key-${i}` },
            on: {
              click: () => {
                stopPreview();
                slider.value = String(k.t);
                showTime(k.t);
              },
            },
          }),
          h('span', { class: 'anim-key-info', text: `位置 ${k.p.map((v) => v.toFixed(1)).join(', ')}` }),
          button({
            icon: 'trash',
            title: 'キーを削除',
            class: 'icon-btn small ghost',
            onClick: () => updateClip((x) => x.keys.splice(i, 1), 'キーを削除'),
          }),
        ),
      ),
    );
  };
  kit.bind(refresh);

  body.append(
    fieldRow('自動再生', auto.el, { hint: 'Play で最初から再生' }),
    fieldRow('長さ', duration.el, { hint: '秒' }),
    fieldRow('くり返し', loop.el),
    fieldRow('動き方', easing.el),
    h('div', { class: 'anim-timeline' }, h('div', { class: 'anim-track' }, marks, slider), timeLabel),
    h('div', { class: 'button-row' }, recordBtn, playBtn),
    keyList,
  );
  return root;
}
