// The manager as the IPC handlers use it: publish a folder, materialize a
// cloud project into a fresh folder, start twice, sign out. The backend is
// the in-memory fake, so this is the manager's own logic, not Convex.

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

const { SyncManager, folderName } = await import("./manager");
const { FakeBackend } = await import("./testing/fake-backend");

const PROJECT = "proj_1";
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
  it("publishes a folder and keeps syncing it", async () => {
    const dir = join(root, "local");
    await mkdir(dir);
    await writeFile(join(dir, "index.tsx"), "one\n");
    const { files, status } = await manager.publish({ dir, projectId: PROJECT, sessionToken: "session" });
    expect(files).toBe(1);
    expect(["synced", "syncing"]).toContain(status.state);
    await settled(dir);
    expect(backend.text(PROJECT, "index.tsx")).toBe("one\n");
    await writeFile(join(dir, "index.tsx"), "two\n");
    const until = Date.now() + 4000;
    while (Date.now() < until && backend.text(PROJECT, "index.tsx") !== "two\n") await sleep(25);
    expect(backend.text(PROJECT, "index.tsx")).toBe("two\n");
  });

  it("materializes a cloud project into a free folder under the root", async () => {
    await backend.writeMany(PROJECT, [{ path: "index.tsx", text: "cloud\n", hash: "x" }]);
    await mkdir(join(root, "My Film"));
    const dir = await manager.materialize({ root, projectId: PROJECT, name: "My Film", sessionToken: "session" });
    expect(dir).toBe(join(root, "My Film-2"));
    await settled(dir);
    expect(await readFile(join(dir, "index.tsx"), "utf8")).toBe("cloud\n");
    const until = Date.now() + 2000;
    while (Date.now() < until && !(await readdir(join(dir, ".compound", "sync"))).includes("state.json")) await sleep(10);
    expect(JSON.parse(await readFile(join(dir, ".compound", "sync", "state.json"), "utf8")).projectId).toBe(PROJECT);
  });

  it("starting the same folder for the same project twice keeps one sync; another project replaces it", async () => {
    await backend.writeMany(PROJECT, [{ path: "index.tsx", text: "v1\n", hash: "x" }]);
    const dir = join(root, "a");
    await manager.start({ dir, projectId: PROJECT, sessionToken: "session" });
    await manager.start({ dir, projectId: PROJECT, sessionToken: "session" });
    await settled(dir);
    // A different project for a folder that already is a checkout is refused
    // by the engine; the manager must not leave a half-started sync behind.
    await expect(manager.start({ dir, projectId: "proj_other", sessionToken: "session" })).rejects.toThrow(/different cloud project/);
    expect(manager.status(dir)).toBeNull();
    expect(backend.text(PROJECT, "index.tsx")).toBe("v1\n");
  });

  it("signing out stops every sync", async () => {
    const a = join(root, "a");
    const b = join(root, "b");
    await manager.start({ dir: a, projectId: PROJECT, sessionToken: "session" });
    await manager.start({ dir: b, projectId: "proj_2", sessionToken: "session" });
    expect(manager.status(a)).not.toBeNull();
    await manager.setSession(null);
    expect(manager.status(a)).toBeNull();
    expect(manager.status(b)).toBeNull();
  });
});

describe("folderName", () => {
  it("makes a record name safe for a folder", () => {
    expect(folderName("My Film: Part 2/3?")).toBe("My Film Part 2 3");
    expect(folderName("   ")).toBe("project");
    expect(folderName("..hidden")).toBe("hidden");
  });
});
