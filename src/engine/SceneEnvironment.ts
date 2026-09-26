import {
  CanvasTexture,
  Color,
  CubeCamera,
  DirectionalLight,
  EquirectangularReflectionMapping,
  Fog,
  HalfFloatType,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLCubeRenderTarget,
} from 'three';
import type { Camera, Object3D, Texture, WebGLRenderer, WebGLRenderTarget } from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { QualityLevel } from '../core/settings';
import type { EnvironmentData } from '../core/types';
import { WeatherEffect } from './Weather';

/**
 * シーンの環境 (空・霧・映り込み・天候・露出) を管理する。
 * エディタのビューポートと Play Mode の両方で使う。
 *
 * 空の画像と映り込み用の環境マップは「設定や太陽の向きが変わったときだけ」作り直す。
 * (毎フレーム作ると重いため)
 */

const DEFAULT_SUN = new Vector3(0.45, 0.75, 0.35).normalize();

/** シーン内の最初の太陽光 (DirectionalLight) の「太陽のある方向」 */
export function findSunDirection(root: Object3D): Vector3 | null {
  let dir: Vector3 | null = null;
  root.traverseVisible((o) => {
    if (dir || !(o instanceof DirectionalLight)) return;
    o.updateWorldMatrix(true, false);
    o.target.updateWorldMatrix(true, false);
    const from = new Vector3().setFromMatrixPosition(o.matrixWorld);
    const to = new Vector3().setFromMatrixPosition(o.target.matrixWorld);
    const d = from.sub(to);
    if (d.lengthSq() > 1e-8) dir = d.normalize();
  });
  return dir;
}

function hexToVec(hex: string): [number, number, number] {
  const c = new Color(hex);
  // Canvas は sRGB で描くので sRGB の値を使う
  return [c.r, c.g, c.b].map((v) => Math.pow(v, 1 / 2.2)) as [number, number, number];
}

