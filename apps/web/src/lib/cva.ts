/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defineConfig } from "cva"
import { extendTailwindMerge } from "tailwind-merge"

// tailwind-merge only knows the stock font sizes. Without this, `text-xxs`
// is mistaken for a text colour and dropped whenever a colour class follows.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: ["xxs"] }] } },
});

export const { cva, cx, compose } = defineConfig({
  hooks: {
    onComplete: (className) => twMerge(className),
  },
});
