/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The editor's view of a project — where the playhead stands, what is
 * selected, which scene the timeline points at, where the camera and the
 * timeline are looking, which rows are open — kept out of the file. The
 * file carries the project's opening state (an author marks a scene
 * `active`, gives the stage a `camera`); what this editor did with it since
 * lives here, per project, in the app's database, and goes back on the
 * stage after every mount. Entries are keyed by source stamp, the one name
 * an element keeps across remounts.
 */

import { Active, ClipHeight, Expanded, FrameRate, getCameraMatrix, Scene, secondsToFrames, Selected, setCameraMatrix, setPlayhead, setTimelineView, Source } from '@compound/runtime';

import { getDocumentEditor, isPendingSource } from './editor';
import { loadProjectView, saveProjectView } from '../lib/db';

import type { Entity, World } from 'koota';
import type { CameraMatrix, TimelineView } from '@compound/runtime';

/** The props that are pointing and viewing rather than composition. */
export const VIEW_PROPS: ReadonlySet<string> = new Set(['selected', 'active', 'camera', 'expanded', 'clipHeight', 'timeline', 'playhead']);

/** One view-prop edit as the editor reports it: `{ kind: 'prop', ... }` minus the kind. */
export interface ViewEdit {
	source: string;
	name: string;
	value: unknown;
}

/**
 * Where the editor was looking in a project. Every map is keyed by the
 * source stamp of the element it is about; the camera belongs to the stage,
 * of which there is one, so it stands alone. `playhead` is in seconds, as
 * the file spells it; `timeline` is `[zoom, x, y]` as `getTimelineView`
 * reports it. Only what the editor changed is here: a prop never touched is
 * absent, and the file's value stands.
 *
 * `fileActive` and `fileCamera` are not the editor's but the file's: what
 * the document said at the last mount, kept so a change in the file is told
 * apart from the file the view was made over (see `reconcileWithFile`).
 * `fileActive` is `''` when the file marked no scene, and absent when no
 * mount has recorded it yet — records from before it was kept.
 */
export interface ProjectView {
	camera?: number[];
	active?: string;
	fileActive?: string;
	fileCamera?: number[];
	selected: string[];
	playhead: Record<string, number>;
	timeline: Record<string, [number, number, number]>;
	expanded: Record<string, boolean>;
	clipHeight: Record<string, number>;
}

export const emptyView = (): ProjectView => ({ selected: [], playhead: {}, timeline: {}, expanded: {}, clipHeight: {} });

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isNumberTuple = (value: unknown, length: number): value is number[] =>
	Array.isArray(value) && value.length === length && value.every(isFiniteNumber);

/** `record` without `key`, as a new object. */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
	if (!(key in record)) return record;
	const rest = { ...record };
	delete rest[key];
	return rest;
}

/**
 * Folds one edit into `view`: what the editor reported as the prop it would
 * have written, kept as the view instead. Pure — `view` is left alone and a
 * new one answers — so it can be replayed and tested. An edit of a prop that
 * is not a view prop is ignored. `false` is how the editor unsets a prop, and
 * it means the same here: the entry goes, and the file's value is back in
 * force on the next mount.
 */
export function applyViewEdit(view: ProjectView, edit: ViewEdit): ProjectView {
	const { source, name, value } = edit;

	switch (name) {
		case 'active': {
			if (value === true) return { ...view, active: source };
			if (view.active !== source) return view;
			const rest = { ...view };
			delete rest.active;
			return rest;
		}
		case 'selected': {
			const selected = view.selected.includes(source);
			if (value === true) return selected ? view : { ...view, selected: [...view.selected, source] };
			return selected ? { ...view, selected: view.selected.filter((other) => other !== source) } : view;
		}
		case 'playhead': {
			if (isFiniteNumber(value) && value > 0) return { ...view, playhead: { ...view.playhead, [source]: value } };
			return { ...view, playhead: without(view.playhead, source) };
		}
		case 'timeline': {
			if (isNumberTuple(value, 3)) return { ...view, timeline: { ...view.timeline, [source]: [value[0]!, value[1]!, value[2]!] } };
			return { ...view, timeline: without(view.timeline, source) };
		}
		case 'expanded': {
			return { ...view, expanded: { ...view.expanded, [source]: value === true } };
		}
		case 'clipHeight': {
			if (isFiniteNumber(value)) return { ...view, clipHeight: { ...view.clipHeight, [source]: value } };
			return { ...view, clipHeight: without(view.clipHeight, source) };
		}
		case 'camera': {
			return isNumberTuple(value, 6) ? { ...view, camera: [...value] } : view;
		}
		default:
			return view;
	}
}

/**
 * The view with every source in `ids` renamed to what it maps to: what
 * `DocumentEditor.restamp` does to the entities, done to the record.
 */
