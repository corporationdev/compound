/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The signed-in user's organizations, live from Convex, and which one the
// dashboard is looking at. One store for the app: the auth context tells it
// who is signed in (`setCloudUser`), and everything else reads signals.

import { createMemo, createRoot, createSignal } from 'solid-js';
import { api } from '@compound/backend/convex/_generated/api';
import { convex } from './auth-client';
import { canManageMembers, pickActiveOrganization, type OrganizationSummary } from './cloud-logic';

export { canManageMembers, pickActiveOrganization };
export type Organization = OrganizationSummary;
export type MemberRole = 'member' | 'admin';

const ACTIVE_STORAGE_KEY = 'compound:active-organization';

const readStored = (): string | null => {
  try {
    return window.localStorage.getItem(ACTIVE_STORAGE_KEY);
  } catch {
    return null;
  }
};

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

const requireConvex = () => {
  if (!convex) throw new Error('Cloud is not configured.');
  return convex;
};

const store = createRoot(() => {
  const [cloudUserId, setCloudUserId] = createSignal<string | null>(null);
  // null while unknown: signed out, or the first snapshot has not landed.
  const [organizations, setOrganizations] = createSignal<Organization[] | null>(null);
  const [organizationsError, setOrganizationsError] = createSignal<string | null>(null);
  const [remembered, setRemembered] = createSignal<string | null>(readStored());

  const activeOrganizationId = createMemo(() => pickActiveOrganization(organizations(), remembered()));
  const activeOrganization = createMemo(() => {
    const id = activeOrganizationId();
    return id ? (organizations() ?? []).find((organization) => organization.id === id) ?? null : null;
  });
  /** Signed in, with an organization to put projects in. */
  const cloudReady = createMemo(() => !!cloudUserId() && !!activeOrganizationId());

  return {
    cloudUserId,
    setCloudUserId,
    organizations,
    setOrganizations,
    organizationsError,
    setOrganizationsError,
    remembered,
    setRemembered,
    activeOrganizationId,
    activeOrganization,
    cloudReady,
  };
});

export const {
  cloudUserId,
  organizations,
  organizationsError,
  activeOrganizationId,
  activeOrganization,
  cloudReady,
} = store;

let unsubscribe: (() => void) | undefined;
let ensuredPersonal = false;

/**
 * Follows the signed-in user: subscribes to their organizations, and drops
 * the subscription (and the list) when they sign out. Called by the auth
 * context after `convex.setAuth`, so the subscription runs authenticated.
 */
export function setCloudUser(userId: string | null): void {
  if (userId === store.cloudUserId()) return;
  unsubscribe?.();
  unsubscribe = undefined;
  ensuredPersonal = false;
  store.setCloudUserId(userId);
  store.setOrganizations(null);
  store.setOrganizationsError(null);
  if (!userId || !convex) return;

  const client = convex;
  unsubscribe = client.onUpdate(
    api.organizations.listMine,
    {},
    (list) => {
      store.setOrganizations(list);
      store.setOrganizationsError(null);
      // An account from before organizations existed has none; ask for the
      // personal one once, and the subscription delivers it.
      if (list.length === 0 && !ensuredPersonal) {
        ensuredPersonal = true;
        client.mutation(api.organizations.ensurePersonal, {}).catch((error) => {
          store.setOrganizationsError(errorMessage(error, 'Could not create your organization'));
        });
      }
    },
    (error) => store.setOrganizationsError(errorMessage(error, 'Could not load organizations')),
  );
}

/** Makes `id` the active organization, remembered across launches. */
export function setActiveOrganization(id: string): void {
  store.setRemembered(id);
  try {
    window.localStorage.setItem(ACTIVE_STORAGE_KEY, id);
  } catch (error) {
    console.warn('[cloud] could not remember the active organization', error);
  }
}

/** Creates an organization the caller owns and makes it active. */
export async function createOrganization(name: string): Promise<string> {
  const { id } = await requireConvex().action(api.organizations.create, { name });
  setActiveOrganization(id);
  return id;
}

/** Adds an existing account to the organization; the caller must be an owner or admin. */
export async function addMemberByEmail(
  organizationId: string,
  email: string,
  role: MemberRole = 'member',
): Promise<void> {
  await requireConvex().action(api.organizations.addMemberByEmail, { organizationId, email, role });
}
