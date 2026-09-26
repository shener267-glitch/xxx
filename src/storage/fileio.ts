/**
 * ファイルの書き出し (ダウンロード) と読み込み。
 */

export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return cleaned || 'untitled';
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 一部のモバイルブラウザはクリック直後に解放するとダウンロードに失敗する
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** ファイル選択ダイアログを開いてテキストを読み込む。キャンセル時は null */
export function pickTextFile(accept = '.json,application/json'): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    const finish = (v: { name: string; text: string } | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      if (file.size > 50 * 1024 * 1024) {
        settled = true;
        input.remove();
        reject(new Error('ファイルが大きすぎます (50MB まで)'));
        return;
      }
      file
        .text()
        .then((text) => finish({ name: file.name, text }))
        .catch((err) => {
          settled = true;
          input.remove();
          reject(err);
        });
    });
    // キャンセル検出 (対応ブラウザのみ)
    input.addEventListener('cancel', () => finish(null));
    input.click();
  });
}
