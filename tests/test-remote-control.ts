import test from "tape";

import type {CallParticipant, RemoteControlState} from "../app/common/types.ts";
import {RemoteControl} from "../app/main/remote-control.ts";

const cordelia = {identity: "8", name: "Cordelia"};
const hamlet = {identity: "10", name: "King Hamlet"};

function setUp(inactivityTimeout?: number, requestCooldown?: number) {
  const consents: Array<{
    participant: CallParticipant;
    signal: AbortSignal;
    answer: (allowed: boolean) => void;
    fail: (error: Error) => void;
  }> = [];
  const events: string[] = [];
  const states: RemoteControlState[] = [];
  const endedStates: string[] = [];
  let tokens = 0;
  const control = new RemoteControl(
    {
      async askConsent(participant, signal) {
        return new Promise<boolean>((resolve, reject) => {
          consents.push({participant, signal, answer: resolve, fail: reject});
          signal.addEventListener("abort", () => {
            resolve(false);
          });
        });
      },
      controlStarted(controller) {
        events.push(`started ${controller.identity}`);
      },
      controlEnded() {
        events.push("ended");
        endedStates.push(control.state.state);
      },
      stateChanged(state) {
        states.push(state);
      },
      newToken() {
        tokens += 1;
        return `token-${tokens}`;
      },
    },
    inactivityTimeout,
    requestCooldown,
  );
  return {control, consents, events, states, endedStates};
}

async function grant(
  {control, consents}: ReturnType<typeof setUp>,
  participant: CallParticipant,
): Promise<void> {
  const request = control.request(participant);
  consents.at(-1)!.answer(true);
  await request;
}

test("Control starts only once the owner allows it", async (t) => {
  const setup = setUp();
  const {control, consents, events, states} = setup;
  control.shareStarted();
  const request = control.request(cordelia);
  t.deepEqual(control.state, {state: "requested", participant: cordelia});
  t.deepEqual(events, []);
  t.equal(consents.length, 1);
  t.deepEqual(consents[0]!.participant, cordelia);

  consents[0]!.answer(true);
  await request;
  t.deepEqual(control.state, {
    state: "controlled",
    participant: cordelia,
    token: "token-1",
  });
  t.deepEqual(events, ["started 8"]);
  t.deepEqual(
    states.map(({state}) => state),
    ["shared", "requested", "controlled"],
  );
  control.shareStopped();
});

test("Denying the request keeps the screen shared", async (t) => {
  const {control, consents, events} = setUp();
  control.shareStarted();
  const request = control.request(cordelia);
  consents[0]!.answer(false);
  await request;
  t.deepEqual(control.state, {state: "shared"});
  t.deepEqual(events, []);
});

test("A failure to ask for consent denies the request", async (t) => {
  const {control, consents, events} = setUp();
  control.shareStarted();
  const request = control.request(cordelia);
  consents[0]!.fail(new Error("No dialog"));
  await request;
  t.deepEqual(control.state, {state: "shared"});
  t.deepEqual(events, []);
});

test("Requests need a shared screen nobody controls or requested", async (t) => {
  const setup = setUp();
  const {control, consents} = setup;
  await control.request(cordelia);
  t.deepEqual(control.state, {state: "none"});
  t.equal(consents.length, 0, "no share");

  control.shareStarted();
  const pending = control.request(cordelia);
  await control.request(hamlet);
  t.equal(consents.length, 1, "pending request");
  t.deepEqual(control.state, {state: "requested", participant: cordelia});

  consents[0]!.answer(true);
  await pending;
  await control.request(hamlet);
  t.equal(consents.length, 1, "controlled");
  t.equal(control.state.state, "controlled");
  control.shareStopped();
});

test("Each grant has a new token", async (t) => {
  const setup = setUp();
  const {control} = setup;
  control.shareStarted();
  await grant(setup, cordelia);
  const first = control.state;
  control.stop();
  await grant(setup, cordelia);
  t.notDeepEqual(control.state, first);
  t.deepEqual(control.state, {
    state: "controlled",
    participant: cordelia,
    token: "token-2",
  });
  control.shareStopped();
});

