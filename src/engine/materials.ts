import { DoubleSide, FrontSide, MathUtils, MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Vector2 } from 'three';
import type { Material, Texture } from 'three';
import type { QualityLevel } from '../core/settings';
import type { MaterialData, PrimitiveShape } from '../core/types';
import { acquireTexture, releaseTexture } from './textures';

/**
 * MaterialData から Three.js のマテリアルを作る。
 * プリセットごとにシェーダー (マテリアルの種類) を切り替え、
 * 重い表現 (ガラスの屈折) は画質「高」のときだけ使う。
 */

/** 全マテリアルで共有する時間 (水の波などのアニメーション用) */
export const sharedUniforms = {
  uTime: { value: 0 },
};

export interface MaterialOptions {
  quality: QualityLevel;
}

/** マテリアルを作り直す必要があるかを判定するための署名 */
export function materialSignature(m: MaterialData, shape: PrimitiveShape, opts: MaterialOptions): string {
  const glassMode = m.preset === 'glass' ? (opts.quality === 'high' ? 'refract' : 'simple') : '';
  return `${m.preset}:${glassMode}:${shape === 'plane' ? 'p' : ''}`;
}

/** 水の表面を波打たせるシェーダーの追加コード */
function applyWaterShader(mat: MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = sharedUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform float uTime;
        varying vec3 vWaterWorld;
        float waterHeight(vec2 p) {
          return sin(p.x * 0.35 + uTime * 1.1) * 0.035
               + sin(p.y * 0.42 - uTime * 0.9) * 0.03
               + sin((p.x + p.y) * 0.9 + uTime * 1.7) * 0.012;
        }`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        vec4 wWorld = modelMatrix * vec4(transformed, 1.0);
        transformed.y += waterHeight(wWorld.xz);
        vWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `#include <beginnormal_vertex>
        {
          vec2 wp = (modelMatrix * vec4(position, 1.0)).xz;
          float e = 0.1;
          float hx = waterHeight(wp + vec2(e, 0.0)) - waterHeight(wp - vec2(e, 0.0));
          float hz = waterHeight(wp + vec2(0.0, e)) - waterHeight(wp - vec2(0.0, e));
          objectNormal = normalize(vec3(-hx / (2.0 * e), 1.0, -hz / (2.0 * e)));
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform float uTime;
        varying vec3 vWaterWorld;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        {
          // 細かいさざ波 (法線を揺らす)
          vec2 p = vWaterWorld.xz;
          float r1 = sin(p.x * 3.1 + uTime * 2.3) * cos(p.y * 2.7 - uTime * 1.9);
          float r2 = sin(p.x * 5.3 - uTime * 3.1 + p.y * 1.7) * 0.5;
          vec3 ripple = vec3(r1 * 0.12 + r2 * 0.06, 0.0, cos(p.y * 3.3 + uTime * 2.0) * 0.1);
          normal = normalize(normal + (viewMatrix * vec4(ripple, 0.0)).xyz);
        }`,
      )
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `// 斜めから見るほど不透明に (フレネル)
        {
          vec3 viewDir = normalize(vViewPosition);
          float fres = pow(1.0 - clamp(abs(dot(normal, viewDir)), 0.0, 1.0), 3.0);
          diffuseColor.a = clamp(diffuseColor.a + fres * 0.5, 0.0, 1.0);
        }
        #include <opaque_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => 'pocket-water';
}

export function createMaterial(m: MaterialData, shape: PrimitiveShape, opts: MaterialOptions): Material {
  const side = shape === 'plane' ? DoubleSide : FrontSide;
  let mat: Material;
  switch (m.preset) {
    case 'unlit':
      mat = new MeshBasicMaterial({ side });
      break;
    case 'glass': {
      const refract = opts.quality === 'high';
      const g = new MeshPhysicalMaterial({
        side,
        ior: 1.5,
        thickness: 0.4,
        clearcoat: 1,
        clearcoatRoughness: 0.05,
        specularIntensity: 1,
      });
      // 屈折 (transmission) は描画負荷が高いので画質「高」のみ
      if (refract) g.transmission = 1;
      g.userData.refract = refract;
      mat = g;
      break;
    }
    case 'water': {
      const w = new MeshStandardMaterial({ side: DoubleSide });
      applyWaterShader(w);
      mat = w;
      break;
    }
    default:
      mat = new MeshStandardMaterial({ side });
  }
  mat.userData.mapKey = null;
  return mat;
}

function mapKeyFor(m: MaterialData): string | null {
  if (m.texture) return `asset:${m.texture}`;
  if (m.pattern && m.pattern !== 'none') return `pattern:${m.pattern}`;
  return null;
}

const _center = new Vector2(0.5, 0.5);

function applyUv(tex: Texture, m: MaterialData): void {
  tex.repeat.set(m.uvScale[0] || 1, m.uvScale[1] || 1);
  tex.offset.set(m.uvOffset[0], m.uvOffset[1]);
  tex.center.copy(_center);
  tex.rotation = MathUtils.degToRad(m.uvRotation);
}

/** データの値をマテリアルに反映する */
export function updateMaterial(mat: Material, m: MaterialData): void {
  const anyMat = mat as MeshStandardMaterial & MeshPhysicalMaterial;
  // テクスチャ (模様 / 画像)
  const key = mapKeyFor(m);
  if (mat.userData.mapKey !== key) {
    releaseTexture(anyMat.map);
    anyMat.map = key ? acquireTexture(key) : null;
    mat.userData.mapKey = key;
    mat.needsUpdate = true;
  }
  if (anyMat.map) applyUv(anyMat.map, m);

  const refract = mat.userData.refract === true;
  let opacity = m.opacity;
  // 屈折ガラスは透過で表現するので不透明度は 1 に近づける
  if (m.preset === 'glass' && refract) opacity = Math.max(0.85, m.opacity);
  const transparent = opacity < 0.999 || m.preset === 'water' || (m.preset === 'glass' && !refract);

  if (mat instanceof MeshStandardMaterial) {
    mat.color.set(m.color);
    mat.roughness = m.roughness;
    mat.metalness = m.metalness;
    mat.emissive.set(m.emissive);
    mat.emissiveIntensity = m.emissiveIntensity;
    mat.envMapIntensity = m.envIntensity;
    mat.wireframe = m.wireframe;
    if (mat instanceof MeshPhysicalMaterial && refract) {
      mat.transmission = MathUtils.clamp(1.15 - m.opacity, 0.2, 1);
      mat.attenuationColor.set(m.color);
    }
  } else if (mat instanceof MeshBasicMaterial) {
    mat.color.set(m.color);
    mat.wireframe = m.wireframe;
  }
  if (mat.transparent !== transparent) {
    mat.transparent = transparent;
    mat.needsUpdate = true;
  }
  mat.opacity = opacity;
  mat.depthWrite = !transparent || m.preset === 'water';
}

/** マテリアルと使用中のテクスチャを解放する */
export function disposeMaterial(mat: Material): void {
  const anyMat = mat as MeshStandardMaterial;
  releaseTexture(anyMat.map);
  anyMat.map = null;
  mat.dispose();
}