export function renameViewSources(view: ProjectView, ids: Record<string, string>): ProjectView {
	const rename = (source: string): string => ids[source] ?? source;
	const rekey = <T>(record: Record<string, T>): Record<string, T> =>
		Object.fromEntries(Object.entries(record).map(([source, value]) => [rename(source), value]));

	return {
		...view,
		...(view.active === undefined ? {} : { active: rename(view.active) }),
		...(view.fileActive ? { fileActive: rename(view.fileActive) } : {}),
		selected: view.selected.map(rename),
		playhead: rekey(view.playhead),
		timeline: rekey(view.timeline),
		expanded: rekey(view.expanded),
		clipHeight: rekey(view.clipHeight),
	};
}

/** What the file says of the props the view can override: read off a fresh mount. */
export interface FileView {
	/** Source stamp of the scene the file marks `active`; absent when it marks none. */
	active?: string;
	/** The stage's `camera`, or the runtime's default when the file gives none. */
	camera?: number[];
}

const sameNumbers = (a: number[] | undefined, b: number[] | undefined): boolean =>
	a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => value === b[index]);

/** Which of the recorded view's overrides `applyViewToWorld` should put on. */
export interface ViewOverrides {
	active: boolean;
	camera: boolean;
}

/**
 * Decides, at a mount, whether the recorded `active` and `camera` go over
 * the file's, given what the file says now. The file wins when the file
 * changed: an author or an agent marking another scene `active`, or moving
 * the stage's `camera`, is the file's opening state being rewritten, and the
 * view follows it — `view.active`/`view.camera` take the file's value and
 * the override is skipped. When the file says what it said at the last
 * mount, the record stands over it as before. What the file says is then
 * kept as `fileActive`/`fileCamera` for the next mount. A record that has no
 * file values yet (one from before they were kept) cannot tell, and is put
 * back over the file this once. Pure: `view` is left alone, and the same
 * object comes back when nothing in it changed.
 */
export function reconcileWithFile(view: ProjectView, file: FileView): { view: ProjectView; overrideActive: boolean; overrideCamera: boolean } {
	const next: ProjectView = { ...view };
	let changed = false;

	const fileActive = file.active ?? '';
	const activeChanged = view.fileActive !== undefined && view.fileActive !== fileActive;
	const overrideActive = !activeChanged && view.active !== undefined;
	if (activeChanged) {
		if (file.active === undefined) delete next.active;
		else next.active = file.active;
	}
	if (view.fileActive !== fileActive) {
		next.fileActive = fileActive;
		changed = true;
	}

	const fileCamera = isNumberTuple(file.camera, 6) ? file.camera : undefined;
	const cameraChanged = view.fileCamera !== undefined && fileCamera !== undefined && !sameNumbers(view.fileCamera, fileCamera);
	const overrideCamera = !cameraChanged && isNumberTuple(view.camera, 6);
	if (cameraChanged) next.camera = [...fileCamera];
	if (fileCamera !== undefined && !sameNumbers(view.fileCamera, fileCamera)) {
		next.fileCamera = [...fileCamera];
		changed = true;
	}

	return { view: changed ? next : view, overrideActive, overrideCamera };
}

/**
 * What the file put on a freshly mounted world: the reconciler has already
 * applied its `active` and `camera`, so the active entity's source and the
 * camera matrix are the file's, read before any override.
 */
export function readFileView(world: World): FileView {
	let active: string | undefined;
	for (const entity of world.query(Active)) {
		active = entity.get(Source)?.value || undefined;
	}
	return { active, camera: getCameraMatrix(world) };
}

/**
 * Puts `view` back on a mounted world, over what the file said. Every write
 * goes straight to the traits and the runtime's actions — the same ones the
 * reconciler used a moment ago to apply the file — so nothing is reported
 * back as an edit. A source the mount no longer has is skipped: the element
 * was deleted, or the file was rewritten, and there is nothing to put the
 * view on. Active is a trait add, which is enough: the runtime's observers
 * keep it to one entity, and to a root. `overrides` says whether the
 * recorded active and camera go on at all — `reconcileWithFile` decides —
 * and both do unless told otherwise.
 */
