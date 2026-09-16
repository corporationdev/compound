/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash } from "node:crypto";

/** The content hash every synced file carries: SHA-256 of its UTF-8 bytes, hex. */
export const hashText = (text: string | Uint8Array): string =>
  createHash("sha256").update(text).digest("hex");
