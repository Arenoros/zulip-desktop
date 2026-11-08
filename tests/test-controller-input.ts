/* eslint-disable node-test/prefer-context-mock -- Tape has no mock context; the clock is restored in finally. */
import {mock} from "node:test";

import test from "tape";

import {ControllerInput, screenPoint} from "../app/main/controller-input.ts";
import {RemoteControl} from "../app/main/remote-control.ts";
import {RemoteInput} from "../app/main/remote-input.ts";

const participant = {identity: "8", name: "Cordelia"};
const token = "a".repeat(32);

function setup() {
  const calls: unknown[] = [];
  let accepted = true;
  let bounds:
    {x: number; y: number; width: number; height: number} | undefined = {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
  };
  const input = new RemoteInput({
    moveMouse(x, y) {
      calls.push(["move", x, y]);
      return accepted;
    },
    setMouseButton(button, down) {
      calls.push(["button", button, down]);
      return accepted;
    },
    scrollWheel(x, y) {
      calls.push(["wheel", x, y]);
      return accepted;
    },
    setKey: () => true,
    getCursorPosition: () => ({x: 0, y: 0}),
  });
  const control = new RemoteControl(
    {
      askConsent: async () => true,
      controlStarted: () => undefined,
      controlEnded() {
        input.releaseAll();
      },
      stateChanged: () => undefined,
      newToken: () => token,
    },
    1000,
  );
  const receiver = new ControllerInput(control, input, () => bounds);
  const message = (sequence: number, event: unknown) => ({
    version: 1,
    type: "mouse",
    token,
    sequence,
    event,
  });
  return {
    calls,
    control,
    receiver,
    message,
    async grant() {
      control.shareStarted();
      await control.request(participant);
    },
    removeDisplay() {
      bounds = undefined;
    },
    rejectInput() {
      accepted = false;
    },
  };
}

test("Normalized positions stay inside the shared screen", (t) => {
  const bounds = {x: -1920, y: 40, width: 1920, height: 1080};
  t.deepEqual(screenPoint({x: 0, y: 0}, bounds), {x: -1920, y: 40});
  t.deepEqual(screenPoint({x: 1, y: 1}, bounds), {x: -1, y: 1119});
  t.deepEqual(screenPoint({x: 0.5, y: 0.5}, bounds), {x: -960, y: 580});
  for (const point of [
    {x: -0.01, y: 0},
    {x: 0, y: 1.01},
    {x: NaN, y: 0},
    {x: 0, y: Infinity},
  ]) {
    t.equal(screenPoint(point, bounds), undefined);
  }

  t.equal(screenPoint({x: 0, y: 0}, {...bounds, width: 0}), undefined);
  t.equal(screenPoint({x: 0, y: 0}, {...bounds, x: 0.5}), undefined);
  t.end();
});

test("Mouse input requires a current grant, sender, token and valid protocol", async (t) => {
  const s = setup();
  const packet = s.message(1, {type: "move", x: 0.5, y: 0.5});
  s.receiver.receive(participant.identity, packet);
  t.deepEqual(s.calls, []);
  await s.grant();
  s.receiver.receive("intruder", packet);
  s.receiver.receive(undefined, packet);
  for (const invalid of [
    undefined,
    null,
    {},
    {...packet, version: 2},
    {...packet, token: "b".repeat(32)},
    {...packet, sequence: -1},
    {...packet, sequence: 0.5},
    {...packet, sequence: Infinity},
    {...packet, event: {type: "move", x: -0.01, y: 0}},
    {...packet, event: {type: "move", x: 0, y: 1.01}},
    {...packet, event: {type: "move", x: NaN, y: 0}},
    {
      ...packet,
      event: {type: "button", x: 0, y: 0, button: "back", down: true},
    },
    {
      ...packet,
      event: {type: "wheel", x: 0, y: 0, dx: 0, dy: 12_001},
    },
  ]) {
    s.receiver.receive(participant.identity, invalid);
  }

  t.deepEqual(s.calls, [], "invalid input never reaches the native module");
  s.receiver.receive(participant.identity, packet);
  t.deepEqual(s.calls, [["move", 960, 540]]);
  s.control.stop();
  s.calls.length = 0;
  s.receiver.receive(
    participant.identity,
    s.message(2, {type: "move", x: 0, y: 0}),
  );
  t.deepEqual(s.calls, [], "revoked input is rejected");
});

