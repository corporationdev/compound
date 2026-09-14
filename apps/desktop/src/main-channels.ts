/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Wire-level channels — the only raw ipcRenderer/ipcMain channels in play for
// the main↔renderer request/event protocol. Everything else multiplexes
// through these via an envelope carrying the logical MAIN_CHANNELS name and
// (for requests) a UUID for correlation.
//
// CLI traffic uses a separate wire pair (CLI_WIRE in @compound/cli/protocol);
// main forwards it opaquely without inspecting channel names.
import type { LogEntry, ScreenshotResult } from "@compound/cli/protocol";
import type { SourceEdit, WriteResult } from "./edit";

export const MAIN_WIRE = {
  REQUEST: "main:request",
  RESPONSE: "main:response",
  EVENT: "main:event",
} as const;

export type MainWireChannel = (typeof MAIN_WIRE)[keyof typeof MAIN_WIRE];

// Logical channels. Two categories:
//   • Renderer→Main requests (request + response)
//   • Main→Renderer events   (push, no response)
// Renderer-state queries used to live here; they now answer CLI requests
// directly via the CLI bridge.
export const MAIN_CHANNELS = {
  CHAT_REQUEST: "chat:request",
  CHAT_STATE: "chat:state",
  CLOUD_CONFIG: "cloud:config",
  CLOUD_AUTH: "cloud:auth",
  CLOUD_MEDIA: "cloud:media",
  CLOUD_UPLOAD: "cloud:upload",
  CLOUD_UPLOAD_CANCEL: "cloud:upload-cancel",
  RENDER_CACHE_LOOKUP: "render-cache:lookup",
  RENDER_CACHE_STORE: "render-cache:store",
  CLOUD_UPLOAD_PROGRESS: "cloud:upload-progress",
  CLOUD_CATALOG_FILE: "cloud:catalog-file",
  CLOUD_CATALOG_ARTWORK: "cloud:catalog-artwork",
  // Renderer→Main requests
  APP_OPEN_EXTERNAL: "app:open-external",
  APP_DEEP_LINK_TAKE: "app:deep-link-take",
  SOCIAL_PICK_VIDEO: "social:pick-video",
  APP_SHOW_IN_FOLDER: "app:show-in-folder",
  CLI_IS_INSTALLED: "cli:is-installed",
  CLI_INSTALL: "cli:install",
  SKILLS_IS_INSTALLED: "skills:is-installed",
  SKILLS_INSTALL: "skills:install",
  WINDOW_IS_FULLSCREEN: "window:is-fullscreen",
  WINDOW_CAPTURE: "window:capture",
  FILE_TRANSFER: "file:transfer",
  FILE_WRITE_OPEN: "file:write-open",
  FILE_WRITE_CHUNK: "file:write-chunk",
  FILE_WRITE_CLOSE: "file:write-close",
  FILE_WRITE_ABORT: "file:write-abort",
  HEADLESS_GET_MODE: "headless:get-mode",
  LOGS_GET: "logs:get",
  PROJECTS_PICK_ROOT: "projects:pick-root",
  PROJECTS_DEFAULT_ROOT: "projects:default-root",
  PROJECTS_LIST: "projects:list",
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

  // Main→Renderer events
  APP_DEEP_LINK: "app:deep-link",
  WINDOW_FULLSCREEN_CHANGE: "window:fullscreen-change",
  HEADLESS_MODE: "headless:mode",
  PROJECTS_CHANGED: "projects:changed",
} as const;

