/* A node builtin that a browser bundle references only inside a dead `ENVIRONMENT_IS_NODE` branch. Emscripten's glue decides that branch with `typeof process == "object" && process.versions?.node`, which is false in a tab, so nothing here is ever reached; the stub exists only so esbuild has something to resolve. GENERATED nothing — this file is hand-written and read by scripts/bundle-vendor.js. */
export const createRequire = () => { throw new Error('caster: a vendored bundle reached for a node builtin in the browser'); };
export const readFileSync = createRequire;
export const normalize = createRequire;
export const dirname = createRequire;
export default { createRequire, readFileSync, normalize, dirname };
