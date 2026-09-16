// The sync engine's contract, pinned against an in-memory cloud: what a
// checkout pushes, what it writes, how two of them converge, and what
// happens when the connection drops.

import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeBackend } from "./testing/fake-backend";
import { withProjectLock } from "./locks";
import { WorkspaceSync, collectSyncableFiles, publishFolder } from "./workspace-sync";
import type { ConflictNotice, SyncStatus } from "./workspace-sync";

const PROJECT = "org_1";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let root: string;
const syncs: WorkspaceSync[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sync-test-"));
});

afterEach(async () => {
  await Promise.all(syncs.splice(0).map((sync) => sync.stop()));
  await rm(root, { recursive: true, force: true });
});

async function checkout(name: string, backend: FakeBackend, extra: Partial<ConstructorParameters<typeof WorkspaceSync>[0]> = {}): Promise<WorkspaceSync> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const sync = new WorkspaceSync({ dir, organizationId: PROJECT, backend, watch: false, coalesceMs: 5, retryBaseMs: 20, ...extra });
  syncs.push(sync);
  await sync.start();
  return sync;
}

const read = (sync: WorkspaceSync, path: string): Promise<string> => readFile(join(sync.dir, path), "utf8");
const exists = (sync: WorkspaceSync, path: string): Promise<boolean> => stat(join(sync.dir, path)).then(() => true, () => false);

async function edit(sync: WorkspaceSync, path: string, text: string): Promise<void> {
  await mkdir(join(sync.dir, ...path.split("/").slice(0, -1)), { recursive: true });
  await writeFile(join(sync.dir, path), text);
  sync.noteChange(path);
}

async function remove(sync: WorkspaceSync, path: string): Promise<void> {
  await rm(join(sync.dir, path));
  sync.noteChange(path);
}

/** Waits until every checkout is idle and the cloud has nothing more to deliver. */
async function settle(...all: WorkspaceSync[]): Promise<void> {
  for (let round = 0; round < 50; round++) {
    await Promise.all(all.map((sync) => sync.idle()));
    await sleep(15);
    if (all.every((sync) => sync.status.state === "synced")) {
      await Promise.all(all.map((sync) => sync.idle()));
      await sleep(15);
      if (all.every((sync) => sync.status.state === "synced")) return;
    }
  }
}

async function folderText(dir: string): Promise<Record<string, string>> {
  const files = await collectSyncableFiles(dir);
  return Object.fromEntries(files.map((file) => [file.path, file.text]));
}

describe("checkout", () => {
  it("brings a workspace down in batches, not a round trip per file, and knows its project folders from the first listing", async () => {
    const backend = new FakeBackend();
    const files = Array.from({ length: 150 }, (_, i) => ({ path: `projects/p${i % 3}/file${i}.md`, text: `${i}\n`, hash: `h${i}` }));
    await backend.writeMany(PROJECT, [...files, { path: "projects/p0/package.json", text: "{}\n", hash: "pkg" }]);
    const a = await checkout("a", backend);
    expect(backend.batchFetches).toBe(3);
    expect(backend.fetches).toBe(0);
    expect(Object.keys(await folderText(a.dir))).toHaveLength(151);
    expect([...a.projectRoots]).toEqual(["projects/p0"]);

    // A second start of the same folder knows the project before the cloud answers.
    await a.stop();
    const again = new WorkspaceSync({ dir: a.dir, organizationId: PROJECT, backend, watch: false, coalesceMs: 5 });
    syncs.push(again);
    const started = again.start();
    expect([...again.projectRoots]).toEqual([]);
    await started;
    expect([...again.projectRoots]).toEqual(["projects/p0"]);
  });
});

