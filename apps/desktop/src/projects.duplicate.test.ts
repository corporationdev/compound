// A duplicated project is a new project, not a second copy of the original's
// identity: it gets its own id, and any per-project sync state from before
// workspaces is left behind.

import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => tmpdir() },
  dialog: {},
  shell: {},
  ipcMain: { on: () => { } },
}));

const { duplicateProject, initProject, getProject } = await import("./projects");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dup-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("duplicateProject", () => {
  it("gives the copy a new id and drops stale sync state", async () => {
    const dir = join(root, "orig");
    const original = await initProject(null, dir);
    await mkdir(join(dir, ".compound", "sync", "base"), { recursive: true });
    await writeFile(join(dir, ".compound", "sync", "state.json"), JSON.stringify({ projectId: "proj_cloud", files: {} }));
    await writeFile(join(dir, ".compound", "sync", "base", "index.tsx"), "x");

    const copy = await duplicateProject(dir);
    expect(copy.dir).toBe(join(root, "orig-copy"));
    expect(copy.id).not.toBe(original.id);
    const pkg = JSON.parse(await readFile(join(copy.dir, "package.json"), "utf8"));
    expect(pkg.projectId).toBe(copy.id);
    expect(pkg.displayName).toBe("orig (Copy)");
    await expect(stat(join(copy.dir, ".compound", "sync"))).rejects.toThrow();

    // The original keeps everything.
    expect((await getProject(dir))?.id).toBe(original.id);
    expect(await readFile(join(dir, ".compound", "sync", "base", "index.tsx"), "utf8")).toBe("x");
  });
});
