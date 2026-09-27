import * as A from '../../core/actions';
import type { EventBlock } from '../../core/events';
import { createBlock, getBlockDef, summarize } from '../../core/events';
import { cameraAt, clampTime, createTimeline, createTimelineItem, lastItemTime, sortedItems } from '../../core/timeline';
import type { TimelineData } from '../../core/types';
import { clone, createId } from '../../core/util';
import type { AppContext } from '../context';
import { button, h } from '../dom';
import { icon } from '../icons';
import { confirmDialog, toast } from '../overlays';
import { fieldRow, NumberField, TextField, Toggle } from '../widgets';
import type { EventsPanel } from './EventsPanel';

/**
 * イベントタブの「タイムライン」: カットシーンの一覧と編集。
 * 時刻の目盛りの上に動作 (カメラの切り替え・会話・移動など) を並べ、スライダーで時刻を動かすと
 * カメラの切り替えを 3D ビューで確かめられる。
 */
export class TimelineView {
  /** 編集中のタイムライン */
  private openId: string | null = null;
  /** プレビューの時刻 */
  private time = 0;
  private playing = 0;
  private container: HTMLElement | null = null;

  constructor(
    private ctx: AppContext,
    private panel: EventsPanel,
  ) {}

  private get list(): TimelineData[] {
    return this.ctx.editor.sceneData.timelines;
  }

  private commit(list: TimelineData[], label: string, mergeKey?: string): void {
    A.setTimelines(this.ctx.editor, list, label, mergeKey);
  }

  private update(id: string, fn: (t: TimelineData) => void, label: string, mergeKey?: string): void {
    const list = clone(this.list);
    const t = list.find((x) => x.id === id);
    if (!t) return;
    fn(t);
    this.commit(list, label, mergeKey);
  }

  /** タブを離れるとき (プレビューをやめる) */
  leave(): void {
    this.stopPreview();
    this.ctx.viewport.setPreviewCamera(null);
  }

  render(container: HTMLElement): void {
    this.container = container;
    const tl = this.openId ? this.list.find((t) => t.id === this.openId) : undefined;
    if (!tl) {
      this.openId = null;
      this.renderList(container);
    } else {
      this.renderEditor(container, tl);
    }
  }

  private rerender(): void {
    if (this.container) this.render(this.container);
  }

  // ------------------------------------------------------------------
  // 一覧
  // ------------------------------------------------------------------

  private renderList(container: HTMLElement): void {
    const list = this.list;
    const intro = h(
      'div',
      { class: 'panel-intro' },
      h('b', { text: 'タイムライン (カットシーン)' }),
      h('span', { text: '決まった時刻にカメラの切り替え・会話・移動などを順に実行します。オープニングやボス登場の演出に' }),
    );
    const add = button({
      icon: 'plus',
      label: 'タイムラインを追加',
      class: 'primary',
      testId: 'tl-add',
      onClick: () => {
        const t = createTimeline(`タイムライン${list.length + 1}`);
        this.commit([...clone(list), t], 'タイムラインを追加');
        this.open(t.id);
      },
    });
    const cards = list.map((t, i) =>
      h(
        'button',
        { class: 'tl-card', attrs: { type: 'button', 'data-testid': `tl-card-${i}` }, on: { click: () => this.open(t.id) } },
        h('span', { class: 'tl-card-icon', html: icon('film', 22) }),
        h('span', { class: 'tl-card-name', text: t.name }),
        h('span', { class: 'tl-card-sub', text: `${t.duration} 秒 ・ 動作 ${t.items.length}${t.autoplay ? ' ・ 自動で再生' : ''}` }),
      ),
    );
    container.replaceChildren(
      intro,
      h('div', { class: 'button-row' }, add),
      ...(cards.length
        ? cards
        : [
            h(
              'div',
              { class: 'hint-card' },
              h('span', { html: icon('film', 22) }),
              h('p', { text: '例: 0 秒「カメラ1 に切り替える」→ 2 秒「会話: ようこそ！」→ 5 秒「カメラをふだんの視点に戻す」。イベントの「タイムラインを再生」や「自動で再生」で始まります。' }),
            ),
          ]),
    );
  }

  /** 指定したタイムラインの編集画面を開く */
  open(id: string): void {
    this.openId = id;
    this.time = 0;
    this.rerender();
  }

  // ------------------------------------------------------------------
  // 編集
  // ------------------------------------------------------------------

