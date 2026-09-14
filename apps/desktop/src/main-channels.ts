/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Wire-level channels — the only raw ipcRenderer/ipcMain channels in play for
// the main↔renderer request/event protocol. Everything else multiplexes
// through these via an envelope carrying the logical MAIN_CHANNELS name and
// (for requests) a UUID for correlation.
//
// Tool calls from the MCP server use their own wire (DAPI_WIRE in
// @compound/dapi), in the other direction: main asks, the renderer answers.
import type { LogEntry, ScreenshotResult } from "@compound/dapi";
import type { SourceEdit, WriteResult } from "./edit-types";
import type { AgentId } from "./mcp-config";

export const MAIN_WIRE = {
  REQUEST: "main:request",
  RESPONSE: "main:response",
  EVENT: "main:event",
} as const;

export type MainWireChannel = (typeof MAIN_WIRE)[keyof typeof MAIN_WIRE];

// Logical channels. Two categories:
//   • Renderer→Main requests (request + response)
//   • Main→Renderer events   (push, no response)
// Tool calls are not here: they arrive from main over DAPI_WIRE and are
// answered by the renderer's handlers (apps/web/src/dapi).
export const MAIN_CHANNELS = {
  CHAT_REQUEST: "chat:request",
  CHAT_STATE: "chat:state",
  CLOUD_CONFIG: "cloud:config",
  CLOUD_AUTH: "cloud:auth",
  CLOUD_MEDIA: "cloud:media",
  CLOUD_UPLOAD: "cloud:upload",
  CLOUD_CATALOG_UPLOAD: "cloud:catalog-upload",
  CLOUD_CATALOG_FILE: "cloud:catalog-file",
  CLOUD_CATALOG_ARTWORK: "cloud:catalog-artwork",
  // Renderer→Main requests
  APP_OPEN_EXTERNAL: "app:open-external",
  APP_SHOW_IN_FOLDER: "app:show-in-folder",
  WINDOW_IS_FULLSCREEN: "window:is-fullscreen",
  WINDOW_CAPTURE: "window:capture",
  FILE_TRANSFER: "file:transfer",
  FILE_WRITE_OPEN: "file:write-open",
  FILE_WRITE_CHUNK: "file:write-chunk",
  FILE_WRITE_CLOSE: "file:write-close",
  FILE_WRITE_ABORT: "file:write-abort",
  LOGS_GET: "logs:get",
  PROJECTS_PICK_ROOT: "projects:pick-root",
  PROJECTS_PICK_FOLDER: "projects:pick-folder",
  PROJECTS_DEFAULT_ROOT: "projects:default-root",
  PROJECTS_SCAN: "projects:scan",
  PROJECTS_GET: "projects:get",
  PROJECTS_INIT: "projects:init",
  PROJECTS_RESOLVE: "projects:resolve",
  PROJECTS_CREATE: "projects:create",
  PROJECTS_RENAME: "projects:rename",
  PROJECTS_DUPLICATE: "projects:duplicate",
  PROJECTS_DELETE: "projects:delete",
  PROJECTS_COMPILE: "projects:compile",
  PROJECTS_WRITE: "projects:write",
  PROJECTS_WATCH: "projects:watch",
  PROJECTS_UNWATCH: "projects:unwatch",
  PROJECTS_MANIFEST_READ: "projects:manifest-read",
  PROJECTS_MANIFEST_WRITE: "projects:manifest-write",
  PROJECTS_CONFIG_READ: "projects:config-read",
  PROJECTS_CONFIG_WRITE: "projects:config-write",
  PROJECTS_FS_LIST: "projects:fs-list",
  PROJECTS_FS_STAT: "projects:fs-stat",
  PROJECTS_FS_REMOVE: "projects:fs-remove",
  PROJECTS_FS_REAL_PATH: "projects:fs-real-path",
  HEADLESS_GET_MODE: "headless:get-mode",
  MCP_STATUS: "mcp:status",
  MCP_APPLY: "mcp:apply",
  CLI_STATUS: "cli:status",
  CLI_INSTALL: "cli:install",
  CLI_UNINSTALL: "cli:uninstall",

  // Main→Renderer events
  WINDOW_FULLSCREEN_CHANGE: "window:fullscreen-change",
  PROJECTS_CHANGED: "projects:changed",
} as const;

