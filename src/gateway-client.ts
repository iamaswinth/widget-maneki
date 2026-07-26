export interface WidgetTokenResponse {
  token: string;
  livekit_url: string;
  room: string;
  /** Opaque, gateway-signed. Persist it (session.ts) and send it back as
   * `grant` next time or the visitor gets a new identity — and so a new
   * conversation — on every page. */
  grant: string;
}

export interface WidgetTokenParams {
  siteId: string;
  pageUrl?: string;
  /** From a previous response; omitted on a first visit. The visitor's
   * visitor_id/session_id live inside it, signed — there is deliberately no
   * way to pass either one directly. */
  grant?: string;
}

/** Thrown for both HTTP error responses (status set from the response) and
 * network-level failures (status 0) — callers branch on `status` to pick
 * the right fail state (403 unpublished/origin, 429 rate-limited, 0 = the
 * request never reached the gateway at all). */
export class WidgetTokenError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "WidgetTokenError";
  }
}

export async function requestWidgetToken(
  gatewayUrl: string,
  params: WidgetTokenParams
): Promise<WidgetTokenResponse> {
  let response: Response;
  try {
    response = await fetch(`${gatewayUrl}/widget/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        site_id: params.siteId,
        page_url: params.pageUrl,
        grant: params.grant,
      }),
    });
  } catch (err) {
    throw new WidgetTokenError(0, `Network error requesting widget token: ${String(err)}`);
  }

  if (!response.ok) {
    throw new WidgetTokenError(response.status, `Widget token request failed (${response.status})`);
  }

  return (await response.json()) as WidgetTokenResponse;
}
