import { describe, expect, it } from 'vitest';
import { AssetService } from '../src/app/AssetService';
import { createEntity } from '../src/core/catalog';
import { Editor } from '../src/core/Editor';
import { createProject } from '../src/core/project';
import { buildPackage, readPackage } from '../src/core/projectPackage';
import { createPrefab } from '../src/core/prefabs';
import type { ProjectData } from '../src/core/types';
import { bytesText, crc32, createZip, isZip, readZip, textBytes } from '../src/core/zip';
import { MemoryBackupStore } from '../src/storage/BackupStore';
import { MemoryAssetStore } from '../src/storage/ProjectRepository';
import { registerBuiltinComponents } from '../src/components/builtin';

describe('ZIP', () => {
  it('CRC-32 (既知の値)', () => {
    expect(crc32(textBytes('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('作って読むと同じ中身 (圧縮あり・なし、日本語のファイル名、バイナリ)', async () => {
    const big = textBytes('ポケットエンジン '.repeat(500));
    const bin = new Uint8Array(3000).map((_, i) => (i * 37) % 256);
    for (const compress of [true, false]) {
      const zip = await createZip(
        [
          { name: 'a.txt', data: textBytes('hello') },
          { name: 'フォルダ/日本語.json', data: big },
          { name: 'assets/image.png', data: bin },
          { name: 'empty.txt', data: new Uint8Array() },
        ],
        { compress },
      );
      expect(isZip(zip)).toBe(true);
      const files = await readZip(zip);
      expect([...files.keys()]).toEqual(['a.txt', 'フォルダ/日本語.json', 'assets/image.png', 'empty.txt']);
      expect(bytesText(files.get('a.txt')!)).toBe('hello');
      expect(files.get('フォルダ/日本語.json')).toEqual(big);
      expect(files.get('assets/image.png')).toEqual(bin);
      expect(files.get('empty.txt')!.length).toBe(0);
      // 圧縮すると繰り返しの多い文字は小さくなる
      if (compress) expect(zip.length).toBeLessThan(big.length);
    }
  });

  it('壊れたファイル・ZIP でないもの・同じ名前', async () => {
    expect(isZip(textBytes('{"a":1}'))).toBe(false);
    await expect(readZip(textBytes('not a zip at all, sorry'))).rejects.toThrow();
    const zip = await createZip([{ name: 'x.txt', data: textBytes('abc'.repeat(100)) }], { compress: false });
    const broken = zip.slice();
    broken[40] ^= 0xff; // 中身を壊す
    await expect(readZip(broken)).rejects.toThrow(/壊れて/);
    await expect(createZip([{ name: 'a', data: new Uint8Array() }, { name: 'a', data: new Uint8Array() }])).rejects.toThrow();
  });
});

function projectWithAssets(name: string): ProjectData {
  registerBuiltinComponents();
  const p = createProject(name, false);
  p.assets.push({ id: 'a_img', name: '空の画像', type: 'image', folder: '', mime: 'image/png', size: 4, createdAt: 1 });
  p.assets.push({ id: 'a_snd', name: 'ドン', type: 'audio', folder: '効果音', mime: 'audio/wav', size: 3, createdAt: 1 });
  return p;
}

describe('プロジェクトのパッケージ (.pocket.zip)', () => {
  it('1 つのプロジェクト: データとアセットの本体が戻る', async () => {
    const p = projectWithAssets('テスト');
    const bodies: Record<string, Uint8Array> = { a_img: new Uint8Array([1, 2, 3, 4]), a_snd: new Uint8Array([9, 8, 7]) };
    const missing: string[] = [];
    const zip = await buildPackage([p], async (_pid, id) => bodies[id] ?? null, missing);
    expect(missing).toEqual([]);
    const [back] = await readPackage(zip);
    expect(back.project.name).toBe('テスト');
    expect(back.project.id).toBe(p.id);
    expect(back.assets.get('a_img')).toEqual(bodies.a_img);
    expect(back.assets.get('a_snd')).toEqual(bodies.a_snd);
    expect(back.project.assets.find((a) => a.id === 'a_snd')?.folder).toBe('効果音');
  });

  it('複数のプロジェクト (すべてバックアップ)・見つからないアセット', async () => {
    const a = projectWithAssets('A');
    const b = projectWithAssets('B');
    const missing: string[] = [];
    const zip = await buildPackage([a, b], async (pid, id) => (pid === a.id && id === 'a_img' ? new Uint8Array([5]) : null), missing);
    expect(missing.length).toBe(3);
    const items = await readPackage(zip);
    expect(items.map((x) => x.project.name)).toEqual(['A', 'B']);
    expect(items[0].assets.size).toBe(1);
    expect(items[1].assets.size).toBe(0);
    await expect(readPackage(await createZip([{ name: 'readme.txt', data: textBytes('x') }]))).rejects.toThrow();
  });
});

describe('バックアップ', () => {
  it('追加・一覧 (新しい順)・読み込み・古い自動バックアップから消す', async () => {
    const store = new MemoryBackupStore();
    const p = projectWithAssets('バックアップ');
    const infos = [];
    for (let i = 0; i < 5; i++) {
      p.name = `v${i}`;
      infos.push(await store.add(p, i === 1 ? 'manual' : 'auto'));
      await new Promise((r) => setTimeout(r, 2));
    }
    const list = await store.list(p.id);
    expect(list.map((b) => b.projectName)).toEqual(['v4', 'v3', 'v2', 'v1', 'v0']);
    expect((await store.load(infos[2].key))?.name).toBe('v2');
    // 3 個にする: 古い自動 (v0, v2) から消し、手動 (v1) は残る
    expect(await store.prune(p.id, 3)).toBe(2);
    expect((await store.list(p.id)).map((b) => b.projectName)).toEqual(['v4', 'v3', 'v1']);
    // 別のプロジェクトのものは別
    await store.add(projectWithAssets('ほか'), 'auto');
    expect((await store.list()).length).toBe(4);
    await store.removeProject(p.id);
    expect((await store.list()).map((b) => b.projectName)).toEqual(['ほか']);
  });
});

describe('他のプロジェクトから取り込む・使われていないアセット', () => {
  it('部品が使っているアセットも取り込み、同じ ID は付け替える', async () => {
    registerBuiltinComponents();
    const store = new MemoryAssetStore();
    const src = projectWithAssets('元');
    await store.put(src.id, 'a_img', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }));
    await store.put(src.id, 'a_snd', new Blob([new Uint8Array([7, 7, 7])], { type: 'audio/wav' }));
    // 画像を貼った部品
    const board = createEntity('plane', '看板');
    board.mesh!.material.texture = 'a_img';
    src.prefabs.push(createPrefab([board], '看板'));

    const dst = createProject('先', false);
    // 先のプロジェクトにも a_img という ID がある (付け替えが必要)
    dst.assets.push({ id: 'a_img', name: '別の画像', type: 'image', folder: '', mime: 'image/png', size: 1, createdAt: 1 });
    const editor = new Editor(dst);
    const assets = new AssetService(store, editor);
    const r = await assets.importFromProject(src, [], [src.prefabs[0].id]);
    expect(r).toEqual({ assets: 1, prefabs: 1 });
    const imported = editor.project.assets.find((a) => a.name === '空の画像')!;
    expect(imported.id).not.toBe('a_img');
    const pf = editor.project.prefabs[0];
    const root = pf.entities[pf.root];
    expect(root.mesh!.material.texture).toBe(imported.id);
    expect(await store.get(dst.id, imported.id)).not.toBeNull();
    // 音声を名前指定で取り込む (同じ名前は付け替えない ID)
    await assets.importFromProject(src, ['a_snd'], []);
    expect(editor.project.assets.map((a) => a.id)).toContain('a_snd');

    // 使われていないアセット: 別の画像 と ドン (部品の画像は使われている)
    expect(assets.unused().map((a) => a.name).sort()).toEqual(['ドン', '別の画像'].sort());
    expect(await assets.removeUnused()).toBe(2);
    expect(editor.project.assets.map((a) => a.name)).toEqual(['空の画像']);
  });
});
