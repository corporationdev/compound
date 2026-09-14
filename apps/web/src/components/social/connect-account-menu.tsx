/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, createSignal, type JSX } from "solid-js";
import { toast } from "somoto";

import { Button, type ButtonProps } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { SOCIAL_PLATFORMS, SOCIAL_PLATFORM_LABELS, connectSocialAccount, socialPlatformIcon, type SocialPlatform } from "@/lib/social";

/**
 * The one way to start connecting an account: a platform menu that hands off
 * to the provider's OAuth page. The backend finishes the round trip, so the
 * live accounts query updates wherever this menu was opened from, whether
 * Settings or the post composer.
 */
export function ConnectAccountMenu(props: {
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  class?: string;
  /** Runs before the browser leaves for the provider (e.g. flush a draft). */
  onBeforeConnect?: () => void | Promise<void>;
  children?: JSX.Element;
}) {
  const [connecting, setConnecting] = createSignal<SocialPlatform | null>(null);

  const connect = async (platform: SocialPlatform) => {
    setConnecting(platform);
    try {
      await props.onBeforeConnect?.();
      await connectSocialAccount(platform);
      toast(`Finish connecting ${SOCIAL_PLATFORM_LABELS[platform]} in your browser`, {
        description: "The account will appear here as soon as you approve it.",
      });
    } catch (e) {
      toast.error(`Could not connect ${SOCIAL_PLATFORM_LABELS[platform]}`, { description: (e as Error).message });
    } finally {
      setConnecting(null);
    }
  };

  return (
    <DropdownMenu placement="bottom-end">
      <DropdownMenuTrigger as={Button} variant={props.variant ?? "secondary"} size={props.size} class={props.class} disabled={connecting() !== null}>
        {connecting() ? `Opening ${SOCIAL_PLATFORM_LABELS[connecting()!]}…` : (props.children ?? "Connect account")}
        <Icon name="chevron-down" class="size-4 ml-1" />
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent class="w-48">
          <For each={SOCIAL_PLATFORMS}>
            {(platform) => (
              <DropdownMenuItem onSelect={() => void connect(platform)}>
                <Icon name={socialPlatformIcon(platform)} class="size-4 mr-2" />
                {SOCIAL_PLATFORM_LABELS[platform]}
              </DropdownMenuItem>
            )}
          </For>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenu>
  );
}
