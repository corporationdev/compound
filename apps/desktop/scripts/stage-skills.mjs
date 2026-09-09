// Bundle the repository's Compound skills; builds never fetch upstream branding.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(desktopDir, '..', '..', 'skills');
const stageDir = join(desktopDir, 'skills');
const skills = readdirSync(sourceDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(sourceDir, entry.name, 'SKILL.md')))
  .map((entry) => entry.name);
if (!skills.length) throw new Error(`No Compound skills found in ${sourceDir}`);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
for (const name of skills) cpSync(join(sourceDir, name), join(stageDir, name), { recursive: true });
console.log(`Staged Compound skills: ${skills.join(', ')}`);
