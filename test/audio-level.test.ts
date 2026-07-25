import { describe, expect, it } from "vitest";
import { createFrequencySampler, createScalarSampler, type FrequencyProbe } from "../src/audio-level";

const BAR_COUNT = 28;

/** FrequencyProbe is structurally typed — no AnalyserNode/AudioContext
 * needed, just an object shaped like one. */
function probe(fill: number, bins = 64): FrequencyProbe {
  return {
    frequencyBinCount: bins,
    getByteFrequencyData: (a: Uint8Array) => a.fill(fill),
  };
}

function throwingProbe(bins = 64): FrequencyProbe {
  return {
    frequencyBinCount: bins,
    getByteFrequencyData: () => {
      throw new Error("AudioContext is closed");
    },
  };
}

describe("createFrequencySampler", () => {
  it("fills out with values in [0,1] and returns true for a loud probe", () => {
    const sampler = createFrequencySampler(probe(200));
    const out = new Float32Array(BAR_COUNT);

    expect(sampler.sample(out)).toBe(true);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...out)).toBeGreaterThan(0);
  });

  it("mirrors symmetrically around the ring", () => {
    const sampler = createFrequencySampler(probe(180));
    const out = new Float32Array(BAR_COUNT);
    sampler.sample(out);

    for (let i = 0; i < BAR_COUNT; i++) {
      expect(out[i]).toBeCloseTo(out[BAR_COUNT - 1 - i], 5);
    }
  });

  it("returns false and leaves out untouched when frequencyBinCount is 0", () => {
    const sampler = createFrequencySampler(probe(200, 0));
    const out = new Float32Array(BAR_COUNT).fill(-1);

    expect(sampler.sample(out)).toBe(false);
    expect(Array.from(out).every((v) => v === -1)).toBe(true);
  });

  it("returns false instead of throwing when the probe throws (closed AudioContext)", () => {
    const sampler = createFrequencySampler(throwingProbe());
    const out = new Float32Array(BAR_COUNT);

    expect(() => sampler.sample(out)).not.toThrow();
    expect(sampler.sample(out)).toBe(false);
  });

  it("reports false after enough consecutive silent samples, then recovers", () => {
    const silent = probe(0);
    const loud = probe(200);
    const sampler = createFrequencySampler(silent, { silenceFrames: 3 });
    const out = new Float32Array(BAR_COUNT);

    expect(sampler.sample(out)).toBe(true); // streak 1
    expect(sampler.sample(out)).toBe(true); // streak 2
    expect(sampler.sample(out)).toBe(true); // streak 3
    expect(sampler.sample(out)).toBe(false); // streak 4 > limit

    // Recovers once the probe goes loud again — same sampler instance, so
    // this also proves the silent streak isn't a one-way trip.
    const recoveringSampler = createFrequencySampler(loud, { silenceFrames: 3 });
    expect(recoveringSampler.sample(out)).toBe(true);
  });

  it("rises faster than it falls (asymmetric attack/release)", () => {
    let level = 255;
    const dynamicProbe: FrequencyProbe = {
      frequencyBinCount: 64,
      getByteFrequencyData: (a) => a.fill(level),
    };
    const sampler = createFrequencySampler(dynamicProbe);
    const out = new Float32Array(BAR_COUNT);

    sampler.sample(out);
    const afterRise1 = out[0];
    sampler.sample(out);
    const afterRise2 = out[0];
    expect(afterRise2).toBeGreaterThan(afterRise1);
    const riseDelta = afterRise2 - afterRise1;

    level = 0;
    sampler.sample(out);
    const afterFall1 = out[0];
    sampler.sample(out);
    const afterFall2 = out[0];
    expect(afterFall2).toBeLessThan(afterFall1);
    const fallDelta = afterFall1 - afterFall2;

    expect(fallDelta).toBeLessThan(riseDelta);
  });
});

describe("createScalarSampler", () => {
  it("produces a non-flat, mirrored ring from a single scalar reading", () => {
    const sampler = createScalarSampler(() => 0.5);
    const out = new Float32Array(BAR_COUNT);

    expect(sampler.sample(out)).toBe(true);
    const values = new Set(out);
    expect(values.size).toBeGreaterThan(1); // non-flat
    for (let i = 0; i < BAR_COUNT; i++) {
      expect(out[i]).toBeCloseTo(out[BAR_COUNT - 1 - i], 5);
    }
  });

  it("returns false when the reader reports null", () => {
    const sampler = createScalarSampler(() => null);
    const out = new Float32Array(BAR_COUNT);

    expect(sampler.sample(out)).toBe(false);
  });
});
