import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequestWidgetToken, FakeWidgetTokenError } = vi.hoisted(() => {
  class FakeWidgetTokenError extends Error {
    constructor(
      public status: number,
      message: string
    ) {
      super(message);
    }
  }
  return { mockRequestWidgetToken: vi.fn(), FakeWidgetTokenError };
});
vi.mock("../src/gateway-client", () => ({
  requestWidgetToken: (...args: unknown[]) => mockRequestWidgetToken(...args),
  WidgetTokenError: FakeWidgetTokenError,
}));

const mockConnectToRoom = vi.hoisted(() => vi.fn());
vi.mock("../src/livekit-connection", () => ({
  connectToRoom: (...args: unknown[]) => mockConnectToRoom(...args),
}));

const mockHandleNavigate = vi.hoisted(() => vi.fn());

// vitest's jsdom sets pretendToBeVisual: true, so requestAnimationFrame is
// REAL here, and vi.useFakeTimers() (used below by several tests) fakes it
// too — meaning the 8s dispatch-timeout tests would otherwise run ~240 real
// visualizer frames each. This file tests orchestration, not animation: rAF
// is stubbed globally so those tests stay fast and any tick() bug doesn't
// surface as a confusing, unrelated failure. The rAF lifecycle itself is
// asserted directly against these same stubs in its own describe block.
const RAF_ID = 42;
const mockRaf = vi.fn().mockReturnValue(RAF_ID);
const mockCancelRaf = vi.fn();

vi.mock("../src/navigation", async (importOriginal) => {
  // Only handleNavigate is mocked — PENDING_NAVIGATION_KEY must stay the
  // real exported value, since element.ts's auto-resume check reads it
  // directly (see element-resume tests below).
  const actual = await importOriginal<typeof import("../src/navigation")>();
  return { ...actual, handleNavigate: (...args: unknown[]) => mockHandleNavigate(...args) };
});

import "../src/index";
import { PENDING_NAVIGATION_KEY } from "../src/navigation";
import type { ManekiWidgetElement } from "../src/element";
import type { ConnectToRoomHandlers } from "../src/livekit-connection";

function mountWidget(): ManekiWidgetElement {
  const el = document.createElement("maneki-widget") as ManekiWidgetElement;
  el.setAttribute("site-id", "acme");
  el.setAttribute("gateway-url", "https://gateway.example.com");
  document.body.appendChild(el);
  return el;
}

function click(el: ManekiWidgetElement): void {
  el.shadowRoot!.querySelector<HTMLButtonElement>("button.visualizer")!.click();
}

function hangupButton(el: ManekiWidgetElement): HTMLButtonElement {
  return el.shadowRoot!.querySelector<HTMLButtonElement>("button.ctl.leave")!;
}

function clickHangup(el: ManekiWidgetElement): void {
  hangupButton(el).click();
}

function micButton(el: ManekiWidgetElement): HTMLButtonElement {
  return el.shadowRoot!.querySelector<HTMLButtonElement>("button.ctl.mic")!;
}

function clickMic(el: ManekiWidgetElement): void {
  micButton(el).click();
}

function submitText(el: ManekiWidgetElement, text: string): void {
  const input = el.shadowRoot!.querySelector<HTMLInputElement>(".text-input")!;
  const form = el.shadowRoot!.querySelector<HTMLFormElement>(".text-form")!;
  input.value = text;
  form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
}

function textToggleButton(el: ManekiWidgetElement): HTMLButtonElement {
  return el.shadowRoot!.querySelector<HTMLButtonElement>("button.ctl.chat")!;
}

function revealTextInput(el: ManekiWidgetElement): void {
  textToggleButton(el).click();
}

function label(el: ManekiWidgetElement): string {
  return el.shadowRoot!.querySelector(".label")!.textContent!;
}

