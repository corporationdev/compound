/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A document's properties — its frontmatter — as rows above the body: a
// name, and a value edited by its type. The type comes from the folder's
// table schema when the document sits in a table, else from the value.

import { For, Show, Switch, Match, createEffect, createMemo, createSignal, createUniqueId } from "solid-js";

import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverPortal, PopoverTrigger } from "@/components/ui/popover";
import { cx } from "@/lib/cva";

import {
  PROPERTY_TYPE_LABELS,
  inferPropertyType,
  propertyFromText,
  propertyToText,
  type Properties,
  type PropertySchema,
  type PropertyType,
  type TableSchema,
} from "./markdown";

// Drawn after Notion's property type icons, so they read at a glance.
const TYPE_ICONS: Record<PropertyType, string> = {
  text: "prop-text",
  number: "prop-number",
  checkbox: "prop-checkbox",
  date: "prop-date",
  list: "prop-multiselect",
  select: "prop-select",
};

/** The schema for `name`: the table's, else one read off the value. */
export function schemaFor(name: string, value: unknown, schema: TableSchema | null | undefined): PropertySchema {
  return schema?.properties[name] ?? { type: inferPropertyType(value) };
}

/** Property names in display order: the schema's first, then the rest as written. */
export function propertyNames(properties: Properties | null, schema: TableSchema | null | undefined): string[] {
  const names = new Set<string>();
  for (const name of Object.keys(schema?.properties ?? {})) names.add(name);
  for (const name of Object.keys(properties ?? {})) names.add(name);
  return [...names];
}

type ValueProps = {
  value: unknown;
  schema: PropertySchema;
  onChange: (value: unknown) => void;
  /** Tighter, for a table cell. */
  compact?: boolean;
  /** Accessible field name, especially inside a database row. */
  label?: string;
  class?: string;
};

const INPUT = "h-6 min-w-0 flex-1 rounded-sm bg-transparent px-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 hover:bg-accent focus:bg-input focus:ring-1 focus:ring-ring select-text";

/** One property's value, edited as its type calls for. */
export function PropertyValue(props: ValueProps) {
  const commitText = (text: string) => {
    const next = propertyFromText(text, props.schema.type);
    if (propertyToText(next) === propertyToText(props.value) && typeof next === typeof props.value) return;
    props.onChange(next);
  };

  const stop = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Enter") (event.currentTarget as HTMLInputElement).blur();
    if (event.key === "Escape") {
      const input = event.currentTarget as HTMLInputElement;
      const text = propertyToText(props.value);
      input.value = input.type === "date" ? text.slice(0, 10) : text;
      (event.currentTarget as HTMLInputElement).blur();
    }
  };

  return (
    <Switch>
      <Match when={props.schema.type === "checkbox"}>
        <label class={cx("flex flex-1 items-center px-1.5", props.compact ? "min-h-8 cursor-pointer" : "h-6", props.class)}>
          <input
            type="checkbox"
            aria-label={props.label ?? "Checkbox value"}
            checked={props.value === true}
            onChange={(event) => props.onChange(event.currentTarget.checked)}
            class="size-3.5 accent-primary"
          />
        </label>
      </Match>
      <Match when={props.schema.type === "select"}>
        <SelectValueEditor value={props.value} options={props.schema.options ?? []} onChange={props.onChange} class={props.class} label={props.label} compact={props.compact} />
      </Match>
      <Match when={props.schema.type === "list"}>
        <MultiSelectEditor value={props.value} options={props.schema.options ?? []} onChange={props.onChange} class={props.class} label={props.label} compact={props.compact} />
      </Match>
      <Match when={props.schema.type === "date"}>
        <input
          type="date"
          aria-label={props.label ?? "Property value"}
          value={propertyToText(props.value).slice(0, 10)}
          onChange={(event) => commitText(event.currentTarget.value)}
          onKeyDown={stop}
          class={cx(INPUT, "[color-scheme:dark]", props.compact && "h-8 w-full rounded-none text-[14px]", props.compact && !props.value && "[&:not(:focus)::-webkit-datetime-edit]:text-transparent [&:not(:focus)::-webkit-calendar-picker-indicator]:opacity-0", props.class)}
        />
      </Match>
      <Match when={props.schema.type === "number"}>
        <input
          type="number"
          aria-label={props.label ?? "Property value"}
          value={propertyToText(props.value)}
          placeholder={props.compact ? "" : "Empty"}
          onChange={(event) => commitText(event.currentTarget.value)}
          onKeyDown={stop}
          class={cx(INPUT, props.compact && "h-8 w-full rounded-none text-[14px]", props.class)}
        />
      </Match>
      <Match when={true}>
        <input
          type="text"
          aria-label={props.label ?? "Property value"}
          value={propertyToText(props.value)}
          placeholder={props.compact ? "" : "Empty"}
          onChange={(event) => commitText(event.currentTarget.value)}
          onKeyDown={stop}
          class={cx(INPUT, props.compact && "h-8 w-full rounded-none text-[14px]", props.class)}
        />
      </Match>
    </Switch>
  );
}

