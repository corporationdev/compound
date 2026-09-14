/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";

export const projectsList = defineTool({
  name: "projects_list",
  title: "List known projects",
  description:
    "List the projects the app knows about — the ones its dashboard shows — with each one's id, display name, and folder. Use it to find a project's folder before `open`.",
  input: z.object({}),
  output: z.object({
    projects: z.array(
      z.object({
        id: z.string(),
        name: z.string().describe("display name"),
        dir: z.string().describe("absolute path of the project folder"),
      }),
    ),
  }),
  environment: "renderer",
});
