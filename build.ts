import {
  build,
  type Plugin,
  type PluginBuild,
  type OnResolveArgs,
} from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const buildSea = process.argv.includes("--sea");

const plugins: Plugin[] = [];

if (buildSea) {
  plugins.push({
    name: "ignore-i18n-except-en",
    setup(build: PluginBuild) {
      build.onResolve(
        { filter: /data\/i18n\/.*\.json$/ },
        (args: OnResolveArgs) => {
          if (args.path.endsWith("en-US.json")) {
            return undefined;
          }
          return { path: args.path, external: true };
        },
      );
    },
  });
}

async function runBuild() {
  console.log("Starting esbuild...");

  await build({
    entryPoints: {
      start: "bin/start.ts",
      index: "src/index.ts",
    },
    bundle: true,
    platform: "node",
    target: "node26",
    format: "esm",
    splitting: !buildSea,
    minifyIdentifiers: false,
    minifySyntax: true,
    minifyWhitespace: true,
    outdir: "dist",

    banner: {
      js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    },

    // to avoid bundling vendored libs, disabled for now.
    // external: ["./src/libs/vendoring/tp/*"]
    plugins: plugins,
  });

  console.log("Esbuild completed successfully. Copying assets...");

  mkdirSync("dist/worker", { recursive: true });

  copyFileSync(
    "src/libs/paginatedreader/readerClient.js",
    "dist/readerClient.js",
  );
  copyFileSync(
    "src/libs/vendoring/worker/tokenworker.js",
    "dist/worker/tokenworker.js",
  );

  console.log("Build and asset copying completed successfully!");
}

runBuild().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
