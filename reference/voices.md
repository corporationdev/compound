# `compound voices`

> Compound: cloud media generation and transforms are unavailable. Import media files instead. Model and voice listings are empty. The API descriptions below document the upstream authoring contract.


Lists the speech voices available for `generate.voice` declarations (see [jsx/generate.md](./jsx/generate.md)).

## Input

None.

## Output

JSON Lines, one per voice:

```ts
{ id: string; label: string; description: string }
```
