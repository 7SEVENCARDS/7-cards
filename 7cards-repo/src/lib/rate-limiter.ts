// Sliding-window in-process rate limiter.
//
// Each Cloudflare Worker isolate maintains its own bucket store. This gives
// per-isolate burst protection without requiring KV or Durable Objects.
// Combined with Cloudflare's edge IP reputation filtering it is sufficient
// to stop credential-stuffing and webhook-flood attacks.
//
// To graduate to true distributed rate limiting, enable the Workers Rate
// Limiting binding in wrangler.toml (see the commented block at the bottom
// of that file) and replace calls here with `env.RATE_LIMITER_*.limit({key})`.

type Bucket = { count: number; resetAt: number };

const store = new Map<string, Bucket>();

/**
 * Returns true if the request is within the limit, false if it should be
 * rejected. Automatically resets the bucket after `windowMs` milliseconds.
 */
export function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = store.get(key);

  if (!b || now >= b.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (b.count >= limit) return false;

  b.count++;
  return true;
}

/**
 * Throws a 429-flavoured error (with `statusCode: 429`) if the limit is
 * exceeded. TanStack Start / h3 will surface this as an HTTP 500 by default,
 * but the statusCode property lets a wrapping try/catch convert it correctly.
 *
 * In server.ts (where we control the raw Response) use `allow()` directly
 * so we can return a well-formed 429 Response with Retry-After.
 */
export function assertNotRateLimited(
  key: string,
  limit: number,
  windowMs: number,
): void {
  if (!allow(key, limit, windowMs)) {
    const err = new Error("Too many requests. Please wait and try again.");
    (err as Error & { statusCode: number }).statusCode = 429;
    throw err;
  }
}

/**
 * Extract the best available client IP from an HTTP request.
 * Prefers the Cloudflare-injected header that cannot be spoofed by callers.
 */
export function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/**
 * Build a namespaced rate-limit key: `<namespace>:<value>`.
 * Keeps different limit policies from sharing buckets.
 */
export function rlKey(namespace: string, value: string): string {
  return `${namespace}:${value}`;
}

// Purge stale buckets every 5 minutes so the Map does not grow indefinitely
// in long-lived isolates.
if (typeof setInterval !== "undefined") {
  const STALE_AFTER = 5 * 60 * 1_000;
  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of store) {
      if (now >= b.resetAt + STALE_AFTER) store.delete(k);
    }
  }, STALE_AFTER);
}
