const STORAGE_KEY = "maneki_visitor_grant";

/** The visitor's identity is an opaque, gateway-signed grant — the widget
 * never generates or reads the ids inside it. It used to mint its own
 * session_id here and send it as a plain string, which meant any caller
 * could name someone else's session and have the agent resume that
 * conversation; see api-gateway's app/widget/grant.py.
 *
 * Kept in sessionStorage, which survives a same-tab cross-page navigation
 * (including the agent-triggered ones in navigation.ts) but not a new
 * tab/window — the same "one visit" boundary the session_id had. When
 * cross-visit visitor memory is wired up this moves to localStorage with a
 * longer server-side TTL; the grant itself doesn't change shape. */
export function readGrant(storage: Storage = window.sessionStorage): string | null {
  return storage.getItem(STORAGE_KEY);
}

/** Called with the grant from every successful token response — it's
 * re-signed server-side each time (sliding expiry), so persisting the newest
 * one is what keeps a visitor's identity from lapsing mid-visit. */
export function storeGrant(grant: string, storage: Storage = window.sessionStorage): void {
  storage.setItem(STORAGE_KEY, grant);
}