const TOKEN_RESPONSE = {
  token: "jwt",
  livekit_url: "wss://lk.example.com",
  room: "room-1",
  grant: "grant-issued",
};

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
  mockRequestWidgetToken.mockReset();
  mockConnectToRoom.mockReset();
  mockHandleNavigate.mockReset();
  window.sessionStorage.clear();
  // jsdom leaves navigator.mediaDevices undefined; the widget's secure-context
  // guard checks for it before connecting, so stub a getUserMedia here to
  // represent the normal (secure-context) case. The "insecure context"
  // describe block below removes it to exercise the guard.
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: () => Promise.resolve({}) },
    configurable: true,
  });
  mockRaf.mockClear();
  mockCancelRaf.mockClear();
  vi.stubGlobal("requestAnimationFrame", mockRaf);
  vi.stubGlobal("cancelAnimationFrame", mockCancelRaf);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tap-to-talk orchestration", () => {
  it("goes idle -> connecting -> listening on a successful connection", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    mockConnectToRoom.mockResolvedValue({ disconnect: vi.fn() });

    const el = mountWidget();
    expect(el.state).toBe("idle");

    click(el);
    // The synchronous prefix of handleTapToTalk (setState("connecting"))
    // runs before the click handler returns, ahead of any await.
    expect(el.state).toBe("connecting");

    await vi.waitFor(() => expect(el.state).toBe("listening"));

    expect(mockRequestWidgetToken).toHaveBeenCalledWith(
      "https://gateway.example.com",
      expect.objectContaining({ siteId: "acme" })
    );
    expect(mockConnectToRoom).toHaveBeenCalledWith(
      "wss://lk.example.com",
      "jwt",
      expect.objectContaining({
        onRemoteAudio: expect.any(Function),
        onDataMessage: expect.any(Function),
        onDisconnected: expect.any(Function),
      })
    );
  });

  it("transitions to speaking when the remote audio callback fires", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    let handlers!: ConnectToRoomHandlers;
    mockConnectToRoom.mockImplementation(async (_url: string, _token: string, h: ConnectToRoomHandlers) => {
      handlers = h;
      return { disconnect: vi.fn() };
    });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    handlers.onRemoteAudio(document.createElement("audio"));

    expect(el.state).toBe("speaking");
  });

  it("goes to the error state when the token request fails for an unrecognized reason", async () => {
    mockRequestWidgetToken.mockRejectedValue(new FakeWidgetTokenError(500, "boom"));

    const el = mountWidget();
    click(el);

    await vi.waitFor(() => expect(el.state).toBe("error"));
    expect(mockConnectToRoom).not.toHaveBeenCalled();
  });

  it("ignores a second tap while already connecting", async () => {
    mockConnectToRoom.mockResolvedValue({ disconnect: vi.fn() });
    let resolveToken!: (value: unknown) => void;
    mockRequestWidgetToken.mockReturnValue(
      new Promise((resolve) => {
        resolveToken = resolve;
      })
    );

    const el = mountWidget();
    click(el);
    click(el); // second tap while still "connecting"

    expect(mockRequestWidgetToken).toHaveBeenCalledTimes(1);

    resolveToken(TOKEN_RESPONSE);
    await vi.waitFor(() => expect(el.state).toBe("listening"));
  });

  it("sends no grant on a first visit, then persists the one it gets back", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    mockConnectToRoom.mockResolvedValue({ disconnect: vi.fn() });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    expect(mockRequestWidgetToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ grant: undefined })
    );
    // Persisting it is what lets the next page resume this conversation.
    expect(window.sessionStorage.getItem("maneki_visitor_grant")).toBe("grant-issued");
  });

  it("replays the stored grant on a later connect", async () => {
    window.sessionStorage.setItem("maneki_visitor_grant", "grant-from-earlier");
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    mockConnectToRoom.mockResolvedValue({ disconnect: vi.fn() });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    expect(mockRequestWidgetToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ grant: "grant-from-earlier" })
    );
  });

  it("a tap from the error state retries", async () => {
    mockRequestWidgetToken
      .mockRejectedValueOnce(new FakeWidgetTokenError(500, "boom"))
      .mockResolvedValueOnce(TOKEN_RESPONSE);
    mockConnectToRoom.mockResolvedValue({ disconnect: vi.fn() });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("error"));

    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    expect(mockRequestWidgetToken).toHaveBeenCalledTimes(2);
  });
});