describe("folders that appear with files already in them", () => {
  it("pushes files written the instant their folder was made, as a scaffold does, and files that came with a folder renamed in", async () => {
    const backend = new FakeBackend();
    const a = await checkout("a", backend, { sweepDelayMs: 30 });
    // What the watcher reports for a folder that came into being: its own path, before it could attach to it.
    await mkdir(join(a.dir, "projects", "fresh"), { recursive: true });
    await writeFile(join(a.dir, "projects", "fresh", "package.json"), "{}\n");
    await writeFile(join(a.dir, "projects", "fresh", "index.tsx"), "x\n");
    const writesBefore = backend.writes;
    // The watcher reports the folder and each file in it, in whatever order.
    a.noteChange("projects/fresh/index.tsx");
    a.noteChange("projects/fresh");
    a.noteChange("projects/fresh/package.json");
    await settle(a);
    expect(backend.text(PROJECT, "projects/fresh/package.json")).toBe("{}\n");
    expect(backend.text(PROJECT, "projects/fresh/index.tsx")).toBe("x\n");
    // One write for the whole folder, not one per file, so another machine sees the project whole.
    expect(backend.writes - writesBefore).toBe(0);
    expect(backend.batchWrites).toBe(1);
    // The rows' versions came back through the subscription: a later edit goes up as an update, not a conflicting create.
    expect(backend.version(PROJECT, "projects/fresh/index.tsx")).toBe(1);
    await edit(a, "projects/fresh/index.tsx", "y\n");
    await settle(a);
    expect(backend.text(PROJECT, "projects/fresh/index.tsx")).toBe("y\n");
    expect(backend.version(PROJECT, "projects/fresh/index.tsx")).toBe(2);

    const staging = join(a.dir, ".dstmp-moved.1-1");
    await mkdir(join(staging, "deep"), { recursive: true });
    await writeFile(join(staging, "deep", "note.md"), "moved\n");
    await rename(staging, join(a.dir, "projects", "moved"));
    a.noteChange("projects/moved");
    await settle(a);
    expect(backend.text(PROJECT, "projects/moved/deep/note.md")).toBe("moved\n");
  });
});

describe("status", () => {
  it("says synced once the engine has stayed quiet, not between every file of a burst", async () => {
    const backend = new FakeBackend();
    const statuses: string[] = [];
    const a = await checkout("a", backend, { statusSettleMs: 60, onStatus: (status) => statuses.push(status.state) });
    for (let i = 0; i < 5; i++) {
      await edit(a, `note-${i}.md`, `${i}\n`);
      await sleep(10);
    }
    await settle(a);
    await sleep(120);
    expect(statuses[statuses.length - 1]).toBe("synced");
    expect(statuses.filter((state) => state === "synced").length).toBe(1);
  });
});

describe("removals", () => {
  it("take the folders a removed file leaves empty with them, and no more", async () => {
    const backend = new FakeBackend();
    const a = await checkout("a", backend);
    const b = await checkout("b", backend);
    await edit(a, "projects/gone/deep/only.md", "x\n");
    await edit(a, "projects/kept/note.md", "y\n");
    await settle(a, b);
    expect(await exists(b, "projects/gone/deep/only.md")).toBe(true);
    // Derived data the app made beside the files does not keep the folder alive.
    await mkdir(join(b.dir, "projects", "gone", "cache", "thumbnails"), { recursive: true });
    await writeFile(join(b.dir, "projects", "gone", "cache", "thumbnails", "x.webp"), "");
    await remove(a, "projects/gone/deep/only.md");
    await settle(a, b);
    expect(await exists(b, "projects/gone")).toBe(false);
    expect(await exists(b, "projects/kept/note.md")).toBe(true);
    expect(await exists(b, "projects")).toBe(true);
  });
});

