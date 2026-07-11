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

import "../src/index";
import type { ManekiWidgetElement } from "../src/element";

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
    expect(mockConnectToRoom).toHaveBeenCalledWith("wss://lk.example.com", "jwt", expect.any(Function));
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
