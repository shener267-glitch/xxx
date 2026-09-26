import * as A from '../../core/actions';
import type { EditorSettings, PlayCameraMode, QualityLevel } from '../../core/settings';
import { DEFAULT_SETTINGS } from '../../core/settings';
import { estimateStorage } from '../../storage/ProjectRepository';
import type { AppContext } from '../context';
import { button, h } from '../dom';
import { confirmDialog, toast } from '../overlays';
import { fieldRow, NumberField, section, Select, TextField, Toggle } from '../widgets';

/**
 * 設定タブ: エディタ設定 (端末ごと) とプロジェクト設定。
 */
export class SettingsPanel {
  readonly el: HTMLElement;
  private refreshers: (() => void)[] = [];

  constructor(ctx: AppContext) {
    const ed = ctx.editor;
    const s = () => ed.settings;
    const set = (patch: Partial<EditorSettings>) => ed.updateSettings(patch);

    const toggle = (key: keyof EditorSettings, title: string, testId?: string) => {
      const t = new Toggle({ title, testId, onChange: (v) => set({ [key]: v } as Partial<EditorSettings>) });
      this.refreshers.push(() => t.set(Boolean(s()[key])));
      return t.el;
    };
    const number = (key: keyof EditorSettings, title: string, step: number, min: number, max?: number) => {
      const f = new NumberField({ title, step, min, max, onChange: (v) => set({ [key]: v } as Partial<EditorSettings>) });
      this.refreshers.push(() => f.set(Number(s()[key])));
      return f.el;
    };

    const quality = new Select<QualityLevel>({
      title: '画質',
      testId: 'set-quality',
      options: [
        { value: 'low', label: '低 (軽い・省電力)' },
        { value: 'medium', label: '中 (おすすめ)' },
        { value: 'high', label: '高 (高解像度)' },
      ],
      onChange: (v) => set({ quality: v }),
    });
    this.refreshers.push(() => quality.set(s().quality));

    const playCam = new Select<PlayCameraMode>({
      title: 'Play 開始時のカメラ',
      options: [
        { value: 'game', label: 'ゲームカメラ (メインカメラ)' },
        { value: 'firstPerson', label: '一人称' },
        { value: 'thirdPerson', label: '三人称 (プレイヤー追従)' },
      ],
      onChange: (v) => set({ playCamera: v }),
    });
    this.refreshers.push(() => playCam.set(s().playCamera));

    const keep = new Select<'revert' | 'keep'>({
      title: 'Play 終了時',
      testId: 'set-play-keep',
      options: [
        { value: 'revert', label: '元に戻す (おすすめ)' },
        { value: 'keep', label: '位置などの変化を保存する' },
      ],
      onChange: (v) => set({ playKeepChanges: v === 'keep' }),
    });
    this.refreshers.push(() => keep.set(s().playKeepChanges ? 'keep' : 'revert'));

    const projectName = new TextField({ title: 'ゲーム名', testId: 'set-project-name', onChange: (v) => A.renameProject(ed, v) });
    this.refreshers.push(() => projectName.set(ed.project.name));

    const startScene = h('select', {
      class: 'select',
      attrs: { 'aria-label': '開始シーン' },
      on: { change: () => A.setStartScene(ed, startScene.value) },
    });
    this.refreshers.push(() => {
      startScene.innerHTML = '';
      for (const sc of ed.project.scenes) startScene.appendChild(h('option', { text: sc.name, props: { value: sc.id } }));
      startScene.value = ed.project.startSceneId;
    });

    const storageInfo = h('span', { class: 'readonly-value', text: '計算中…' });
    const repoKind = ctx.projects.repo.kind;
    const updateStorage = () => {
      void estimateStorage().then((est) => {
        const where = repoKind === 'indexeddb' ? 'IndexedDB' : repoKind === 'localstorage' ? 'localStorage' : 'メモリ (保存されません)';
        storageInfo.textContent = est ? `${where} / ${(est.usage / 1048576).toFixed(1)}MB 使用中` : where;
      });
    };

    this.el = h(
      'div',
      { class: 'panel settings-panel' },
      section('表示', 'eye', [
        fieldRow('グリッド', toggle('showGrid', 'グリッド', 'set-grid')),
        fieldRow('影', toggle('shadows', '影')),
        fieldRow('画質', quality.el, { hint: '重いときは「低」に' }),
        fieldRow('ギズモの大きさ', number('gizmoSize', 'ギズモの大きさ', 0.1, 0.5, 3)),
      ]),
      section('操作', 'hand', [
        fieldRow('1本指でカメラ回転', toggle('oneFingerOrbit', '1本指でカメラ回転'), { hint: 'OFF にすると誤操作が減ります' }),
        fieldRow('スナップ', toggle('snapEnabled', 'スナップ', 'set-snap'), { hint: 'グリッドに吸着' }),
        fieldRow('移動の刻み', number('snapMove', '移動の刻み', 0.05, 0.01)),
        fieldRow('回転の刻み (度)', number('snapRotate', '回転の刻み', 1, 1, 180)),
        fieldRow('拡大の刻み', number('snapScale', '拡大の刻み', 0.05, 0.01)),
      ]),
      section('Play', 'play', [
        fieldRow('開始時のカメラ', playCam.el),
        fieldRow('Play 終了時', keep.el),
        fieldRow('FPS 表示', toggle('showFps', 'FPS 表示', 'set-fps')),
      ]),
      section('プロジェクト', 'folder', [
        fieldRow('ゲーム名', projectName.el),
        fieldRow('開始シーン', startScene, { hint: '書き出したゲームで最初に開く' }),
        fieldRow('自動保存', toggle('autosave', '自動保存')),
        fieldRow('保存先', storageInfo),
        h(
          'div',
          { class: 'button-row' },
          button({ icon: 'folder', label: 'プロジェクト一覧', class: 'secondary', onClick: () => ctx.openProjects() }),
          button({ icon: 'download', label: '書き出し', class: 'secondary', onClick: () => ctx.projects.exportProject() }),
        ),
      ]),
      section('その他', 'info', [
        h(
          'div',
          { class: 'button-row' },
          button({ icon: 'help', label: '操作ガイド', class: 'secondary', onClick: () => ctx.showHelp() }),
          button({
            icon: 'reset',
            label: '設定を初期化',
            class: 'secondary',
            onClick: async () => {
              if (await confirmDialog('エディタの設定を初期状態に戻しますか？ (プロジェクトは消えません)')) {
                set({ ...DEFAULT_SETTINGS });
                toast('設定を初期化しました', 'success');
              }
            },
          }),
        ),
        h('p', { class: 'field-note', text: 'Pocket Engine v0.1 (Phase 1) — データはこの端末のブラウザ内にのみ保存されます。大切なプロジェクトは「書き出し」でファイルに保存してください。' }),
      ]),
    );

    ed.events.on('settings-changed', () => this.refresh());
    ed.events.on('project-changed', () => this.refresh());
    ed.events.on('dirty-changed', (d) => {
      if (!d) updateStorage();
    });
    this.refresh();
    updateStorage();
  }

  refresh(): void {
    for (const r of this.refreshers) r();
  }
}
