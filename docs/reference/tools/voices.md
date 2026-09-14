# voices

List the speech voices available for `generate.voice` declarations in a project module.

> Compound: cloud media generation and transforms are unavailable. Import media files instead. Model and voice listings are empty. The API descriptions below document the upstream authoring contract.

| | |
| --- | --- |
| MCP tool | `voices` |
| CLI | `compound voices` |

## Input

None.

See [jsx/generate.md](../jsx/generate.md) for the declaration a voice id goes on.

## Output

One JSON object:

```ts
{ voices: Array<{ id: string; label: string; description: string }> }
```
