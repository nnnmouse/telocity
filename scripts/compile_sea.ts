import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { platform } from "node:os";

const isWindows = platform() === "win32";
const isMac = platform() === "darwin";

const outputBinary = isWindows ? "dist/telocity.exe" : "dist/telocity";

console.log(
  `1. Generating platform-specific sea-config.json for target: ${outputBinary}...`,
);

const seaConfig = {
  main: "dist/start.js",
  output: outputBinary,
  mainFormat: "module",
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: true,
  assets: {
    "tokenworker.js": "dist/worker/tokenworker.js",
    "readerClient.js": "dist/readerClient.js",
    "en-US.json": "data/i18n/en-US.json",
    "fr-FR.json": "data/i18n/fr-FR.json",
    "ja-JP.json": "data/i18n/ja-JP.json",
    "zh-CN.json": "data/i18n/zh-CN.json",
  },
};

writeFileSync("sea-config.json", JSON.stringify(seaConfig, null, 2));

console.log(
  "2. Compiling Single Executable Application directly via Node.js native engine...",
);
execSync("node --build-sea sea-config.json", { stdio: "inherit" });

if (isMac) {
  console.log("3. Resigning macOS binary target locally...");
  try {
    execSync(`codesign --sign - ${outputBinary}`);
  } catch (err) {
    console.warn(
      "- Warning: Local ad-hoc signing failed (normal if Xcode Command Line Tools are missing).",
      err instanceof Error ? err.message : String(err),
    );
  }
}

console.log(`\nExecutable successfully built at: ${outputBinary}`);
