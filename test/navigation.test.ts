import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractAnchorId,
  handleNavigate,
  isSamePageTarget,
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
