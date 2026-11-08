import {spawnSync} from "node:child_process";
import {createRequire} from "node:module";
import path from "node:path";
import process from "node:process";

import test from "tape";

import {
  type MouseButton,
  RemoteInput,
  type RemoteInputBinding,
} from "../app/main/remote-input.ts";

function fakeBinding(calls: string[]): RemoteInputBinding {
  return {
    moveMouse: () => true,
    setMouseButton(button: MouseButton, down: boolean) {
      calls.push(`button ${button} ${down}`);
      return true;
    },
    scrollWheel: () => true,
    setKey(scanCode: number, down: boolean) {
      calls.push(`key ${scanCode} ${down}`);
      return true;
    },
    getCursorPosition: () => ({x: 0, y: 0}),
  };
}

test("releaseAll releases what is still held down", (t) => {
  const calls: string[] = [];
  const remoteInput = new RemoteInput(fakeBinding(calls));
  remoteInput.setKey(0x2a, true);
  remoteInput.setKey(0x1e, true);
  remoteInput.setKey(0x1e, false);
  remoteInput.setMouseButton("left", true);
  remoteInput.setMouseButton("right", true);
  remoteInput.setMouseButton("right", false);
  calls.length = 0;

  remoteInput.releaseAll();
  t.deepEqual(calls, ["key 42 false", "button left false"]);

  calls.length = 0;
  remoteInput.releaseAll();
  t.deepEqual(calls, []);
  t.end();
});

test(
  "native module clicks, scrolls, and types into a window",
  {skip: process.platform !== "win32"},
  (t) => {
    // Required from Node, the electron package is the path to Electron.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const electronPath = createRequire(import.meta.url)("electron") as string;
    const result = spawnSync(
      electronPath,
      [path.join(import.meta.dirname, "remote-input-app.cjs")],
      {encoding: "utf8", timeout: 30e3},
    );
    t.equal(result.status, 0, result.stderr);
    t.end();
  },
);
