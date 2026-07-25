import type { FrequencyProbe } from "./audio-level";

export type RemoteAudioHandler = (element: HTMLMediaElement) => void;

/** plan-v2 §5.4's data-channel protocol: {"type": "navigate", "target": "..."}
 * or {"type": "interrupt"} — see agent.py's _publish_event. */
export interface DataMessage {
  type: string;
  [key: string]: unknown;
}
export type DataMessageHandler = (message: DataMessage) => void;

/** "you" for the visitor's own transcribed speech, "agent" for the voice
 * runtime's generated replies — LiveKit's own transcript sync delivers both
 * over the room automatically (see agent.py's TranscriptSynchronizer),
 * independent of whether TTS audio actually plays. */
export type TranscriptionHandler = (text: string, speaker: "you" | "agent") => void;

export type AudioProbeKind = "local" | "remote";

/** A live handle to a track's amplitude — used by the radial visualizer.
 * `analyser` is typed via the structural FrequencyProbe (see audio-level.ts)
 * so no Web Audio *global* type or livekit-client type needs to leak into
 * element.ts. `calculateVolume` is livekit-client's own cheap 0..1 reading,
 * a fallback for callers that don't want to do their own FFT bucketing. */
export interface AudioProbe {
  kind: AudioProbeKind;
  analyser: FrequencyProbe;
  calculateVolume: () => number;
}
export type AudioProbeHandler = (probe: AudioProbe) => void;

export interface ConnectToRoomHandlers {
  onRemoteAudio: RemoteAudioHandler;
  onDataMessage: DataMessageHandler;
  /** Fires only for a disconnect the widget didn't initiate itself (network
   * drop, server-side room close) — never for our own connection.disconnect()
   * call, so callers can safely treat this as "the connection was lost". */
  onDisconnected: () => void;
  /** Optional — omit to skip transcript logging entirely. */
  onTranscription?: TranscriptionHandler;
  /** Optional — fires at most once per AudioProbeKind, and again if a track
   * is republished (the superseded probe's AudioContext is closed first).
   * MAY NEVER FIRE: a browser without usable Web Audio, an SDK build without
   * createAudioAnalyser, or a page already at the AudioContext cap gets no
   * probe at all. Callers must render sensibly with no amplitude in that
   * case — see radial-visualizer.ts's synthetic fallback. */
  onAudioProbe?: AudioProbeHandler;
}

// LiveKit Agents' AgentSession wires a text-stream handler on this topic by
// default (RoomIO._on_chat_text_stream in the livekit-agents Python SDK) and
// feeds it into the exact same generate_reply() pipeline a transcribed voice
// turn uses — no backend opt-in needed, this is enabled out of the box.
const CHAT_TOPIC = "lk.chat";

// createAudioAnalyser options: a small FFT is cheap and speech energy lives
// in a handful of low bins anyway — see audio-level.ts's DEFAULT_HIGH_BIN.
const ANALYSER_OPTIONS = { fftSize: 128, smoothingTimeConstant: 0.7 };

export interface LiveKitConnection {
  disconnect(): Promise<void>;
  sendText(text: string): Promise<void>;
  /** Mic mute toggle for the control bar. Rejects only if the underlying
   * room call rejects; callers are expected to catch and ignore transient
   * failures the same way any other mid-call operation might. */
  setMicrophoneEnabled(enabled: boolean): Promise<void>;
}

/** The only place `livekit-client` is imported — a dynamic import, so it's
 * fetched lazily on tap-to-talk (see vite.config.ts's comment on why the
 * build output is a single ES module, not iife/umd, to make this actually
 * code-split into its own chunk instead of being inlined). */
