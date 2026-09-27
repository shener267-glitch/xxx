import * as A from '../core/actions';
import type { AppContext } from './context';
import { hasOpenOverlay, toast } from './overlays';

/**
 * パソコン用キーボードショートカット。
 */
export function installShortcuts(ctx: AppContext): void {
  const ed = ctx.editor;
  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    if (hasOpenOverlay()) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    // ` キーでデバッグコンソール (編集中・Play 中どちらでも)
    if (!mod && (key === '`' || key === 'f8')) {
      e.preventDefault();
      ctx.console.toggle();
      return;
    }

    if (ed.mode === 'play') {
      if (key === 'escape') {
        e.preventDefault();
        ctx.play.stop();
      }
      return;
    }

    if (mod && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      ed.undo();
    } else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
      e.preventDefault();
      ed.redo();
    } else if (mod && key === 's') {
      e.preventDefault();
      void ctx.projects.save().then((ok) => ok && toast('保存しました', 'success', 1200));
    } else if (mod && key === 'd') {
      e.preventDefault();
      A.duplicateEntities(ed);
    } else if (mod && key === 'c') {
      const n = A.copyEntities(ed);
      if (n) toast(`${n}個をコピーしました`, 'info', 1200);
    } else if (mod && key === 'v') {
      A.pasteEntities(ed);
    } else if (mod && key === 'g') {
      e.preventDefault();
      if (e.shiftKey) A.ungroupEntity(ed);
      else A.groupEntities(ed);
    } else if (mod && key === 'a') {
      e.preventDefault();
      ed.selection.set(ed.scene.ordered().filter((x) => !x.locked).map((x) => x.id));
    } else if (!mod && (key === 'delete' || key === 'backspace')) {
      e.preventDefault();
      A.deleteEntities(ed);
    } else if (!mod && key === 'escape') {
      ed.selection.clear();
    } else if (!mod && key === 'q') ed.setTool('select');
    else if (!mod && key === 'w') ed.setTool('translate');
    else if (!mod && key === 'e') ed.setTool('rotate');
    else if (!mod && key === 'r') ed.setTool('scale');
    else if (!mod && key === 'f') ed.requestFocus();
    else if (!mod && key === 'x') ed.setSpace(ed.space === 'world' ? 'local' : 'world');
    else if (!mod && key === 'p') {
      e.preventDefault();
      ctx.play.play();
    }
  });
}
