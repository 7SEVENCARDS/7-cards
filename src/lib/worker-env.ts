// ─── Cloudflare Workers env singleton ────────────────────────────────────────
// Vite/Nitro inlines process.env.X at build time, so secrets not available
// during the build step are compiled as `undefined`. Runtime injection via
// Object.assign(process.env, ...) does not help because the identifier
// references are already substituted with literals in the bundle. Instead, we
// store the Worker's env object in this module-level singleton (refreshed at
// the top of every fetch() call) and expose getEnv() for all server-side code
// that needs runtime credentials.
// server.ts calls initWorkerEnv(env) at the very top of every fetch() call.

let _env: Record<string, string> = {};

export function initWorkerEnv(env: unknown): void {
  if (env && typeof env === "object") {
    _env = {};
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof v === "string") _env[k] = v;
    }
  }
}

/**
 * Get a runtime env var — reads from the Worker's env binding object (set
 * per-request via initWorkerEnv) with a fallback to process.env for local dev.
 */
export function getEnv(key: string): string | undefined {
  return _env[key] ?? process.env[key];
}
