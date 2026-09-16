/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";

import { api } from "@compound/backend/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { convex } from "@/lib/auth-client";
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogPortal, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/auth";
import {
  activeOrganization,
  activeOrganizationId,
  addMemberByEmail,
  canManageMembers,
  organizationsError,
  type MemberRole,
} from "@/lib/organizations";

import { DashboardDividedStack, DashboardSurfaceSection } from "./shared";

const inputClass = "rounded-md border border-border bg-input p-2 text-xs";

type OrganizationMember = FunctionReturnType<typeof api.organizations.listMembers>[number];

/** Member management follows the organization selected in the sidebar. */
export function DashboardOrganizationSection() {
  const auth = useAuth();
  const [members, setMembers] = createSignal<OrganizationMember[] | null>(null);
  const [listError, setListError] = createSignal("");
  const [removing, setRemoving] = createSignal(false);
  const [removeTarget, setRemoveTarget] = createSignal<OrganizationMember | null>(null);
  const [removeError, setRemoveError] = createSignal("");

  const [memberEmail, setMemberEmail] = createSignal("");
  const [memberRole, setMemberRole] = createSignal<MemberRole>("member");
  const [adding, setAdding] = createSignal(false);
  const [memberMessage, setMemberMessage] = createSignal("");
  const [memberError, setMemberError] = createSignal("");

  createEffect(() => {
    const organizationId = activeOrganizationId();
    setMembers(null);
    setListError("");
    setMemberEmail("");
    setMemberRole("member");
    setMemberError("");
    setMemberMessage("");
    setRemoveTarget(null);
    setRemoveError("");
    if (!organizationId || !convex) return;
    const unsubscribe = convex.onUpdate(api.organizations.listMembers, { organizationId },
      (list) => { setMembers(list); setListError(""); },
      (error) => setListError(error.message || "Could not load members"),
    );
    onCleanup(unsubscribe);
  });

  const handleRemove = async () => {
    const organizationId = activeOrganizationId();
    const target = removeTarget();
    if (!organizationId || !target || !convex || removing()) return;
    setRemoving(true);
    setRemoveError("");
    try {
      await convex.mutation(api.organizations.removeMember, { organizationId, memberId: target.id });
      if (activeOrganizationId() === organizationId) setRemoveTarget(null);
    } catch (error) {
      if (activeOrganizationId() === organizationId)
        setRemoveError(error instanceof Error ? error.message : "Could not remove member");
    } finally {
      setRemoving(false);
    }
  };

  const handleAddMember = async (event: SubmitEvent) => {
    event.preventDefault();
    const organizationId = activeOrganizationId();
    const email = memberEmail().trim();
    if (!organizationId || !email || adding()) return;
    const role = memberRole();
    setAdding(true);
    setMemberError("");
    setMemberMessage("");
    try {
      await addMemberByEmail(organizationId, email, role);
      if (activeOrganizationId() === organizationId) {
        setMemberMessage(`Added ${email} as ${role}.`);
        setMemberEmail("");
      }
    } catch (error) {
      if (activeOrganizationId() === organizationId)
        setMemberError(error instanceof Error ? error.message : "Could not add member");
    } finally {
      setAdding(false);
    }
  };

  return (
    <Show when={auth.isAuthenticated()}>
      <DashboardSurfaceSection title="Organization" description="Manage who can access this organization’s projects and documents.">
        <DashboardDividedStack>
          <div class="flex flex-col gap-3">
            <div class="flex items-center justify-between gap-2 text-xs">
              <span class="font-450 text-foreground">{activeOrganization()?.name ?? "Loading organization…"}</span>
              <span class="text-muted-foreground">{activeOrganization()?.role}</span>
            </div>
            <Show when={organizationsError() || listError()}>
              <p role="alert" class="text-xs text-destructive">{organizationsError() || listError()}</p>
            </Show>
            <Show when={members()} fallback={<Show when={!listError()}><p class="text-xs text-muted-foreground">Loading members…</p></Show>}>
              {(list) => (
                <div class="flex flex-col divide-y divide-border">
                  <For each={list()}>
                    {(member) => (
                      <div class="flex items-center gap-3 py-3">
                        <span class="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-xs text-foreground">{(member.name || member.email).charAt(0).toUpperCase()}</span>
                        <div class="min-w-0 flex-1 text-xs">
                          <p class="truncate text-foreground">{member.name || member.email}{member.userId === auth.user()?.id ? " (you)" : ""}</p>
                          <p class="truncate text-muted-foreground">{member.email}</p>
                        </div>
                        <span class="text-xs text-muted-foreground">{member.role}</span>
                        <Show when={canManageMembers(activeOrganization()?.role) && member.userId !== auth.user()?.id && !member.role.split(",").some((role) => role.trim() === "owner")}>
                          <Button variant="ghost" aria-label={`Remove ${member.name || member.email}`} onClick={() => { setRemoveError(""); setRemoveTarget(member); }}>Remove</Button>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </Show>
            <Show when={activeOrganization() && !canManageMembers(activeOrganization()?.role)}>
              <p class="text-xs text-muted-foreground">Only owners and admins can add or remove members.</p>
            </Show>
          </div>

          <Show when={canManageMembers(activeOrganization()?.role)}>
            <form class="flex flex-col gap-2" onSubmit={(event) => void handleAddMember(event)}>
              <label class="flex flex-col gap-2 text-xs">
                Add member to {activeOrganization()?.name}
                <div class="flex items-center gap-2">
                  <input
                    class={`${inputClass} min-w-0 flex-1`} disabled={adding()}
                    type="email"
                    value={memberEmail()}
                    onInput={(event) => setMemberEmail(event.currentTarget.value)}
                    placeholder="teammate@example.com"
                    required
                  />
                  <select
                    class={inputClass}
                    aria-label="Role"
                    disabled={adding()}
                    value={memberRole()}
                    onChange={(event) => setMemberRole(event.currentTarget.value as MemberRole)}
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                  <Button type="submit" variant="secondary" disabled={adding() || !memberEmail().trim()}>
                    {adding() ? "Adding…" : "Add"}
                  </Button>
                </div>
              </label>
              <p class="text-xs text-muted-foreground">They need a Compound account under that email already.</p>
              <Show when={memberError()}>
                <p role="alert" class="text-xs text-destructive">{memberError()}</p>
              </Show>
              <Show when={memberMessage()}>
                <p role="status" class="text-xs text-foreground">{memberMessage()}</p>
              </Show>
            </form>
          </Show>
        </DashboardDividedStack>
      </DashboardSurfaceSection>
      <AlertDialog open={removeTarget() !== null} onOpenChange={(open) => { if (!open && !removing()) setRemoveTarget(null); }}>
        <AlertDialogPortal>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove member</AlertDialogTitle>
              <AlertDialogDescription>
                {removeTarget()?.name || removeTarget()?.email} will lose access to {activeOrganization()?.name}'s projects and documents. You can add them again later.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Show when={removeError()}><p role="alert" class="text-xs text-destructive">{removeError()}</p></Show>
            <AlertDialogFooter>
              <Button variant="secondary" disabled={removing()} onClick={() => setRemoveTarget(null)}>Cancel</Button>
              <Button variant="destructive" disabled={removing()} onClick={() => void handleRemove()}>{removing() ? "Removing…" : "Remove member"}</Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogPortal>
      </AlertDialog>
    </Show>
  );
}
