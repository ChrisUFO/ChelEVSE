// Public-surface barrel for the app-settings helpers. The implementation lives
// in the ./settings/ modules — plan (rate-plan scope/date algebra), validate
// (settings and charger-address validation) and state (editor validation and
// the save lifecycle) — so every importer keeps this path. No name may be
// exported by two submodules: a duplicated `export *` name is silently dropped.

// The rate bounds live in rates.js: the same 0–5 limit governs a flat rate and
// a window row, so both validators share one definition.
export { RATE_MAX, RATE_MIN } from './rates.js';

export * from './settings/plan.js';
export * from './settings/validate.js';
export * from './settings/state.js';
