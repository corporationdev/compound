/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A document on disk is markdown with YAML frontmatter: the frontmatter is
// its properties, the body its prose. What the editor shows is these two
// taken apart, and what it writes is them put back together — so an agent
// editing the same file with its own tools sees exactly what the user sees.

import { parse, stringify } from 'yaml';

/** Frontmatter as parsed: a flat map of property name to value. */
export type Properties = Record<string, unknown>;

export type SplitDocument = {
  /** The properties, or null when the file has no frontmatter (or none that parses). */
  properties: Properties | null;
  /** The markdown after the frontmatter. */
  body: string;
};

const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** Takes a file's text apart into properties and body. */
export function splitDocument(text: string): SplitDocument {
  const match = FRONTMATTER.exec(text);
  if (!match) return { properties: null, body: text };
  let parsed: unknown;
  try {
    parsed = parse(match[1] ?? '');
  } catch {
    return { properties: null, body: text };
  }
  if (parsed === null || parsed === undefined) return { properties: {}, body: text.slice(match[0].length) };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return { properties: null, body: text };
  return { properties: parsed as Properties, body: text.slice(match[0].length) };
}

/**
 * Puts a document back together. No frontmatter block is written for null
 * or empty properties, so a plain note stays a plain note.
 */
export function joinDocument(properties: Properties | null, body: string): string {
  const trimmed = body.replace(/^\n+/, '');
  if (!properties || Object.keys(properties).length === 0) return trimmed;
  const yaml = stringify(properties, { lineWidth: 0 }).replace(/\n+$/, '');
  return `---\n${yaml}\n---\n\n${trimmed}`;
}

/** What kind of value a property holds, from the value itself. */
export type PropertyType = 'text' | 'number' | 'checkbox' | 'date' | 'list' | 'select';

export type PropertySchema = {
  type: PropertyType;
  /** For `select`: the values to choose from. */
  options?: string[];
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** The type a value reads as when nothing says otherwise. */
export function inferPropertyType(value: unknown): PropertyType {
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'list';
  if (value instanceof Date) return 'date';
  if (typeof value === 'string' && ISO_DATE.test(value)) return 'date';
  return 'text';
}

/** A value for editing as text: dates as ISO days, lists comma-joined, the rest as-is. */
export function propertyToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  return String(value);
}

/** Text typed into a property, read back as the value its type calls for. */
export function propertyFromText(text: string, type: PropertyType): unknown {
  switch (type) {
    case 'number': {
      const number = Number(text.trim());
      return text.trim() === '' || Number.isNaN(number) ? text : number;
    }
    case 'checkbox':
      return text === 'true';
    case 'list':
      return text.split(',').map((item) => item.trim()).filter(Boolean);
    default:
      return text;
  }
}

/** A table folder's schema, as `_table.yaml` holds it. */
export type TableSchema = {
  name?: string;
  properties: Record<string, PropertySchema>;
};

/** Reads a `_table.yaml`, lenient about what it finds: unknown types read as text. */
export function parseTableSchema(text: string): TableSchema {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    return { properties: {} };
  }
  if (!parsed || typeof parsed !== 'object') return { properties: {} };
  const raw = parsed as { name?: unknown; properties?: unknown };
  const properties: Record<string, PropertySchema> = {};
  if (raw.properties && typeof raw.properties === 'object') {
    for (const [name, spec] of Object.entries(raw.properties as Record<string, unknown>)) {
      const type = typeof spec === 'string' ? spec : (spec as { type?: unknown })?.type;
      const options = typeof spec === 'object' && spec ? (spec as { options?: unknown }).options : undefined;
      properties[name] = {
        type: normalizeType(type),
        ...(Array.isArray(options) ? { options: options.map(String) } : {}),
      };
    }
  }
  return { ...(typeof raw.name === 'string' ? { name: raw.name } : {}), properties };
}

const PROPERTY_TYPES: ReadonlySet<string> = new Set(['text', 'number', 'checkbox', 'date', 'list', 'select']);
const isPropertyType = (value: unknown): value is PropertyType => typeof value === 'string' && PROPERTY_TYPES.has(value);

/** Names a schema may use for a type, including Notion's, read as ours. */
const TYPE_ALIASES: Record<string, PropertyType> = {
  multiselect: 'list',
  'multi-select': 'list',
  multi_select: 'list',
  tags: 'list',
  boolean: 'checkbox',
  bool: 'checkbox',
  string: 'text',
  enum: 'select',
};

function normalizeType(value: unknown): PropertyType {
  if (isPropertyType(value)) return value;
  if (typeof value === 'string' && value.toLowerCase() in TYPE_ALIASES) return TYPE_ALIASES[value.toLowerCase()]!;
  return 'text';
}

/** What a type is called in the UI. */
export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  text: 'Text',
  number: 'Number',
  checkbox: 'Checkbox',
  date: 'Date',
  list: 'Multi-select',
  select: 'Select',
};

/** The name of the schema file that makes a folder a table. */
export const TABLE_SCHEMA_FILE = '_table.yaml';
