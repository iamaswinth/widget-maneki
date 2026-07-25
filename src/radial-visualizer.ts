import type { WidgetState } from "./state";

/** Renders and animates the ring of bars that replaced the old orb button —
 * modeled on LiveKit's own AgentAudioVisualizerRadial look
 * (https://docs.livekit.io/reference/components/agents-ui/component/agent-audio-visualizer-radial/),
 * hand-written here rather than imported: that component is React-only
 * (shadcn/Radix), and ../CLAUDE.md forbids shipping a framework runtime
 * inside a third-party page.
 *
 * This module has NO dependency on `livekit-client` — not even type-only —
 * and no CSS of its own. Its CSS contract lives in element.ts's single
 * `STYLE` template literal (the `.ring` / `.bar` rules and the `--mw-*`
 * custom properties this module writes); that's where the project's styling
 * convention requires it to live, and it's the only place a customer's page
 * could ever observe it (Shadow DOM encapsulated).
 *
 * Everything in here is DOM + time — no AudioContext, no rAF. The caller
 * (element.ts) owns the animation frame loop and calls tick(timeMs) once per
 * frame; that's what keeps this module testable with neither.
 */

export const DEFAULT_BAR_COUNT = 28;

/** What drives the bars on a given frame — real per-bar frequency data, a
 * single volume scalar, or neither (null), in which case computeBarMagnitudes
 * falls back to a calm synthetic shimmer. */
export interface AudioInput {
  bars: Float32Array | null;
  volume: number | null;
}

const TAU = Math.PI * 2;

/** Wraps an angle difference into [-PI, PI] so the "how close is bar i to the
 * comet head" distance is always the short way around the ring. */
function wrapAngle(delta: number): number {
  return Math.atan2(Math.sin(delta), Math.cos(delta));
}

/** PURE — no DOM, no time source, no allocation (writes into `out`). This is
 * the entire animation: a function of state/muted/time/audio only, which is
 * why it needs neither rAF nor AudioContext to test. `idle` and `error` are
 * deliberately time-invariant — see the "idle schedules nothing" test in
 * element-connection.test.ts, which depends on that being true so the
 * rAF loop can stay off while nobody's in a call. */
export function computeBarMagnitudes(
  state: WidgetState,
  muted: boolean,
  timeMs: number,
  audio: AudioInput | null,
  out: Float32Array
): Float32Array {
  const n = out.length;

  if (state === "error") {
    out.fill(0.12);
    return out;
  }

  if (state === "idle") {
    for (let i = 0; i < n; i++) out[i] = 0.18 + 0.1 * Math.sin((i * TAU * 3) / n);
    return out;
  }

  // Muted must look muted — a flat resting ring, never the "calm shimmer"
  // fallback below, which would read as "everything's fine, just quiet."
  if (state === "listening" && muted) {
    out.fill(0.1);
    return out;
  }

  if (state === "connecting") {
    // A single bright point sweeps around the ring, like a loading spinner —
    // matches the reference screenshot's tapering-dots look.
    const theta = ((timeMs / 900) % 1) * TAU;
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * TAU;
      const d = wrapAngle(angle - theta);
      out[i] = 0.15 + 0.85 * Math.exp(-((d / 0.55) ** 2));
    }
    return out;
  }

  // listening (unmuted) or speaking, from here down.
  if (audio?.bars) {
    const bars = audio.bars;
    for (let i = 0; i < n; i++) {
      const v = bars[i % bars.length] ?? 0;
      out[i] = Math.max(0.1, Math.min(1, v));
    }
    return out;
  }

  if (audio?.volume != null) {
    const v = audio.volume;
    for (let i = 0; i < n; i++) {
      out[i] = 0.12 + v * (0.35 + 0.65 * Math.abs(Math.sin((i * TAU * 2) / n + timeMs / 220)));
    }
    return out;
  }

  // No usable audio at all (analyser unavailable, or the silence watchdog
  // tripped) — a calm shimmer rather than a dead ring.
  for (let i = 0; i < n; i++) {
    out[i] = 0.16 + 0.08 * Math.sin((i * TAU * 2) / n + timeMs / 700);
  }
  return out;
}

// Below this, no bar-to-bar difference is visually distinguishable — skips a
// wasted style write on frames where nothing meaningfully changed.
const CHANGE_THRESHOLD = 0.004;
// ~30fps: imperceptible on a 64px ring, halves the per-frame cost on
// low-end devices. Applied here (not by the caller) so every consumer of
// this module gets it for free.
const MIN_FRAME_INTERVAL_MS = 33;

export interface RadialVisualizerOptions {
  barCount?: number;
}

export interface RadialVisualizer {
  /** Append this inside the tap-to-talk button. aria-hidden + pointer-events:
   * none (set via CSS) so the 28 bars can never contribute to the button's
   * accessible name or intercept clicks. */
  readonly root: HTMLElement;
  /** Idempotent — safe to call on every render(). */
  setState(state: WidgetState, color: string): void;
  setMuted(muted: boolean): void;
  /** Latest audio for subsequent ticks; null clears it (falls back to the
   * calm shimmer via computeBarMagnitudes). */
  setAudio(audio: AudioInput | null): void;
  /** Advance to absolute time `timeMs` and write CSS custom properties.
   * Absolute, not delta: a tab hidden for 10 minutes resumes with a phase
   * jump, never a catch-up loop or accumulated drift. */
  tick(timeMs: number): void;
  destroy(): void;
}

export function createRadialVisualizer(doc: Document, opts: RadialVisualizerOptions = {}): RadialVisualizer {
  const barCount = opts.barCount ?? DEFAULT_BAR_COUNT;

  const root = doc.createElement("div");
  root.className = "ring";
  root.setAttribute("aria-hidden", "true");

  let bars: HTMLElement[] = [];
  for (let i = 0; i < barCount; i++) {
    const bar = doc.createElement("span");
    bar.className = "bar";
    // Rotation is static per bar — written once here, never touched again by
    // tick(), so JS never re-serializes a transform on the hot path.
    bar.style.setProperty("--mw-a", `${(i * 360) / barCount}deg`);
    root.appendChild(bar);
    bars.push(bar);
  }

  let state: WidgetState = "idle";
  let muted = false;
  let audio: AudioInput | null = null;
  const magnitudes = new Float32Array(barCount);
  const written = new Float32Array(barCount).fill(-1); // force the first tick to write
  let lastTickMs = -Infinity;

  return {
    root,

    setState(next, color) {
      state = next;
      root.dataset.state = next;
      root.style.setProperty("--mw-bar-color", color);
    },

    setMuted(next) {
      muted = next;
      root.dataset.muted = String(next);
    },

    setAudio(next) {
      audio = next;
    },

    tick(timeMs) {
      if (bars.length === 0) return; // destroyed
      if (timeMs - lastTickMs < MIN_FRAME_INTERVAL_MS) return;
      lastTickMs = timeMs;

      computeBarMagnitudes(state, muted, timeMs, audio, magnitudes);

      for (let i = 0; i < bars.length; i++) {
        const m = magnitudes[i];
        if (Math.abs(m - written[i]) < CHANGE_THRESHOLD) continue;
        written[i] = m;
        bars[i].style.setProperty("--mw-l", m.toFixed(3));
      }
    },

    destroy() {
      root.innerHTML = "";
      bars = [];
    },
  };
}
