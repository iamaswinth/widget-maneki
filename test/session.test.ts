import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getOrCreateSessionId } from "../src/session";

describe("getOrCreateSessionId", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("creates and persists a new id when none exists", () => {
    const id = getOrCreateSessionId();
    expect(id).toBeTruthy();
    expect(window.sessionStorage.getItem("maneki_session_id")).toBe(id);
  });

  it("returns the same id on subsequent calls (same tab)", () => {
    const first = getOrCreateSessionId();
    const second = getOrCreateSessionId();
    expect(second).toBe(first);
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

    const id = getOrCreateSessionId(fakeStorage);
    expect(getOrCreateSessionId(fakeStorage)).toBe(id);
  });

  describe("without crypto.randomUUID (insecure-context fallback)", () => {
    // crypto.randomUUID() only exists in secure contexts (HTTPS, or the
    // literal hostnames "localhost"/"127.0.0.1") — a custom local hostname
    // like host.docker.internal doesn't qualify, even though it's just as
    // local. Simulates that by removing it and confirming the
    // getRandomValues-based fallback still produces a usable id.
    const original = crypto.randomUUID;

    beforeEach(() => {
      // @ts-expect-error - deliberately simulating an environment without it
      delete crypto.randomUUID;
    });

    afterEach(() => {
      crypto.randomUUID = original;
    });

    it("still generates a valid-looking v4 UUID", () => {
      const id = getOrCreateSessionId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it("still persists and returns the same id on subsequent calls", () => {
      const first = getOrCreateSessionId();
      const second = getOrCreateSessionId();
      expect(second).toBe(first);
    });
  });
});
