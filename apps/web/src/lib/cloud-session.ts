/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The signed native session the desktop's sync engine needs. The renderer
// keeps it in localStorage under a key namespaced by the auth server (see
// `createNativeSession`); main mints Convex JWTs from it. Desktop only: in
// the browser there is no native session and no sync.

import { MAIN_CHANNELS } from '@desktop/main-channels';
import { mainBridge } from './ipc';

let authUrl: Promise<string> | undefined;

/** The auth server this build talks to, asked of main once. */
function getAuthUrl(): Promise<string> {
  authUrl ??= mainBridge
    .call(MAIN_CHANNELS.CLOUD_CONFIG, undefined)
    .then((config) => config.authUrl)
    .catch((error) => {
      authUrl = undefined;
      throw error;
    });
  return authUrl;
}

/** The signed native session token, or null when signed out (or not on the desktop). */
export async function getNativeSessionToken(): Promise<string | null> {
  if (!window.desktop) return null;
  const key = `compound:${await getAuthUrl()}:native-session`;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The token, or an error that reads as the next step for the user. */
export async function requireNativeSessionToken(): Promise<string> {
  if (!window.desktop) throw new Error('Cloud projects are only available in the desktop app.');
  const token = await getNativeSessionToken();
  if (!token) throw new Error('Sign in to use cloud projects.');
  return token;
}

/**
 * Tells main what the session is now, so its sync engine follows sign-in and
 * sign-out. Called after every session change; a null token stops every sync.
 */
export async function syncSessionWithMain(): Promise<void> {
  if (!window.desktop) return;
  try {
    const sessionToken = await getNativeSessionToken();
    await mainBridge.call(MAIN_CHANNELS.SYNC_SESSION, { sessionToken });
  } catch (error) {
    console.warn('[cloud] could not hand the session to main', error);
  }
}