describe("data-channel message dispatch", () => {
  async function connectAndCaptureHandlers(): Promise<{
    el: ManekiWidgetElement;
    handlers: ConnectToRoomHandlers;
  }> {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    let handlers!: ConnectToRoomHandlers;
    mockConnectToRoom.mockImplementation(async (_url: string, _token: string, h: ConnectToRoomHandlers) => {
      handlers = h;
      return { disconnect: vi.fn() };
    });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));
    return { el, handlers };
  }

  it("routes a navigate message to handleNavigate with the target", async () => {
    const { handlers } = await connectAndCaptureHandlers();

    handlers.onDataMessage({ type: "navigate", target: "#pricing" });

    expect(mockHandleNavigate).toHaveBeenCalledWith("#pricing");
  });

  it("ignores a navigate message with a non-string target rather than throwing", async () => {
    const { handlers } = await connectAndCaptureHandlers();

    expect(() => handlers.onDataMessage({ type: "navigate", target: 42 })).not.toThrow();
    expect(mockHandleNavigate).not.toHaveBeenCalled();
  });

  it("does not throw on an unknown message type", async () => {
    const { handlers } = await connectAndCaptureHandlers();

    expect(() => handlers.onDataMessage({ type: "something-unexpected" })).not.toThrow();
    expect(mockHandleNavigate).not.toHaveBeenCalled();
  });

  it("an interrupt message while speaking switches the visualizer back to listening", async () => {
    const { el, handlers } = await connectAndCaptureHandlers();
    handlers.onRemoteAudio(document.createElement("audio"));
    expect(el.state).toBe("speaking");

    handlers.onDataMessage({ type: "interrupt" });

    expect(el.state).toBe("listening");
  });

  it("an interrupt message while not speaking is a no-op", async () => {
    const { el, handlers } = await connectAndCaptureHandlers();
    expect(el.state).toBe("listening");

    handlers.onDataMessage({ type: "interrupt" });

    expect(el.state).toBe("listening");
  });
});

describe("cross-page session resume", () => {
  it("auto-reconnects on mount when the pending-navigation flag is set", async () => {
    window.sessionStorage.setItem("maneki_visitor_grant", "grant-existing");
    window.sessionStorage.setItem(PENDING_NAVIGATION_KEY, "1");
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    mockConnectToRoom.mockResolvedValue({ disconnect: vi.fn() });

    const el = mountWidget();

    // No click — mounting alone should have kicked off the connection.
    await vi.waitFor(() => expect(el.state).toBe("listening"));
    // The grant surviving the navigation is what carries the conversation
    // across the page load; the flag only decides whether to reconnect now.
    expect(mockRequestWidgetToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ grant: "grant-existing" })
    );
  });

  it("clears the pending-navigation flag so a later reload doesn't loop-reconnect", async () => {
    window.sessionStorage.setItem(PENDING_NAVIGATION_KEY, "1");
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    mockConnectToRoom.mockResolvedValue({ disconnect: vi.fn() });

    const el = mountWidget();
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    expect(window.sessionStorage.getItem(PENDING_NAVIGATION_KEY)).toBeNull();
  });

  it("does not auto-connect on a normal mount with no pending-navigation flag", async () => {
    const el = mountWidget();

    // Give any stray microtask a chance to run, then confirm nothing fired.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(el.state).toBe("idle");
    expect(mockRequestWidgetToken).not.toHaveBeenCalled();
  });
});

