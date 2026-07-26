import { type AudioLevelSampler, createFrequencySampler } from "./audio-level";
import { isMicPermissionDenied } from "./errors";
import { requestWidgetToken, WidgetTokenError } from "./gateway-client";
import {
  type AudioProbeKind,
  connectToRoom,
  DataMessage,
  LiveKitConnection,
} from "./livekit-connection";
import { handleClick, handleNavigate, PENDING_NAVIGATION_KEY } from "./navigation";
import { DEFAULT_BAR_COUNT, createRadialVisualizer, type RadialVisualizer } from "./radial-visualizer";
import { readGrant, storeGrant } from "./session";
import { WidgetState, WidgetStateMachine } from "./state";

const STATE_LABELS: Record<WidgetState, string> = {
  idle: "Tap to talk",
  connecting: "Connecting…",
  listening: "Listening…",
  speaking: "Speaking…",
  error: "Something went wrong",
};

// Also doubles as the visualizer ring's --mw-bar-color. The ring has no
// backing disc of its own (see button.visualizer below) — it sits directly
// on whatever the host page's background is, so these are a compromise
// rather than tuned against one known background; idle's mid-grey in
// particular may read faint on a light host page.
const STATE_COLORS: Record<WidgetState, string> = {
  idle: "#9ca3af",
  connecting: "#a855f7",
  listening: "#22c55e",
  speaking: "#3b82f6",
  error: "#ef4444",
};

// How long to wait after joining the room for the agent to actually publish
// an audio track before treating it as a dispatch failure.
const DISPATCH_TIMEOUT_MS = 8000;

// How long the hangup button stays "armed" (awaiting a confirming second
// tap) before silently disarming itself.
const HANGUP_REVERT_MS = 3000;

// How long to buffer a cross-page navigate before actually moving the page
// (see navigation.ts's crossPageDelayMs) — the navigate event can fire
// mid-sentence (voice_runtime's navigation_min_spoken_chars), so without
// this the page would unload before the in-flight TTS clause finishes
// playing, audibly cutting the agent off. A heuristic buffer for a short
// spoken clause, not a measurement of actual playout completion — tune if
// it proves too short/long in practice.
const CROSS_PAGE_NAVIGATE_DELAY_MS = 1500;

const STYLE = `
  :host {
    all: initial;
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2147483647;
    font-family: system-ui, -apple-system, sans-serif;
  }
  .wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  button.visualizer {
    width: 64px;
    height: 64px;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
    display: block;
    transition: transform 150ms ease;
  }
  button.visualizer:active {
    transform: scale(0.95);
  }
  /* :host{all:initial} plus a fully custom, unfilled button means the UA
     focus ring may not show at all — make it explicit for keyboard users.
     A dark outline so it also reads against a light host page, now that
     there's no dark disc guaranteeing contrast underneath it. */
  button.visualizer:focus-visible {
    outline: 2px solid #1f2937;
    outline-offset: 4px;
  }
  .ring {
    /* Every --mw-* is defaulted here, not inherited: :host{all:initial}
       does NOT reset custom properties (per spec), so a host page's own
       --mw-l or --mw-color would otherwise reach these bars. */
    --mw-l: 0;
    --mw-a: 0deg;
    --mw-bar-color: #9ca3af;
    --mw-bar-w: 3px;
    --mw-bar-min: 3px;
    --mw-bar-max: 14px;
    --mw-ring-r: 15px;
    position: relative;
    width: 64px;
    height: 64px;
    pointer-events: none;
    contain: layout style;
  }
  .ring .bar {
    position: absolute;
    left: 50%;
    /* bottom (not top) pins the inner end to the exact ring centre at ANY
       height — with top:50% the transform-origin would move as height
       changes and every bar would drift outward as it grew. */
    bottom: 50%;
    width: var(--mw-bar-w);
    margin-left: calc(var(--mw-bar-w) / -2);
    height: calc(var(--mw-bar-min) + var(--mw-l) * (var(--mw-bar-max) - var(--mw-bar-min)));
    border-radius: calc(var(--mw-bar-w) / 2);
    background: var(--mw-bar-color);
    transform-origin: 50% 100%;
    transform: rotate(var(--mw-a)) translateY(calc(-1 * var(--mw-ring-r)));
    will-change: height;
  }
  /* Compositor-only flourishes: zero JS, so the rAF loop stays OFF at idle. */
  .ring[data-state="idle"] {
    animation: mw-breathe 3s ease-in-out infinite;
  }
  .ring[data-state="speaking"] {
    animation: mw-spin 8s linear infinite;
  }
  .ring[data-state="error"] {
    opacity: 0.6;
  }
  .ring[data-muted="true"] {
    opacity: 0.5;
  }
  @keyframes mw-breathe {
    0%, 100% { opacity: 0.75; }
    50% { opacity: 1; }
  }
  @keyframes mw-spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .ring { animation: none; }
    button.visualizer { transition: none; }
  }
  .label {
    font-size: 12px;
    color: #1f2937;
    background: rgba(255, 255, 255, 0.9);
    padding: 2px 8px;
    border-radius: 6px;
    max-width: 220px;
    text-align: center;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px;
    border-radius: 999px;
    background: #111827;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  }
  button.ctl {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font: inherit;
    font-size: 12px;
    line-height: 1;
    padding: 6px 8px;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: #e5e7eb;
    cursor: pointer;
  }
  button.ctl:hover {
    background: rgba(255, 255, 255, 0.1);
  }
  button.ctl:focus-visible {
    outline: 2px solid #ffffff;
    outline-offset: 1px;
  }
  button.ctl.mic[data-muted="true"] {
    color: #f87171;
  }
  button.ctl.chat[data-open="true"] {
    background: rgba(255, 255, 255, 0.16);
  }
  button.ctl.leave {
    color: #fdba74;
  }
  button.ctl.leave[data-armed="true"] {
    background: #dc2626;
    color: #fff;
  }
  .text-form {
    display: flex;
    gap: 4px;
  }
  .text-input {
    font-size: 13px;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid #d1d5db;
    width: 160px;
  }
  .text-send {
    font-size: 13px;
    padding: 6px 10px;
    border-radius: 6px;
    border: none;
    background: #4b5563;
    color: #fff;
    cursor: pointer;
  }
`;

