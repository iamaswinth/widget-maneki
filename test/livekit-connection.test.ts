import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOn = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockSetMicrophoneEnabled = vi.fn().mockResolvedValue(undefined);
const mockStartAudio = vi.fn().mockResolvedValue(undefined);

class FakeRoom {
  on = mockOn;
  connect = mockConnect;
  disconnect = mockDisconnect;
  startAudio = mockStartAudio;
  localParticipant = { setMicrophoneEnabled: mockSetMicrophoneEnabled };
}

// Intercepts both the static type-only import in livekit-connection.ts and
// the runtime dynamic import() it performs — vitest's vi.mock handles both.
vi.mock("livekit-client", () => ({
  Room: FakeRoom,
  RoomEvent: { TrackSubscribed: "trackSubscribed", DataReceived: "dataReceived", Disconnected: "disconnected" },
  Track: { Kind: { Audio: "audio", Video: "video" } },
}));

import { connectToRoom } from "../src/livekit-connection";

function getHandler(eventName: string): (...args: unknown[]) => void {
  const call = mockOn.mock.calls.find(([name]) => name === eventName);
  if (!call) throw new Error(`no handler registered for ${eventName}`);
  return call[1];
}

function handlers(overrides: Partial<Parameters<typeof connectToRoom>[2]> = {}) {
  return {
    onRemoteAudio: vi.fn(),
    onDataMessage: vi.fn(),
    onDisconnected: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  mockOn.mockClear();
  mockConnect.mockClear();
  mockDisconnect.mockClear();
  mockSetMicrophoneEnabled.mockClear();
  mockStartAudio.mockClear();
});

describe("connectToRoom", () => {
  it("connects, enables the mic, and unblocks audio playback", async () => {
    await connectToRoom("wss://lk.example.com", "jwt-abc", handlers());

    expect(mockConnect).toHaveBeenCalledWith("wss://lk.example.com", "jwt-abc");
    expect(mockSetMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(mockStartAudio).toHaveBeenCalled();
  });

  it("invokes onRemoteAudio with the attached element when an audio track is subscribed", async () => {
    const h = handlers();
    await connectToRoom("wss://lk.example.com", "jwt-abc", h);

    const fakeAudioEl = document.createElement("audio");
    getHandler("trackSubscribed")({ kind: "audio", attach: () => fakeAudioEl });

    expect(h.onRemoteAudio).toHaveBeenCalledWith(fakeAudioEl);
  });

  it("ignores non-audio (e.g. video) tracks", async () => {
    const h = handlers();
    await connectToRoom("wss://lk.example.com", "jwt-abc", h);

    getHandler("trackSubscribed")({ kind: "video", attach: vi.fn() });

    expect(h.onRemoteAudio).not.toHaveBeenCalled();
  });

  it("disconnect() tears down the underlying room", async () => {
    const connection = await connectToRoom("wss://lk.example.com", "jwt-abc", handlers());
    await connection.disconnect();
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it("decodes and forwards a valid JSON data-channel message", async () => {
    const h = handlers();
    await connectToRoom("wss://lk.example.com", "jwt-abc", h);

    const payload = new TextEncoder().encode(JSON.stringify({ type: "navigate", target: "#pricing" }));
    getHandler("dataReceived")(payload);

    expect(h.onDataMessage).toHaveBeenCalledWith({ type: "navigate", target: "#pricing" });
  });

  it("swallows a malformed data-channel payload instead of throwing", async () => {
    const h = handlers();
    await connectToRoom("wss://lk.example.com", "jwt-abc", h);

    const badPayload = new TextEncoder().encode("not json");
    expect(() => getHandler("dataReceived")(badPayload)).not.toThrow();
    expect(h.onDataMessage).not.toHaveBeenCalled();
  });

  it("invokes onDisconnected for an unexpected room disconnect", async () => {
    const h = handlers();
    await connectToRoom("wss://lk.example.com", "jwt-abc", h);

    getHandler("disconnected")();

    expect(h.onDisconnected).toHaveBeenCalled();
  });

  it("does not invoke onDisconnected for a disconnect we initiated ourselves", async () => {
    const h = handlers();
    const connection = await connectToRoom("wss://lk.example.com", "jwt-abc", h);

    await connection.disconnect();
    // The real Room would fire RoomEvent.Disconnected as a side effect of
    // room.disconnect() — simulate that here.
    getHandler("disconnected")();

    expect(h.onDisconnected).not.toHaveBeenCalled();
  });
});
