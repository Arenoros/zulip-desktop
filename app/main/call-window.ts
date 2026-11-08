import {
  BrowserWindow,
  type DesktopCapturerSource,
  type Display,
  type DisplayMediaRequestHandlerHandlerRequest,
  type Streams,
  type WebContents,
  desktopCapturer,
  dialog,
  globalShortcut,
  screen,
  webContents,
} from "electron/main";
import crypto from "node:crypto";
import path from "node:path";

import {bundlePath} from "../common/paths.ts";
import {t} from "../common/translation-util.ts";
import type {CallParticipant} from "../common/types.ts";

import {showControlIndicator} from "./control-indicator.ts";
import {ControllerInput} from "./controller-input.ts";
import {RemoteControl} from "./remote-control.ts";
import {loadRemoteInput} from "./remote-input.ts";
import {send} from "./typed-ipc-main.ts";

const stopControlShortcut = "Ctrl+Alt+Shift+S";

type CallWindow = {
  window: BrowserWindow;
  url: string;
  origin: string;
  // The screen the user chose to share, until the call page gets it.
  chosenScreen: DesktopCapturerSource | undefined;
  // The display the call page last got to share.  Only the main process
  // sets it, so that the call page cannot pick what is controlled.
  sharedDisplayId: number | undefined;
  remoteControl: RemoteControl;
  controllerInput: ControllerInput | undefined;
  hideControlIndicator: (() => void) | undefined;
};

const callWindows = new Map<number, CallWindow>();

function isAnyScreenControlled(): boolean {
  return callWindows
    .values()
    .some(({remoteControl}) => remoteControl.state.state === "controlled");
}

function updateStopControlShortcut(): void {
  const controlled = isAnyScreenControlled();
  if (controlled === globalShortcut.isRegistered(stopControlShortcut)) {
    return;
  }

  if (!controlled) {
    globalShortcut.unregister(stopControlShortcut);
  } else if (
    !globalShortcut.register(stopControlShortcut, () => {
      for (const {remoteControl} of callWindows.values()) {
        remoteControl.stop();
      }
    })
  ) {
    console.warn("Failed to register", stopControlShortcut);
  }
}

