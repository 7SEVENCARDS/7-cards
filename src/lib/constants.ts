// ─────────────────────────────────────────────────────────────────────────────
// Shared platform constants — single source of truth for all hardcoded values.
// Import these instead of scattering magic strings across the codebase.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default NGN/USD fallback exchange rate used when no live rate is available
 * from the exchange_rates table or Reloadly.
 * Update this value when the market rate shifts materially.
 */
export const DEFAULT_NGN_RATE = 1485;

/**
 * Canonical public URL of the production app.
 * Used as a fallback when VITE_APP_URL / APP_URL env vars are not set.
 * All code that needs the app base URL should use getAppUrl() below.
 */
export const APP_DOMAIN = "https://7evencards.xyz";

/** Return the runtime app URL, falling back to the canonical domain. */
export function getAppUrl(): string {
  // VITE_APP_URL and APP_URL are in the build env so Vite inlines them
  // correctly. The hardcoded APP_DOMAIN is the final fallback.
  return (
    process.env.VITE_APP_URL ??
    process.env.APP_URL ??
    APP_DOMAIN
  );
}

/** Support contact email — used in UI and fraud notifications. */
export const SUPPORT_EMAIL = "support@7evencards.xyz";

/** Disputes email — used in fraud/enforcement notifications. */
export const DISPUTES_EMAIL = "disputes@7evencards.xyz";

/** Vendor portal path — append to getAppUrl() */
export const VENDOR_PORTAL_PATH = "/vendor";
