/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";

export const LibraryKind = z.enum(["music", "sfx"]).describe("music or sfx");

/** The Compound source ID a search, get, or resolve hands back. */
export const SourceId = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,100}$/, "Pass an exact source ID returned by library_search or library_resolve")
  .describe("exact source ID from library_search or library_resolve");

/** One catalog entry. Times are seconds. */
export const LibraryItem = z.object({
  sourceId: z.string(),
  kind: LibraryKind,
  title: z.string(),
  description: z.string().optional(),
  duration: z.number().optional().describe("seconds"),
  sourceRange: z
    .object({ start: z.number(), end: z.number() })
    .optional()
    .describe("recommended in and out points within the source, in seconds"),
  selectedDuration: z.number().optional().describe("seconds covered by sourceRange"),
  status: z.enum(["uploading", "queued", "running", "ready", "failed"]),
  error: z.string().optional(),
});

export const librarySearch = defineTool({
  name: "library_search",
  title: "Search the library",
  description:
    "Search the combined music and sound-effects library (your own items plus the shared catalog). Omitted, empty, or whitespace-only queries browse ALL items of this kind, following every page. For general music/SFX selection, browse first and read the descriptions and recommended source ranges rather than guessing at a keyword. `expand` includes external discovery and needs at least two query characters. Returns items, count, complete, and expanded; times are seconds. Import a chosen source with library_import, then place the returned local path in the project's JSX.",
  input: z.object({
    kind: LibraryKind,
    query: z.string().max(120).optional().describe("title or keyword filter; omit to browse everything"),
    expand: z.boolean().optional().describe("include external discovery; requires at least two query characters"),
  }),
  output: z.object({
    items: z.array(LibraryItem),
    count: z.int(),
    complete: z.boolean().describe("true when every page was followed"),
    expanded: z.boolean().describe("true when external discovery was included"),
  }),
  environment: "renderer",
});

export const libraryGet = defineTool({
  name: "library_get",
  title: "Read a library source",
  description:
    "Read a source's description, preparation status, duration, and recommended source range without downloading it. Times are seconds.",
  input: z.object({ sourceId: SourceId }),
  output: LibraryItem,
  environment: "renderer",
});

export const libraryResolve = defineTool({
  name: "library_resolve",
  title: "Resolve a music link",
  description:
    "Resolve an exact supported music link to a source ID, without downloading or importing it. Pass the resulting source ID to library_import.",
  input: z.object({ url: z.string().min(1).max(2048).describe("supported music link") }),
  output: LibraryItem,
  environment: "renderer",
});

export const libraryImport = defineTool({
  name: "library_import",
  title: "Import a library source",
  description:
    "Import a source into the open project's assets, reusing cached audio and any existing asset. Returns the asset id, its project-relative path, its absolute local path, and the recommended sourceRange in seconds. Edit the project's JSX to place it; this does not insert a timeline clip. Uncached audio may take about 40 seconds to prepare — retry the same source ID after a timeout, completed preparation is reused.",
  input: z.object({ sourceId: SourceId }),
  output: LibraryItem.extend({
    assetId: z.string(),
    path: z.string().describe("project-relative asset path, for JSX"),
    localPath: z.string().optional().describe("absolute path on disk"),
    reused: z.boolean().describe("true when the project already had this asset"),
  }),
  environment: "renderer",
});
