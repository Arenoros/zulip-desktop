import {
  BrowserWindow,
  type DesktopCapturerSource,
  type Display,
  type DisplayMediaRequestHandlerHandlerRequest,
  type Streams,
  type WebContents,
  desktopCapturer,
  dialog,
  screen,
  webContents,
} from "electron/main";
import path from "node:path";

import {bundlePath} from "../common/paths.ts";
import {t} from "../common/translation-util.ts";

type CallWindow = {
  window: BrowserWindow;
  url: string;
  origin: string;
  // The screen the user chose to share, until the call page gets it.
  chosenScreen: DesktopCapturerSource | undefined;
  // The display the call page last got to share.  Only the main process
  // sets it, so that the call page cannot pick what is controlled.
  sharedDisplayId: number | undefined;
};

const callWindows = new Map<number, CallWindow>();

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
  callWindows.set(id, {
    window,
    url: url.href,
    origin: url.origin,
    chosenScreen: undefined,
    sharedDisplayId: undefined,
  });
  window.on("closed", () => {
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
}
