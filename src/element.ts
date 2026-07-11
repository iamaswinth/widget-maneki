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

/** The widget's Custom Element shell. Session 1 scope only: visual states
 * driven by a mocked state machine, no real LiveKit connection yet — that's
 * Session 2. `handleTapToTalk` is a deliberate stub extension point. */
export class ManekiWidgetElement extends HTMLElement {
  private stateMachine = new WidgetStateMachine();
  private unsubscribe: (() => void) | null = null;
  private orbEl!: HTMLButtonElement;
  private labelEl!: HTMLSpanElement;

  connectedCallback(): void {
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

    wrap.appendChild(this.orbEl);
    wrap.appendChild(this.labelEl);
    shadow.appendChild(wrap);

    this.unsubscribe = this.stateMachine.subscribe((state) => this.render(state));
    this.render(this.stateMachine.state);
  }

  disconnectedCallback(): void {
    this.unsubscribe?.();
  }

  /** Exposed for tests and for later sessions to drive real state
   * transitions once a real connection exists. */
  setState(state: WidgetState): void {
    this.stateMachine.setState(state);
  }

  get state(): WidgetState {
    return this.stateMachine.state;
  }

  /** Stub — Session 2 replaces this with the real lazy-load-livekit-client
   * + POST /widget/token + room-join flow. */
  protected handleTapToTalk(): void {
    // Intentionally empty in Session 1.
  }

  private render(state: WidgetState): void {
    this.orbEl.style.backgroundColor = STATE_COLORS[state];
    this.orbEl.dataset.state = state;
    this.labelEl.textContent = STATE_LABELS[state];
  }
}
