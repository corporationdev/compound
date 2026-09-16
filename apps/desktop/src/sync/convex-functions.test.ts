// The engine against the real Convex functions, run in-process by
// convex-test: the same two-checkout scenarios as workspace-sync.test.ts, but
// with `files.write` / `files.remove` / `files.list` deciding versions and
// conflicts instead of the fake. Subscriptions are polled, since convex-test
// has no WebSocket; everything else is the code the app ships.

import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";

import schema from "../../../../packages/backend/convex/schema";
import { api, components } from "../../../../packages/backend/convex/_generated/api";
import { WorkspaceSync, collectSyncableFiles } from "./workspace-sync";
import type { RemoteFile, RemoteFileMeta, SyncBackend, WriteOutcome } from "./backend";

const backendDir = resolve(import.meta.dirname, "../../../../packages/backend/convex");
const componentDir = join(backendDir, "betterAuth");
const componentSchema = (await import(`${componentDir}/schema.ts`)).default;

async function modules(dir: string, ignore: string[] = []) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const paths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .filter((path) => !ignore.some((prefix) => path.startsWith(prefix)));
  return Object.fromEntries(paths.map((path) => [`${dir}/${path}`, () => import(`${dir}/${path}`)]));
}

type Harness = ReturnType<typeof convexTest>;
/** What `withIdentity` returns: the harness as one signed-in user. */
type Signed = ReturnType<Harness["withIdentity"]>;

async function member(t: Harness, email: string) {
  const now = Date.now();
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: { model: "user", data: { name: "Test", email, emailVerified: true, createdAt: now, updatedAt: now } },
  });
  const session = await t.mutation(components.betterAuth.adapter.create, {
    input: { model: "session", data: { userId: user!._id, token: crypto.randomUUID(), expiresAt: now + 60000, createdAt: now, updatedAt: now } },
  });
  return t.withIdentity({ subject: user!._id, sessionId: session!._id });
}

/**
 * `SyncBackend` over convex-test for one signed-in user. Every subscriber is
 * re-queried after any write through this or any sibling backend, which is
 * what the WebSocket would do.
 */
class HarnessBackend implements SyncBackend {
  private readonly subscribers = new Set<{ organizationId: string; deliver: () => Promise<void> }>();
  readonly as: Signed;
  private readonly peers: Set<HarnessBackend>;
  constructor(as: Signed, peers: Set<HarnessBackend>) {
    this.as = as;
    this.peers = peers;
    peers.add(this);
  }

  private async notifyAll(): Promise<void> {
    for (const peer of this.peers) for (const subscriber of peer.subscribers) await subscriber.deliver();
  }

  subscribe(organizationId: string, onSnapshot: (files: RemoteFileMeta[]) => void, onError: (error: Error) => void): () => void {
    const subscriber = {
      organizationId,
      deliver: async () => {
        try {
          const files = (await this.as.query(api.files.list, { organizationId })) as RemoteFileMeta[];
          onSnapshot(files);
        } catch (error) {
          // What the WebSocket client reports through its onError callback.
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      },
    };
    this.subscribers.add(subscriber);
    void subscriber.deliver();
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  fetch(organizationId: string, path: string): Promise<RemoteFile | null> {
    return this.as.query(api.files.get, { organizationId, path }) as Promise<RemoteFile | null>;
  }

  async removeMany(organizationId: string, paths: Array<{ path: string; expectedVersion: number }>): Promise<WriteOutcome[]> {
    const outcomes = (await this.as.mutation(api.files.removeMany, { organizationId, paths })) as WriteOutcome[];
    await this.notifyAll();
    return outcomes;
  }

  fetchMany(organizationId: string, paths: string[]): Promise<RemoteFile[]> {
    return this.as.query(api.files.getMany, { organizationId, paths }) as Promise<RemoteFile[]>;
  }

  async write(organizationId: string, path: string, text: string, hash: string, expectedVersion: number | null): Promise<WriteOutcome> {
    const outcome = (await this.as.mutation(api.files.write, { organizationId, path, text, hash, expectedVersion })) as WriteOutcome;
    await this.notifyAll();
    return outcome;
  }

  async remove(organizationId: string, path: string, expectedVersion: number): Promise<WriteOutcome> {
    const outcome = (await this.as.mutation(api.files.remove, { organizationId, path, expectedVersion })) as WriteOutcome;
    await this.notifyAll();
    return outcome;
  }

  async writeMany(organizationId: string, files: Array<{ path: string; text: string; hash: string }>): Promise<void> {
    await this.as.mutation(api.files.writeMany, { organizationId, files });
    await this.notifyAll();
  }
}

let root: string;
const syncs: WorkspaceSync[] = [];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sync-convex-"));
});

