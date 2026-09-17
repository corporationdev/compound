/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cloudConfig, authRequest, mediaRequest, uploadMedia, uploadCatalogAudio, readCatalogAudio, readCatalogArtwork } from './cloud';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, nativeImage, session, shell } from "electron";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { tempPathFor } from "./atomic";
import { DapiServer } from "./dapi/server";
import { cliStatus, installCli, uninstallCli } from "./cli-install";
import { mcpStatus, registerMcp } from "./mcp-install";
import { enableHeadless, isHeadless } from "./headless";
import { setupAppMenu } from "./menu";
import { prepareUserData } from "./brand-migration";
import { ChatServer } from "./chat-server";
import { mainBridge } from "./main-manager";
import { MAIN_CHANNELS } from "./main-channels";
import {
  compileProject,
  createProject,
  defaultRoot,
  deleteProject,
  duplicateProject,
  getProject,
  initProject,
  pickFolder,
  pickRoot,
  renameProject,
  resolveProject,
  unwatchAll,
  listEntries,
  realPathEntry,
  noteContent,
  noteRenamed,
  readConfig,
  readManifest,
  removeEntry,
  statEntry,
  unwatchProject,
  watchProject,
  writeConfig,
  writeManifest,
  writeProject,
} from "./projects";
import { syncManager } from "./sync/manager";
import {
  createWorkspaceEntry,
  findProjects,
  listWorkspace,
  openWorkspace,
  readWorkspaceFile,
  removeWorkspaceEntry,
  renameWorkspaceEntry,
  unwatchAllWorkspaces,
  unwatchWorkspace,
  watchWorkspace,
  writeWorkspaceFile,
} from "./workspace";
import { AssetTransferManager, realAssetCloud } from "./assets-transfers";
import type { LogEntry } from "@compound/dapi";

// The dev launcher names the stage's Vite server; a bare `electron-forge start` keeps the default.
const DEV_URL = process.env.COMPOUND_DEV_URL || "http://localhost:5173";
const MACOS_CORNER_RADIUS = 18;
const MACOS_BACKDROP = { blur: 80, red: 0.07, green: 0.07, blue: 0.07, alpha: 0.9 };

app.setName("Compound");
const customUserData = app.commandLine.getSwitchValue("user-data-dir");
app.setPath("userData", customUserData || prepareUserData(app.getPath("appData")));
app.commandLine.appendSwitch("enable-blink-features", "CanvasDrawElement");
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

let setNativeCornerRadius: ((handle: Buffer, radius: number) => void) | null = null;
let setNativeBackdrop:
  | ((handle: Buffer, blur: number, r: number, g: number, b: number, a: number) => void)
  | null = null;

if (process.platform === "darwin") {
  ({ setCornerRadius: setNativeCornerRadius, setBackdrop: setNativeBackdrop } = require(
    join(app.getAppPath(), "dist", "corner_radius.node"),
  ));
}

function applyCornerRadius(radius: number) {
  if (!setNativeCornerRadius || !mainWindow || mainWindow.isDestroyed()) return;
  setNativeCornerRadius(mainWindow.getNativeWindowHandle(), radius);
}

function applyBackdrop() {
  if (!setNativeBackdrop || !mainWindow || mainWindow.isDestroyed()) return;
  const { blur, red, green, blue, alpha } = MACOS_BACKDROP;
  setNativeBackdrop(mainWindow.getNativeWindowHandle(), blur, red, green, blue, alpha);
}


const openWrites = new Map<string, { handle: FileHandle; path: string; temp: string; reserved: boolean }>();

let mainWindow: BrowserWindow | null = null;
let assetsWindow: BrowserWindow | null = null;
// Every project's asset uploads and downloads; state goes to the window as events.
const assetTransfers = new AssetTransferManager({
  cloud: realAssetCloud,
  feed: (organizationId, onSnapshot, onError) => syncManager.subscribeAssets(organizationId, onSnapshot, onError),
  getToken: () => syncManager.token(),
  onChange: (snapshot) => {
    if (!assetsWindow || assetsWindow.isDestroyed()) return;
    mainBridge.emit(assetsWindow, MAIN_CHANNELS.CLOUD_ASSETS_STATE, snapshot);
  },
});


// Renderer console mirror, served to the CLI via LOGS_GET. Lives in main so
// it survives reloads and captures everything the devtools console shows
// (page logs, worker logs, uncaught errors) without touching the web bundle.
const LOG_BUFFER_MAX = 2000;
const logBuffer: LogEntry[] = [];

