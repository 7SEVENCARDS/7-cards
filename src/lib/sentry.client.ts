// ─── Client-side Sentry (Browser / TanStack Start client bundle) ──────────────
// Self-initialising: captureClientException auto-inits on first call.
// TanStack Start's import-protection plugin blocks *.client.* files from being
// imported (statically or dynamically) in route files. This module must ONLY
// be imported from non-route files (e.g. lib/lovable-error-reporting.ts).
//
// Design rules:
//  - All exports are no-ops when VITE_SENTRY_DSN is absent.
//  - Never throws — Sentry must never break the application.
//  - SSR-safe: all window/browser checks guard against server execution.

let initialized = false;
let initPromise: Promise<void> | null = null;

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

async function ensureInit(): Promise<void> {
  if (initialized || typeof window === "undefined") return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const dsn = (import.meta.env.VITE_SENTRY_DSN as string | undefined) ?? "";
    if (!dsn) return;
    const Sentry = await getSentryBrowser();
    if (!Sentry) return;
    initialized = true;
    Sentry.init({
      dsn,
      environment: import.meta.env.MODE === "production" ? "production" : "development",
      release: (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) ?? undefined,
      integrations: [Sentry.browserTracingIntegration()],
      tracesSampleRate: 0.01,
      tracePropagationTargets: ["7evencards.xyz", "vendor.7evencards.xyz", /^\/api\//],
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      ignoreErrors: ["AbortError", "Network request failed", "NetworkError"],
    });
  })();
  return initPromise;
}

/**
 * Capture a client-side exception and send it to Sentry.
 * Auto-initialises Sentry on first call. Safe to call on the server — no-op.
 * This function must ONLY be called from non-route files to satisfy TanStack
 * Start's import-protection constraint on *.client.* modules.
 */
export async function captureClientException(
  error: unknown,
  extras?: Record<string, unknown>,
): Promise<void> {
  try {
    if (typeof window === "undefined") return;
    await ensureInit();
    if (!initialized) return;
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
