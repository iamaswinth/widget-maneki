import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractAnchorId,
  handleClick,
  handleNavigate,
  isSamePageTarget,
  isSameDestinationPage,
  pageKey,
  PENDING_NAVIGATION_KEY,
  resolveNavigationTarget,
} from "../src/navigation";

const CURRENT = new URL("https://acme.example.com/pricing");

describe("isSamePageTarget", () => {
  it("treats a bare #id as same-page", () => {
    expect(isSamePageTarget("#discount", CURRENT)).toBe(true);
  });

  it("treats a matching-origin, matching-path URL with a hash as same-page", () => {
    expect(isSamePageTarget("https://acme.example.com/pricing#discount", CURRENT)).toBe(true);
  });

  it("treats a different path as cross-page", () => {
    expect(isSamePageTarget("https://acme.example.com/faq#discount", CURRENT)).toBe(false);
  });

  it("treats a different origin as cross-page", () => {
    expect(isSamePageTarget("https://evil.example.com/pricing#discount", CURRENT)).toBe(false);
  });

  it("treats a same-origin/path URL with no hash as cross-page (nothing to scroll to)", () => {
    expect(isSamePageTarget("https://acme.example.com/pricing", CURRENT)).toBe(false);
  });

  it("treats an unparseable target as cross-page rather than throwing", () => {
    expect(isSamePageTarget("not a url and not a hash", CURRENT)).toBe(false);
  });
});

describe("extractAnchorId", () => {
  it("extracts a bare #id", () => {
    expect(extractAnchorId("#pricing")).toBe("pricing");
  });

  it("strips a trailing text-fragment", () => {
    expect(extractAnchorId("#pricing:~:text=refund%20policy")).toBe("pricing");
  });

  it("returns null for a pure text-fragment with no id", () => {
    expect(extractAnchorId("#:~:text=refund%20policy")).toBeNull();
  });

  it("returns null when there's no hash at all", () => {
    expect(extractAnchorId("https://acme.example.com/pricing")).toBeNull();
  });

  it("extracts the id from a full URL", () => {
    expect(extractAnchorId("https://acme.example.com/pricing#discount")).toBe("discount");
  });
});

