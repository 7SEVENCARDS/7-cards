// ─── Client-side Sentry (Browser / TanStack Start client bundle) ──────────────
// Lazily initialised once via VITE_SENTRY_DSN (inlined at build time by Vite).
// Dynamically imports @sentry/browser to avoid adding to the critical-path
// bundle when Sentry is not configured.
//
// Design rules:
//  - All exports are no-ops when VITE_SENTRY_DSN is absent.
//  - Never throws — Sentry must never break the application.
//  - SSR-safe: all window/browser checks guard against server execution.

let initialized = false;

type SentryBrowser = typeof import("@sentry/browser");
let _sentry: SentryBrowser | null = null;

async function getSentryBrowser(): Promise<SentryBrowser | null> {
  if (_sentry) return _sentry;
  try {
    _sentry = await import("@sentry/browser");
    return _sentry;
  } catch {
    return null;
  }
}

/**
 * Initialise Sentry in the browser. Call once on app mount.
 * Safe to call on the server (SSR) — returns immediately.
 */
export async function initSentryClient(): Promise<void> {
  if (initialized || typeof window === "undefined") return;
  const dsn = (import.meta.env.VITE_SENTRY_DSN as string | undefined) ?? "";
  if (!dsn) return;
  const Sentry = await getSentryBrowser();
  if (!Sentry) return;
  initialized = true;
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE === "production" ? "production" : "development",
    // Error capture only — no performance tracing or session replay.
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    ignoreErrors: ["AbortError", "Network request failed", "NetworkError"],
  });
}

/**
 * Capture a client-side exception and send it to Sentry.
 * Safe to call before init or on server — returns immediately.
 */
export async function captureClientException(
  error: unknown,
  extras?: Record<string, unknown>,
): Promise<void> {
  try {
    if (!initialized || typeof window === "undefined") return;
    const Sentry = await getSentryBrowser();
    if (!Sentry) return;
    Sentry.withScope((scope) => {
      if (extras) scope.setExtras(extras);
      Sentry.captureException(error);
    });
  } catch {
    // Sentry must never crash the application.
  }
}
