#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const JSON_PATH = path.resolve(process.cwd(), "data/i18n/en-US.json");
const SRC_DIR = path.resolve(process.cwd(), "src");
const CMAP_PATH = path.resolve(process.cwd(), "src/cmap.ts");
const FILE_EXT_WHITELIST = [".ts", ".tsx", ".js", ".jsx", ".html", ".json"];

const IGNORE_DIRS = ["node_modules", "dist", "build", ".git", "tp"];

const WHOLESALE_SUBTREES = ["m.c.rd", "help.generic", "languages"];
const DYNAMIC_PREFIXES = ["m.c.models."];

function getCommandAliases(): string[] {
  if (!fs.existsSync(CMAP_PATH)) return [];
  const content = fs.readFileSync(CMAP_PATH, "utf8");
  const match = content.match(/const commandMap = \{([\s\S]*?)\} as const/);

  const mapBody = match?.[1];
  if (!mapBody) return [];

  return mapBody
    .split("\n")
    .map((line) => {
      const parts = line.split(":");
      return parts[0]?.trim();
    })
    .filter(
      (key): key is string =>
        !!key && !key.startsWith("//") && key !== "_default",
    );
}

function getFiles(dir: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return [];

  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (IGNORE_DIRS.includes(file)) continue;
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      results = results.concat(getFiles(fullPath));
    } else if (FILE_EXT_WHITELIST.includes(path.extname(file))) {
      results.push(fullPath);
    }
  }
  return results;
}

function flatten(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return [];
  }

  const keys: string[] = [];
  const record = obj as Record<string, unknown>;

  for (const k in record) {
    const val = record[k];
    const newKey = prefix ? `${prefix}.${k}` : k;

    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      keys.push(...flatten(val, newKey));
    } else {
      keys.push(newKey);
    }
  }
  return keys;
}

function run(): void {
  console.log("Starting Telocity comprehensive i18n scan...");

  if (!fs.existsSync(JSON_PATH)) {
    console.error(`Missing translation file: ${JSON_PATH}`);
    process.exit(2);
  }

  const cmdAliases = getCommandAliases();
  const i18n: unknown = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
  const allKeys = flatten(i18n);
  const files = getFiles(SRC_DIR);

  console.log(
    `Scanning ${files.length} source files (including local vendoring)...`,
  );
  const fileContents = files
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n---\n");

  const unused: string[] = [];

  for (const key of allKeys) {
    if (WHOLESALE_SUBTREES.some((p) => key.startsWith(p))) continue;
    if (DYNAMIC_PREFIXES.some((p) => key.startsWith(p))) continue;
    if (key.startsWith("help.commands.")) {
      const alias = key.split(".")[2];
      if (alias && cmdAliases.includes(alias)) continue;
    }

    const regexPattern = key
      .split(".")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\?\\.]+");
    const searchRegex = new RegExp(regexPattern);
    if (searchRegex.test(fileContents)) {
      continue;
    }

    if (
      fileContents.includes(`"${key}"`) ||
      fileContents.includes(`'${key}'`)
    ) {
      continue;
    }

    unused.push(key);
  }

  if (unused.length > 0) {
    console.log(`\nFound ${unused.length} unused keys:`);
    const grouped: Record<string, string[]> = {};
    for (const k of unused) {
      const top = k.split(".")[0] || "other";
      if (!grouped[top]) grouped[top] = [];
      grouped[top].push(k);
    }

    for (const [group, keys] of Object.entries(grouped)) {
      console.log(`\n[${group.toUpperCase()}]`);
      for (const k of keys) console.log(`  ${k}`);
    }
    process.exit(1);
  } else {
    console.log("\nAll i18n keys are accounted for.");
    process.exit(0);
  }
}

run();
