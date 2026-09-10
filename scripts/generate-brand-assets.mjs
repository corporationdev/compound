// Regenerate Compound's desktop, web, and installer artwork from the source PNG.
import sharp from 'sharp';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'assets/compound-logo.png');
// Center on the silhouette's visual mass, not the source image's whitespace.
// The two right lobes otherwise make a bounding-box-centered mark look off-center.
const { data, info } = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
let sumX = 0, sumY = 0, count = 0;
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * info.channels;
    if ((data[i] + data[i + 1] + data[i + 2]) / 3 < 170) {
      sumX += x; sumY += y; count++;
    }
  }
}
if (!count) throw new Error('No logo silhouette found');
const center = { x: sumX / count, y: sumY / count };
const original = `data:image/png;base64,${(await readFile(source)).toString('base64')}`;
const centered = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000" fill="white"/><image href="${original}" x="${500 - center.x}" y="${500 - center.y}" width="${info.width}" height="${info.height}"/></svg>`);
const centeredPng = await sharp(centered).png().toBuffer();
await writeFile(join(root, 'assets/compound-logo-centered.png'), centeredPng);
const logo = `data:image/png;base64,${centeredPng.toString('base64')}`;
const flatMark = await readFile(join(root, 'assets/compound-mark.svg'), 'utf8');
const desktop = join(root, 'apps/desktop/assets');
const web = join(root, 'apps/web/public');
const svg = (w, h, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);
const render = (path, data, width) => sharp(data).resize({ width }).png().toFile(join(root, path));
await mkdir(desktop, { recursive: true });
await mkdir(web, { recursive: true });

const appIcon = svg(1024, 1024, `
  <defs><clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="184"/></clipPath>
  <filter id="shadow" x="-25%" y="-25%" width="150%" height="150%"><feDropShadow dy="10" stdDeviation="10" flood-opacity=".16"/></filter></defs>
  <rect x="100" y="100" width="824" height="824" rx="184" fill="white" filter="url(#shadow)"/>
  <image href="${logo}" x="100" y="100" width="824" height="824" clip-path="url(#tile)"/>`);
await render('apps/desktop/assets/icon.png', appIcon, 1024);
await copyFile(join(desktop, 'icon.png'), join(desktop, 'icon-dev.png'));
// UI artwork and native artwork share exactly the same visual center.
await sharp(centeredPng).resize(256).png().toFile(join(web, 'compound-logo.png'));
await writeFile(join(root, 'apps/web/src/assets/icons/compound-logo.svg'), flatMark);
await writeFile(join(web, 'compound-mark.svg'), flatMark);
const flatPath = flatMark.match(/<path[^>]* d="([^"]+)"/)?.[1];
if (!flatPath) throw new Error('The flat mark must contain its traced path');
await writeFile(join(root, 'apps/web/src/assets/icons/compound-project-file.svg'),
  `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 11V6a1 1 0 0 1 1-1h5l5 5v8a1 1 0 0 1-1 1h-5M13 5v5h5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path transform="translate(3 11) scale(.009)" fill="currentColor" d="${flatPath}"/></svg>\n`);
await copyFile(join(web, 'compound-logo.png'), join(root, 'apps/web/src/assets/images/compound-logo.png'));
// Keep the mark readable on dark browser tabs, with transparent rounded corners.
const favicon = svg(1000, 1000, `<rect width="1000" height="1000" rx="200" fill="white"/><path fill="#151515" d="${flatPath}"/>`);
await sharp(favicon).resize(64).png().toFile(join(web, 'compound-favicon.png'));
await writeFile(join(root, 'apps/landing/public/favicon.svg'), favicon);
// Embed the monochrome mark in the boot screen so it inherits its theme color.
const indexPath = join(root, 'apps/web/index.html');
const index = await readFile(indexPath, 'utf8');
await writeFile(indexPath, index.replace(/<!-- compound-mark:start -->[\s\S]*?<!-- compound-mark:end -->/, `<!-- compound-mark:start -->${flatMark.trim()}<!-- compound-mark:end -->`));
await sharp(join(desktop, 'icon.png')).resize(128).png().toFile(join(web, 'compound-app-icon.png'));

const card = svg(1200, 630, `<rect width="1200" height="630" fill="#f7f7f5"/>
  <image href="${logo}" x="65" y="110" width="400" height="400"/>
  <text x="475" y="308" font-family="Helvetica,Arial,sans-serif" font-size="80" font-weight="600" fill="#151515">Compound</text>
  <text x="480" y="362" font-family="Helvetica,Arial,sans-serif" font-size="26" fill="#555">The video editor built for agents</text>`);
await render('apps/web/public/compound-social.png', card, 1200);
await render('assets/compound-banner.png', card, 1200);

const dmg = svg(658, 498, `<rect width="658" height="498" fill="#f7f7f5"/>
  <text x="329" y="72" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="28" font-weight="600" fill="#151515">Compound</text>
  <path d="M298 217h60m-12-12 12 12-12 12" fill="none" stroke="#888" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="329" y="370" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="17" fill="#666">Drag Compound to Applications</text>`);
await render('apps/desktop/assets/dmg-background.png', dmg, 658);
await render('apps/desktop/assets/dmg-background@2x.png', dmg, 1316);
console.log('Generated Compound brand assets. Run bun run --cwd apps/desktop make:icns on macOS.');