// The docs the MCP instructions point agents at: staged into the bundle by
// scripts/stage-docs.mjs (Contents/Resources/docs) when packaged; the repo's
// own `docs/` in development, so edits show up without a staging step. Null
// when neither exists.
function docsDir(): string | null {
  const dir = app.isPackaged ? join(process.resourcesPath, "docs") : join(app.getAppPath(), "..", "..", "docs");
  return existsSync(dir) ? dir : null;
}

// The MCP server agents and the dapi CLI talk to. Started once the app is
// ready; the first connection switches the app into headless mode.
const dapi = new DapiServer({
  version: app.getVersion(),
  logs: () => logBuffer,
  docsDir: docsDir(),
  onFirstConnection: enableHeadless,
});

function pushLog(level: LogEntry["level"], message: string, source: string) {
  logBuffer.push({ ts: Date.now(), level, message, source });
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
}

function captureConsole(window: BrowserWindow) {
  window.webContents.on("console-message", ({ level, message, lineNumber, sourceId }) => {
    pushLog(level, message, sourceId ? `${sourceId}:${lineNumber}` : "");
  });
  window.webContents.on("preload-error", (_event, path, error) => {
    pushLog("error", `Preload error: ${error.message}`, path);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    pushLog("error", `Renderer process gone: ${details.reason} (exit code ${details.exitCode})`, "");
  });
}


function isHiddenLaunch(argv: string[]): boolean {
  return argv.includes("--hidden");
}