describe("project roots", () => {
  it("names every folder the cloud holds a package.json in, from the first snapshot", async () => {
    const backend = new FakeBackend();
    await backend.writeMany(PROJECT, [
      { path: "projects/film/package.json", text: "{}\n", hash: "h1" },
      { path: "projects/film/index.tsx", text: "a\n", hash: "h2" },
      { path: "clients/acme/package.json", text: "{}\n", hash: "h3" },
      { path: "notes.md", text: "n\n", hash: "h4" },
    ]);
    const a = await checkout("a", backend);
    expect([...a.projectRoots].sort()).toEqual(["clients/acme", "projects/film"]);
  });

  it("forgets a folder whose package.json the cloud dropped", async () => {
    const backend = new FakeBackend();
    await backend.writeMany(PROJECT, [{ path: "projects/film/package.json", text: "{}\n", hash: "h1" }]);
    const a = await checkout("a", backend);
    expect(a.projectRoots.has("projects/film")).toBe(true);
    await remove(a, "projects/film/package.json");
    await settle(a);
    expect(a.projectRoots.has("projects/film")).toBe(false);
  });
});

describe("one checkout", () => {
  it("materializes an empty folder from the cloud and pushes new local files", async () => {
    const backend = new FakeBackend();
    await backend.writeMany(PROJECT, [
      { path: "index.tsx", text: "export default () => <stage />;\n", hash: "h1" },
      { path: "scenes/a.tsx", text: "a\n", hash: "h2" },
    ]);
    const a = await checkout("a", backend);
    expect(await read(a, "index.tsx")).toBe("export default () => <stage />;\n");
    expect(await read(a, "scenes/a.tsx")).toBe("a\n");
    expect(a.status.state).toBe("synced");

    await edit(a, "notes.md", "hello\n");
    await settle(a);
    expect(backend.text(PROJECT, "notes.md")).toBe("hello\n");
    expect(backend.version(PROJECT, "notes.md")).toBe(1);
  });

  it("publishes a local folder then syncs without rewriting anything", async () => {
    const backend = new FakeBackend();
    const dir = join(root, "local");
    await mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "index.tsx"), "one\n");
    await writeFile(join(dir, "package.json"), "{}\n");
    await writeFile(join(dir, "node_modules", "x", "index.js"), "ignored");
    await writeFile(join(dir, "assets", "clip.mp4"), "ignored");
    await writeFile(join(dir, "logo.png"), new Uint8Array([0x89, 0x50, 0, 0]));
    expect(await publishFolder(dir, PROJECT, backend)).toBe(2);
    expect(backend.snapshot(PROJECT).map((row) => row.path)).toEqual(["index.tsx", "package.json"]);

    const writes = backend.writes;
    const a = new WorkspaceSync({ dir, organizationId: PROJECT, backend, watch: false, coalesceMs: 5 });
    syncs.push(a);
    await a.start();
    await settle(a);
    expect(backend.writes).toBe(writes);
    expect(backend.version(PROJECT, "index.tsx")).toBe(1);
  });

  it("writes cloud changes to a clean file and deletes on a tombstone", async () => {
    const backend = new FakeBackend();
    await backend.writeMany(PROJECT, [{ path: "index.tsx", text: "v1\n", hash: "x" }]);
    const a = await checkout("a", backend);
    await backend.write(PROJECT, "index.tsx", "v2\n", "y", 1);
    await settle(a);
    expect(await read(a, "index.tsx")).toBe("v2\n");
    await backend.remove(PROJECT, "index.tsx", 2);
    await settle(a);
    expect(await exists(a, "index.tsx")).toBe(false);
  });

  it("pushes a local delete as a tombstone", async () => {
    const backend = new FakeBackend();
    await backend.writeMany(PROJECT, [{ path: "old.tsx", text: "x\n", hash: "x" }]);
    const a = await checkout("a", backend);
    await remove(a, "old.tsx");
    await settle(a);
    expect(backend.text(PROJECT, "old.tsx")).toBeNull();
    expect(backend.version(PROJECT, "old.tsx")).toBe(2);
  });

  it("does not bounce its own writes back to the cloud", async () => {
    const backend = new FakeBackend();
    await backend.writeMany(PROJECT, [{ path: "index.tsx", text: "v1\n", hash: "x" }]);
    const a = await checkout("a", backend);
    const before = backend.writes;
    await backend.write(PROJECT, "index.tsx", "v2\n", "y", 1);
    await settle(a);
    // The watcher would report the write sync just made; it must be a no-op.
    a.noteChange("index.tsx");
    await settle(a);
    expect(backend.writes).toBe(before + 1);
  });

  it("ignores files the rules exclude and binary content at a synced path", async () => {
    const backend = new FakeBackend();
    const a = await checkout("a", backend);
    await edit(a, "cache/x.txt", "no");
    await edit(a, ".compound/sync/other", "no");
    await writeFile(join(a.dir, "blob.bin"), new Uint8Array([1, 0, 2]));
    a.noteChange("blob.bin");
    await settle(a);
    expect(backend.snapshot(PROJECT)).toEqual([]);
  });

  it("keeps a local edit made while offline and pushes it when the connection returns", async () => {
    const backend = new FakeBackend();
    await backend.writeMany(PROJECT, [{ path: "index.tsx", text: "v1\n", hash: "x" }]);
    const statuses: SyncStatus[] = [];
    const a = await checkout("a", backend, { onStatus: (status) => statuses.push(status) });
    backend.setOffline(true);
    await edit(a, "index.tsx", "mine\n");
    await a.idle();
    await sleep(30);
    expect(a.status.state).toBe("offline");
    expect(backend.text(PROJECT, "index.tsx")).toBe("v1\n");
    backend.setOffline(false);
    await settle(a);
    expect(backend.text(PROJECT, "index.tsx")).toBe("mine\n");
    expect(a.status.state).toBe("synced");
    expect(statuses.some((status) => status.state === "offline")).toBe(true);
  });

  it("resumes from its saved state on restart instead of re-pushing everything", async () => {
    const backend = new FakeBackend();
    await backend.writeMany(PROJECT, [{ path: "index.tsx", text: "v1\n", hash: "x" }]);
    const a = await checkout("a", backend);
    await edit(a, "index.tsx", "v2\n");
    await settle(a);
    await a.stop();
    syncs.splice(syncs.indexOf(a), 1);
    const writes = backend.writes;

    const again = new WorkspaceSync({ dir: a.dir, organizationId: PROJECT, backend, watch: false, coalesceMs: 5 });
    syncs.push(again);
    await again.start();
    await settle(again);
    expect(backend.writes).toBe(writes);
    expect(await read(again, "index.tsx")).toBe("v2\n");
  });

  it("recreates a file the cloud deleted while it was changed here", async () => {
    const backend = new FakeBackend();
    await backend.writeMany(PROJECT, [{ path: "index.tsx", text: "v1\n", hash: "x" }]);
    const a = await checkout("a", backend);
    backend.setOffline(true);
    await edit(a, "index.tsx", "kept\n");
    await a.idle();
    backend.offline = false;
    await backend.remove(PROJECT, "index.tsx", 1);
    backend.setOffline(false);
    await settle(a);
    expect(await read(a, "index.tsx")).toBe("kept\n");
    expect(backend.text(PROJECT, "index.tsx")).toBe("kept\n");
  });
});

