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
  RoomEvent: { TrackSubscribed: "trackSubscribed", DataReceived: "dataReceived" },
  Track: { Kind: { Audio: "audio", Video: "video" } },
}));

import { connectToRoom } from "../src/livekit-connection";

function getHandler(eventName: string): (...args: unknown[]) => void {
  const call = mockOn.mock.calls.find(([name]) => name === eventName);
  if (!call) throw new Error(`no handler registered for ${eventName}`);
  return call[1];
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
    await connectToRoom("wss://lk.example.com", "jwt-abc", vi.fn(), vi.fn());

    expect(mockConnect).toHaveBeenCalledWith("wss://lk.example.com", "jwt-abc");
    expect(mockSetMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(mockStartAudio).toHaveBeenCalled();
  });

  it("invokes onRemoteAudio with the attached element when an audio track is subscribed", async () => {
    const onRemoteAudio = vi.fn();
    await connectToRoom("wss://lk.example.com", "jwt-abc", onRemoteAudio, vi.fn());

    const fakeAudioEl = document.createElement("audio");
    getHandler("trackSubscribed")({ kind: "audio", attach: () => fakeAudioEl });

    expect(onRemoteAudio).toHaveBeenCalledWith(fakeAudioEl);
  });

  it("ignores non-audio (e.g. video) tracks", async () => {
    const onRemoteAudio = vi.fn();
    await connectToRoom("wss://lk.example.com", "jwt-abc", onRemoteAudio, vi.fn());

    getHandler("trackSubscribed")({ kind: "video", attach: vi.fn() });

    expect(onRemoteAudio).not.toHaveBeenCalled();
  });

  it("disconnect() tears down the underlying room", async () => {
    const connection = await connectToRoom("wss://lk.example.com", "jwt-abc", vi.fn(), vi.fn());
    await connection.disconnect();
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it("decodes and forwards a valid JSON data-channel message", async () => {
    const onDataMessage = vi.fn();
    await connectToRoom("wss://lk.example.com", "jwt-abc", vi.fn(), onDataMessage);

    const payload = new TextEncoder().encode(JSON.stringify({ type: "navigate", target: "#pricing" }));
    getHandler("dataReceived")(payload);

    expect(onDataMessage).toHaveBeenCalledWith({ type: "navigate", target: "#pricing" });
  });

  it("swallows a malformed data-channel payload instead of throwing", async () => {
    const onDataMessage = vi.fn();
    await connectToRoom("wss://lk.example.com", "jwt-abc", vi.fn(), onDataMessage);

    const badPayload = new TextEncoder().encode("not json");
    expect(() => getHandler("dataReceived")(badPayload)).not.toThrow();
    expect(onDataMessage).not.toHaveBeenCalled();
  });
});
