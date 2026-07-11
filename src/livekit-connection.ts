export type RemoteAudioHandler = (element: HTMLMediaElement) => void;

/** plan-v2 §5.4's data-channel protocol: {"type": "navigate", "target": "..."}
 * or {"type": "interrupt"} — see agent.py's _publish_event. */
export interface DataMessage {
  type: string;
  [key: string]: unknown;
}
export type DataMessageHandler = (message: DataMessage) => void;

export interface ConnectToRoomHandlers {
  onRemoteAudio: RemoteAudioHandler;
  onDataMessage: DataMessageHandler;
  /** Fires only for a disconnect the widget didn't initiate itself (network
   * drop, server-side room close) — never for our own connection.disconnect()
   * call, so callers can safely treat this as "the connection was lost". */
  onDisconnected: () => void;
}

export interface LiveKitConnection {
  disconnect(): Promise<void>;
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
  const { Room, RoomEvent, Track } = await import("livekit-client");

  const room = new Room();
  let intentionalDisconnect = false;

  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      handlers.onRemoteAudio(track.attach());
    }
  });

  room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
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

  await room.connect(livekitUrl, token);
  await room.localParticipant.setMicrophoneEnabled(true);
  // Browsers gate audio autoplay behind user interaction; tap-to-talk is
  // that interaction, but the actual remote track may not exist yet at
  // connect time, so explicitly unblocking playback here (rather than
  // relying on it happening implicitly once a track attaches later) avoids
  // a silent stuck state per LiveKit's own recommended pattern.
  await room.startAudio();

  return {
    disconnect: async () => {
      intentionalDisconnect = true;
      await room.disconnect();
    },
  };
}
