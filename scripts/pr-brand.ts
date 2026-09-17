import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './environment';

// CI: name a pull request's desktop build after the PR so it installs and runs
// beside the real Compound: "Compound PR 12", its own bundle id, its own
// profile. The name rides along in runtime-config.json, which the packager and
// the app both read, so nothing else has to know the PR number.
const number = Number(process.argv[2]);
if (!Number.isInteger(number) || number <= 0) throw new Error('Usage: pr-brand.ts <pull request number>');
const file = join(root, 'apps/desktop/runtime-config.json');
const config = JSON.parse(readFileSync(file, 'utf8'));
if (config.stage === 'prod') throw new Error('Refusing to brand a production configuration as a pull request build');
config.appName = `Compound PR ${number}`;
config.appId = `dev.corporation.compound.pr${number}`;
writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
console.log(`Branded ${config.stage} build as "${config.appName}" (${config.appId}).`);
