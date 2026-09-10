/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { initTRPC } from "@trpc/server";
import type { AnyTRPCRouter } from "@trpc/server";
import type { ProcedureCaller, RouterCaller } from "./ipc";

// Each invocation carries its own project target, so concurrent CLI calls
// cannot retarget one another. The renderer hosts the router.
export type CliRequestContext = { target?: import("@compound/cli/channels").CliProjectTarget };
export const t = initTRPC.context<CliRequestContext>().create({ allowOutsideOfServer: true });

// Inputs come pre-typed from the tRPC client, so parsers are identity casts
// rather than schemas; validation stays where it always was, in the handlers.
const input =
  <I,>() =>
  (value: unknown) =>
    value as I;

// Lift an existing unary handler into a procedure, inferring its input and
// output types. The cast collapses tRPC's conditional input type, which
// stays unresolved for a generic I. Zero-argument handlers use q0/m0: they
// skip .input() so the client can call them without an argument.
export const q = <O, I>(fn: (data: I, ctx: CliRequestContext) => O | Promise<O>) =>
  t.procedure.input(input<I>()).query(({ input: data, ctx }) => fn(data as I, ctx));

export const m = <O, I>(fn: (data: I, ctx: CliRequestContext) => O | Promise<O>) =>
  t.procedure.input(input<I>()).mutation(({ input: data, ctx }) => fn(data as I, ctx));

export const q0 = <O,>(fn: (ctx: CliRequestContext) => O | Promise<O>) => t.procedure.query(({ ctx }) => fn(ctx));

export const m0 = <O,>(fn: (ctx: CliRequestContext) => O | Promise<O>) => t.procedure.mutation(({ ctx }) => fn(ctx));

// Adapts a router for the CLI bridge: resolve a dot-joined procedure path to
// an invocable, or undefined when this router doesn't own the path (the
// bridge then tries other routers or holds the request).
export function createRouterCaller(router: AnyTRPCRouter): RouterCaller {
  const makeCaller = t.createCallerFactory(router);
  return (path: string): ProcedureCaller | undefined => {
    if (!(path in router._def.procedures)) return undefined;
    return (data: unknown, target) => {
      const caller = makeCaller({ target });
      return path.split(".").reduce<any>((o, key) => o[key], caller)(data) as Promise<unknown>;
    };
  };
}