describe("error and edge states", () => {
  it("shows a secure-context message and never requests a token on an insecure origin", async () => {
    // Simulate a plain-HTTP (non-localhost) origin where the browser omits
    // navigator.mediaDevices entirely.
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });

    const el = mountWidget();
    click(el);

    await vi.waitFor(() => expect(el.state).toBe("error"));
    expect(label(el)).toMatch(/secure|https/i);
    // Guarded before any network call — no point issuing a token for a
    // session that can never capture audio.
    expect(mockRequestWidgetToken).not.toHaveBeenCalled();
  });

  it("hides the widget entirely on a 403 (unpublished tenant / Origin mismatch)", async () => {
    mockRequestWidgetToken.mockRejectedValue(new FakeWidgetTokenError(403, "Origin not allowed"));

    const el = mountWidget();
    click(el);

    await vi.waitFor(() => expect(el.style.display).toBe("none"));
    // Not the generic "error" state — this is a distinct fail-silent path.
    expect(el.state).toBe("connecting");
  });

  it("shows a rate-limit-specific message on 429", async () => {
    mockRequestWidgetToken.mockRejectedValue(new FakeWidgetTokenError(429, "Rate limit exceeded"));

    const el = mountWidget();
    click(el);

    await vi.waitFor(() => expect(el.state).toBe("error"));
    expect(label(el)).toMatch(/high demand/i);
  });

  it("shows a mic-permission-specific message when getUserMedia is denied", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    mockConnectToRoom.mockRejectedValue(new DOMException("Permission denied", "NotAllowedError"));

    const el = mountWidget();
    click(el);

    await vi.waitFor(() => expect(el.state).toBe("error"));
    expect(label(el)).toMatch(/microphone/i);
  });

  it("shows a generic message for an unrecognized connection failure", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    mockConnectToRoom.mockRejectedValue(new Error("something else entirely"));

    const el = mountWidget();
    click(el);

    await vi.waitFor(() => expect(el.state).toBe("error"));
    expect(label(el)).toBe("Something went wrong");
  });

  it("silently reconnects once on an unexpected disconnect", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    let handlers!: ConnectToRoomHandlers;
    let connectCount = 0;
    mockConnectToRoom.mockImplementation(async (_url: string, _token: string, h: ConnectToRoomHandlers) => {
      connectCount += 1;
      handlers = h;
      return { disconnect: vi.fn() };
    });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    handlers.onDisconnected();

    await vi.waitFor(() => expect(connectCount).toBe(2));
    await vi.waitFor(() => expect(el.state).toBe("listening"));
    // Reconnected silently — never surfaced as an error to the visitor.
    expect(el.state).not.toBe("error");
  });

  it("gives up after a second consecutive disconnect and shows a retryable error", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    let handlers!: ConnectToRoomHandlers;
    mockConnectToRoom.mockImplementation(async (_url: string, _token: string, h: ConnectToRoomHandlers) => {
      handlers = h;
      return { disconnect: vi.fn() };
    });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    handlers.onDisconnected(); // first drop -> silent reconnect
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    handlers.onDisconnected(); // second drop in a row -> give up

    await vi.waitFor(() => expect(el.state).toBe("error"));
    expect(label(el)).toMatch(/connection lost/i);
  });

  it("a fresh tap after a reconnect-exhausted error resets the retry budget", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    let handlers!: ConnectToRoomHandlers;
    mockConnectToRoom.mockImplementation(async (_url: string, _token: string, h: ConnectToRoomHandlers) => {
      handlers = h;
      return { disconnect: vi.fn() };
    });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));
    handlers.onDisconnected();
    await vi.waitFor(() => expect(el.state).toBe("listening"));
    handlers.onDisconnected();
    await vi.waitFor(() => expect(el.state).toBe("error"));

    click(el); // fresh manual retry
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    // Should be able to silently survive one more drop again, not
    // immediately give up because of the earlier exhausted attempt.
    handlers.onDisconnected();
    await vi.waitFor(() => expect(el.state).toBe("listening"));
  });

  it("falls back to an error state if the agent never joins within the dispatch timeout", async () => {
    vi.useFakeTimers();
    try {
      mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
      mockConnectToRoom.mockResolvedValue({ disconnect: vi.fn() });

      const el = mountWidget();
      click(el);
      await vi.advanceTimersByTimeAsync(0);
      expect(el.state).toBe("listening");

      await vi.advanceTimersByTimeAsync(8000);

      expect(el.state).toBe("error");
      expect(label(el)).toMatch(/didn't join/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire the dispatch-timeout fallback if the agent's audio arrives in time", async () => {
    vi.useFakeTimers();
    try {
      mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
      let handlers!: ConnectToRoomHandlers;
      mockConnectToRoom.mockImplementation(async (_url: string, _token: string, h: ConnectToRoomHandlers) => {
        handlers = h;
        return { disconnect: vi.fn() };
      });

      const el = mountWidget();
      click(el);
      await vi.advanceTimersByTimeAsync(0);

      handlers.onRemoteAudio(document.createElement("audio"));
      expect(el.state).toBe("speaking");

      await vi.advanceTimersByTimeAsync(8000);

      expect(el.state).toBe("speaking");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("text input", () => {
  it("connects first, then sends, when submitted while idle", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    const mockSendText = vi.fn().mockResolvedValue(undefined);
    mockConnectToRoom.mockResolvedValue({ disconnect: vi.fn(), sendText: mockSendText });

    const el = mountWidget();
    expect(el.state).toBe("idle");

    revealTextInput(el);
    submitText(el, "how much does it cost?");
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    expect(mockRequestWidgetToken).toHaveBeenCalledTimes(1);
    expect(mockSendText).toHaveBeenCalledWith("how much does it cost?");
  });

  it("sends directly, without reconnecting, when already connected", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    const mockSendText = vi.fn().mockResolvedValue(undefined);
    mockConnectToRoom.mockResolvedValue({ disconnect: vi.fn(), sendText: mockSendText });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));
    mockRequestWidgetToken.mockClear();

    revealTextInput(el);
    submitText(el, "what about the FAQ?");
    await vi.waitFor(() => expect(mockSendText).toHaveBeenCalledWith("what about the FAQ?"));

    expect(mockRequestWidgetToken).not.toHaveBeenCalled();
  });

  it("is a no-op for empty or whitespace-only input", async () => {
    const el = mountWidget();

    revealTextInput(el);
    submitText(el, "   ");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(el.state).toBe("idle");
    expect(mockRequestWidgetToken).not.toHaveBeenCalled();
  });

  it("leaves the widget in its error state and never sends if the connect attempt fails", async () => {
    mockRequestWidgetToken.mockRejectedValue(new FakeWidgetTokenError(500, "boom"));

    const el = mountWidget();
    revealTextInput(el);
    submitText(el, "hello?");

    await vi.waitFor(() => expect(el.state).toBe("error"));
    expect(mockConnectToRoom).not.toHaveBeenCalled();
  });

  it("clears the input field after submitting", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    mockConnectToRoom.mockResolvedValue({ disconnect: vi.fn(), sendText: vi.fn() });

    const el = mountWidget();
    revealTextInput(el);
    submitText(el, "hello");
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    const input = el.shadowRoot!.querySelector<HTMLInputElement>(".text-input")!;
    expect(input.value).toBe("");
  });
});

