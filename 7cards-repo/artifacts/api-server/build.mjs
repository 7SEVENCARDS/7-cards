import esbuild from "esbuild";
import { pino } from "esbuild-plugin-pino";

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  outfile: "dist/index.mjs",
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: true,
  external: ["thread-stream", "pino-pretty"],
  plugins: [pino({ transports: ["pino-pretty"] })],
});

console.log("Build complete → dist/index.mjs");
