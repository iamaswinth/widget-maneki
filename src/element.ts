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
  private audioContainer!: HTMLDivElement;
  private connection: LiveKitConnection | null = null;
  private errorMessage: string | null = null;
  private dispatchTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempted = false;

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

    this.audioContainer = document.createElement("div");
    this.audioContainer.style.display = "none";

    wrap.appendChild(this.orbEl);
    wrap.appendChild(this.labelEl);
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

  private async attemptConnect(): Promise<void> {
    const siteId = this.getAttribute("site-id")!;
    const gatewayUrl = this.getAttribute("gateway-url")!;

    this.errorMessage = null;
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
  }
}
