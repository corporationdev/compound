import { describe, expect, it } from "vitest";

import { MAX_SYNC_BYTES, isSyncableContent, isSyncablePath, shouldDescend } from "./rules";

describe("isSyncablePath", () => {
  it("takes source, config and notes at any depth", () => {
    for (const path of [
      "index.tsx", "notes.md", "projects/film/index.tsx", "projects/film/package.json", "projects/film/assets.yml",
      "projects/film/scenes/intro.tsx", "ideas/_table.yaml", "ideas/hook.md", "AGENTS.md", ".gitignore",
    ]) {
      expect(isSyncablePath(path)).toBe(true);
    }
  });

  it("refuses installs, caches, exports, media, the app folder and agent config wherever they sit", () => {
    for (const path of [
      "node_modules/x/index.js", "projects/film/node_modules/x.js", ".compound/sync/state.json", "projects/film/.compound/x",
      "projects/film/cache/thumbnails/a.webp", "cache/a", "projects/film/exports/intro.mp4", "projects/film/assets/b-roll/drone.mp4",
      "brand/assets/logo.svg", ".git/HEAD", "projects/film/.git/HEAD", ".claude/settings.local.json", "projects/film/.mcp.json",
      ".DS_Store", "projects/.DS_Store", ".dstmp-index.tsx.1-2", "projects/film/.dstmp-index.tsx.1-2",
    ]) {
      expect(isSyncablePath(path)).toBe(false);
    }
  });

  it("refuses paths that could escape or confuse the folder", () => {
    for (const path of ["", "/index.tsx", "../index.tsx", "a/../b.tsx", "a//b.tsx", "a\\b.tsx", "a\0b"]) {
      expect(isSyncablePath(path)).toBe(false);
    }
  });

  it("descends into everything but the ignored names", () => {
    expect(shouldDescend("projects")).toBe(true);
    expect(shouldDescend("scenes")).toBe(true);
    expect(shouldDescend("assets")).toBe(false);
    expect(shouldDescend("node_modules")).toBe(false);
    expect(shouldDescend(".compound")).toBe(false);
    expect(shouldDescend(".dstmp-x")).toBe(false);
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
