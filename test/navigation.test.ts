import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractAnchorId, handleNavigate, isSamePageTarget, PENDING_NAVIGATION_KEY } from "../src/navigation";

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
});
