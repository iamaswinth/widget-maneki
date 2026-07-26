import { highlightElement } from "./highlight";

export const PENDING_NAVIGATION_KEY = "maneki_pending_navigation";

/** The "same destination page" URL-key spec — this has two other
 * implementations that MUST stay byte-identical:
 * Firecrawl-scraper-ingestion/app/links.py::page_key and
 * voice_runtime/urls.py::page_key. `URL.origin` already normalizes host
 * casing and drops a default port, and `new URL()` already collapses `.`/
 * `..` path segments — the browser does for free what the Python side has
 * to do by hand. Query string and fragment are dropped entirely; path case
 * is preserved (case-sensitivity is server-dependent). Returns null for
 * anything that isn't a resolvable http(s) URL. */
export function pageKey(url: string | URL, base?: string | URL): string | null {
  let u: URL;
  try {
    u = new URL(url, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const path = u.pathname === "/" ? "/" : u.pathname.replace(/\/$/, "");
  return `${u.origin}${path}`;
}

export function isSameDestinationPage(
  a: string | URL,
  b: string | URL,
  base?: string | URL
): boolean {
  const keyA = pageKey(a, base);
  const keyB = pageKey(b, base);
  return keyA !== null && keyA === keyB;
}

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

// How long a click-caused hard navigation gets to actually unload the page
// before we give up waiting for it — see handleClick's "not prevented"
// branch. pagehide for a cross-document navigation fires around TTFB, so
// this only needs to comfortably clear realistic TTFB on a slow mobile
// connection; too short loses the auto-resume flag on an ordinary slow
// page, too long risks attributing some *later*, unrelated unload to this
// click.
const PAGEHIDE_WINDOW_MS = 2500;

// How long we give a click handler that called preventDefault() to actually
// finish a client-side route change before concluding it wasn't a router at
// all (a modal, a broken handler, tracking-then-bail) and falling back to a
// real navigation. Generous for a synchronous history.pushState (every
// mainstream router does it in the same task as preventDefault) and short
// enough not to read as a stall.
const SOFT_NAV_VERIFY_MS = 400;

export interface HandleClickOptions extends HandleNavigateOptions {
  /** The anchor text the ingestion service captured for this link — a
   * disambiguation hint only, never a selector. Which live-DOM element gets
   * clicked is always decided by href matching (pageKey), never by text
   * alone. */
  linkText?: string;
}

function findAnchor(destination: URL, doc: Document, linkText?: string): HTMLAnchorElement | null {
  const destinationKey = pageKey(destination.href);
  const candidates: HTMLAnchorElement[] = [];
  for (const el of Array.from(doc.querySelectorAll("a[href]"))) {
    const a = el as HTMLAnchorElement;
    // A target="_blank" (or any non-"_self") anchor opens a new tab, leaving
    // the visitor's LiveKit-connected tab stranded on the old page while the
    // content appears somewhere else — strictly worse than a hard navigate
    // in the same tab, so it's never a candidate.
    if (a.target && a.target !== "_self") continue;
    if (pageKey(a.href) === destinationKey) candidates.push(a);
  }
  if (candidates.length === 0) return null;
  if (linkText) {
    const normalized = linkText.trim().toLowerCase();
    const exact = candidates.find((a) => (a.textContent ?? "").trim().toLowerCase() === normalized);
    if (exact) return exact;
    const partial = candidates.find((a) => (a.textContent ?? "").toLowerCase().includes(normalized));
    if (partial) return partial;
  }
  return candidates[0];
}

/** Attempts click-based navigation for a cross-page target: finds a real
 * `<a>` on the live page that leads there and dispatches a click on it,
 * instead of assigning `location.href` — on an SPA-routed target site, the
 * site's own client-side router intercepts the click and the LiveKit
 * connection survives. Falls back to `handleNavigate` (today's behavior,
 * byte-identical) in every case where that isn't demonstrably true:
 *
 *  - same-page target: not this function's job at all (see handleNavigate)
 *  - target fails the same same-origin/http(s) gate handleNavigate uses
 *  - no matching `<a>` on the live page (the crawl is a snapshot; the DOM
 *    may have changed since)
 *  - the click's default action fires without a preventDefault() that
 *    routes anywhere (the SOFT_NAV_VERIFY_MS fallback)
 *
 * Same cancel-handle contract as handleNavigate: clears whichever of the
 * pre-click delay timer / pagehide listener / verify timer is outstanding. */
export function handleClick(
  target: string,
  options: HandleClickOptions = {}
): (() => void) | undefined {
  const win = options.win ?? window;
  const doc = options.doc ?? document;
  const storage = options.storage ?? window.sessionStorage;
  const crossPageDelayMs = options.crossPageDelayMs ?? 0;

  const currentUrl = new URL(win.location.href);

  if (isSamePageTarget(target, currentUrl)) {
    return handleNavigate(target, options);
  }

  const destination = resolveNavigationTarget(target, currentUrl);
  if (!destination) {
    console.error("<maneki-widget> refusing to click toward an untrusted target:", target);
    return undefined;
  }

  const anchor = findAnchor(destination, doc, options.linkText);
  if (!anchor) {
    return handleNavigate(target, options);
  }

  let cleanupPending: (() => void) | undefined;

  const commit = (): void => {
    highlightElement(anchor, doc);

    let pagehideTimer: ReturnType<typeof setTimeout> | undefined;
    const canListen = typeof win.addEventListener === "function";

    const cleanup = (): void => {
      if (canListen) win.removeEventListener("pagehide", onPagehide);
      if (pagehideTimer !== undefined) clearTimeout(pagehideTimer);
      cleanupPending = undefined;
    };
    const onPagehide = (): void => {
      // A real navigation is actually unloading the page now — reproduce
      // today's resume behavior exactly (see handleNavigate's commit()).
      storage.setItem(PENDING_NAVIGATION_KEY, "1");
      cleanup();
    };

    if (canListen) {
      win.addEventListener("pagehide", onPagehide);
      pagehideTimer = setTimeout(cleanup, PAGEHIDE_WINDOW_MS);
    }
    cleanupPending = cleanup;

    // Not `.click()` — dispatching our own MouseEvent lets us read the
    // return value, which is exactly `!defaultPrevented`. Every mainstream
    // client-side router (React Router, Next.js, Vue Router, SvelteKit)
    // intercepts link clicks by calling preventDefault() inside its click
    // handler, so this is a synchronous, unambiguous "did the SPA take
    // over?" signal — no timer-based guessing needed for this half.
    // No `view` — it must be a real Window (jsdom enforces this strictly,
    // and this module's own test fakes, like handleNavigate's, are plain
    // { location } stand-ins), and no router this targets keys off it
    // anyway; they check `button`/modifier keys/`target`/defaultPrevented.
    const notPrevented = anchor.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
      })
    );

    if (!notPrevented) {
      // SPA intercepted the click. No reload is coming, so there is nothing
      // for the pagehide listener to catch — but a handler can call
      // preventDefault() without actually routing anywhere (a modal, a
      // broken handler), so verify before declaring victory.
      cleanup();
      setTimeout(() => {
        if (pageKey(win.location.href) !== pageKey(destination.href)) {
          handleNavigate(target, { ...options, crossPageDelayMs: 0 });
        }
      }, SOFT_NAV_VERIFY_MS);
    }
    // else: a real navigation is underway (a synthetic click's default
    // action on an <a> runs its activation behavior, same as .click()) —
    // the armed pagehide listener sets PENDING_NAVIGATION_KEY when it
    // actually unloads.
  };

  if (crossPageDelayMs <= 0) {
    commit();
    return undefined;
  }

  const timerId = setTimeout(commit, crossPageDelayMs);
  return () => {
    clearTimeout(timerId);
    cleanupPending?.();
  };
}