/** The widget's Custom Element shell.
 *
 * Configured declaratively via attributes, not a global config object —
 * `<maneki-widget site-id="acme" gateway-url="https://gateway.example.com">`.
 * Missing either attribute is treated as an embedding mistake on the
 * owner's side (same fail-silent philosophy as a 403 from /widget/token):
 * nothing renders, an error is logged for the developer, but the host page
 * never sees a broken UI.
 */
export class ManekiWidgetElement extends HTMLElement {
  private stateMachine = new WidgetStateMachine();
  private unsubscribe: (() => void) | null = null;
  private vizEl!: HTMLButtonElement;
  private visualizer: RadialVisualizer | null = null;
  private labelEl!: HTMLSpanElement;
  private micEl!: HTMLButtonElement;
  private textInputEl!: HTMLInputElement;
  private textFormEl!: HTMLFormElement;
  private textToggleEl!: HTMLButtonElement;
  private hangupEl!: HTMLButtonElement;
  private audioContainer!: HTMLDivElement;
  private connection: LiveKitConnection | null = null;
  private errorMessage: string | null = null;
  private dispatchTimeoutId: ReturnType<typeof setTimeout> | null = null;
  // Cancels a cross-page navigate or click still buffered inside its
  // CROSS_PAGE_NAVIGATE_DELAY_MS window — see handleDataMessage's
  // "interrupt" case, which aborts it if a barge-in lands before it fires.
  // One field, not two: only one cross-page page-action is ever pending at
  // a time, and both "navigate" and "click" fall through to the same
  // handleNavigate on refusal/no-match, so a single cancel contract covers
  // both without replicating it.
  private pendingPageActionCancel: (() => void) | null = null;
  private reconnectAttempted = false;
  private hangupArmed = false;
  private hangupRevertTimerId: ReturnType<typeof setTimeout> | null = null;
  private textInputRevealed = false;
  private micMuted = false;
  // Per-source amplitude samplers, fed by connectToRoom's onAudioProbe. Map
  // rather than two fields because a source may never arrive at all (no
  // usable Web Audio, an older SDK build, or the AudioContext cap) — see
  // livekit-connection.ts's AudioProbeHandler doc comment.
  private samplers = new Map<AudioProbeKind, AudioLevelSampler>();
  // Reused every frame — sampleAudio() must not allocate on the hot path.
  private levels = new Float32Array(DEFAULT_BAR_COUNT);
  private frameId: number | null = null;
  private frameLoopBroken = false;
  // Test/fixture-only bypass — see setSyntheticAudioLevel below.
  private syntheticLevel: number | null = null;

