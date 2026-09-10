# `compound context`

Summary of app state: what the project's source cannot say. The composition
itself — its scenes, what is selected, which scene is active, the work area —
is all in the JSX, and a caller that wants any of it reads the file. Alias:
`ctx`.

## Target

Run inside a Compound project, or use `compound --project <id-or-path> context`.
The explicit option takes precedence over discovery from the working directory
(and its parents). The visible editor is never a fallback. With no target, the
command fails with a resolution error. Use `compound projects list` to list
projects from all remembered roots, including external project folders.

## Output

One JSON object:

```ts
{
  rootDir:      string | null;   // absolute folder projects live under; null until one is picked
  projectId:    string;          // stable package.json projectId
  projectName:  string;
  projectDir:   string;          // absolute target project folder
  editorAttached: boolean;       // this exact project is currently open
  currentTime:  number | null;   // playhead in the active scene, in seconds; null if no scene is active
  fontFamilies: string[] | null;        // families registered in the running world, valid as `fontFamily`
  generations:  {                // every generated source in the project, and where it stands
    element: string | null;      // the element's source stamp, `<file>:<id>`; null for an entity no element produced
    name:    string | null;      // the element's `name`, when it has one
    state:   "generating" | "failed" | "done";
    error?:  string;             // what it failed with, on `failed` rows
    asset?:  string;             // the library path it landed as, on `done` rows
  }[] | null;
}
```

When the target is not open, `editorAttached` is false and `currentTime`,
`fontFamilies`, and `generations` are null. Project files and relative media can
still be read and edited. There is no background renderer. `capture`, `check`,
and `export` fail unless this exact target is open; they never render a different
visible project. Opening a project is an explicit navigation action.

`currentTime` is local to the active scene, the same origin a clip's `start`
and `end` are placed against, and in the same unit.

`projectDir` is the resolved target, regardless of which project the user is viewing.

`fontFamilies` is what text can be drawn with right now — loaded into the world,
not merely named in the source — and always includes the editor default. For
every family installed on the machine, see [`compound fonts`](./fonts.md).

`generations` is how a caller waits for `generate.*` declarations without
blocking: generation is asynchronous, so poll this until nothing is
`generating`. A `done` row's `asset` is a library path, ready for
[`compound media probe`](./media/probe.md) and its siblings; a `failed` row's
`error` is the same message the element carries as its `error` prop, which is
what keeps it from being generated again (see
[jsx/errors.md](./jsx/errors.md#failed-sources)).