describe("text input toggle", () => {
  it("hides the text form and shows the default toggle label on a fresh mount", () => {
    const el = mountWidget();

    expect(el.shadowRoot!.querySelector<HTMLFormElement>(".text-form")!.style.display).toBe("none");
    expect(textToggleButton(el).textContent).toMatch(/prefer to type/i);
  });

  it("reveals the text form and focuses the input on tap", () => {
    const el = mountWidget();

    revealTextInput(el);

    const form = el.shadowRoot!.querySelector<HTMLFormElement>(".text-form")!;
    expect(form.style.display).not.toBe("none");
    expect(el.shadowRoot!.activeElement).toBe(el.shadowRoot!.querySelector(".text-input"));
    expect(textToggleButton(el).textContent).toMatch(/hide/i);
  });

  it("collapses the text form again on a second tap", () => {
    const el = mountWidget();

    revealTextInput(el);
    revealTextInput(el);

    const form = el.shadowRoot!.querySelector<HTMLFormElement>(".text-form")!;
    expect(form.style.display).toBe("none");
    expect(textToggleButton(el).textContent).toMatch(/prefer to type/i);
  });

  it("stays revealed across a state transition instead of collapsing on connect", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    mockConnectToRoom.mockResolvedValue({ disconnect: vi.fn() });

    const el = mountWidget();
    revealTextInput(el);

    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    expect(el.shadowRoot!.querySelector<HTMLFormElement>(".text-form")!.style.display).not.toBe("none");
  });
});