/**
 * A project folder, wherever it lives: a real npm package with a JSX entry.
 * Its package.json is the project record: `projectId` is what the project
 * is, `displayName` the human name, `main` the entry file.
 */
export type ProjectInfo = {
  /**
   * package.json `projectId`: the project's identity, and the segment its URL
   * carries. Empty for a folder that predates ids and has not been opened
   * since — `PROJECTS_RESOLVE` is what gives one out.
   */
  id: string;
  /** Folder name. Renaming the project moves it, so it is not the identity. */
  name: string;
  /** Human name from package.json `displayName` (falls back to the folder name). */
  displayName: string;
  /** Absolute path of the project folder. */
  dir: string;
  /** Entry file relative to `dir`: package.json `main`, else index.tsx/ts/jsx/js. */
  entry: string;
  /** mtime of the entry file, ISO string. */
  modifiedAt: string;
  /** birthtime of the folder, ISO string. */
  createdAt: string;
};

export type CompileResult =
  { ok: true; code: string } | { ok: false; error: string };

export type { SourceEdit, WriteResult };
export type { AgentId };

// One agent the settings page lists: whether it is set up on this machine,
// whether its config already carries the app's MCP entry, and — for the
// agents that need the bundled `dapi` binary — why this build cannot
// connect it (null when it can).
export type McpAgentStatus = {
  id: AgentId;
  label: string;
  detected: boolean;
  connected: boolean;
  /** Absolute path of the config file the entry goes into. */
  config: string;
  unavailable: string | null;
};

/** `url` is the HTTP endpoint any other agent can be pointed at by hand. */
export type McpStatus = { url: string; agents: McpAgentStatus[] };

export type McpApplyRequest = { add: AgentId[]; remove: AgentId[] };

// Per agent: written, taken out, or left as it was with the reason.
export type McpApplyResult = {
  added: AgentId[];
  removed: AgentId[];
  failures: { id: AgentId; error: string }[];
};

// Where the `dapi` command stands. `managed` means what is there is a
// symlink (the app's own, or the dev workflow's Homebrew link), which
// "Uninstall" can remove; `available` that this build can create the app's
// link (a dev build cannot: that is `npm run symlink:create`).
export type CliStatus = {
  installed: boolean;
  path: string | null;
  managed: boolean;
  available: boolean;
};

// Outcome of linking the bundled compound CLI into PATH. "cancelled" means the
// user dismissed the macOS admin prompt — not an error, not installed.
export type CliInstallResult =
  | { status: "installed" }
  | { status: "cancelled" }
  | { status: "error"; error: string };

// Outcome of taking the symlink back out. "absent" means there was none to
// remove; "cancelled" that the admin prompt was dismissed and it stays.
export type CliUninstallResult =
  | { status: "removed" }
  | { status: "absent" }
  | { status: "cancelled" }
  | { status: "error"; error: string };

export type MainChannel = (typeof MAIN_CHANNELS)[keyof typeof MAIN_CHANNELS];


