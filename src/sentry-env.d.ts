// Globals injected by vite.config.ts `define` at build time.
// These are replaced as plain string literals by Rollup in both the client
// bundle and the Nitro Cloudflare Worker output -- they are NOT runtime values.
//
// __SENTRY_RELEASE__ -- git SHA from CI env var SENTRY_RELEASE (github.sha).
//   Empty string in local dev (no SENTRY_RELEASE set).
//   Used by: src/lib/sentry.server.ts, src/server.ts (health endpoint)
declare const __SENTRY_RELEASE__: string;
