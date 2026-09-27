import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { registerBuiltinComponents } from '../src/components/builtin';
import type { ExportedGame, GameBuildInput } from '../src/core/gameExport';
import {
  DATA_FILE,
  fromBase64,
  gameDataScript,
  gameFileBase,
  gameHtml,
  gameSingleHtml,
  gameZipEntries,
  parseGameDataScript,
  PLAYER_FILE,
  scriptSafeJson,
  toBase64,
  webManifest,
} from '../src/core/gameExport';
import { createProject } from '../src/core/project';
import { sanitizeProject } from '../src/core/serialization';
import { bytesText, createZip, readZip } from '../src/core/zip';

function input(overrides: Partial<GameBuildInput> = {}): GameBuildInput {
  registerBuiltinComponents();
  const project = createProject('テスト', true);
  project.game.title = 'ぼくの <ゲーム> & "冒険"';
  project.game.author = 'たろう';
  project.game.version = '1.2.0';
  project.assets.push({ id: 'a_img', name: '画像', type: 'image', folder: '', mime: 'image/png', size: 4, createdAt: 1, thumb: 'data:image/png;base64,AAAA' });
  return {
    project,
    assets: new Map([['a_img', { mime: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) }]]),
    playerJs: 'window.__played=(window.__POCKET_GAME__||{}).format;var s="</script>";',
    icons: { small: new Uint8Array([1, 2, 3]), large: new Uint8Array([4, 5, 6]) },
    exportedAt: 1000,
    ...overrides,
  };
}

describe('base64', () => {
  it('行って戻る (大きなデータ・すべてのバイト)', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) % 256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(toBase64(new Uint8Array([104, 105]))).toBe('aGk=');
    expect(fromBase64('')).toEqual(new Uint8Array());
  });
});

describe('ゲームのデータ (game-data.js)', () => {
  it('<script> の中で壊れない JSON', () => {
    const text = scriptSafeJson({ a: '</script><script>alert(1)</script>', b: 'x y z' });
    expect(text).not.toContain('</script');
    expect(text).not.toContain(' ');
    expect(JSON.parse(text)).toEqual({ a: '</script><script>alert(1)</script>', b: 'x y z' });
  });

  it('書いて読むと同じ中身 (サムネイルは入れない)', () => {
    const src = input();
    const script = gameDataScript(parseGameDataScript(gameDataScript({ format: 'pocket-engine-game', version: 1, exportedAt: 1, project: src.project, assets: {} })));
    const game = parseGameDataScript(script);
    expect(game.project.game.title).toBe('ぼくの <ゲーム> & "冒険"');
    expect(() => parseGameDataScript('var x = 1;')).toThrow();
  });

  it('ブラウザと同じように実行すると window に入る', () => {
    const entries = gameZipEntries(input());
    const data = bytesText(entries.find((e) => e.name === DATA_FILE)!.data);
    const window: Record<string, unknown> = {};
    runInNewContext(data, { window });
    const game = window.__POCKET_GAME__ as ExportedGame;
    expect(game.format).toBe('pocket-engine-game');
    expect(game.project.name).toBe('テスト');
    expect(game.project.assets[0].thumb).toBeUndefined();
    expect(fromBase64(game.assets.a_img.data)).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(game.assets.a_img.mime).toBe('image/png');
  });
});

describe('ZIP (GitHub Pages 用)', () => {
  it('必要なファイルがそろい、相対パスだけを使う', async () => {
    const zip = await createZip(gameZipEntries(input()));
    const files = await readZip(zip);
    expect([...files.keys()].sort()).toEqual(['.nojekyll', 'README.txt', DATA_FILE, 'icon-192.png', 'icon-512.png', 'index.html', 'manifest.webmanifest', PLAYER_FILE].sort());
    const html = bytesText(files.get('index.html')!);
    expect(html).toContain(`<script src="${DATA_FILE}"></script>`);
    expect(html).toContain(`<script src="${PLAYER_FILE}"></script>`);
    // データを先に読む
    expect(html.indexOf(DATA_FILE)).toBeLessThan(html.indexOf(PLAYER_FILE));
    // 絶対パス・外部の URL を使わない (どのサブパスでも・オフラインでも動く)
    expect(html).not.toMatch(/(src|href)="\/(?!\/)/);
    expect(html).not.toMatch(/(src|href)="https?:/);
    // タイトルは HTML として安全に
    expect(html).toContain('<title>ぼくの &lt;ゲーム&gt; &amp; &quot;冒険&quot;</title>');
    expect(html).toContain('<meta name="author" content="たろう" />');
    const manifest = JSON.parse(bytesText(files.get('manifest.webmanifest')!));
    expect(manifest.start_url).toBe('./');
    expect(manifest.icons.map((i: { src: string }) => i.src)).toEqual(['icon-192.png', 'icon-512.png']);
    expect(files.get('icon-512.png')).toEqual(new Uint8Array([4, 5, 6]));
    expect(bytesText(files.get('README.txt')!)).toContain('GitHub Pages');
  });

  it('アイコンが無ければアイコンのファイル・リンクを入れない', () => {
    const entries = gameZipEntries(input({ icons: null }));
    expect(entries.some((e) => e.name.startsWith('icon-'))).toBe(false);
    const html = bytesText(entries.find((e) => e.name === 'index.html')!.data);
    expect(html).not.toContain('rel="icon"');
    expect(JSON.parse(webManifest(input().project, false)).icons).toBeUndefined();
  });
});

describe('1 つの HTML', () => {
  it('データ・本体・アイコンをすべて中に入れ、</script> で壊れない', () => {
    const html = gameSingleHtml(input());
    expect(html).not.toContain('src="');
    expect(html).toContain('href="data:image/png;base64,AQID"');
    expect(html).not.toContain('rel="manifest"');
    // スクリプトは 2 つだけ閉じられる (本体の中の "</script>" は無害化されている)
    expect(html.match(/<\/script>/g)?.length).toBe(2);
    // 中身を取り出して順に実行すると、本体がデータを読める
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBe(2);
    const window: Record<string, unknown> = {};
    for (const s of scripts) runInNewContext(s, { window });
    expect(window.__played).toBe('pocket-engine-game');
  });

  it('ファイル名に使えない文字を置き換える', () => {
    const p = input().project;
    p.game.title = 'a/b:c*d?';
    expect(gameFileBase(p)).toBe('a_b_c_d_');
    p.game.title = '  ';
    expect(gameFileBase(p)).toBe('テスト');
  });

  it('色が正しくなければ既定の色', () => {
    const p = input().project;
    p.game.titleBackground = 'red;}</style><script>';
    const html = gameHtml(p, { icon: null, manifest: false, scripts: { src: PLAYER_FILE } });
    expect(html).not.toContain('red;}');
    expect(html).toContain('#1b2a4a');
  });
});

describe('ゲーム設定 (書き出し用の項目)', () => {
  it('古いプロジェクトには既定値が入り、正しくない値は直す', () => {
    registerBuiltinComponents();
    const p = createProject('古い', false) as unknown as { game: Record<string, unknown> };
    delete p.game.author;
    delete p.game.orientation;
    delete p.game.startFromTitle;
    p.game.quality = 'ultra';
    const fixed = sanitizeProject(p);
    expect(fixed.game.author).toBe('');
    expect(fixed.game.version).toBe('1.0.0');
    expect(fixed.game.orientation).toBe('any');
    expect(fixed.game.quality).toBe('auto');
    expect(fixed.game.startFromTitle).toBe(true);
  });
});