  private renderEditor(container: HTMLElement, tl: TimelineData): void {
    const id = tl.id;
    const sc = this.panel.summaryCtx;
    const name = new TextField({ title: '名前', testId: 'tl-name', maxLength: 60, onChange: (v) => v.trim() && this.update(id, (t) => (t.name = v.trim()), '名前を変更') });
    name.set(tl.name);
    const duration = new NumberField({
      step: 0.5,
      min: 0.5,
      max: 600,
      title: '長さ (秒)',
      testId: 'tl-duration',
      onChange: (v) => this.update(id, (t) => (t.duration = Math.max(0.5, Math.min(600, v))), '長さを変更', 'duration'),
    });
    duration.set(tl.duration);
    const toggle = (key: 'autoplay' | 'lockPlayer' | 'skippable' | 'restoreCamera', title: string, testId: string) => {
      const t = new Toggle({ title, testId, onChange: (v) => this.update(id, (x) => (x[key] = v), `${title}を変更`) });
      t.set(tl[key]);
      return t.el;
    };

    // 目盛りと動作の印
    const track = h('div', { class: 'tl-track', attrs: { 'data-testid': 'tl-track' } });
    const dur = Math.max(0.5, tl.duration);
    const step = dur <= 10 ? 1 : dur <= 30 ? 5 : dur <= 120 ? 10 : 30;
    for (let s = 0; s <= dur + 1e-6; s += step) {
      track.appendChild(h('span', { class: 'tl-tick', style: `left:${(s / dur) * 100}%`, text: `${s}` }));
    }
    const items = sortedItems(tl);
    items.forEach((it, i) => {
      const def = getBlockDef('action', it.action.type);
      track.appendChild(
        h('button', {
          class: `tl-marker${it.action.type === 'camera' ? ' camera' : ''}`,
          style: `left:${Math.min(100, (it.time / dur) * 100)}%`,
          attrs: { type: 'button', title: `${it.time}秒 ${summarize('action', it.action, sc)}`, 'data-testid': `tl-marker-${i}` },
          html: icon(def?.icon ?? 'help', 12),
          on: { click: () => this.editItem(id, it.id) },
        }),
      );
    });
    const head = h('span', { class: 'tl-playhead', style: `left:${(Math.min(this.time, dur) / dur) * 100}%` });
    track.appendChild(head);

    // 時刻のスライダー (カメラの切り替えを 3D ビューでプレビュー)
    const scrub = h('input', { class: 'range', attrs: { type: 'range', min: 0, max: dur, step: 0.05, value: String(Math.min(this.time, dur)), 'aria-label': '時刻', 'data-testid': 'tl-scrub' } });
    const timeLabel = h('span', { class: 'tl-time', attrs: { 'data-testid': 'tl-time' } });
    const setTime = (t: number) => {
      this.time = Math.max(0, Math.min(dur, t));
      scrub.value = String(this.time);
      head.style.left = `${(this.time / dur) * 100}%`;
      timeLabel.textContent = `${this.time.toFixed(1)} 秒`;
      const cam = cameraAt(tl, this.time);
      this.ctx.viewport.setPreviewCamera(cam && cam !== 'player' ? cam : null);
    };
    scrub.addEventListener('input', () => {
      this.stopPreview();
      setTime(Number(scrub.value));
    });
    timeLabel.textContent = `${this.time.toFixed(1)} 秒`;
    const playBtn = button({
      icon: 'play',
      title: 'プレビュー再生 (カメラの切り替え)',
      class: 'icon-btn small secondary',
      testId: 'tl-play',
      onClick: () => {
        if (this.playing) {
          this.stopPreview();
          return;
        }
        let last = performance.now();
        if (this.time >= dur) setTime(0);
        const tick = (now: number) => {
          setTime(this.time + (now - last) / 1000);
          last = now;
          if (this.time >= dur) {
            this.playing = 0;
            return;
          }
          this.playing = requestAnimationFrame(tick);
        };
        this.playing = requestAnimationFrame(tick);
      },
    });

    // 動作の一覧
    const rows = items.map((it, i) => {
      const def = getBlockDef('action', it.action.type);
      return h(
        'button',
        { class: 'tl-item', attrs: { type: 'button', 'data-testid': `tl-item-${i}` }, on: { click: () => this.editItem(id, it.id) } },
        h('span', { class: 'tl-item-time', text: `${it.time.toFixed(1)}秒` }),
        h('span', { class: 'tl-item-icon', html: icon(def?.icon ?? 'help', 16) }),
        h('span', { class: 'tl-item-text', text: summarize('action', it.action, sc) }),
      );
    });

    container.replaceChildren(
      h(
        'div',
        { class: 'tl-editor-head' },
        button({
          icon: 'chevronLeft',
          label: '一覧',
          class: 'secondary small',
          testId: 'tl-back',
          onClick: () => {
            this.leave();
            this.openId = null;
            this.rerender();
          },
        }),
        h('b', { text: tl.name }),
      ),
      fieldRow('名前', name.el),
      fieldRow('長さ', duration.el, { hint: '秒' }),
      h('div', { class: 'tl-track-wrap' }, track),
      h('div', { class: 'tl-scrub-row' }, playBtn, scrub, timeLabel),
      h('p', { class: 'field-note', text: 'スライダーを動かすと、カメラの切り替えを 3D ビューで確かめられます。' }),
      h('div', { class: 'tl-items', attrs: { 'data-testid': 'tl-items' } }, ...(rows.length ? rows : [h('div', { class: 'ev-none', text: '(動作はまだありません)' })])),
      h(
        'div',
        { class: 'button-row' },
        button({ icon: 'plus', label: '動作を追加', class: 'primary', testId: 'tl-add-item', onClick: () => this.addItem(id) }),
        button({ icon: 'camera', label: 'カメラを追加', class: 'secondary', testId: 'tl-add-camera', onClick: () => this.addCameraItem(id) }),
      ),
      fieldRow('自動で再生', toggle('autoplay', '自動で再生', 'tl-autoplay'), { hint: 'ゲームが始まったとき' }),
      fieldRow('プレイヤーを止める', toggle('lockPlayer', 'プレイヤーを止める', 'tl-lock'), { hint: '再生中は操作できない' }),
      fieldRow('スキップできる', toggle('skippable', 'スキップできる', 'tl-skip')),
      fieldRow('終わったらカメラを戻す', toggle('restoreCamera', '終わったらカメラを戻す', 'tl-restore')),
      h(
        'div',
        { class: 'button-row' },
        button({
          icon: 'duplicate',
          label: '複製',
          class: 'secondary small',
          testId: 'tl-duplicate',
          onClick: () => {
            const copy = { ...clone(tl), id: createId('tl'), name: `${tl.name} コピー`, autoplay: false };
            this.commit([...clone(this.list), copy], 'タイムラインを複製');
            this.open(copy.id);
          },
        }),
        button({
          icon: 'trash',
          label: '削除',
          class: 'danger-outline small',
          testId: 'tl-delete',
          onClick: () => {
            void confirmDialog(`タイムライン「${tl.name}」を削除しますか？`, { title: 'タイムラインを削除', okLabel: '削除', danger: true }).then((ok) => {
              if (!ok) return;
              this.leave();
              this.openId = null;
              this.commit(
                this.list.filter((t) => t.id !== id),
                'タイムラインを削除',
              );
            });
          },
        }),
      ),
    );
  }

