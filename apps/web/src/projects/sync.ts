/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The renderer's side of cloud sync. Main runs the engine per folder; this
// starts and stops it, publishes local folders, gives cloud projects a folder
// here, and keeps each folder's status as a signal for the editor to show.

import { createSignal } from 'solid-js';
import { toast } from 'somoto';

import { MAIN_CHANNELS } from '@desktop/main-channels';
import type { ProjectInfo, SyncStatus } from '@desktop/main-channels';
import { mainBridge } from '@/lib/ipc';
import { addProjectRecords, listProjectRecords } from '@/lib/db';
import { requireNativeSessionToken } from '@/lib/cloud-session';
import { createCloudProject, type CloudProject } from '@/lib/cloud-projects';

import { ensureProjectsRoot, getProject, markProjectsChanged, refreshProject } from './host';

export type { SyncStatus };

const [statuses, setStatuses] = createSignal<Record<string, SyncStatus>>({});

const putStatus = (dir: string, status: SyncStatus | null): void => {
  setStatuses((current) => {
    const next = { ...current };
    if (status) next[dir] = status;
    else delete next[dir];
    return next;
  });
};

/** What sync is doing for the folder `dir`; null for a folder that is not syncing. */
export const syncStatus = (dir: string): SyncStatus | null => statuses()[dir] ?? null;

// One handler per event channel, for the life of the app: main reports for
// every syncing folder, and the signal map sorts them by folder.
mainBridge.handle(MAIN_CHANNELS.SYNC_STATUS, ({ dir, status }) => putStatus(dir, status));
mainBridge.handle(MAIN_CHANNELS.SYNC_CONFLICT, ({ path, keptCopy }) => {
  toast.warning(`Merged a teammate's change to ${path}`, {
    description: `Their version of the conflicting lines was kept at ${keptCopy}`,
    duration: 12_000,
  });
});

/** Keeps `dir` in step with the cloud project `cloudProjectId`; idempotent for a folder already syncing it. */
export async function startProjectSync(dir: string, cloudProjectId: string): Promise<SyncStatus> {
  const sessionToken = await requireNativeSessionToken();
  putStatus(dir, { state: 'starting', pending: 0, skipped: [] });
  try {
    const status = await mainBridge.call(MAIN_CHANNELS.SYNC_START, { dir, projectId: cloudProjectId, sessionToken });
    putStatus(dir, status);
    return status;
  } catch (error) {
    putStatus(dir, { state: 'error', pending: 0, skipped: [], error: (error as Error).message });
    throw error;
  }
}

export async function stopProjectSync(dir: string): Promise<void> {
  try {
    await mainBridge.call(MAIN_CHANNELS.SYNC_STOP, { dir });
  } finally {
    putStatus(dir, null);
  }
}

/**
 * Makes a local project a cloud one: a project row in the active
 * organization named after it, its files pushed up, and sync running on
 * the folder from then on. The record picks up its `cloudProjectId` from
 * package.json, which main wrote on the way.
 */
export async function publishProject(project: ProjectInfo): Promise<ProjectInfo> {
  const sessionToken = await requireNativeSessionToken();
  const projectId = await createCloudProject(project.displayName);
  const { status } = await mainBridge.call(MAIN_CHANNELS.SYNC_PUBLISH, { dir: project.dir, projectId, sessionToken });
  putStatus(project.dir, status);
  return (await refreshProject(project.dir)) ?? { ...project, cloudProjectId: projectId };
}

/**
 * The folder for a cloud project on this machine: the checkout already on
 * the list, or a new folder under the projects root that main fills from
 * the cloud and keeps in step. The answer goes to the same open path a
 * local card takes.
 */
export async function openCloudProject(project: CloudProject): Promise<ProjectInfo> {
  const sessionToken = await requireNativeSessionToken();

  for (const record of await listProjectRecords()) {
    if (record.cloudProjectId !== project._id) continue;
    // A folder that has gone (a disconnected disk) is not the checkout any more.
    const current = await getProject(record.dir);
    if (current) return current;
  }

  const root = await ensureProjectsRoot();
  if (!root) throw new Error('Choose a projects folder first.');
  const info = await mainBridge.call(MAIN_CHANNELS.SYNC_MATERIALIZE, {
    root,
    projectId: project._id,
    name: project.name,
    sessionToken,
  });
  await addProjectRecords([info]);
  markProjectsChanged();
  try {
    const status = await mainBridge.call(MAIN_CHANNELS.SYNC_STATUS_GET, { dir: info.dir });
    if (status) putStatus(info.dir, status);
  } catch {
    // The status event will say.
  }
  return info;
}