describe("two checkouts", () => {
  it("see each other's edits to different files", async () => {
    const backend = new FakeBackend();
    await backend.writeMany(PROJECT, [{ path: "index.tsx", text: "v1\n", hash: "x" }]);
    const a = await checkout("a", backend);
    const b = await checkout("b", backend);
    await edit(a, "a.tsx", "from a\n");
    await edit(b, "b.tsx", "from b\n");
    await settle(a, b);
    expect(await read(b, "a.tsx")).toBe("from a\n");
    expect(await read(a, "b.tsx")).toBe("from b\n");
    expect(await folderText(a.dir)).toEqual(await folderText(b.dir));
  });

  it("merge edits to different lines of the same file without losing either", async () => {
    const backend = new FakeBackend();
    const base = "line1\nline2\nline3\nline4\nline5\n";
    await backend.writeMany(PROJECT, [{ path: "index.tsx", text: base, hash: "x" }]);
    const a = await checkout("a", backend);
    const b = await checkout("b", backend);
    // Both edit before either hears from the other.
    backend.delayMs = 40;
    await edit(a, "index.tsx", base.replace("line1", "A1"));
    await edit(b, "index.tsx", base.replace("line5", "B5"));
    await settle(a, b);
    backend.delayMs = 0;
    await settle(a, b);
    const expected = "A1\nline2\nline3\nline4\nB5\n";
    expect(await read(a, "index.tsx")).toBe(expected);
    expect(await read(b, "index.tsx")).toBe(expected);
    expect(backend.text(PROJECT, "index.tsx")).toBe(expected);
  });

  it("converge when both edit the same line, and the side whose text lost keeps a copy out of the tree", async () => {
    const backend = new FakeBackend();
    const base = "line1\nline2\nline3\n";
    await backend.writeMany(PROJECT, [{ path: "index.tsx", text: base, hash: "x" }]);
    const conflictsA: ConflictNotice[] = [];
    const conflictsB: ConflictNotice[] = [];
    const a = await checkout("a", backend, { onConflict: (notice) => conflictsA.push(notice) });
    const b = await checkout("b", backend, { onConflict: (notice) => conflictsB.push(notice) });
    backend.delayMs = 40;
    await edit(a, "index.tsx", base.replace("line2", "from a"));
    await edit(b, "index.tsx", base.replace("line2", "from b"));
    await settle(a, b);
    backend.delayMs = 0;
    await settle(a, b);
    const final = await read(a, "index.tsx");
    expect(await read(b, "index.tsx")).toBe(final);
    expect(backend.text(PROJECT, "index.tsx")).toBe(final);
    expect(["line1\nfrom a\nline3\n", "line1\nfrom b\nline3\n"]).toContain(final);
    // The losing text is kept under .compound on the machine that merged it
    // away: not in the tree, and not sent to the cloud.
    const conflicts = [...conflictsA, ...conflictsB];
    expect(conflicts.length).toBeGreaterThan(0);
    const loser = final.includes("from a") ? "from b" : "from a";
    for (const conflict of conflicts) {
      expect(conflict.path).toBe("index.tsx");
      expect(conflict.keptCopy).toMatch(/\/\.compound\/conflicts\/index\.tsx\..*\.conflict$/);
      expect(await readFile(conflict.keptCopy, "utf8")).toContain(loser);
    }
    expect(backend.snapshot(PROJECT).some((file) => file.path.includes("conflict"))).toBe(false);
    expect(await folderText(a.dir)).toEqual(await folderText(b.dir));
  });

  it("lets the cloud win over a folder with no sync history, keeping the local text", async () => {
    const backend = new FakeBackend();
    await backend.writeMany(PROJECT, [{ path: "index.tsx", text: "cloud\n", hash: "x" }]);
    // A folder copied by hand: files present, no .compound/sync at all.
    const dir = join(root, "copied");
    await mkdir(dir);
    await writeFile(join(dir, "index.tsx"), "mine\n");
    const conflicts: ConflictNotice[] = [];
    const a = new WorkspaceSync({ dir, organizationId: PROJECT, backend, watch: false, coalesceMs: 5, onConflict: (notice) => conflicts.push(notice) });
    syncs.push(a);
    await a.start();
    await settle(a);
    expect(await read(a, "index.tsx")).toBe("cloud\n");
    expect(backend.text(PROJECT, "index.tsx")).toBe("cloud\n");
    expect(backend.version(PROJECT, "index.tsx")).toBe(1);
    expect(conflicts).toHaveLength(1);
    expect(await readFile(conflicts[0]!.keptCopy, "utf8")).toBe("mine\n");
  });

  it("refuses to sync a folder that is a checkout of another project", async () => {
    const backend = new FakeBackend();
    await backend.writeMany(PROJECT, [{ path: "index.tsx", text: "v1\n", hash: "x" }]);
    const a = await checkout("a", backend);
    await a.stop();
    syncs.splice(syncs.indexOf(a), 1);
    await writeFile(join(a.dir, "index.tsx"), "edited\n");
    const other = new WorkspaceSync({ dir: a.dir, organizationId: "org_other", backend, watch: false, coalesceMs: 5 });
    syncs.push(other);
    await expect(other.start()).rejects.toThrow(/different organization/);
    expect(other.status.state).toBe("error");
    expect(backend.snapshot("org_other")).toEqual([]);
    expect(backend.text(PROJECT, "index.tsx")).toBe("v1\n");
  });

  it("treats a file as clean after a restart that lost its base text", async () => {
    const backend = new FakeBackend();
    await backend.writeMany(PROJECT, [{ path: "index.tsx", text: "1\n2\n3\n", hash: "x" }]);
    const a = await checkout("a", backend);
    await a.stop();
    syncs.splice(syncs.indexOf(a), 1);
    await rm(join(a.dir, ".compound", "sync", "base"), { recursive: true, force: true });
    // A teammate changes line 2 while this checkout is closed.
    await backend.write(PROJECT, "index.tsx", "1\ntwo\n3\n", "y", 1);
    const conflicts: ConflictNotice[] = [];
    const again = new WorkspaceSync({ dir: a.dir, organizationId: PROJECT, backend, watch: false, coalesceMs: 5, onConflict: (notice) => conflicts.push(notice) });
    syncs.push(again);
    await again.start();
    await settle(again);
    expect(await read(again, "index.tsx")).toBe("1\ntwo\n3\n");
    expect(conflicts).toEqual([]);
    expect(backend.version(PROJECT, "index.tsx")).toBe(2);
  });

  it("reports files it cannot sync instead of silently skipping them", async () => {
    const backend = new FakeBackend();
    const a = await checkout("a", backend);
    await writeFile(join(a.dir, "index.tsx"), new Uint8Array([1, 0, 2]));
    a.noteChange("index.tsx");
    await settle(a);
    expect(a.status.skipped).toEqual(["index.tsx"]);
    await edit(a, "index.tsx", "text again\n");
    await settle(a);
    expect(a.status.skipped).toEqual([]);
    expect(backend.text(PROJECT, "index.tsx")).toBe("text again\n");
  });

  it("keeps an inspector write that lands while a cloud change is being applied, under the folder lock", async () => {
    const backend = new FakeBackend();
    const base = "1\n2\n3\n4\n5\n";
    await backend.writeMany(PROJECT, [{ path: "index.tsx", text: base, hash: "x" }]);
    const a = await checkout("a", backend);
    // The write-back reads, edits and writes under the same lock sync uses.
    const inspectorWrite = () => withProjectLock(a.dir, async () => {
      const current = await read(a, "index.tsx");
      await sleep(20);
      await writeFile(join(a.dir, "index.tsx"), current.replace("1", "one"));
    });
    await Promise.all([
      backend.write(PROJECT, "index.tsx", base.replace("5", "five"), "y", 1),
      inspectorWrite().then(() => a.noteChange("index.tsx")),
    ]);
    await settle(a);
    expect(await read(a, "index.tsx")).toBe("one\n2\n3\n4\nfive\n");
    expect(backend.text(PROJECT, "index.tsx")).toBe("one\n2\n3\n4\nfive\n");
  });

  it("converge over rounds of simultaneous edits", async () => {
    const backend = new FakeBackend();
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    await backend.writeMany(PROJECT, [{ path: "index.tsx", text: lines.join("\n") + "\n", hash: "x" }]);
    const a = await checkout("a", backend);
    const b = await checkout("b", backend);
    for (let round = 0; round < 6; round++) {
      // Each round both edit at the same moment, before either hears from the other.
      backend.delayMs = 40;
      const at = await read(a, "index.tsx");
      const bt = await read(b, "index.tsx");
      await edit(a, "index.tsx", at.replace(`line${round}`, `a${round}`));
      await edit(b, "index.tsx", bt.replace(`line${19 - round}`, `b${round}`));
      await settle(a, b);
      backend.delayMs = 0;
      await settle(a, b);
    }
    const final = await read(a, "index.tsx");
    expect(await read(b, "index.tsx")).toBe(final);
    expect(backend.text(PROJECT, "index.tsx")).toBe(final);
    for (let round = 0; round < 6; round++) {
      expect(final).toContain(`a${round}`);
      expect(final).toContain(`b${round}`);
    }
  });

  it("does not clobber a file the user writes while a cloud change is being applied", async () => {
    const backend = new FakeBackend();
    const base = "1\n2\n3\n4\n5\n";
    await backend.writeMany(PROJECT, [{ path: "index.tsx", text: base, hash: "x" }]);
    const a = await checkout("a", backend);
    // The cloud changes line 5 while, at the same instant, the user changes line 1.
    await backend.write(PROJECT, "index.tsx", base.replace("5", "five"), "y", 1);
    await writeFile(join(a.dir, "index.tsx"), base.replace("1", "one"));
    a.noteChange("index.tsx");
    await settle(a);
    const expected = "one\n2\n3\n4\nfive\n";
    expect(await read(a, "index.tsx")).toBe(expected);
    expect(backend.text(PROJECT, "index.tsx")).toBe(expected);
  });

  it("restore a file deleted on one side while edited on the other", async () => {
    const backend = new FakeBackend();
    await backend.writeMany(PROJECT, [{ path: "index.tsx", text: "v1\n", hash: "x" }]);
    const a = await checkout("a", backend);
    const b = await checkout("b", backend);
    backend.delayMs = 40;
    await remove(a, "index.tsx");
    await edit(b, "index.tsx", "v2\n");
    await settle(a, b);
    backend.delayMs = 0;
    await settle(a, b);
    expect(await read(a, "index.tsx")).toBe("v2\n");
    expect(await read(b, "index.tsx")).toBe("v2\n");
    expect(backend.text(PROJECT, "index.tsx")).toBe("v2\n");
  });

  it("propagate a delete, and a rename as delete plus create", async () => {
    const backend = new FakeBackend();
    await backend.writeMany(PROJECT, [{ path: "old.tsx", text: "x\n", hash: "x" }]);
    const a = await checkout("a", backend);
    const b = await checkout("b", backend);
    await remove(a, "old.tsx");
    await edit(a, "new.tsx", "x\n");
    await settle(a, b);
    expect(await exists(b, "old.tsx")).toBe(false);
    expect(await read(b, "new.tsx")).toBe("x\n");
    expect((await readdir(b.dir)).filter((name) => !name.startsWith("."))).toEqual(["new.tsx"]);
  });

  it("a fresh checkout after edits gets the merged result", async () => {
    const backend = new FakeBackend();
    await backend.writeMany(PROJECT, [{ path: "index.tsx", text: "1\n2\n3\n", hash: "x" }]);
    const a = await checkout("a", backend);
    await edit(a, "index.tsx", "one\n2\n3\n");
    await settle(a);
    const c = await checkout("c", backend);
    expect(await read(c, "index.tsx")).toBe("one\n2\n3\n");
  });
});

describe("with the folder watcher", () => {
  it.skipIf(process.platform === "linux")("picks up an outside edit without being told", async () => {
    const backend = new FakeBackend();
    await backend.writeMany(PROJECT, [{ path: "index.tsx", text: "v1\n", hash: "x" }]);
    const dir = join(root, "watched");
    await mkdir(dir);
    const a = new WorkspaceSync({ dir, organizationId: PROJECT, backend, coalesceMs: 20 });
    syncs.push(a);
    await a.start();
    await writeFile(join(dir, "index.tsx"), "edited by hand\n");
    const until = Date.now() + 4000;
    while (Date.now() < until && backend.text(PROJECT, "index.tsx") !== "edited by hand\n") await sleep(25);
    expect(backend.text(PROJECT, "index.tsx")).toBe("edited by hand\n");
  });
});