  private stopPreview(): void {
    if (this.playing) cancelAnimationFrame(this.playing);
    this.playing = 0;
  }

  /** 時刻の入力欄 (動作のフォームの先頭に出す) */
  private timeField(initial: number): { el: HTMLElement; get(): number } {
    let value = clampTime(initial);
    const f = new NumberField({ step: 0.1, min: 0, max: 600, title: '時刻 (秒)', testId: 'tl-item-time', onChange: (v) => (value = clampTime(v)) });
    f.set(value);
    return { el: fieldRow('実行する時刻', f.el, { hint: '秒' }), get: () => value };
  }

  private addItem(id: string): void {
    this.panel.pickType('action', (def) => {
      const t = this.timeField(this.time);
      const push = (b: EventBlock) => {
        this.update(id, (x) => x.items.push(createTimelineItem(t.get(), b)), '動作を追加');
        this.growIfNeeded(id);
      };
      this.panel.openForm('action', createBlock('action', def.type), { onOk: push, extra: [t.el], title: 'タイムラインの動作' });
    });
  }

  /** よく使う「カメラを切り替える」をすぐに足す */
  private addCameraItem(id: string): void {
    const t = this.timeField(this.time);
    const cams = Object.values(this.ctx.editor.sceneData.entities).filter((e) => e.kind === 'camera');
    if (cams.length === 0) toast('シーンにカメラがありません。「追加」→「カメラ」で置いてください', 'warn', 2500);
    const block = createBlock('action', 'camera', { target: cams[0]?.id ?? '' });
    this.panel.openForm('action', block, {
      onOk: (b) => {
        this.update(id, (x) => x.items.push(createTimelineItem(t.get(), b)), 'カメラの切り替えを追加');
        this.growIfNeeded(id);
      },
      extra: [t.el],
      title: 'カメラを切り替える',
    });
  }

  private editItem(id: string, itemId: string): void {
    const tl = this.list.find((x) => x.id === id);
    const item = tl?.items.find((x) => x.id === itemId);
    if (!tl || !item) return;
    const t = this.timeField(item.time);
    this.panel.openForm('action', item.action, {
      onOk: (b) => {
        this.update(
          id,
          (x) => {
            const it = x.items.find((y) => y.id === itemId);
            if (it) {
              it.action = b;
              it.time = t.get();
            }
          },
          '動作を変更',
        );
        this.growIfNeeded(id);
      },
      onDelete: () => this.update(id, (x) => (x.items = x.items.filter((y) => y.id !== itemId)), '動作を削除'),
      allowTypeChange: true,
      extra: [t.el],
      title: 'タイムラインの動作',
    });
  }

  /** 動作が長さを超えたら長さを伸ばす */
  private growIfNeeded(id: string): void {
    const tl = this.list.find((x) => x.id === id);
    if (!tl) return;
    const need = Math.ceil(lastItemTime(tl) + 1);
    if (need > tl.duration) this.update(id, (x) => (x.duration = need), '長さを変更', 'duration');
  }
}
