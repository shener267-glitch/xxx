import { builtinSoundId, isBuiltinSound } from '../core/sounds';

/**
 * 音の再生 (Web Audio)。
 * - 組み込みの効果音・音楽はオシレーターで合成する (音声ファイル不要・軽量)
 * - 音声アセットはリゾルバから Blob を受け取り、デコードして再生する
 * - Web Audio が使えない環境では何もしない (ゲームは音なしで動く)
 */

export type BlobResolver = (assetId: string) => Promise<Blob | null>;

export interface AudioVolumes {
  master: number;
  music: number;
  sfx: number;
}

type Ctx = AudioContext;

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

/** 音楽のパターン (16分音符単位。null は休符) */
interface Track {
  bpm: number;
  wave: OscillatorType;
  lead: (number | null)[];
  bass: (number | null)[];
  /** リードの音量 */
  gain: number;
  /** 伴奏の和音 (小節ごとの根音) */
  pad?: number[];
}

// C=60
const TRACKS: Record<string, Track> = {
  happy: {
    bpm: 128,
    wave: 'square',
    gain: 0.07,
    lead: [72, null, 76, null, 79, null, 76, null, 77, null, 74, null, 72, null, null, null, 72, null, 76, null, 79, null, 84, null, 83, null, 79, null, 81, null, null, null],
    bass: [48, null, null, null, 55, null, null, null, 53, null, null, null, 55, null, null, null, 48, null, null, null, 55, null, null, null, 57, null, null, null, 55, null, null, null],
  },
  adventure: {
    bpm: 136,
    wave: 'sawtooth',
    gain: 0.045,
    lead: [69, null, 72, 74, 76, null, 74, 72, 74, null, 71, null, 67, null, null, null, 69, null, 72, 74, 76, null, 79, 76, 77, null, 76, 74, 76, null, null, null],
    bass: [45, null, 45, null, 45, null, 45, null, 43, null, 43, null, 43, null, 43, null, 41, null, 41, null, 41, null, 41, null, 40, null, 40, null, 44, null, 44, null],
  },
  calm: {
    bpm: 84,
    wave: 'triangle',
    gain: 0.08,
    lead: [76, null, null, 79, null, null, 81, null, 79, null, null, 76, null, null, 74, null, 72, null, null, 74, null, null, 76, null, 74, null, null, null, null, null, null, null],
    bass: [48, null, null, null, null, null, null, null, 53, null, null, null, null, null, null, null, 45, null, null, null, null, null, null, null, 43, null, null, null, null, null, null, null],
    pad: [60, 65, 57, 55],
  },
  tension: {
    bpm: 156,
    wave: 'square',
    gain: 0.05,
    lead: [62, null, 63, null, 62, null, 60, null, 62, null, null, null, 57, null, null, null, 62, null, 63, null, 65, null, 63, null, 62, null, 60, null, 58, null, null, null],
    bass: [38, 38, null, 38, 38, null, 38, 38, 38, 38, null, 38, 36, null, 36, null, 38, 38, null, 38, 38, null, 38, 38, 34, 34, null, 34, 36, null, 36, null],
  },
};

export class AudioEngine {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private musicStop: (() => void) | null = null;
  private musicSource: string | null = null;
  private volumes: AudioVolumes = { master: 1, music: 0.7, sfx: 0.9 };
  private musicVolume = 1;
  private disposed = false;
  /** 最近再生した音 (デバッグ・テスト用) */
  readonly history: string[] = [];

  constructor(private resolve: BlobResolver | null) {
    try {
      const AC: typeof AudioContext | undefined =
        typeof window !== 'undefined' ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      this.musicBus = ctx.createGain();
      this.musicBus.connect(this.master);
      this.sfxBus = ctx.createGain();
      this.sfxBus.connect(this.master);
      this.applyVolumes();
    } catch {
      this.ctx = null;
    }
  }

  get available(): boolean {
    return this.ctx !== null;
  }

  /** ユーザー操作の中で呼ぶと、ブラウザの自動再生制限が解除される */
  unlock(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  setVolumes(v: Partial<AudioVolumes>): void {
    this.volumes = { ...this.volumes, ...v };
    this.applyVolumes();
  }

  getVolumes(): AudioVolumes {
    return { ...this.volumes };
  }

  private applyVolumes(): void {
    if (!this.ctx || !this.master || !this.musicBus || !this.sfxBus) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.volumes.master, t, 0.02);
    this.musicBus.gain.setTargetAtTime(this.volumes.music * this.musicVolume, t, 0.02);
    this.sfxBus.gain.setTargetAtTime(this.volumes.sfx, t, 0.02);
  }