async function setFileInputFiles(selector: string, absolutePath: string) {
  if (!mainWindow) throw new Error("No main window");
  const wc = mainWindow.webContents;
  // Stay attached between calls — attach/detach dominates the cost of a
  // transfer, and file materialization happens in bursts.
  if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
  const { root } = await wc.debugger.sendCommand("DOM.getDocument");
  const { nodeId } = await wc.debugger.sendCommand("DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
  if (!nodeId) throw new Error(`Selector not found: ${selector}`);
  await wc.debugger.sendCommand("DOM.setFileInputFiles", {
    files: [absolutePath],
    nodeId,
  });
}

function createWindow(show = true) {
  mainWindow = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    ...(process.platform === "darwin"
      ? { vibrancy: "sidebar" as const, backgroundColor: "#00000000" }
      : { backgroundColor: "#1c1c1c" }),
    webPreferences: {
      preload: join(app.getAppPath(), "dist", "preload.js"),
    },
  });

  captureConsole(mainWindow);
  syncManager.attach(mainWindow);
  assetsWindow = mainWindow;

  applyCornerRadius(MACOS_CORNER_RADIUS);
  applyBackdrop();

  mainWindow.once("ready-to-show", () => {
    applyCornerRadius(MACOS_CORNER_RADIUS);
    applyBackdrop();

    if (show) {
      mainWindow?.show();
    }
  });

  mainWindow.on("show", () => {
    applyCornerRadius(MACOS_CORNER_RADIUS);
    applyBackdrop();
  });

  mainWindow.on("enter-full-screen", () => {
    applyCornerRadius(0);
    mainBridge.emit(mainWindow, MAIN_CHANNELS.WINDOW_FULLSCREEN_CHANGE, { fullscreen: true });
  });
  mainWindow.on("leave-full-screen", () => {
    applyCornerRadius(MACOS_CORNER_RADIUS);
    mainBridge.emit(mainWindow, MAIN_CHANNELS.WINDOW_FULLSCREEN_CHANGE, { fullscreen: false });
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (!app.isPackaged) {
    mainWindow.loadURL(DEV_URL);
  } else {
    mainWindow.loadFile(join(app.getAppPath(), "web", "index.html"));
  }
}


if (app.requestSingleInstanceLock()) {
  app.on("second-instance", (_event, argv) => {

    const hidden = isHiddenLaunch(argv);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (hidden) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow(!hidden);
    }
  });


  mainBridge.handle(MAIN_CHANNELS.APP_OPEN_EXTERNAL, ({ url }) => shell.openExternal(url));
  mainBridge.handle(MAIN_CHANNELS.APP_SHOW_IN_FOLDER, ({ path }) => shell.showItemInFolder(path));
  const trustedRenderer = (event: import('electron').IpcMainEvent) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Untrusted renderer');
    const url = new URL(event.senderFrame.url);
    const trusted = app.isPackaged ? url.protocol === 'file:' && url.pathname === new URL(pathToFileURL(join(app.getAppPath(), 'web', 'index.html')).href).pathname : url.origin === DEV_URL;
    if (!trusted) throw new Error('Untrusted renderer origin');
  };
  const chat = new ChatServer({
    runtimeDir: app.isPackaged ? join(process.resourcesPath, 'chat-runtime') : join(app.getAppPath(), 'chat-runtime'),
    dataDir: join(app.getPath('userData'), 'chat'),
    mcpUrl: dapi.url,
    // Codex reads only its user config, so the server is registered there the
    // first time a chat runs it. Claude Code reads the project's `.mcp.json`.
    registerProvider: async (provider) => { if (provider === 'codex') registerMcp('codex'); },
    validateProject: async (input) => {
      const project = await getProject(input.dir);
      if (!project || project.id !== input.id) throw new Error('Project directory no longer matches this chat. Reopen the project.');
      return { id: project.id, name: project.displayName, dir: project.dir };
    },
    changed: state => mainBridge.emit(mainWindow, MAIN_CHANNELS.CHAT_STATE, state),
  });
  mainBridge.handle(MAIN_CHANNELS.CHAT_REQUEST, (data, event) => { trustedRenderer(event); return chat.request(data); });
  void app.whenReady().then(() => chat.start());
  mainBridge.handle(MAIN_CHANNELS.CLOUD_CONFIG, (_data, event) => { trustedRenderer(event); return cloudConfig(); });
  mainBridge.handle(MAIN_CHANNELS.CLOUD_AUTH, (data, event) => { trustedRenderer(event); return authRequest(data.operation, data.body, data.sessionToken); });
  mainBridge.handle(MAIN_CHANNELS.CLOUD_MEDIA, (data, event) => { trustedRenderer(event); return mediaRequest(data.path, data.body, data.token); });
  mainBridge.handle(MAIN_CHANNELS.CLOUD_UPLOAD, (data, event) => { trustedRenderer(event); return uploadMedia(data.contentType, data.bytes, data.token); });
  mainBridge.handle(MAIN_CHANNELS.CLOUD_CATALOG_UPLOAD, (data, event) => { trustedRenderer(event); return uploadCatalogAudio(data); });
  mainBridge.handle(MAIN_CHANNELS.CLOUD_CATALOG_FILE, (data, event) => { trustedRenderer(event); return readCatalogAudio(data.sourceId, data.token); });
  mainBridge.handle(MAIN_CHANNELS.CLOUD_CATALOG_ARTWORK, (data, event) => { trustedRenderer(event); return readCatalogArtwork(data.sourceId, data.token); });
  mainBridge.handle(MAIN_CHANNELS.WINDOW_IS_FULLSCREEN, () => mainWindow?.isFullScreen() ?? false);
  mainBridge.handle(MAIN_CHANNELS.WINDOW_CAPTURE, async () => {
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error("No main window");
    const image = await mainWindow.webContents.capturePage(undefined, { stayHidden: true });
    const { width, height } = image.getSize();
    const png = image.toPNG();
    // A plain Uint8Array over the PNG, so the renderer sees bytes and not a Buffer.
    return { png: new Uint8Array(png.buffer, png.byteOffset, png.byteLength), width, height };
  });
  mainBridge.handle(MAIN_CHANNELS.LOGS_GET, () => logBuffer);
  mainBridge.handle(MAIN_CHANNELS.HEADLESS_GET_MODE, () => isHeadless());
  mainBridge.handle(MAIN_CHANNELS.MCP_STATUS, () => mcpStatus());
  mainBridge.handle(MAIN_CHANNELS.CLI_STATUS, () => cliStatus());
  mainBridge.handle(MAIN_CHANNELS.CLI_INSTALL, () => installCli());
  mainBridge.handle(MAIN_CHANNELS.CLI_UNINSTALL, () => uninstallCli());
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_PICK_ROOT, () => pickRoot(mainWindow));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_PICK_FOLDER, () => pickFolder(mainWindow));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_DEFAULT_ROOT, () => defaultRoot(mainWindow));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_GET, ({ dir }) => getProject(dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_INIT, ({ dir }) => initProject(mainWindow, dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_RESOLVE, ({ dir }) => resolveProject(dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_CREATE, ({ root, displayName }) =>
    createProject(root, displayName),
  );
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_RENAME, ({ dir, displayName }) => renameProject(dir, displayName));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_DUPLICATE, ({ dir }) => duplicateProject(dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_DELETE, ({ dir }) => deleteProject(dir).then(id => chat.forgetProject(id)));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_COMPILE, ({ dir }) => compileProject(dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_WRITE, ({ dir, edits }) => writeProject(dir, edits));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_WATCH, ({ dir }, event) =>
    watchProject(BrowserWindow.fromWebContents(event.sender), dir),
  );
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_UNWATCH, ({ dir }) => unwatchProject(dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_MANIFEST_READ, ({ dir }) => readManifest(dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_MANIFEST_WRITE, ({ dir, manifest }) => writeManifest(dir, manifest));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_CONFIG_READ, ({ dir }) => readConfig(dir));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_CONFIG_WRITE, ({ dir, config }) => writeConfig(dir, config));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_FS_LIST, ({ dir, source }) => listEntries(dir, source));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_FS_STAT, ({ dir, source }) => statEntry(dir, source));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_FS_REMOVE, ({ dir, path }) => removeEntry(dir, path));
  mainBridge.handle(MAIN_CHANNELS.PROJECTS_FS_REAL_PATH, ({ dir, source }) => realPathEntry(dir, source));
  mainBridge.handle(MAIN_CHANNELS.CLOUD_ASSETS_ATTACH, (data, event) => { trustedRenderer(event); return assetTransfers.attach(data); });
  mainBridge.handle(MAIN_CHANNELS.CLOUD_ASSETS_UPDATE, ({ dir, local, eagerOriginals }, event) => { trustedRenderer(event); assetTransfers.update(dir, local, eagerOriginals); });
  mainBridge.handle(MAIN_CHANNELS.CLOUD_ASSETS_DETACH, ({ dir }) => assetTransfers.detach(dir));
  mainBridge.handle(MAIN_CHANNELS.CLOUD_ASSETS_RETRY, ({ dir, sampleId }, event) => { trustedRenderer(event); assetTransfers.retry(dir, sampleId); });
  mainBridge.handle(MAIN_CHANNELS.CLOUD_ASSET_FETCH, ({ dir, sampleId, prefer }, event) => { trustedRenderer(event); return assetTransfers.fetch(dir, sampleId, prefer); });
  mainBridge.handle(MAIN_CHANNELS.SYNC_START, (data, event) => { trustedRenderer(event); return syncManager.start(data); });
  mainBridge.handle(MAIN_CHANNELS.SYNC_STOP, ({ dir }) => syncManager.stop(dir));
  mainBridge.handle(MAIN_CHANNELS.SYNC_STATUS_GET, ({ dir }) => syncManager.status(dir));
  mainBridge.handle(MAIN_CHANNELS.SYNC_SESSION, ({ sessionToken }, event) => { trustedRenderer(event); return syncManager.setSession(sessionToken); });
  // The workspace channels act on the disk under a folder the renderer names;
  // only the app's own page may, and only for a folder `openWorkspace` gave out.
  mainBridge.handle(MAIN_CHANNELS.WORKSPACE_OPEN, (data, event) => { trustedRenderer(event); return openWorkspace(data); });
  mainBridge.handle(MAIN_CHANNELS.WORKSPACE_LIST, ({ dir }, event) => { trustedRenderer(event); return listWorkspace(dir, syncManager.projectRoots(dir)); });
  mainBridge.handle(MAIN_CHANNELS.WORKSPACE_PROJECTS, ({ dir }, event) => { trustedRenderer(event); return findProjects(dir); });
  mainBridge.handle(MAIN_CHANNELS.WORKSPACE_READ, ({ dir, path }, event) => { trustedRenderer(event); return readWorkspaceFile(dir, path); });
  mainBridge.handle(MAIN_CHANNELS.WORKSPACE_WRITE, ({ dir, path, text, base }, event) => { trustedRenderer(event); return writeWorkspaceFile(dir, path, text, base); });
  mainBridge.handle(MAIN_CHANNELS.WORKSPACE_CREATE, ({ dir, path, kind }, event) => { trustedRenderer(event); return createWorkspaceEntry(dir, path, kind); });
  mainBridge.handle(MAIN_CHANNELS.WORKSPACE_RENAME, ({ dir, from, to }, event) => { trustedRenderer(event); return renameWorkspaceEntry(dir, from, to); });
  mainBridge.handle(MAIN_CHANNELS.WORKSPACE_REMOVE, ({ dir, path }, event) => { trustedRenderer(event); return removeWorkspaceEntry(dir, path); });
  mainBridge.handle(MAIN_CHANNELS.WORKSPACE_WATCH, ({ dir }, event) => {
    trustedRenderer(event);
    watchWorkspace(BrowserWindow.fromWebContents(event.sender), dir);
  });
  mainBridge.handle(MAIN_CHANNELS.WORKSPACE_UNWATCH, ({ dir }, event) => { trustedRenderer(event); unwatchWorkspace(dir); });
  mainBridge.handle(MAIN_CHANNELS.FILE_TRANSFER, ({ selector, absolutePath }) =>
    setFileInputFiles(selector, absolutePath),
  );

  mainBridge.handle(MAIN_CHANNELS.FILE_WRITE_OPEN, async ({ path, exclusive }) => {
    await mkdir(dirname(path), { recursive: true });

    // `exclusive` means the name must be free, so it is taken now rather than
    // at the rename below — the empty file that reserves it is renamed over
    // when the write finishes, and removed when it is abandoned.
    if (exclusive) {
      noteContent(path, "");
      await (await open(path, "wx")).close();
    }

    // The bytes go to a temp file beside the destination and are renamed into
    // place once they are whole. Nothing ever sees half an asset — not the
    // watcher, not a scan of the library, not an import — so there is no
    // window anyone has to be kept out of.
    const temp = tempPathFor(path);
    const handle = await open(temp, "wx");
    const id = randomUUID();
    openWrites.set(id, { handle, path, temp, reserved: exclusive === true });
    return { id };
  });

  mainBridge.handle(MAIN_CHANNELS.FILE_WRITE_CHUNK, async ({ id, data, position }) => {
    const entry = openWrites.get(id);
    if (!entry) throw new Error(`No open file for write id ${id}`);
    await entry.handle.write(data, 0, data.byteLength, position);
  });

  mainBridge.handle(MAIN_CHANNELS.FILE_WRITE_CLOSE, async ({ id }) => {
    const entry = openWrites.get(id);
    if (!entry) return;
    openWrites.delete(id);
    try {
      await entry.handle.close();
      // Claimed before the rename, which is the first and only moment the
      // destination changes (see `noteRenamed`).
      await noteRenamed(entry.temp, entry.path);
      await rename(entry.temp, entry.path);
    } catch (error) {
      await unlink(entry.temp).catch(() => { });
      throw error;
    }
  });

  // Abort: close the fd and drop the temp file (cancel / error cleanup). The
  // destination is left alone — an abandoned write never reached it — bar the
  // name an `exclusive` open reserved, which is given back.
  mainBridge.handle(MAIN_CHANNELS.FILE_WRITE_ABORT, async ({ id }) => {
    const entry = openWrites.get(id);
    if (!entry) return;
    openWrites.delete(id);
    try {
      await entry.handle.close();
    } finally {
      await unlink(entry.temp).catch(() => { });
      if (entry.reserved) {
        noteContent(entry.path, null);
        await unlink(entry.path).catch(() => { });
      }
    }
  });

  app.whenReady().then(() => {
    if (!app.isPackaged && process.platform === "darwin") {
      const devIcon = nativeImage.createFromPath(join(app.getAppPath(), "assets", "icon-dev.png"));
      if (!devIcon.isEmpty()) app.dock?.setIcon(devIcon);
    }

    setupAppMenu();
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
    session.defaultSession.setPermissionCheckHandler(() => true);
    session.defaultSession.setDevicePermissionHandler(() => true);


    dapi.start();
    createWindow(!isHiddenLaunch(process.argv));
  });

  let chatStopped = false;
  app.on("before-quit", (event) => {
    if (!chatStopped) {
      event.preventDefault();
      // Pending pushes land before the app goes; a checkout closed mid-write
      // would only catch up on the next launch.
      unwatchAllWorkspaces();
      void Promise.allSettled([chat.stop(), syncManager.stopAll()]).finally(() => {
        chatStopped = true;
        // The renderer is not consulted again: the chat is down and the
        // watchers are gone, so nothing it could say would change the outcome,
        // and a close it declines would leave a headless app behind (which is
        // what a Ctrl-C'd dev session used to do).
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
        app.quit();
        setTimeout(() => app.exit(0), 2000).unref();
      });
    }
    unwatchAll();
    dapi.stop();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  });
} else {
  console.warn(
    `[compound] Another instance is already running (user data: ${app.getPath("userData")}). ` +
    "Quit the existing Compound/Electron app before starting a new dev session.",
  );
  app.quit();
}
