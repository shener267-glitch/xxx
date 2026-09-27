import { checkProject, countProblems } from '../core/diagnostics';
import type { Issue, IssueLevel } from '../core/diagnostics';
import { logger } from '../core/logger';
import type { LogEntry, LogLevel } from '../core/logger';
import { jsHeapMB, perfMonitor } from '../engine/PerfMonitor';
import type { AppContext } from './context';
import { button, h, rafThrottle } from './dom';
import { icon } from './icons';
import { addFromCatalog } from './menus';
import { toast } from './overlays';

/**
 * デバッグコンソール: ログ (エラーの発生場所から該当オブジェクトを選べる)・性能 (FPS・描画・メモリ)・
 * Play 中の道具 (シーン切り替え・カメラ・時刻・回復・やり直し)。
 * スマホでは画面の下半分、PC では右側に出る。
 */

export type ConsoleTab = 'log' | 'check' | 'perf' | 'tools';
type LevelFilter = 'all' | LogLevel;

const LEVEL_LABEL: Record<LogLevel, string> = { info: '情報', warn: '警告', error: 'エラー' };
const LEVEL_ICON: Record<LogLevel, string> = { info: 'info', warn: 'alert', error: 'alert' };
const ISSUE_LABEL: Record<IssueLevel, string> = { error: 'エラー', warn: '注意', info: 'お知らせ' };

function clock(t: number): string {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':');
}

export class DebugConsole {
  readonly el: HTMLElement;
  private opened = false;
  private tab: ConsoleTab = 'log';
  private level: LevelFilter = 'all';
  private query = '';
  private body: HTMLElement;
  private tabsEl: HTMLElement;
  private expanded = new Set<number>();
  private releasePerf: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private schedule = rafThrottle(() => this.render());