describe("handleNavigate", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  function fakeWin(href: string): Window {
    return { location: { href } } as unknown as Window;
  }

  function fakeStorage(): Storage & { _data: Record<string, string> } {
    const data: Record<string, string> = {};
    return {
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
      _data: data,
    } as unknown as Storage & { _data: Record<string, string> };
  }

  it("scrolls to and highlights a same-page #id target", () => {
    const el = document.createElement("div");
    el.id = "pricing";
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);

    handleNavigate("#pricing", { win: fakeWin("https://acme.example.com/page"), doc: document });

    expect(el.scrollIntoView).toHaveBeenCalled();
    expect(document.body.querySelector("[data-maneki-highlight]")).not.toBeNull();
  });

  it("does nothing if the same-page target element doesn't exist", () => {
    expect(() =>
      handleNavigate("#does-not-exist", { win: fakeWin("https://acme.example.com/page"), doc: document })
    ).not.toThrow();
    expect(document.body.querySelector("[data-maneki-highlight]")).toBeNull();
  });

  it("marks the pending-navigation flag and assigns location.href for a cross-page target", () => {
    const win = fakeWin("https://acme.example.com/pricing");
    const storage = fakeStorage();

    handleNavigate("https://acme.example.com/faq#refunds", { win, doc: document, storage });

    expect(storage._data[PENDING_NAVIGATION_KEY]).toBe("1");
    expect(win.location.href).toBe("https://acme.example.com/faq#refunds");
  });

  it("does not touch the pending-navigation flag for a same-page target", () => {
    const el = document.createElement("div");
    el.id = "pricing";
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);
    const storage = fakeStorage();

    handleNavigate("#pricing", { win: fakeWin("https://acme.example.com/page"), doc: document, storage });

    expect(storage._data[PENDING_NAVIGATION_KEY]).toBeUndefined();
  });

  describe("crossPageDelayMs", () => {
    // Only the cross-page branch buffers — a navigate can fire mid-sentence
    // (voice_runtime's navigation_min_spoken_chars), and without this the
    // page would unload before the in-flight TTS clause finishes playing.
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("defers the pending-navigation flag and location.href assignment", () => {
      const win = fakeWin("https://acme.example.com/pricing");
      const storage = fakeStorage();

      handleNavigate("https://acme.example.com/faq#refunds", {
        win,
        doc: document,
        storage,
        crossPageDelayMs: 1500,
      });

      // Not yet — still buffered.
      expect(storage._data[PENDING_NAVIGATION_KEY]).toBeUndefined();
      expect(win.location.href).toBe("https://acme.example.com/pricing");

      vi.advanceTimersByTime(1500);

      expect(storage._data[PENDING_NAVIGATION_KEY]).toBe("1");
      expect(win.location.href).toBe("https://acme.example.com/faq#refunds");
    });

    it("returns a cancel callback that prevents the buffered navigation from ever firing", () => {
      const win = fakeWin("https://acme.example.com/pricing");
      const storage = fakeStorage();

      const cancel = handleNavigate("https://acme.example.com/faq#refunds", {
        win,
        doc: document,
        storage,
        crossPageDelayMs: 1500,
      });
      expect(cancel).toBeTypeOf("function");
      cancel?.();

      vi.advanceTimersByTime(5000);

      expect(storage._data[PENDING_NAVIGATION_KEY]).toBeUndefined();
      expect(win.location.href).toBe("https://acme.example.com/pricing");
    });

    it("omitting the option keeps today's synchronous, immediate behavior", () => {
      const win = fakeWin("https://acme.example.com/pricing");
      const storage = fakeStorage();

      const cancel = handleNavigate("https://acme.example.com/faq#refunds", { win, doc: document, storage });

      expect(cancel).toBeUndefined();
      expect(storage._data[PENDING_NAVIGATION_KEY]).toBe("1");
      expect(win.location.href).toBe("https://acme.example.com/faq#refunds");
    });

    it("a same-page target never buffers even when crossPageDelayMs is set", () => {
      const el = document.createElement("div");
      el.id = "pricing";
      el.scrollIntoView = vi.fn();
      document.body.appendChild(el);

      const cancel = handleNavigate("#pricing", {
        win: fakeWin("https://acme.example.com/page"),
        doc: document,
        crossPageDelayMs: 1500,
      });

      expect(cancel).toBeUndefined();
      expect(el.scrollIntoView).toHaveBeenCalled();
    });

    it("a refused (untrusted) target never buffers either", () => {
      const win = fakeWin("https://acme.example.com/pricing");
      const storage = fakeStorage();

      const cancel = handleNavigate("javascript:alert(1)", {
        win,
        doc: document,
        storage,
        crossPageDelayMs: 1500,
      });

      expect(cancel).toBeUndefined();
      vi.advanceTimersByTime(5000);
      expect(storage._data[PENDING_NAVIGATION_KEY]).toBeUndefined();
      expect(win.location.href).toBe("https://acme.example.com/pricing");
    });
  });

  describe("untrusted targets", () => {
    // handleNavigate ends in a location.href assignment on the tenant's own
    // site. The target traces back to crawled page content, so it is not a
    // trusted string just because it arrived over the data channel.
    const refused = [
      ["a javascript: URL (executes script on the host page)", "javascript:alert(document.cookie)"],
      ["a javascript: URL with mixed case and padding", "  JaVaScRiPt:alert(1)"],
      ["a data: URL", "data:text/html,<script>alert(1)</script>"],
      ["an off-origin page (open redirect / phishing)", "https://evil.example.com/login"],
      ["a protocol-relative off-origin URL", "//evil.example.com/login"],
      ["an https -> http downgrade on the same host", "http://acme.example.com/faq"],
    ] as const;

    for (const [label, target] of refused) {
      it(`refuses ${label}`, () => {
        const win = fakeWin("https://acme.example.com/pricing");
        const storage = fakeStorage();

        handleNavigate(target, { win, doc: document, storage });

        expect(win.location.href).toBe("https://acme.example.com/pricing");
        // A refused navigation must not arm auto-resume either, or the next
        // page load would reconnect on the strength of a navigation that
        // never happened.
        expect(storage._data[PENDING_NAVIGATION_KEY]).toBeUndefined();
      });
    }

    it("still allows an ordinary same-origin path", () => {
      const win = fakeWin("https://acme.example.com/pricing");
      const storage = fakeStorage();

      handleNavigate("/faq", { win, doc: document, storage });

      expect(win.location.href).toBe("https://acme.example.com/faq");
      expect(storage._data[PENDING_NAVIGATION_KEY]).toBe("1");
    });
  });
});

