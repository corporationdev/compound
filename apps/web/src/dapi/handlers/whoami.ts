/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toolByName } from "@compound/dapi";

import type { ToolHandler } from "../handler";

// The auth record carries identities, provider metadata and avatar URLs;
// the output schema names the id and the email, and parsing strips the rest.
export const whoami: ToolHandler<"whoami"> = async (_, ctx) => toolByName("whoami").output.parse({ user: ctx.app.user() });
