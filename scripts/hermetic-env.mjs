// Preloaded by `npm test` (node --import): makes the suite hermetic inside an orka job pane.
// A pane exports core.hooksPath via GIT_CONFIG_COUNT/KEY_n/VALUE_n and tags itself with ORKA_*/ORCA_*
// (job, worker, ports). Tests inherit process.env, so their scratch-repo commits would hit orka's
// guard hook ("not an orka repo") and orka would think it runs in a job. The test runner's child
// processes inherit this cleaned env.
// GIT_*: the repo-local vars `git rev-parse --local-env-vars` lists, plus the numbered config pairs.
const GIT_LOCAL = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY",
  "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR",
]);

export const leaked = (key) => GIT_LOCAL.has(key) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key) || /^OR[CK]A_/.test(key);

for (const key of Object.keys(process.env)) if (leaked(key)) delete process.env[key];