test("Late moves are dropped without dropping reliable button releases", async (t) => {
  const s = setup();
  await s.grant();
  s.receiver.receive("8", s.message(2, {type: "move", x: 0, y: 0}));
  s.receiver.receive("8", s.message(1, {type: "move", x: 1, y: 1}));
  s.receiver.receive("8", s.message(2, {type: "move", x: 1, y: 1}));
  t.deepEqual(s.calls, [["move", 0, 0]]);
  s.calls.length = 0;
  s.receiver.receive(
    "8",
    s.message(3, {type: "button", button: "left", down: true, x: 0, y: 0}),
  );
  s.receiver.receive("8", s.message(5, {type: "move", x: 1, y: 1}));
  s.receiver.receive(
    "8",
    s.message(4, {type: "button", button: "left", down: false, x: 0.5, y: 0.5}),
  );
  s.receiver.receive(
    "8",
    s.message(4, {type: "button", button: "left", down: true, x: 0, y: 0}),
  );
  t.deepEqual(s.calls, [
    ["move", 0, 0],
    ["button", "left", true],
    ["move", 1919, 1079],
    ["move", 960, 540],
    ["button", "left", false],
  ]);
  s.calls.length = 0;
  s.receiver.receive(
    "8",
    s.message(6, {type: "wheel", x: 0.5, y: 0.5, dx: 120, dy: 240}),
  );
  t.deepEqual(s.calls, [
    ["move", 960, 540],
    ["wheel", 120, -240],
  ]);
  s.control.stop();
});

test("Every end of control releases held buttons", async (t) => {
  for (const end of [
    (s: ReturnType<typeof setup>) => {
      s.control.stop();
    },
    (s: ReturnType<typeof setup>) => {
      s.control.shareStopped();
    },
    (s: ReturnType<typeof setup>) => {
      s.control.shareStarted();
    },
    (s: ReturnType<typeof setup>) => {
      s.control.participantLeft("8");
    },
    (s: ReturnType<typeof setup>) => {
      s.removeDisplay();
      s.receiver.receive("8", s.message(3, {type: "move", x: 0, y: 0}));
    },
  ]) {
    const s = setup();
    // eslint-disable-next-line no-await-in-loop -- Each scenario owns its grant and input state.
    await s.grant();
    s.receiver.receive(
      "8",
      s.message(1, {type: "button", button: "left", down: true, x: 0, y: 0}),
    );
    s.receiver.receive(
      "8",
      s.message(2, {type: "button", button: "right", down: true, x: 0, y: 0}),
    );
    s.calls.length = 0;
    end(s);
    t.deepEqual(s.calls, [
      ["button", "left", false],
      ["button", "right", false],
    ]);
  }
});

test("Input rate is bounded and exhaustion releases a held button", async (t) => {
  const s = setup();
  await s.grant();
  s.receiver.receive(
    "8",
    s.message(1, {type: "button", button: "left", down: true, x: 0, y: 0}),
    0,
  );
  for (let sequence = 2; sequence <= 121; sequence += 1) {
    s.receiver.receive("8", s.message(sequence, {type: "move", x: 0, y: 0}), 0);
  }

  t.equal(s.control.state.state, "shared");
  t.equal(s.calls.length, 122);
  t.deepEqual(s.calls.at(-1), ["button", "left", false]);
});

test("Accepted input refreshes the inactivity timeout; rejected input does not", async (t) => {
  mock.timers.enable({apis: ["setTimeout"]});
  const s = setup();
  try {
    await s.grant();
    mock.timers.tick(900);
    s.receiver.receive(
      "8",
      s.message(1, {type: "button", button: "middle", down: true, x: 0, y: 0}),
    );
    mock.timers.tick(900);
    t.equal(s.control.state.state, "controlled");
    s.receiver.receive("other", s.message(2, {type: "move", x: 0, y: 0}));
    mock.timers.tick(100);
    t.equal(s.control.state.state, "shared");
    t.deepEqual(s.calls.at(-1), ["button", "middle", false]);
  } finally {
    s.control.stop();
    mock.timers.reset();
  }
});

test("Rejected native input ends control without crashing", async (t) => {
  const s = setup();
  await s.grant();
  s.rejectInput();
  s.receiver.receive("8", s.message(1, {type: "move", x: 0, y: 0}));
  t.equal(s.control.state.state, "shared");
});
