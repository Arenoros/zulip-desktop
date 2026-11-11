import {BrowserWindow, type Display} from "electron/main";
import path from "node:path";

import {html} from "../common/html.ts";
import {bundlePath} from "../common/paths.ts";
import {t} from "../common/translation-util.ts";

import {type SharePanelAction, sharePanelAction} from "./share-source.ts";

const width = 760;
const height = 48;

export type SharePanelState = {
  message: string;
  // Whether the call page handles the buttons that change and stop the
  // share; older call pages do not.
  shareButtons: boolean;
  stopControl: boolean;
};

function panelPage(stopShortcut: string): string {
  return html`
    <!doctype html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <title>${t.__("Screen sharing")}</title>
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
            gap: 8px;
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
            flex-shrink: 0;
            padding: 6px 12px;
            border: 0;
            border-radius: 4px;
            font: inherit;
            color: #fff;
            background: #3d3d3d;
            cursor: pointer;
          }
          button:hover {
            background: #4d4d4d;
          }
          button.stop {
            background: #c62a2a;
          }
          button.stop:hover {
            background: #d63b3b;
          }
          button[hidden] {
            display: none;
          }
        </style>
      </head>
      <body>
        <span class="message"></span>
        <button type="button" data-action="change-source" hidden>
          ${t.__("Change source")}
        </button>
        <button
          type="button"
          class="stop"
          data-action="stop-control"
          title="${t.__("Stop control ({{{shortcut}}})", {
            shortcut: stopShortcut,
          })}"
          hidden
        >
          ${t.__("Stop control")}
        </button>
        <button type="button" class="stop" data-action="stop-sharing" hidden>
          ${t.__("Stop sharing")}
        </button>
        <script>
          for (const button of document.querySelectorAll("button")) {
            button.addEventListener("click", () => {
              window.zulipShareUi.send(button.dataset.action);
            });
          }

          // Called by the app whenever what the panel shows changes.
          function render(state) {
            document.querySelector(".message").textContent = state.message;
            document.querySelector(".message").title = state.message;
            for (const action of ["change-source", "stop-sharing"]) {
              document.querySelector('[data-action="' + action + '"]').hidden =
                !state.shareButtons;
            }
            document.querySelector('[data-action="stop-control"]').hidden =
              !state.stopControl;
          }
        </script>
      </body>
    </html>
  `.html;
}

// Shows the owner of a screen share, on top of everything and outside
// of what is shared, what they share or who controls it, with buttons
// to change or stop the share and to stop control.
export class SharePanel {
  private readonly loaded: Promise<void>;
  private readonly onAction: (action: SharePanelAction) => void;
  readonly window: BrowserWindow;

  constructor(
    stopShortcut: string,
    onAction: (action: SharePanelAction) => void,
  ) {
    this.onAction = onAction;
    this.window = new BrowserWindow({
      width,
      height,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      closable: false,
      skipTaskbar: true,
      // Clicking the panel should not take the focus away from what
      // is shared or from whoever controls it.
      focusable: false,
      alwaysOnTop: true,
      show: false,
      backgroundColor: "#1f1f1f",
      webPreferences: {
        preload: path.join(bundlePath, "../preload/share-ui.cjs"),
      },
    });
    this.window.setAlwaysOnTop(true, "screen-saver");
    this.window.setContentProtection(true);
    this.window.removeMenu();
    this.window.webContents.on("will-navigate", (event) => {
      event.preventDefault();
    });
    this.window.webContents.ipc.on("share-ui", (_event, message: unknown) => {
      const action = sharePanelAction(message);
      if (action !== undefined) {
        this.onAction(action);
      }
    });
    this.loaded = this.window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(panelPage(stopShortcut))}`,
    );
  }

  // Shows the panel at the top of display.
  show(display: Display, state: SharePanelState): void {
    this.window.setBounds({
      x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
      y: display.workArea.y + 8,
      width,
      height,
    });
    void this.loaded
      .then(async () => {
        if (this.window.isDestroyed()) {
          return;
        }

        await this.window.webContents.executeJavaScript(
          `render(${JSON.stringify(state)})`,
        );
        this.window.showInactive();
      })
      .catch((error: unknown) => {
        console.error("Failed to show the share panel:", error);
      });
  }

  close(): void {
    if (!this.window.isDestroyed()) {
      this.window.destroy();
    }
  }
}
