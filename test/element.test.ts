import { beforeEach, describe, expect, it } from "vitest";
import "../src/index";
import type { ManekiWidgetElement } from "../src/element";

function mountWidget(): ManekiWidgetElement {
  const el = document.createElement("maneki-widget") as ManekiWidgetElement;
  document.body.appendChild(el);
  return el;
}

describe("<maneki-widget>", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("registers the custom element", () => {
    expect(customElements.get("maneki-widget")).toBeDefined();
  });

  it("renders a Shadow DOM with an orb button and a label", () => {
    const el = mountWidget();
    const shadow = el.shadowRoot!;
    expect(shadow).not.toBeNull();
    expect(shadow.querySelector("button.orb")).not.toBeNull();
    expect(shadow.querySelector(".label")).not.toBeNull();
  });

  it("starts in the idle state with the idle label", () => {
    const el = mountWidget();
    expect(el.state).toBe("idle");
    expect(el.shadowRoot!.querySelector(".label")!.textContent).toBe("Tap to talk");
  });

  it.each([
    ["connecting", "Connecting…"],
    ["listening", "Listening…"],
    ["speaking", "Speaking…"],
    ["error", "Something went wrong"],
  ] as const)("renders the %s state correctly", (state, label) => {
    const el = mountWidget();
    el.setState(state);

    expect(el.state).toBe(state);
    expect(el.shadowRoot!.querySelector(".label")!.textContent).toBe(label);
    expect(el.shadowRoot!.querySelector("button.orb")!.getAttribute("data-state")).toBe(state);
  });

  it("is encapsulated: shadow-internal elements are unreachable from a light-DOM query", () => {
    mountWidget();
    // .orb only exists inside the widget's shadow root — a host-page-style
    // querySelector must not be able to reach it, proving the boundary.
    expect(document.querySelector(".orb")).toBeNull();
    expect(document.querySelector(".label")).toBeNull();
  });

  it("the widget's own <style> lives inside its shadow root, not the document", () => {
    mountWidget();
    const styleInDocument = Array.from(document.querySelectorAll("style")).some((s) =>
      s.textContent?.includes("button.orb")
    );
    expect(styleInDocument).toBe(false);
  });

  it("cleans up its subscription on disconnect (no error re-rendering after removal)", () => {
    const el = mountWidget();
    el.remove();
    expect(() => el.setState("listening")).not.toThrow();
  });
});
