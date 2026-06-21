// ─────────────────────────────────────────────────────────────────────────────
// Timeout-aware fetch wrapper
//
// Every external API call (Reloadly, Squad, Dojah, Busha) must go through this
// so a slow or hung third-party service cannot stall a Cloudflare Worker thread
// indefinitely.
//
// Default timeout: 15 seconds — enough for any legitimate API response but
// tight enough to fail fast and surface the error to the user.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Drop-in replacement for `fetch` with a hard abort timeout.
 * Throws a descriptive Error (not a raw DOMException) on timeout so callers
 * can distinguish "timed out" from "network error" in catch blocks.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(
        `External API request timed out after ${timeoutMs}ms: ${url.replace(/\?.*/, "")}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
