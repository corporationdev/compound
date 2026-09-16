/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Three-way text merge for a file two clients changed since they last
// agreed. Edits to different lines combine; edits to the same lines cannot,
// and there the local side wins — a file with conflict markers in it would
// not compile, and the other side's text is kept beside the project for the
// user to look at (see `ProjectSync`).

import { diff3Merge } from "node-diff3";

export type MergeOutcome = {
  /** The merged text. */
  text: string;
  /** Whether any region could not be combined and was taken from the local side. */
  conflicted: boolean;
};

const lines = (text: string): string[] => text.split("\n");

/** Merges `local` and `remote`, both derived from `base`. */
export function mergeText(base: string, local: string, remote: string): MergeOutcome {
  if (local === remote) return { text: local, conflicted: false };
  if (local === base) return { text: remote, conflicted: false };
  if (remote === base) return { text: local, conflicted: false };

  const regions = diff3Merge(lines(local), lines(base), lines(remote), { excludeFalseConflicts: true });
  const out: string[] = [];
  let conflicted = false;
  for (const region of regions) {
    if (region.ok) out.push(...region.ok);
    else if (region.conflict) {
      conflicted = true;
      out.push(...region.conflict.a);
    }
  }
  return { text: out.join("\n"), conflicted };
}
