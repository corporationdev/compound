/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';

import { convex } from './auth-client';

import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';

export type QueryState<T> =
  | { status: 'loading'; data: undefined; error: undefined }
  | { status: 'ready'; data: T; error: undefined }
  | { status: 'error'; data: undefined; error: Error };

/**
 * Subscribe a Solid signal to a Convex query. The subscription follows
 * `args()`: a new argument value swaps the subscription, `null` pauses it
 * (state goes back to loading). The Convex client already carries the
 * session (`convex.setAuth` in the auth context), so any owner-scoped query
 * just works.
 */
export function createQuery<Query extends FunctionReference<'query'>>(
  query: Query,
  args: () => FunctionArgs<Query> | null = () => ({}) as FunctionArgs<Query>,
): Accessor<QueryState<FunctionReturnType<Query>>> {
  const loading = { status: 'loading', data: undefined, error: undefined } as const;
  const [state, setState] = createSignal<QueryState<FunctionReturnType<Query>>>(loading);
  createEffect(() => {
    const current = args();
    if (!convex) {
      setState({ status: 'error', data: undefined, error: new Error('Cloud is not configured.') });
      return;
    }
    if (current === null) {
      setState(loading);
      return;
    }
    setState(loading);
    const unsubscribe = convex.onUpdate(
      query,
      current,
      (data) => setState({ status: 'ready', data, error: undefined }),
      (error) => setState({ status: 'error', data: undefined, error }),
    );
    onCleanup(unsubscribe);
  });
  return state;
}
