// Runs after `astro build`. Removes data files that the build needed but the browser never loads,
// so visitors and the Pages deploy do not carry them. The store events layer is loaded from the
// small store_index.json; the full store_events.json (about 9 MB) is only an input to the build.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.CSA_SITE_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const rel of ['data/store_events.json']) {
  const file = path.join(root, 'dist', rel);
  if (fs.existsSync(file)) {
    fs.rmSync(file);
    console.log(`prune-dist: removed ${rel}`);
  }
}