test("Control ends when stopped", async (t) => {
  const setup = setUp();
  const {control, events, endedStates} = setup;
  control.shareStarted();
  await grant(setup, cordelia);
  control.stop();
  t.deepEqual(control.state, {state: "shared"});
  t.deepEqual(events, ["started 8", "ended"]);
  t.deepEqual(endedStates, ["shared"], "the hook sees the new state");

  control.stop();
  t.deepEqual(events, ["started 8", "ended"], "stopping again does nothing");
});

test("Stopping does not answer a pending request", (t) => {
  const {control, consents} = setUp();
  control.shareStarted();
  void control.request(cordelia);
  control.stop();
  t.deepEqual(control.state, {state: "requested", participant: cordelia});
  t.false(consents[0]!.signal.aborted);
  control.shareStopped();
  t.end();
});

test("Control ends when the controller leaves", async (t) => {
  const setup = setUp();
  const {control, events} = setup;
  control.shareStarted();
  await grant(setup, cordelia);
  control.participantLeft(hamlet.identity);
  t.equal(control.state.state, "controlled", "another participant left");
  control.participantLeft(cordelia.identity);
  t.deepEqual(control.state, {state: "shared"});
  t.deepEqual(events, ["started 8", "ended"]);
});

test("A request ends when the requester leaves", async (t) => {
  const {control, consents, events} = setUp();
  control.shareStarted();
  const request = control.request(cordelia);
  control.participantLeft(cordelia.identity);
  t.true(consents[0]!.signal.aborted);
  t.deepEqual(control.state, {state: "shared"});

  // Even if the owner allowed it just as the requester left.
  consents[0]!.answer(true);
  await request;
  t.deepEqual(control.state, {state: "shared"});
  t.deepEqual(events, []);
});

test("Control and requests end when the share stops", async (t) => {
  const setup = setUp();
  const {control, consents, events} = setup;
  control.shareStarted();
  await grant(setup, cordelia);
  control.shareStopped();
  t.deepEqual(control.state, {state: "none"});
  t.deepEqual(events, ["started 8", "ended"]);

  control.shareStarted();
  const request = control.request(hamlet);
  control.shareStopped();
  t.true(consents[1]!.signal.aborted);
  consents[1]!.answer(true);
  await request;
  t.deepEqual(control.state, {state: "none"});
  t.deepEqual(events, ["started 8", "ended"]);
});

test("Sharing another screen ends control of the previous one", async (t) => {
  const setup = setUp();
  const {control, events} = setup;
  control.shareStarted();
  await grant(setup, cordelia);
  control.shareStarted();
  t.deepEqual(control.state, {state: "shared"});
  t.deepEqual(events, ["started 8", "ended"]);
});

test("Control ends after the inactivity timeout", async (t) => {
  const setup = setUp(20);
  const {control, events} = setup;
  control.shareStarted();
  await grant(setup, cordelia);
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  t.deepEqual(control.state, {state: "shared"});
  t.deepEqual(events, ["started 8", "ended"]);
});

test("A refused participant cannot ask again until the cooldown ends", async (t) => {
  const {control, consents} = setUp(undefined, 30);
  control.shareStarted();
  const request = control.request(cordelia);
  consents[0]!.answer(false);
  await request;
  await control.request(cordelia);
  t.equal(consents.length, 1, "refused just now");
  t.deepEqual(control.state, {state: "shared"});

  // Others can still ask.
  const other = control.request(hamlet);
  t.equal(consents.length, 2);
  consents[1]!.fail(new Error("No dialog"));
  await other;
  await control.request(hamlet);
  t.equal(consents.length, 2, "a failure to ask counts as refusing");

  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  void control.request(cordelia);
  t.equal(consents.length, 3, "after the cooldown");
  t.deepEqual(control.state, {state: "requested", participant: cordelia});
  control.shareStopped();
});

test("Only refusals delay the next request", async (t) => {
  const setup = setUp(undefined, 60_000);
  const {control, consents} = setup;
  control.shareStarted();
  const first = control.request(cordelia);
  control.participantLeft(cordelia.identity);
  await first;
  void control.request(cordelia);
  t.equal(consents.length, 2, "after leaving during the request");
  control.shareStopped();

  control.shareStarted();
  await grant(setup, cordelia);
  control.stop();
  void control.request(cordelia);
  t.equal(consents.length, 4, "after control ended");
  control.shareStopped();
});
