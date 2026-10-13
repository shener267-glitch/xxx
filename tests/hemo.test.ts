import { Raycaster, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { clampToRoom, PROP_DEFS, propRestPosition, ROOM } from '../src/hemo/lab';
import { LabScene } from '../src/hemo/LabScene';

describe('HEMO 実験室 (Phase 1)', () => {
  it('置いてある物は床の上に置かれ、IDが重ならない', () => {
    expect(new Set(PROP_DEFS.map((d) => d.id)).size).toBe(PROP_DEFS.length);
    for (const d of PROP_DEFS) expect(propRestPosition(d)[1]).toBeCloseTo(d.size[1] / 2);
  });

  it('clampToRoom は壁の内側に収める', () => {
    expect(clampToRoom(100, -100, 0.5)).toEqual([ROOM.halfX - 0.5, -(ROOM.halfZ - 0.5)]);
    expect(clampToRoom(1, 2, 0.5)).toEqual([1, 2]);
  });

  it('LabScene が作られ、全ての物が登録される', () => {
    const lab = new LabScene('low');
    expect(lab.props.size).toBe(PROP_DEFS.length);
    expect(lab.selectedId).toBeNull();
    lab.dispose();
  });

  it('物を動かしても壁にめり込まず、リセットで元に戻る', () => {
    const lab = new LabScene('low');
    const mesh = lab.props.get('ball')!;
    const before = mesh.position.clone();
    lab.moveProp('ball', 999, -999);
    expect(Math.abs(mesh.position.x)).toBeLessThan(ROOM.halfX);
    expect(Math.abs(mesh.position.z)).toBeLessThan(ROOM.halfZ);
    lab.select('ball');
    lab.reset();
    expect(mesh.position.distanceTo(before)).toBeLessThan(1e-9);
    expect(lab.selectedId).toBeNull();
    lab.dispose();
  });

  it('光線で物を選べる (上から下へ撃つ)', () => {
    const lab = new LabScene('low');
    const p = lab.props.get('barrel')!.position;
    const ray = new Raycaster(new Vector3(p.x, 5, p.z), new Vector3(0, -1, 0));
    expect(lab.pick(ray)).toBe('barrel');
    const empty = new Raycaster(new Vector3(5, 5, 5), new Vector3(0, -1, 0));
    expect(lab.pick(empty)).toBeNull();
    lab.dispose();
  });

  it('選択すると選択枠が表示され、解除で消える', () => {
    const lab = new LabScene('low');
    lab.select('crate-a');
    expect(lab.scene.getObjectByName('__selection')?.visible).toBe(true);
    lab.select(null);
    expect(lab.scene.getObjectByName('__selection')?.visible).toBe(false);
    lab.dispose();
  });
});