/**
 * A project folder under the projects root: a real npm package with a JSX
 * entry. Its package.json is the project record: `projectId` is what the
 * project is, `displayName` the human name, `main` the entry file.
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
  | { ok: true; code: string }
  | { ok: false; error: string };

// Outcome of linking the bundled compound CLI into PATH. "cancelled" means the
// user dismissed the macOS admin prompt — not an error, not installed.
export type CliInstallResult =
  | { status: "installed" }
  | { status: "cancelled" }
  | { status: "error"; error: string };

// Outcome of symlinking the bundled skills into the agent skill directories.
export type SkillsInstallResult =
  | { status: "installed" }
  | { status: "error"; error: string };

export type { SourceEdit, WriteResult };

export type MainChannel = (typeof MAIN_CHANNELS)[keyof typeof MAIN_CHANNELS];

export type CloudAuthOperation = 'sendCode' | 'verifyCode' | 'session' | 'token' | 'signOut' | 'updateUser' | 'deleteUser' | 'requestEmailChange' | 'changeEmail';
export type CloudAuthResult = { data: unknown; sessionToken: string | null; error?: string };
export type CloudConfig = { stage: string; projectsFolderName: string; convexUrl: string; authUrl: string; serverUrl: string };
export type MainRequestMap = {
  [MAIN_CHANNELS.CHAT_REQUEST]: { request: import("@compound/chat").ChatRequest; response: import("@compound/chat").ChatReply };
  [MAIN_CHANNELS.CLOUD_CONFIG]: { request: void; response: CloudConfig };
  [MAIN_CHANNELS.CLOUD_AUTH]: { request: { operation: CloudAuthOperation; body?: Record<string, unknown>; sessionToken: string | null }; response: CloudAuthResult };
  // A JSON call to the Worker; `path` is the full route (`/media/…`, `/social/…`).
  [MAIN_CHANNELS.CLOUD_MEDIA]: { request: { path: string; body: Record<string, unknown>; token: string | null }; response: unknown };
  // Multipart upload of a file on disk or of bytes; progress arrives on CLOUD_UPLOAD_PROGRESS.
  [MAIN_CHANNELS.CLOUD_UPLOAD]: { request: import("./cloud-upload").CloudUploadRequest; response: import("./cloud-upload").CloudUploadResult };
  [MAIN_CHANNELS.CLOUD_UPLOAD_CANCEL]: { request: { uploadId: string }; response: void };
  // Hash of a project's render inputs, plus the existing export for that hash if it is still on disk.
  [MAIN_CHANNELS.RENDER_CACHE_LOOKUP]: { request: import("./render-cache").RenderCacheLookup; response: import("./render-cache").RenderCacheResult };
  [MAIN_CHANNELS.RENDER_CACHE_STORE]: { request: { dir: string; name: string; entry: import("./render-cache").RenderCacheEntry }; response: void };
  [MAIN_CHANNELS.CLOUD_CATALOG_FILE]: { request: { sourceId: string; token: string | null }; response: { media: import('@compound/backend/catalog').CatalogMedia; bytes: Uint8Array } };
  [MAIN_CHANNELS.CLOUD_CATALOG_ARTWORK]: { request: { sourceId: string; token: string | null }; response: Uint8Array | null };

  [MAIN_CHANNELS.APP_OPEN_EXTERNAL]: { request: { url: string }; response: void };
  // A `compound://` link that arrived before the renderer was listening.
  [MAIN_CHANNELS.APP_DEEP_LINK_TAKE]: { request: void; response: import("./deep-link").DeepLink | null };
  [MAIN_CHANNELS.SOCIAL_PICK_VIDEO]: { request: void; response: { path: string; name: string } | null };
  [MAIN_CHANNELS.CLI_IS_INSTALLED]: { request: void; response: boolean };
  [MAIN_CHANNELS.CLI_INSTALL]: { request: void; response: CliInstallResult };
  [MAIN_CHANNELS.SKILLS_IS_INSTALLED]: { request: void; response: boolean };
  [MAIN_CHANNELS.SKILLS_INSTALL]: { request: void; response: SkillsInstallResult };
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
  [MAIN_CHANNELS.APP_SHOW_IN_FOLDER]: { request: { path: string }; response: void };
  [MAIN_CHANNELS.HEADLESS_GET_MODE]: { request: void; response: boolean };
  [MAIN_CHANNELS.LOGS_GET]: { request: void; response: LogEntry[] };
  [MAIN_CHANNELS.PROJECTS_PICK_ROOT]: { request: void; response: string | null };
  [MAIN_CHANNELS.PROJECTS_DEFAULT_ROOT]: { request: void; response: string | null };
  [MAIN_CHANNELS.PROJECTS_LIST]: { request: { root: string }; response: ProjectInfo[] };
  [MAIN_CHANNELS.PROJECTS_GET]: { request: { dir: string }; response: ProjectInfo | null };
  [MAIN_CHANNELS.PROJECTS_INIT]: { request: { dir: string }; response: ProjectInfo };
  [MAIN_CHANNELS.PROJECTS_RESOLVE]: {
    request: { root: string; ref: string };
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
  [MAIN_CHANNELS.PROJECTS_DUPLICATE]: { request: { dir: string }; response: ProjectInfo };
  [MAIN_CHANNELS.PROJECTS_DELETE]: { request: { dir: string }; response: void };
  [MAIN_CHANNELS.PROJECTS_COMPILE]: { request: { dir: string }; response: CompileResult };
  [MAIN_CHANNELS.PROJECTS_WRITE]: {
    request: { dir: string; edits: SourceEdit[] };
    response: WriteResult;
  };
  [MAIN_CHANNELS.PROJECTS_WATCH]: { request: { dir: string }; response: void };
  [MAIN_CHANNELS.PROJECTS_UNWATCH]: { request: { dir: string }; response: void };
  // The asset manifest (`assets.yml`) as plain data; null when there is none.
  [MAIN_CHANNELS.PROJECTS_MANIFEST_READ]: { request: { dir: string }; response: unknown };
  [MAIN_CHANNELS.PROJECTS_MANIFEST_WRITE]: { request: { dir: string; manifest: unknown }; response: void };
  // The project's config: the `compound` field of its package.json, as
  // parsed (null when absent). The renderer owns its shape; see
  // `engine/project-config` in the web app.
  [MAIN_CHANNELS.PROJECTS_CONFIG_READ]: { request: { dir: string }; response: unknown };
  [MAIN_CHANNELS.PROJECTS_CONFIG_WRITE]: { request: { dir: string; config: unknown }; response: void };
  // Project file system, for the asset library. `source` is project-relative
  // or absolute; `path` is always project-relative. Writes stream through the
  // FILE_WRITE_* channels (which create parent directories).
  [MAIN_CHANNELS.PROJECTS_FS_LIST]: { request: { dir: string; source: string }; response: FsEntry[] };
  [MAIN_CHANNELS.PROJECTS_FS_STAT]: { request: { dir: string; source: string }; response: FsStat | null };
  [MAIN_CHANNELS.PROJECTS_FS_REMOVE]: { request: { dir: string; path: string }; response: void };
  [MAIN_CHANNELS.PROJECTS_FS_REAL_PATH]: { request: { dir: string; source: string }; response: string | null };
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
  // A `compound://` link opened while the app was running.
  [MAIN_CHANNELS.APP_DEEP_LINK]: import("./deep-link").DeepLink;
  [MAIN_CHANNELS.CLOUD_UPLOAD_PROGRESS]: import("./cloud-upload").CloudUploadProgress;
  [MAIN_CHANNELS.CHAT_STATE]: import("@compound/chat").ChatState;
  [MAIN_CHANNELS.WINDOW_FULLSCREEN_CHANGE]: { fullscreen: boolean };
  [MAIN_CHANNELS.HEADLESS_MODE]: { active: boolean };
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
