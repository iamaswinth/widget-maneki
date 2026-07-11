import { afterEach, describe, expect, it, vi } from "vitest";
import { requestWidgetToken, WidgetTokenError } from "../src/gateway-client";

const GATEWAY_URL = "https://gateway.example.com";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestWidgetToken", () => {
  it("posts the expected body and returns the parsed response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "jwt-abc", livekit_url: "wss://lk.example.com", room: "tenant-acme-xyz" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestWidgetToken(GATEWAY_URL, {
      siteId: "acme",
      sessionId: "sess-1",
      pageUrl: "https://acme.example.com/pricing",
    });

    expect(result).toEqual({ token: "jwt-abc", livekit_url: "wss://lk.example.com", room: "tenant-acme-xyz" });

    expect(fetchMock).toHaveBeenCalledWith(
      `${GATEWAY_URL}/widget/token`,
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      site_id: "acme",
      session_id: "sess-1",
      page_url: "https://acme.example.com/pricing",
      visitor_id: undefined,
    });
  });

  it("throws WidgetTokenError with the response status on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ detail: "Origin not allowed" }) })
    );

    await expect(requestWidgetToken(GATEWAY_URL, { siteId: "acme", sessionId: "sess-1" })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("throws WidgetTokenError with status 0 on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    );

    const err = await requestWidgetToken(GATEWAY_URL, { siteId: "acme", sessionId: "sess-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(WidgetTokenError);
    expect(err.status).toBe(0);
  });
});