export type CloudAuthOperation = 'sendCode' | 'verifyCode' | 'session' | 'token' | 'signOut' | 'updateUser' | 'deleteUser' | 'requestEmailChange' | 'changeEmail';
export type CloudAuthResult = { data: unknown; sessionToken: string | null; error?: string };
export type CloudConfig = { stage: string; projectsFolderName: string; convexUrl: string; authUrl: string; serverUrl: string };
export type MainRequestMap = {
  [MAIN_CHANNELS.CHAT_REQUEST]: { request: import("@compound/chat").ChatRequest; response: import("@compound/chat").ChatReply };
  [MAIN_CHANNELS.CLOUD_CONFIG]: { request: void; response: CloudConfig };
  [MAIN_CHANNELS.CLOUD_AUTH]: { request: { operation: CloudAuthOperation; body?: Record<string, unknown>; sessionToken: string | null }; response: CloudAuthResult };
  [MAIN_CHANNELS.CLOUD_MEDIA]: { request: { path: string; body: Record<string, unknown>; token: string | null }; response: unknown };
  [MAIN_CHANNELS.CLOUD_UPLOAD]: { request: { contentType: string; bytes: Uint8Array; token: string | null }; response: { uploadId: string } };
  [MAIN_CHANNELS.CLOUD_CATALOG_UPLOAD]: { request: { title: string; kind: 'music' | 'sfx'; mimeType: string; bytes: Uint8Array; token: string | null }; response: { sourceId: string } };
  [MAIN_CHANNELS.CLOUD_CATALOG_FILE]: { request: { sourceId: string; token: string | null }; response: { media: import('@compound/backend/catalog').CatalogMedia; bytes: Uint8Array } };
  [MAIN_CHANNELS.CLOUD_CATALOG_ARTWORK]: { request: { sourceId: string; token: string | null }; response: Uint8Array | null };

  [MAIN_CHANNELS.APP_OPEN_EXTERNAL]: { request: { url: string }; response: void };
  [MAIN_CHANNELS.WINDOW_IS_FULLSCREEN]: { request: void; response: boolean };
  [MAIN_CHANNELS.WINDOW_CAPTURE]: { request: void; response: ScreenshotResult };
  [MAIN_CHANNELS.FILE_TRANSFER]: {
    request: { selector: string; absolutePath: string };
    response: void;
  };
  [MAIN_CHANNELS.FILE_WRITE_OPEN]: {
    request: { path: string; exclusive?: boolean };
    response: { id: string };
  };
  [MAIN_CHANNELS.FILE_WRITE_CHUNK]: {
    request: { id: string; data: Uint8Array; position: number };
    response: void;
  };
  [MAIN_CHANNELS.FILE_WRITE_CLOSE]: {
    request: { id: string };
    response: void;
  };
  [MAIN_CHANNELS.FILE_WRITE_ABORT]: {
    request: { id: string };
    response: void;
  };
  // Reveals a file or folder in the OS file manager (Finder on macOS).
  [MAIN_CHANNELS.APP_SHOW_IN_FOLDER]: {
    request: { path: string };
    response: void;
  };
  [MAIN_CHANNELS.LOGS_GET]: { request: void; response: LogEntry[] };
  [MAIN_CHANNELS.PROJECTS_PICK_ROOT]: {
    request: void;
    response: string | null;
  };
  [MAIN_CHANNELS.PROJECTS_PICK_FOLDER]: {
    request: void;
    response: string | null;
  };
  [MAIN_CHANNELS.PROJECTS_DEFAULT_ROOT]: {
    request: void;
    response: string | null;
  };
  // Every project folder directly under `root`: what the app puts on its
  // list when `root` is chosen as the projects root.
  [MAIN_CHANNELS.PROJECTS_SCAN]: {
    request: { root: string };
    response: ProjectInfo[];
  };
  [MAIN_CHANNELS.PROJECTS_GET]: {
    request: { dir: string };
    response: ProjectInfo | null;
  };
  [MAIN_CHANNELS.PROJECTS_INIT]: {
    request: { dir: string };
    response: ProjectInfo;
  };
  [MAIN_CHANNELS.PROJECTS_RESOLVE]: {
    request: { dir: string };
    response: ProjectInfo | null;
  };
  [MAIN_CHANNELS.PROJECTS_CREATE]: {
    request: { root: string; displayName: string };
    response: ProjectInfo;
  };
  // Renames the project: `displayName` in the record, and the folder with it.
  [MAIN_CHANNELS.PROJECTS_RENAME]: {
    request: { dir: string; displayName: string };
    response: ProjectInfo;
  };
  [MAIN_CHANNELS.PROJECTS_DUPLICATE]: {
    request: { dir: string };
    response: ProjectInfo;
  };
  [MAIN_CHANNELS.PROJECTS_DELETE]: { request: { dir: string }; response: void };
  [MAIN_CHANNELS.PROJECTS_COMPILE]: {
    request: { dir: string };
    response: CompileResult;
  };
  [MAIN_CHANNELS.PROJECTS_WRITE]: {
    request: { dir: string; edits: SourceEdit[] };
    response: WriteResult;
  };
  [MAIN_CHANNELS.PROJECTS_WATCH]: { request: { dir: string }; response: void };
  [MAIN_CHANNELS.PROJECTS_UNWATCH]: {
    request: { dir: string };
    response: void;
  };
  // The asset manifest (`assets.yml`) as plain data; null when there is none.
  [MAIN_CHANNELS.PROJECTS_MANIFEST_READ]: { request: { dir: string }; response: unknown };
  [MAIN_CHANNELS.PROJECTS_MANIFEST_WRITE]: { request: { dir: string; manifest: unknown }; response: void };
  // The project's config: the `compound` field of its package.json, as
  // parsed (null when absent). The renderer owns its shape; see
  // `engine/project-config` in the web app.
  [MAIN_CHANNELS.PROJECTS_CONFIG_READ]: {
    request: { dir: string };
    response: unknown;
  };
  [MAIN_CHANNELS.PROJECTS_CONFIG_WRITE]: {
    request: { dir: string; config: unknown };
    response: void;
  };
  // Project file system, for the asset library. `source` is project-relative
  // or absolute; `path` is always project-relative. Writes stream through the
  // FILE_WRITE_* channels (which create parent directories).
  [MAIN_CHANNELS.PROJECTS_FS_LIST]: {
    request: { dir: string; source: string };
    response: FsEntry[];
  };
  [MAIN_CHANNELS.PROJECTS_FS_STAT]: {
    request: { dir: string; source: string };
    response: FsStat | null;
  };
  [MAIN_CHANNELS.PROJECTS_FS_REMOVE]: {
    request: { dir: string; path: string };
    response: void;
  };
  [MAIN_CHANNELS.PROJECTS_FS_REAL_PATH]: {
    request: { dir: string; source: string };
    response: string | null;
  };
  // Whether an agent is driving the app (see headless.ts).
  [MAIN_CHANNELS.HEADLESS_GET_MODE]: { request: void; response: boolean };
  // The app's MCP server in the agents' configs (see mcp-install.ts), and
  // the `compound` command on PATH (see cli-install.ts). The install/uninstall
  // calls put the macOS admin prompt on screen.
  [MAIN_CHANNELS.MCP_STATUS]: { request: void; response: McpStatus };
  [MAIN_CHANNELS.MCP_APPLY]: { request: McpApplyRequest; response: McpApplyResult };
  [MAIN_CHANNELS.CLI_STATUS]: { request: void; response: CliStatus };
  [MAIN_CHANNELS.CLI_INSTALL]: { request: void; response: CliInstallResult };
  [MAIN_CHANNELS.CLI_UNINSTALL]: { request: void; response: CliUninstallResult };
};

export type FsEntry = {
  name: string;
  kind: "file" | "directory";
  size: number;
  mtime: number;
  /** Set when the entry is a symlink; `kind` is what it points at. */
  link?: boolean;
};
export type FsStat = { size: number; mtime: number };
export type MainRequestChannel = keyof MainRequestMap;

export type MainEventMap = {
  [MAIN_CHANNELS.CHAT_STATE]: import("@compound/chat").ChatState;
  [MAIN_CHANNELS.WINDOW_FULLSCREEN_CHANGE]: { fullscreen: boolean };
  // A file inside a watched project folder changed (path relative to `dir`).
  [MAIN_CHANNELS.PROJECTS_CHANGED]: { dir: string; path: string };
};
export type MainEventChannel = keyof MainEventMap;

export type MainRequest = {
  id: string;
  channel: MainRequestChannel;
  data: unknown;
};

export type MainEvent = {
  channel: MainEventChannel;
  data: unknown;
};

export type MainReply =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: string };
