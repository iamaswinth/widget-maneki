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
  RoomEvent: { TrackSubscribed: "trackSubscribed" },
  Track: { Kind: { Audio: "audio", Video: "video" } },
}));

import { connectToRoom } from "../src/livekit-connection";

beforeEach(() => {
  mockOn.mockClear();
  mockConnect.mockClear();
  mockDisconnect.mockClear();
  mockSetMicrophoneEnabled.mockClear();
  mockStartAudio.mockClear();
});

describe("connectToRoom", () => {
  it("connects, enables the mic, and unblocks audio playback", async () => {
    await connectToRoom("wss://lk.example.com", "jwt-abc", vi.fn());

    expect(mockConnect).toHaveBeenCalledWith("wss://lk.example.com", "jwt-abc");
    expect(mockSetMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(mockStartAudio).toHaveBeenCalled();
  });

  it("invokes onRemoteAudio with the attached element when an audio track is subscribed", async () => {
    const onRemoteAudio = vi.fn();
    await connectToRoom("wss://lk.example.com", "jwt-abc", onRemoteAudio);

    const [eventName, handler] = mockOn.mock.calls[0];
    expect(eventName).toBe("trackSubscribed");

    const fakeAudioEl = document.createElement("audio");
    const fakeTrack = { kind: "audio", attach: () => fakeAudioEl };
    handler(fakeTrack);

    expect(onRemoteAudio).toHaveBeenCalledWith(fakeAudioEl);
  });

  it("ignores non-audio (e.g. video) tracks", async () => {
    const onRemoteAudio = vi.fn();
    await connectToRoom("wss://lk.example.com", "jwt-abc", onRemoteAudio);

    const [, handler] = mockOn.mock.calls[0];
    handler({ kind: "video", attach: vi.fn() });

    expect(onRemoteAudio).not.toHaveBeenCalled();
  });

  it("disconnect() tears down the underlying room", async () => {
    const connection = await connectToRoom("wss://lk.example.com", "jwt-abc", vi.fn());
    await connection.disconnect();
    expect(mockDisconnect).toHaveBeenCalled();
  });
});
