import { Color, DoubleSide, Mesh, PlaneGeometry, ShaderMaterial } from 'three';

/**
 * シェーダーで描く無限風グリッド。
 * 1m ごとの細線・10m ごとの太線・X/Z 軸線を描き、遠くほど薄くする。
 * GridHelper より線が滑らかで、スマホでも頂点数が少なく軽い。
 */
export class Grid extends Mesh<PlaneGeometry, ShaderMaterial> {
  constructor() {
    const geometry = new PlaneGeometry(2000, 2000, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
      // y=0 に置いた地面と重なってもちらつかないよう手前に寄せて描く
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      uniforms: {
        uMinorColor: { value: new Color('#5a6070') },
        uMajorColor: { value: new Color('#7d8596') },
        uXColor: { value: new Color('#e5484d') },
        uZColor: { value: new Color('#3e8bff') },
        uFadeDistance: { value: 60 },
        uCellSize: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorldPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uMinorColor;
        uniform vec3 uMajorColor;
        uniform vec3 uXColor;
        uniform vec3 uZColor;
        uniform float uFadeDistance;
        uniform float uCellSize;
        varying vec3 vWorldPos;

        float gridLine(vec2 coord, float size, float thickness) {
          vec2 c = coord / size;
          vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
          float line = min(g.x, g.y);
          return 1.0 - min(line / thickness, 1.0);
        }

        void main() {
          vec2 p = vWorldPos.xz;
          float minor = gridLine(p, uCellSize, 1.0);
          float major = gridLine(p, uCellSize * 10.0, 1.4);

          // 軸線 (X 軸は z=0、Z 軸は x=0)
          vec2 fw = fwidth(p);
          float xAxis = 1.0 - min(abs(p.y) / (fw.y * 1.6), 1.0);
          float zAxis = 1.0 - min(abs(p.x) / (fw.x * 1.6), 1.0);

          float dist = length(cameraPosition.xz - p);
          float fade = 1.0 - smoothstep(uFadeDistance * 0.35, uFadeDistance, dist);
          // 真横から見たときのモアレを軽減
          float view = smoothstep(0.0, 0.25, abs(normalize(cameraPosition - vWorldPos).y));
          fade *= mix(0.35, 1.0, view);

          vec3 color = uMinorColor;
          float alpha = minor * 0.35;
          if (major > 0.0) {
            color = mix(color, uMajorColor, major);
            alpha = max(alpha, major * 0.6);
          }
          if (xAxis > 0.0) {
            color = mix(color, uXColor, xAxis);
            alpha = max(alpha, xAxis * 0.9);
          }
          if (zAxis > 0.0) {
            color = mix(color, uZColor, zAxis);
            alpha = max(alpha, zAxis * 0.9);
          }
          alpha *= fade;
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(color, alpha);
          #include <colorspace_fragment>
        }
      `,
    });
    super(geometry, material);
    this.name = '__grid';
    this.renderOrder = -1;
    this.frustumCulled = false;
    this.userData.noPick = true;
  }

  /** カメラ距離に応じてフェード距離を調整 */
  setFadeDistance(d: number): void {
    this.material.uniforms.uFadeDistance.value = d;
  }

  override dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
