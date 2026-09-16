/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The active organization's projects, live from Convex. Re-subscribes when
// the active organization changes; empty while there is none.

import { createEffect, createRoot, createSignal, onCleanup } from 'solid-js';
import { api } from '@compound/backend/convex/_generated/api';
import type { FunctionReturnType } from 'convex/server';
import type { Id } from '@compound/backend/convex/_generated/dataModel';
import { convex } from './auth-client';
import { matchCloudToLocal } from './cloud-logic';
import { activeOrganizationId } from './organizations';

export { matchCloudToLocal };

export type CloudProject = FunctionReturnType<typeof api.projects.list>[number];
export type CloudProjectId = Id<'projects'>;

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

const requireConvex = () => {
  if (!convex) throw new Error('Cloud is not configured.');
  return convex;
};

const store = createRoot(() => {
  // null while there is no organization, or its first snapshot is still on its way.
  const [cloudProjects, setCloudProjects] = createSignal<CloudProject[] | null>(null);
  const [cloudProjectsError, setCloudProjectsError] = createSignal<string | null>(null);

  createEffect(() => {
    const organizationId = activeOrganizationId();
    setCloudProjects(null);
    setCloudProjectsError(null);
    if (!organizationId || !convex) return;

    const unsubscribe = convex.onUpdate(
      api.projects.list,
      { organizationId },
      (list) => {
        setCloudProjects([...list].sort((a, b) => b.updatedAt - a.updatedAt));
        setCloudProjectsError(null);
      },
      (error) => setCloudProjectsError(errorMessage(error, 'Could not load cloud projects')),
    );
    onCleanup(unsubscribe);
  });

  return { cloudProjects, cloudProjectsError };
});

export const { cloudProjects, cloudProjectsError } = store;

/** Creates an empty project in the active organization; publishing fills it. */
export async function createCloudProject(name: string): Promise<CloudProjectId> {
  const organizationId = activeOrganizationId();
  if (!organizationId) throw new Error('Choose an organization first.');
  const { projectId } = await requireConvex().mutation(api.projects.create, { organizationId, name });
  return projectId;
}

export async function renameCloudProject(projectId: CloudProjectId, name: string): Promise<void> {
  await requireConvex().mutation(api.projects.rename, { projectId, name });
}

export async function archiveCloudProject(projectId: CloudProjectId): Promise<void> {
  await requireConvex().mutation(api.projects.archive, { projectId });
}
