import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useRef, type ReactNode } from "react";
import { Toaster } from "../components/ui/sonner";
import { NetworkStatus } from "../components/NetworkStatus";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => reset()}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "7SEVEN CARDS — Verify Fast. Get Paid Faster." },
      { name: "description", content: "Sell gift cards & crypto for Naira in under 5 minutes. Instant verification. Zero fees. Built for Africa." },
      { name: "robots", content: "index, follow, max-image-preview:large" },
      { name: "keywords", content: "sell gift cards Nigeria, gift card exchange naira, Amazon gift card Nigeria, iTunes card Nigeria, sell gift card fast" },
      /* Open Graph */
      { property: "og:title", content: "7SEVEN CARDS — Verify Fast. Get Paid Faster." },
      { property: "og:description", content: "Sell gift cards for Naira in under 5 minutes. Instant verification, zero fees, direct bank transfer." },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://7evencards.xyz/" },
      { property: "og:site_name", content: "7SEVEN CARDS" },
      { property: "og:image", content: "https://7evencards.xyz/logo-full.png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "7SEVEN CARDS — Sell gift cards for Naira" },
      { property: "og:locale", content: "en_NG" },
      /* Twitter / X */
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "7SEVEN CARDS — Verify Fast. Get Paid Faster." },
      { name: "twitter:description", content: "Sell gift cards for Naira in under 5 minutes. Zero fees, instant bank transfer." },
      { name: "twitter:image", content: "https://7evencards.xyz/logo-full.png" },
      { name: "twitter:site", content: "@7sevencards" },
      /* PWA / Mobile */
      { name: "theme-color", content: "#0a1220" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "apple-mobile-web-app-title", content: "7SEVEN CARDS" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "format-detection", content: "telephone=no" },
      { name: "application-name", content: "7SEVEN CARDS" },
      { name: "msapplication-TileColor", content: "#0a1220" },
      { name: "msapplication-TileImage", content: "/logo-badge.png" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "canonical", href: "https://7evencards.xyz/" },
      { rel: "icon", type: "image/png", href: "/favicon.png" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/site.webmanifest" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700;800&family=Inter:wght@400;500;600;700&display=swap",
      },
      { rel: "dns-prefetch", href: "https://supabase.co" },
      { rel: "dns-prefetch", href: "https://onesignal.com" },
    ],
    scripts: [
      {
        src: "https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js",
        defer: true,
        async: true,
      },
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "FinancialService",
          name: "7SEVEN CARDS",
          description: "Sell gift cards for Nigerian Naira in under 5 minutes. Instant verification, zero fees.",
          url: "https://7evencards.xyz",
          logo: "https://7evencards.xyz/logo-full.png",
          areaServed: "NG",
          currenciesAccepted: "NGN",
          priceRange: "Free",
          sameAs: ["https://twitter.com/7sevencards"],
        }),
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const oneSignalInit = useRef(false);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (oneSignalInit.current) return;
    const appId = import.meta.env.VITE_ONESIGNAL_APP_ID as string | undefined;
    if (!appId) return;

    oneSignalInit.current = true;
    // @ts-expect-error OneSignal loaded via external SDK script
    window.OneSignalDeferred = window.OneSignalDeferred ?? [];
    // @ts-expect-error OneSignal loaded via external SDK script
    window.OneSignalDeferred.push(async (OneSignal: unknown) => {
      await (OneSignal as { init: (opts: object) => Promise<void> }).init({
        appId,
        safari_web_id: `web.onesignal.auto.${appId}`,
        notifyButton: { enable: false },
        allowLocalhostAsSecureOrigin: import.meta.env.DEV as boolean,
      });
    });
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <NetworkStatus />
      <Outlet />
      <Toaster richColors position="top-center" />
    </QueryClientProvider>
  );
}
