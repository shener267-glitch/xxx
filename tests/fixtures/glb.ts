/**
 * テスト用の小さな GLB (glTF バイナリ) を作る。
 * 幅 1・高さ 2・奥行き 1 の箱 (底が y = 0) と、アニメーション「Idle」「Walk」を持つ。
 */
export function makeTestGlb(): Uint8Array {
  // 箱の 8 頂点と 12 三角形
  const p = [
    [-0.5, 0, -0.5],
    [0.5, 0, -0.5],
    [0.5, 2, -0.5],
    [-0.5, 2, -0.5],
    [-0.5, 0, 0.5],
    [0.5, 0, 0.5],
    [0.5, 2, 0.5],
    [-0.5, 2, 0.5],
  ];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3];
  const positions = new Float32Array(p.flat());
  const indices = new Uint16Array(idx);
  const times = new Float32Array([0, 0.5, 1]);
  const idle = new Float32Array([0, 0, 0, 0, 0.05, 0, 0, 0, 0]);
  const walk = new Float32Array([0, 0, 0, 0.2, 0.1, 0, 0, 0, 0]);
  const parts = [positions, indices, times, idle, walk];
  const offsets: number[] = [];
  let len = 0;
  for (const a of parts) {
    offsets.push(len);
    len += Math.ceil(a.byteLength / 4) * 4;
  }
  const bin = new Uint8Array(len);
  parts.forEach((a, i) => bin.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), offsets[i]));
  const json = {
    asset: { version: '2.0', generator: 'pocket-engine-test' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Box' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0.45, 0.2, 1], metallicFactor: 0, roughnessFactor: 0.6 } }],
    buffers: [{ byteLength: len }],
    bufferViews: parts.map((a, i) => ({ buffer: 0, byteOffset: offsets[i], byteLength: a.byteLength, ...(i === 1 ? { target: 34963 } : i === 0 ? { target: 34962 } : {}) })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, 0, -0.5], max: [0.5, 2, 0.5] },
      { bufferView: 1, componentType: 5123, count: idx.length, type: 'SCALAR' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 3, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 4, componentType: 5126, count: 3, type: 'VEC3' },
    ],
    animations: [
      { name: 'Idle', channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }], samplers: [{ input: 2, output: 3, interpolation: 'LINEAR' }] },
      { name: 'Walk', channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }], samplers: [{ input: 2, output: 4, interpolation: 'LINEAR' }] },
    ],
  };
  let jsonText = JSON.stringify(json);
  while (jsonText.length % 4 !== 0) jsonText += ' ';
  const jsonBytes = new TextEncoder().encode(jsonText);
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  const binStart = 20 + jsonBytes.length;
  dv.setUint32(binStart, bin.length, true);
  dv.setUint32(binStart + 4, 0x004e4942, true);
  out.set(bin, binStart + 8);
  return out;
}
