import { describe, expect, it, vi } from "vitest";
import { WidgetStateMachine } from "../src/state";

describe("WidgetStateMachine", () => {
  it("starts idle", () => {
    const machine = new WidgetStateMachine();
    expect(machine.state).toBe("idle");
  });

  it("notifies subscribers with next and previous state on change", () => {
    const machine = new WidgetStateMachine();
    const listener = vi.fn();
    machine.subscribe(listener);

    machine.setState("connecting");

    expect(listener).toHaveBeenCalledWith("connecting", "idle");
    expect(machine.state).toBe("connecting");
  });

  it("does not notify when setting the same state again", () => {
    const machine = new WidgetStateMachine();
    machine.setState("listening");
    const listener = vi.fn();
    machine.subscribe(listener);

    machine.setState("listening");

    expect(listener).not.toHaveBeenCalled();
  });

  it("unsubscribe stops further notifications", () => {
    const machine = new WidgetStateMachine();
    const listener = vi.fn();
    const unsubscribe = machine.subscribe(listener);

    unsubscribe();
    machine.setState("speaking");

    expect(listener).not.toHaveBeenCalled();
  });

  it("supports multiple independent subscribers", () => {
    const machine = new WidgetStateMachine();
    const a = vi.fn();
    const b = vi.fn();
    machine.subscribe(a);
    machine.subscribe(b);

    machine.setState("error");

    expect(a).toHaveBeenCalledWith("error", "idle");
    expect(b).toHaveBeenCalledWith("error", "idle");
  });
});
