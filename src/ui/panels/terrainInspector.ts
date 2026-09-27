import * as A from '../../core/actions';
import type { GenerateOptions, TerrainGenerator } from '../../core/terrain';
import { DEFAULT_GENERATE, generateHeights, heightRange, resampleHeights, TERRAIN_GENERATORS, TERRAIN_RESOLUTIONS } from '../../core/terrain';
import type { EntityData, TerrainData } from '../../core/types';
import { button, h } from '../dom';
import { toast } from '../overlays';
import { ColorField, fieldRow, NumberField, Select, Toggle } from '../widgets';
import type { InspectorKit } from './gameInspector';

/**
 * Inspector の「地形」: ブラシ編集の開始・形の作り直し・大きさ・分割数・色。
 */

const lastGen: GenerateOptions = { ...DEFAULT_GENERATE };

export function terrainSection(kit: InspectorKit, e: EntityData): HTMLElement[] {
  const ctx = kit.ctx;
  const ed = ctx.editor;
  const id = e.id;
  const cur = () => ed.scene.get(id)?.terrain;
  const set = (path: string, v: unknown, label: string, merge = false) =>
    A.setEntityValue(ed, [id], `terrain.${path}`, v, { label, mergeKey: merge ? `terrain.${path}` : undefined });

  // ---- ブラシ ----
  const brushBtn = button({
    icon: 'edit',
    label: 'ブラシで形を変える',
    class: 'primary',
    testId: 'terrain-brush',
    onClick: () => {
      if (ctx.viewport.terrainBrush.start(id)) ctx.closeSheet();
    },
  });
  const range = h('span', { class: 'readonly-value', attrs: { 'data-testid': 'terrain-range' } });

  // ---- 作り直す ----
  const genType = new Select<TerrainGenerator>({ options: TERRAIN_GENERATORS, title: '形', testId: 'terrain-gen-type', onChange: (v) => (lastGen.type = v) });
  genType.set(lastGen.type);
  const genHeight = new NumberField({ step: 0.5, min: 0, max: 200, title: '高さ (m)', testId: 'terrain-gen-height', onChange: (v) => (lastGen.height = v) });
  genHeight.set(lastGen.height);
  const genRough = new NumberField({ step: 0.1, min: 0.2, max: 4, title: '起伏の細かさ', testId: 'terrain-gen-rough', onChange: (v) => (lastGen.roughness = v) });
  genRough.set(lastGen.roughness);
  const generate = (newSeed: boolean) => {
    const t = cur();
    if (!t) return;
    if (newSeed) lastGen.seed = (lastGen.seed % 9999) + 1;
    set('heights', generateHeights(t, lastGen), '地形を作り直す');
  };

  // ---- 大きさ・分割数 ----
  const size = new NumberField({ step: 1, min: 1, max: 2000, title: '一辺の長さ (m)', testId: 'terrain-size', onChange: (v) => set('size', Math.max(1, v), '地形の大きさを変更', true) });
  const res = new Select<string>({
    options: TERRAIN_RESOLUTIONS.map((n) => ({ value: String(n), label: `${n} × ${n}${n >= 96 ? ' (重い)' : ''}` })),
    title: '細かさ (分割数)',
    testId: 'terrain-res',
    onChange: (v) => {
      const t = cur();
      if (!t) return;
      const n = Number(v);
      A.updateEntities(
        ed,
        [id],
        (x) => {
          if (!x.terrain) return;
          x.terrain.heights = resampleHeights(x.terrain, n);
          x.terrain.resolution = n;
        },
        '地形の細かさを変更',
      );
    },
  });

  // ---- 色 ----
  const auto = new Toggle({ title: '高さで色を塗る', testId: 'terrain-autocolor', onChange: (v) => set('autoColor', v, '地形の色を変更') });
  const flat = new Toggle({ title: 'ローポリ風', testId: 'terrain-flat', onChange: (v) => set('flatShading', v, '地形の見た目を変更') });
  const colorKeys: [keyof TerrainData['colors'], string][] = [
    ['grass', '草'],
    ['sand', '砂'],
    ['rock', '岩 (急な斜面)'],
    ['snow', '雪'],
  ];
  const colorFields = colorKeys.map(
    ([k, label]) => [k, new ColorField({ title: label, testId: `terrain-color-${k}`, onChange: (v) => set(`colors.${k}`, v, '地形の色を変更') })] as const,
  );
  const sandLevel = new NumberField({ step: 0.1, min: -200, max: 200, title: '砂になる高さ (m)', testId: 'terrain-sand', onChange: (v) => set('sandLevel', v, '地形の色を変更', true) });
  const snowLevel = new NumberField({ step: 0.5, min: -200, max: 400, title: '雪になる高さ (m)', testId: 'terrain-snow', onChange: (v) => set('snowLevel', v, '地形の色を変更', true) });
  const autoRows = [
    ...colorFields.slice(1).map(([, f], i) => fieldRow(colorKeys[i + 1][1], f.el)),
    fieldRow('砂になる高さ', sandLevel.el, { hint: 'これより低い所 (m)' }),
    fieldRow('雪になる高さ', snowLevel.el, { hint: 'これより高い所 (m)' }),
  ];

  kit.bind(() => {
    const t = cur();
    if (!t) return;
    const r = heightRange(t);
    range.textContent = `${r.min.toFixed(1)} 〜 ${r.max.toFixed(1)} m`;
    size.set(t.size);
    res.set(String(t.resolution));
    auto.set(t.autoColor);
    flat.set(t.flatShading);
    for (const [k, f] of colorFields) f.set(t.colors[k]);
    sandLevel.set(t.sandLevel);
    snowLevel.set(t.snowLevel);
    for (const row of autoRows) row.hidden = !t.autoColor;
  });

  return [
    kit.section(
      '地形',
      'mountain',
      [
        h('p', { class: 'field-note', text: 'ブラシでなぞると山を盛ったり谷を掘ったりできます。2 本指でカメラを動かせます。' }),
        h('div', { class: 'button-row' }, brushBtn),
        fieldRow('高さの範囲', range),
        fieldRow('一辺の長さ', size.el, { hint: 'm' }),
        fieldRow('細かさ', res.el, { hint: '細かいほどなめらか (重くなる)' }),
      ],
      { testId: 'sec-terrain' },
    ),
    kit.section(
      '形を作り直す',
      'reset',
      [
        fieldRow('形', genType.el),
        fieldRow('高さ', genHeight.el, { hint: 'いちばん高い所 (m)' }),
        fieldRow('起伏の細かさ', genRough.el),
        h(
          'div',
          { class: 'button-row' },
          button({ icon: 'mountain', label: '作る', class: 'secondary small', testId: 'terrain-generate', onClick: () => generate(false) }),
          button({
            icon: 'reset',
            label: '別の形',
            class: 'secondary small',
            testId: 'terrain-reroll',
            onClick: () => {
              generate(true);
              toast('別の形にしました (元に戻すで戻せます)', 'info', 1400);
            },
          }),
        ),
      ],
      { collapsed: true, testId: 'sec-terrain-gen' },
    ),
    kit.section(
      '地形の色',
      'palette',
      [fieldRow('高さで色を塗る', auto.el, { hint: '低い所は砂・斜面は岩・高い所は雪' }), fieldRow(colorKeys[0][1], colorFields[0][1].el), ...autoRows, fieldRow('ローポリ風', flat.el)],
      { collapsed: true, testId: 'sec-terrain-color' },
    ),
  ];
}
