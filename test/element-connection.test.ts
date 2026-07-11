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
import type { DataMessageHandler } from "../src/livekit-connection";

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

beforeEach(() => {
  document.body.innerHTML = "";
  mockRequestWidgetToken.mockReset();
  mockConnectToRoom.mockReset();
  mockHandleNavigate.mockReset();
  window.sessionStorage.clear();
});

describe("tap-to-talk orchestration", () => {
  it("goes idle -> connecting -> listening on a successful connection", async () => {
    mockRequestWidgetToken.mockResolvedValue({
      token: "jwt",
      livekit_url: "wss://lk.example.com",
      room: "room-1",
    });
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
      expect.any(Function),
      expect.any(Function)
    );
  });

  it("transitions to speaking when the remote audio callback fires", async () => {
    mockRequestWidgetToken.mockResolvedValue({
      token: "jwt",
      livekit_url: "wss://lk.example.com",
      room: "room-1",
    });
    let capturedOnRemoteAudio: ((el: HTMLMediaElement) => void) | undefined;
    mockConnectToRoom.mockImplementation(async (_url: string, _token: string, onRemoteAudio: (el: HTMLMediaElement) => void) => {
      capturedOnRemoteAudio = onRemoteAudio;
      return { disconnect: vi.fn() };
    });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));

    capturedOnRemoteAudio!(document.createElement("audio"));

    expect(el.state).toBe("speaking");
  });

  it("goes to the error state when the token request fails", async () => {
    mockRequestWidgetToken.mockRejectedValue(new FakeWidgetTokenError(403, "Origin not allowed"));

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

    resolveToken({ token: "jwt", livekit_url: "wss://lk.example.com", room: "room-1" });
    await vi.waitFor(() => expect(el.state).toBe("listening"));
  });

  it("sends the sessionStorage session_id in the token request", async () => {
    mockRequestWidgetToken.mockResolvedValue({
      token: "jwt",
      livekit_url: "wss://lk.example.com",
      room: "room-1",
    });
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
      .mockResolvedValueOnce({ token: "jwt", livekit_url: "wss://lk.example.com", room: "room-1" });
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
  async function connectAndCaptureDataHandler(): Promise<{
    el: ManekiWidgetElement;
    onDataMessage: DataMessageHandler;
  }> {
    mockRequestWidgetToken.mockResolvedValue({
      token: "jwt",
      livekit_url: "wss://lk.example.com",
      room: "room-1",
    });
    let onDataMessage!: DataMessageHandler;
    mockConnectToRoom.mockImplementation(async (_url: string, _token: string, _onRemoteAudio, handler: DataMessageHandler) => {
      onDataMessage = handler;
      return { disconnect: vi.fn() };
    });

    const el = mountWidget();
    click(el);
    await vi.waitFor(() => expect(el.state).toBe("listening"));
    return { el, onDataMessage };
  }

  it("routes a navigate message to handleNavigate with the target", async () => {
    const { onDataMessage } = await connectAndCaptureDataHandler();

    onDataMessage({ type: "navigate", target: "#pricing" });

    expect(mockHandleNavigate).toHaveBeenCalledWith("#pricing");
  });

  it("ignores a navigate message with a non-string target rather than throwing", async () => {
    const { onDataMessage } = await connectAndCaptureDataHandler();

    expect(() => onDataMessage({ type: "navigate", target: 42 })).not.toThrow();
    expect(mockHandleNavigate).not.toHaveBeenCalled();
  });

  it("does not throw on an unknown message type", async () => {
    const { onDataMessage } = await connectAndCaptureDataHandler();

    expect(() => onDataMessage({ type: "something-unexpected" })).not.toThrow();
    expect(mockHandleNavigate).not.toHaveBeenCalled();
  });
});

describe("cross-page session resume", () => {
  it("auto-reconnects on mount when the pending-navigation flag is set", async () => {
    window.sessionStorage.setItem("maneki_session_id", "sess-existing");
    window.sessionStorage.setItem(PENDING_NAVIGATION_KEY, "1");
    mockRequestWidgetToken.mockResolvedValue({
      token: "jwt",
      livekit_url: "wss://lk.example.com",
      room: "room-1",
    });
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
    mockRequestWidgetToken.mockResolvedValue({
      token: "jwt",
      livekit_url: "wss://lk.example.com",
      room: "room-1",
    });
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
