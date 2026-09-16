import { describe, expect, it } from "vitest";

import { MAX_SYNC_BYTES, isSyncableContent, isSyncablePath, shouldDescend } from "./rules";

describe("isSyncablePath", () => {
  it("takes source and config at any depth", () => {
    for (const path of ["index.tsx", "package.json", "assets.yml", "scenes/intro.tsx", "tsconfig.json", "AGENTS.md", ".gitignore"]) {
      expect(isSyncablePath(path)).toBe(true);
    }
  });

  it("refuses installs, caches, exports, media, the app folder and agent config", () => {
    for (const path of [
      "node_modules/x/index.js", "scenes/node_modules/x.js", ".compound/sync/state.json", "cache/thumbnails/a.webp",
      "exports/intro.mp4", "assets/b-roll/drone.mp4", ".git/HEAD", ".claude/settings.local.json", ".mcp.json",
      ".DS_Store", "scenes/.DS_Store", ".dstmp-index.tsx.1-2",
    ]) {
      expect(isSyncablePath(path)).toBe(false);
    }
  });

  it("refuses paths that could escape or confuse the folder", () => {
    for (const path of ["", "/index.tsx", "../index.tsx", "a/../b.tsx", "a//b.tsx", "a\\b.tsx", "a\0b"]) {
      expect(isSyncablePath(path)).toBe(false);
    }
  });

  it("does not confuse a nested folder named like a root-only ignore", () => {
    expect(isSyncablePath("scenes/assets/notes.md")).toBe(true);
    expect(shouldDescend("scenes", "assets")).toBe(true);
    expect(shouldDescend("", "assets")).toBe(false);
  });
});

describe("isSyncableContent", () => {
  it("takes text up to the limit and refuses binary or oversized files", () => {
    expect(isSyncableContent(new TextEncoder().encode("export default () => <stage />;"))).toBe(true);
    expect(isSyncableContent(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]))).toBe(false);
    expect(isSyncableContent(new Uint8Array(MAX_SYNC_BYTES + 1).fill(0x20))).toBe(false);
    expect(isSyncableContent(new Uint8Array(MAX_SYNC_BYTES).fill(0x20))).toBe(true);
  });
});
