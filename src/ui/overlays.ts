import { button, h } from './dom';
import { icon } from './icons';

/**
 * モーダル・アクションシート・トースト・入力ダイアログ。
 * スマホでは画面下から出るシート形式、広い画面では中央のダイアログで表示する。
 */

let root: HTMLElement | null = null;
const stack: { close: () => void; dismissible: boolean }[] = [];

function overlayRoot(): HTMLElement {
  if (!root) {
    root = h('div', { class: 'overlay-root' });
    document.body.appendChild(root);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top.dismissible) {
          e.preventDefault();
          top.close();
        }
      }
    });
  }
  return root;
}

export function hasOpenOverlay(): boolean {
  return stack.length > 0;
}

export interface ModalAction {
  label: string;
  kind?: 'primary' | 'danger' | 'default';
  testId?: string;
  /** false を返すとモーダルを閉じない */
  onClick?: () => boolean | void;
}

export interface ModalOptions {
  title?: string;
  content: HTMLElement;
  actions?: ModalAction[];
  /** 下からのシート表示 (既定: true) */
  sheet?: boolean;
  className?: string;
  dismissible?: boolean;
  onClose?: () => void;
  testId?: string;
}

export interface ModalHandle {
  el: HTMLElement;
  close(): void;
}

export function openModal(opts: ModalOptions): ModalHandle {
  const dismissible = opts.dismissible ?? true;
  const backdrop = h('div', { class: `modal-backdrop ${opts.sheet === false ? 'mb-center' : 'mb-sheet'}` });
  const panel = h('div', {
    class: `modal ${opts.className ?? ''}`.trim(),
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title, 'data-testid': opts.testId },
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    const i = stack.findIndex((s) => s.close === close);
    if (i >= 0) stack.splice(i, 1);
    backdrop.classList.remove('open');
    // 閉じるアニメーション中は下の画面の操作を妨げない
    backdrop.style.pointerEvents = 'none';
    backdrop.setAttribute('aria-hidden', 'true');
    // フェードアウト中の要素が、次に開いたメニューの要素と混同されないようにする (自動テスト用の識別子)
    backdrop.querySelectorAll('[data-testid]').forEach((el) => el.removeAttribute('data-testid'));
    setTimeout(() => backdrop.remove(), 180);
    opts.onClose?.();
  };

  if (opts.sheet !== false) panel.appendChild(h('div', { class: 'modal-grabber' }));
  if (opts.title) {
    panel.appendChild(
      h(
        'div',
        { class: 'modal-header' },
        h('div', { class: 'modal-title', text: opts.title }),
        dismissible ? button({ icon: 'x', title: '閉じる', class: 'icon-btn ghost', onClick: close }) : null,
      ),
    );
  }
  panel.appendChild(h('div', { class: 'modal-body' }, opts.content));
  if (opts.actions && opts.actions.length > 0) {
    const footer = h('div', { class: 'modal-actions' });
    for (const a of opts.actions) {
      const b = button({
        label: a.label,
        class: a.kind === 'primary' ? 'primary' : a.kind === 'danger' ? 'danger' : 'secondary',
        testId: a.testId,
        onClick: () => {
          if (a.onClick?.() === false) return;
          close();
        },
      });
      footer.appendChild(b);
    }
    panel.appendChild(footer);
  }
  backdrop.appendChild(panel);
  // ゴーストクリック対策: 長押しなどで指の下にモーダルが開いた場合、
  // 指を離したときの合成クリックが中のボタンを押してしまうのを防ぐ。
  // (モーダル内で押し始めたクリックだけを有効にする。キーボード操作によるクリックは対象外)
  let armed = false;
  backdrop.addEventListener('pointerdown', () => (armed = true), true);
  backdrop.addEventListener(
    'click',
    (e) => {
      const pointerType = (e as PointerEvent).pointerType;
      const fromPointer = e.detail > 0 || (typeof pointerType === 'string' && pointerType !== '');
      if (!armed && fromPointer) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true,
  );
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop && dismissible) {
      e.preventDefault();
      close();
    }
  });
  overlayRoot().appendChild(backdrop);
  stack.push({ close, dismissible });
  requestAnimationFrame(() => backdrop.classList.add('open'));
  return { el: panel, close };
}

