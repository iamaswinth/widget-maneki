import { beforeEach, describe, expect, it } from "vitest";
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
});
