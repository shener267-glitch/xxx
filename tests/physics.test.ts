import { describe, expect, it } from 'vitest';
import { Group } from 'three';
import { createEntity } from '../src/core/catalog';
import type { EntityData } from '../src/core/types';
import { computeColliderShape, readCollider } from '../src/engine/colliderShapes';
import { PhysicsWorld } from '../src/runtime/PhysicsWorld';

function withComponent(e: EntityData, type: string, props: Record<string, unknown>): EntityData {
  e.components.push({ id: `c_${type}`, type, enabled: true, props });
  return e;
}

function objectFor(e: EntityData): Group {
  const g = new Group();
  g.position.set(...e.transform.position);
  g.scale.set(...e.transform.scale);
  g.updateMatrixWorld(true);
  return g;
}

describe('コライダー形状', () => {
  it('見た目に合わせて自動で決まる', () => {
    const cube = createEntity('cube');
    expect(computeColliderShape(cube, [2, 1, 3], null)).toEqual({ kind: 'box', half: [1, 0.5, 1.5], offset: [0, 0, 0] });
    const sphere = createEntity('sphere');
    expect(computeColliderShape(sphere, [2, 2, 2], null)).toMatchObject({ kind: 'sphere', radius: 1 });
    const plane = createEntity('plane');
    const s = computeColliderShape(plane, [10, 1, 10], null);
    expect(s.kind).toBe('box');
    if (s.kind === 'box') expect(s.half[1]).toBeLessThan(0.05);
    const capsule = createEntity('capsule');
    expect(computeColliderShape(capsule, [1, 1, 1], null)).toMatchObject({ kind: 'capsule', radius: 0.5, height: 1 });
  });

  it('形と大きさを指定できる', () => {
    const cube = createEntity('cube');
    const col = readCollider({ id: 'c', type: 'collider', enabled: true, props: { shape: 'sphere', size: [2, 2, 2], offset: [0, 1, 0] } });
    expect(computeColliderShape(cube, [1, 1, 1], col)).toEqual({ kind: 'sphere', radius: 1, offset: [0, 1, 0] });
  });
});

describe('物理演算', () => {
  const settings = { enabled: true, gravity: [0, -9.81, 0] as [number, number, number], autoColliders: false };

  function setup() {
    const ground = withComponent(createEntity('cube', '床'), 'collider', {});
    ground.transform.position = [0, -0.5, 0];
    ground.transform.scale = [20, 1, 20];
    const box = withComponent(createEntity('cube', '箱'), 'rigidbody', { type: 'dynamic', mass: 1 });
    box.transform.position = [0, 5, 0];
    return { ground, box };
  }

  it('重力で落下して床の上で止まる', async () => {
    const world = await PhysicsWorld.create(settings);
    const { ground, box } = setup();
    const gObj = objectFor(ground);
    const bObj = objectFor(box);
    world.addEntity(ground, gObj);
    world.addEntity(box, bObj);
    for (let i = 0; i < 240; i++) world.step(1 / 60);
    // 床の上面 (y=0) に 1m の箱が乗る → 中心は y≈0.5
    expect(bObj.position.y).toBeGreaterThan(0.4);
    expect(bObj.position.y).toBeLessThan(0.6);
  });

  it('重力を受けない設定', async () => {
    const world = await PhysicsWorld.create(settings);
    const { box } = setup();
    box.components[0].props.useGravity = false;
    const bObj = objectFor(box);
    world.addEntity(box, bObj);
    for (let i = 0; i < 60; i++) world.step(1 / 60);
    expect(bObj.position.y).toBeCloseTo(5, 3);
  });

  it('トリガーは通り抜けて接触イベントを出す', async () => {
    const world = await PhysicsWorld.create(settings);
    const { ground, box } = setup();
    const zone = withComponent(createEntity('cube', 'ゾーン'), 'collider', { trigger: true });
    zone.transform.position = [0, 2.5, 0];
    zone.transform.scale = [3, 1, 3];
    world.addEntity(ground, objectFor(ground));
    const bObj = objectFor(box);
    world.addEntity(box, bObj);
    world.addEntity(zone, objectFor(zone));
    const events: string[] = [];
    world.onContactBegin = (e) => events.push(`begin:${[e.a, e.b].sort().join(',')}:${e.trigger}`);
    world.onContactEnd = (e) => events.push(`end:${[e.a, e.b].sort().join(',')}:${e.trigger}`);
    for (let i = 0; i < 240; i++) world.step(1 / 60);
    const pair = [box.id, zone.id].sort().join(',');
    expect(events).toContain(`begin:${pair}:true`);
    expect(events).toContain(`end:${pair}:true`);
    // トリガーでは止まらず床まで落ちる
    expect(bObj.position.y).toBeLessThan(0.6);
  });

  it('重力の向きを変えられる', async () => {
    const world = await PhysicsWorld.create({ enabled: true, gravity: [0, 9.81, 0], autoColliders: false });
    const { box } = setup();
    const bObj = objectFor(box);
    world.addEntity(box, bObj);
    for (let i = 0; i < 30; i++) world.step(1 / 60);
    expect(bObj.position.y).toBeGreaterThan(5.5);
  });

  it('レイキャストで床を検出できる', async () => {
    const world = await PhysicsWorld.create(settings);
    const { ground } = setup();
    world.addEntity(ground, objectFor(ground));
    world.step(1 / 60);
    const hit = world.raycast([0, 3, 0], [0, -3, 0]);
    expect(hit?.id).toBe(ground.id);
    expect(hit!.point[1]).toBeCloseTo(0, 2);
  });
});
