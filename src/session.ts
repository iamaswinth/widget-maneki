const STORAGE_KEY = "maneki_session_id";

/** A LiveKit room ends on page unload, so conversation continuity has to be
 * tracked separately — sessionStorage survives same-tab cross-page
 * navigation (including agent-triggered ones) but not a new tab/window,
 * which is the right boundary for "same visit". */
export function getOrCreateSessionId(storage: Storage = window.sessionStorage): string {
  let id = storage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    storage.setItem(STORAGE_KEY, id);
  }
  return id;
}
