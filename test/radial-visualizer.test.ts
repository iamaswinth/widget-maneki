import { describe, expect, it, vi } from "vitest";
import {
  computeBarMagnitudes,
  createRadialVisualizer,
  DEFAULT_BAR_COUNT,
  type AudioInput,
} from "../src/radial-visualizer";
import type { WidgetState } from "../src/state";

const STATES: WidgetState[] = ["idle", "connecting", "listening", "speaking", "error"];
const AUDIO_VARIANTS: (AudioInput | null)[] = [
  null,
  { bars: new Float32Array([0.2, 0.5, 0.9, 0.1]), volume: null },
  { bars: null, volume: 0.6 },
];

function newOut(): Float32Array {
  return new Float32Array(DEFAULT_BAR_COUNT);
}

describe("computeBarMagnitudes", () => {
  it("is pure — identical args produce identical output", () => {
    const out1 = newOut();
    const out2 = newOut();
    computeBarMagnitudes("listening", false, 1234, { bars: null, volume: 0.4 }, out1);
    computeBarMagnitudes("listening", false, 1234, { bars: null, volume: 0.4 }, out2);
    expect(Array.from(out1)).toEqual(Array.from(out2));
  });

  it("stays within [0,1] across every state x audio x muted combination", () => {
    for (const state of STATES) {
      for (const audio of AUDIO_VARIANTS) {
        for (const muted of [false, true]) {
          const out = newOut();
          computeBarMagnitudes(state, muted, 500, audio, out);
          for (const v of out) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("idle is time-invariant", () => {
    const outEarly = newOut();
    const outLate = newOut();
    computeBarMagnitudes("idle", false, 0, null, outEarly);
    computeBarMagnitudes("idle", false, 99999, null, outLate);
    expect(Array.from(outEarly)).toEqual(Array.from(outLate));
  });

  it("error is flat", () => {
    const out = newOut();
    computeBarMagnitudes("error", false, 777, null, out);
    const first = out[0];
    expect(Array.from(out).every((v) => v === first)).toBe(true);
  });

  it("connecting rotates a sweep around the ring over time", () => {
    const argmax = (out: Float32Array): number => {
      let best = 0;
      for (let i = 1; i < out.length; i++) if (out[i] > out[best]) best = i;
      return best;
    };
    const out0 = newOut();
    const out100 = newOut();
    const out200 = newOut();
    computeBarMagnitudes("connecting", false, 0, null, out0);
    computeBarMagnitudes("connecting", false, 100, null, out100);
    computeBarMagnitudes("connecting", false, 200, null, out200);

    const i0 = argmax(out0);
    const i100 = argmax(out100);
    const i200 = argmax(out200);
    expect(i100).toBeGreaterThan(i0);
    expect(i200).toBeGreaterThan(i100);
  });

  it("passes real bar data through with a 0.10 floor", () => {
    const out = newOut();
    const bars = new Float32Array(DEFAULT_BAR_COUNT).fill(0);
    bars[0] = 0.9;
    computeBarMagnitudes("listening", false, 0, { bars, volume: null }, out);
    expect(out[0]).toBeCloseTo(0.9, 5);
    expect(out[1]).toBeGreaterThanOrEqual(0.1); // floor applied to the zero entries
  });

  it("is flat and resting when muted while listening, regardless of audio", () => {
    const out = newOut();
    const bars = new Float32Array(DEFAULT_BAR_COUNT).fill(0.9);
    computeBarMagnitudes("listening", true, 123, { bars, volume: null }, out);
    const first = out[0];
    expect(Array.from(out).every((v) => v === first)).toBe(true);
    expect(first).toBeCloseTo(0.1, 5);
  });

  it("muted has no special-cased effect while speaking (still driven by audio)", () => {
    const out = newOut();
    const bars = new Float32Array(DEFAULT_BAR_COUNT).fill(0.8);
    computeBarMagnitudes("speaking", true, 0, { bars, volume: null }, out);
    expect(out[0]).toBeCloseTo(0.8, 5);
  });
});

describe("createRadialVisualizer", () => {
  it("builds barCount bar elements with distinct static rotation angles", () => {
    const viz = createRadialVisualizer(document);
    const barEls = viz.root.querySelectorAll(".bar");
    expect(barEls.length).toBe(DEFAULT_BAR_COUNT);

    const angles = Array.from(barEls).map((el) => (el as HTMLElement).style.getPropertyValue("--mw-a"));
    expect(new Set(angles).size).toBe(DEFAULT_BAR_COUNT);
    expect(angles[0]).toBe("0deg");
    expect(angles[1]).toBe(`${360 / DEFAULT_BAR_COUNT}deg`);
  });

  it("is aria-hidden so it never contributes to the button's accessible name", () => {
    const viz = createRadialVisualizer(document);
    expect(viz.root.getAttribute("aria-hidden")).toBe("true");
  });

  it("respects a custom barCount", () => {
    const viz = createRadialVisualizer(document, { barCount: 10 });
    expect(viz.root.querySelectorAll(".bar").length).toBe(10);
  });

  it("setState writes the color custom property and the data-state attribute", () => {
    const viz = createRadialVisualizer(document);
    viz.setState("speaking", "#3b82f6");
    expect(viz.root.dataset.state).toBe("speaking");
    expect(viz.root.style.getPropertyValue("--mw-bar-color").trim()).toBe("#3b82f6");
  });

  it("setMuted writes data-muted", () => {
    const viz = createRadialVisualizer(document);
    viz.setMuted(true);
    expect(viz.root.dataset.muted).toBe("true");
  });

  it("tick writes a parseable --mw-l in [0,1] on every bar", () => {
    const viz = createRadialVisualizer(document);
    viz.setState("listening", "#22c55e");
    viz.tick(0);

    const barEls = viz.root.querySelectorAll(".bar");
    for (const el of Array.from(barEls)) {
      const raw = (el as HTMLElement).style.getPropertyValue("--mw-l");
      const parsed = Number(raw);
      expect(Number.isNaN(parsed)).toBe(false);
      expect(parsed).toBeGreaterThanOrEqual(0);
      expect(parsed).toBeLessThanOrEqual(1);
    }
  });

  it("tick allocates no DOM nodes", () => {
    const viz = createRadialVisualizer(document);
    const before = viz.root.childElementCount;
    for (let t = 0; t < 10; t++) viz.tick(t * 50);
    expect(viz.root.childElementCount).toBe(before);
  });

  it("suppresses a redundant write when the magnitude barely changes", () => {
    const viz = createRadialVisualizer(document);
    viz.setState("error", "#ef4444"); // flat, time-invariant -> identical every tick
    viz.tick(0);

    const bar = viz.root.querySelector(".bar") as HTMLElement;
    const spy = vi.spyOn(bar.style, "setProperty");
    viz.tick(1000); // still flat/time-invariant, and far enough past the 33ms throttle

    const levelWrites = spy.mock.calls.filter(([prop]) => prop === "--mw-l");
    expect(levelWrites.length).toBe(0);
  });

  it("destroy empties the root and a later tick does not throw", () => {
    const viz = createRadialVisualizer(document);
    viz.tick(0);
    viz.destroy();

    expect(viz.root.childElementCount).toBe(0);
    expect(() => viz.tick(16)).not.toThrow();
  });
});
