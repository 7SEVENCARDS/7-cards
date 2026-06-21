import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { rm, mkdir } from "node:fs/promises";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(artifactDir, "dist");

await rm(path.join(distDir, "worker.mjs"), { force: true });
await mkdir(distDir, { recursive: true });

await esbuild({
  entryPoints: [path.resolve(artifactDir, "src/worker.ts")],
  platform: "browser",
  bundle: true,
  format: "esm",
  outfile: path.join(distDir, "worker.mjs"),
  logLevel: "info",
  external: [],
});

console.log("Worker built → dist/worker.mjs");
