import { stageFrom } from './environment';
import { writeRuntime } from './write-runtime-env';

// Convex's --cmd supplies the newly created deployment's public URL.
const stage = stageFrom(['--stage', process.env.STAGE ?? '']);
if (!process.env.CONVEX_URL) throw new Error('Convex did not provide a preview URL');
writeRuntime(stage);
console.log(`Wrote runtime configuration for ${stage}.`);