describe("resolveNavigationTarget", () => {
  const CURRENT_PAGE = new URL("https://acme.example.com/pricing");

  it("resolves a relative path against the current page", () => {
    expect(resolveNavigationTarget("/faq", CURRENT_PAGE)?.href).toBe("https://acme.example.com/faq");
  });

  it("returns the parsed URL, not the caller's string", () => {
    // What gets assigned must be what passed the check — no room for our
    // parse and the browser's to disagree.
    expect(resolveNavigationTarget("/a/../b", CURRENT_PAGE)?.href).toBe("https://acme.example.com/b");
  });

  it("rejects an unparseable target", () => {
    expect(resolveNavigationTarget("http://[", CURRENT_PAGE)).toBeNull();
  });

  it("rejects a non-http(s) scheme", () => {
    expect(resolveNavigationTarget("javascript:alert(1)", CURRENT_PAGE)).toBeNull();
    expect(resolveNavigationTarget("blob:https://acme.example.com/x", CURRENT_PAGE)).toBeNull();
  });

  it("rejects a different origin", () => {
    expect(resolveNavigationTarget("https://evil.example.com/", CURRENT_PAGE)).toBeNull();
  });
});

describe("pageKey", () => {
  // Mirrors Firecrawl-scraper-ingestion/app/links.py::page_key's table and
  // voice_runtime/urls.py::page_key's — the three MUST stay in lockstep.
  const cases: Array<[string, string | undefined, string]> = [
    ["https://Example.com/Pricing/", undefined, "https://example.com/Pricing"],
    ["https://example.com:443/pricing?ref=x#plans", undefined, "https://example.com/pricing"],
    ["http://example.com:80/pricing", undefined, "http://example.com/pricing"],
    ["http://example.com:8080/pricing", undefined, "http://example.com:8080/pricing"],
    ["/pricing", "https://example.com/a/b", "https://example.com/pricing"],
    ["../pricing", "https://example.com/a/b/c", "https://example.com/a/pricing"],
    ["https://example.com", undefined, "https://example.com/"],
    ["#pricing", "https://example.com/x", "https://example.com/x"],
  ];

  for (const [url, base, expected] of cases) {
    it(`normalizes ${url}${base ? ` (base ${base})` : ""} to ${expected}`, () => {
      expect(pageKey(url, base)).toBe(expected);
    });
  }

  for (const url of ["mailto:a@b.c", "javascript:alert(1)", "tel:+15551234567", ""]) {
    it(`rejects ${url || "(empty string)"}`, () => {
      expect(pageKey(url)).toBeNull();
    });
  }

  it("rejects an unparseable URL", () => {
    expect(pageKey("http://[invalid")).toBeNull();
  });
});

describe("isSameDestinationPage", () => {
  it("is true regardless of query string and fragment", () => {
    expect(
      isSameDestinationPage("https://x.com/pricing?utm=ad", "https://x.com/pricing#enterprise")
    ).toBe(true);
  });

  it("is false for a different path", () => {
    expect(isSameDestinationPage("https://x.com/pricing", "https://x.com/about")).toBe(false);
  });

  it("is false when either side is unparseable", () => {
    expect(isSameDestinationPage("javascript:alert(1)", "https://x.com/pricing")).toBe(false);
  });
});

