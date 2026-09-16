import { describe, expect, test } from 'bun:test';
import {
  inferPropertyType,
  joinDocument,
  parseTableSchema,
  propertyFromText,
  propertyToText,
  splitDocument,
} from '../src/components/workspace/markdown';

describe('splitDocument', () => {
  test('takes frontmatter apart from the body', () => {
    const text = '---\ntitle: Hook\nstatus: Scripting\ntags:\n  - a\n  - b\n---\n\n# Body\n';
    expect(splitDocument(text)).toEqual({
      properties: { title: 'Hook', status: 'Scripting', tags: ['a', 'b'] },
      body: '\n# Body\n',
    });
  });

  test('a file without frontmatter is all body', () => {
    expect(splitDocument('# Just a note\n')).toEqual({ properties: null, body: '# Just a note\n' });
    expect(splitDocument('')).toEqual({ properties: null, body: '' });
  });

  test('a horizontal rule at the top is not frontmatter', () => {
    expect(splitDocument('---\n\nText').properties).toBeNull();
    expect(splitDocument('--- not yaml\nx\n---\n').properties).toBeNull();
  });

  test('frontmatter that does not parse, or is not a map, leaves the text alone', () => {
    const broken = '---\n: [\n---\nbody';
    expect(splitDocument(broken)).toEqual({ properties: null, body: broken });
    const list = '---\n- a\n- b\n---\nbody';
    expect(splitDocument(list)).toEqual({ properties: null, body: list });
  });

  test('empty frontmatter reads as no properties but is still frontmatter', () => {
    expect(splitDocument('---\n---\nbody')).toEqual({ properties: {}, body: 'body' });
  });

  test('handles CRLF and a file that is only frontmatter', () => {
    expect(splitDocument('---\r\na: 1\r\n---\r\nbody')).toEqual({ properties: { a: 1 }, body: 'body' });
    expect(splitDocument('---\na: 1\n---')).toEqual({ properties: { a: 1 }, body: '' });
  });
});

describe('joinDocument', () => {
  test('writes frontmatter, a blank line, then the body', () => {
    expect(joinDocument({ title: 'Hook', done: false, n: 3, tags: ['a', 'b'] }, '# Body\n')).toBe(
      '---\ntitle: Hook\ndone: false\nn: 3\ntags:\n  - a\n  - b\n---\n\n# Body\n',
    );
  });

  test('no properties means no frontmatter', () => {
    expect(joinDocument(null, 'plain\n')).toBe('plain\n');
    expect(joinDocument({}, 'plain\n')).toBe('plain\n');
  });

  test('round-trips what split produced', () => {
    const text = '---\ntitle: Hook\nstatus: Scripting\n---\n\n# Body\n\nMore.\n';
    const { properties, body } = splitDocument(text);
    expect(joinDocument(properties, body)).toBe(text);
  });
});

describe('property types', () => {
  test('infers from values', () => {
    expect(inferPropertyType(true)).toBe('checkbox');
    expect(inferPropertyType(3)).toBe('number');
    expect(inferPropertyType(['a'])).toBe('list');
    expect(inferPropertyType('2026-09-15')).toBe('date');
    expect(inferPropertyType('2026-09-15T10:22:00Z')).toBe('date');
    expect(inferPropertyType('Scripting')).toBe('text');
    expect(inferPropertyType(null)).toBe('text');
  });

  test('converts to and from text by type', () => {
    expect(propertyToText(['a', 'b'])).toBe('a, b');
    expect(propertyToText(new Date('2026-09-15T00:00:00Z'))).toBe('2026-09-15');
    expect(propertyToText(null)).toBe('');
    expect(propertyFromText('42', 'number')).toBe(42);
    expect(propertyFromText('x', 'number')).toBe('x');
    expect(propertyFromText('true', 'checkbox')).toBe(true);
    expect(propertyFromText('a, b ,c', 'list')).toEqual(['a', 'b', 'c']);
    expect(propertyFromText('hello', 'text')).toBe('hello');
  });
});

describe('parseTableSchema', () => {
  test('reads property specs in long and short form', () => {
    const schema = parseTableSchema('name: Ideas\nproperties:\n  status:\n    type: select\n    options: [Idea, Scripting, Done]\n  views: number\n  weird:\n    type: nope\n');
    expect(schema).toEqual({
      name: 'Ideas',
      properties: {
        status: { type: 'select', options: ['Idea', 'Scripting', 'Done'] },
        views: { type: 'number' },
        weird: { type: 'text' },
      },
    });
  });

  test("reads Notion's names for types", () => {
    const schema = parseTableSchema('properties:\n  tags: multiselect\n  done: boolean\n  kind: enum\n');
    expect(schema.properties).toEqual({ tags: { type: 'list' }, done: { type: 'checkbox' }, kind: { type: 'select' } });
  });

  test('tolerates an empty or broken file', () => {
    expect(parseTableSchema('')).toEqual({ properties: {} });
    expect(parseTableSchema(': [')).toEqual({ properties: {} });
  });
});

describe('slash menu items', () => {
  test('filters by title and keyword, keeps order, and answers everything for an empty query', async () => {
    const { blockItems, filterItems } = await import('../src/components/workspace/slash-items');
    const items = blockItems();
    expect(filterItems(items, '').map((item) => item.id)).toEqual(items.map((item) => item.id));
    expect(filterItems(items, 'head').map((item) => item.id)).toEqual(['h1', 'h2', 'h3']);
    expect(filterItems(items, 'h2').map((item) => item.id)).toEqual(['h2']);
    expect(filterItems(items, 'check').map((item) => item.id)).toEqual(['todo']);
    expect(filterItems(items, 'zzz')).toEqual([]);
  });
});
