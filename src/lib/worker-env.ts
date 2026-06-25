// ─── Cloudflare Workers env singleton ────────────────────────────────────────
// Vite/Nitro inlines process.env.X at build time, so secrets not available
// during the build step are compiled as `undefined`. Runtime injection via
// Object.assign(process.env, ...) does not help.
//
// ROOT CAUSE: Nitro's cloudflare-module preset generates its own CF Worker
// entry that receives `fetch(request, env, ctx)` from Cloudflare, stores the
// env on globalThis.__env__, then calls our server.ts fetch WITHOUT passing
// env as the second argument (env === undefined in our handler). So we must
// read secrets from globalThis.__env__ — not from the fetch() parameter.
//
// server.ts still calls initWorkerEnv(env) (a no-op now) for compatibility,
// but getEnv() reads directly from globalThis.__env__.

export function initWorkerEnv(_env: unknown): void {
  // No-op: Nitro stores the CF env on globalThis.__env__ directly.
  // We read from there in getEnv() instead.
}

/**
 * Get a runtime env var — reads from Nitro's globalThis.__env__ (set by
 * Nitro's generated Cloudflare Workers entry before our handler is called).
 * Falls back to process.env for local dev.
 */
export function getEnv(key: string): string | undefined {
  // Nitro's cloudflare-module preset stores CF Worker env on globalThis.__env__
  // before dispatching to the server entry handler.
  const nitroEnv = (globalThis as Record<string, unknown>)["__env__"] as
    | Record<string, unknown>
    | undefined;
  if (nitroEnv) {
    const val = nitroEnv[key];
    if (typeof val === "string") return val;
  }
  // Fallback: process.env for local dev (NODE_ENV, SQUADCO_ENV, etc.)
  return process.env[key];
}

// ─── Cloudflare Workers Rate Limiting bindings ────────────────────────────────
// These are CF Rate Limit bindings (not string env vars), so they must be
// read from the raw CF env object, not through getEnv() which returns strings.

export interface RateLimiterBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface WorkerRateLimiters {
  RATE_LIMITER_LOGIN:   RateLimiterBinding;
  RATE_LIMITER_WEBHOOK: RateLimiterBinding;
  RATE_LIMITER_KYC:     RateLimiterBinding;
}

/**
 * Get the Workers Rate Limiting binding by name.
 * Returns undefined when running in local dev (no CF binding available).
 */
export function getRateLimiter(name: keyof WorkerRateLimiters): RateLimiterBinding | undefined {
  const nitroEnv = (globalThis as Record<string, unknown>)['__env__'] as
    | Record<string, unknown>
    | undefined;
  if (!nitroEnv) return undefined;
  const binding = nitroEnv[name];
  if (binding && typeof (binding as RateLimiterBinding).limit === 'function') {
    return binding as RateLimiterBinding;
  }
  return undefined;
}