export async function connectToRoom(
  livekitUrl: string,
  token: string,
  handlers: ConnectToRoomHandlers
): Promise<LiveKitConnection> {
  // Kept as a module object (not fully destructured) so createAudioAnalyser
  // can be feature-detected below rather than assumed to exist — see
  // attachProbe.
  const lk = await import("livekit-client");
  const { Room, RoomEvent, Track, ParticipantKind } = lk;

  const room = new Room();
  let intentionalDisconnect = false;

  // Chrome caps concurrent AudioContexts per page (~6), and the HOST page
  // may already be using some — createAudioAnalyser opens a new one per
  // call, so leaking these across hangup/reconnect cycles would eventually
  // make every call throw. Keyed by kind so a republished track replaces
  // rather than accumulates.
  const probeCleanups = new Map<AudioProbeKind, () => Promise<void>>();

  async function releaseProbes(): Promise<void> {
    const cleanups = [...probeCleanups.values()];
    probeCleanups.clear();
    // allSettled, not all: one rejecting cleanup must never block
    // room.disconnect() below.
    await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
  }

  function attachProbe(kind: AudioProbeKind, track: unknown): void {
    const onAudioProbe = handlers.onAudioProbe;
    if (!onAudioProbe || !track) return;
    // Looked up off the module object rather than destructured above: an SDK
    // build (or a test double) without this helper must degrade to "the
    // visualizer runs without amplitude", not a TypeError mid-connect. The
    // `in` check comes first deliberately — vitest's mocked-module proxy
    // throws on a `get` of a property the mock factory never returned at
    // all (by design, to catch typos), but not on a `has` check, so this
    // order is what lets a test double omit the export entirely rather
    // than needing to declare it as `undefined`.
    if (!("createAudioAnalyser" in lk) || typeof lk.createAudioAnalyser !== "function") return;
    try {
      // cloneTrack deliberately left false (the default): with a cloned
      // track the analyser keeps reading while the visitor is muted, and
      // the ring would lie about mute.
      const { analyser, calculateVolume, cleanup } = lk.createAudioAnalyser(
        track as Parameters<typeof lk.createAudioAnalyser>[0],
        ANALYSER_OPTIONS
      );
      void probeCleanups.get(kind)?.(); // close a superseded context, if any
      probeCleanups.set(kind, cleanup);
      onAudioProbe({ kind, analyser, calculateVolume });
    } catch (err) {
      // AudioContext construction throws in jsdom, at the per-page context
      // cap, and under some CSP/permission configurations. The call itself
      // is unaffected — the visualizer just falls back to synthetic motion.
      console.warn(
        "<maneki-widget> audio analyser unavailable — visualizer will run without amplitude:",
        err
      );
    }
  }

  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      handlers.onRemoteAudio(track.attach());
      attachProbe("remote", track);
    }
  });

  room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: { kind?: unknown }) => {
    // These messages drive navigation and barge-in on the host page, so who
    // sent them matters as much as what they say. `kind` is assigned by the
    // LiveKit server from the joining token's grants, not self-reported, so
    // another participant in the room can't claim to be the agent. Anything
    // else — a second visitor, or a server-originated packet with no
    // participant at all — is dropped.
    if (!participant || participant.kind !== ParticipantKind.AGENT) {
      console.warn("<maneki-widget> ignoring a data-channel message from a non-agent sender");
      return;
    }
    try {
      const message = JSON.parse(new TextDecoder().decode(payload)) as DataMessage;
      handlers.onDataMessage(message);
    } catch (err) {
      console.error("<maneki-widget> received a malformed data-channel message:", err);
    }
  });

  room.on(RoomEvent.Disconnected, () => {
    if (!intentionalDisconnect) handlers.onDisconnected();
  });

  room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
    if (!handlers.onTranscription) return;
    for (const segment of segments) {
      // Interim (non-final) segments update rapidly as STT/TTS stream in —
      // only the final text per segment id is worth printing.
      if (!segment.final) continue;
      handlers.onTranscription(segment.text, participant?.isLocal ? "you" : "agent");
    }
  });

  await room.connect(livekitUrl, token);
  const micPub = await room.localParticipant.setMicrophoneEnabled(true);
  attachProbe("local", micPub?.audioTrack);
  // Browsers gate audio autoplay behind user interaction; tap-to-talk is
  // that interaction, but the actual remote track may not exist yet at
  // connect time, so explicitly unblocking playback here (rather than
  // relying on it happening implicitly once a track attaches later) avoids
  // a silent stuck state per LiveKit's own recommended pattern.
  await room.startAudio();

  return {
    disconnect: async () => {
      intentionalDisconnect = true; // set before any await — a Disconnected
      // event racing in during cleanup below must still classify as
      // intentional.
      await releaseProbes();
      await room.disconnect();
    },
    sendText: async (text: string) => {
      await room.localParticipant.sendText(text, { topic: CHAT_TOPIC });
    },
    setMicrophoneEnabled: async (enabled: boolean) => {
      await room.localParticipant.setMicrophoneEnabled(enabled);
    },
  };
}