describe("hangup", () => {
  it("hides the hangup button while idle", () => {
    const el = mountWidget();
    expect(hangupButton(el).style.display).toBe("none");
  });

  it("shows the hangup button once listening", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    mockConnectToRoom.mockResolvedValue({ disconnect: vi.fn() });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    expect(hangupButton(el).style.display).not.toBe("none");
  });

  it("arms on the first tap without disconnecting", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    const mockDisconnect = vi.fn().mockResolvedValue(undefined);
    mockConnectToRoom.mockResolvedValue({ disconnect: mockDisconnect });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    clickHangup(el);

    expect(mockDisconnect).not.toHaveBeenCalled();
    expect(el.state).toBe("listening");
    expect(hangupButton(el).textContent).toMatch(/confirm/i);
  });

  it("disconnects and returns to idle on a confirming second tap", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    const mockDisconnect = vi.fn().mockResolvedValue(undefined);
    mockConnectToRoom.mockResolvedValue({ disconnect: mockDisconnect });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    clickHangup(el); // arm
    clickHangup(el); // confirm
    await vi.waitFor(() => expect(el.state).toBe("idle"));

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(hangupButton(el).style.display).toBe("none");
    expect(label(el)).toBe("Tap to talk");
  });

  it("auto-reverts the armed state after the timeout without disconnecting", async () => {
    vi.useFakeTimers();
    try {
      mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
      const mockDisconnect = vi.fn().mockResolvedValue(undefined);
      mockConnectToRoom.mockResolvedValue({ disconnect: mockDisconnect });

      const el = mountWidget();
      click(el);
      await vi.advanceTimersByTimeAsync(0);
      expect(el.state).toBe("listening");

      clickHangup(el);
      expect(hangupButton(el).textContent).toMatch(/confirm/i);

      await vi.advanceTimersByTimeAsync(3000);

      expect(hangupButton(el).textContent).toMatch(/end call/i);
      expect(hangupButton(el).textContent).not.toMatch(/confirm/i);
      expect(mockDisconnect).not.toHaveBeenCalled();
      expect(el.state).toBe("listening");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the sessionStorage grant untouched after a confirmed hangup", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    mockConnectToRoom.mockResolvedValue({ disconnect: vi.fn().mockResolvedValue(undefined) });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));
    const storedGrant = window.sessionStorage.getItem("maneki_visitor_grant");
    expect(storedGrant).toBeTruthy();

    clickHangup(el);
    clickHangup(el);
    await vi.waitFor(() => expect(el.state).toBe("idle"));

    expect(window.sessionStorage.getItem("maneki_visitor_grant")).toBe(storedGrant);
  });

  it("resets the armed state instead of leaving a stale confirm label after an unexpected disconnect", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    let handlers!: ConnectToRoomHandlers;
    mockConnectToRoom.mockImplementation(async (_url: string, _token: string, h: ConnectToRoomHandlers) => {
      handlers = h;
      return { disconnect: vi.fn().mockResolvedValue(undefined) };
    });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    clickHangup(el); // arm
    expect(hangupButton(el).textContent).toMatch(/confirm/i);

    handlers.onDisconnected(); // first drop -> silent reconnect
    handlers.onDisconnected(); // second drop in a row -> give up

    await vi.waitFor(() => expect(el.state).toBe("error"));
    expect(hangupButton(el).style.display).toBe("none");

    // A fresh connect afterward starts unarmed, not still "confirming".
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));
    expect(hangupButton(el).textContent).toMatch(/end call/i);
  });
});

