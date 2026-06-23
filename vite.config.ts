// @lovable.dev/vite-tanstack-config already includes the following -- do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare
//     as a default target), componentTagger (dev-only), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection.
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { sentryVitePlugin } from "@sentry/vite-plugin";

export default defineConfig({
  // Force the Nitro/Cloudflare Workers build outside the Lovable sandbox (e.g. GitHub Actions).
  // Without this, @lovable.dev/vite-tanstack-config skips the nitro deploy plugin when it
  // detects no Lovable context, so .output/server/index.mjs is never produced.
  nitro: true,
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    server: { entry: "server" },
  },
  vite: {
    build: {
      // "hidden" source maps: .map files are generated but the sourceMappingURL comment is
      // omitted from the output bundle, so maps are never served to end-users.
      // @sentry/vite-plugin uploads them to Sentry and deletes the files afterwards.
      sourcemap: "hidden",
    },
    define: {
      // __SENTRY_RELEASE__ is a plain global constant replaced by Rollup at build time.
      // This is the correct Vite/Rollup pattern -- do NOT use "import.meta.env.FOO" as a
      // define key; Vite owns that namespace and will throw during the Nitro SSR build.
      // The value is the git SHA injected by CI as SENTRY_RELEASE=github.sha.
      // Declaration: src/sentry-env.d.ts   Usage: src/lib/sentry.server.ts
      __SENTRY_RELEASE__: JSON.stringify(process.env.SENTRY_RELEASE ?? ""),
    },
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
    plugins: [
      // Sentry source map upload -- runs only when SENTRY_AUTH_TOKEN is present (CI builds).
      // Uploads .map files to Sentry (org: 7even, project: node-cloudflare-workers),
      // tags the release with the git SHA for issue-deploy correlation, then removes
      // every .map file so no source maps are ever deployed to the public CDN.
      ...(process.env.SENTRY_AUTH_TOKEN
        ? [
            sentryVitePlugin({
              org:       process.env.SENTRY_ORG     ?? "7even",
              project:   process.env.SENTRY_PROJECT ?? "node-cloudflare-workers",
              authToken: process.env.SENTRY_AUTH_TOKEN,
              release: {
                name: process.env.SENTRY_RELEASE ?? "dev",
              },
              telemetry: false,
              sourcemaps: {
                assets: ["dist/**/*.map", ".output/**/*.map"],
                // Delete .map files after upload -- must not reach the Worker bundle.
                filesToDeleteAfterUpload: ["dist/**/*.map", ".output/**/*.map"],
              },
            }),
          ]
        : []),
    ],
  },
});
