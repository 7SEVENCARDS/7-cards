// ─── Server-side Sentry (Cloudflare Workers) ─────────────────────────────────
// Lazily initialised on the first Worker request using SENTRY_DSN from the
// runtime environment via getEnv(). Uses @sentry/cloudflare which is designed
// for the Workers + nodejs_compat runtime.
//
// Design rules:
//  - NEVER throws — Sentry must never break the application.
//  - No-op when SENTRY_DSN is absent (dev / misconfigured envs).
//  - Idempotent: init runs once per isolate lifetime.

import * as Sentry from "@sentry/cloudflare";
import { getEnv } from "./worker-env";

let initialized = false;

/**
 * Call once per request (or on first request). Safe to call repeatedly —
 * subsequent calls are no-ops after the first successful init.
 */
export function initSentryServer(): void {
  if (initialized) return;
  const dsn = getEnv("SENTRY_DSN");
  if (!dsn) return;
  initialized = true;
  Sentry.init({
    dsn,
    environment: getEnv("NODE_ENV") === "production" ? "production" : "development",
    // Tag every event with the git SHA so Sentry can correlate issues to deploys.
    release: getEnv("SENTRY_RELEASE") ?? undefined,
    // 1% performance tracing — captures latency for SSR renders and server spans
    // without adding meaningful overhead at 7evencards traffic volumes.
    tracesSampleRate: 0.01,
    // Suppress noisy operational errors that don't need investigation.
    ignoreErrors: ["AbortError", "TimeoutError"],
  });
}

/**
 * Capture an exception and ship it to Sentry.
 * Safe to call even if Sentry is not configured.
 */
export function captureServerException(
  error: unknown,
  extras?: Record<string, unknown>,
): void {
  try {
    if (!getEnv("SENTRY_DSN")) return;
    Sentry.withScope((scope) => {
      if (extras) scope.setExtras(extras);
      Sentry.captureException(error);
    });
  } catch {
    // Sentry must never crash the application.
  }
}

/**
 * Wrap an async operation in a Sentry performance span.
 * No-op when Sentry is not configured or not yet initialized.
 *
 * @example
 *   const resp = await startServerSpan(
 *     { name: "SSR GET /", op: "http.server" },
 *     () => handler.fetch(request, env, ctx),
 *   );
 */
export async function startServerSpan<T>(
  spanContext: { name: string; op?: string; attributes?: Record<string, string | number | boolean> },
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!getEnv("SENTRY_DSN")) return fn();
  try {
    return await Sentry.startSpan(spanContext, fn);
  } catch (err) {
    // If span wrapping itself fails, still execute the function.
    return fn();
  }
}
