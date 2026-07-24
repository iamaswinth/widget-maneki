import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOn = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockSetMicrophoneEnabled = vi.fn().mockResolvedValue(undefined);
const mockStartAudio = vi.fn().mockResolvedValue(undefined);
const mockSendText = vi.fn().mockResolvedValue(undefined);

class FakeRoom {
  on = mockOn;
  connect = mockConnect;
  disconnect = mockDisconnect;
  startAudio = mockStartAudio;
  localParticipant = { setMicrophoneEnabled: mockSetMicrophoneEnabled, sendText: mockSendText };
}

// Intercepts both the static type-only import in livekit-connection.ts and
// the runtime dynamic import() it performs — vitest's vi.mock handles both.
vi.mock("livekit-client", () => ({
  Room: FakeRoom,
  RoomEvent: {
    TrackSubscribed: "trackSubscribed",
    DataReceived: "dataReceived",
    Disconnected: "disconnected",
    TranscriptionReceived: "transcriptionReceived",
  },
  Track: { Kind: { Audio: "audio", Video: "video" } },
  // Mirrors @livekit/protocol's ParticipantInfo_Kind. The server assigns this
  // from the joining token's grants — a participant can't set its own.
  ParticipantKind: { STANDARD: 0, INGRESS: 1, EGRESS: 2, SIP: 3, AGENT: 4 },
}));

import { connectToRoom } from "../src/livekit-connection";

const AGENT_SENDER = { kind: 4 };
const VISITOR_SENDER = { kind: 0 };

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
  mockSendText.mockClear();
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
    getHandler("dataReceived")(payload, AGENT_SENDER);

    expect(h.onDataMessage).toHaveBeenCalledWith({ type: "navigate", target: "#pricing" });
  });

  it("swallows a malformed data-channel payload instead of throwing", async () => {
    const h = handlers();
    await connectToRoom("wss://lk.example.com", "jwt-abc", h);

    const badPayload = new TextEncoder().encode("not json");
    expect(() => getHandler("dataReceived")(badPayload, AGENT_SENDER)).not.toThrow();
    expect(h.onDataMessage).not.toHaveBeenCalled();
  });

  describe("data-channel sender identity", () => {
    // navigate/interrupt drive the host page, so a message from anyone but the
    // voice-runtime agent must not be acted on.
    const navigatePayload = () =>
      new TextEncoder().encode(JSON.stringify({ type: "navigate", target: "https://evil.example.com" }));

    it("ignores a message from another visitor in the room", async () => {
      const h = handlers();
      await connectToRoom("wss://lk.example.com", "jwt-abc", h);

      getHandler("dataReceived")(navigatePayload(), VISITOR_SENDER);

      expect(h.onDataMessage).not.toHaveBeenCalled();
    });

    it("ignores a packet with no participant at all", async () => {
      // Server-originated data, or anything LiveKit can't attribute.
      const h = handlers();
      await connectToRoom("wss://lk.example.com", "jwt-abc", h);

      getHandler("dataReceived")(navigatePayload(), undefined);

      expect(h.onDataMessage).not.toHaveBeenCalled();
    });

    it("still accepts the agent", async () => {
      const h = handlers();
      await connectToRoom("wss://lk.example.com", "jwt-abc", h);

      getHandler("dataReceived")(
        new TextEncoder().encode(JSON.stringify({ type: "interrupt" })),
        AGENT_SENDER
      );

      expect(h.onDataMessage).toHaveBeenCalledWith({ type: "interrupt" });
    });
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

  describe("transcription", () => {
    it("reports the local participant's final segment as 'you'", async () => {
      const onTranscription = vi.fn();
      await connectToRoom("wss://lk.example.com", "jwt-abc", handlers({ onTranscription }));

      getHandler("transcriptionReceived")(
        [{ id: "seg-1", text: "how much does it cost", final: true }],
        { isLocal: true }
      );

      expect(onTranscription).toHaveBeenCalledWith("how much does it cost", "you");
    });

    it("reports a remote participant's final segment as 'agent'", async () => {
      const onTranscription = vi.fn();
      await connectToRoom("wss://lk.example.com", "jwt-abc", handlers({ onTranscription }));

      getHandler("transcriptionReceived")(
        [{ id: "seg-2", text: "It starts at forty nine dollars.", final: true }],
        { isLocal: false }
      );

      expect(onTranscription).toHaveBeenCalledWith("It starts at forty nine dollars.", "agent");
    });

    it("ignores interim (non-final) segments", async () => {
      const onTranscription = vi.fn();
      await connectToRoom("wss://lk.example.com", "jwt-abc", handlers({ onTranscription }));

      getHandler("transcriptionReceived")([{ id: "seg-3", text: "It starts at", final: false }], {
        isLocal: false,
      });

      expect(onTranscription).not.toHaveBeenCalled();
    });

    it("does nothing when onTranscription is omitted (optional handler)", async () => {
      await connectToRoom("wss://lk.example.com", "jwt-abc", handlers());

      expect(() =>
        getHandler("transcriptionReceived")([{ id: "seg-4", text: "hi", final: true }], {
          isLocal: true,
        })
      ).not.toThrow();
    });

    it("treats a missing participant as remote (agent) — LiveKit omits it for some server-attributed segments", async () => {
      const onTranscription = vi.fn();
      await connectToRoom("wss://lk.example.com", "jwt-abc", handlers({ onTranscription }));

      getHandler("transcriptionReceived")([{ id: "seg-5", text: "hello", final: true }], undefined);

      expect(onTranscription).toHaveBeenCalledWith("hello", "agent");
    });
  });

  describe("sendText", () => {
    it("sends the text over the lk.chat topic", async () => {
      const connection = await connectToRoom("wss://lk.example.com", "jwt-abc", handlers());

      await connection.sendText("how much does it cost?");

      expect(mockSendText).toHaveBeenCalledWith("how much does it cost?", { topic: "lk.chat" });
    });
  });
});