afterEach(async () => {
  await Promise.all(syncs.splice(0).map((sync) => sync.stop()));
  await rm(root, { recursive: true, force: true });
});

async function settle(...all: WorkspaceSync[]): Promise<void> {
  for (let round = 0; round < 60; round++) {
    await Promise.all(all.map((sync) => sync.idle()));
    await sleep(10);
    if (all.every((sync) => sync.status.state === "synced")) {
      await Promise.all(all.map((sync) => sync.idle()));
      if (all.every((sync) => sync.status.state === "synced")) return;
    }
  }
}

async function checkout(name: string, backend: SyncBackend, organizationId: string): Promise<WorkspaceSync> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const sync = new WorkspaceSync({ dir, organizationId, backend, watch: false, coalesceMs: 5, retryBaseMs: 20 });
  syncs.push(sync);
  await sync.start();
  return sync;
}

async function edit(sync: WorkspaceSync, path: string, text: string): Promise<void> {
  await writeFile(join(sync.dir, path), text);
  sync.noteChange(path);
}

const read = (sync: WorkspaceSync, path: string): Promise<string> => readFile(join(sync.dir, path), "utf8");

async function setup() {
  const t = convexTest(schema, await modules(backendDir, ["betterAuth/"]));
  t.registerComponent("betterAuth", componentSchema, await modules(componentDir));
  const alice = await member(t, "alice@example.com");
  const { id: organizationId } = await alice.mutation(api.organizations.ensurePersonal, {});
  const bob = await member(t, "bob@example.com");
  await t.mutation(components.betterAuth.adapter.create, {
    input: { model: "member", data: { organizationId, userId: (await bob.query(api.auth.getCurrentUser, {}))!.id, role: "member", createdAt: Date.now() } },
  });
  const peers = new Set<HarnessBackend>();
  return { t, organizationId, alice: new HarnessBackend(alice, peers), bob: new HarnessBackend(bob, peers), outsider: new HarnessBackend(await member(t, "eve@example.com"), new Set()) };
}

describe("sync engine over the Convex functions", () => {
  it("pushes from one member and checks out for another", async () => {
    const { organizationId, alice, bob } = await setup();
    const a = await checkout("a", alice, organizationId);
    await edit(a, "index.tsx", "export default () => <stage />;\n");
    await edit(a, "package.json", "{}\n");
    await settle(a);
    const b = await checkout("b", bob, organizationId);
    expect(await read(b, "index.tsx")).toBe("export default () => <stage />;\n");
    expect((await collectSyncableFiles(b.dir)).map((file) => file.path).sort()).toEqual(["index.tsx", "package.json"]);
  });

  it("merges concurrent edits to different lines through real version checks", async () => {
    const { organizationId, alice, bob } = await setup();
    const base = "1\n2\n3\n4\n5\n";
    await alice.writeMany(organizationId, [{ path: "index.tsx", text: base, hash: "" }]).catch(() => { });
    const a = await checkout("a", alice, organizationId);
    await edit(a, "index.tsx", base);
    await settle(a);
    const b = await checkout("b", bob, organizationId);
    await settle(a, b);
    // Each edits its own copy before the other's push lands: the second push
    // is refused by the mutation's version check and merged.
    await Promise.all([
      edit(a, "index.tsx", base.replace("1", "one")),
      edit(b, "index.tsx", base.replace("5", "five")),
    ]);
    await settle(a, b);
    expect(await read(a, "index.tsx")).toBe("one\n2\n3\n4\nfive\n");
    expect(await read(b, "index.tsx")).toBe("one\n2\n3\n4\nfive\n");
  });

  it("propagates a delete as a tombstone the other checkout honours", async () => {
    const { organizationId, alice, bob } = await setup();
    const a = await checkout("a", alice, organizationId);
    await edit(a, "old.tsx", "x\n");
    await settle(a);
    const b = await checkout("b", bob, organizationId);
    await settle(a, b);
    await rm(join(a.dir, "old.tsx"));
    a.noteChange("old.tsx");
    await settle(a, b);
    await expect(read(b, "old.tsx")).rejects.toThrow();
    const rows = (await alice.as.query(api.files.list, { organizationId })) as RemoteFileMeta[];
    expect(rows).toEqual([expect.objectContaining({ path: "old.tsx", deleted: true, version: 2 })]);
  });

  it("refuses a checkout for someone outside the organization", async () => {
    const { organizationId, outsider } = await setup();
    const dir = join(root, "eve");
    await mkdir(dir);
    const sync = new WorkspaceSync({ dir, organizationId, backend: outsider, watch: false });
    syncs.push(sync);
    await expect(sync.start()).rejects.toThrow(/member/);
    expect(await collectSyncableFiles(dir)).toEqual([]);
    expect(sync.status.state).toBe("error");
  });
});
