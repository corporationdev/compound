# models

List available AI generation models and their per-model constraints (durations, aspect ratios, features), for `generate.*` asset declarations in a project module.

> Compound: cloud media generation and transforms are unavailable. Import media files instead. Model and voice listings are empty. The API descriptions below document the upstream authoring contract.

| | |
| --- | --- |
| MCP tool | `models` |
| CLI | `compound models [type]` |

## Input

| Field | Type | CLI | Description |
| --- | --- | --- | --- |
| `type` | `"image" \| "video" \| "audio"` | `[type]` | filter to one kind of model, image, video, or audio (default: all three) |

Use it to discover valid model ids and the per-model constraints (durations, aspect ratios, features) to set on an asset declaration (see [jsx/generate.md](../jsx/generate.md)). No tool generates: asset generation is declared in the project module and produced on mount.

## Output

One JSON object:

```ts
{
  models: Array<{
    type:          "image" | "video" | "audio";
    id:            string;     // the model id to set on a generate.* declaration
    name:          string;
    durations?:    string[];   // video only, e.g. ["5s","10s"]
    aspectRatios?: string[];   // video only
    features?:     Array<"start-frame" | "end-frame" | "audio">;  // video only
  }>;
}
```
