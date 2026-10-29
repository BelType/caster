// What tsc does not emit and the package needs beside its modules: `src/capabilities.ts` resolves '../vendor/…' and '../profiles/…' against its own URL, so with the emit at dist/src/ they must stand at dist/vendor/ and dist/profiles/.
import { cpSync } from 'node:fs';

for (const dir of ['vendor', 'profiles']) cpSync(new URL(`../${dir}`, import.meta.url), new URL(`../dist/${dir}`, import.meta.url), { recursive: true });
