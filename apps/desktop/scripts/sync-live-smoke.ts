// Two checkouts of one organization's workspace, against a real Convex deployment.
//
// A manual check of the whole path the app uses — signed native session →
// JWT from the auth server → WebSocket subscription → versioned writes —
// which the unit tests cannot reach. Needs a signed native session token,
// the credential the desktop app keeps in localStorage under
// `compound:<authUrl>:native-session`:
//
//   COMPOUND_SESSION_TOKEN=<token.signature> bun apps/desktop/scripts/sync-live-smoke.ts
//
// Reads the deployment from apps/desktop/runtime-config.json. Writes under a
// folder named smoke-<time> in the caller's first organization's workspace,
// drives two engines through concurrent edits and a delete, prints the
// outcome, and removes the folder.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvexClient } from "convex/browser";
import { api } from "@compound/backend/convex/_generated/api";

import { ConvexSyncBackend } from "../src/sync/convex-backend";
import { WorkspaceSync } from "../src/sync/workspace-sync";

const sessionToken = process.env.COMPOUND_SESSION_TOKEN;
if (!sessionToken) throw new Error("Set COMPOUND_SESSION_TOKEN to a signed native session token");

const config = JSON.parse(await readFile(new URL("../runtime-config.json", import.meta.url), "utf8")) as { convexUrl: string; authUrl: string };

async function fetchToken(): Promise<string | null> {
  const response = await fetch(`${config.authUrl}/api/auth/convex/token`, {
    headers: { Origin: "compound://", Authorization: `Bearer ${sessionToken}` },
  });
  if (!response.ok) throw new Error(`token: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { token?: string }).token ?? null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const read = (dir: string, path: string): Promise<string> => readFile(join(dir, path), "utf8");

async function settle(...all: WorkspaceSync[]): Promise<void> {
  for (let round = 0; round < 200; round++) {
    await Promise.all(all.map((sync) => sync.idle()));
    await sleep(50);
    if (all.every((sync) => sync.status.state === "synced")) return;
  }
  throw new Error(`did not settle: ${all.map((sync) => JSON.stringify(sync.status)).join(" ")}`);
}

const control = new ConvexClient(config.convexUrl, { unsavedChangesWarning: false });
control.setAuth(fetchToken);
const me = await control.query(api.auth.getCurrentUser, {});
console.log("signed in as", me?.email);
let organizations = await control.query(api.organizations.listMine, {});
if (organizations.length === 0) {
  await control.mutation(api.organizations.ensurePersonal, {});
  organizations = await control.query(api.organizations.listMine, {});
}
console.log("organizations", organizations.map((organization) => `${organization.name} (${organization.role})`));
const organizationId = organizations[0]!.id;
// Everything the run writes sits under one folder of the workspace, cleared at the end.
const folder = `smoke-${new Date().toISOString().slice(11, 19).replace(/:/g, "-")}`;
console.log("workspace folder", folder);

const backendA = new ConvexSyncBackend(config.convexUrl, fetchToken);
const backendB = new ConvexSyncBackend(config.convexUrl, fetchToken);
const dirA = await mkdtemp(join(tmpdir(), "smoke-a-"));
const dirB = await mkdtemp(join(tmpdir(), "smoke-b-"));
const a = new WorkspaceSync({ dir: dirA, organizationId, backend: backendA, coalesceMs: 50, onStatus: (status) => console.log("  A", status.state, status.pending) });
const b = new WorkspaceSync({ dir: dirB, organizationId, backend: backendB, coalesceMs: 50, onStatus: (status) => console.log("  B", status.state, status.pending) });

try {
  await a.start();
  const base = "line1\nline2\nline3\nline4\nline5\n";
  await mkdir(join(dirA, folder), { recursive: true });
  await writeFile(join(dirA, folder, "index.tsx"), base);
  await writeFile(join(dirA, folder, "package.json"), JSON.stringify({ name: folder, projectId: "smoke", main: "index.tsx" }, null, 2) + "\n");
  await settle(a);
  console.log("A published", (await backendA.client.query(api.files.list, { organizationId })).filter((file) => file.path.startsWith(folder)).map((file) => `${file.path}@${file.version}`));

  await b.start();
  await settle(b);
  console.log("B materialized index.tsx ==", (await read(dirB, `${folder}/index.tsx`)) === base);

  // Concurrent edits to different lines, from two machines.
  await Promise.all([
    writeFile(join(dirA, folder, "index.tsx"), base.replace("line1", "A1")),
    writeFile(join(dirB, folder, "index.tsx"), base.replace("line5", "B5")),
  ]);
  await settle(a, b);
  const merged = await read(dirA, `${folder}/index.tsx`);
  console.log("merged equal on both:", merged === (await read(dirB, `${folder}/index.tsx`)), JSON.stringify(merged));
  if (merged !== "A1\nline2\nline3\nline4\nB5\n") throw new Error("merge lost an edit");

  // A delete from B reaches A.
  await rm(join(dirB, folder, "package.json"));
  await settle(a, b);
  const gone = await read(dirA, `${folder}/package.json`).then(() => false, () => true);
  console.log("delete propagated:", gone);
  if (!gone) throw new Error("delete did not propagate");
  console.log("PASS");
} finally {
  await a.stop();
  await b.stop();
  await backendA.close();
  await backendB.close();
  // Leave the workspace as it was: the folder's rows become tombstones.
  await rm(join(dirA, folder), { recursive: true, force: true }).catch(() => { });
  await control.close();
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
}
