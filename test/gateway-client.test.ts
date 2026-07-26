import { afterEach, describe, expect, it, vi } from "vitest";
import { requestWidgetToken, WidgetTokenError } from "../src/gateway-client";

const GATEWAY_URL = "https://gateway.example.com";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestWidgetToken", () => {
  it("posts the expected body and returns the parsed response", async () => {
    const response = {
      token: "jwt-abc",
      livekit_url: "wss://lk.example.com",
      room: "tenant-acme-xyz",
      grant: "grant-abc",
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => response,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestWidgetToken(GATEWAY_URL, {
      siteId: "acme",
      pageUrl: "https://acme.example.com/pricing",
      grant: "grant-from-last-page",
    });

    expect(result).toEqual(response);

    expect(fetchMock).toHaveBeenCalledWith(
      `${GATEWAY_URL}/widget/token`,
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      site_id: "acme",
      page_url: "https://acme.example.com/pricing",
      grant: "grant-from-last-page",
    });
  });

  it("sends no identity fields at all on a first visit", async () => {
    // There is no client-supplied visitor_id/session_id to leak or forge —
    // the gateway mints both. See api-gateway's app/widget/grant.py.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "t", livekit_url: "wss://lk", room: "r", grant: "g" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await requestWidgetToken(GATEWAY_URL, { siteId: "acme" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("visitor_id");
    expect(body).not.toHaveProperty("session_id");
    expect(body.grant).toBeUndefined();
  });

  it("throws WidgetTokenError with the response status on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ detail: "Origin not allowed" }) })
    );

    await expect(requestWidgetToken(GATEWAY_URL, { siteId: "acme" })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("throws WidgetTokenError with status 0 on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    );

    const err = await requestWidgetToken(GATEWAY_URL, { siteId: "acme" }).catch((e) => e);
    expect(err).toBeInstanceOf(WidgetTokenError);
    expect(err.status).toBe(0);
  });
});