  /** The gateway to talk to: the `gateway-url` attribute if present, else the
   * URL baked in at build time (see vite.config.ts). A released build carries
   * the production gateway so the embed snippet is a single tag with no
   * config; the attribute stays available to point a page at a local or
   * staging gateway. Empty string means neither was supplied. */
  private resolveGatewayUrl(): string {
    return this.getAttribute("gateway-url") || __MANEKI_GATEWAY_URL__;
  }

  connectedCallback(): void {
    const siteId = this.getAttribute("site-id");
    if (!siteId || !this.resolveGatewayUrl()) {
      console.error(
        "<maneki-widget> requires a site-id attribute, and a gateway-url attribute " +
          "unless this build has one baked in — not rendering."
      );
      return;
    }

    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = STYLE;
    shadow.appendChild(style);

    const wrap = document.createElement("div");
    wrap.className = "wrap";

    this.vizEl = document.createElement("button");
    this.vizEl.type = "button";
    this.vizEl.className = "visualizer";
    this.vizEl.setAttribute("aria-label", "Talk to us");
    this.vizEl.addEventListener("click", () => this.handleTapToTalk());

    this.visualizer = createRadialVisualizer(document);
    this.vizEl.appendChild(this.visualizer.root);

    this.labelEl = document.createElement("span");
    this.labelEl.className = "label";

    const controls = document.createElement("div");
    controls.className = "controls";

    this.micEl = document.createElement("button");
    this.micEl.type = "button";
    this.micEl.className = "ctl mic";
    this.micEl.addEventListener("click", () => void this.handleMicTap());

    // Accessibility/no-mic fallback alongside the voice orb — typed text
    // drives the identical backend pipeline as a transcribed voice turn
    // (LiveKit Agents' built-in "lk.chat" text-stream handler calls the
    // same generate_reply() a confirmed voice utterance does — see
    // livekit-connection.ts's CHAT_TOPIC comment). Collapsed behind a
    // toggle by default (see textInputRevealed/handleTextToggle) so it
    // reads as a deliberate secondary channel rather than a second,
    // competing input method shown to every visitor.
    this.textToggleEl = document.createElement("button");
    this.textToggleEl.type = "button";
    this.textToggleEl.className = "ctl chat";
    this.textToggleEl.addEventListener("click", () => this.handleTextToggle());

    this.hangupEl = document.createElement("button");
    this.hangupEl.className = "ctl leave";
    this.hangupEl.type = "button";
    this.hangupEl.addEventListener("click", () => this.handleHangupTap());

    controls.appendChild(this.micEl);
    controls.appendChild(this.textToggleEl);
    controls.appendChild(this.hangupEl);

    this.textFormEl = document.createElement("form");
    this.textFormEl.className = "text-form";
    this.textInputEl = document.createElement("input");
    this.textInputEl.type = "text";
    this.textInputEl.className = "text-input";
    this.textInputEl.placeholder = "Type a message…";
    this.textInputEl.setAttribute("aria-label", "Type a message");
    const sendBtn = document.createElement("button");
    sendBtn.type = "submit";
    sendBtn.className = "text-send";
    sendBtn.textContent = "Send";
    this.textFormEl.appendChild(this.textInputEl);
    this.textFormEl.appendChild(sendBtn);
    this.textFormEl.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const text = this.textInputEl.value;
      this.textInputEl.value = "";
      void this.handleTextSubmit(text);
    });

    this.audioContainer = document.createElement("div");
    this.audioContainer.style.display = "none";

    wrap.appendChild(this.vizEl);
    wrap.appendChild(this.labelEl);
    wrap.appendChild(controls);
    wrap.appendChild(this.textFormEl);
    shadow.appendChild(wrap);
    shadow.appendChild(this.audioContainer);

    this.unsubscribe = this.stateMachine.subscribe((state) => this.render(state));
    this.render(this.stateMachine.state);

    this.maybeAutoResume();
  }

  /** If the agent triggered a cross-page navigation last page load,
   * navigation.ts marked this flag right before the location.href
   * assignment. The sessionStorage grant already survived the
   * navigation on its own; this flag is what decides whether to
   * immediately reconnect on it, rather than waiting for another tap —
   * the visitor already opted in once, this page load is a continuation
   * of that same conversation, not a fresh visit.
   *
   * Known limitation: browsers may still block audio autoplay here since
   * a page load isn't a user gesture, even though mic-permission itself
   * typically persists per-origin without a new prompt. Worth revisiting
   * if it turns out to bite in practice — not addressed further here. */
  private maybeAutoResume(): void {
    if (window.sessionStorage.getItem(PENDING_NAVIGATION_KEY) !== "1") return;
    window.sessionStorage.removeItem(PENDING_NAVIGATION_KEY);
    this.reconnectAttempted = false;
    void this.attemptConnect();
  }

  disconnectedCallback(): void {
    this.stopFrameLoop();
    this.samplers.clear();
    this.visualizer?.destroy();
    this.visualizer = null;
    this.unsubscribe?.();
    this.clearDispatchTimeout();
    this.clearHangupRevertTimer();
    this.cancelPendingPageAction();
    void this.connection?.disconnect();
  }

  /** Exposed for tests and for later sessions to drive real state
   * transitions once a real connection exists. */
  setState(state: WidgetState): void {
    this.stateMachine.setState(state);
  }

  get state(): WidgetState {
    return this.stateMachine.state;
  }

  /** Test/fixture-only: feeds a synthetic 0..1 amplitude straight into the
   * visualizer, bypassing any analyser. This is how examples/index.html —
   * the project's only visual verification path — exercises
   * amplitude-driven rendering with no gateway and no LiveKit room. Same
   * status as setState above: not part of the embed API. Pass null to
   * release it back to whatever real sampler (if any) is attached. */
  setSyntheticAudioLevel(level: number | null): void {
    this.syntheticLevel = level;
  }

  protected async handleTapToTalk(): Promise<void> {
    // Only idle/error can start a connection — a tap while already
    // connecting/listening/speaking is a no-op, not a reconnect or hangup.
    if (this.state !== "idle" && this.state !== "error") return;
    this.reconnectAttempted = false;
    await this.attemptConnect();
  }

  /** Mute toggle — the mic is otherwise enabled for the whole call and
   * never switchable. Only meaningful once connected; a tap while idle/
   * connecting/error is a no-op since there's no track to mute yet. */
  private async handleMicTap(): Promise<void> {
    if (this.state !== "listening" && this.state !== "speaking") return;
    if (!this.connection) return;

    this.micMuted = !this.micMuted;
    this.render(this.state);
    try {
      await this.connection.setMicrophoneEnabled(!this.micMuted);
    } catch (err) {
      console.error("<maneki-widget> failed to toggle the microphone:", err);
    }
  }

  /** The hangup button requires two taps: the first "arms" it (and
   * auto-disarms after HANGUP_REVERT_MS if left untouched, so a single
   * stray tap can't end the call), the second actually disconnects. */
  private async handleHangupTap(): Promise<void> {
    if (!this.hangupArmed) {
      this.hangupArmed = true;
      this.render(this.state);
      this.hangupRevertTimerId = setTimeout(() => {
        this.hangupRevertTimerId = null;
        this.hangupArmed = false;
        this.render(this.state);
      }, HANGUP_REVERT_MS);
      return;
    }

    this.clearHangupRevertTimer();
    await this.endCall();
  }

  /** Visitor-initiated hangup — the only path (besides the element being
   * removed from the DOM, see disconnectedCallback) that intentionally
   * disconnects and returns to idle. Deliberately leaves the sessionStorage
   * grant alone: it exists so a conversation can resume on a later tap, and
   * ending one call shouldn't burn that continuity. */
  private async endCall(): Promise<void> {
    this.clearDispatchTimeout();
    this.clearHangupRevertTimer();
    // A visitor who explicitly hangs up shouldn't have the page yanked out
    // from under them a moment later by a navigate/click that was still buffered.
    this.cancelPendingPageAction();
    await this.connection?.disconnect();
    this.connection = null;
    this.reconnectAttempted = false;
    this.errorMessage = null;
    this.hangupArmed = false;
    this.samplers.clear();
    this.syntheticLevel = null;
    this.micMuted = false;
    this.setState("idle");
  }

  /** Reveals/collapses the text-input fallback. Deliberately independent of
   * call state — once a visitor opts into typing, it stays revealed across
   * connecting/listening/speaking/error rather than re-hiding itself and
   * forcing them to rediscover the toggle after every turn. */
  private handleTextToggle(): void {
    this.textInputRevealed = !this.textInputRevealed;
    this.render(this.state);
    if (this.textInputRevealed) this.textInputEl.focus();
  }

  /** Connects first (same flow as tap-to-talk) if not already connected,
   * then sends the typed text over the room's "lk.chat" text stream — the
   * backend treats it exactly like a transcribed voice turn. */
  private async handleTextSubmit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (this.state === "idle" || this.state === "error") {
      this.reconnectAttempted = false;
      await this.attemptConnect();
    }
    if (!this.connection) return; // attemptConnect failed; error state already shown

    await this.connection.sendText(trimmed);
  }

  private async attemptConnect(): Promise<void> {
    const siteId = this.getAttribute("site-id")!;
    // Non-null safe: connectedCallback refused to render without both.
    const gatewayUrl = this.resolveGatewayUrl();

    this.errorMessage = null;

    // getUserMedia only exists in a secure context — HTTPS, or the literal
    // hostnames localhost/127.0.0.1. On any other plain-HTTP origin
    // navigator.mediaDevices is undefined and mic capture is impossible;
    // no token or room-join can salvage that. A production embed is always
    // HTTPS, so this only bites local plain-HTTP testing — but detecting it
    // here turns an otherwise-cryptic deep-in-livekit-client crash
    // ("Cannot read properties of undefined (reading 'getUserMedia')")
    // into a clear, actionable message.
    if (!navigator.mediaDevices?.getUserMedia) {
      console.error(
        "<maneki-widget> no getUserMedia — this origin is not a secure context (needs HTTPS or localhost)."
      );
      this.errorMessage = "Voice needs a secure (HTTPS) connection.";
      this.setState("error");
      return;
    }

    this.setState("connecting");
    try {
      const {
        token,
        livekit_url: livekitUrl,
        grant,
      } = await requestWidgetToken(gatewayUrl, {
        siteId,
        pageUrl: window.location.href,
        grant: readGrant() ?? undefined,
      });
      // Stored before connecting, not after: the grant is what makes the next
      // page's request resume this same conversation, and a failure between
      // here and a successful join shouldn't cost the visitor their identity.
      storeGrant(grant);

      this.connection = await connectToRoom(livekitUrl, token, {
        onRemoteAudio: (audioEl) => {
          this.clearDispatchTimeout();
          this.audioContainer.appendChild(audioEl);
          this.setState("speaking");
        },
        onDataMessage: (message) => this.handleDataMessage(message),
        onDisconnected: () => this.handleUnexpectedDisconnect(),
        onTranscription: (text, speaker) => console.log(`${speaker}> ${text}`),
        onAudioProbe: (probe) => {
          this.samplers.set(probe.kind, createFrequencySampler(probe.analyser));
        },
      });

      this.setState("listening");
      this.startDispatchTimeout();
    } catch (err) {
      this.handleConnectError(err);
    }
  }

  private handleConnectError(err: unknown): void {
    if (err instanceof WidgetTokenError) {
      if (err.status === 403) {
        // Config problem on the owner's side (unpublished tenant, or an
        // Origin that doesn't match what they configured) — no retry can
        // fix this, so disappear entirely rather than show a broken state
        // on their site. The frame loop is running (state is "connecting"),
        // and since the element stays in the DOM hidden rather than
        // removed, disconnectedCallback never fires to stop it — without
        // this explicit stop it would tick a hidden subtree forever.
        console.error("<maneki-widget> 403 from the gateway — hiding (site not published or Origin mismatch).");
        this.stopFrameLoop();
        this.style.display = "none";
        return;
      }
      if (err.status === 429) {
        console.error("<maneki-widget> rate-limited by the gateway:", err);
        this.errorMessage = "High demand right now — please try again in a moment.";
        this.setState("error");
        return;
      }
    }

    if (isMicPermissionDenied(err)) {
      this.errorMessage = "Microphone access is blocked — check your browser's site settings.";
      this.setState("error");
      return;
    }

    console.error("<maneki-widget> failed to connect:", err);
    this.errorMessage = null;
    this.setState("error");
  }

  /** Fires only for a disconnect we didn't initiate ourselves (see
   * livekit-connection.ts's intentionalDisconnect flag) — a real dropped
   * connection. One silent reconnect attempt, reusing the same session_id
   * so the conversation resumes rather than restarting; a second failure
   * in a row gives up and shows a state the visitor can retry from. */
  private handleUnexpectedDisconnect(): void {
    this.clearDispatchTimeout();
    this.connection = null;
    // The old room's analysers point at a now-dead track; a reconnect (if
    // one follows) registers fresh ones via onAudioProbe.
    this.samplers.clear();
    this.micMuted = false;
    if (this.reconnectAttempted) {
      this.errorMessage = "Connection lost — tap to reconnect.";
      this.setState("error");
      return;
    }
    this.reconnectAttempted = true;
    void this.attemptConnect();
  }

  private startDispatchTimeout(): void {
    this.clearDispatchTimeout();
    this.dispatchTimeoutId = setTimeout(() => {
      this.dispatchTimeoutId = null;
      // Only fire if still waiting — a track may have already arrived and
      // moved us to "speaking", or the connection may have already dropped.
      if (this.state === "listening") {
        this.errorMessage = "The agent didn't join — please try again.";
        this.setState("error");
      }
    }, DISPATCH_TIMEOUT_MS);
  }

  private clearDispatchTimeout(): void {
    if (this.dispatchTimeoutId !== null) {
      clearTimeout(this.dispatchTimeoutId);
      this.dispatchTimeoutId = null;
    }
  }

  private clearHangupRevertTimer(): void {
    if (this.hangupRevertTimerId !== null) {
      clearTimeout(this.hangupRevertTimerId);
      this.hangupRevertTimerId = null;
    }
  }

  /** Clears whatever cross-page navigate/click is still buffered, calling
   * its cancel handle first if one is pending — the shared body behind
   * disconnectedCallback, endCall, the "navigate"/"click" cases (a second
   * page-action arriving mid-buffer must not leak the first one's timer),
   * and "interrupt" below. */
  private cancelPendingPageAction(): void {
    this.pendingPageActionCancel?.();
    this.pendingPageActionCancel = null;
  }

  private handleDataMessage(message: DataMessage): void {
    switch (message.type) {
      case "navigate":
        if (typeof message.target === "string") {
          this.cancelPendingPageAction();
          this.pendingPageActionCancel =
            handleNavigate(message.target, { crossPageDelayMs: CROSS_PAGE_NAVIGATE_DELAY_MS }) ?? null;
        }
        break;
      case "click":
        if (typeof message.target === "string") {
          this.cancelPendingPageAction();
          this.pendingPageActionCancel =
            handleClick(message.target, {
              crossPageDelayMs: CROSS_PAGE_NAVIGATE_DELAY_MS,
              linkText: typeof message.link_text === "string" ? message.link_text : undefined,
            }) ?? null;
        }
        break;
      case "interrupt":
        // A barge-in that lands inside a still-buffered cross-page
        // navigate/click's delay window means the visitor interrupted the
        // agent right as it announced the move — cancel the pending
        // page-action rather than moving them away from a section they just
        // cut the agent off about. One already committed (delay elapsed, or
        // a same-page scroll which never buffers at all) isn't retracted —
        // there's nothing left to cancel by then.
        this.cancelPendingPageAction();
        // Immediate visual confirmation the interruption registered, ahead
        // of any new audio — the backend's own barge-in handling is what
        // actually stops playback (see voice_runtime/agent.py).
        if (this.state === "speaking") this.setState("listening");
        break;
      default:
        console.warn("<maneki-widget> received an unknown data-channel message type:", message.type);
    }
  }

  /** Feeds the visualizer whichever source is relevant for the current
   * state, once per frame. Deliberately never mixes local + remote: while
   * the agent speaks, the visitor's own mic is picking up that same audio
   * through their speakers, and mixing would make the ring react to the
   * agent twice. Falls back to the other source (then to null, which
   * computeBarMagnitudes renders as a calm shimmer) if the preferred one
   * isn't available or has gone silent long enough to look broken. */
  private sampleAudio(): void {
    if (this.syntheticLevel !== null) {
      this.visualizer?.setAudio({ bars: null, volume: this.syntheticLevel });
      return;
    }
    const prefer: AudioProbeKind = this.state === "speaking" ? "remote" : "local";
    const fallback: AudioProbeKind = prefer === "remote" ? "local" : "remote";
    const sampler = this.samplers.get(prefer) ?? this.samplers.get(fallback);
    const ok = sampler?.sample(this.levels) ?? false;
    this.visualizer?.setAudio(ok ? { bars: this.levels, volume: null } : null);
  }

  /** Which states animate is a pure function of state (and mute) —
   * re-derived on every render(), never driven from a transition handler.
   * idle and error are deliberately STATIC (a compositor-only CSS animation
   * covers idle's breathing look), so an embedded widget schedules ZERO
   * animation frames for the entire time a visitor is not in a call. Muted
   * while listening also schedules nothing — a muted mic has nothing to
   * visualize — but muted while the agent is speaking still animates from
   * the remote probe. */
  private syncFrameLoop(state: WidgetState): void {
    const animated =
      state === "connecting" || state === "speaking" || (state === "listening" && !this.micMuted);
    if (animated && !prefersReducedMotion()) {
      this.startFrameLoop();
    } else {
      this.stopFrameLoop();
    }
  }

  private startFrameLoop(): void {
    if (this.frameId !== null || this.frameLoopBroken) return;
    if (typeof requestAnimationFrame !== "function") return;
    const frame = (t: number): void => {
      try {
        this.sampleAudio();
        this.visualizer?.tick(t);
      } catch (err) {
        // Never let a frame throw into the host page, and never spin on a
        // repeating throw — log once and stop rescheduling.
        console.error("<maneki-widget> visualizer frame failed — animation stopped:", err);
        this.frameId = null;
        this.frameLoopBroken = true;
        return;
      }
      this.frameId = requestAnimationFrame(frame);
    };
    this.frameId = requestAnimationFrame(frame);
  }

  private stopFrameLoop(): void {
    if (this.frameId === null) return;
    cancelAnimationFrame(this.frameId);
    this.frameId = null;
    // Settle to the resting pattern for the current state rather than
    // freezing mid-sweep/mid-amplitude.
    try {
      this.visualizer?.tick(0);
    } catch {
      // Already logged by startFrameLoop's frame() if this is why it broke.
    }
  }

  private render(state: WidgetState): void {
    this.vizEl.dataset.state = state;
    this.visualizer?.setState(state, STATE_COLORS[state]);
    this.visualizer?.setMuted(this.micMuted);
    this.labelEl.textContent = state === "error" && this.errorMessage ? this.errorMessage : STATE_LABELS[state];

    const active = state === "listening" || state === "speaking";
    if (!active) {
      this.clearHangupRevertTimer();
      this.hangupArmed = false;
    }
    this.hangupEl.style.display = active ? "" : "none";
    this.hangupEl.dataset.armed = String(this.hangupArmed);
    const hangupLabel = this.hangupArmed ? "Confirm end call?" : "End call";
    this.hangupEl.textContent = hangupLabel;
    this.hangupEl.setAttribute("aria-label", hangupLabel);

    this.micEl.style.display = active ? "" : "none";
    this.micEl.dataset.muted = String(this.micMuted);
    this.micEl.textContent = this.micMuted ? "🔇 Unmute" : "🎙 Mute";
    this.micEl.setAttribute("aria-label", this.micMuted ? "Unmute microphone" : "Mute microphone");
    this.micEl.setAttribute("aria-pressed", String(this.micMuted));

    const toggleLabel = this.textInputRevealed ? "Hide typing" : "⌨ Prefer to type?";
    this.textToggleEl.textContent = toggleLabel;
    this.textToggleEl.dataset.open = String(this.textInputRevealed);
    this.textToggleEl.setAttribute("aria-label", this.textInputRevealed ? "Hide text input" : "Show text input");
    this.textFormEl.style.display = this.textInputRevealed ? "" : "none";

    this.syncFrameLoop(state);
  }
}

/** jsdom implements no `matchMedia` at all, so the optional call here is
 * load-bearing, not defensive noise — without it every element test would
 * throw a TypeError the first time render() runs. */
function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
