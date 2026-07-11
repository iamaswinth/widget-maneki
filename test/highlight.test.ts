import { beforeEach, describe, expect, it, vi } from "vitest";
import { highlightElement } from "../src/highlight";

describe("highlightElement", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("appends an overlay to document.body, not inside the target element", () => {
    const target = document.createElement("div");
    target.id = "pricing";
    document.body.appendChild(target);

    highlightElement(target);

    const overlay = document.body.querySelector("[data-maneki-highlight]");
    expect(overlay).not.toBeNull();
    expect(overlay!.parentElement).toBe(document.body);
    expect(target.querySelector("[data-maneki-highlight]")).toBeNull();
  });

  it("positions the overlay using the element's bounding rect", () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 100,
      left: 50,
      width: 200,
      height: 40,
      right: 250,
      bottom: 140,
      x: 50,
      y: 100,
      toJSON: () => ({}),
    });

    highlightElement(target);

    const overlay = document.body.querySelector<HTMLElement>("[data-maneki-highlight]")!;
    expect(overlay.style.top).toBe("100px");
    expect(overlay.style.left).toBe("50px");
    expect(overlay.style.width).toBe("200px");
    expect(overlay.style.height).toBe("40px");
  });

  it("fades out and removes itself after the highlight duration", () => {
    vi.useFakeTimers();
    const target = document.createElement("div");
    document.body.appendChild(target);

    highlightElement(target);
    expect(document.body.querySelector("[data-maneki-highlight]")).not.toBeNull();

    vi.advanceTimersByTime(2500);
    expect(document.body.querySelector<HTMLElement>("[data-maneki-highlight]")!.style.opacity).toBe("0");

    vi.advanceTimersByTime(400);
    expect(document.body.querySelector("[data-maneki-highlight]")).toBeNull();

    vi.useRealTimers();
  });
});
