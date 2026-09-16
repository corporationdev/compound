// The manager as the IPC handlers use it: bind a folder with files in it,
// check out an organization into an empty one, start twice, sign out. The
// backend is the in-memory fake, so this is the manager's own logic, not
// Convex.

import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getAppPath: () => tmpdir() },
  dialog: {},
  shell: {},
  ipcMain: { on: () => { } },
}));

const { SyncManager } = await import("./manager");
const { FakeBackend } = await import("./testing/fake-backend");

const ORG = "org_1";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let root: string;
let backend: InstanceType<typeof FakeBackend>;
let manager: InstanceType<typeof SyncManager>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "manager-test-"));
  backend = new FakeBackend();
  manager = new SyncManager(backend);
});

afterEach(async () => {
  await manager.stopAll();
  await rm(root, { recursive: true, force: true });
});

async function settled(dir: string): Promise<void> {
  for (let round = 0; round < 100; round++) {
    if (manager.status(dir)?.state === "synced") return;
    await sleep(20);
  }
  throw new Error(`never synced: ${JSON.stringify(manager.status(dir))}`);
}

describe("SyncManager", () => {
  it("binds a folder with files in it: they go up, and edits keep going up", async () => {
    const dir = join(root, "acme");
    await mkdir(join(dir, "projects", "film"), { recursive: true });
    await writeFile(join(dir, "projects", "film", "index.tsx"), "one\n");
    await writeFile(join(dir, "notes.md"), "# Notes\n");
    const status = await manager.start({ dir, organizationId: ORG, sessionToken: "session" });
    expect(["synced", "syncing"]).toContain(status.state);
    await settled(dir);
    expect(backend.text(ORG, "projects/film/index.tsx")).toBe("one\n");
    expect(backend.text(ORG, "notes.md")).toBe("# Notes\n");
    await writeFile(join(dir, "projects", "film", "index.tsx"), "two\n");
    const until = Date.now() + 4000;
    while (Date.now() < until && backend.text(ORG, "projects/film/index.tsx") !== "two\n") await sleep(25);
    expect(backend.text(ORG, "projects/film/index.tsx")).toBe("two\n");
  });

  it("checks an organization out into an empty folder", async () => {
    await backend.writeMany(ORG, [{ path: "projects/film/index.tsx", text: "cloud\n", hash: "x" }]);
    const dir = join(root, "acme");
    await manager.start({ dir, organizationId: ORG, sessionToken: "session" });
    await settled(dir);
    expect(await readFile(join(dir, "projects", "film", "index.tsx"), "utf8")).toBe("cloud\n");
    const until = Date.now() + 2000;
    while (Date.now() < until && !(await readdir(join(dir, ".compound", "sync"))).includes("state.json")) await sleep(10);
    expect(JSON.parse(await readFile(join(dir, ".compound", "sync", "state.json"), "utf8")).organizationId).toBe(ORG);
  });

  it("starting the same folder for the same organization twice keeps one sync; another organization is refused", async () => {
    await backend.writeMany(ORG, [{ path: "index.tsx", text: "v1\n", hash: "x" }]);
    const dir = join(root, "a");
    await manager.start({ dir, organizationId: ORG, sessionToken: "session" });
    await manager.start({ dir, organizationId: ORG, sessionToken: "session" });
    await settled(dir);
    // A different organization for a folder that already is a checkout is
    // refused by the engine; the manager must not leave a half-started sync behind.
    await expect(manager.start({ dir, organizationId: "org_other", sessionToken: "session" })).rejects.toThrow(/different organization/);
    expect(manager.status(dir)).toBeNull();
    expect(backend.text(ORG, "index.tsx")).toBe("v1\n");
  });

  it("signing out stops every sync", async () => {
    const a = join(root, "a");
    const b = join(root, "b");
    await manager.start({ dir: a, organizationId: ORG, sessionToken: "session" });
    await manager.start({ dir: b, organizationId: "org_2", sessionToken: "session" });
    expect(manager.status(a)).not.toBeNull();
    await manager.setSession(null);
    expect(manager.status(a)).toBeNull();
    expect(manager.status(b)).toBeNull();
  });
});
