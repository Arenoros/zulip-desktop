import {createRequire} from "node:module";
import process from "node:process";

// Physical mouse buttons; the system's swapped-buttons setting applies
// to them exactly as it does to a real mouse.
export type MouseButton = "left" | "right" | "middle";

// The zulip-remote-input native module.  Every function returns false
// if Windows did not accept the input.  Windows silently drops input
// aimed at windows of elevated processes (UIPI), so true does not
// guarantee delivery.
export type RemoteInputBinding = {
  // Physical pixels on the virtual desktop, as returned by
  // screen.dipToScreenPoint.  Points outside the virtual desktop are
  // rejected.
  moveMouse(x: number, y: number): boolean;
  setMouseButton(button: MouseButton, down: boolean): boolean;
  // WHEEL_DELTA units (120 per notch).  Positive deltaY scrolls up and
  // positive deltaX scrolls right, as in Windows.
  scrollWheel(deltaX: number, deltaY: number): boolean;
  // Set 1 scan code; extended keys carry the 0xE0 prefix, e.g. 0xE048
  // for the Up arrow.
  setKey(scanCode: number, down: boolean): boolean;
  getCursorPosition(): {x: number; y: number};
};

// Remembers which keys and mouse buttons are held down on behalf of a
// remote user, so that they can all be released however the remote
// control session ends.
export class RemoteInput {
  private readonly binding: RemoteInputBinding;
  private readonly pressedButtons = new Set<MouseButton>();
  private readonly pressedKeys = new Set<number>();

  constructor(binding: RemoteInputBinding) {
    this.binding = binding;
  }

  moveMouse(x: number, y: number): boolean {
    return this.binding.moveMouse(x, y);
  }

  setMouseButton(button: MouseButton, down: boolean): boolean {
    if (down) {
      this.pressedButtons.add(button);
    } else {
      this.pressedButtons.delete(button);
    }

    return this.binding.setMouseButton(button, down);
  }

  scrollWheel(deltaX: number, deltaY: number): boolean {
    return this.binding.scrollWheel(deltaX, deltaY);
  }

  setKey(scanCode: number, down: boolean): boolean {
    if (down) {
      this.pressedKeys.add(scanCode);
    } else {
      this.pressedKeys.delete(scanCode);
    }

    return this.binding.setKey(scanCode, down);
  }

  releaseAll(): void {
    for (const scanCode of this.pressedKeys) {
      this.binding.setKey(scanCode, false);
    }

    for (const button of this.pressedButtons) {
      this.binding.setMouseButton(button, false);
    }

    this.pressedKeys.clear();
    this.pressedButtons.clear();
  }
}

// Returns undefined where remote control is not supported.
export function loadRemoteInput(): RemoteInput | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }

  try {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- native module without type information
    return new RemoteInput(require("zulip-remote-input") as RemoteInputBinding);
  } catch (error: unknown) {
    console.error("Failed to load zulip-remote-input:", error);
    return undefined;
  }
}
