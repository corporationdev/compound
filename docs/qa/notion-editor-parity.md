# Core document editor parity audit

Compared on 2026-09-16 against the installed Notion desktop app and the live
Compound Electron development app, branch `cloud-sync`.

## Scope and storage boundary

Compound stores document bodies as Markdown, properties as YAML frontmatter,
and databases as folders with `_table.yaml` and Markdown row files. This pass
keeps that contract. It does not claim complete parity with Notion's block
model, collaboration system, or database platform.

## Capability map

| Area | Baseline | Result / boundary |
| --- | --- | --- |
| Empty editor | Empty-page hint plus permanent footer | One contextual hint on the active empty block; footer removed (verified in live DOM) |
| Slash insertion | Crowded two-line rows; weak viewport handling | Grouped readable rows, distinct glyphs, search, keyboard navigation, viewport positioning and dismissal |
| Basic blocks | Text, headings, lists, tasks, quotes, code, rules | Retained; consistent type conversion and Markdown round-trip coverage |
| Rich text | Bold, italic, underline, strike, inline code | Retained with selection-aware toolbar; round-trip verified |
| Links | Basic toolbar URL input | Cmd/Ctrl+K, explicit apply/remove/cancel; one Link to page command with a searchable destination picker |
| Block actions | No visible block gutter | Hover add/drag handle, duplicate, delete, insert above/below, convert, move up/down |
| Block selection | Text selection only | Escape selection, selected-block commands and keyboard operations |
| Nested lists/tasks | Basic extension behavior | Tab/Shift+Tab nesting; checkbox keyboard toggle |
| Simple tables | Insert-only interface | Add/delete rows and columns, Tab cell traversal, whole-table selection |
| Database rows | Editable cells and open page | Exterior hover checkbox gutter, select-all/mixed state, ranges, compact bulk toolbar, property edit, duplicate and trash |
| Database reading | Header sorting | Natural/numeric sorting, search, property contains filter, column resize |
| Database writing | Add row and edit value | Inline creation with persistent title focus, inline title edits, explicit open action, property creation with existing six types |
| Page properties | Missing schema fields hidden | All declared schema fields visible; accessible labels; searchable select options |
| Persistence | Debounced saves with stale-response races | Serialized saves, newer typing retained during merges, stale watcher responses ignored, retry-safe state |
| Undo/redo and paste | Tiptap history / Markdown input | Existing support retained; no alternate document storage introduced |
| Toggle/callout, columns, colors, equations | No persistent schema | Not added; requires an explicit serialization design |
| Synced blocks, block anchors, comments, suggestions, people mentions | No persistent schema | Not added |
| Page icons/covers, uploaded or external media, third-party embeds | Outside core Markdown editor contract | Not added |
| Database saved views, board/calendar/gallery, relations/formulas/rollups, automations | Not supported by present table schema | Not added |
| Database advanced view tools | Absent | Compound filters, grouping, calculations and manual persisted ordering remain gaps |

## Hands-on comparison

In Notion, selected an existing database row and inspected its checkbox gutter,
blue selected state, and contextual bulk-action toolbar. Created a scratch
`Editor parity lab` page; used slash search to insert a heading, typed a
paragraph, observed the focused-line placeholder and Escape selection. Captured
its slash menu and writing layout for comparison.

In Compound, created scratch pages, used heading slash insertion, duplicated a
row, bulk-edited two rows to `In progress`, reloaded and checked retained values.
Verified search narrows rows and select-all applies to visible rows. Inserted a
simple table, typed headers via Tab, added a row and column through its toolbar.
Duplicated a heading through the block menu. Applied a link through Cmd+K and
verified the link survived reload. Also verified native dragging, menu and keyboard block movement, multi-block
Shift-arrow selection and Enter editing, repeat tag entry without closing the
popover, Escape dismissal, property creation, numeric sorting (2 before 10),
range selection, trash, and page-title rename. The final scratch page remains
available as `Editor parity lab`.

## Automated verification

- Web typecheck: pass.
- Production web build: pass (existing bundle-size/mixed-import warnings).
- ESLint across changed editor/database source files: pass.
- Targeted Markdown/editor/persistence/database/tree tests: 55 pass, 173 assertions.
- `git diff --check`: pass.


Regression coverage lives in `apps/web/test/workspace-document-editor.test.ts`,
`workspace-document-persistence.test.ts`, and `database-model.test.ts`, alongside
existing Markdown and tree tests. Tests cover document structure and Markdown
round-trips, block operations, selected row ranges, natural sorting, serialized
writes, deferred save responses and stale watcher reads.

An existing full-suite isolation issue is reproducible using only
`transcription-client.test.ts` and `view-state.test.ts`: the former leaves a
partial `window` global installed, causing animejs to require an absent
`document`. The standalone view-state suite passes. This is independent of the
editor changes.

## Research references

- [Notion writing and editing](https://www.notion.com/help/writing-and-editing-basics): block insertion, handles, transformations, selection and content families.
- [Notion keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts): editing and block keyboard behavior.
- [Notion tables](https://www.notion.com/help/tables): row selection, property edits and table interactions.
- [Notion columns, headings and dividers](https://www.notion.com/help/columns-headings-and-dividers): simple tables and structural layout boundaries.

## Follow-up: inline mechanics and visual corrections

The initial pass did not adequately match the embedded database's layout and
creation behavior. Follow-up verification used the installed Notion CRM table
and Link to page picker, alongside the actual Compound database NodeView.

- Database title and right-hand controls now share a vertically centered row.
- Removed the selection column and enclosing rounded card. Checkboxes sit in
  an exterior gutter and appear on row hover, keyboard focus, or selection.
- Selection actions replace the toolbar's left side. Measured table top before
  and after selection was identical (461.59375 CSS pixels).
- Scoped prose table CSS away from databases. Embedded table margin is 0; the
  ordinary Markdown table retains its intended 9.75px vertical spacing.
- New page creates inline, selects its title, and keeps focus after the watcher
  refresh. Found and fixed a second bug where differing optimistic/listing
  orders moved the focused DOM node and blurred it. Typed and renamed
  `Inline mechanics check`, then reloaded to verify persistence.
- Verified embedded checkbox selection, Cmd+A, Shift+Down range selection,
  keyboard trash of four disposable rows, and preservation of the host document.
- Verified compact status and tag cell pickers, option creation/removal, and
  persistence after reload. Empty cells are blank; chips have no permanent
  dropdown arrows or remove buttons.
- Root slash results contain Link to page and Linked database commands, not
  every available destination. Verified search, empty results, Escape/back,
  keyboard insertion, correct encoded page target and persistence after reload.
  Project and internal documents are excluded from these pickers.

Typecheck, targeted ESLint, production build, and all 55 focused tests passed
after these corrections. Native Electron screenshots were used for visual
inspection; DOM checks were used for geometry and interaction state.
