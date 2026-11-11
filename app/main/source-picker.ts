import {
  BrowserWindow,
  type DesktopCapturerSource,
  type Display,
  desktopCapturer,
  nativeTheme,
  screen,
} from "electron/main";
import path from "node:path";

import {html} from "../common/html.ts";
import {bundlePath} from "../common/paths.ts";
import {t} from "../common/translation-util.ts";

import {chosenSource, sourceKind, sourcesToOffer} from "./share-source.ts";

const thumbnailSize = {width: 320, height: 180};
// How often the previews of what is on each screen and window refresh.
const refreshInterval = 2000;

type PageSource = {
  id: string;
  kind: "screen" | "window";
  name: string;
  description: string;
  thumbnail: string | null;
  icon: string | null;
};

export function findDisplay(
  source: DesktopCapturerSource,
): Display | undefined {
  return screen
    .getAllDisplays()
    .find(({id}) => String(id) === source.display_id);
}

function screenDescription(source: DesktopCapturerSource): string {
  const display = findDisplay(source);
  if (display === undefined) {
    return "";
  }

  const size = {
    width: String(Math.round(display.size.width * display.scaleFactor)),
    height: String(Math.round(display.size.height * display.scaleFactor)),
  };
  return display.id === screen.getPrimaryDisplay().id
    ? t.__("{{{width}}} × {{{height}}}, primary screen", size)
    : t.__("{{{width}}} × {{{height}}}", size);
}

function pageSource(source: DesktopCapturerSource): PageSource {
  const kind = sourceKind(source.id);
  return {
    id: source.id,
    kind,
    name: source.name,
    description: kind === "screen" ? screenDescription(source) : "",
    thumbnail: source.thumbnail.isEmpty()
      ? null
      : `data:image/jpeg;base64,${source.thumbnail.toJPEG(80).toString("base64")}`,
    icon:
      source.appIcon === null || source.appIcon.isEmpty()
        ? null
        : source.appIcon.toDataURL(),
  };
}

function pickerPage(): string {
  return html`
    <!doctype html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <title>${t.__("Choose what to share")}</title>
        <style>
          :root {
            color-scheme: light dark;
            --accent: #5f5fe8;
            --muted: light-dark(#666, #aaa);
            --tile: light-dark(#f2f2f2, #2a2a2a);
            --preview: light-dark(#dcdcdc, #111);
            font-family: menu, sans-serif;
            font-size: 14px;
            color: light-dark(#222, #eee);
            background: light-dark(#fff, #1f1f1f);
          }
          body {
            display: flex;
            flex-direction: column;
            height: 100vh;
            margin: 0;
            user-select: none;
          }
          main {
            flex: 1;
            overflow-y: auto;
            padding: 16px 20px;
          }
          h1 {
            margin: 0 0 12px;
            font-size: 18px;
            font-weight: 600;
          }
          h2 {
            margin: 16px 0 8px;
            font-size: 14px;
            font-weight: 600;
            color: var(--muted);
          }
          section[hidden] {
            display: none;
          }
          .sources {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
            gap: 12px;
          }
          .source {
            display: flex;
            flex-direction: column;
            gap: 6px;
            min-width: 0;
            padding: 8px;
            border: 2px solid transparent;
            border-radius: 8px;
            font: inherit;
            color: inherit;
            text-align: left;
            background: var(--tile);
            cursor: pointer;
          }
          .source:focus-visible {
            outline: 2px solid var(--accent);
            outline-offset: 2px;
          }
          .source[aria-pressed="true"] {
            border-color: var(--accent);
          }
          .preview {
            display: flex;
            align-items: center;
            justify-content: center;
            aspect-ratio: 16 / 9;
            overflow: hidden;
            border-radius: 4px;
            background: var(--preview);
          }
          .preview img {
            max-width: 100%;
            max-height: 100%;
          }
          .label {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
          }
          .label img {
            flex-shrink: 0;
            width: 16px;
            height: 16px;
          }
          .name,
          .description {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .description {
            font-size: 12px;
            color: var(--muted);
          }
          footer {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            padding: 12px 20px;
            border-top: 1px solid light-dark(#ddd, #333);
          }
          footer button {
            padding: 6px 16px;
            border: 1px solid light-dark(#ccc, #444);
            border-radius: 4px;
            font: inherit;
            color: inherit;
            background: transparent;
            cursor: pointer;
          }
          footer button.primary {
            border-color: var(--accent);
            color: #fff;
            background: var(--accent);
          }
          footer button:disabled {
            cursor: default;
            opacity: 0.5;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>${t.__("Choose what to share")}</h1>
          <section data-kind="screen" hidden>
            <h2>${t.__("Screens")}</h2>
            <div class="sources"></div>
          </section>
          <section data-kind="window" hidden>
            <h2>${t.__("Windows")}</h2>
            <div class="sources"></div>
          </section>
        </main>
        <footer>
          <button type="button" class="cancel">${t.__("Cancel")}</button>
          <button type="button" class="primary share" disabled>
            ${t.__("Share")}
          </button>
        </footer>
        <script>
          const shareButton = document.querySelector(".share");
          const tiles = new Map();
          let selectedId;

          function select(id) {
            selectedId = id;
            for (const [tileId, tile] of tiles) {
              tile.setAttribute("aria-pressed", String(tileId === id));
            }
            shareButton.disabled = !tiles.has(id);
          }

          function share() {
            if (tiles.has(selectedId)) {
              window.zulipShareUi.send(selectedId);
            }
          }

          function newTile(source) {
            const tile = document.createElement("button");
            tile.type = "button";
            tile.className = "source";
            tile.dataset.id = source.id;
            tile.setAttribute("aria-pressed", "false");
            tile.innerHTML =
              '<div class="preview"></div><div class="label"><span class="name"></span></div><div class="description"></div>';
            tile.addEventListener("click", () => {
              select(source.id);
            });
            tile.addEventListener("dblclick", () => {
              select(source.id);
              share();
            });
            return tile;
          }

          function updateTile(tile, source) {
            const preview = tile.querySelector(".preview");
            if (source.thumbnail === null) {
              preview.replaceChildren();
            } else {
              const image =
                preview.querySelector("img") ?? document.createElement("img");
              image.alt = "";
              image.src = source.thumbnail;
              preview.replaceChildren(image);
            }
            const label = tile.querySelector(".label");
            const name = label.querySelector(".name");
            name.textContent = source.name;
            tile.title = source.name;
            label.querySelector("img")?.remove();
            if (source.icon !== null) {
              const icon = document.createElement("img");
              icon.alt = "";
              icon.src = source.icon;
              label.prepend(icon);
            }
            const description = tile.querySelector(".description");
            description.textContent = source.description;
            description.hidden = source.description === "";
          }

          // Called by the app with the current sources, screens first.
          function showSources(sources) {
            const focusedId = document.activeElement?.dataset.id;
            const ids = new Set(sources.map((source) => source.id));
            for (const [id, tile] of tiles) {
              if (!ids.has(id)) {
                tile.remove();
                tiles.delete(id);
              }
            }
            for (const section of document.querySelectorAll("section")) {
              const kindSources = sources.filter(
                (source) => source.kind === section.dataset.kind,
              );
              const list = section.querySelector(".sources");
              for (const source of kindSources) {
                const tile = tiles.get(source.id) ?? newTile(source);
                tiles.set(source.id, tile);
                updateTile(tile, source);
                list.append(tile);
              }
              section.hidden = kindSources.length === 0;
            }
            if (!tiles.has(selectedId)) {
              select(sources[0]?.id);
            }
            (tiles.get(focusedId ?? selectedId) ?? shareButton).focus();
          }

          document.querySelector(".cancel").addEventListener("click", () => {
            window.close();
          });
          shareButton.addEventListener("click", share);
          document.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
              window.close();
              return;
            }
            const order = [...document.querySelectorAll(".source")];
            const index = order.indexOf(document.activeElement);
            if (index === -1) {
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              select(order[index].dataset.id);
              share();
              return;
            }
            const step = {
              ArrowLeft: -1,
              ArrowUp: -1,
              ArrowRight: 1,
              ArrowDown: 1,
            }[event.key];
            if (step !== undefined) {
              event.preventDefault();
              const next = order[index + step];
              if (next !== undefined) {
                next.focus();
                next.click();
              }
            }
          });
        </script>
      </body>
    </html>
  `.html;
}

