/**
 * ZIP ファイルの作成と読み込み (依存ライブラリなし)。
 * - 圧縮はブラウザの CompressionStream ('deflate-raw') が使えれば使い、使えなければ無圧縮で保存する
 * - 読み込みは 無圧縮 (0) と deflate (8) に対応
 * - ファイル名は UTF-8 (汎用フラグ bit 11)
 * プロジェクトのバックアップ (Phase 9) とゲームの書き出し (Phase 10) で使う。
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  /** 最終更新日時 (省略時は今) */
  date?: Date;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function streamTransform(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const blob = new Blob([data as BlobPart]);
  const out = blob.stream().pipeThrough(stream as unknown as TransformStream<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

function canCompress(): boolean {
  try {
    return typeof CompressionStream !== 'undefined' && !!new CompressionStream('deflate-raw' as CompressionFormat);
  } catch {
    return false;
  }
}

function canDecompress(): boolean {
  try {
    return typeof DecompressionStream !== 'undefined' && !!new DecompressionStream('deflate-raw' as CompressionFormat);
  } catch {
    return false;
  }
}

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export const textBytes = (s: string): Uint8Array => new TextEncoder().encode(s);
export const bytesText = (b: Uint8Array): string => new TextDecoder().decode(b);

/**
 * ZIP を作る。compress = false なら無圧縮 (画像・音声などすでに圧縮されているものは無圧縮の方が速い)
 */
export async function createZip(entries: ZipEntry[], opts: { compress?: boolean } = {}): Promise<Uint8Array> {
  const useDeflate = opts.compress !== false && canCompress();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const names = new Set<string>();
  for (const e of entries) {
    const name = e.name.replace(/^\/+/, '');
    if (!name || names.has(name)) throw new Error(`ZIP のファイル名が正しくありません: ${e.name}`);
    names.add(name);
    const nameBytes = textBytes(name);
    const crc = crc32(e.data);
    let method = 0;
    let body = e.data;
    // 小さいファイルや圧縮済みの形式は無圧縮
    if (useDeflate && e.data.length > 64 && !/\.(png|jpe?g|webp|gif|mp3|ogg|m4a|aac|glb|woff2?|zip)$/i.test(name)) {
      const deflated = await streamTransform(e.data, new CompressionStream('deflate-raw' as CompressionFormat));
      if (deflated.length < e.data.length) {
        method = 8;
        body = deflated;
      }
    }
    const { time, date } = dosTime(e.date ?? new Date());
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    locals.push(local, body);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

/** ZIP かどうか (先頭が PK\x03\x04) */
export function isZip(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
}

/** ZIP を読む (ファイル名 → 中身) */
export async function readZip(data: Uint8Array): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // 終端レコードを後ろから探す
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP ファイルとして読めませんでした');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP ファイルが壊れています');
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = bytesText(data.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const lNameLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const body = data.subarray(start, start + compSize);
    let content: Uint8Array;
    if (method === 0) content = body.slice();
    else if (method === 8) {
      if (!canDecompress()) throw new Error('このブラウザでは圧縮された ZIP を読めません');
      content = await streamTransform(body, new DecompressionStream('deflate-raw' as CompressionFormat));
    } else throw new Error(`対応していない圧縮方式です (${method})`);
    if (content.length !== size || crc32(content) !== crc) throw new Error(`ZIP の中の「${name}」が壊れています`);
    out.set(name, content);
  }
  return out;
}
