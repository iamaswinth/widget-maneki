import { highlightElement } from "./highlight";

export const PENDING_NAVIGATION_KEY = "maneki_pending_navigation";

/** True for a bare "#id" (or "#id:~:text=...") target, or a full URL whose
 * origin+path match the current page and which carries a hash — i.e.
 * anything that should scroll within this page rather than navigate away. */
export function isSamePageTarget(target: string, currentUrl: URL): boolean {
  if (target.startsWith("#")) return true;
  let targetUrl: URL;
  try {
    targetUrl = new URL(target, currentUrl);
  } catch {
    return false;
  }
  return (
    targetUrl.origin === currentUrl.origin &&
    targetUrl.pathname === currentUrl.pathname &&
    targetUrl.hash !== ""
  );
}

/** Strips a leading "#" and any native text-fragment suffix (":~:text=...")
 * to recover the plain element id to scroll to. A target that's a pure text
 * fragment with no id (e.g. "#:~:text=refund%20policy") returns null — nothing
 * for us to resolve ourselves; that shape only does anything useful as a
 * cross-page URL the browser loads natively (see handleNavigate). */
export function extractAnchorId(target: string): string | null {
  const hashIndex = target.indexOf("#");
  if (hashIndex === -1) return null;
  let fragment = target.slice(hashIndex + 1);
  const textFragmentIndex = fragment.indexOf(":~:text=");
  if (textFragmentIndex === 0) return null;
  if (textFragmentIndex > 0) fragment = fragment.slice(0, textFragmentIndex);
  return fragment || null;
}

export interface HandleNavigateOptions {
  win?: Window;
  doc?: Document;
  storage?: Storage;
  /** How long to wait, in ms, before actually assigning location.href for a
   * cross-page target — default 0 (today's synchronous, immediate
   * behavior; every existing call site/test that omits this keeps working
   * unchanged). The navigate event can fire mid-sentence (see
   * voice_runtime's navigation_min_spoken_chars) so the page would
   * otherwise unload before the in-flight TTS clause finishes playing,
   * audibly cutting the agent off. A positive value buffers just the page
   * move — not the underlying decision — to give that clause a moment to
   * finish. Only applies to the cross-page branch; a same-page anchor
   * scroll doesn't tear down the connection, so it always stays instant. */
  crossPageDelayMs?: number;
}

/** Resolves a cross-page target to the URL we're willing to send a visitor
 * to, or null to refuse.
 *
 * This runs inside someone else's web page, on a site Maneki doesn't control,
 * and it ends in an assignment to `location.href` — which executes script for
 * a `javascript:` URL. So the target can't be treated as a trusted string just
 * because it arrived over the data channel: it originates from a retrieval
 * hit's `navigation` field, which traces back to crawled page content.
 *
 * Two rules, both required:
 *  - scheme must be http(s) — blocks `javascript:`, `data:`, `blob:`, `vbscript:`
 *  - origin must match the current page — the agent's job is guiding a visitor
 *    around the tenant's own site, so there is no legitimate off-site target,
 *    and this also blocks an open-redirect into a phishing page. Note origin
 *    includes the scheme, so an https→http downgrade is refused too.
 *
 * Returns the parsed URL rather than the caller's string so the value actually
 * assigned is the one that passed these checks — no room for our parse and the
 * browser's to disagree. */
export function resolveNavigationTarget(target: string, currentUrl: URL): URL | null {
  let url: URL;
  try {
    url = new URL(target, currentUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.origin !== currentUrl.origin) return null;
  return url;
}

/** Dispatches an agent-sent navigation target: scroll+highlight for a
 * same-page anchor, or a real cross-page load (marking a pending-resume
 * flag first — see Session 4 — since the WebRTC connection can't survive
 * page unload). Cross-page text-fragment handling is deliberately left to
 * the browser's own native behavior on the next page's load.
 *
 * Returns a cancel callback when a cross-page navigation was scheduled with
 * `crossPageDelayMs` (so a caller can abort it — e.g. element.ts cancels on
 * an "interrupt" event that lands before the delay elapses), or `undefined`
 * for the same-page/refused/immediate cases, where there's nothing pending
 * to cancel. */
export function handleNavigate(
  target: string,
  options: HandleNavigateOptions = {}
): (() => void) | undefined {
  const win = options.win ?? window;
  const doc = options.doc ?? document;
  const storage = options.storage ?? window.sessionStorage;
  const crossPageDelayMs = options.crossPageDelayMs ?? 0;

  const currentUrl = new URL(win.location.href);

  if (isSamePageTarget(target, currentUrl)) {
    const id = extractAnchorId(target);
    if (!id) return undefined;
    const el = doc.getElementById(id);
    if (!el) return undefined;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    highlightElement(el, doc);
    return undefined;
  }

  const destination = resolveNavigationTarget(target, currentUrl);
  if (!destination) {
    console.error("<maneki-widget> refusing to navigate to an untrusted target:", target);
    return undefined;
  }

  const commit = (): void => {
    // Only set after the target is known-good — a refused navigation must
    // not leave the flag behind, or the next page load would auto-reconnect
    // on the strength of a navigation that never happened.
    storage.setItem(PENDING_NAVIGATION_KEY, "1");
    win.location.href = destination.href;
  };

  if (crossPageDelayMs <= 0) {
    commit();
    return undefined;
  }

  // Global timer functions, not win.setTimeout — the fake `win` objects this
  // module's own tests (and callers not opting into a delay) pass around are
  // bare { location } stand-ins with no timer methods of their own.
  const timerId = setTimeout(commit, crossPageDelayMs);
  return () => clearTimeout(timerId);
}
