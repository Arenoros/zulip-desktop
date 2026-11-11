import {
  BrowserWindow,
  type DesktopCapturerSource,
  type Display,
  type DisplayMediaRequestHandlerHandlerRequest,
  type Event,
  type Streams,
  type WebContents,
  dialog,
  globalShortcut,
  powerMonitor,
  screen,
  webContents,
} from "electron/main";
import crypto from "node:crypto";
import path from "node:path";

import {bundlePath} from "../common/paths.ts";
import {t} from "../common/translation-util.ts";
import type {CallParticipant} from "../common/types.ts";

import {ControllerInput} from "./controller-input.ts";
import {RemoteControl} from "./remote-control.ts";
import {loadRemoteInput} from "./remote-input.ts";
import {SharePanel} from "./share-panel.ts";
import {
  type SharePanelAction,
  type SourceKind,
  sourceKind,
} from "./share-source.ts";
import {chooseSource, findDisplay} from "./source-picker.ts";
import {send} from "./typed-ipc-main.ts";

const stopControlShortcut = "Ctrl+Alt+Shift+S";

type CallWindow = {
  window: BrowserWindow;
  url: string;
  origin: string;
  // The source the user chose to share, until the call page gets it.
  chosenSource: DesktopCapturerSource | undefined;
  // A source the user chose from the share panel, which the call page
  // is asked to share instead of the current one.
  replacementSource: DesktopCapturerSource | undefined;
  choosingSource: boolean;
  // What the call page last got to share, and the display if it is a
  // screen.  Only the main process sets them, so that the call page
  // cannot pick what is controlled.
  sharedSource: {kind: SourceKind; name: string} | undefined;
  sharedDisplayId: number | undefined;
  // Whether the call page handles the buttons of the share panel.
  sharePanelSupported: boolean;
  sharePanel: SharePanel | undefined;
  remoteControl: RemoteControl;
  controllerInput: ControllerInput | undefined;
  stopWatchingCallPage: (() => void) | undefined;
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

// Calls onHang if the page stops responding.  Remote input only reaches
// the app through the call page, so a hung page could not release the
// keys and buttons it holds.
function watchCallPage(contents: WebContents, onHang: () => void): () => void {
  let answered = true;
  const timer = setInterval(() => {
    if (!answered) {
      onHang();
      return;
    }

    answered = false;
    void contents
      .executeJavaScript("0")
      .then(() => {
        answered = true;
      })
      .catch(() => undefined);
  }, 2500);
  return () => {
    clearInterval(timer);
  };
}

function sharePanelDisplay(callWindow: CallWindow): Display {
  // Electron cannot tell where a shared window is, so the panel goes
  // where the call window is.
  return (
    screen.getAllDisplays().find(({id}) => id === callWindow.sharedDisplayId) ??
    screen.getDisplayMatching(callWindow.window.getBounds())
  );
}

function updateSharePanel(callWindow: CallWindow): void {
  const {state} = callWindow.remoteControl;
  const {sharedSource} = callWindow;
  if (
    sharedSource === undefined ||
    state.state === "none" ||
    callWindow.window.isDestroyed()
  ) {
    callWindow.sharePanel?.close();
    callWindow.sharePanel = undefined;
    return;
  }

  callWindow.sharePanel ??= new SharePanel(stopControlShortcut, (action) => {
    handleSharePanelAction(callWindow, action);
  });
  callWindow.sharePanel.show(sharePanelDisplay(callWindow), {
    message:
      state.state === "controlled"
        ? t.__("{{{name}}} is controlling your screen", {
            name: state.participant.name,
          })
        : t.__("You are sharing {{{source}}}", {source: sharedSource.name}),
    shareButtons: callWindow.sharePanelSupported,
    stopControl: state.state === "controlled",
  });
}

async function chooseSourceToShare(
  callWindow: CallWindow,
): Promise<DesktopCapturerSource | undefined> {
  if (callWindow.choosingSource) {
    return undefined;
  }

  callWindow.choosingSource = true;
  try {
    return await chooseSource(
      callWindow.window,
      callWindow.sharePanel === undefined ? [] : [callWindow.sharePanel.window],
    );
  } finally {
    callWindow.choosingSource = false;
  }
}

async function changeSource(callWindow: CallWindow): Promise<void> {
  const source = await chooseSourceToShare(callWindow);
  // Canceling, or stopping the share meanwhile, keeps things as they are.
  if (
    source === undefined ||
    callWindow.remoteControl.state.state === "none" ||
    callWindow.window.isDestroyed()
  ) {
    return;
  }

  callWindow.replacementSource = source;
  send(callWindow.window.webContents, "screen-share-change-source");
}

function handleSharePanelAction(
  callWindow: CallWindow,
  action: SharePanelAction,
): void {
  switch (action) {
    case "change-source": {
      void changeSource(callWindow).catch((error: unknown) => {
        console.error("Failed to change the shared source:", error);
      });
      break;
    }

    case "stop-sharing": {
      send(callWindow.window.webContents, "screen-share-stop");
      break;
    }

    case "stop-control": {
      callWindow.remoteControl.stop();
      break;
    }
  }
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
    chosenSource: undefined,
    replacementSource: undefined,
    choosingSource: false,
    sharedSource: undefined,
    sharedDisplayId: undefined,
    sharePanelSupported: false,
    sharePanel: undefined,
    controllerInput: undefined,
    stopWatchingCallPage: undefined,
    remoteControl: new RemoteControl({
      askConsent: async (participant, signal) =>
        askConsent(window, participant, signal),
      controlStarted() {
        callWindow.stopWatchingCallPage = watchCallPage(
          window.webContents,
          () => {
            callWindow.remoteControl.stop();
          },
        );
        updateStopControlShortcut();
      },
      controlEnded() {
        callWindow.stopWatchingCallPage?.();
        callWindow.stopWatchingCallPage = undefined;
        remoteInput?.releaseAll();
        updateStopControlShortcut();
      },
      stateChanged(state) {
        if (state.state === "none") {
          callWindow.replacementSource = undefined;
          callWindow.sharedSource = undefined;
        }

        updateSharePanel(callWindow);
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

  const stopControlOnRemovedDisplay = (
    _event: Event,
    display: Display,
  ): void => {
    if (display.id === callWindow.sharedDisplayId) {
      callWindow.remoteControl.stop();
    }
  };

  const stopControl = (): void => {
    callWindow.remoteControl.stop();
  };

  screen.on("display-removed", stopControlOnRemovedDisplay);
  powerMonitor.on("lock-screen", stopControl);
  callWindows.set(id, callWindow);
  // Leaving the call page stops its screen share.
  window.webContents.on("did-navigate", () => {
    callWindow.remoteControl.shareStopped();
  });
  window.webContents.on("render-process-gone", () => {
    callWindow.remoteControl.shareStopped();
  });
  window.on("closed", () => {
    callWindow.sharePanel?.close();
    callWindow.sharePanel = undefined;
    screen.off("display-removed", stopControlOnRemovedDisplay);
    powerMonitor.off("lock-screen", stopControl);
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
      // Like browsers, we grant it by letting the user choose a source,
      // so that canceling rejects the request with NotAllowedError
      // rather than with the AbortError of handleDisplayMediaRequest.
      // A source chosen from the share panel was chosen already.
      callWindow.chosenSource = callWindow.replacementSource;
      callWindow.replacementSource = undefined;
      if (callWindow.chosenSource !== undefined) {
        callback(true);
        break;
      }

      void chooseSourceToShare(callWindow)
        .then((source) => {
          callWindow.chosenSource = source;
          callback(source !== undefined);
        })
        .catch((error: unknown) => {
          console.error("Failed to choose a source to share:", error);
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
  const source = callWindow?.chosenSource;
  if (callWindow === undefined || source === undefined) {
    callback(null);
    return;
  }

  callWindow.chosenSource = undefined;
  const kind = sourceKind(source.id);
  callWindow.sharedSource = {kind, name: source.name};
  callWindow.sharedDisplayId =
    kind === "screen" ? findDisplay(source)?.id : undefined;
  callback({video: source});
  // Sharing another source ends the control of the previous one.
  callWindow.remoteControl.shareStarted();
}

// Call pages that ask what kind of source they got to share also handle
// the buttons of the share panel.
export function getSharedSourceKind(callWindow: CallWindow): SourceKind | null {
  if (!callWindow.sharePanelSupported) {
    callWindow.sharePanelSupported = true;
    updateSharePanel(callWindow);
  }

  return callWindow.sharedSource?.kind ?? null;
}

export function requestRemoteControl(
  callWindow: CallWindow,
  participant: CallParticipant,
): void {
  // Whoever controls a screen could answer the consent dialog, and only
  // a shared screen, not a window, can be controlled.
  if (isAnyScreenControlled() || callWindow.sharedDisplayId === undefined) {
    return;
  }

  void callWindow.remoteControl.request(participant);
}
