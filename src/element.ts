import { isMicPermissionDenied } from "./errors";
import { requestWidgetToken, WidgetTokenError } from "./gateway-client";
import { connectToRoom, DataMessage, LiveKitConnection } from "./livekit-connection";
import { handleNavigate, PENDING_NAVIGATION_KEY } from "./navigation";
import { getOrCreateSessionId } from "./session";
import { WidgetState, WidgetStateMachine } from "./state";

const STATE_LABELS: Record<WidgetState, string> = {
  idle: "Tap to talk",
  connecting: "Connecting…",
  listening: "Listening…",
  speaking: "Speaking…",
  error: "Something went wrong",
};

const STATE_COLORS: Record<WidgetState, string> = {
  idle: "#4b5563",
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
  button.orb {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    border: none;
    cursor: pointer;
    transition: background-color 200ms ease, transform 150ms ease;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.25);
  }
  button.orb:active {
    transform: scale(0.95);
  }
  button.orb[data-state="connecting"],
  button.orb[data-state="listening"] {
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 2px 12px rgba(0, 0, 0, 0.25); }
    50% { box-shadow: 0 2px 24px rgba(0, 0, 0, 0.4); }
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
  .hangup {
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 6px;
    border: none;
    background: #f97316;
    color: #fff;
    cursor: pointer;
  }
  .hangup[data-armed="true"] {
    background: #dc2626;
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
  private orbEl!: HTMLButtonElement;
  private labelEl!: HTMLSpanElement;
  private textInputEl!: HTMLInputElement;
  private hangupEl!: HTMLButtonElement;
  private audioContainer!: HTMLDivElement;
  private connection: LiveKitConnection | null = null;
  private errorMessage: string | null = null;
  private dispatchTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempted = false;
  private hangupArmed = false;
  private hangupRevertTimerId: ReturnType<typeof setTimeout> | null = null;

  connectedCallback(): void {
    const siteId = this.getAttribute("site-id");
    const gatewayUrl = this.getAttribute("gateway-url");
    if (!siteId || !gatewayUrl) {
      console.error(
        "<maneki-widget> requires both site-id and gateway-url attributes — not rendering."
      );
      return;
    }

    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = STYLE;
    shadow.appendChild(style);

    const wrap = document.createElement("div");
    wrap.className = "wrap";

    this.orbEl = document.createElement("button");
    this.orbEl.className = "orb";
    this.orbEl.setAttribute("aria-label", "Talk to us");
    this.orbEl.addEventListener("click", () => this.handleTapToTalk());

    this.labelEl = document.createElement("span");
    this.labelEl.className = "label";

    this.hangupEl = document.createElement("button");
    this.hangupEl.className = "hangup";
    this.hangupEl.type = "button";
    this.hangupEl.addEventListener("click", () => this.handleHangupTap());

    // Testing/accessibility fallback alongside the mic — typed text drives
    // the identical backend pipeline as a transcribed voice turn (LiveKit
    // Agents' built-in "lk.chat" text-stream handler calls the same
    // generate_reply() a confirmed voice utterance does — see
    // livekit-connection.ts's CHAT_TOPIC comment).
    const textForm = document.createElement("form");
    textForm.className = "text-form";
    this.textInputEl = document.createElement("input");
    this.textInputEl.type = "text";
    this.textInputEl.className = "text-input";
    this.textInputEl.placeholder = "Type a message…";
    this.textInputEl.setAttribute("aria-label", "Type a message");
    const sendBtn = document.createElement("button");
    sendBtn.type = "submit";
    sendBtn.className = "text-send";
    sendBtn.textContent = "Send";
    textForm.appendChild(this.textInputEl);
    textForm.appendChild(sendBtn);
    textForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const text = this.textInputEl.value;
      this.textInputEl.value = "";
      void this.handleTextSubmit(text);
    });

    this.audioContainer = document.createElement("div");
    this.audioContainer.style.display = "none";

    wrap.appendChild(this.orbEl);
    wrap.appendChild(this.labelEl);
    wrap.appendChild(this.hangupEl);
    wrap.appendChild(textForm);
    shadow.appendChild(wrap);
    shadow.appendChild(this.audioContainer);

    this.unsubscribe = this.stateMachine.subscribe((state) => this.render(state));
    this.render(this.stateMachine.state);

    this.maybeAutoResume();
  }

  /** If the agent triggered a cross-page navigation last page load,
   * navigation.ts marked this flag right before the location.href
   * assignment. sessionStorage's session_id already survived the
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
    this.unsubscribe?.();
    this.clearDispatchTimeout();
    this.clearHangupRevertTimer();
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

  protected async handleTapToTalk(): Promise<void> {
    // Only idle/error can start a connection — a tap while already
    // connecting/listening/speaking is a no-op, not a reconnect or hangup.
    if (this.state !== "idle" && this.state !== "error") return;
    this.reconnectAttempted = false;
    await this.attemptConnect();
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
   * session_id alone: it exists so a conversation can resume on a later
   * tap, and ending one call shouldn't burn that continuity. */
  private async endCall(): Promise<void> {
    this.clearDispatchTimeout();
    this.clearHangupRevertTimer();
    await this.connection?.disconnect();
    this.connection = null;
    this.reconnectAttempted = false;
    this.errorMessage = null;
    this.hangupArmed = false;
    this.setState("idle");
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
    const gatewayUrl = this.getAttribute("gateway-url")!;

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
      const sessionId = getOrCreateSessionId();
      const { token, livekit_url: livekitUrl } = await requestWidgetToken(gatewayUrl, {
        siteId,
        sessionId,
        pageUrl: window.location.href,
      });

      this.connection = await connectToRoom(livekitUrl, token, {
        onRemoteAudio: (audioEl) => {
          this.clearDispatchTimeout();
          this.audioContainer.appendChild(audioEl);
          this.setState("speaking");
        },
        onDataMessage: (message) => this.handleDataMessage(message),
        onDisconnected: () => this.handleUnexpectedDisconnect(),
        onTranscription: (text, speaker) => console.log(`${speaker}> ${text}`),
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
        // on their site.
        console.error("<maneki-widget> 403 from the gateway — hiding (site not published or Origin mismatch).");
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

  private handleDataMessage(message: DataMessage): void {
    switch (message.type) {
      case "navigate":
        if (typeof message.target === "string") handleNavigate(message.target);
        break;
      case "interrupt":
        // Immediate visual confirmation the interruption registered, ahead
        // of any new audio — the backend's own barge-in handling is what
        // actually stops playback (see voice_runtime/agent.py).
        if (this.state === "speaking") this.setState("listening");
        break;
      default:
        console.warn("<maneki-widget> received an unknown data-channel message type:", message.type);
    }
  }

  private render(state: WidgetState): void {
    this.orbEl.style.backgroundColor = STATE_COLORS[state];
    this.orbEl.dataset.state = state;
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
  }
}