  constructor(private ctx: AppContext) {
    this.tabsEl = h('div', { class: 'console-tabs', attrs: { role: 'tablist' } });
    this.body = h('div', { class: 'console-body' });
    this.el = h(
      'section',
      { class: 'debug-console', attrs: { 'data-testid': 'console', 'aria-label': 'デバッグコンソール', hidden: '' } },
      h(
        'header',
        { class: 'console-header' },
        h('span', { class: 'console-title', html: `${icon('bug', 18)}<span>デバッグ</span>` }),
        this.tabsEl,
        button({ icon: 'x', title: '閉じる', class: 'icon-btn small ghost', testId: 'console-close', onClick: () => this.hide() }),
      ),
      this.body,
    );
    logger.subscribe((e) => {
      if (this.opened && this.tab === 'log') {
        this.schedule();
        // 開いている間に出たエラーは既読にする
        if (e.level === 'error') logger.markRead();
      }
      this.notify();
    });
    logger.onClear(() => {
      this.notify();
      if (this.opened) this.schedule();
    });
    ctx.editor.events.on('mode-changed', () => this.opened && this.schedule());
    for (const type of ['history-changed', 'scene-loaded', 'assets-changed'] as const) {
      ctx.editor.events.on(type, () => this.opened && this.tab === 'check' && this.schedule());
    }
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** エラー数の表示を更新するため */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  show(tab: ConsoleTab = this.tab, level?: LevelFilter): void {
    this.tab = tab;
    if (level) this.level = level;
    this.opened = true;
    this.el.hidden = false;
    document.body.classList.add('console-open');
    logger.markRead();
    this.render();
    this.notify();
  }

  hide(): void {
    this.opened = false;
    this.el.hidden = true;
    document.body.classList.remove('console-open');
    this.releasePerf?.();
    this.releasePerf = null;
    this.notify();
  }

  toggle(): void {
    if (this.opened) this.hide();
    else this.show();
  }

  // ------------------------------------------------------------------

  private render(): void {
    if (!this.opened) return;
    const tabs: [ConsoleTab, string][] = [
      ['log', 'ログ'],
      ['check', 'チェック'],
      ['perf', '性能'],
      ['tools', '道具'],
    ];
    const problems = countProblems(checkProject(this.ctx.editor.project));
    const dot = (id: ConsoleTab) => (id === 'log' && logger.entries.some((e) => e.level === 'error')) || (id === 'check' && problems.errors + problems.warnings > 0);
    this.tabsEl.replaceChildren(
      ...tabs.map(([id, label]) =>
        h('button', {
          class: `console-tab${this.tab === id ? ' active' : ''}`,
          text: dot(id) ? `${label} ●` : label,
          attrs: { type: 'button', role: 'tab', 'aria-selected': String(this.tab === id), 'data-testid': `console-tab-${id}` },
          on: {
            click: () => {
              this.tab = id;
              this.render();
            },
          },
        }),
      ),
    );
    if (this.tab !== 'perf') {
      this.releasePerf?.();
      this.releasePerf = null;
    }
    if (this.tab === 'log') this.renderLog();
    else if (this.tab === 'check') this.renderCheck();
    else if (this.tab === 'perf') this.renderPerf();
    else this.renderTools();
  }

  // ---- チェック (ゲームが思った通りに動かない原因になりやすい設定) ----

  private renderCheck(): void {
    const ed = this.ctx.editor;
    const issues = checkProject(ed.project);
    const c = countProblems(issues);
    const summary =
      issues.length === 0
        ? h('div', { class: 'check-ok', attrs: { 'data-testid': 'check-ok' } }, h('span', { html: icon('check', 20) }), h('span', { text: '問題は見つかりませんでした。Play で遊んでみましょう！' }))
        : h('div', { class: 'check-summary', attrs: { 'data-testid': 'check-summary' } }, `エラー ${c.errors} ・ 注意 ${c.warnings} ・ お知らせ ${c.infos}`);
    const list = h(
      'div',
      { class: 'check-list', attrs: { 'data-testid': 'check-list' } },
      issues.map((i) => this.issueRow(i)),
    );
    this.body.replaceChildren(
      summary,
      list,
      h('p', { class: 'field-note', text: 'すべてのシーンを調べています。「エラー」は直さないとその部分が動きません。「注意」は思った通りに動かない原因になりやすい設定です。' }),
    );
  }

  private issueRow(issue: Issue): HTMLElement {
    const ctx = this.ctx;
    const ed = ctx.editor;
    const openScene = () => {
      if (ctx.play.playing) ctx.play.stop();
      if (ed.sceneData.id !== issue.sceneId) ed.setActiveScene(issue.sceneId);
    };
    const actions: HTMLElement[] = [];
    if (issue.entityId) {
      actions.push(
        button({
          icon: 'target',
          label: '選ぶ',
          class: 'secondary small',
          testId: 'issue-select',
          onClick: () => {
            openScene();
            if (!ed.scene.get(issue.entityId!)) return;
            ed.select(issue.entityId!);
            this.hide();
            ctx.openTab('inspector', 'half');
          },
        }),
      );
    }
    if (issue.ruleId || issue.timelineId) {
      actions.push(
        button({
          icon: 'zap',
          label: issue.ruleId ? 'イベントを開く' : 'タイムラインを開く',
          class: 'secondary small',
          testId: 'issue-open-event',
          onClick: () => {
            openScene();
            this.hide();
            ctx.showRule(issue.ruleId ?? null, issue.timelineId);
          },
        }),
      );
    }
    if (issue.fix) {
      const fix = issue.fix;
      actions.push(
        button({
          icon: 'check',
          label: fix.label,
          class: 'primary small',
          testId: `issue-fix-${fix.kind}`,
          onClick: () => {
            openScene();
            if (addFromCatalog(ctx, fix.kind === 'add-player' ? 'game-player' : 'light-directional')) this.render();
          },
        }),
      );
    }
    const other = issue.sceneId !== ed.sceneData.id ? h('span', { class: 'issue-scene', text: `シーン「${issue.sceneName}」` }) : null;
    return h(
      'div',
      { class: `issue lv-${issue.level}`, attrs: { 'data-testid': 'issue', 'data-level': issue.level } },
      h(
        'div',
        { class: 'issue-head' },
        h('span', { class: 'issue-badge', text: ISSUE_LABEL[issue.level] }),
        h('b', { class: 'issue-title', text: issue.title }),
      ),
      other,
      h('p', { class: 'issue-detail', text: issue.detail }),
      actions.length ? h('div', { class: 'button-row' }, actions) : null,
    );
  }

  // ---- ログ ----

  private filtered(): LogEntry[] {
    const q = this.query.toLowerCase();
    return logger.entries.filter(
      (e) => (this.level === 'all' || e.level === this.level) && (!q || e.message.toLowerCase().includes(q) || (e.source ?? '').toLowerCase().includes(q)),
    );
  }

  private renderLog(): void {
    const counts = { error: 0, warn: 0, info: 0 };
    for (const e of logger.entries) counts[e.level]++;
    const chips = h(
      'div',
      { class: 'chip-row' },
      (['all', 'error', 'warn', 'info'] as LevelFilter[]).map((lv) =>
        h('button', {
          class: `chip${this.level === lv ? ' active' : ''}${lv === 'error' && counts.error ? ' has-error' : ''}`,
          text: lv === 'all' ? `すべて ${logger.entries.length}` : `${LEVEL_LABEL[lv]} ${counts[lv]}`,
          attrs: { type: 'button', 'data-testid': `console-level-${lv}`, 'aria-pressed': String(this.level === lv) },
          on: {
            click: () => {
              this.level = lv;
              this.render();
            },
          },
        }),
      ),
    );
    const search = h('input', {
      class: 'text-input small',
      attrs: { type: 'search', placeholder: 'ログを検索', 'aria-label': 'ログを検索', 'data-testid': 'console-search', value: this.query },
    });
    search.addEventListener('input', () => {
      this.query = search.value.trim();
      this.renderList(list);
    });
    const tools = h(
      'div',
      { class: 'console-tools' },
      search,
      button({
        icon: 'copy',
        title: 'ログをコピー',
        class: 'icon-btn small secondary',
        testId: 'console-copy',
        onClick: () => {
          const text = logger.toText(this.filtered());
          void navigator.clipboard?.writeText(text).then(
            () => toast('ログをコピーしました', 'success', 1200),
            () => toast('コピーできませんでした', 'warn', 1500),
          );
        },
      }),
      button({ icon: 'trash', title: 'ログを消す', class: 'icon-btn small secondary', testId: 'console-clear', onClick: () => logger.clear() }),
    );
    const list = h('div', { class: 'log-list', attrs: { 'data-testid': 'log-list', role: 'log' } });
    this.body.replaceChildren(chips, tools, list);
    this.renderList(list);
  }

  private renderList(list: HTMLElement): void {
    const items = this.filtered();
    if (items.length === 0) {
      list.replaceChildren(h('div', { class: 'empty-state small', text: logger.entries.length ? '条件に合うログはありません' : 'ログはまだありません' }));
      return;
    }
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.replaceChildren(...items.slice(-300).map((e) => this.row(e)));
    if (nearBottom || list.scrollTop === 0) list.scrollTop = list.scrollHeight;
  }

  private row(e: LogEntry): HTMLElement {
    const open = this.expanded.has(e.seq);
    const ed = this.ctx.editor;
    const target = e.entityId && ed.scene.get(e.entityId) ? e.entityId : null;
    const el = h(
      'div',
      { class: `log-row lv-${e.level}${open ? ' open' : ''}`, attrs: { 'data-testid': 'log-row', 'data-level': e.level } },
      h(
        'button',
        {
          class: 'log-head',
          attrs: { type: 'button', 'aria-expanded': String(open) },
          on: {
            click: () => {
              if (open) this.expanded.delete(e.seq);
              else this.expanded.add(e.seq);
              el.replaceWith(this.row(e));
            },
          },
        },
        h('span', { class: 'log-icon', html: icon(LEVEL_ICON[e.level], 14), attrs: { title: LEVEL_LABEL[e.level] } }),
        h('span', { class: 'log-time', text: clock(e.time) }),
        h('span', { class: 'log-msg', text: e.message }),
      ),
      e.source ? h('div', { class: 'log-source', text: `場所: ${e.source}` }) : null,
      e.hint ? h('div', { class: 'log-hint', attrs: { 'data-testid': 'log-hint' } }, h('b', { text: 'どうすれば直る？ ' }), e.hint) : null,
    );
    if (open) {
      if (e.detail) el.appendChild(h('pre', { class: 'log-detail', text: e.detail }));
      if (target) {
        el.appendChild(
          button({
            icon: 'target',
            label: 'このオブジェクトを選ぶ',
            class: 'secondary small',
            testId: 'log-select',
            onClick: () => {
              // Play 中なら止めてから選ぶ
              if (this.ctx.play.playing) this.ctx.play.stop();
              ed.select(target);
              ed.requestFocus([target]);
              this.hide();
              this.ctx.openTab('inspector', 'half');
            },
          }),
        );
      }
    }
    return el;
  }

  // ---- 性能 ----

  private renderPerf(): void {
    if (!this.releasePerf) {
      this.releasePerf = perfMonitor.acquire();
      const off = perfMonitor.onUpdate(() => {
        if (!this.opened || this.tab !== 'perf') {
          off();
          return;
        }
        this.updatePerf();
      });
    }
    const grid = h('div', { class: 'perf-grid', attrs: { 'data-testid': 'perf-grid' } });
    const graph = h('canvas', { class: 'perf-graph', attrs: { width: 300, height: 70, 'data-testid': 'perf-graph', 'aria-label': 'FPS のグラフ' } });
    this.body.replaceChildren(grid, graph, h('p', { class: 'field-note', text: 'FPS は 1 秒あたりの画面の更新回数です (60 前後が目安)。描画の回数・三角形が多いと重くなります。' }));
    this.updatePerf();
  }

  /** 表示する数値 (テストからも使う) */
  perfStats(): Record<string, string> {
    const engine = this.ctx.viewport.engine;
    const info = engine.renderer.info;
    const rt = this.ctx.play.runtime;
    const playing = this.ctx.play.playing && rt;
    const heap = jsHeapMB();
    const objects = playing ? rt!.objects.size : Object.keys(this.ctx.editor.sceneData.entities).length;
    return {
      fps: perfMonitor.fps ? String(perfMonitor.fps) : '—',
      frame: perfMonitor.frameMs ? `${perfMonitor.frameMs} ms` : '—',
      worst: perfMonitor.worstMs ? `${perfMonitor.worstMs} ms` : '—',
      draw: String(info.render.calls),
      tri: info.render.triangles.toLocaleString(),
      geo: String(info.memory.geometries),
      tex: String(info.memory.textures),
      mem: heap !== null ? `${heap} MB` : '取得できません',
      objects: String(objects),
      bodies: playing ? String(rt!.physics?.bodies.size ?? 0) : '—',
      size: `${Math.round(engine.width * engine.renderer.getPixelRatio())} × ${Math.round(engine.height * engine.renderer.getPixelRatio())}`,
      quality: { low: '低', medium: '中', high: '高' }[this.ctx.editor.settings.quality],
      post: engine.postActive ? 'あり' : 'なし',
    };
  }

  private updatePerf(): void {
    const grid = this.body.querySelector('.perf-grid');
    if (!grid) return;
    const s = this.perfStats();
    const items: [string, string, string][] = [
      ['fps', 'FPS', s.fps],
      ['frame', '1 フレームの時間', s.frame],
      ['worst', 'いちばん遅いフレーム', s.worst],
      ['draw', '描画の回数', s.draw],
      ['tri', '三角形', s.tri],
      ['geo', '形 (ジオメトリ)', s.geo],
      ['tex', 'テクスチャ', s.tex],
      ['mem', 'メモリ (JS)', s.mem],
      ['objects', 'オブジェクト', s.objects],
      ['bodies', '物理ボディ', s.bodies],
      ['size', '描画の解像度', s.size],
      ['quality', '画質', s.quality],
      ['post', '画面の効果', s.post],
    ];
    grid.replaceChildren(
      ...items.map(([key, label, value]) =>
        h('div', { class: `perf-item${key === 'fps' && Number(value) > 0 && Number(value) < 30 ? ' bad' : ''}` }, h('b', { text: value, attrs: { 'data-testid': `perf-${key}` } }), h('span', { text: label })),
      ),
    );
    const canvas = this.body.querySelector<HTMLCanvasElement>('.perf-graph');
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;
    const w = canvas.width;
    const hgt = canvas.height;
    g.clearRect(0, 0, w, hgt);
    g.strokeStyle = 'rgba(255,255,255,0.15)';
    for (const f of [30, 60]) {
      const y = hgt - (f / 70) * hgt;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    const hist = perfMonitor.history;
    g.strokeStyle = '#3fd584';
    g.lineWidth = 2;
    g.beginPath();
    hist.forEach((f, i) => {
      const x = (i / 59) * w;
      const y = hgt - (Math.min(70, f) / 70) * hgt;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.stroke();
  }

  // ---- 道具 (Play 中) ----

  private renderTools(): void {
    const ctx = this.ctx;
    const rt = ctx.play.runtime;
    if (!ctx.play.playing || !rt) {
      this.body.replaceChildren(h('div', { class: 'empty-state small', text: 'Play 中に使えるデバッグ用の道具です (シーン切り替え・カメラ・時刻・回復・やり直し)。' }));
      return;
    }
    const project = ctx.editor.project;
    const sceneSel = h('select', { class: 'select', attrs: { 'aria-label': 'シーン', 'data-testid': 'tool-scene' } });
    for (const s of project.scenes) sceneSel.appendChild(h('option', { text: s.name, props: { value: s.id, selected: s.id === rt.sceneData.id } }));
    const cameraSel = h('select', { class: 'select', attrs: { 'aria-label': 'カメラ', 'data-testid': 'tool-camera' } });
    cameraSel.appendChild(h('option', { text: '(ふだんのカメラ)', props: { value: '' } }));
    for (const e of Object.values(rt.sceneData.entities)) {
      if (e.kind === 'camera') cameraSel.appendChild(h('option', { text: e.name, props: { value: e.id, selected: rt.activeCameraId === e.id } }));
    }
    const rows: HTMLElement[] = [
      h(
        'div',
        { class: 'tool-row' },
        h('span', { text: 'シーン' }),
        sceneSel,
        button({ label: '移動', class: 'secondary small', testId: 'tool-scene-go', onClick: () => ctx.play.changeScene(sceneSel.value) }),
      ),
      h(
        'div',
        { class: 'tool-row' },
        h('span', { text: 'カメラ' }),
        cameraSel,
        button({ label: '切り替え', class: 'secondary small', testId: 'tool-camera-go', onClick: () => rt.switchCamera(cameraSel.value || null, 0.6) }),
      ),
    ];
    if (rt.sceneData.environment.time.enabled) {
      const hour = h('input', { class: 'range', attrs: { type: 'range', min: 0, max: 24, step: 0.25, value: rt.getHour(), 'aria-label': '時刻', 'data-testid': 'tool-hour' } });
      hour.addEventListener('input', () => rt.setHour(Number(hour.value)));
      rows.push(h('div', { class: 'tool-row' }, h('span', { text: '時刻' }), hour));
    }
    rows.push(
      h(
        'div',
        { class: 'button-row' },
        button({ icon: 'heart', label: 'HP を回復', class: 'secondary small', testId: 'tool-heal', onClick: () => rt.debugHeal() }),
        button({ icon: 'reset', label: '最初から', class: 'secondary small', testId: 'tool-restart', onClick: () => ctx.play.restart() }),
      ),
    );
    this.body.replaceChildren(...rows);
  }
}
