import { beforeEach, describe, expect, it } from "vitest";
import { readGrant, storeGrant } from "../src/session";

describe("visitor grant storage", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("returns null before the gateway has issued anything", () => {
    // A first visit sends no grant at all — the widget can't invent one,
    // which is the whole point: identity is minted server-side.
    expect(readGrant()).toBeNull();
  });

  it("round-trips a stored grant", () => {
    storeGrant("grant-abc");
    expect(readGrant()).toBe("grant-abc");
  });

  it("overwrites with the newest grant", () => {
    // The gateway re-signs on every token request (sliding expiry), so the
    // latest one has to win or the visitor's identity lapses mid-visit.
    storeGrant("grant-old");
    storeGrant("grant-new");
    expect(readGrant()).toBe("grant-new");
  });

  it("accepts an injected storage (for cross-page-navigation simulation in tests)", () => {
    class FakeStorage {
      private data: Record<string, string> = {};
      getItem(key: string): string | null {
        return this.data[key] ?? null;
      }
      setItem(key: string, value: string): void {
        this.data[key] = value;
      }
    }
    const fakeStorage = new FakeStorage() as unknown as Storage;

    storeGrant("grant-xyz", fakeStorage);
    expect(readGrant(fakeStorage)).toBe("grant-xyz");
  });
});
