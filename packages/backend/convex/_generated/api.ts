/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as asset_transcription from "../asset_transcription.js";
import type * as assets from "../assets.js";
import type * as auth from "../auth.js";
import type * as catalog from "../catalog.js";
import type * as catalog_actions from "../catalog_actions.js";
import type * as catalog_manifest from "../catalog_manifest.js";
import type * as catalog_providers_capabilities from "../catalog_providers/capabilities.js";
import type * as catalog_providers_http from "../catalog_providers/http.js";
import type * as catalog_providers_myinstants from "../catalog_providers/myinstants.js";
import type * as catalog_providers_registry from "../catalog_providers/registry.js";
import type * as catalog_providers_types from "../catalog_providers/types.js";
import type * as catalog_providers_youtube from "../catalog_providers/youtube.js";
import type * as catalog_types from "../catalog_types.js";
import type * as crons from "../crons.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as lib_membership from "../lib/membership.js";
import type * as lib_organizations from "../lib/organizations.js";
import type * as organizations from "../organizations.js";
import type * as projects from "../projects.js";
import type * as transcription_workflow from "../transcription_workflow.js";
import type * as transcriptions from "../transcriptions.js";
import type * as uploads from "../uploads.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  asset_transcription: typeof asset_transcription;
  assets: typeof assets;
  auth: typeof auth;
  catalog: typeof catalog;
  catalog_actions: typeof catalog_actions;
  catalog_manifest: typeof catalog_manifest;
  "catalog_providers/capabilities": typeof catalog_providers_capabilities;
  "catalog_providers/http": typeof catalog_providers_http;
  "catalog_providers/myinstants": typeof catalog_providers_myinstants;
  "catalog_providers/registry": typeof catalog_providers_registry;
  "catalog_providers/types": typeof catalog_providers_types;
  "catalog_providers/youtube": typeof catalog_providers_youtube;
  catalog_types: typeof catalog_types;
  crons: typeof crons;
  files: typeof files;
  http: typeof http;
  "lib/membership": typeof lib_membership;
  "lib/organizations": typeof lib_organizations;
  organizations: typeof organizations;
  projects: typeof projects;
  transcription_workflow: typeof transcription_workflow;
  transcriptions: typeof transcriptions;
  uploads: typeof uploads;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {
  betterAuth: import("../betterAuth/_generated/component.js").ComponentApi<"betterAuth">;
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
