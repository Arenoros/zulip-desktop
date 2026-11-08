import test from "tape";

import {isLiveKitCallUrl} from "../app/main/livekit-call-url.ts";

const server = "https://chat.example.com";

test("LiveKit call links of the tab's server open in the app", (t) => {
  t.true(
    isLiveKitCallUrl(
      server,
      new URL("https://chat.example.com/calls/livekit/join?call_id=123"),
    ),
  );
  t.true(
    isLiveKitCallUrl(
      server,
      new URL(
        "https://chat.example.com/calls/livekit/join?call_id=123&voice_only=true",
      ),
    ),
  );
  t.end();
});

test("Other links open in the browser", (t) => {
  for (const url of [
    // Another server
    "https://evil.example.com/calls/livekit/join?call_id=123",
    // eslint-disable-next-line unicorn/prefer-https -- another origin
    "http://chat.example.com/calls/livekit/join?call_id=123",
    "https://chat.example.com:8443/calls/livekit/join?call_id=123",
    // Another page of the server
    "https://chat.example.com/calls/bigbluebutton/join?meeting_id=1",
    "https://chat.example.com/calls/livekit/join/extra",
    "https://chat.example.com/user_uploads/2/ab/call.png",
  ]) {
    t.false(isLiveKitCallUrl(server, new URL(url)), url);
  }

  t.end();
});
