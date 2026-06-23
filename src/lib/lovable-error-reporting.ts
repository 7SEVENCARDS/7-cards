type LovableErrorOptions = {
  mechanism?: "manual" | "onerror" | "unhandledrejection" | "react_error_boundary";
  handled?: boolean;
  severity?: "error" | "warning" | "info";
};

type LovableEvents = {
  captureException?: (
    error: unknown,
    context?: Record<string, unknown>,
    options?: LovableErrorOptions,
  ) => void;
};

declare global {
  interface Window {
    __lovableEvents?: LovableEvents;
  }
}

// NOTE: This file is imported by src/routes/__root.tsx (a TanStack Start route
// file). The import-protection plugin blocks ALL imports of *.client.* files
// from route files — including transitive dynamic imports from this file.
// Do NOT add any import("./sentry.client") or similar here. Sentry capture
// is handled externally via window.__lovableEvents registered by a client-only
// entry point that is outside the route import chain.
export function reportLovableError(error: unknown, context: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;

  const route = window.location.pathname;

  window.__lovableEvents?.captureException?.(
    error,
    { source: "react_error_boundary", route, ...context },
    { mechanism: "react_error_boundary", handled: false, severity: "error" },
  );
}
