/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createSignal } from "solid-js";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/auth";
import {
  activeOrganization,
  activeOrganizationId,
  addMemberByEmail,
  canManageMembers,
  createOrganization,
  organizations,
  organizationsError,
  setActiveOrganization,
  type MemberRole,
} from "@/lib/organizations";

import { DashboardDividedStack, DashboardSurfaceSection } from "./shared";

const inputClass = "rounded-md border border-border bg-input p-2 text-xs";

/**
 * The signed-in user's organizations: which one the dashboard shows projects
 * for, a new one, and — for owners and admins — a member added by the email
 * of an existing account. Nothing while signed out.
 */
export function DashboardOrganizationSection() {
  const auth = useAuth();

  const [newName, setNewName] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const [createError, setCreateError] = createSignal("");

  const [memberEmail, setMemberEmail] = createSignal("");
  const [memberRole, setMemberRole] = createSignal<MemberRole>("member");
  const [adding, setAdding] = createSignal(false);
  const [memberMessage, setMemberMessage] = createSignal("");
  const [memberError, setMemberError] = createSignal("");

  const handleCreate = async (event: SubmitEvent) => {
    event.preventDefault();
    const name = newName().trim();
    if (!name || creating()) return;
    setCreating(true);
    setCreateError("");
    try {
      await createOrganization(name);
      setNewName("");
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Could not create organization");
    } finally {
      setCreating(false);
    }
  };

  const handleAddMember = async (event: SubmitEvent) => {
    event.preventDefault();
    const organizationId = activeOrganizationId();
    const email = memberEmail().trim();
    if (!organizationId || !email || adding()) return;
    setAdding(true);
    setMemberError("");
    setMemberMessage("");
    try {
      await addMemberByEmail(organizationId, email, memberRole());
      setMemberMessage(`Added ${email} as ${memberRole()}.`);
      setMemberEmail("");
    } catch (error) {
      setMemberError(error instanceof Error ? error.message : "Could not add member");
    } finally {
      setAdding(false);
    }
  };

  return (
    <Show when={auth.isAuthenticated()}>
      <DashboardSurfaceSection title="Organization" description="Cloud projects belong to an organization; everyone in it can open and edit them.">
        <DashboardDividedStack>
          <div class="flex flex-col gap-2">
            <p class="text-xs text-foreground">Current organization</p>
            <Show when={organizationsError()}>
              <p class="text-xs text-destructive">{organizationsError()}</p>
            </Show>
            <Show when={organizations()} fallback={<p class="text-xs text-muted-foreground">Loading…</p>}>
              {(list) => (
                <div role="radiogroup" aria-label="Current organization" class="flex flex-col gap-1">
                  <For each={list()}>
                    {(organization) => (
                      <label class="flex cursor-pointer items-center gap-2 text-xs">
                        <input
                          type="radio"
                          name="active-organization"
                          value={organization.id}
                          checked={activeOrganizationId() === organization.id}
                          onChange={() => setActiveOrganization(organization.id)}
                        />
                        <span class="text-foreground">{organization.name}</span>
                        <span class="text-muted-foreground">{organization.role}</span>
                      </label>
                    )}
                  </For>
                </div>
              )}
            </Show>
          </div>

          <form class="flex flex-col gap-2" onSubmit={(event) => void handleCreate(event)}>
            <label class="flex flex-col gap-2 text-xs">
              Create organization
              <div class="flex items-center gap-2">
                <input
                  class={`${inputClass} flex-1`}
                  value={newName()}
                  onInput={(event) => setNewName(event.currentTarget.value)}
                  placeholder="Organization name"
                  maxLength={100}
                  required
                />
                <Button type="submit" variant="secondary" disabled={creating() || !newName().trim()}>
                  Create
                </Button>
              </div>
            </label>
            <Show when={createError()}>
              <p class="text-xs text-destructive">{createError()}</p>
            </Show>
          </form>

          <Show when={canManageMembers(activeOrganization()?.role)}>
            <form class="flex flex-col gap-2" onSubmit={(event) => void handleAddMember(event)}>
              <label class="flex flex-col gap-2 text-xs">
                Add member to {activeOrganization()?.name}
                <div class="flex items-center gap-2">
                  <input
                    class={`${inputClass} flex-1`}
                    type="email"
                    value={memberEmail()}
                    onInput={(event) => setMemberEmail(event.currentTarget.value)}
                    placeholder="teammate@example.com"
                    required
                  />
                  <select
                    class={inputClass}
                    aria-label="Role"
                    value={memberRole()}
                    onChange={(event) => setMemberRole(event.currentTarget.value as MemberRole)}
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                  <Button type="submit" variant="secondary" disabled={adding() || !memberEmail().trim()}>
                    Add
                  </Button>
                </div>
              </label>
              <p class="text-xs text-muted-foreground">They need a Compound account under that email already.</p>
              <Show when={memberError()}>
                <p class="text-xs text-destructive">{memberError()}</p>
              </Show>
              <Show when={memberMessage()}>
                <p role="status" class="text-xs text-foreground">{memberMessage()}</p>
              </Show>
            </form>
          </Show>
        </DashboardDividedStack>
      </DashboardSurfaceSection>
    </Show>
  );
}
