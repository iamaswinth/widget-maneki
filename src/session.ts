const STORAGE_KEY = "maneki_session_id";

/** crypto.randomUUID() only exists in secure contexts (HTTPS, or the literal
 * hostnames "localhost"/"127.0.0.1") — a custom hostname resolving to a
 * local machine (e.g. host.docker.internal during local testing, or any
 * plain-HTTP embed) doesn't count, even though it's just as local.
 * crypto.getRandomValues() has no such restriction, so it's the fallback. */
function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A LiveKit room ends on page unload, so conversation continuity has to be
 * tracked separately — sessionStorage survives same-tab cross-page
 * navigation (including agent-triggered ones) but not a new tab/window,
 * which is the right boundary for "same visit". */
export function getOrCreateSessionId(storage: Storage = window.sessionStorage): string {
  let id = storage.getItem(STORAGE_KEY);
  if (!id) {
    id = generateUUID();
    storage.setItem(STORAGE_KEY, id);
  }
  return id;
}
