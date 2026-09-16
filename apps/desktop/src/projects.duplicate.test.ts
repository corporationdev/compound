// A duplicated checkout is a new local project, not a second checkout of
// the original: the cloud binding and the sync state must not come along.

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

const { duplicateProject, initProject, recordCloudProjectId, getProject } = await import("./projects");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dup-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("duplicateProject", () => {
  it("drops the cloud binding and the sync state so the copy is local-only", async () => {
    const dir = join(root, "orig");
    const original = await initProject(null, dir);
    await recordCloudProjectId(dir, "proj_cloud");
    expect((await getProject(dir))?.cloudProjectId).toBe("proj_cloud");
    await mkdir(join(dir, ".compound", "sync", "base"), { recursive: true });
    await writeFile(join(dir, ".compound", "sync", "state.json"), JSON.stringify({ projectId: "proj_cloud", files: {} }));
    await writeFile(join(dir, ".compound", "sync", "base", "index.tsx"), "x");

    const copy = await duplicateProject(dir);
    expect(copy.dir).toBe(join(root, "orig-copy"));
    expect(copy.id).not.toBe(original.id);
    expect(copy.cloudProjectId).toBeUndefined();
    const pkg = JSON.parse(await readFile(join(copy.dir, "package.json"), "utf8"));
    expect("cloudProjectId" in pkg).toBe(false);
    expect(pkg.displayName).toBe("orig (Copy)");
    await expect(stat(join(copy.dir, ".compound", "sync"))).rejects.toThrow();

    // The original keeps everything.
    expect((await getProject(dir))?.cloudProjectId).toBe("proj_cloud");
    expect(await readFile(join(dir, ".compound", "sync", "base", "index.tsx"), "utf8")).toBe("x");
  });
});
