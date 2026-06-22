// ─── Cloudflare Workers env singleton ────────────────────────────────────────
// Vite/Nitro inlines process.env.X at build time, so secrets not available
// during the build step are compiled as `undefined`. Runtime injection via
// Object.assign(process.env, ...) does not help because the identifier
// references are already substituted with literals in the bundle. Instead, we
// store the Worker's env object in this module-level singleton (refreshed at
// the top of every fetch() call) and expose getEnv() for all server-side code
// that needs runtime credentials.
// server.ts calls initWorkerEnv(env) at the very top of every fetch() call.
//
// IMPORTANT: Cloudflare Workers env bindings are NON-ENUMERABLE. Do NOT use
// Object.entries(env) or Object.keys(env) — they return empty arrays. Instead,
// store the raw env object and access keys directly with env[key].

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _env: Record<string, any> | null = null;

export function initWorkerEnv(env: unknown): void {
  if (env && typeof env === "object") {
    // Store the raw env object — do NOT spread or Object.entries it.
    // CF Worker env bindings are non-enumerable; only direct key access works.
    _env = env as Record<string, unknown>;
  }
}

/**
 * Get a runtime env var — reads from the Worker's env binding object (set
 * per-request via initWorkerEnv) with a fallback to process.env for local dev.
 */
export function getEnv(key: string): string | undefined {
  if (_env !== null) {
    const val = _env[key];
    if (typeof val === "string") return val;
  }
  return process.env[key];
}
