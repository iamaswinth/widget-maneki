export type RemoteAudioHandler = (element: HTMLMediaElement) => void;

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
  onRemoteAudio: RemoteAudioHandler
): Promise<LiveKitConnection> {
  const { Room, RoomEvent, Track } = await import("livekit-client");

  const room = new Room();

  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      onRemoteAudio(track.attach());
    }
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
      await room.disconnect();
    },
  };
}
