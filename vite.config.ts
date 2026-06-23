// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  // Force the Nitro/Cloudflare Workers build outside the Lovable sandbox (e.g. GitHub Actions).
  // Without this, @lovable.dev/vite-tanstack-config skips the nitro deploy plugin when it
  // detects no Lovable context, so .output/server/index.mjs is never produced.
  nitro: true,
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    // pnpm virtual store (.pnpm/) can cause Rollup to lose track of sub-dependencies
    // (e.g. @tanstack/query-core inside @tanstack/react-query) during the Nitro SSR
    // bundling phase. resolve.dedupe forces a single instance and ssr.noExternal ensures
    // all TanStack packages are bundled (not external) in the Cloudflare Worker output.
    resolve: {
      dedupe: [
        "@tanstack/query-core",
        "@tanstack/react-query",
        "@tanstack/react-router",
        "@tanstack/react-start",
        "@tanstack/router-core",
        "@tanstack/history",
      ],
    },
    ssr: {
      noExternal: [
        "@tanstack/query-core",
        "@tanstack/react-query",
        "@tanstack/react-router",
        "@tanstack/react-start",
        "@tanstack/router-core",
        "@tanstack/history",
      ],
    },
  },
});