async function askConsent(
  window: BrowserWindow,
  participant: CallParticipant,
  signal: AbortSignal,
): Promise<boolean> {
  window.flashFrame(true);
  try {
    const {response} = await dialog.showMessageBox({
      type: "question",
      title: t.__("Remote control"),
      message: t.__("{{{name}}} wants to control your screen", {
        name: participant.name,
      }),
      detail: t.__(
        "They will be able to use your mouse and keyboard on the screen you share. You can take back control at any time with {{{shortcut}}}.",
        {shortcut: stopControlShortcut},
      ),
      buttons: [t.__("Allow"), t.__("Deny")],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      // Deny requests that the owner does not answer.
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    return response === 0;
  } finally {
    if (!window.isDestroyed()) {
      window.flashFrame(false);
    }
  }
}

function sharedDisplay(callWindow: CallWindow): Display {
  return (
    screen.getAllDisplays().find(({id}) => id === callWindow.sharedDisplayId) ??
    screen.getPrimaryDisplay()
  );
}

export function openCallWindow(url: URL): void {
  for (const callWindow of callWindows.values()) {
    if (callWindow.url === url.href) {
      callWindow.window.show();
      return;
    }
  }

  const window = new BrowserWindow({
    title: "Zulip",
    width: 1100,
    height: 720,
    minWidth: 500,
    minHeight: 400,
    webPreferences: {
      // The session of the server tabs, so that the user is logged in.
      partition: "persist:webviewsession",
      preload: path.join(bundlePath, "../preload/preload.cjs"),
    },
  });
  // The app menu acts on the main window.
  window.removeMenu();
  const {id} = window.webContents;
  const remoteInput = loadRemoteInput();
  const callWindow: CallWindow = {
    window,
    url: url.href,
    origin: url.origin,
    chosenScreen: undefined,
    sharedDisplayId: undefined,
    controllerInput: undefined,
    hideControlIndicator: undefined,
    remoteControl: new RemoteControl({
      askConsent: async (participant, signal) =>
        askConsent(window, participant, signal),
      controlStarted(controller) {
        callWindow.hideControlIndicator = showControlIndicator(
          sharedDisplay(callWindow),
          controller.name,
          stopControlShortcut,
          () => {
            callWindow.remoteControl.stop();
          },
        );
        updateStopControlShortcut();
      },
      controlEnded() {
        remoteInput?.releaseAll();
        callWindow.hideControlIndicator?.();
        callWindow.hideControlIndicator = undefined;
        updateStopControlShortcut();
      },
      stateChanged(state) {
        if (!window.isDestroyed()) {
          send(window.webContents, "remote-control-state", state);
        }
      },
      newToken: () => crypto.randomBytes(16).toString("hex"),
    }),
  };
  if (remoteInput !== undefined) {
    callWindow.controllerInput = new ControllerInput(
      callWindow.remoteControl,
      remoteInput,
      () => {
        const display = screen
          .getAllDisplays()
          .find((display) => display.id === callWindow.sharedDisplayId);
        return display === undefined
          ? undefined
          : screen.dipToScreenRect(null, display.bounds);
      },
    );
  }

  callWindows.set(id, callWindow);
  // Leaving the call page stops its screen share.
  window.webContents.on("did-navigate", () => {
    callWindow.remoteControl.shareStopped();
  });
  window.webContents.on("render-process-gone", () => {
    callWindow.remoteControl.shareStopped();
  });
  window.on("closed", () => {
    callWindow.remoteControl.shareStopped();
    callWindows.delete(id);
  });
  void window.loadURL(url.href);
}

// Returns the call window showing contents, as long as it is still on
// the server of its call.
export function getCallWindow(contents: WebContents): CallWindow | undefined {
  const callWindow = callWindows.get(contents.id);
  if (callWindow === undefined) {
    return undefined;
  }

  return URL.parse(contents.getURL())?.origin === callWindow.origin
    ? callWindow
    : undefined;
}

function findDisplay(source: DesktopCapturerSource): Display | undefined {
  return screen
    .getAllDisplays()
    .find(({id}) => String(id) === source.display_id);
}

function screenLabel(source: DesktopCapturerSource): string {
  const display = findDisplay(source);
  if (display === undefined) {
    return source.name;
  }

  const size = {
    width: String(Math.round(display.size.width * display.scaleFactor)),
    height: String(Math.round(display.size.height * display.scaleFactor)),
  };
  // On Windows, the lines after the first one of a button label are
  // shown as its description.
  return `${source.name}\n${
    display.id === screen.getPrimaryDisplay().id
      ? t.__("{{{width}}} × {{{height}}}, primary screen", size)
      : t.__("{{{width}}} × {{{height}}}", size)
  }`;
}

async function chooseScreen(
  callWindow: CallWindow,
): Promise<DesktopCapturerSource | undefined> {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {width: 0, height: 0},
  });
  const {response} = await dialog.showMessageBox(callWindow.window, {
    title: t.__("Share screen"),
    message: t.__("Choose a screen to share"),
    buttons: [...sources.map((source) => screenLabel(source)), t.__("Cancel")],
    cancelId: sources.length,
  });
  return sources[response];
}

export function handleCallPermissionRequest(
  callWindow: CallWindow,
  permission: string,
  requestingUrl: string,
  callback: (granted: boolean) => void,
): void {
  if (new URL(requestingUrl).origin !== callWindow.origin) {
    callback(false);
    return;
  }

  switch (permission) {
    case "media": {
      callback(true);
      break;
    }

    case "display-capture": {
      // The page asks for this permission whenever it shares a screen.
      // Like browsers, we grant it by letting the user choose a screen,
      // so that canceling rejects the request with NotAllowedError
      // rather than with the AbortError of handleDisplayMediaRequest.
      callWindow.chosenScreen = undefined;
      void chooseScreen(callWindow)
        .then((source) => {
          callWindow.chosenScreen = source;
          callback(source !== undefined);
        })
        .catch((error: unknown) => {
          console.error("Failed to choose a screen to share:", error);
          callback(false);
        });
      break;
    }

    default: {
      callback(false);
    }
  }
}

export function handleDisplayMediaRequest(
  request: DisplayMediaRequestHandlerHandlerRequest,
  callback: (streams: Streams | null) => void,
): void {
  const contents =
    request.frame === null ? undefined : webContents.fromFrame(request.frame);
  const callWindow =
    contents === undefined ? undefined : getCallWindow(contents);
  const source = callWindow?.chosenScreen;
  if (callWindow === undefined || source === undefined) {
    callback(null);
    return;
  }

  callWindow.chosenScreen = undefined;
  callWindow.sharedDisplayId = findDisplay(source)?.id;
  callback({video: source});
  callWindow.remoteControl.shareStarted();
}

export function requestRemoteControl(
  callWindow: CallWindow,
  participant: CallParticipant,
): void {
  // Whoever controls a screen could answer the consent dialog.
  if (isAnyScreenControlled()) {
    return;
  }

  void callWindow.remoteControl.request(participant);
}
