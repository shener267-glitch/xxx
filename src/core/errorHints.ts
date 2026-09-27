/**
 * プログラムのエラー文 (英語) を、初心者向けの「原因と直し方」に言い換える。
 * 当てはまらないものは null (元のエラー文だけを表示する)。
 */

const RULES: [RegExp, string][] = [
  [/quota|QuotaExceeded|storage.*full/i, '端末の保存容量が足りません。いらないプロジェクトやアセットを消すか、「バックアップ」でファイルに書き出してから整理してください。'],
  [/Failed to fetch|NetworkError|Load failed|ERR_INTERNET|network/i, 'ファイルを読み込めませんでした。インターネットの接続を確認して、もう一度試してください。'],
  [/decodeAudioData|Unable to decode|EncodingError|audio/i, '音声ファイルを読み込めませんでした。対応していない形式か、ファイルが壊れている可能性があります (MP3 / WAV / OGG を使ってください)。'],
  [/gltf|glb|GLTFLoader/i, '3D モデルを読み込めませんでした。GLB 形式 (glTF バイナリ) のファイルを使ってください。'],
  [/WebGL|context lost|CONTEXT_LOST/i, '3D の表示が一時的に止まりました。ほかのアプリを閉じてから、ページを再読み込みしてください。'],
  [/NotAllowedError|permission/i, 'ブラウザに操作を止められました。画面をタップしてから、もう一度試してください。'],
  [/Cannot read propert(y|ies) of (undefined|null)|is (undefined|null)|undefined is not an object/i, '必要な設定やオブジェクトが見つかりませんでした。消したオブジェクトやアセットを使っていないか、「チェック」で確認してください。'],
  [/Maximum call stack|too much recursion/i, '同じ処理がくり返し呼ばれ続けました。イベントが自分自身を何度も呼んでいないか確認してください。'],
  [/out of memory|Array buffer allocation failed/i, 'メモリが足りません。オブジェクトや大きな画像・モデルを減らしてください。'],
];

export function explainError(err: unknown): string | null {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : typeof err === 'string' ? err : '';
  if (!text) return null;
  for (const [re, hint] of RULES) if (re.test(text)) return hint;
  return null;
}