/** A searchable select; custom values remain ordinary frontmatter strings. */
function SelectValueEditor(props: { value: unknown; options: string[]; onChange: (value: unknown) => void; class?: string; label?: string; compact?: boolean }) {
  const current = () => propertyToText(props.value);
  const [query, setQuery] = createSignal("");
  const [open, setOpen] = createSignal(false);
  const [highlighted, setHighlighted] = createSignal(0);
  const listId = createUniqueId();
  const options = createMemo(() => [...new Set([...props.options, ...(current() ? [current()] : [])])]);
  const matches = createMemo(() => options().filter((option) => option.toLowerCase().includes(query().trim().toLowerCase())));
  const canCreate = () => !!query().trim() && !options().some((option) => option.toLowerCase() === query().trim().toLowerCase());
  const candidates = () => [...matches(), ...(canCreate() ? [query().trim()] : [])];
  const active = () => Math.min(highlighted(), candidates().length - 1);
  const choose = (value: string) => { props.onChange(value); setOpen(false); setQuery(""); setHighlighted(0); };
  return (
    <Popover placement="bottom-start" open={open()} onOpenChange={(value) => { setOpen(value); setQuery(""); setHighlighted(0); }}>
      <PopoverTrigger as="button" type="button" aria-label={props.label ?? "Value"}
        class={cx("inline-flex min-w-0 items-center gap-1 px-1.5 text-left text-xs hover:bg-accent data-[expanded]:bg-accent", props.compact ? "min-h-8 w-full flex-1 text-[14px]" : "h-7 rounded-sm", current() ? "text-foreground" : "text-muted-foreground/60", props.class)}>
        <Show when={current()} fallback={!props.compact && <span>Empty</span>}>
          <span class="truncate rounded-sm bg-accent px-1.5 py-0.5">{current()}</span>
        </Show>
        <Show when={!props.compact}><Icon name="chevron-down" class="size-4 shrink-0 text-muted-foreground" /></Show>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent class="w-60 p-1.5">
          <input type="text" role="combobox" aria-label="Search select options" aria-expanded={open()} aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={active() >= 0 ? `${listId}-${active()}` : undefined} placeholder="Search or create an option"
            ref={(element) => queueMicrotask(() => element.focus())}
            onInput={(event) => { setQuery(event.currentTarget.value); setHighlighted(Math.max(0, candidates().findIndex((option) => option.toLowerCase() === query().trim().toLowerCase()))); }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") { event.preventDefault(); setOpen(false); setQuery(""); }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const count = candidates().length;
                if (count) setHighlighted((active() + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const choice = candidates()[active()];
                if (choice !== undefined) choose(choice);
              }
            }}
            class="mb-1.5 h-8 w-full rounded-sm bg-input px-2 text-xs outline-none focus:ring-1 focus:ring-ring select-text" />
          <button type="button" onClick={() => choose("")} class="w-full rounded-sm px-2 py-2 text-left text-xs text-muted-foreground hover:bg-accent">Clear value</button>
          <div id={listId} role="listbox" aria-label={props.label ?? "Options"} class="flex max-h-60 flex-col overflow-auto">
            <For each={candidates()}>{(option, index) => (
              <button id={`${listId}-${index()}`} type="button" role="option" aria-selected={option === current()}
                onMouseMove={() => setHighlighted(index())} onClick={() => choose(option)}
                ref={(element) => createEffect(() => { if (index() === active()) queueMicrotask(() => element.scrollIntoView({ block: "nearest" })); })}
                class={cx("flex items-center gap-2 rounded-sm px-2 py-2 text-left text-xs hover:bg-accent", active() === index() && "bg-accent")}>
                <span class="min-w-0 flex-1 truncate">{canCreate() && index() === candidates().length - 1 ? `Create “${option}”` : option}</span>
                <Show when={option === current()}><Icon name="confirm-check" class="size-4" /></Show>
              </button>
            )}</For>
          </div>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}

/** The values a list property holds, as strings. */
function listValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  const text = propertyToText(value);
  return text ? text.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

/**
 * A multi-select property, as Notion has it: the values as chips, a "+"
 * that opens the options to pick from, and a box to type a new one.
 * Options are the schema's plus whatever the value already holds.
 */
function MultiSelectEditor(props: { value: unknown; options: string[]; onChange: (value: unknown) => void; class?: string; label?: string; compact?: boolean }) {
  const values = createMemo(() => listValues(props.value));
  const [query, setQuery] = createSignal("");
  const [open, setOpen] = createSignal(false);
  const [highlighted, setHighlighted] = createSignal(0);
  const listId = createUniqueId();
  const options = createMemo(() => {
    const all = [...new Set([...props.options, ...values()])];
    const needle = query().trim().toLowerCase();
    return needle ? all.filter((option) => option.toLowerCase().includes(needle)) : all;
  });
  const canCreate = () => !!query().trim() && !options().some((option) => option.toLowerCase() === query().trim().toLowerCase());
  const candidates = () => [...options(), ...(canCreate() ? [query().trim()] : [])];
  const active = () => Math.min(highlighted(), candidates().length - 1);
  const toggle = (option: string) => {
    const current = values();
    props.onChange(current.includes(option) ? current.filter((item) => item !== option) : [...current, option]);
  };
  // The box is not bound to the signal: writing the value back on every
  // keystroke fights the caret. It is read on input and cleared by hand.
  let box: HTMLInputElement | undefined;
  const clear = () => {
    setQuery("");
    setHighlighted(0);
    if (box) box.value = "";
  };
  const addTyped = () => {
    const typed = query().trim();
    if (!typed) return;
    if (!values().includes(typed)) props.onChange([...values(), typed]);
    clear();
  };
  return (
    <div class={cx("flex min-w-0 flex-1 flex-wrap items-center", props.compact ? "min-h-8 w-full" : "min-h-6 gap-1 px-1", props.class)}>
      <Show when={!props.compact}>
      <For each={values()}>
        {(item) => (
          <span class="inline-flex h-5 max-w-48 items-center gap-0.5 rounded-sm bg-accent pl-1.5 pr-0.5 text-xs text-foreground">
            <span class="truncate">{item}</span>
            <button
              type="button"
              aria-label={`Remove ${item}`}
              onClick={() => toggle(item)}
              class="grid size-4 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Icon name="close-remove-small" class="size-3.5" />
            </button>
          </span>
        )}
      </For>
      </Show>
      <Popover placement="bottom-start" open={open()} onOpenChange={(value) => { setOpen(value); if (!value) clear(); }}>
        <Show when={props.compact} fallback={
          <PopoverTrigger
            as="button"
            type="button"
            aria-label={props.label ? `Add ${props.label}` : "Add a value"}
            class={cx(
              "inline-flex h-5 items-center gap-0.5 rounded-sm px-1 text-xs text-muted-foreground/70 hover:bg-accent hover:text-foreground data-[expanded]:bg-accent",
              values().length === 0 && "pl-0.5",
            )}
          >
            <Icon name="plus-add-small" class="size-4" />
            <Show when={values().length === 0}><span>Empty</span></Show>
          </PopoverTrigger>
        }>
          <PopoverTrigger as="button" type="button" aria-label={props.label ?? "Multi-select value"}
            class="flex min-h-8 w-full min-w-0 flex-1 flex-wrap items-center gap-1 px-1.5 py-1.5 text-left text-[14px] text-foreground hover:bg-accent data-[expanded]:bg-accent">
            <For each={values()}>{(item) => <span class="inline-flex h-5 max-w-full items-center truncate rounded-sm bg-accent px-1.5">{item}</span>}</For>
          </PopoverTrigger>
        </Show>
        <PopoverPortal>
          <PopoverContent class="w-56 p-1">
            <input
              ref={(el) => {
                box = el;
                queueMicrotask(() => el.focus());
              }}
              type="text"
              placeholder="Search or type a new option"
              role="combobox"
              aria-label={props.label ? `Search ${props.label} options` : "Search options"}
              aria-expanded={open()} aria-controls={listId} aria-autocomplete="list"
              aria-activedescendant={active() >= 0 ? `${listId}-${active()}` : undefined}
              onInput={(event) => { setQuery(event.currentTarget.value); setHighlighted(Math.max(0, candidates().findIndex((option) => option.toLowerCase() === query().trim().toLowerCase()))); }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") { event.preventDefault(); setOpen(false); clear(); }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const count = candidates().length;
                  if (count) setHighlighted((active() + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  const choice = candidates()[active()];
                  if (choice !== undefined) { toggle(choice); clear(); }
                }
              }}
              class="mb-1 h-7 w-full rounded-md bg-input px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:ring-1 focus:ring-ring select-text"
            />
            <div id={listId} role="listbox" aria-label={props.label ?? "Options"} aria-multiselectable="true" class="flex max-h-56 flex-col overflow-y-auto">
              <For each={options()}>
                {(option, index) => (
                  <button
                    id={`${listId}-${index()}`} role="option" aria-selected={values().includes(option)}
                    ref={(element) => createEffect(() => { if (index() === active()) queueMicrotask(() => element.scrollIntoView({ block: "nearest" })); })}
                    onMouseMove={() => setHighlighted(index())}
                    type="button"
                    onClick={() => toggle(option)}
                    class={cx("flex h-7 items-center gap-2 rounded-md px-2 text-left text-xs text-foreground hover:bg-accent", active() === index() && "bg-accent")}
                  >
                    <span class="inline-flex h-5 max-w-full items-center truncate rounded-sm bg-accent px-1.5">{option}</span>
                    <span class="flex-1" />
                    <Show when={values().includes(option)}>
                      <Icon name="confirm-check" class="size-4 text-muted-foreground" />
                    </Show>
                  </button>
                )}
              </For>
              <Show when={canCreate()}>
                <button
                  type="button"
                  id={`${listId}-${options().length}`} role="option" aria-selected="false"
                  onMouseMove={() => setHighlighted(options().length)}
                  onClick={addTyped}
                  class={cx("flex h-7 items-center gap-1 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground", active() === options().length && "bg-accent")}
                >
                  <span>Create</span>
                  <span class="inline-flex h-5 max-w-full items-center truncate rounded-sm bg-accent px-1.5 text-foreground">{query().trim()}</span>
                </button>
              </Show>
              <Show when={options().length === 0 && !query().trim()}>
                <p class="px-2 py-1 text-xs text-muted-foreground">Type to add an option.</p>
              </Show>
            </div>
          </PopoverContent>
        </PopoverPortal>
      </Popover>
    </div>
  );
}

type PanelProps = {
  properties: Properties | null;
  schema: TableSchema | null | undefined;
  onChange: (next: Properties | null) => void;
};

/** A fresh property name not yet in use. */
function freeName(names: string[]): string {
  const existing = new Set(names);
  let name = "Property";
  for (let i = 2; existing.has(name); i++) name = `Property ${i}`;
  return name;
}

/** `properties` with `from` renamed to `to`, in the same position. */
function renameKey(properties: Properties, from: string, to: string): Properties {
  const next: Properties = {};
  for (const [key, value] of Object.entries(properties)) next[key === from ? to : key] = value;
  return next;
}

export function PropertiesPanel(props: PanelProps) {
  const [editingName, setEditingName] = createSignal<string | null>(null);
  const names = createMemo(() => propertyNames(props.properties, props.schema));

  const setValue = (name: string, value: unknown) => {
    props.onChange({ ...(props.properties ?? {}), [name]: value });
  };

  const remove = (name: string) => {
    const next = { ...(props.properties ?? {}) };
    delete next[name];
    props.onChange(Object.keys(next).length ? next : null);
  };

  const add = () => {
    const name = freeName(names());
    props.onChange({ ...(props.properties ?? {}), [name]: "" });
    setEditingName(name);
  };

  const commitName = (from: string, to: string) => {
    setEditingName(null);
    const trimmed = to.trim();
    if (!trimmed || trimmed === from || !props.properties || trimmed in props.properties) return;
    props.onChange(renameKey(props.properties, from, trimmed));
  };

  return (
    <div class="flex flex-col gap-0.5">
      <For each={names()}>
        {(name) => {
          const schema = () => schemaFor(name, props.properties?.[name], props.schema);
          return (
            <div class="group flex min-h-7 items-center gap-1">
              <div class="flex w-40 shrink-0 items-center gap-1 pr-2">
                <span title={PROPERTY_TYPE_LABELS[schema().type]} class="grid size-4 shrink-0 place-items-center">
                  <Icon name={TYPE_ICONS[schema().type]} class="size-4 text-muted-foreground/70" />
                </span>
                <Show
                  when={editingName() === name}
                  fallback={
                    <button
                      type="button"
                      disabled={!!props.schema?.properties[name]}
                      title={props.schema?.properties[name] ? "Database property" : "Rename property"}
                      onClick={() => setEditingName(name)}
                      class="h-6 min-w-0 flex-1 truncate rounded-sm px-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      {name}
                    </button>
                  }
                >
                  <input
                    ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                    type="text"
                    value={name}
                    onBlur={(event) => commitName(name, event.currentTarget.value)}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") { event.currentTarget.value = name; setEditingName(null); }
                    }}
                    class="h-6 min-w-0 flex-1 rounded-sm bg-input px-1 text-xs text-foreground outline-none ring-1 ring-ring select-text"
                  />
                </Show>
              </div>
              <PropertyValue value={props.properties?.[name]} schema={schema()} label={name} onChange={(value) => setValue(name, value)} />
              <button
                type="button"
                title={props.schema?.properties[name] ? "Clear value" : "Remove property"}
                aria-label={`${props.schema?.properties[name] ? "Clear" : "Remove"} ${name}`}
                onClick={() => remove(name)}
                class="grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
              >
                <Icon name="close-remove-small" class="size-4" />
              </button>
            </div>
          );
        }}
      </For>
      <button
        type="button"
        onClick={add}
        class="flex h-7 w-fit items-center gap-1 rounded-md px-1 text-xs text-muted-foreground/70 hover:bg-accent hover:text-foreground"
      >
        <Icon name="plus-add-small" class="size-4" />
        Add a property
      </button>
    </div>
  );
}
