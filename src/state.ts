export type WidgetState = "idle" | "connecting" | "listening" | "speaking" | "error";

type Listener = (state: WidgetState, previous: WidgetState) => void;

/** Minimal pub/sub state holder — no real transition validation (any state
 * can follow any other) since the actual connection/audio logic that would
 * make some transitions illegal doesn't exist yet (Session 2+). */
export class WidgetStateMachine {
  private _state: WidgetState = "idle";
  private listeners = new Set<Listener>();

  get state(): WidgetState {
    return this._state;
  }

  setState(next: WidgetState): void {
    if (next === this._state) return;
    const previous = this._state;
    this._state = next;
    for (const listener of this.listeners) listener(next, previous);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
