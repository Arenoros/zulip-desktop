// Electron app for test-remote-input.ts.  It drives its own window
// through zulip-remote-input and exits with status 0 if the window
// received exactly the click, wheel, and key events that were sent.

const {BrowserWindow, app, screen} = require("electron/main");

const remoteInput = require("zulip-remote-input");

const pageScript = `
  window.events = [];
  for (const type of ["mousedown", "mouseup", "wheel", "keydown", "keyup"]) {
    addEventListener(type, (event) => {
      events.push(
        type.startsWith("key")
          ? type + " " + event.code
          : type.startsWith("mouse")
            ? type + " " + event.button
            : type + " " + Math.sign(event.deltaY),
      );
    });
  }
`;

async function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function run() {
  const win = new BrowserWindow({
    width: 200,
    height: 200,
    alwaysOnTop: true,
    frame: false,
  });
  await win.loadURL("data:text/html,<body></body>");
  await win.webContents.executeJavaScript(pageScript);

  const bounds = win.getContentBounds();
  const target = screen.dipToScreenPoint({
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  });
  const start = remoteInput.getCursorPosition();
  try {
    if (!remoteInput.moveMouse(target.x, target.y)) {
      throw new Error("moveMouse failed");
    }

    const position = remoteInput.getCursorPosition();
    if (position.x !== target.x || position.y !== target.y) {
      throw new Error(
        `Cursor at ${JSON.stringify(position)}, expected ${JSON.stringify(target)}`,
      );
    }

    // Clicking activates the window, so that the key events reach it
    // too.  Chromium can drop a wheel event that arrives while a
    // frameless window is still being activated, so wait for that.
    remoteInput.setMouseButton("left", true);
    remoteInput.setMouseButton("left", false);
    await sleep(300);
    remoteInput.scrollWheel(0, -120);
    remoteInput.setKey(0x1e, true);
    remoteInput.setKey(0x1e, false);
    await sleep(1000);
  } finally {
    remoteInput.moveMouse(start.x, start.y);
  }

  const events = await win.webContents.executeJavaScript("window.events");
  const expected = [
    "mousedown 0",
    "mouseup 0",
    "wheel 1",
    "keydown KeyA",
    "keyup KeyA",
  ];
  if (JSON.stringify(events) !== JSON.stringify(expected)) {
    throw new Error(`Got events ${JSON.stringify(events)}`);
  }
}

app
  .whenReady()
  .then(run)
  .then(() => {
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