describe("visualizer animation lifecycle", () => {
  it("schedules no animation frames while idle", () => {
    mountWidget();
    expect(mockRaf).not.toHaveBeenCalled();
  });

  it("starts the frame loop once listening and cancels it when the element is removed", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    mockConnectToRoom.mockResolvedValue({ disconnect: vi.fn(), setMicrophoneEnabled: vi.fn() });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    expect(mockRaf).toHaveBeenCalled();

    el.remove();

    expect(mockCancelRaf).toHaveBeenCalledWith(RAF_ID);
  });

  it("passes onAudioProbe to connectToRoom", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    mockConnectToRoom.mockResolvedValue({ disconnect: vi.fn(), setMicrophoneEnabled: vi.fn() });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    expect(mockConnectToRoom).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ onAudioProbe: expect.any(Function) })
    );
  });

  it("feeding an audio probe does not throw and the ring stays intact", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    let handlers!: ConnectToRoomHandlers;
    mockConnectToRoom.mockImplementation(async (_url: string, _token: string, h: ConnectToRoomHandlers) => {
      handlers = h;
      return { disconnect: vi.fn(), setMicrophoneEnabled: vi.fn() };
    });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    // Assert only that feeding a probe doesn't throw and the ring is
    // structurally intact — never the animated values themselves, which
    // would make this test flaky against future tuning of the motion math.
    expect(() =>
      handlers.onAudioProbe?.({
        kind: "local",
        analyser: { frequencyBinCount: 64, getByteFrequencyData: (a: Uint8Array) => a.fill(200) },
        calculateVolume: () => 0.5,
      })
    ).not.toThrow();
    expect(el.shadowRoot!.querySelectorAll(".ring .bar").length).toBe(28);
  });

  it("stops the frame loop when a 403 hides the widget", async () => {
    mockRequestWidgetToken.mockRejectedValue(new FakeWidgetTokenError(403, "Origin not allowed"));

    const el = mountWidget();
    click(el);

    await vi.waitFor(() => expect(el.style.display).toBe("none"));
    // Regression guard: state is "connecting" (so the loop is running) at
    // the moment of the 403, and the element stays in the DOM hidden rather
    // than removed, so disconnectedCallback never fires to stop it — without
    // an explicit stop here the loop would tick a hidden subtree forever.
    expect(mockCancelRaf).toHaveBeenCalled();
  });
});

describe("mic mute", () => {
  it("is hidden while idle", () => {
    const el = mountWidget();
    expect(micButton(el).style.display).toBe("none");
  });

  it("shows once listening and toggles mute on tap", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    const mockSetMicrophoneEnabled = vi.fn().mockResolvedValue(undefined);
    mockConnectToRoom.mockResolvedValue({
      disconnect: vi.fn(),
      setMicrophoneEnabled: mockSetMicrophoneEnabled,
    });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    expect(micButton(el).style.display).not.toBe("none");
    expect(micButton(el).dataset.muted).toBe("false");

    clickMic(el);
    await vi.waitFor(() => expect(micButton(el).dataset.muted).toBe("true"));
    expect(mockSetMicrophoneEnabled).toHaveBeenCalledWith(false);

    clickMic(el);
    await vi.waitFor(() => expect(micButton(el).dataset.muted).toBe("false"));
    expect(mockSetMicrophoneEnabled).toHaveBeenCalledWith(true);
  });

  it("stops the frame loop while muted and listening", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    mockConnectToRoom.mockResolvedValue({
      disconnect: vi.fn(),
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
    });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));
    mockCancelRaf.mockClear();

    clickMic(el);
    await vi.waitFor(() => expect(micButton(el).dataset.muted).toBe("true"));

    expect(mockCancelRaf).toHaveBeenCalled();
  });

  it("resets after a confirmed hangup and a fresh connect", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    mockConnectToRoom.mockResolvedValue({
      disconnect: vi.fn().mockResolvedValue(undefined),
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
    });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));
    clickMic(el);
    await vi.waitFor(() => expect(micButton(el).dataset.muted).toBe("true"));

    clickHangup(el);
    clickHangup(el);
    await vi.waitFor(() => expect(el.state).toBe("idle"));

    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));
    expect(micButton(el).dataset.muted).toBe("false");
  });
});
