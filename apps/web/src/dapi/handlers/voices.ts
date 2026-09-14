/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ToolHandler } from "../handler";

/** Compound does not run in-app speech generation, so there are no voices. */
export const voices: ToolHandler<"voices"> = async () => ({ voices: [] });
