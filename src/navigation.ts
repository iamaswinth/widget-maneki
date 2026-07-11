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
}

/** Dispatches an agent-sent navigation target: scroll+highlight for a
 * same-page anchor, or a real cross-page load (marking a pending-resume
 * flag first — see Session 4 — since the WebRTC connection can't survive
 * page unload). Cross-page text-fragment handling is deliberately left to
 * the browser's own native behavior on the next page's load. */
export function handleNavigate(target: string, options: HandleNavigateOptions = {}): void {
  const win = options.win ?? window;
  const doc = options.doc ?? document;
  const storage = options.storage ?? window.sessionStorage;

  const currentUrl = new URL(win.location.href);

  if (isSamePageTarget(target, currentUrl)) {
    const id = extractAnchorId(target);
    if (!id) return;
    const el = doc.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    highlightElement(el, doc);
    return;
  }

  storage.setItem(PENDING_NAVIGATION_KEY, "1");
  win.location.href = target;
}
