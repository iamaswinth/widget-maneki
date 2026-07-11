import { beforeEach, describe, expect, it, vi } from "vitest";

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
  el.shadowRoot!.querySelector<HTMLButtonElement>("button.orb")!.click();
}

function label(el: ManekiWidgetElement): string {
  return el.shadowRoot!.querySelector(".label")!.textContent!;
}

const TOKEN_RESPONSE = { token: "jwt", livekit_url: "wss://lk.example.com", room: "room-1" };

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
  mockRequestWidgetToken.mockReset();
  mockConnectToRoom.mockReset();
  mockHandleNavigate.mockReset();
  window.sessionStorage.clear();
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

  it("sends the sessionStorage session_id in the token request", async () => {
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    mockConnectToRoom.mockResolvedValue({ disconnect: vi.fn() });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    const sessionId = window.sessionStorage.getItem("maneki_session_id");
    expect(sessionId).toBeTruthy();
    expect(mockRequestWidgetToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId })
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

  it("an interrupt message while speaking switches the orb back to listening", async () => {
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
    window.sessionStorage.setItem("maneki_session_id", "sess-existing");
    window.sessionStorage.setItem(PENDING_NAVIGATION_KEY, "1");
    mockRequestWidgetToken.mockResolvedValue(TOKEN_RESPONSE);
    mockConnectToRoom.mockResolvedValue({ disconnect: vi.fn() });

    const el = mountWidget();

    // No click — mounting alone should have kicked off the connection.
    await vi.waitFor(() => expect(el.state).toBe("listening"));
    expect(mockRequestWidgetToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: "sess-existing" })
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
