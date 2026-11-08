import {BrowserWindow, type Display} from "electron/main";

import {html} from "../common/html.ts";
import {t} from "../common/translation-util.ts";

const width = 520;
const height = 48;

// Shows the owner of a screen, on top of everything on that screen,
// who controls it, with a button to stop them.  Returns a function that
// hides it again; closing it by any other means calls onStop.
export function showControlIndicator(
  display: Display,
  controllerName: string,
  stopShortcut: string,
  onStop: () => void,
): () => void {
  const indicator = new BrowserWindow({
    x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
    y: display.workArea.y + 8,
    width,
    height,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Clicking the indicator should not take the focus away from what
    // the controller is doing.
    focusable: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#1f1f1f",
  });
  indicator.setAlwaysOnTop(true, "screen-saver");
  indicator.removeMenu();
  indicator.on("closed", onStop);
  indicator.once("ready-to-show", () => {
    indicator.showInactive();
  });

  const page = html`
    <!doctype html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <title>${t.__("Remote control")}</title>
        <style>
          html {
            height: 100%;
            font-family: menu, sans-serif;
            font-size: 14px;
            color: #fff;
            background: #1f1f1f;
            user-select: none;
          }
          body {
            display: flex;
            align-items: center;
            gap: 12px;
            height: 100%;
            margin: 0;
            padding: 0 8px 0 16px;
            box-sizing: border-box;
          }
          .message {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            app-region: drag;
          }
          button {
            padding: 6px 12px;
            border: 0;
            border-radius: 4px;
            font: inherit;
            color: #fff;
            background: #c62a2a;
            cursor: pointer;
          }
        </style>
      </head>
      <body>
        <span class="message"
          >${t.__("{{{name}}} is controlling your screen", {
            name: controllerName,
          })}</span
        >
        <button
          type="button"
          title="${t.__("Stop control ({{{shortcut}}})", {
            shortcut: stopShortcut,
          })}"
        >
          ${t.__("Stop control")}
        </button>
        <script>
          document.querySelector("button").addEventListener("click", () => {
            window.close();
          });
        </script>
      </body>
    </html>
  `.html;
  void indicator.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(page)}`,
  );

  return () => {
    indicator.off("closed", onStop);
    if (!indicator.isDestroyed()) {
      indicator.close();
    }
  };
}