export function applyViewToWorld(world: World, view: ProjectView, overrides: ViewOverrides = { active: true, camera: true }): void {
	const entities = new Map<string, Entity>();
	for (const entity of world.query(Source)) {
		const source = entity.get(Source)?.value;
		if (source) entities.set(source, entity);
	}
	const fps = world.get(FrameRate)?.value ?? 30;

	if (overrides.camera && isNumberTuple(view.camera, 6)) setCameraMatrix(world, view.camera as CameraMatrix);

	// A recorded selection replaces the file's; none recorded leaves it.
	if (view.selected.length) {
		const next = new Set(view.selected.map((source) => entities.get(source)).filter((entity): entity is Entity => !!entity));
		if (next.size) {
			for (const entity of [...world.query(Selected)]) {
				if (!next.has(entity)) entity.remove(Selected);
			}
			for (const entity of next) entity.add(Selected);
		}
	}

	if (overrides.active && view.active !== undefined) {
		const entity = entities.get(view.active);
		if (entity?.has(Scene)) entity.add(Active);
	}
	// Nothing recorded and the file marks no scene — a project first opened on
	// this machine after being made on another. The timeline shows the active
	// scene, so an empty timeline beside a drawn canvas is what an unset one
	// looks like: the first scene stands in until something else is picked.
	if (!world.query(Active).length) {
		const [first] = world.query(Scene);
		first?.add(Active);
	}

	for (const [source, seconds] of Object.entries(view.playhead)) {
		const entity = entities.get(source);
		if (entity?.has(Scene)) setPlayhead(world, entity, secondsToFrames(seconds, fps));
	}

	for (const [source, timeline] of Object.entries(view.timeline)) {
		const entity = entities.get(source);
		if (entity) setTimelineView(world, entity, timeline as TimelineView);
	}

	for (const [source, expanded] of Object.entries(view.expanded)) {
		const entity = entities.get(source);
		if (!entity) continue;
		if (expanded) entity.add(Expanded);
		else entity.remove(Expanded);
	}

	for (const [source, height] of Object.entries(view.clipHeight)) {
		const entity = entities.get(source);
		if (!entity) continue;
		entity.add(ClipHeight);
		entity.set(ClipHeight, { value: height });
	}
}

/** How long after the last view edit the record is written. */
const SAVE_DELAY = 250;

export interface ViewStore {
	/** Resolves once the persisted view has been read; `applyToWorld` before then applies nothing recorded. */
	readonly ready: Promise<void>;
	/** Folds a view-prop edit in and schedules a save. */
	push(edit: ViewEdit): void;
	/** Puts the current view back on the mounted world, letting the file win where it changed since the last mount. */
	applyToWorld(): void;
	/** Writes what is pending and stops listening. */
	dispose(): void;
}

/**
 * The view store for one open project: takes the view-prop edits the editor
 * reports, keeps the folded view in the app's database, and puts it back on
 * the stage after each mount. Edits reported before the record has been read
 * are held and folded over it once it has. Renames the editor announces
 * (`onRename`, for elements it inserted) are followed, so a selection made on
 * a new element keeps its key once the file has named it; edits against a
 * still-pending source are held until then.
 */
export function createViewStore(projectId: string, world: World): ViewStore {
	let view = emptyView();
	let loaded = false;
	let disposed = false;
	let dirty = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const pending: ViewEdit[] = [];

	const save = (): void => {
		timer = undefined;
		if (!dirty) return;
		dirty = false;
		saveProjectView(projectId, view).catch((error) => console.error('[view] could not save the view', error));
	};

	const schedule = (): void => {
		dirty = true;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(save, SAVE_DELAY);
	};

	const fold = (edit: ViewEdit): void => {
		const next = applyViewEdit(view, edit);
		if (next === view) return;
		view = next;
		schedule();
	};

	const ready = loadProjectView(projectId).then((stored) => {
		if (disposed) return;
		loaded = true;
		if (stored) view = { ...emptyView(), ...stored };
		for (const edit of pending.splice(0)) fold(edit);
	});

	const unlisten = getDocumentEditor(world).onRename((ids) => {
		// The record first, then the edits still waiting on it; those whose
		// source now has a name can go in.
		const renamed = renameViewSources(view, ids);
		if (renamed !== view) {
			view = renamed;
			schedule();
		}
		for (const edit of pending) edit.source = ids[edit.source] ?? edit.source;
		if (!loaded) return;
		const settled = pending.filter((edit) => !isPendingSource(edit.source));
		if (!settled.length) return;
		pending.splice(0, pending.length, ...pending.filter((edit) => isPendingSource(edit.source)));
		for (const edit of settled) fold(edit);
	});

	return {
		ready,
		push(edit) {
			if (disposed) return;
			if (!loaded || isPendingSource(edit.source)) {
				pending.push({ source: edit.source, name: edit.name, value: edit.value });
				return;
			}
			fold(edit);
		},
		applyToWorld() {
			if (disposed || !loaded) return;
			// The file's active and camera, as this mount has them; where they
			// differ from the last mount's, the file has been rewritten and the
			// view follows it instead of covering it.
			const reconciled = reconcileWithFile(view, readFileView(world));
			if (reconciled.view !== view) {
				view = reconciled.view;
				schedule();
			}
			applyViewToWorld(world, view, { active: reconciled.overrideActive, camera: reconciled.overrideCamera });
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			unlisten();
			if (timer !== undefined) clearTimeout(timer);
			save();
		},
	};
}
