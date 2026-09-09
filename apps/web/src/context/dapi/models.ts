import type { ModelsRequest, ModelInfo } from "@compound/cli/channels";
/** Compound no longer exposes media generation models. */
export function handleModels() { return async (_req: ModelsRequest): Promise<ModelInfo[]> => []; }
