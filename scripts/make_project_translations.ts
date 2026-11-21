#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const VERBOSE = false;
const IS_WINDOWS = os.platform() === "win32";

const languages = {
  "fr-FR": "French (France)",
  "ja-JP": "Japanese (Japan)",
  "zh-CN": "Simplified Chinese (China)",
} as const;

const PROJECT_ROOT = process.cwd();
const I18N_DIR = path.join(PROJECT_ROOT, "data", "i18n");
const SOURCE_FILE = path.join(I18N_DIR, "en-US.json");

function isEnoentError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

function cleanTranslatedJson(rawContent: string): string {
  return rawContent
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/```\s*$/, "")
    .trim();
}

function runTelocityOS(targetFile: string, inputFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "os",
      "--file",
      inputFile,
      "--outfile",
      targetFile,
      "--params",
      "internaltranslation",
    ];

    const command = IS_WINDOWS ? "cmd.exe" : "telocity-dev";
    const finalArgs = IS_WINDOWS ? ["/c", "telocity-dev", ...args] : args;

    if (VERBOSE) console.log(`[EXEC]: ${command} ${finalArgs.join(" ")}`);

    const child = spawn(command, finalArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdin.end();

    child.stdout.on("data", (data: Buffer) => {
      if (VERBOSE) process.stdout.write(data);
    });

    child.stderr.on("data", (data: Buffer) => {
      if (VERBOSE) process.stderr.write(data);
    });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Process exited with code ${code}`));
    });
  });
}

async function translationTask() {
  try {
    await stat(I18N_DIR);
    await stat(SOURCE_FILE);
  } catch (err) {
    if (isEnoentError(err)) {
      console.error(`Error: Path not found: ${err.path ?? "unknown"}`);
      process.exit(1);
    }
    throw err;
  }

  const sourceContent = await readFile(SOURCE_FILE, "utf-8");
  const sortedLangs = Object.keys(languages).sort();

  for (const lang of sortedLangs as (keyof typeof languages)[]) {
    const langName = languages[lang];
    const langFile = path.join(I18N_DIR, `${lang}.json`);

    try {
      await stat(langFile);
      console.log(`[-] Skipping ${lang} (Exists)`);
      continue;
    } catch (err) {
      if (!isEnoentError(err)) throw err;
    }

    const tempInputPath = path.join(
      os.tmpdir(),
      `telocity-temp-input-${Date.now()}.txt`,
    );
    try {
      console.log(`[+] Translating: ${lang}...`);

      const instruction = `### Translation Instructions

You are a professional software localization system. Localize the provided application JSON file into ${langName} (${lang}) while strictly preserving all technical structures, keys, and formatting.

### Technical & Formatting Constraints

1. **Structure Lock:** Retain the exact hierarchical JSON structure and all keys without alteration. Never translate, rename, or omit any JSON key under any circumstance.

2. **Template Variable Lock:** Do not translate, modify, or strip any template variables wrapped in double curly braces (e.g., \`{{ .ErrorMessage }}\`, \`{{ .File1 }}\`, \`{{ .Count }}\`). They must remain identical to the source text.

3. **CLI & Escape Sequence Preservation:** Retain all command-line flags (e.g., \`--params\`, \`-e\`), markdown formatting, backticks, and escape sequences (such as \`\\n\`) exactly as written.

### Localization Tasks

1. **UI String Translation:** Translate all user-facing string values within the \`"e"\` (errors), \`"help"\` (CLI help menus), and \`"m"\` (messages) sections into natural, fluent, and context-appropriate ${langName}.

2. **Language Metadata Translation:** In the \`"languages"\` block, translate the string value of the \`"_LLM_INSTRUCTIONS_ALIASES"\` key into ${langName}.

3. **Language Name Translation:** In the \`"languages"\` block, translate the \`"name"\` property of each entry into ${langName} (e.g., "French" becomes its natural name in ${langName}).

### Aliases Enrichment Rules

For each entry's \`"aliases"\` array in the \`"languages"\` section, expand the list with a comprehensive set of lowercase search keywords a user speaking ${langName} might type to find that language:

- **Standard Codes:** Include standard 2-letter and 3-letter ISO codes (e.g., \`ja\`, \`jpn\`, \`es\`, \`spa\`).

- **English & Native Autonyms:** Include the English name (e.g., \`french\`, \`spanish\`) and the language's native script autonym (e.g., \`français\`, \`español\`).

- **Target Language Terms:** Include the translated name of the language in ${langName} (e.g., \`フランス語\` / \`西班牙语\`) and the associated region or country name in ${langName} (e.g., \`フランス\` / \`西班牙\`).

- **Phonetic & IME Inputs:** If ${langName} or the target language uses non-Latin scripts, include standard romanizations, phonetic variations, and common keyboard IME typing sequences (e.g., for Chinese: Pinyin such as \`zhongwen\`, \`hanyu\`, \`xibanyayu\`; for Japanese: Hiragana and Romaji typing sequences; for Latin scripts: diacritic-stripped variants such as \`espanol\`).

- **Exclusivity & Accuracy:** Every alias must strictly and exclusively map to that language entry. Ensure all terms are authentic and verified in ${langName}; avoid unnatural machine-phonetic transliterations (e.g., do not translate "Tagalog" as "他ガログ").

### Output Constraints

Output ONLY the raw, updated JSON text. Do not wrap the output in Markdown code blocks (do NOT use \`\`\`json or \`\`\`). Do not include any introductory text, concluding notes, or explanations.`;

      const sourceSection = `### Source Content to Localize:\n\n${sourceContent}`;

      // Prompt doubling version:
      //const fullPayload = `${instruction}\n\n${sourceSection}\n\n${instruction}\n\n${sourceSection}`;

      // Single prompt version:
      const fullPayload = `${instruction}\n\n${sourceSection}`;

      await writeFile(tempInputPath, fullPayload, "utf-8");

      await runTelocityOS(langFile, tempInputPath);

      const rawOutput = await readFile(langFile, "utf-8");
      const cleanedOutput = cleanTranslatedJson(rawOutput);

      try {
        JSON.parse(cleanedOutput);
        await writeFile(langFile, cleanedOutput, "utf-8");
        console.log(`[OK] Saved ${langFile}`);
      } catch {
        console.error(`[!] Failed to parse LLM response for ${lang} as JSON.`);
      }
    } catch (err) {
      console.error(
        `[FAIL] ${lang}:`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      await unlink(tempInputPath).catch(() => {});
    }
  }
}

translationTask().catch(console.error);
