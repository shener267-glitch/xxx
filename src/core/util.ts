/**
 * 汎用ユーティリティ (DOM / Three.js に依存しない)。
 */

let idCounter = 0;

/**
 * 衝突しにくい短い ID を生成する。
 * crypto.randomUUID は http (非セキュアコンテキスト) で使えないため自前で生成する。
 */
export function createId(prefix = 'e'): string {
  idCounter = (idCounter + 1) % 1296;
  const time = Date.now().toString(36).slice(-5);
  const rand = Math.floor(Math.random() * 36 ** 5)
    .toString(36)
    .padStart(5, '0');
  return `${prefix}_${time}${idCounter.toString(36).padStart(2, '0')}${rand}`;
}

/** プレーンなデータのディープコピー */
export function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/** プレーンなデータの等価比較 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** 浮動小数点の表示誤差を丸める (例: 0.30000000000000004 → 0.3) */
export function roundTo(v: number, digits = 4): number {
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export function snapTo(v: number, step: number): number {
  if (!step || step <= 0) return v;
  return roundTo(Math.round(v / step) * step, 6);
}

/** 'a.b.0' のようなパスで値を取得 */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** 'a.b.0' のようなパスで値を設定 (途中のオブジェクトは存在している前提) */
export function setPath(obj: unknown, path: string, value: unknown): boolean {
  const keys = path.split('.');
  let cur: unknown = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return false;
    cur = (cur as Record<string, unknown>)[keys[i]];
  }
  if (cur === null || cur === undefined || typeof cur !== 'object') return false;
  (cur as Record<string, unknown>)[keys[keys.length - 1]] = value;
  return true;
}

/** 既存の名前と重複しない名前を作る (例: 'キューブ' → 'キューブ 2') */
export function uniqueName(base: string, existing: Iterable<string>): string {
  const names = new Set(existing);
  if (!names.has(base)) return base;
  const m = /^(.*?)(?:\s+(\d+))?$/.exec(base);
  const stem = m ? m[1] : base;
  let n = m && m[2] ? parseInt(m[2], 10) + 1 : 2;
  while (names.has(`${stem} ${n}`)) n++;
  return `${stem} ${n}`;
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** '#abc' / 'aabbcc' などを '#aabbcc' に正規化。不正なら null */
export function normalizeHex(input: string): string | null {
  const m = HEX_RE.exec(input.trim());
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return `#${h}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = normalizeHex(hex) ?? '#ffffff';
  const v = parseInt(n.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  wrapped.flush = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = null;
    fn(...args);
  };
  return wrapped;
}

/**
 * 四則演算のみの安全な数式評価 (数値入力欄で "1.5*2" などを許可するため)。
 * 評価できない場合は null。
 */
export function evaluateExpression(src: string): number | null {
  const s = src.replace(/\s+/g, '').replace(/,/g, '.').replace(/×/g, '*').replace(/÷/g, '/');
  if (!s) return null;
  let pos = 0;
  const peek = () => s[pos];
  const parseNumber = (): number | null => {
    const m = /^\d*\.?\d+(?:e[+-]?\d+)?|^\d+\.?/i.exec(s.slice(pos));
    if (!m) return null;
    pos += m[0].length;
    return parseFloat(m[0]);
  };
  const parseFactor = (): number | null => {
    const c = peek();
    if (c === '+') {
      pos++;
      return parseFactor();
    }
    if (c === '-') {
      pos++;
      const v = parseFactor();
      return v === null ? null : -v;
    }
    if (c === '(') {
      pos++;
      const v = parseExpr();
      if (peek() !== ')') return null;
      pos++;
      return v;
    }
    return parseNumber();
  };
  const parseTerm = (): number | null => {
    let v = parseFactor();
    while (v !== null && (peek() === '*' || peek() === '/')) {
      const op = s[pos++];
      const r = parseFactor();
      if (r === null) return null;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const parseExpr = (): number | null => {
    let v = parseTerm();
    while (v !== null && (peek() === '+' || peek() === '-')) {
      const op = s[pos++];
      const r = parseTerm();
      if (r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const result = parseExpr();
  if (result === null || pos !== s.length || !Number.isFinite(result)) return null;
  return result;
}
