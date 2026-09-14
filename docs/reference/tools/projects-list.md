# projects_list

List the projects the app knows about — the ones its dashboard shows — with each one's id, display name, and folder. Use it to find a project's folder before [`open`](./open.md).

| | |
| --- | --- |
| MCP tool | `projects_list` |
| CLI | `compound projects list` |

## Input

None.

## Output

One JSON object:

```ts
{
  projects: {
    id:   string;   // the project's stable `projectId` from its package.json
    name: string;   // display name
    dir:  string;   // absolute path of the project folder
  }[];
}
```

A project's `id` is stable across renames and moves; `dir` is where its JSX lives. Pass a `dir` to [`open`](./open.md) to make that project the one the editor is working on.

## Errors

Fails while the app is down (`open` launches it).
