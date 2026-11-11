import {contextBridge} from "electron/renderer";

import {ipcRenderer} from "./typed-ipc-renderer.ts";

// Lets the source picker and the share panel tell the main process what
// the user chose.
contextBridge.exposeInMainWorld("zulipShareUi", {
  send(message: string): void {
    ipcRenderer.send("share-ui", message);
  },
});