// ------------------------------------------------------------------
// 確認・入力
// ------------------------------------------------------------------

export function confirmDialog(
  message: string,
  opts: { title?: string; okLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    openModal({
      title: opts.title ?? '確認',
      sheet: false,
      content: h('p', { class: 'modal-message', text: message }),
      actions: [
        { label: 'キャンセル' },
        {
          label: opts.okLabel ?? 'OK',
          kind: opts.danger ? 'danger' : 'primary',
          testId: 'confirm-ok',
          onClick: () => {
            result = true;
          },
        },
      ],
      onClose: () => resolve(result),
    });
  });
}

export function promptDialog(
  title: string,
  value = '',
  opts: { placeholder?: string; okLabel?: string; maxLength?: number } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const input = h('input', {
      class: 'text-input',
      attrs: { type: 'text', maxlength: opts.maxLength ?? 100, placeholder: opts.placeholder, 'data-testid': 'prompt-input', enterkeyhint: 'done' },
      props: { value },
    });
    const submit = () => {
      result = input.value;
      modal.close();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    const modal = openModal({
      title,
      sheet: false,
      content: input,
      actions: [
        { label: 'キャンセル' },
        {
          label: opts.okLabel ?? 'OK',
          kind: 'primary',
          testId: 'prompt-ok',
          onClick: () => {
            result = input.value;
          },
        },
      ],
      onClose: () => resolve(result),
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 60);
  });
}

// ------------------------------------------------------------------
// アクションシート
// ------------------------------------------------------------------

export interface ActionItem {
  label: string;
  icon?: string;
  hint?: string;
  /** キーボードショートカットの表記 (タッチ端末では非表示) */
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  testId?: string;
  onSelect: () => void;
}

export function actionSheet(title: string | null, items: (ActionItem | 'separator')[], opts: { testId?: string } = {}): ModalHandle {
  const list = h('div', { class: 'action-list', attrs: { role: 'menu' } });
  const modal = openModal({ title: title ?? undefined, content: list, className: 'action-sheet', testId: opts.testId });
  for (const item of items) {
    if (item === 'separator') {
      list.appendChild(h('div', { class: 'action-sep' }));
      continue;
    }
    const row = h(
      'button',
      {
        class: `action-item ${item.danger ? 'danger' : ''} ${item.checked ? 'checked' : ''}`.trim(),
        attrs: { type: 'button', role: 'menuitem', 'data-testid': item.testId },
        props: { disabled: !!item.disabled },
        on: {
          click: () => {
            modal.close();
            item.onSelect();
          },
        },
      },
      h('span', { class: 'action-icon', html: item.icon ? icon(item.icon, 20) : '' }),
      h('span', { class: 'action-label', text: item.label }),
      item.hint ? h('span', { class: 'action-hint', text: item.hint }) : null,
      item.shortcut ? h('span', { class: 'action-hint action-shortcut', text: item.shortcut }) : null,
      item.checked ? h('span', { class: 'action-check', html: icon('check', 18) }) : null,
    );
    list.appendChild(row);
  }
  return modal;
}

// ------------------------------------------------------------------
// トースト
// ------------------------------------------------------------------

let toastRoot: HTMLElement | null = null;

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

/** お知らせを出す。close() ですぐに消せる (長い処理の「〜しています…」など) */
export function toast(message: string, kind: ToastKind = 'info', ms = 2200): { close(): void } {
  if (!toastRoot) {
    toastRoot = h('div', { class: 'toast-root', attrs: { 'aria-live': 'polite' } });
    document.body.appendChild(toastRoot);
  }
  const iconName = kind === 'success' ? 'check' : kind === 'error' ? 'bug' : kind === 'warn' ? 'info' : 'info';
  const el = h('div', { class: `toast ${kind}`, attrs: { role: kind === 'error' ? 'alert' : 'status' } }, h('span', { html: icon(iconName, 18) }), h('span', { text: message }));
  toastRoot.appendChild(el);
  // 同時に大量に出ないよう古いものを消す
  while (toastRoot.children.length > 3) toastRoot.firstElementChild?.remove();
  requestAnimationFrame(() => el.classList.add('show'));
  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  };
  setTimeout(close, ms);
  return { close };
}
