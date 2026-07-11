/** getUserMedia (via livekit-client's setMicrophoneEnabled) rejects with
 * this specific DOMException when the visitor denies the mic permission
 * prompt — distinct from every other connection failure, since retrying
 * won't help until they change their browser's site settings. */
export function isMicPermissionDenied(err: unknown): boolean {
  return err instanceof DOMException && err.name === "NotAllowedError";
}