// Lets the user choose a screen or a window to share, in a window on
// top of parent, which does not offer itself, parent, or the excluded
// windows.  Resolves to undefined if the user cancels.
export async function chooseSource(
  parent: BrowserWindow,
  excludedWindows: readonly BrowserWindow[],
): Promise<DesktopCapturerSource | undefined> {
  const picker = new BrowserWindow({
    parent,
    modal: true,
    width: 860,
    height: 640,
    minWidth: 520,
    minHeight: 400,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: t.__("Choose what to share"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1f1f1f" : "#ffffff",
    webPreferences: {
      preload: path.join(bundlePath, "../preload/share-ui.cjs"),
    },
  });
  picker.removeMenu();
  const excludedIds = new Set(
    [picker, parent, ...excludedWindows].map((window) =>
      window.getMediaSourceId(),
    ),
  );
  let offered: DesktopCapturerSource[] = [];
  let chosen: DesktopCapturerSource | undefined;
  let refreshing = false;

  async function refresh(): Promise<void> {
    if (refreshing) {
      return;
    }

    refreshing = true;
    try {
      offered = sourcesToOffer(
        await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize,
          fetchWindowIcons: true,
        }),
        excludedIds,
      );
      if (!picker.isDestroyed()) {
        await picker.webContents.executeJavaScript(
          `showSources(${JSON.stringify(offered.map((source) => pageSource(source)))})`,
        );
      }
    } finally {
      refreshing = false;
    }
  }

  const timer = setInterval(() => {
    refresh().catch((error: unknown) => {
      console.error("Failed to refresh the sources to share:", error);
    });
  }, refreshInterval);
  picker.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  picker.webContents.ipc.on("share-ui", (_event, message: unknown) => {
    chosen = chosenSource(message, offered);
    if (chosen !== undefined) {
      picker.close();
    }
  });
  picker.once("ready-to-show", () => {
    picker.show();
  });

  return new Promise((resolve) => {
    picker.on("closed", () => {
      clearInterval(timer);
      resolve(chosen);
    });
    picker
      .loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(pickerPage())}`,
      )
      .then(refresh)
      .catch((error: unknown) => {
        console.error("Failed to show the sources to share:", error);
        picker.close();
      });
  });
}
