import { describe, expect, it } from 'vitest';
import { daylight, nightness, skyColorsAt, sunColorAt, sunDirectionAt } from '../src/engine/sky';
import { createEmptyScene } from '../src/core/project';
import { sanitizeScene } from '../src/core/serialization';

describe('時刻と太陽', () => {
  it('6 時に東から昇り、12 時に最も高く、18 時に西に沈む', () => {
    const at6 = sunDirectionAt(6);
    const at12 = sunDirectionAt(12);
    const at18 = sunDirectionAt(18);
    const at0 = sunDirectionAt(0);
    expect(at6.y).toBeCloseTo(0, 5);
    expect(at6.x).toBeGreaterThan(0.9);
    expect(at18.x).toBeLessThan(-0.9);
    expect(at12.y).toBeGreaterThan(0.8);
    expect(at0.y).toBeLessThan(-0.8);
    for (const h of [0, 3, 9, 15, 21]) expect(sunDirectionAt(h).length()).toBeCloseTo(1, 5);
    // 通り道の向きを 90 度回すと、6 時の太陽は -Z (北) 側
    expect(sunDirectionAt(6, 90).z).toBeLessThan(-0.9);
  });

  it('昼は明るく夜は暗い。星は夜だけ', () => {
    expect(daylight(sunDirectionAt(12).y)).toBe(1);
    expect(daylight(sunDirectionAt(0).y)).toBe(0);
    expect(nightness(sunDirectionAt(0).y)).toBe(1);
    expect(nightness(sunDirectionAt(12).y)).toBe(0);
    const dusk = daylight(sunDirectionAt(18.2).y);
    expect(dusk).toBeGreaterThan(0);
    expect(dusk).toBeLessThan(0.5);
  });

  it('空の色: 昼は設定の色、夜は暗い色、夕方は地平線が赤い', () => {
    const day = { top: '#3d7fd6', horizon: '#c9dff2', bottom: '#5b6270' };
    expect(skyColorsAt(sunDirectionAt(12).y, day)).toEqual(day);
    const night = skyColorsAt(sunDirectionAt(0).y, day);
    expect(night.top).toBe('#050914');
    const dusk = skyColorsAt(sunDirectionAt(17.9).y, day);
    const r = parseInt(dusk.horizon.slice(1, 3), 16);
    const b = parseInt(dusk.horizon.slice(5, 7), 16);
    expect(r).toBeGreaterThan(b);
    // 太陽の色も夕方は赤っぽい
    expect(sunColorAt(0.02, '#ffffff')).not.toBe('#ffffff');
    expect(sunColorAt(0.9, '#ffffff')).toBe('#ffffff');
  });

  it('時刻・雲・ポストエフェクトの設定を保存して読み込める (古いデータは既定値)', () => {
    const scene = createEmptyScene('空', false);
    scene.environment.time = { ...scene.environment.time, enabled: true, hour: 19.5, cycle: true };
    scene.environment.clouds.enabled = true;
    scene.environment.post.bloom.enabled = true;
    scene.environment.weather.lightning = true;
    const back = sanitizeScene(JSON.parse(JSON.stringify(scene)));
    expect(back.environment.time).toMatchObject({ enabled: true, hour: 19.5, cycle: true });
    expect(back.environment.clouds.enabled).toBe(true);
    expect(back.environment.post.bloom.enabled).toBe(true);
    expect(back.environment.weather.lightning).toBe(true);
    const old = JSON.parse(JSON.stringify(scene));
    delete old.environment.time;
    delete old.environment.clouds;
    delete old.environment.post;
    old.environment.weather = { type: 'rain', intensity: 0.5 };
    const fixed = sanitizeScene(old);
    expect(fixed.environment.time.enabled).toBe(false);
    expect(fixed.environment.clouds.enabled).toBe(false);
    expect(fixed.environment.post.dof.enabled).toBe(false);
    expect(fixed.environment.weather.lightning).toBe(false);
    // 範囲外の値は直す
    const bad = JSON.parse(JSON.stringify(scene));
    bad.environment.time.hour = 30;
    bad.environment.post.bloom.strength = 99;
    const b2 = sanitizeScene(bad);
    expect(b2.environment.time.hour).toBe(6);
    expect(b2.environment.post.bloom.strength).toBe(3);
  });
});