describe("handleClick", () => {
  // Fake timers throughout — commit() always schedules a pagehide-window
  // timer (real or fake, doesn't matter to jsdom's synchronous
  // dispatchEvent), and using fake timers uniformly means a test that
  // doesn't care about that timer just never advances it; useRealTimers()
  // in afterEach discards it cleanly instead of leaking a real background
  // timer past the test's lifetime.
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeWin(href: string): Window {
    return { location: { href } } as unknown as Window;
  }

  /** A fake window with real listener bookkeeping (via a Map, not jsdom's
   * incomplete anchor-navigation support) so a test can simulate "a real
   * navigation actually started unloading the page" by firing "pagehide"
   * itself, independent of whether jsdom would ever really navigate. */
  function fakeWinWithEvents(href: string): Window & { _fire: (type: string) => void } {
    const listeners = new Map<string, Set<() => void>>();
    return {
      location: { href },
      addEventListener: (type: string, cb: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(cb);
      },
      removeEventListener: (type: string, cb: () => void) => {
        listeners.get(type)?.delete(cb);
      },
      _fire: (type: string) => {
        for (const cb of listeners.get(type) ?? []) cb();
      },
    } as unknown as Window & { _fire: (type: string) => void };
  }

  function fakeStorage(): Storage & { _data: Record<string, string> } {
    const data: Record<string, string> = {};
    return {
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
      _data: data,
    } as unknown as Storage & { _data: Record<string, string> };
  }

  function appendAnchor(href: string, text: string, targetAttr?: string): HTMLAnchorElement {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    if (targetAttr) a.target = targetAttr;
    document.body.appendChild(a);
    return a;
  }

  it("delegates a same-page target straight to the scroll+highlight path", () => {
    const el = document.createElement("div");
    el.id = "pricing";
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);

    handleClick("#pricing", { win: fakeWin("https://acme.example.com/page"), doc: document });

    expect(el.scrollIntoView).toHaveBeenCalled();
  });

  it("refuses an untrusted cross-page target without ever touching the DOM", () => {
    appendAnchor("https://evil.example.com/login", "Login");
    const win = fakeWin("https://acme.example.com/pricing");
    const storage = fakeStorage();

    handleClick("https://evil.example.com/login", { win, doc: document, storage });

    expect(win.location.href).toBe("https://acme.example.com/pricing");
    expect(storage._data[PENDING_NAVIGATION_KEY]).toBeUndefined();
  });

  it("falls back to handleNavigate when no matching anchor exists on the live page", () => {
    // The crawl is a snapshot -- nothing on the page happens to link there.
    const win = fakeWin("https://acme.example.com/pricing");
    const storage = fakeStorage();

    handleClick("https://acme.example.com/faq", { win, doc: document, storage });

    expect(win.location.href).toBe("https://acme.example.com/faq");
    expect(storage._data[PENDING_NAVIGATION_KEY]).toBe("1");
  });

  it("never selects a target=\"_blank\" anchor, falling back instead", () => {
    appendAnchor("https://acme.example.com/faq", "FAQ", "_blank");
    const win = fakeWin("https://acme.example.com/pricing");
    const storage = fakeStorage();

    handleClick("https://acme.example.com/faq", { win, doc: document, storage });

    // Fell all the way back to a hard navigate, since the only match was disqualified.
    expect(win.location.href).toBe("https://acme.example.com/faq");
    expect(storage._data[PENDING_NAVIGATION_KEY]).toBe("1");
  });

  it("prefers the anchor whose text exactly matches linkText among duplicates", () => {
    appendAnchor("https://acme.example.com/faq", "Learn more");
    const preferred = appendAnchor("https://acme.example.com/faq", "Frequently Asked Questions");
    const win = fakeWinWithEvents("https://acme.example.com/pricing");
    const clicked: EventTarget[] = [];
    preferred.addEventListener("click", (e) => {
      clicked.push(e.target as EventTarget);
      e.preventDefault();
    });

    handleClick("https://acme.example.com/faq", {
      win,
      doc: document,
      linkText: "Frequently Asked Questions",
    });

    expect(clicked).toEqual([preferred]);
  });

  it("matches an anchor regardless of query string and trailing slash differences", () => {
    const anchor = appendAnchor("https://acme.example.com/faq/", "FAQ");
    const win = fakeWinWithEvents("https://acme.example.com/pricing");
    let dispatched = false;
    anchor.addEventListener("click", (e) => {
      dispatched = true;
      e.preventDefault();
    });

    handleClick("https://acme.example.com/faq?ref=agent", { win, doc: document });

    expect(dispatched).toBe(true);
  });

  describe("soft-nav detection", () => {
    it("SPA intercepts the click (preventDefault) -> no pending-navigation flag, no fallback", () => {
      const anchor = appendAnchor("https://acme.example.com/faq", "FAQ");
      anchor.addEventListener("click", (e) => e.preventDefault());
      const win = fakeWinWithEvents("https://acme.example.com/pricing");
      const storage = fakeStorage();

      handleClick("https://acme.example.com/faq", { win, doc: document, storage });

      expect(storage._data[PENDING_NAVIGATION_KEY]).toBeUndefined();
      // Not overwritten by a fallback navigate either.
      expect(win.location.href).toBe("https://acme.example.com/pricing");
    });

    it("not prevented + pagehide fires within the window -> sets the pending-navigation flag", () => {
      const anchor = appendAnchor("https://acme.example.com/faq", "FAQ");
      const win = fakeWinWithEvents("https://acme.example.com/pricing");
      const storage = fakeStorage();

      handleClick("https://acme.example.com/faq", { win, doc: document, storage });
      win._fire("pagehide");

      expect(storage._data[PENDING_NAVIGATION_KEY]).toBe("1");
      void anchor; // present on the page; only pagehide timing is under test here
    });

    it("not prevented + pagehide never fires -> flag stays unset, no fallback", () => {
      appendAnchor("https://acme.example.com/faq", "FAQ");
      const win = fakeWinWithEvents("https://acme.example.com/pricing");
      const storage = fakeStorage();

      handleClick("https://acme.example.com/faq", { win, doc: document, storage });
      vi.advanceTimersByTime(10_000); // well past PAGEHIDE_WINDOW_MS

      expect(storage._data[PENDING_NAVIGATION_KEY]).toBeUndefined();
      expect(win.location.href).toBe("https://acme.example.com/pricing");
    });

    it("preventDefault with no actual route change falls back to a real navigation", () => {
      const anchor = appendAnchor("https://acme.example.com/faq", "FAQ");
      // Prevents default but does nothing else -- a broken handler, or one
      // that bailed (e.g. a modal) rather than routing anywhere.
      anchor.addEventListener("click", (e) => e.preventDefault());
      const win = fakeWinWithEvents("https://acme.example.com/pricing");
      const storage = fakeStorage();

      handleClick("https://acme.example.com/faq", { win, doc: document, storage });
      vi.advanceTimersByTime(1000); // past SOFT_NAV_VERIFY_MS

      expect(win.location.href).toBe("https://acme.example.com/faq");
      expect(storage._data[PENDING_NAVIGATION_KEY]).toBe("1");
    });
  });

  describe("crossPageDelayMs", () => {
    it("buffers the click the same way handleNavigate buffers a redirect", () => {
      const anchor = appendAnchor("https://acme.example.com/faq", "FAQ");
      let clicked = false;
      anchor.addEventListener("click", () => {
        clicked = true;
      });
      const win = fakeWinWithEvents("https://acme.example.com/pricing");

      handleClick("https://acme.example.com/faq", { win, doc: document, crossPageDelayMs: 1500 });

      expect(clicked).toBe(false);
      vi.advanceTimersByTime(1500);
      expect(clicked).toBe(true);
    });

    it("a cancel handle prevents the buffered click from ever firing", () => {
      const anchor = appendAnchor("https://acme.example.com/faq", "FAQ");
      let clicked = false;
      anchor.addEventListener("click", () => {
        clicked = true;
      });
      const win = fakeWinWithEvents("https://acme.example.com/pricing");

      const cancel = handleClick("https://acme.example.com/faq", {
        win,
        doc: document,
        crossPageDelayMs: 1500,
      });
      cancel?.();
      vi.advanceTimersByTime(5000);

      expect(clicked).toBe(false);
    });
  });
});
