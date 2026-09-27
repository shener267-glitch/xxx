import { HalfFloatType, Vector2, WebGLRenderTarget } from 'three';
import type { Camera, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import type { QualityLevel } from '../core/settings';
import type { PostEffectsData } from '../core/types';

/**
 * 画面全体の効果 (ポストエフェクト): 光のにじみ (ブルーム)・被写界深度・色あい・周辺を暗く。
 * three.js の EffectComposer を使う。モジュールは初めて使うときだけ読み込む (起動を軽くするため)。
 *
 * 順番: 描画 → 被写界深度 → ブルーム → トーンマッピング / sRGB (OutputPass) → 色あい・周辺減光
 */

type Modules = {
  EffectComposer: typeof import('three/examples/jsm/postprocessing/EffectComposer.js').EffectComposer;
  RenderPass: typeof import('three/examples/jsm/postprocessing/RenderPass.js').RenderPass;
  UnrealBloomPass: typeof import('three/examples/jsm/postprocessing/UnrealBloomPass.js').UnrealBloomPass;
  BokehPass: typeof import('three/examples/jsm/postprocessing/BokehPass.js').BokehPass;
  OutputPass: typeof import('three/examples/jsm/postprocessing/OutputPass.js').OutputPass;
  ShaderPass: typeof import('three/examples/jsm/postprocessing/ShaderPass.js').ShaderPass;
};

let modulesPromise: Promise<Modules> | null = null;

function loadModules(): Promise<Modules> {
  if (!modulesPromise) {
    modulesPromise = Promise.all([
      import('three/examples/jsm/postprocessing/EffectComposer.js'),
      import('three/examples/jsm/postprocessing/RenderPass.js'),
      import('three/examples/jsm/postprocessing/UnrealBloomPass.js'),
      import('three/examples/jsm/postprocessing/BokehPass.js'),
      import('three/examples/jsm/postprocessing/OutputPass.js'),
      import('three/examples/jsm/postprocessing/ShaderPass.js'),
    ]).then(([a, b, c, d, e, f]) => ({
      EffectComposer: a.EffectComposer,
      RenderPass: b.RenderPass,
      UnrealBloomPass: c.UnrealBloomPass,
      BokehPass: d.BokehPass,
      OutputPass: e.OutputPass,
      ShaderPass: f.ShaderPass,
    }));
  }
  return modulesPromise;
}

/** 色あい・コントラスト・色味・周辺減光 (表示用の色 = sRGB で計算) */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uSaturation: { value: 0 },
    uContrast: { value: 0 },
    uWarmth: { value: 0 },
    uVignette: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uWarmth;
    uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(l), col, 1.0 + uSaturation);
      col = (col - 0.5) * (1.0 + uContrast * 0.8) + 0.5;
      col += vec3(0.07, 0.015, -0.07) * uWarmth;
      float d = distance(vUv, vec2(0.5));
      col *= mix(1.0, smoothstep(0.9, 0.3, d), uVignette);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
    }
  `,
};

export interface PostOptions {
  /** 被写界深度のピントの距離 (m)。null なら設定の値 */
  focus?: number | null;
  /** 被写界深度を使わない (エディタのプレビュー用) */
  noDof?: boolean;
}

export class PostProcessor {
  private m: Modules | null = null;
  private loading = false;
  private composer: InstanceType<Modules['EffectComposer']> | null = null;
  private renderPass: InstanceType<Modules['RenderPass']> | null = null;
  private bloom: InstanceType<Modules['UnrealBloomPass']> | null = null;
  private bokeh: InstanceType<Modules['BokehPass']> | null = null;
  private grade: InstanceType<Modules['ShaderPass']> | null = null;
  private size = { w: 1, h: 1, ratio: 1 };
  private bokehCamera: Camera | null = null;
  /** 読み込みが終わったとき (再描画のため) */
  onReady: (() => void) | null = null;

  constructor(private renderer: WebGLRenderer) {}

  get ready(): boolean {
    return this.composer !== null;
  }

  /** 使う準備 (モジュールを読み込む)。読み込み中は false */
  prepare(): boolean {
    if (this.composer) return true;
    if (!this.loading) {
      this.loading = true;
      void loadModules()
        .then((m) => {
          this.m = m;
          this.build();
          this.onReady?.();
        })
        .catch((err) => console.warn('[PocketEngine] ポストエフェクトを読み込めませんでした', err));
    }
    return false;
  }

  private build(): void {
    const m = this.m!;
    const r = this.renderer;
    const target = new WebGLRenderTarget(this.size.w, this.size.h, { type: HalfFloatType, samples: r.capabilities.isWebGL2 ? 4 : 0 });
    const composer = new m.EffectComposer(r, target);
    this.renderPass = new m.RenderPass(undefined as unknown as Scene, undefined as unknown as Camera);
    composer.addPass(this.renderPass);
    this.composer = composer;
    this.setSize(this.size.w, this.size.h, this.size.ratio);
  }

  setSize(w: number, h: number, ratio: number): void {
    this.size = { w, h, ratio };
    if (!this.composer) return;
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);
  }

  /** 設定に合わせてパスを付け外しする */
  private configure(data: PostEffectsData, quality: QualityLevel, scene: Scene, camera: Camera, opts: PostOptions): void {
    const m = this.m!;
    const composer = this.composer!;
    const wantDof = data.dof.enabled && !opts.noDof;
    // 被写界深度
    if (wantDof && (!this.bokeh || this.bokehCamera !== camera)) {
      if (this.bokeh) composer.removePass(this.bokeh);
      this.bokeh = new m.BokehPass(scene, camera, { focus: 10, aperture: 0.002, maxblur: 0.01 });
      this.bokehCamera = camera;
      composer.insertPass(this.bokeh, 1);
    } else if (!wantDof && this.bokeh) {
      composer.removePass(this.bokeh);
      this.bokeh.dispose();
      this.bokeh = null;
      this.bokehCamera = null;
    }
    if (this.bokeh) {
      const u = this.bokeh.uniforms as Record<string, { value: number }>;
      const cam = camera as PerspectiveCamera;
      u.focus.value = Math.max(0.1, opts.focus ?? data.dof.focus);
      u.aperture.value = 0.0006 + data.dof.blur * 0.004;
      u.maxblur.value = 0.002 + data.dof.blur * 0.012;
      u.nearClip.value = cam.near;
      u.farClip.value = cam.far;
      (this.bokeh as unknown as { scene: Scene }).scene = scene;
    }
    // ブルーム (中画質は解像度を半分にして軽くする)
    if (data.bloom.enabled && !this.bloom) {
      const k = quality === 'high' ? 1 : 0.5;
      this.bloom = new m.UnrealBloomPass(new Vector2(this.size.w * k, this.size.h * k), data.bloom.strength, data.bloom.radius, data.bloom.threshold);
      composer.insertPass(this.bloom, this.bokeh ? 2 : 1);
    } else if (!data.bloom.enabled && this.bloom) {
      composer.removePass(this.bloom);
      this.bloom.dispose();
      this.bloom = null;
    }
    if (this.bloom) {
      this.bloom.strength = data.bloom.strength;
      this.bloom.radius = data.bloom.radius;
      this.bloom.threshold = data.bloom.threshold;
    }
    // 出力 (トーンマッピング・sRGB) と色あい
    if (!composer.passes.some((p) => p instanceof m.OutputPass)) composer.addPass(new m.OutputPass());
    const wantGrade = data.vignette > 0.001 || Math.abs(data.saturation) > 0.001 || Math.abs(data.contrast) > 0.001 || Math.abs(data.warmth) > 0.001;
    if (wantGrade && !this.grade) {
      this.grade = new m.ShaderPass(GradeShader);
      composer.addPass(this.grade);
    } else if (!wantGrade && this.grade) {
      composer.removePass(this.grade);
      this.grade.dispose();
      this.grade = null;
    }
    if (this.grade) {
      const u = this.grade.uniforms as Record<string, { value: number }>;
      u.uSaturation.value = data.saturation;
      u.uContrast.value = data.contrast;
      u.uWarmth.value = data.warmth;
      u.uVignette.value = data.vignette;
    }
  }

  /** 効果をかけて描画する。まだ準備できていなければ false (呼び出し側がふつうに描く) */
  render(scene: Scene, camera: Camera, data: PostEffectsData, quality: QualityLevel, opts: PostOptions = {}): boolean {
    if (!this.prepare()) return false;
    this.configure(data, quality, scene, camera, opts);
    const rp = this.renderPass!;
    rp.scene = scene;
    rp.camera = camera;
    this.composer!.render();
    return true;
  }

  /** 使っている効果 (テスト・デバッグ用) */
  get activePasses(): string[] {
    if (!this.composer) return [];
    return ['render', ...(this.bokeh ? ['dof'] : []), ...(this.bloom ? ['bloom'] : []), 'output', ...(this.grade ? ['grade'] : [])];
  }

  dispose(): void {
    this.bloom?.dispose();
    this.bokeh?.dispose();
    this.grade?.dispose();
    this.composer?.dispose();
    this.composer = null;
  }
}
