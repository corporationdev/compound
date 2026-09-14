/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useNavigate } from "@solidjs/router";
import { onCleanup, onMount } from "solid-js";
import { toast } from "somoto";

import { MAIN_CHANNELS } from "@desktop/main-channels";
import { SOCIAL_RETURN_HOST } from "@compound/backend/convex/social_model";
import { SOCIAL_PLATFORM_LABELS, type SocialPlatform } from "@/lib/social";
import { mainBridge } from "@/lib/ipc";

import type { DeepLink } from "@desktop/deep-link";

/**
 * Route a `compound://` link to a screen. Links only bring the app to the
 * right place; the state they describe (a connected account, …) was already
 * saved by the backend and reaches the UI through live queries.
 */
export function routeDeepLink(link: DeepLink, navigate: (to: string, options?: { replace?: boolean }) => void) {
  if (link.host === SOCIAL_RETURN_HOST) {
    navigate("/?dashboard=settings", { replace: true });
    const username = link.params.username;
    const platform = link.params.platform as SocialPlatform | undefined;
    if (username)
      toast(`Connected @${username}`, {
        description: platform && SOCIAL_PLATFORM_LABELS[platform] ? `${SOCIAL_PLATFORM_LABELS[platform]} is ready to post.` : undefined,
      });
    return true;
  }
  return false;
}

/** Mounted once at the app root on desktop: takes the link that launched the app, then listens for more. */
export function DeepLinks() {
  const navigate = useNavigate();
  onMount(() => {
    if (!window.desktop) return;
    const handle = (link: DeepLink) => {
      routeDeepLink(link, (to, options) => navigate(to, options));
    };
    onCleanup(mainBridge.handle(MAIN_CHANNELS.APP_DEEP_LINK, handle));
    void mainBridge
      .call(MAIN_CHANNELS.APP_DEEP_LINK_TAKE, undefined)
      .then((pending) => pending && handle(pending))
      .catch(() => {});
  });
  return null;
}