  /** 一時停止中は音を止める */
  setPaused(paused: boolean): void {
    if (!this.ctx || this.disposed) return;
    if (paused) void this.ctx.suspend().catch(() => undefined);
    else void this.ctx.resume().catch(() => undefined);
  }

  // ------------------------------------------------------------------
  // 効果音
  // ------------------------------------------------------------------

  /** 効果音を鳴らす (source = 'builtin:coin' または音声アセットの ID) */
  play(source: string | null | undefined, volume = 1): void {
    if (!source) return;
    this.history.push(source);
    if (this.history.length > 50) this.history.shift();
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus || this.disposed) return;
    try {
      if (isBuiltinSound(source)) this.synth(builtinSoundId(source), volume);
      else void this.playBuffer(source, volume, false, this.sfxBus);
    } catch {
      // 音が鳴らなくてもゲームは続ける
    }
  }

  private tone(type: OscillatorType, freqs: [number, number], start: number, dur: number, vol: number, out: AudioNode): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqs[0], start);
    if (freqs[1] !== freqs[0]) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqs[1]), start + dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(vol, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g).connect(out);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  private noiseBurst(start: number, dur: number, vol: number, filterFrom: number, filterTo: number, out: AudioNode): void {
    const ctx = this.ctx!;
    if (!this.noise) {
      const len = Math.floor(ctx.sampleRate * 1);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noise = buf;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(filterFrom, start);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, filterTo), start + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(filter).connect(g).connect(out);
    src.start(start);
    src.stop(start + dur + 0.02);
  }

  private synth(id: string, volume: number): void {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = volume;
    out.connect(this.sfxBus!);
    const t = ctx.currentTime + 0.005;
    const seq = (type: OscillatorType, notes: number[], step: number, dur: number, vol: number) =>
      notes.forEach((n, i) => this.tone(type, [midi(n), midi(n)], t + i * step, dur, vol, out));
    switch (id) {
      case 'coin':
        this.tone('square', [988, 988], t, 0.07, 0.18, out);
        this.tone('square', [1319, 1319], t + 0.07, 0.3, 0.18, out);
        break;
      case 'item':
        this.tone('triangle', [660, 990], t, 0.18, 0.3, out);
        break;
      case 'jump':
        this.tone('square', [280, 720], t, 0.16, 0.14, out);
        break;
      case 'hit':
        this.noiseBurst(t, 0.09, 0.35, 3000, 600, out);
        this.tone('square', [180, 70], t, 0.12, 0.2, out);
        break;
      case 'damage':
        this.tone('sawtooth', [240, 90], t, 0.3, 0.22, out);
        this.noiseBurst(t, 0.12, 0.2, 1500, 300, out);
        break;
      case 'explosion':
        this.noiseBurst(t, 0.8, 0.6, 2400, 60, out);
        this.tone('sine', [120, 35], t, 0.6, 0.4, out);
        break;
      case 'thunder':
        // 雷: 近いほど鋭い「バリッ」+ 長いゴロゴロ
        this.noiseBurst(t, 0.25, 0.5, 5000, 400, out);
        this.noiseBurst(t + 0.05, 2.6, 0.55, 500, 40, out);
        this.tone('sine', [70, 30], t + 0.05, 2.2, 0.3, out);
        break;
      case 'powerup':
        seq('square', [72, 76, 79, 84, 88], 0.06, 0.1, 0.13);
        break;
      case 'heal':
        seq('sine', [72, 76, 79, 84], 0.08, 0.25, 0.22);
        break;
      case 'save':
        seq('sine', [76, 81, 88], 0.12, 0.4, 0.22);
        break;
      case 'click':
        this.tone('square', [1200, 900], t, 0.035, 0.1, out);
        break;
      case 'talk':
        this.tone('triangle', [880, 880], t, 0.05, 0.12, out);
        this.tone('triangle', [1175, 1175], t + 0.06, 0.06, 0.1, out);
        break;
      case 'win':
        seq('square', [72, 76, 79], 0.12, 0.14, 0.12);
        this.tone('square', [midi(84), midi(84)], t + 0.36, 0.7, 0.13, out);
        this.tone('triangle', [midi(60), midi(60)], t + 0.36, 0.7, 0.2, out);
        break;
      case 'lose':
        seq('triangle', [67, 64, 60], 0.22, 0.3, 0.25);
        this.tone('triangle', [midi(55), midi(43)], t + 0.66, 0.9, 0.25, out);
        break;
      default:
        this.tone('sine', [660, 660], t, 0.12, 0.15, out);
    }
    // 合成用のノードは音が鳴り終わったら切り離す
    setTimeout(() => out.disconnect(), 3500);
  }

  private loadBuffer(assetId: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(assetId);
    if (!p) {
      p = (async () => {
        if (!this.resolve || !this.ctx) return null;
        const blob = await this.resolve(assetId);
        if (!blob) return null;
        const data = await blob.arrayBuffer();
        return await this.ctx.decodeAudioData(data);
      })().catch(() => null);
      this.buffers.set(assetId, p);
    }
    return p;
  }

  private async playBuffer(assetId: string, volume: number, loop: boolean, bus: AudioNode): Promise<(() => void) | null> {
    const buffer = await this.loadBuffer(assetId);
    const ctx = this.ctx;
    if (!buffer || !ctx || this.disposed) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = loop;
    const g = ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(bus);
    src.start();
    return () => {
      try {
        src.stop();
      } catch {
        // 停止済み
      }
      g.disconnect();
    };
  }

  // ------------------------------------------------------------------
  // 音楽
  // ------------------------------------------------------------------

  get currentMusic(): string | null {
    return this.musicSource;
  }

  playMusic(source: string | null, volume = 1): void {
    if (source === this.musicSource) {
      this.musicVolume = volume;
      this.applyVolumes();
      return;
    }
    this.stopMusic();
    this.musicSource = source;
    this.musicVolume = volume;
    this.applyVolumes();
    if (!source || !this.ctx || !this.musicBus || this.disposed) return;
    if (isBuiltinSound(source)) {
      const track = TRACKS[builtinSoundId(source)];
      if (track) this.musicStop = this.startSequencer(track);
    } else {
      let cancelled = false;
      let stopFn: (() => void) | null = null;
      this.musicStop = () => {
        cancelled = true;
        stopFn?.();
      };
      void this.playBuffer(source, 1, true, this.musicBus).then((stop) => {
        if (cancelled) stop?.();
        else stopFn = stop;
      });
    }
  }

  stopMusic(): void {
    this.musicStop?.();
    this.musicStop = null;
    this.musicSource = null;
  }

  /** 組み込み音楽の簡易シーケンサー (先読みしてスケジュールする) */
  private startSequencer(track: Track): () => void {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = 1;
    out.connect(this.musicBus!);
    const stepDur = 60 / track.bpm / 4;
    let step = 0;
    let next = ctx.currentTime + 0.1;
    const steps = Math.max(track.lead.length, track.bass.length);
    const schedule = () => {
      while (next < ctx.currentTime + 0.25) {
        const i = step % steps;
        const lead = track.lead[i % track.lead.length];
        const bass = track.bass[i % track.bass.length];
        if (lead != null) this.tone(track.wave, [midi(lead), midi(lead)], next, stepDur * 1.8, track.gain, out);
        if (bass != null) this.tone('triangle', [midi(bass), midi(bass)], next, stepDur * 2.5, 0.16, out);
        if (track.pad && i % 16 === 0) {
          const root = track.pad[Math.floor(i / 16) % track.pad.length];
          for (const n of [root, root + 4, root + 7]) this.tone('sine', [midi(n), midi(n)], next, stepDur * 15, 0.035, out);
        }
        next += stepDur;
        step++;
      }
    };
    schedule();
    const timer = setInterval(schedule, 60);
    return () => {
      clearInterval(timer);
      const t = ctx.currentTime;
      out.gain.setTargetAtTime(0, t, 0.05);
      setTimeout(() => out.disconnect(), 400);
    };
  }

  dispose(): void {
    this.stopMusic();
    this.disposed = true;
    this.buffers.clear();
    if (this.ctx) void this.ctx.close().catch(() => undefined);
    this.ctx = null;
  }
}
