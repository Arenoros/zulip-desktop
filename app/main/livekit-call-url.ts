// Links to LiveKit calls of the server a tab shows open in a call window
// of the app, which can share a screen for remote control.
export function isLiveKitCallUrl(server: string, url: URL): boolean {
  return url.origin === server && url.pathname === "/calls/livekit/join";
}
