import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, NormalBlending, Points, ShaderMaterial, Vector3 } from 'three';
import type { Camera } from 'three';
import type { QualityLevel } from '../core/settings';
import type { WeatherData } from '../core/types';

/**
 * 雨・雪の表現。
 * 粒子の位置は頂点シェーダーで時間から計算するので、CPU の負荷はほぼゼロ。
 * カメラの周りの箱の中だけに降らせ、カメラが動いても途切れないように座標を折り返す。
 */

const BOX = new Vector3(36, 22, 36);

const COUNTS: Record<'rain' | 'snow', Record<QualityLevel, number>> = {
  rain: { low: 500, medium: 1200, high: 2400 },
  snow: { low: 400, medium: 900, high: 1800 },
};

export class WeatherEffect {
  readonly points: Points<BufferGeometry, ShaderMaterial>;
  readonly type: 'rain' | 'snow';

  constructor(data: WeatherData, quality: QualityLevel) {
    this.type = data.type === 'snow' ? 'snow' : 'rain';
    const intensity = Math.max(0.05, Math.min(1, data.intensity));
    const count = Math.max(50, Math.round(COUNTS[this.type][quality] * intensity));
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = Math.random() * BOX.x;
      positions[i * 3 + 1] = Math.random() * BOX.y;
      positions[i * 3 + 2] = Math.random() * BOX.z;
      seeds[i] = Math.random();
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));
    const rain = this.type === 'rain';
    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: rain ? NormalBlending : AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uCamera: { value: new Vector3() },
        uBox: { value: BOX.clone() },
        uSpeed: { value: rain ? 16 : 1.6 },
        uSize: { value: rain ? 26 : 16 },
        uColor: { value: new Color(rain ? '#a9c7e8' : '#ffffff') },
        uOpacity: { value: rain ? 0.55 : 0.85 },
        uSnow: { value: rain ? 0 : 1 },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime;
        uniform vec3 uCamera;
        uniform vec3 uBox;
        uniform float uSpeed;
        uniform float uSize;
        uniform float uSnow;
        varying float vAlpha;
        void main() {
          vec3 p = position;
          float speed = uSpeed * (0.75 + aSeed * 0.5);
          p.y = mod(p.y - uTime * speed, uBox.y);
          // 雪は左右に揺らす
          p.x += uSnow * sin(uTime * (0.6 + aSeed) + aSeed * 30.0) * 0.8;
          p.z += uSnow * cos(uTime * (0.5 + aSeed) + aSeed * 20.0) * 0.8;
          // カメラを中心に箱を折り返す
          vec3 origin = uCamera - uBox * vec3(0.5, 0.35, 0.5);
          vec3 world = origin + mod(p - origin, uBox);
          vec4 mv = viewMatrix * vec4(world, 1.0);
          gl_Position = projectionMatrix * mv;
          float dist = max(1.0, -mv.z);
          gl_PointSize = uSize * (0.6 + aSeed * 0.8) / dist * 6.0;
          vAlpha = smoothstep(uBox.x * 0.55, uBox.x * 0.2, dist);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uSnow;
        varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float a;
          if (uSnow > 0.5) {
            a = smoothstep(0.5, 0.15, length(c));
          } else {
            // 縦長の細い線 (雨粒)
            a = smoothstep(0.06, 0.0, abs(c.x)) * smoothstep(0.5, 0.2, abs(c.y));
          }
          a *= uOpacity * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor, a);
        }
      `,
    });
    this.points = new Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.points.name = '__weather';
    this.points.userData.noPick = true;
  }

  update(time: number, camera: Camera): void {
    const u = this.points.material.uniforms;
    u.uTime.value = time;
    camera.getWorldPosition(u.uCamera.value);
  }

  dispose(): void {
    this.points.removeFromParent();
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
