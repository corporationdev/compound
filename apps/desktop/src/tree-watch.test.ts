import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic";
import { watchTree, type TreeWatcher } from "./tree-watch";

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const WATCH_TIMEOUT_MS = process.env.CI ? 15000 : 4000;

let dir: string;
let changed: string[];
let watcher: TreeWatcher;

async function waitFor(path: string, count: number): Promise<void> {
  const until = Date.now() + WATCH_TIMEOUT_MS;
  while (Date.now() < until) {
    if (changed.filter((p) => p === path).length >= count) return;
    await settle(25);
  }
  expect(changed.filter((p) => p === path).length).toBeGreaterThanOrEqual(count);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tree-watch-"));
  await mkdir(join(dir, "sub"));
  await writeFile(join(dir, "sub", "notes.md"), "v0\n");
  changed = [];
  watcher = watchTree(dir, { onChange: (path) => changed.push(path) });
  await watcher.ready;
});

afterEach(async () => {
  await watcher.close();
  await rm(dir, { recursive: true, force: true });
});

describe("watchTree", () => {
  it("keeps reporting a file replaced by rename, every time", async () => {
    // Node's recursive fs.watch on Linux reports only the first replacement.
    for (let i = 1; i <= 3; i++) {
      await writeFileAtomic(join(dir, "sub", "notes.md"), `v${i}\n`);
      await waitFor("sub/notes.md", i);
      // A person's edits are seconds apart; the watcher re-arms on the new inode in a few ms.
      await settle(150);
    }
    expect(changed.some((path) => path.includes(".dstmp-"))).toBe(false);
  });

  it("reports files in folders made after the watch began, with /-separated relative paths", async () => {
    await mkdir(join(dir, "later", "deeper"), { recursive: true });
    await settle(150);
    await writeFile(join(dir, "later", "deeper", "a.md"), "a\n");
    await waitFor("later/deeper/a.md", 1);
  });

  it("leaves node_modules alone", async () => {
    await mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await writeFile(join(dir, "node_modules", "x", "index.js"), "x");
    await settle(300);
    expect(changed.some((path) => path.startsWith("node_modules"))).toBe(false);
  });
});