/** 空のグラデーション (+ 太陽の光) を正距円筒図法の画像として描く */
function drawGradientSky(top: string, horizon: string, bottom: string, sun: Vector3, withSun: boolean): HTMLCanvasElement {
  const w = 512;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const T = hexToVec(top);
  const H = hexToVec(horizon);
  const B = hexToVec(bottom);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const v = 1 - (y + 0.5) / h;
    const lat = (v - 0.5) * Math.PI;
    const sy = Math.sin(lat);
    const cl = Math.cos(lat);
    let base: [number, number, number];
    if (sy >= 0) {
      const t = Math.pow(sy, 0.55);
      base = [H[0] + (T[0] - H[0]) * t, H[1] + (T[1] - H[1]) * t, H[2] + (T[2] - H[2]) * t];
    } else {
      const t = Math.min(1, Math.pow(-sy, 0.4) * 1.2);
      base = [H[0] + (B[0] - H[0]) * t, H[1] + (B[1] - H[1]) * t, H[2] + (B[2] - H[2]) * t];
    }
    for (let x = 0; x < w; x++) {
      let r = base[0];
      let g = base[1];
      let b = base[2];
      if (withSun) {
        const lon = ((x + 0.5) / w - 0.5) * Math.PI * 2;
        const dx = cl * Math.cos(lon);
        const dz = cl * Math.sin(lon);
        const dot = dx * sun.x + sy * sun.y + dz * sun.z;
        if (dot > 0) {
          const glow = Math.pow(dot, 12) * 0.35 + Math.pow(dot, 180) * 0.6 + (dot > 0.9994 ? 1 : 0);
          r += glow;
          g += glow * 0.95;
          b += glow * 0.8;
        }
      }
      const i = (y * w + x) * 4;
      d[i] = Math.min(255, r * 255);
      d[i + 1] = Math.min(255, g * 255);
      d[i + 2] = Math.min(255, b * 255);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function lighten(hex: string, k: number): string {
  const c = new Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.max(0, Math.min(1, hsl.l + k)));
  return `#${c.getHexString()}`;
}

export class SceneEnvironment {
  private pmrem: PMREMGenerator;
  private envTarget: WebGLRenderTarget | null = null;
  private bgTexture: Texture | null = null;
  private cubeTarget: WebGLCubeRenderTarget | null = null;
  private skyKey = '';
  private weatherKey = '';
  private weather: WeatherEffect | null = null;
  private data: EnvironmentData | null = null;
  private sunDir = DEFAULT_SUN.clone();
  /** エディタでは天候を表示しない設定にできる */
  weatherVisible = true;

  constructor(
    private scene: Scene,
    private renderer: WebGLRenderer,
    private quality: QualityLevel,
  ) {
    this.pmrem = new PMREMGenerator(renderer);
  }

  setQuality(q: QualityLevel): void {
    if (this.quality === q) return;
    this.quality = q;
    this.skyKey = '';
    this.weatherKey = '';
    if (this.data) this.apply(this.data, this.sunDir);
  }

  setWeatherVisible(v: boolean): void {
    if (this.weatherVisible === v) return;
    this.weatherVisible = v;
    this.weatherKey = '';
    if (this.data) this.apply(this.data, this.sunDir);
  }

  /** 環境設定を反映する。sun は太陽のある方向 (無ければ既定値) */
  apply(env: EnvironmentData, sun?: Vector3 | null): void {
    this.data = env;
    if (sun) this.sunDir.copy(sun);
    else this.sunDir.copy(DEFAULT_SUN);
    this.renderer.toneMappingExposure = env.exposure;

    // 霧
    if (env.fog.enabled) {
      const near = Math.max(0, env.fog.near);
      const far = Math.max(near + 1, env.fog.far);
      if (this.scene.fog instanceof Fog) {
        this.scene.fog.color.set(env.fog.color);
        this.scene.fog.near = near;
        this.scene.fog.far = far;
      } else {
        this.scene.fog = new Fog(env.fog.color, near, far);
      }
    } else {
      this.scene.fog = null;
    }

    // 空と映り込み (変化があったときだけ作り直す)
    const s = this.sunDir;
    const key = JSON.stringify([env.sky, env.background, env.reflections, this.quality, [s.x, s.y, s.z].map((v) => v.toFixed(2))]);
    if (key !== this.skyKey) {
      this.skyKey = key;
      this.rebuildSky(env);
    }

    // 天候
    const wKey = `${env.weather.type}:${env.weather.intensity.toFixed(2)}:${this.quality}:${this.weatherVisible}`;
    if (wKey !== this.weatherKey) {
      this.weatherKey = wKey;
      this.weather?.dispose();
      this.weather = null;
      if (env.weather.type !== 'none' && this.weatherVisible) {
        this.weather = new WeatherEffect(env.weather, this.quality);
        this.scene.add(this.weather.points);
      }
    }
  }

  get hasAnimatedWeather(): boolean {
    return this.weather !== null;
  }

  private disposeSky(): void {
    this.envTarget?.dispose();
    this.envTarget = null;
    this.bgTexture?.dispose();
    this.bgTexture = null;
    this.cubeTarget?.dispose();
    this.cubeTarget = null;
  }

  private rebuildSky(env: EnvironmentData): void {
    this.disposeSky();
    const sky = env.sky;
    // リアルな空は非常に明るい (HDR) ため、背景と映り込みの強さを抑える
    const physical = sky.type === 'physical';
    this.scene.backgroundIntensity = physical ? 0.35 : 1;
    this.scene.environmentIntensity = physical ? 0.12 : 1;
    try {
      if (sky.type === 'physical') {
        this.buildPhysicalSky(env);
        return;
      }
      let canvas: HTMLCanvasElement;
      if (sky.type === 'gradient') {
        canvas = drawGradientSky(sky.topColor, sky.horizonColor, sky.bottomColor, this.sunDir, true);
      } else {
        // 単色の空: 背景は単色、映り込み用には同系色のグラデーションを使う
        canvas = drawGradientSky(lighten(env.background, 0.12), env.background, lighten(env.background, -0.1), this.sunDir, false);
      }
      const tex = new CanvasTexture(canvas);
      tex.mapping = EquirectangularReflectionMapping;
      tex.colorSpace = SRGBColorSpace;
      this.bgTexture = tex;
      this.scene.background = sky.type === 'color' ? new Color(env.background) : tex;
      if (env.reflections) {
        this.envTarget = this.pmrem.fromEquirectangular(tex);
        this.scene.environment = this.envTarget.texture;
      } else {
        this.scene.environment = null;
      }
    } catch (err) {
      console.warn('[PocketEngine] 空の生成に失敗しました', err);
      this.scene.background = new Color(env.background);
      this.scene.environment = null;
    }
  }

  private buildPhysicalSky(env: EnvironmentData): void {
    const size = this.quality === 'low' ? 128 : this.quality === 'medium' ? 256 : 512;
    const skyScene = new Scene();
    const sky = new Sky();
    sky.scale.setScalar(1000);
    const u = sky.material.uniforms;
    u.turbidity.value = Math.max(1, Math.min(20, env.sky.turbidity));
    u.rayleigh.value = 1.6;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.8;
    u.sunPosition.value.copy(this.sunDir).multiplyScalar(100);
    skyScene.add(sky);
    const target = new WebGLCubeRenderTarget(size, { type: HalfFloatType });
    const cam = new CubeCamera(1, 5000, target);
    cam.update(this.renderer, skyScene);
    this.cubeTarget = target;
    this.scene.background = target.texture;
    if (env.reflections) {
      this.envTarget = this.pmrem.fromScene(skyScene, 0, 1, 5000);
      this.scene.environment = this.envTarget.texture;
    } else {
      this.scene.environment = null;
    }
    sky.geometry.dispose();
    sky.material.dispose();
  }

  /** 毎フレームの更新 (天候の粒子をカメラに追従させる) */
  update(time: number, camera: Camera): void {
    this.weather?.update(time, camera);
  }

  dispose(): void {
    this.weather?.dispose();
    this.weather = null;
    this.disposeSky();
    this.pmrem.dispose();
    this.scene.fog = null;
    this.scene.environment = null;
  }
}
