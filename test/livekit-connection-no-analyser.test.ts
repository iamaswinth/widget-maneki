import { describe, expect, it, vi } from "vitest";

// vi.mock is file-scoped, so proving "an SDK build that doesn't export
// createAudioAnalyser at all" needs its own file — the main
// livekit-connection.test.ts's mock factory always exports it. This is the
// permanent regression guard for older/partial livekit-client builds, and
// for the exact mock shape the rest of that suite relies on: the
// feature-detect in livekit-connection.ts (`typeof lk.createAudioAnalyser
// !== "function"`) must degrade gracefully rather than throw.
const mockOn = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockSetMicrophoneEnabled = vi.fn().mockResolvedValue({ audioTrack: { kind: "audio" } });
const mockStartAudio = vi.fn().mockResolvedValue(undefined);
const mockSendText = vi.fn().mockResolvedValue(undefined);

class FakeRoom {
  on = mockOn;
  connect = mockConnect;
  disconnect = mockDisconnect;
  startAudio = mockStartAudio;
  localParticipant = { setMicrophoneEnabled: mockSetMicrophoneEnabled, sendText: mockSendText };
}

vi.mock("livekit-client", () => ({
  Room: FakeRoom,
  RoomEvent: {
    TrackSubscribed: "trackSubscribed",
    DataReceived: "dataReceived",
    Disconnected: "disconnected",
    TranscriptionReceived: "transcriptionReceived",
  },
  Track: { Kind: { Audio: "audio", Video: "video" } },
  ParticipantKind: { STANDARD: 0, INGRESS: 1, EGRESS: 2, SIP: 3, AGENT: 4 },
  // Deliberately NO createAudioAnalyser key at all.
}));

import { connectToRoom } from "../src/livekit-connection";

function getHandler(eventName: string): (...args: unknown[]) => void {
  const call = mockOn.mock.calls.find(([name]) => name === eventName);
  if (!call) throw new Error(`no handler registered for ${eventName}`);
  return call[1];
}

describe("connectToRoom against an SDK build without createAudioAnalyser", () => {
  it("still resolves normally", async () => {
    await expect(
      connectToRoom("wss://lk.example.com", "jwt-abc", {
        onRemoteAudio: vi.fn(),
        onDataMessage: vi.fn(),
        onDisconnected: vi.fn(),
        onAudioProbe: vi.fn(),
      })
    ).resolves.toBeDefined();
  });

  it("never calls onAudioProbe, for either the local or remote track", async () => {
    const onAudioProbe = vi.fn();
    await connectToRoom("wss://lk.example.com", "jwt-abc", {
      onRemoteAudio: vi.fn(),
      onDataMessage: vi.fn(),
      onDisconnected: vi.fn(),
      onAudioProbe,
    });

    getHandler("trackSubscribed")({ kind: "audio", attach: () => document.createElement("audio") });

    expect(onAudioProbe).not.toHaveBeenCalled();
  });
});
