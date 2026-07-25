/** Turns raw Web Audio frequency data (or a plain 0..1 volume reading) into the
 * per-bar magnitudes the radial visualizer draws. Deliberately has no
 * dependency on `livekit-client` or any Web Audio *global* type — see
 * `radial-visualizer.ts`'s header comment for why that boundary matters (the
 * lazy-load invariant in ../CLAUDE.md). `FrequencyProbe` is structurally
 * typed so a real `AnalyserNode` satisfies it without an import, and a test
 * can hand-roll one in three lines with no AudioContext at all. */

/** The minimal shape we need from a Web Audio AnalyserNode. */
export interface FrequencyProbe {
  readonly frequencyBinCount: number;
  getByteFrequencyData(array: Uint8Array): void;
}

export interface AudioLevelSampler {
  /** Fills `out` with `out.length` normalized 0..1 magnitudes, mirrored
   * symmetrically around the ring (bar i and bar out.length-1-i always
   * match — a ring reads as "reactive," not "one side is lit"). Returns
   * false when the probe is unusable (zero bins, a throwing/closed
   * AudioContext) or has been silent long enough to be indistinguishable
   * from broken. Callers should fall back to synthetic motion in that case
   * rather than render a dead ring. */
  sample(out: Float32Array): boolean;
}

export interface SamplerOptions {
  /** Bin window read from a frequency probe. Speech energy lives low, and the
   * top of a small FFT is always near-zero, which would pin half the ring
   * flat. Ignored by createScalarSampler. */
  lowBin?: number;
  highBin?: number;
  /** Exponential smoothing coefficients, 0..1 — how much of the new reading
   * to blend in per sample() call. Asymmetric on purpose: bars should snap
   * up to a transient but ease back down, or the ring looks jittery instead
   * of alive. */
  attack?: number;
  release?: number;
  /** Consecutive all-silent samples before sample() reports false. */
  silenceFrames?: number;
}

const DEFAULT_LOW_BIN = 1; // skip bin 0 (DC offset)
const DEFAULT_HIGH_BIN = 28;
const DEFAULT_ATTACK = 0.55;
const DEFAULT_RELEASE = 0.12;
const DEFAULT_SILENCE_FRAMES = 90; // ~1.5s at 60fps

// Number of independent smoothed values we track internally. mirrorInto
// reflects these across the full ring regardless of the ring's actual bar
// count, so this only needs to be "enough to look varied," not exact.
const TRACKED_VALUES = 14;

function mirrorInto(out: Float32Array, magnitudes: number[]): void {
  const n = out.length;
  const half = Math.ceil(n / 2);
  for (let i = 0; i < half; i++) {
    const v = magnitudes[i % magnitudes.length] ?? 0;
    out[i] = v;
    out[n - 1 - i] = v;
  }
}

/** Shared attack/release + silence-watchdog state machine, fed by either a
 * frequency probe or a plain scalar reading (see createScalarSampler below) —
 * one code path for element.ts regardless of what's actually available. */
function createSmoothedSampler(readRaw: () => number[] | null, opts: SamplerOptions): AudioLevelSampler {
  const attack = opts.attack ?? DEFAULT_ATTACK;
  const release = opts.release ?? DEFAULT_RELEASE;
  const silenceFramesLimit = opts.silenceFrames ?? DEFAULT_SILENCE_FRAMES;

  const smoothed = new Array<number>(TRACKED_VALUES).fill(0);
  let silentStreak = 0;

  return {
    sample(out: Float32Array): boolean {
      const raw = readRaw();
      if (raw === null) return false;

      const loud = raw.some((v) => v > 0.02);
      silentStreak = loud ? 0 : silentStreak + 1;
      if (silentStreak > silenceFramesLimit) return false;

      for (let i = 0; i < smoothed.length; i++) {
        const target = raw[i % raw.length] ?? 0;
        const coeff = target > smoothed[i] ? attack : release;
        smoothed[i] = smoothed[i] + (target - smoothed[i]) * coeff;
      }

      mirrorInto(out, smoothed);
      return true;
    },
  };
}

/** Real per-bar frequency data from an AnalyserNode-shaped probe. */
export function createFrequencySampler(probe: FrequencyProbe, opts: SamplerOptions = {}): AudioLevelSampler {
  const lowBin = opts.lowBin ?? DEFAULT_LOW_BIN;
  const highBin = Math.min(opts.highBin ?? DEFAULT_HIGH_BIN, probe.frequencyBinCount);
  const binCount = Math.max(0, highBin - lowBin);
  // Reused across calls — sample() must not allocate per frame.
  const bytes = new Uint8Array(Math.max(1, probe.frequencyBinCount));

  const readRaw = (): number[] | null => {
    if (binCount <= 0) return null;
    try {
      probe.getByteFrequencyData(bytes);
    } catch {
      // A closed/suspended AudioContext can throw here rather than just
      // returning zeros — either way, the caller falls back to synthetic
      // motion rather than propagating an exception into a render loop.
      return null;
    }
    const magnitudes: number[] = [];
    const step = binCount / TRACKED_VALUES;
    for (let i = 0; i < TRACKED_VALUES; i++) {
      const bin = lowBin + Math.floor(i * step);
      magnitudes.push(bytes[bin] / 255);
    }
    return magnitudes;
  };

  return createSmoothedSampler(readRaw, opts);
}

/** A scalar-only source (LiveKit's own `calculateVolume`, or the synthetic
 * demo hook in examples/index.html) shaped into the same interface so
 * element.ts has exactly one code path regardless of what's available. */
export function createScalarSampler(read: () => number | null, opts: SamplerOptions = {}): AudioLevelSampler {
  const readRaw = (): number[] | null => {
    const v = read();
    if (v === null) return null;
    // A single scalar reading pretending to be several bins with a light
    // per-bin taper — a flat ring is the shape most likely to read as
    // "broken," not "quiet."
    return Array.from({ length: TRACKED_VALUES }, (_, i) => v * (0.7 + 0.3 * Math.abs(Math.sin(i))));
  };
  return createSmoothedSampler(readRaw, opts);
}
