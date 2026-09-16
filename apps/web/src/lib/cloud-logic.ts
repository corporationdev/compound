/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The pure parts of the cloud stores, kept apart from the Convex client and
// the desktop bridge so they can be tested without a window. Re-exported by
// `organizations.ts` and `cloud-projects.ts`, which are where callers get them.

export type OrganizationSummary = { id: string; name: string; slug: string; role: string };

/**
 * Which organization is active: the remembered one while the user still
 * belongs to it, else the first on the list, else none. `organizations` is
 * null while the list is unknown, which answers null rather than guessing.
 */
export function pickActiveOrganization(
  organizations: readonly OrganizationSummary[] | null,
  remembered: string | null,
): string | null {
  if (!organizations || organizations.length === 0) return null;
  if (remembered && organizations.some((organization) => organization.id === remembered)) return remembered;
  return organizations[0]!.id;
}

/** Whether `role` may add members. Better Auth's roles are comma-separated when a member holds several. */
export function canManageMembers(role: string | undefined): boolean {
  if (!role) return false;
  return role.split(',').some((part) => part.trim() === 'owner' || part.trim() === 'admin');
}

/**
 * Pairs cloud projects with the local checkouts that carry their id. Records
 * are taken in the order given (most recently opened first, as `listProjects`
 * answers), so a cloud project checked out twice pairs with the one that was
 * open last. Records for no listed cloud project are left out.
 */
export function matchCloudToLocal<
  Cloud extends { _id: string },
  Local extends { cloudProjectId?: string },
>(cloudProjects: readonly Cloud[], records: readonly Local[]): Map<string, Local> {
  const ids = new Set(cloudProjects.map((project) => project._id));
  const matches = new Map<string, Local>();
  for (const record of records) {
    const id = record.cloudProjectId;
    if (!id || !ids.has(id) || matches.has(id)) continue;
    matches.set(id, record);
  }
  return matches;
}
