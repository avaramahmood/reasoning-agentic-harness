// Electron main process.
// Boots the Node control server (which spawns the bundled llama-server) and
// loads the built React UI. The control server + native binaries ship as
// extraResources; the renderer talks to them over 127.0.0.1:8081 / :8080.

const { app, BrowserWindow, shell } = require("electron");
const { fork } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

let controlProc = null;
let win = null;

function resourcesRoot() {
  // packaged: resources/ ; dev (electron .): project root
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");
}

function startControl() {
  const root = resourcesRoot();
  const controlScript = path.join(root, "server", "control.mjs");
  const nativeDir = path.join(root, "native", "linux");
  const llamaServer = path.join(nativeDir, "llama-server");
  const modelsDir = path.join(app.getPath("userData"), "models");
  fs.mkdirSync(modelsDir, { recursive: true });

  controlProc = fork(controlScript, [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1", // run the .mjs as plain Node, not a second window
      LLAMA_SERVER: llamaServer,
      LD_LIBRARY_PATH: nativeDir + (process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : ""),
      MODELS_DIR: modelsDir,
      NGL: process.env.NGL || "0", // CPU build by default; raise on a CUDA build
      CTX: process.env.CTX || "4096",
    },
    stdio: "inherit",
  });
  controlProc.on("exit", (code) => console.log(`[control] exited (${code})`));
}

function stopControl() {
  if (controlProc) {
    controlProc.kill("SIGINT"); // control.mjs stops llama-server on SIGINT/SIGTERM
    controlProc = null;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1140,
    height: 840,
    minWidth: 820,
    minHeight: 600,
    title: "Reasoning Agent",
    backgroundColor: "#000000",
    webPreferences: { contextIsolation: true },
  });
  if (win.removeMenu) win.removeMenu();
  win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  startControl();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopControl();
  if (process.platform !== "darwin") app.quit();
});
app.on("will-quit", stopControl);
