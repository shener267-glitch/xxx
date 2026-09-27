import { describe, expect, it } from 'vitest';
import { registerBuiltinComponents } from '../src/components/builtin';
import { createEntity } from '../src/core/catalog';
import { createBlock } from '../src/core/events';
import { logger } from '../src/core/logger';
import { createEmptyScene } from '../src/core/project';
import { matchesQuery, searchEntities } from '../src/core/search';
import { sanitizeScene } from '../src/core/serialization';
import { cameraAt, createTimeline, createTimelineItem, itemsBetween, sanitizeTimelines, sortedItems } from '../src/core/timeline';
import type { TimelineData } from '../src/core/types';
import { TimelinePlayer } from '../src/runtime/TimelinePlayer';

function sample(): TimelineData {
  const tl = createTimeline('オープニング');
  tl.duration = 5;
  tl.items.push(createTimelineItem(2, createBlock('action', 'message', { text: 'B' })));
  tl.items.push(createTimelineItem(0, createBlock('action', 'camera', { target: 'cam1', seconds: 0 })));
  tl.items.push(createTimelineItem(3, createBlock('action', 'camera', { target: 'player', seconds: 1 })));
  tl.items.push(createTimelineItem(2, createBlock('action', 'message', { text: 'C' })));
  return tl;
}

describe('タイムライン', () => {
  it('時刻の順に並び、区間の動作を取り出せる', () => {
    const tl = sample();
    expect(sortedItems(tl).map((i) => i.time)).toEqual([0, 2, 2, 3]);
    // 同じ時刻は追加した順
    expect(sortedItems(tl).filter((i) => i.time === 2).map((i) => i.action.params.text)).toEqual(['B', 'C']);
    expect(itemsBetween(tl, -1, 0).map((i) => i.action.type)).toEqual(['camera']);
    expect(itemsBetween(tl, 0, 2).length).toBe(2);
    expect(itemsBetween(tl, 2, 2.5).length).toBe(0);
  });

  it('その時刻のカメラ (プレビュー用)', () => {
    const tl = sample();
    expect(cameraAt(tl, 1)).toBe('cam1');
    expect(cameraAt(tl, 3.5)).toBe('player');
    expect(cameraAt(createTimeline(), 1)).toBeNull();
  });

  it('壊れたデータを直す・保存と読み込み', () => {
    const fixed = sanitizeTimelines([
      { id: 'a', name: '', duration: -3, items: [{ time: 'x', action: { type: 'message', params: { text: 'hi' } } }, null, { time: 2 }] },
      'bad',
      { id: 'a', name: '同じ ID', items: [] },
    ]);
    expect(fixed).toHaveLength(2);
    expect(fixed[0].name).toBe('タイムライン');
    expect(fixed[0].duration).toBe(8);
    expect(fixed[0].items).toHaveLength(1);
    expect(fixed[0].items[0].time).toBe(0);
    expect(fixed[1].id).not.toBe('a');
    const scene = createEmptyScene('S', false);
    scene.timelines.push(sample());
    const back = sanitizeScene(JSON.parse(JSON.stringify(scene)));
    expect(back.timelines[0].items).toHaveLength(4);
    // 古いデータ (タイムラインなし)
    const old = JSON.parse(JSON.stringify(scene));
    delete old.timelines;
    expect(sanitizeScene(old).timelines).toEqual([]);
  });

  it('再生: 時刻になった動作を実行し、スキップ・終わりのイベント・カメラを戻す', () => {
    const calls: string[] = [];
    const host = {
      runActions: (a: { type: string; params: Record<string, unknown> }[]) => calls.push(`run:${a.map((x) => `${x.type}${x.params.text ?? ''}`).join(',')}`),
      switchCamera: (id: string | null) => calls.push(`cam:${id}`),
      setCutscene: (on: boolean, o: { lockPlayer: boolean; skippable: boolean }) => calls.push(`cut:${on}:${o.lockPlayer}:${o.skippable}`),
      emit: (e: string, id: string) => calls.push(`emit:${e}:${id.slice(0, 2)}`),
    };
    const tl = sample();
    const p = new TimelinePlayer(host, [tl]);
    expect(p.play('none')).toBe(false);
    expect(p.play(tl.id)).toBe(true);
    expect(p.lockPlayer).toBe(true);
    expect(calls).toEqual(['cut:true:true:true', 'emit:timeline-start:tl', 'run:camera']);
    p.update(1.9);
    expect(calls.length).toBe(3);
    p.update(0.2);
    expect(calls[3]).toBe('run:messageB,messageC');
    p.update(3);
    expect(calls.slice(4)).toEqual(['run:camera', 'cut:false:false:false', 'cam:null', 'emit:timeline-end:tl']);
    expect(p.current).toBeNull();
    // スキップ
    calls.length = 0;
    p.play(tl.id);
    p.skip();
    expect(calls).toContain('emit:timeline-end:tl');
    expect(calls.filter((c) => c.startsWith('run:')).length).toBe(1);
    // 自動で再生
    calls.length = 0;
    tl.autoplay = true;
    p.playAutoplay();
    expect(p.current?.id).toBe(tl.id);
  });
});

describe('オブジェクトの検索', () => {
  registerBuiltinComponents();
  it('名前・種類・動作・タグで探せる (空白で区切ると両方を含む)', () => {
    const cube = createEntity('cube', '赤い箱');
    const enemy = createEntity('game-enemy', 'スライム');
    enemy.tags.push('ボス');
    const cam = createEntity('camera', '上から');
    const light = createEntity('light-point', '電球');
    const list = [cube, enemy, cam, light];
    expect(searchEntities(list, '箱').map((e) => e.name)).toEqual(['赤い箱']);
    expect(searchEntities(list, 'カメラ').map((e) => e.name)).toEqual(['上から']);
    expect(searchEntities(list, 'ライト').map((e) => e.name)).toEqual(['電球']);
    expect(searchEntities(list, '敵').map((e) => e.name)).toEqual(['スライム']);
    expect(searchEntities(list, 'ボス').map((e) => e.name)).toEqual(['スライム']);
    expect(matchesQuery(enemy, '敵 ボス')).toBe(true);
    expect(matchesQuery(enemy, '敵 カメラ')).toBe(false);
    expect(searchEntities(list, '').length).toBe(4);
  });
});

describe('ログ', () => {
  it('オブジェクトとの関係・未読のエラー数・消去・テキスト', () => {
    logger.clear();
    logger.info('ようこそ', 'テスト');
    logger.log('error', '壊れました', 'Play / 箱', new Error('boom'), { entityId: 'e1' });
    expect(logger.unreadErrors).toBe(1);
    const last = logger.entries[logger.entries.length - 1];
    expect(last).toMatchObject({ level: 'error', entityId: 'e1', source: 'Play / 箱' });
    expect(last.detail).toContain('boom');
    expect(last.seq).toBeGreaterThan(logger.entries[0].seq);
    expect(logger.toText()).toContain('[エラー] (Play / 箱) 壊れました');
    logger.markRead();
    expect(logger.unreadErrors).toBe(0);
    logger.clear();
    expect(logger.entries).toHaveLength(0);
  });
});
