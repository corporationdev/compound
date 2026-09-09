import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareUserData } from '../src/brand-migration';

test('the first Compound launch copies project storage without moving the old profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'compound-profile-test-'));
  try {
    const old = join(root, 'Diffusion Studio');
    mkdirSync(join(old, 'IndexedDB'), { recursive: true });
    writeFileSync(join(old, 'IndexedDB', 'projects'), 'saved roots');
    writeFileSync(join(old, 'auth-old.bin'), 'old encrypted session');
    const next = prepareUserData(root);
    expect(next).toBe(join(root, 'Compound'));
    expect(readFileSync(join(next, 'IndexedDB', 'projects'), 'utf8')).toBe('saved roots');
    expect(readFileSync(join(old, 'IndexedDB', 'projects'), 'utf8')).toBe('saved roots');
    expect(existsSync(join(next, 'auth-old.bin'))).toBe(false);
    writeFileSync(join(next, 'IndexedDB', 'projects'), 'new roots');
    prepareUserData(root);
    expect(readFileSync(join(next, 'IndexedDB', 'projects'), 'utf8')).toBe('new roots');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('development profiles migrate, while clean installs get an empty Compound directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'compound-profile-test-'));
  try {
    const old = join(root, '@diffusionstudio', 'desktop', 'Local Storage');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'preferences'), 'saved preferences');
    expect(readFileSync(join(prepareUserData(root), 'Local Storage', 'preferences'), 'utf8')).toBe('saved preferences');
    const clean = join(root, 'clean');
    expect(existsSync(prepareUserData(clean))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
