import { MathUtils, Quaternion, Vector3 } from 'three';
import type { Vec3 } from '../core/types';
import type { ComponentContext, PlayerControllerHandle } from './registry';
import { registerComponent } from './registry';

/**
 * Phase 3: ゲーム用コンポーネント (プレイヤー・HP・敵・NPC・アイテム・ダメージ床・セーブポイント・ゴール・効果音)。
 * 当たり判定 (拾う・触れる) は見た目の箱の重なりで判定するので、物理 OFF のシーンでも動く。
 */

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

const UP = new Vector3(0, 1, 0);
const _v = new Vector3();
const _w = new Vector3();
const _q = new Quaternion();

/** 水平方向に向きを滑らかに変える */
function faceTowards(ctx: ComponentContext, dirX: number, dirZ: number, dt: number, speed = 10): number {
  const yaw = Math.atan2(dirX, dirZ);
  _q.setFromAxisAngle(UP, yaw);
  ctx.object.quaternion.slerp(_q, Math.min(1, dt * speed));
  return yaw;
}

/** 文章をページに分ける (空行 または「|」で区切る) */
export function splitPages(text: string): string[] {
  return text
    .split(/\n\s*\n|\|/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

export function registerGameplayComponents(): void {
  // ------------------------------------------------------------------
  // プレイヤー操作
  // ------------------------------------------------------------------
  registerComponent({
    type: 'player',
    label: 'プレイヤー操作',
    icon: 'person',
    description: 'ジョイスティック / WASD で歩く・走る、ボタン / Space でジャンプ、攻撃・会話ができます',
    category: 'gameplay',
    defaults: () => ({ camera: 'thirdPerson', moveSpeed: 4, runSpeed: 7.5, jumpHeight: 1.4, lives: 3, attack: true, attackDamage: 10, attackRange: 1.8 }),
    schema: [
      {
        key: 'camera',
        label: 'カメラ',
        type: 'select',
        options: [
          { value: 'thirdPerson', label: '三人称 (後ろから)' },
          { value: 'firstPerson', label: '一人称 (目線)' },
          { value: 'scene', label: 'シーンのカメラ' },
        ],
      },
      { key: 'moveSpeed', label: '歩く速さ', type: 'number', min: 0, max: 50, step: 0.5, unit: 'm/秒' },
      { key: 'runSpeed', label: '走る速さ', type: 'number', min: 0, max: 80, step: 0.5, unit: 'm/秒' },
      { key: 'jumpHeight', label: 'ジャンプの高さ', type: 'number', min: 0, max: 20, step: 0.1, unit: 'm' },
      { key: 'lives', label: '残機', type: 'number', min: 1, max: 99, step: 1 },
      { key: 'attack', label: '攻撃できる', type: 'boolean' },
      { key: 'attackDamage', label: '攻撃力', type: 'number', min: 0, max: 9999, step: 1 },
      { key: 'attackRange', label: '攻撃の届く距離', type: 'number', min: 0.2, max: 20, step: 0.1, unit: 'm' },
    ],
    create(ctx, props) {
      const rt = ctx.runtime;
      const id = ctx.entity.id;
      const walk = Math.max(0, num(props.moveSpeed, 4));
      const run = Math.max(walk, num(props.runSpeed, 7.5));
      const jumpHeight = Math.max(0, num(props.jumpHeight, 1.4));
      const canAttack = bool(props.attack, true);
      const attackDamage = num(props.attackDamage, 10);
      const attackRange = num(props.attackRange, 1.8);
      // 物理を使わない場合の簡易的な重力
      let vy = 0;
      let baseY = 0;
      /** 地形の上では、地形の表面から体の原点までの高さ (地形が無ければ null) */
      let footOffset: number | null = null;
      let grounded = true;
      let attackAnim = 0;
      const baseScale = ctx.object.scale.clone();
      const hasBody = () => !!rt.physics?.bodies.get(id);

      const handle: PlayerControllerHandle = {
        bounce(speed) {
          const phys = rt.physics;
          const v = phys?.getVelocity(id);
          if (phys && v) phys.setVelocity(id, [v[0], speed, v[2]]);
          else {
            vy = speed;
            grounded = false;
          }
        },
        knockback(dir, strength) {
          const phys = rt.physics;
          if (phys && hasBody()) phys.setVelocity(id, [dir[0] * strength, Math.max(3, strength * 0.6), dir[2] * strength]);
          else {
            ctx.object.position.x += dir[0] * strength * 0.12;
            ctx.object.position.z += dir[2] * strength * 0.12;
          }
        },
        respawn(pos) {
          if (rt.physics && hasBody()) rt.physics.teleport(id, pos);
          else {
            ctx.object.position.set(pos[0], pos[1], pos[2]);
            vy = 0;
          }
        },
      };

      const attack = () => {
        attackAnim = 0.18;
        rt.playSound('builtin:hit', 0.7);
        const me = rt.worldPosition(id, new Vector3());
        // 攻撃の向き: 一人称はカメラの向き、それ以外は体の向き
        const yaw = rt.getCameraMode() === 'firstPerson' ? MathUtils.degToRad(rt.cameraYaw()) + Math.PI : null;
        const forward = yaw !== null ? new Vector3(Math.sin(yaw), 0, Math.cos(yaw)) : new Vector3(0, 0, 1).applyQuaternion(ctx.object.quaternion);
        forward.y = 0;
        forward.normalize();
        let hit = false;
        for (const target of rt.healthTargets()) {
          if (target === id || rt.isDestroyed(target)) continue;
          const p = rt.worldPosition(target, _w);
          _v.subVectors(p, me);
          _v.y = 0;
          const dist = _v.length();
          if (dist > attackRange + 0.6) continue;
          if (dist > 0.3 && _v.normalize().dot(forward) < 0.2) continue;
          if (rt.damage(target, attackDamage, id)) hit = true;
        }
        if (hit) rt.emit('attack-hit', id);
      };

      return {
        start() {
          baseY = ctx.object.position.y;
          const p = rt.worldPosition(id, _v);
          const g = rt.groundHeightAt(p.x, p.z);
          footOffset = g !== null ? Math.max(0, p.y - g) : null;
          rt.registerPlayer(id, handle);
        },
        update(dt) {
          const input = rt.input;
          const phys = rt.physics;
          const body = hasBody();
          // 攻撃のアニメーション (少し膨らむ)
          if (attackAnim > 0) {
            attackAnim = Math.max(0, attackAnim - dt);
            const s = 1 + Math.sin((attackAnim / 0.18) * Math.PI) * 0.12;
            ctx.object.scale.set(baseScale.x * s, baseScale.y, baseScale.z * s);
          }
          if (input.consumeAction()) {
            if (!rt.interact() && canAttack) attack();
          }
          const yaw = MathUtils.degToRad(rt.cameraYaw());
          const fx = -Math.sin(yaw);
          const fz = -Math.cos(yaw);
          const rx = Math.cos(yaw);
          const rz = -Math.sin(yaw);
          let dx = fx * input.move.y + rx * input.move.x;
          let dz = fz * input.move.y + rz * input.move.x;
          const len = Math.hypot(dx, dz);
          if (len > 1) {
            dx /= len;
            dz /= len;
          }
          const speed = input.running ? run : walk;
          const jump = input.consumeJump();
          const jumpSpeed = Math.sqrt(2 * rt.gravity * jumpHeight);

          if (phys && body) {
            const v = phys.getVelocity(id) ?? [0, 0, 0];
            const onGround = rt.isGrounded(id);
            const accel = onGround ? 14 : 5;
            const k = Math.min(1, accel * dt);
            const nvx = v[0] + (dx * speed - v[0]) * k;
            const nvz = v[2] + (dz * speed - v[2]) * k;
            let nvy = v[1];
            if (jump && onGround && jumpHeight > 0) {
              nvy = jumpSpeed;
              rt.playSound('builtin:jump', 0.6);
              rt.emit('jump', id);
            }
            phys.setVelocity(id, [nvx, nvy, nvz]);
          } else {
            ctx.object.position.x += dx * speed * dt;
            ctx.object.position.z += dz * speed * dt;
            // 地形の上なら、その場所の地面の高さに合わせる (下り坂で離れたら落ちる)
            if (footOffset !== null && !ctx.entity.parent) {
              const g = rt.groundHeightAt(ctx.object.position.x, ctx.object.position.z);
              if (g !== null) {
                const floor = g + footOffset;
                if (grounded && ctx.object.position.y - floor > 0.6) grounded = false;
                baseY = floor;
                if (grounded) ctx.object.position.y = floor;
              }
            }
            if (jump && grounded && jumpHeight > 0) {
              vy = jumpSpeed;
              grounded = false;
              rt.playSound('builtin:jump', 0.6);
              rt.emit('jump', id);
            }
            if (!grounded) {
              vy -= rt.gravity * dt;
              ctx.object.position.y += vy * dt;
              if (ctx.object.position.y <= baseY) {
                ctx.object.position.y = baseY;
                vy = 0;
                grounded = true;
              }
            }
          }
          // 向き: 一人称はカメラと同じ向き、それ以外は進む方向
          if (rt.getCameraMode() === 'firstPerson') {
            const q = _q.setFromAxisAngle(UP, yaw + Math.PI);
            if (phys && body) phys.setRotation(id, [q.x, q.y, q.z, q.w]);
            else ctx.object.quaternion.copy(q);
          } else if (len > 0.05) {
            faceTowards(ctx, dx, dz, dt, 12);
            if (phys && body) {
              const q = ctx.object.quaternion;
              phys.setRotation(id, [q.x, q.y, q.z, q.w]);
            }
          }
          // 落下して世界の外に出たら
          const p = rt.worldPosition(id, _v);
          if (p.y < -40) rt.damage(id, Number.POSITIVE_INFINITY);
        },
      };
    },
  });

  // ------------------------------------------------------------------
  // HP
  // ------------------------------------------------------------------
  registerComponent({
    type: 'health',
    label: 'HP (体力)',
    icon: 'heart',
    description: 'ダメージを受けると減り、0 になると倒れます (プレイヤーは残機を減らして復活)',
    category: 'gameplay',
    defaults: () => ({ maxHp: 100, invincibleTime: 1, score: 0 }),
    schema: [
      { key: 'maxHp', label: '最大 HP', type: 'number', min: 1, max: 99999, step: 1 },
      { key: 'invincibleTime', label: 'ダメージ後の無敵時間', type: 'number', min: 0, max: 10, step: 0.1, unit: '秒' },
      { key: 'score', label: '倒したときのスコア', type: 'number', min: 0, max: 999999, step: 10 },
    ],
    // HP の管理はランタイムが行う (ダメージ・回復・倒れたときの処理)
  });

  // ------------------------------------------------------------------
  // 敵
  // ------------------------------------------------------------------
  registerComponent({
    type: 'enemy',
    label: '敵',
    icon: 'enemy',
    description: '近づくとプレイヤーを追いかけ、触れるとダメージ。上から踏む・攻撃すると倒せます',
    category: 'gameplay',
    defaults: () => ({ speed: 2, detectRange: 8, damage: 10, patrol: 3, stompable: true }),
    schema: [
      { key: 'speed', label: '移動の速さ', type: 'number', min: 0, max: 50, step: 0.5, unit: 'm/秒' },
      { key: 'detectRange', label: '気づく距離', type: 'number', min: 0, max: 200, step: 0.5, unit: 'm' },
      { key: 'damage', label: '攻撃力', type: 'number', min: 0, max: 9999, step: 1 },
      { key: 'patrol', label: '見回りの幅 (0 = 止まる)', type: 'number', min: 0, max: 100, step: 0.5, unit: 'm' },
      { key: 'stompable', label: '踏んで倒せる', type: 'boolean' },
    ],
    create(ctx, props) {
      const rt = ctx.runtime;
      const id = ctx.entity.id;
      const speed = Math.max(0, num(props.speed, 2));
      const detect = Math.max(0, num(props.detectRange, 8));
      const damage = num(props.damage, 10);
      const patrol = Math.max(0, num(props.patrol, 3));
      const stompable = bool(props.stompable, true);
      const home = new Vector3();
      let dir = 1;
      let chasing = false;
      return {
        start() {
          rt.worldPosition(id, home);
        },
        update(dt) {
          const phys = rt.physics;
          const body = !!phys?.bodies.get(id);
          const me = rt.worldPosition(id, new Vector3());
          const player = rt.playerId && !rt.isDestroyed(rt.playerId) ? rt.playerId : null;
          let tx = 0;
          let tz = 0;
          if (player) {
            const pp = rt.worldPosition(player, _w);
            const dist = Math.hypot(pp.x - me.x, pp.z - me.z);
            const was = chasing;
            chasing = dist < (chasing ? detect * 1.5 : detect);
            if (chasing && !was) rt.emit('enemy-notice', id);
            if (chasing && dist > 0.2) {
              tx = (pp.x - me.x) / dist;
              tz = (pp.z - me.z) / dist;
            }
            // 触れたとき: 上から踏まれたら倒れる、それ以外はプレイヤーにダメージ
            if (rt.overlaps(id, player, 0.06)) {
              const pBottom = rt.bounds(player).min.y;
              const eBox = rt.bounds(id);
              const eMid = (eBox.min.y + eBox.max.y) / 2;
              if (stompable && pBottom > eMid + (eBox.max.y - eBox.min.y) * 0.15) {
                rt.damage(id, Number.POSITIVE_INFINITY, player);
                rt.bouncePlayer(7);
                rt.emit('stomped', id);
                return;
              }
              const push = new Vector3(pp.x - me.x, 0, pp.z - me.z);
              if (push.lengthSq() < 1e-6) push.set(0, 0, 1);
              push.normalize();
              if (rt.damage(player, damage, id)) rt.knockbackPlayer([push.x, 0, push.z], 5);
            }
          }
          if (!chasing && patrol > 0) {
            const off = me.x - home.x;
            if (off > patrol) dir = -1;
            else if (off < -patrol) dir = 1;
            tx = dir;
            tz = 0;
          }
          const moving = Math.hypot(tx, tz) > 0.01;
          const s = chasing ? speed : speed * 0.6;
          if (phys && body) {
            const v = phys.getVelocity(id) ?? [0, 0, 0];
            phys.setVelocity(id, [tx * s, v[1], tz * s]);
          } else if (moving) {
            ctx.object.position.x += tx * s * dt;
            ctx.object.position.z += tz * s * dt;
          }
          if (moving) {
            faceTowards(ctx, tx, tz, dt, 8);
            if (phys && body) {
              const q = ctx.object.quaternion;
              phys.setRotation(id, [q.x, q.y, q.z, q.w]);
            }
          }
        },
      };
    },
  });

  // ------------------------------------------------------------------
  // NPC (話す人)
  // ------------------------------------------------------------------
  registerComponent({
    type: 'npc',
    label: 'NPC (会話)',
    icon: 'chat',
    description: 'プレイヤーが近づくと「話す」ボタンで会話できます。空行または「|」でページを区切ります',
    category: 'gameplay',
    defaults: () => ({ message: 'こんにちは！\n\nいい天気ですね。', talkRange: 2.5, facePlayer: true }),
    schema: [
      { key: 'message', label: 'セリフ', type: 'text', hint: '空行でページを区切る' },
      { key: 'talkRange', label: '話せる距離', type: 'number', min: 0.5, max: 50, step: 0.5, unit: 'm' },
      { key: 'facePlayer', label: 'プレイヤーの方を向く', type: 'boolean' },
    ],
    create(ctx, props) {
      const rt = ctx.runtime;
      const id = ctx.entity.id;
      const pages = splitPages(str(props.message, ''));
      const range = num(props.talkRange, 2.5);
      const face = bool(props.facePlayer, true);
      return {
        update(dt) {
          const player = rt.playerId;
          if (!player || rt.isDestroyed(player)) return;
          const me = rt.worldPosition(id, new Vector3());
          const pp = rt.worldPosition(player, _w);
          const dist = Math.hypot(pp.x - me.x, pp.z - me.z);
          if (dist > range) return;
          if (face && dist > 0.1) faceTowards(ctx, pp.x - me.x, pp.z - me.z, dt, 6);
          rt.offerInteraction(id, '話す', dist, () => {
            rt.emit('talk', id);
            void rt.talk(ctx.entity.name, pages.length > 0 ? pages : ['……']);
          });
        },
      };
    },
  });

  // ------------------------------------------------------------------
  // アイテム
  // ------------------------------------------------------------------
  registerComponent({
    type: 'item',
    label: 'アイテム',
    icon: 'coin',
    description: 'プレイヤーが触れると拾えます (お金・スコア・回復・持ち物)',
    category: 'gameplay',
    defaults: () => ({ kind: 'coin', value: 1, itemName: '鍵', spin: true, sound: '' }),
    schema: [
      {
        key: 'kind',
        label: '種類',
        type: 'select',
        options: [
          { value: 'coin', label: 'お金' },
          { value: 'score', label: 'スコア' },
          { value: 'heal', label: 'HP 回復' },
          { value: 'item', label: '持ち物' },
        ],
      },
      { key: 'value', label: '量', type: 'number', min: 0, max: 999999, step: 1 },
      { key: 'itemName', label: '持ち物の名前', type: 'string', hint: '種類が「持ち物」のとき' },
      { key: 'spin', label: 'くるくる回る', type: 'boolean' },
      { key: 'sound', label: '拾ったときの音', type: 'sound', hint: '未設定なら種類に合った音' },
    ],
    create(ctx, props) {
      const rt = ctx.runtime;
      const id = ctx.entity.id;
      const kind = str(props.kind, 'coin');
      const value = num(props.value, 1);
      const name = str(props.itemName, 'アイテム') || 'アイテム';
      const spin = bool(props.spin, true);
      const sound = str(props.sound, '');
      let baseY = 0;
      const phase = Math.random() * Math.PI * 2;
      return {
        start() {
          baseY = ctx.object.position.y;
        },
        update(dt, time) {
          if (spin) {
            ctx.object.rotateOnWorldAxis(UP, dt * 2.4);
            ctx.object.position.y = baseY + Math.sin(time * 3 + phase) * 0.08;
          }
          const player = rt.playerId;
          if (!player || rt.isDestroyed(player) || !rt.overlaps(id, player, 0.05)) return;
          const s = rt.state;
          switch (kind) {
            case 'heal': {
              if (!rt.heal(player, value)) return; // HP が満タンなら拾わない
              rt.playSound(sound || 'builtin:heal');
              break;
            }
            case 'score':
              s.addScore(value);
              rt.playSound(sound || 'builtin:coin');
              break;
            case 'item':
              s.addItem(name, Math.max(1, Math.round(value)));
              rt.playSound(sound || 'builtin:item');
              rt.toast(`${name}を手に入れた！`);
              break;
            default:
              s.addMoney(value);
              rt.playSound(sound || 'builtin:coin');
          }
          rt.emit('pickup', id, { kind, value, name });
          rt.destroyEntity(id, 'pop');
        },
      };
    },
  });

  // ------------------------------------------------------------------
  // ダメージ床・トゲ
  // ------------------------------------------------------------------
  registerComponent({
    type: 'damage',
    label: 'ダメージ (触れると痛い)',
    icon: 'alert',
    description: 'プレイヤーが触れると HP が減ります (トゲ・溶岩など)',
    category: 'gameplay',
    defaults: () => ({ amount: 20, knockback: true }),
    schema: [
      { key: 'amount', label: 'ダメージ量', type: 'number', min: 0, max: 99999, step: 1 },
      { key: 'knockback', label: '弾き飛ばす', type: 'boolean' },
    ],
    create(ctx, props) {
      const rt = ctx.runtime;
      const id = ctx.entity.id;
      const amount = num(props.amount, 20);
      const knock = bool(props.knockback, true);
      return {
        update() {
          const player = rt.playerId;
          if (!player || rt.isDestroyed(player) || !rt.overlaps(id, player, 0.06)) return;
          if (rt.damage(player, amount, id) && knock) {
            const me = rt.worldPosition(id, new Vector3());
            const pp = rt.worldPosition(player, _w);
            const d = new Vector3(pp.x - me.x, 0, pp.z - me.z);
            if (d.lengthSq() < 1e-6) d.set(0, 0, 1);
            d.normalize();
            rt.knockbackPlayer([d.x, 0, d.z], 4);
          }
        },
      };
    },
  });

  // ------------------------------------------------------------------
  // セーブポイント
  // ------------------------------------------------------------------
  registerComponent({
    type: 'savepoint',
    label: 'セーブポイント',
    icon: 'flag',
    description: '触れると復活地点を記録します。「端末に保存」でタイトル画面の「つづきから」で再開できます',
    category: 'gameplay',
    defaults: () => ({ persist: true, message: 'セーブしました' }),
    schema: [
      { key: 'persist', label: '端末に保存', type: 'boolean' },
      { key: 'message', label: 'メッセージ', type: 'string' },
    ],
    create(ctx, props) {
      const rt = ctx.runtime;
      const id = ctx.entity.id;
      const persist = bool(props.persist, true);
      const message = str(props.message, 'セーブしました');
      let inside = false;
      return {
        update() {
          const player = rt.playerId;
          if (!player || rt.isDestroyed(player)) return;
          const now = rt.overlaps(id, player, 0.15);
          if (now && !inside) {
            const box = rt.bounds(id);
            const c = rt.worldPosition(id, new Vector3());
            const pos: Vec3 = [c.x, box.max.y + 1, c.z];
            rt.saveCheckpoint(pos, persist);
            rt.playSound('builtin:save');
            if (message) rt.toast(message);
            rt.emit('save', id);
          }
          inside = now;
        },
      };
    },
  });

  // ------------------------------------------------------------------
  // ゴール
  // ------------------------------------------------------------------
  registerComponent({
    type: 'goal',
    label: 'ゴール',
    icon: 'trophy',
    description: 'プレイヤーが触れるとゲームクリア。必要な持ち物を指定すると、持っていないと通れません',
    category: 'gameplay',
    defaults: () => ({ message: 'ゲームクリア！', requireItem: '', requireScore: 0 }),
    schema: [
      { key: 'message', label: 'クリアのメッセージ', type: 'string' },
      { key: 'requireItem', label: '必要な持ち物', type: 'string', hint: '空欄なら不要' },
      { key: 'requireScore', label: '必要なスコア', type: 'number', min: 0, max: 999999, step: 10 },
    ],
    create(ctx, props) {
      const rt = ctx.runtime;
      const id = ctx.entity.id;
      const message = str(props.message, 'ゲームクリア！');
      const requireItem = str(props.requireItem, '').trim();
      const requireScore = num(props.requireScore, 0);
      let warned = false;
      return {
        update() {
          const player = rt.playerId;
          if (!player || rt.isDestroyed(player)) return;
          const touching = rt.overlaps(id, player, 0.1);
          if (!touching) {
            warned = false;
            return;
          }
          const s = rt.state;
          if (requireItem && !s.hasItem(requireItem)) {
            if (!warned) rt.toast(`${requireItem}が必要です`);
            warned = true;
            return;
          }
          if (requireScore > 0 && s.score < requireScore) {
            if (!warned) rt.toast(`スコアが ${requireScore} 必要です`);
            warned = true;
            return;
          }
          rt.emit('goal', id);
          rt.gameClear(message);
        },
      };
    },
  });

  // ------------------------------------------------------------------
  // 効果音
  // ------------------------------------------------------------------
  registerComponent({
    type: 'sound',
    label: '効果音',
    icon: 'volume',
    description: 'Play 開始時 (または指定の秒数後) に音を鳴らします。くり返しも可能',
    category: 'audio',
    defaults: () => ({ sound: 'builtin:powerup', volume: 1, delay: 0, repeat: 0 }),
    schema: [
      { key: 'sound', label: '音', type: 'sound' },
      { key: 'volume', label: '音量', type: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'delay', label: '鳴らすまでの時間', type: 'number', min: 0, max: 3600, step: 0.5, unit: '秒' },
      { key: 'repeat', label: 'くり返す間隔 (0 = 1回だけ)', type: 'number', min: 0, max: 3600, step: 0.5, unit: '秒' },
    ],
    create(ctx, props) {
      const rt = ctx.runtime;
      const sound = str(props.sound, '');
      const volume = Math.max(0, Math.min(1, num(props.volume, 1)));
      const repeat = Math.max(0, num(props.repeat, 0));
      let next = Math.max(0, num(props.delay, 0));
      let t = 0;
      let done = false;
      return {
        update(dt) {
          if (done) return;
          t += dt;
          if (t < next) return;
          rt.playSound(sound, volume);
          if (repeat > 0) next += repeat;
          else done = true;
        },
      };
    },
  });
}
