import {
  AmbientLight,
  CanvasTexture,
  Color,
  CubeCamera,
  DirectionalLight,
  EquirectangularReflectionMapping,
  Fog,
  HalfFloatType,
  HemisphereLight,
  PMREMGenerator,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLCubeRenderTarget,
} from 'three';
import type { BufferGeometry, Camera, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, Points, ShaderMaterial, Texture, WebGLRenderer, WebGLRenderTarget } from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { QualityLevel } from '../core/settings';
import type { EnvironmentData } from '../core/types';
import { WeatherEffect } from './Weather';
import { createBolt, createClouds, createMoon, createStars, daylight, nightness, skyColorsAt, sunColorAt, sunDirectionAt, updateClouds } from './sky';

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
  /** 時刻で向きを変える太陽光を探す場所 (シーンのルート) */
  private lightRoot: Object3D | null = null;
  /** Play 中の時刻 (null = 設定の時刻) */
  private hourOverride: number | null = null;
  private stars: Points<BufferGeometry, ShaderMaterial> | null = null;
  private moon: Mesh<PlaneGeometry, MeshBasicMaterial> | null = null;
  private clouds: Mesh<PlaneGeometry, ShaderMaterial> | null = null;
  private cloudDrift = 0;
  private lastTime = 0;
  private lastSkyBuild = -1;
  private timeDriven = false;
  /** 空の色 (時刻に合わせた色。背景・霧に使う) */
  private currentSky = { top: '#3d7fd6', horizon: '#c9dff2', bottom: '#5b6270' };
  // 雷
  private flashLight: HemisphereLight | null = null;
  private bolt: Line<BufferGeometry, LineBasicMaterial> | null = null;
  private nextStrike = 0;
  private strikeAt = -1;
  /** 雷が落ちた回数 (テスト・デバッグ用) */
  strikes = 0;
  /** 雷が落ちたとき (音を鳴らすため)。distance はカメラからの距離 (m) */
  onLightning: ((distance: number) => void) | null = null;
  /** 時間の経過で動くもの (雲・星のまたたき・雷) を動かす */
  animate = true;

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
    this.removeStars();
    if (this.data) this.apply(this.data, this.sunDir);
  }

  setWeatherVisible(v: boolean): void {
    if (this.weatherVisible === v) return;
    this.weatherVisible = v;
    this.weatherKey = '';
    if (this.data) this.apply(this.data, this.sunDir);
  }

  /** 環境設定を反映する。sun は太陽のある方向 (無ければ既定値) */
  setLightRoot(root: Object3D): void {
    this.lightRoot = root;
  }

  /** 今の時刻 (0〜24) */
  get hour(): number {
    return this.hourOverride ?? this.data?.time.hour ?? 12;
  }

  /** Play 中に時刻を変える (太陽・空・明るさを更新する。空の作り直しは間引く) */
  setHour(h: number | null): void {
    this.hourOverride = h === null ? null : ((h % 24) + 24) % 24;
    if (!this.data?.time.enabled) return;
    sunDirectionAt(this.hour, this.data.time.sunDirection, this.sunDir);
    this.applyTime();
  }

  /** 太陽のある方向 (時刻を使っているときは時刻から) */
  get sunDirection(): Vector3 {
    return this.sunDir;
  }

  apply(env: EnvironmentData, sun?: Vector3 | null): void {
    this.data = env;
    if (env.time.enabled) sunDirectionAt(this.hour, env.time.sunDirection, this.sunDir);
    else if (sun) this.sunDir.copy(sun);
    else this.sunDir.copy(DEFAULT_SUN);
    this.renderer.toneMappingExposure = env.exposure;
    this.updateSkyColors();

    // 霧
    if (env.fog.enabled) {
      const near = Math.max(0, env.fog.near);
      const far = Math.max(near + 1, env.fog.far);
      const fogColor = env.time.enabled ? this.currentSky.horizon : env.fog.color;
      if (this.scene.fog instanceof Fog) {
        this.scene.fog.color.set(fogColor);
        this.scene.fog.near = near;
        this.scene.fog.far = far;
      } else {
        this.scene.fog = new Fog(fogColor, near, far);
      }
    } else {
      this.scene.fog = null;
    }

    // 空と映り込み (変化があったときだけ作り直す)
    const key = this.computeSkyKey(env);
    if (key !== this.skyKey) {
      this.skyKey = key;
      this.rebuildSky(env);
      this.lastSkyBuild = this.lastTime;
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

    // 星・月・雲
    const t = env.time;
    if (t.enabled && t.stars) {
      if (!this.stars) {
        this.stars = createStars(this.quality);
        this.scene.add(this.stars);
      }
    } else this.removeStars();
    if (t.enabled && t.moon) {
      if (!this.moon) {
        this.moon = createMoon();
        this.scene.add(this.moon);
      }
    } else if (this.moon) {
      this.moon.removeFromParent();
      this.moon.material.map?.dispose();
      this.moon.material.dispose();
      this.moon.geometry.dispose();
      this.moon = null;
    }
    if (env.clouds.enabled) {
      if (!this.clouds) {
        this.clouds = createClouds();
        this.scene.add(this.clouds);
      }
    } else if (this.clouds) {
      this.clouds.removeFromParent();
      this.clouds.material.dispose();
      this.clouds.geometry.dispose();
      this.clouds = null;
    }
    this.applyTime();
  }

  private computeSkyKey(env: EnvironmentData): string {
    const s = this.sunDir;
    return JSON.stringify([env.sky, env.background, env.reflections, env.time.enabled, this.currentSky, this.quality, [s.x, s.y, s.z].map((v) => v.toFixed(2))]);
  }

  private removeStars(): void {
    if (!this.stars) return;
    this.stars.removeFromParent();
    this.stars.geometry.dispose();
    this.stars.material.dispose();
    this.stars = null;
  }

  /** 時刻に合わせた空の色 */
  private updateSkyColors(): void {
    const env = this.data;
    if (!env) return;
    if (!env.time.enabled) {
      this.currentSky = { top: env.sky.topColor, horizon: env.sky.horizonColor, bottom: env.sky.bottomColor };
      return;
    }
    const day = env.sky.type === 'color' ? { top: env.background, horizon: env.background, bottom: env.background } : { top: env.sky.topColor, horizon: env.sky.horizonColor, bottom: env.sky.bottomColor };
    this.currentSky = skyColorsAt(this.sunDir.y, day);
  }

  /**
   * 時刻に合わせて太陽光の向き・色・明るさ、環境光の明るさ、星・月の見え方を変える。
   * (エディタで太陽光のデータを変えると SceneBuilder が元の値に戻すので、描画の前にも呼ぶ)
   */
  applyTime(): void {
    const env = this.data;
    const root = this.lightRoot;
    if (!env) return;
    const timeOn = env.time.enabled;
    const sunY = this.sunDir.y;
    const day = timeOn ? daylight(sunY) : 1;
    if (root && (timeOn || this.timeDriven)) {
      const moonDir = this.sunDir.clone().negate();
      const useMoon = timeOn && sunY < -0.02;
      const dir = useMoon ? moonDir : this.sunDir;
      const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir.clone().negate());
      const pq = new Quaternion();
      const anchor = new Vector3();
      root.traverse((o) => {
        const ud = o.userData;
        if (o instanceof DirectionalLight && ud.baseIntensity !== undefined) {
          if (!timeOn) {
            o.position.set(0, 0, 0);
            o.quaternion.identity();
            o.intensity = ud.baseIntensity;
            o.color.set(ud.baseColor);
            return;
          }
          const parent = o.parent;
          if (!parent) return;
          parent.updateWorldMatrix(true, false);
          parent.getWorldQuaternion(pq);
          o.quaternion.copy(pq.invert().multiply(q));
          // 影の範囲がオブジェクトの周りに来るよう、光源を方向の反対側に置く
          parent.getWorldPosition(anchor);
          const world = anchor.clone().addScaledVector(dir, 40);
          o.position.copy(parent.worldToLocal(world));
          if (useMoon) {
            o.intensity = ud.baseIntensity * 0.12 * (env.time.moon ? 1 : 0.4) * smooth01(-(sunY + 0.02) / 0.2);
            o.color.set('#9db4ff');
          } else {
            o.intensity = ud.baseIntensity * day;
            o.color.set(sunColorAt(sunY, ud.baseColor));
          }
        } else if ((o instanceof HemisphereLight || o instanceof AmbientLight) && ud.baseIntensity !== undefined && o !== this.flashLight) {
          o.intensity = ud.baseIntensity * (timeOn ? 0.18 + 0.82 * day : 1);
        }
      });
      this.timeDriven = timeOn;
    }
    // 映り込み・背景も夜は暗く
    const physical = env.sky.type === 'physical';
    const baseEnv = physical ? 0.12 : 1;
    this.scene.environmentIntensity = baseEnv * (timeOn ? 0.15 + 0.85 * day : 1);
    if (this.stars) this.stars.material.uniforms.uOpacity.value = timeOn ? nightness(sunY) : 0;
  }

  /** 時刻で変わる空の画像を作り直す (Play 中は間引く) */
  private refreshSkyIfNeeded(force = false): void {
    const env = this.data;
    if (!env?.time.enabled) return;
    this.updateSkyColors();
    const key = this.computeSkyKey(env);
    if (key === this.skyKey) return;
    const interval = this.quality === 'low' ? 1.5 : this.quality === 'medium' ? 0.8 : 0.5;
    if (!force && this.lastTime - this.lastSkyBuild < interval) return;
    this.skyKey = key;
    this.lastSkyBuild = this.lastTime;
    this.rebuildSky(env);
    if (this.scene.fog instanceof Fog) this.scene.fog.color.set(this.currentSky.horizon);
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
      const c = this.currentSky;
      const bg = env.time.enabled ? c.horizon : env.background;
      // 夜は太陽の光を描かない
      const sunVisible = !env.time.enabled || this.sunDir.y > -0.05;
      if (sky.type === 'gradient') {
        canvas = drawGradientSky(c.top, c.horizon, c.bottom, this.sunDir, sunVisible);
      } else {
        // 単色の空: 背景は単色、映り込み用には同系色のグラデーションを使う
        canvas = drawGradientSky(lighten(bg, 0.12), bg, lighten(bg, -0.1), this.sunDir, false);
      }
      const tex = new CanvasTexture(canvas);
      tex.mapping = EquirectangularReflectionMapping;
      tex.colorSpace = SRGBColorSpace;
      this.bgTexture = tex;
      this.scene.background = sky.type === 'color' ? new Color(bg) : tex;
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

  /** 毎フレームの更新 (天候の粒子・星・月・雲をカメラに追従させる、雷) */
  update(time: number, camera: Camera): void {
    const dt = this.lastTime ? Math.min(0.2, Math.max(0, time - this.lastTime)) : 0;
    this.lastTime = time;
    this.weather?.update(time, camera);
    const env = this.data;
    if (!env) return;
    this.refreshSkyIfNeeded();
    const cam = camera.position;
    if (this.stars) {
      this.stars.position.copy(cam);
      const u = this.stars.material.uniforms;
      u.uTime.value = time;
      u.uPixelRatio.value = this.renderer.getPixelRatio();
    }
    if (this.moon) {
      const moonDir = this.sunDir.clone().negate();
      this.moon.visible = moonDir.y > -0.08;
      this.moon.position.copy(cam).addScaledVector(moonDir, 380);
      this.moon.quaternion.copy(camera.quaternion);
      this.moon.scale.setScalar(34);
      this.moon.material.opacity = 0.35 + 0.65 * nightness(this.sunDir.y);
    }
    if (this.clouds) {
      if (this.animate) this.cloudDrift += env.clouds.speed * dt;
      updateClouds(this.clouds, env.clouds, env.time.enabled ? this.sunDir.y : 0.6, this.cloudDrift, camera);
    }
    this.updateLightning(time, dt, camera);
  }

  /** 表示用のオブジェクトを描画の前に最新にする (エディタで止まっているとき用) */
  refresh(camera: Camera): void {
    const keepAnimate = this.animate;
    this.animate = false;
    this.update(this.lastTime || 0.001, camera);
    this.animate = keepAnimate;
    this.applyTime();
  }

  private updateLightning(time: number, dt: number, camera: Camera): void {
    const env = this.data!;
    const on = this.animate && this.weatherVisible && env.weather.type === 'rain' && env.weather.lightning;
    if (!on) {
      if (this.flashLight) this.flashLight.intensity = 0;
      if (this.bolt) this.bolt.visible = false;
      this.nextStrike = 0;
      return;
    }
    if (!this.flashLight) {
      this.flashLight = new HemisphereLight(0xdde6ff, 0x404860, 0);
      this.flashLight.name = '__lightning';
      this.scene.add(this.flashLight);
    }
    if (this.nextStrike === 0) this.nextStrike = time + 2 + Math.random() * 4;
    if (time >= this.nextStrike && this.strikeAt < 0) {
      this.strikeAt = time;
      this.strikes++;
      // 雨が強いほどよく落ちる
      this.nextStrike = time + (3 + Math.random() * 9) / (0.4 + env.weather.intensity);
      const a = Math.random() * Math.PI * 2;
      const dist = 25 + Math.random() * 60;
      const ground = camera.position.clone().add(new Vector3(Math.cos(a) * dist, 0, Math.sin(a) * dist));
      ground.y = 0;
      this.bolt?.removeFromParent();
      this.bolt?.geometry.dispose();
      this.bolt?.material.dispose();
      this.bolt = createBolt(ground.clone().add(new Vector3((Math.random() - 0.5) * 20, 90, (Math.random() - 0.5) * 20)), ground);
      this.scene.add(this.bolt);
      this.onLightning?.(dist);
    }
    if (this.strikeAt >= 0) {
      const t = time - this.strikeAt;
      // 2 回ちらつく光
      const k = t < 0.08 ? 1 : t < 0.14 ? 0.25 : t < 0.24 ? 0.9 : Math.max(0, 1 - (t - 0.24) / 0.35) * 0.6;
      this.flashLight.intensity = k * 3.2;
      if (this.bolt) {
        this.bolt.visible = t < 0.3;
        this.bolt.material.opacity = t < 0.3 ? 1 - t / 0.3 : 0;
      }
      if (t > 0.6) {
        this.strikeAt = -1;
        this.flashLight.intensity = 0;
      }
    }
    void dt;
  }

  /** 雷を今すぐ落とす (テスト・イベント用) */
  strikeNow(): void {
    this.nextStrike = this.lastTime;
  }

  dispose(): void {
    this.weather?.dispose();
    this.weather = null;
    this.removeStars();
    for (const o of [this.moon, this.clouds, this.bolt]) {
      if (!o) continue;
      o.removeFromParent();
      o.geometry.dispose();
      const m = o.material as { map?: Texture | null; dispose(): void };
      m.map?.dispose();
      m.dispose();
    }
    this.moon = null;
    this.clouds = null;
    this.bolt = null;
    this.flashLight?.removeFromParent();
    this.flashLight = null;
    this.disposeSky();
    this.pmrem.dispose();
    this.scene.fog = null;
    this.scene.environment = null;
  }
}

function smooth01(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}
