/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `compound://` links. The OS hands them to main three ways — `open-url` on
// macOS, argv of a second instance, argv of a cold start — and this module
// turns each into one parsed link the renderer can act on. Links are a
// courtesy (bring the app forward, land on the right screen); nothing the
// app persists depends on one arriving.

export const DEEP_LINK_SCHEME = "compound";
const PREFIX = `${DEEP_LINK_SCHEME}://`;

export type DeepLink = {
  /** The screen the link names: `social-connected`, … */
  host: string;
  params: Record<string, string>;
  url: string;
};

export function parseDeepLink(raw: string): DeepLink | null {
  if (typeof raw !== "string" || !raw.toLowerCase().startsWith(PREFIX)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.host.toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(host)) return null;
  return { host, params: Object.fromEntries(url.searchParams), url: url.toString() };
}

/** Every `compound://` argument in an argv, cold start or second instance. */
export function deepLinksIn(argv: readonly string[]): DeepLink[] {
  return argv.flatMap((arg) => parseDeepLink(arg) ?? []);
}

/**
 * Holds links until the renderer can take them. A running renderer gets a
 * push; a renderer that is still booting drains the inbox on startup, so a
 * link that launched the app is not lost to the race with page load.
 */
export class DeepLinkInbox {
  private pending: DeepLink | null = null;
  private readonly deliver: (link: DeepLink) => boolean;
  constructor(deliver: (link: DeepLink) => boolean) {
    this.deliver = deliver;
  }
  push(link: DeepLink) {
    if (this.deliver(link)) this.pending = null;
    else this.pending = link;
  }
  /** The renderer's startup call: return and clear whatever is waiting. */
  take(): DeepLink | null {
    const link = this.pending;
    this.pending = null;
    return link;
  }
}
