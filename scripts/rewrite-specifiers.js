// What `rewriteRelativeImportExtensions` does to a static relative specifier, for the one file the build emits without it (tsconfig.capabilities.json says why): './x.ts' becomes './x.js'.
import { readFileSync, writeFileSync } from 'node:fs';

for (const file of process.argv.slice(2)) {
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.replace(/(\bfrom\s+)(['"])(\.\.?\/[^'"]+)\.ts\2/g, '$1$2$3.js$2'));
}
