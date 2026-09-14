/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { listKnownProjects } from "@/projects";

import type { ToolHandler } from "../handler";

export const projectsList: ToolHandler<"projects_list"> = async () => ({
  projects: (await listKnownProjects()).map((project) => ({
    id: project.id,
    name: project.displayName,
    dir: project.dir,
  })),
});
