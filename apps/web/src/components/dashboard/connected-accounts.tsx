/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createSignal } from "solid-js";
import { toast } from "somoto";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ConnectAccountMenu } from "@/components/social/connect-account-menu";
import { createQuery } from "@/lib/convex";
import {
  SOCIAL_PLATFORM_LABELS,
  disconnectSocialAccount,
  refreshSocialAccounts,
  socialAccountsQuery,
  socialPlatformIcon,
  type SocialAccount,
} from "@/lib/social";

import { DashboardDividedStack, DashboardInfoActionRow, DashboardSurfaceSection } from "./shared";

function AccountAvatar(props: { account: SocialAccount }) {
  const [broken, setBroken] = createSignal(false);
  return (
    <Show
      when={props.account.avatarUrl && !broken()}
      fallback={<Icon name={socialPlatformIcon(props.account.platform)} class="size-5 text-foreground" />}
    >
      <img
        src={props.account.avatarUrl!}
        alt=""
        class="size-6 rounded-full object-cover"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    </Show>
  );
}

/**
 * Settings → Connected accounts. The list is a live Convex query: the OAuth
 * round trip finishes on the backend, so a newly approved account appears
 * here on its own, whether the browser came back to the app or not.
 */
export function DashboardConnectedAccountsSection() {
  const accounts = createQuery(socialAccountsQuery);
  const [refreshing, setRefreshing] = createSignal(false);
  const [pendingDisconnect, setPendingDisconnect] = createSignal<SocialAccount | null>(null);
  const [disconnecting, setDisconnecting] = createSignal(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshSocialAccounts();
    } catch (e) {
      toast.error("Could not refresh accounts", { description: (e as Error).message });
    } finally {
      setRefreshing(false);
    }
  };

  const confirmDisconnect = async () => {
    const account = pendingDisconnect();
    if (!account) return;
    setDisconnecting(true);
    try {
      await disconnectSocialAccount(account.id);
      toast(`Disconnected @${account.username}`);
      setPendingDisconnect(null);
    } catch (e) {
      toast.error("Could not disconnect", { description: (e as Error).message });
    } finally {
      setDisconnecting(false);
    }
  };

  const connectMenu = <ConnectAccountMenu />;

  return (
    <DashboardSurfaceSection title="Connected accounts">
      <DashboardDividedStack>
        <Show when={accounts().status === "error"}>
          <DashboardInfoActionRow
            title="Connected accounts are unavailable"
            description={accounts().error?.message ?? "Sign in again to manage social accounts."}
            action={connectMenu}
          />
        </Show>
        <Show when={accounts().status === "loading"}>
          <DashboardInfoActionRow
            title="Loading accounts…"
            leading={<Icon name="spinner-loader" class="size-4 animate-spin" />}
            action={connectMenu}
          />
        </Show>
        <Show when={accounts().status === "ready"}>
          <Show
            when={accounts().data!.length > 0}
            fallback={
              <DashboardInfoActionRow
                title="No accounts connected"
                description="Connect Instagram, TikTok, YouTube, X, LinkedIn, or Facebook to post rendered scenes from Compound."
                action={connectMenu}
              />
            }
          >
            <For each={accounts().data as SocialAccount[]}>
              {(account) => (
                <DashboardInfoActionRow
                  title={`@${account.username}`}
                  description={SOCIAL_PLATFORM_LABELS[account.platform]}
                  leading={<AccountAvatar account={account} />}
                  layout="inline"
                  action={
                    <Button variant="secondary" onClick={() => setPendingDisconnect(account)}>
                      Disconnect
                    </Button>
                  }
                />
              )}
            </For>
            <DashboardInfoActionRow
              title="Add another account"
              description="Accounts you no longer see may have been removed on the platform. Refresh to re-check."
              action={
                <div class="flex items-center gap-2">
                  <Button variant="ghost" onClick={() => void refresh()} disabled={refreshing()}>
                    {refreshing() ? "Refreshing…" : "Refresh"}
                  </Button>
                  {connectMenu}
                </div>
              }
            />
          </Show>
        </Show>
      </DashboardDividedStack>

      <AlertDialog
        open={pendingDisconnect() !== null}
        onOpenChange={(open) => {
          if (!open && !disconnecting()) setPendingDisconnect(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect account</AlertDialogTitle>
            <AlertDialogDescription>
              {`@${pendingDisconnect()?.username ?? ""} on ${
                pendingDisconnect() ? SOCIAL_PLATFORM_LABELS[pendingDisconnect()!.platform] : ""
              } will be removed from Compound. `}
              You can connect it again at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="secondary" disabled={disconnecting()} onClick={() => setPendingDisconnect(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={disconnecting()} onClick={() => void confirmDisconnect()}>
              {disconnecting() ? "Disconnecting..." : "Disconnect"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardSurfaceSection>
  );
}
