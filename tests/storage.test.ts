import { describe, expect, it } from 'vitest';
import { createProject } from '../src/core/project';
import { MemoryRepository } from '../src/storage/ProjectRepository';

describe('ProjectRepository (メモリ実装)', () => {
  it('保存・一覧・読み込み・削除', async () => {
    const repo = new MemoryRepository();
    const a = createProject('A');
    const b = createProject('B');
    b.updatedAt = a.updatedAt + 1000;
    await repo.save(a, 'data:thumb');
    await repo.save(b);
    const list = await repo.list();
    // 更新が新しい順
    expect(list.map((m) => m.name)).toEqual(['B', 'A']);
    expect(list[1].thumbnail).toBe('data:thumb');
    expect(list[1].sceneCount).toBe(1);
    // サムネイルを渡さずに再保存しても既存のものを保つ
    await repo.save(a);
    expect((await repo.list()).find((m) => m.id === a.id)!.thumbnail).toBe('data:thumb');
    const loaded = await repo.load(a.id);
    expect(loaded).toEqual(a);
    // 読み込んだデータを変更しても保存済みデータは変わらない
    loaded!.name = '変更';
    expect((await repo.load(a.id))!.name).toBe('A');
    await repo.remove(a.id);
    expect(await repo.load(a.id)).toBeNull();
    expect(await repo.list()).toHaveLength(1);
  });
});
