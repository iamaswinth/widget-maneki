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
    void this.handleTapToTalk();
  }

  disconnectedCallback(): void {
    this.unsubscribe?.();
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
    // connecting/listening/speaking is a no-op, not a reconnect or hangup
    // (neither is specced yet; see Session 5 for richer interaction).
    if (this.state !== "idle" && this.state !== "error") return;

    const siteId = this.getAttribute("site-id")!;
    const gatewayUrl = this.getAttribute("gateway-url")!;

    this.setState("connecting");
    try {
      const sessionId = getOrCreateSessionId();
      const { token, livekit_url: livekitUrl } = await requestWidgetToken(gatewayUrl, {
        siteId,
        sessionId,
        pageUrl: window.location.href,
      });

      this.connection = await connectToRoom(
        livekitUrl,
        token,
        (audioEl) => {
          this.audioContainer.appendChild(audioEl);
          this.setState("speaking");
        },
        (message) => this.handleDataMessage(message)
      );

      this.setState("listening");
    } catch (err) {
      const status = err instanceof WidgetTokenError ? err.status : "unknown";
      console.error(`<maneki-widget> failed to connect (status=${status}):`, err);
      this.setState("error");
    }
  }

  private handleDataMessage(message: DataMessage): void {
    switch (message.type) {
      case "navigate":
        if (typeof message.target === "string") handleNavigate(message.target);
        break;
      case "interrupt":
        // Visual feedback for barge-in is Session 5 scope — no-op for now.
        break;
      default:
        console.warn("<maneki-widget> received an unknown data-channel message type:", message.type);
    }
  }

  private render(state: WidgetState): void {
    this.orbEl.style.backgroundColor = STATE_COLORS[state];
    this.orbEl.dataset.state = state;
    this.labelEl.textContent = STATE_LABELS[state];
  }
}
