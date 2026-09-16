/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createSignal } from "solid-js";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogPortal, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuGroupLabel,
  DropdownMenuItem, DropdownMenuPortal, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { useAuth } from "@/context/auth";
import { useAvatar } from "@/hooks/use-avatar";
import {
  activeOrganization, activeOrganizationId, createOrganization,
  organizations, organizationsError, setActiveOrganization,
} from "@/lib/organizations";

export function DashboardSidebarUser(props: { onAccount(): void; onSwitch(): void }) {
  const auth = useAuth();
  const avatarUrl = useAvatar();
  const displayName = () => auth.user()?.name || auth.user()?.email || "User";
  const [createOpen, setCreateOpen] = createSignal(false);
  const [name, setName] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const [error, setError] = createSignal("");
  let trigger: HTMLButtonElement | undefined;

  const handleCreate = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!name().trim() || creating()) return;
    setCreating(true);
    setError("");
    try {
      await createOrganization(name().trim());
      setCreateOpen(false);
      props.onSwitch();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not create organization");
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <div class="shrink-0 p-2">
        <DropdownMenu placement="top-start" gutter={8}>
          <DropdownMenuTrigger
            ref={trigger}
            aria-label={`Account and organizations: ${displayName()}`}
            class="flex w-full items-center gap-2 rounded-md p-2 text-left hover:bg-accent data-[expanded]:bg-accent focus-ring"
          >
            <Show when={avatarUrl()} fallback={
              <span class="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-xs text-foreground">
                {displayName().charAt(0).toUpperCase()}
              </span>
            }>
              {(url) => <img src={url()} alt="" class="size-8 shrink-0 rounded-full object-cover" />}
            </Show>
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate text-xs font-450 text-foreground">
                {displayName()}
              </span>
              <span class="truncate text-xxs text-muted-foreground">{activeOrganization()?.name ?? auth.user()?.email ?? "Account settings"}</span>
            </span>
            <svg aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="m8 9 4-4 4 4m-8 6 4 4 4-4" />
            </svg>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent
              class="w-65 max-w-[calc(100vw-1rem)] gap-1"
              onCloseAutoFocus={(event) => { if (createOpen()) event.preventDefault(); }}
            >
              <Show when={auth.isAuthenticated()}>
                <div class="px-2 py-1.5 text-xs">
                  <p class="truncate font-450 text-foreground">{displayName()}</p>
                  <Show when={displayName() !== auth.user()?.email}>
                    <p class="truncate text-muted-foreground">{auth.user()?.email}</p>
                  </Show>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger class="h-10" textValue={activeOrganization()?.name ?? "Organizations"}>
                    <span class="flex min-w-0 items-center gap-2">
                      <span class="grid size-6 shrink-0 place-items-center rounded-md border border-current/15 font-450">
                        {activeOrganization()?.name.charAt(0).toUpperCase() || "O"}
                      </span>
                      <span class="truncate">{activeOrganization()?.name ?? "Organizations"}</span>
                    </span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent class="w-65 max-w-[calc(100vw-1rem)] gap-1">
                      <DropdownMenuGroup>
                        <DropdownMenuGroupLabel>Organizations</DropdownMenuGroupLabel>
                        <Show when={organizationsError()}>
                          <p role="alert" class="px-2 py-1 text-xs text-destructive">{organizationsError()}</p>
                        </Show>
                        <Show when={organizations()} fallback={<p class="px-2 py-1 text-xs text-muted-foreground">Loading…</p>}>
                          <DropdownMenuRadioGroup
                            value={activeOrganizationId() ?? ""}
                            onChange={(id) => {
                              if (id === activeOrganizationId()) return;
                              setActiveOrganization(id);
                              props.onSwitch();
                            }}
                            class="max-h-64 overflow-y-auto"
                          >
                            <For each={organizations() ?? []}>
                              {(organization) => (
                                <DropdownMenuRadioItem value={organization.id} textValue={organization.name} class="min-h-10 rounded-md text-xs data-[highlighted]:text-primary-foreground">
                                  <span class="grid size-6 shrink-0 place-items-center rounded-md border border-current/15 font-450">
                                    {organization.name.charAt(0).toUpperCase()}
                                  </span>
                                  <span class="min-w-0 flex-1 truncate">{organization.name}</span>
                                </DropdownMenuRadioItem>
                              )}
                            </For>
                          </DropdownMenuRadioGroup>
                        </Show>
                      </DropdownMenuGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem class="h-9 gap-2" onSelect={() => {
                        setName("");
                        setError("");
                        setCreateOpen(true);
                      }}>
                        <Icon name="plus-add" /> Create organization
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
              </Show>
              <DropdownMenuItem class="h-9 gap-2" onSelect={props.onAccount}>
                <Icon name="settings" /> {auth.isAuthenticated() ? "Settings" : "Sign in"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenu>
      </div>

      <Dialog open={createOpen()} onOpenChange={(open) => { if (!creating()) setCreateOpen(open); }}>
        <DialogPortal>
          <DialogContent showCloseButton={!creating()} class="sm:max-w-sm" onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger?.focus();
          }}>
            <DialogHeader>
              <DialogTitle>Create organization</DialogTitle>
              <DialogDescription>A shared space for your team's projects and documents.</DialogDescription>
            </DialogHeader>
            <form class="flex flex-col gap-4" onSubmit={(event) => void handleCreate(event)}>
              <label class="flex flex-col gap-2 text-xs">
                Organization name
                <input class="rounded-md border border-border bg-input p-2 text-xs focus-ring" value={name()} onInput={(event) => setName(event.currentTarget.value)} placeholder="e.g. Acme Studio" maxLength={100} required disabled={creating()} />
              </label>
              <Show when={error()}><p role="alert" class="text-xs text-destructive">{error()}</p></Show>
              <DialogFooter>
                <Button type="button" variant="secondary" disabled={creating()} onClick={() => setCreateOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={creating() || !name().trim()}>{creating() ? "Creating…" : "Create organization"}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    </>
  );
}
