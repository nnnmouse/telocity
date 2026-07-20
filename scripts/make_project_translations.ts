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

      const instruction = `You are a professional software localization system. Your task is to translate this application translation file into ${langName} (${lang}) while strictly preserving technical formatting.

[Global Constraints - Critical]
1. **Structure Lock**: Keep the hierarchical JSON structure and all keys completely unchanged. Under no circumstances should any JSON key be translated or modified.
2. **Template Variable Lock**: Do not translate, modify, or remove any template variables wrapped in double curly braces (e.g., {{ .ErrorMessage }}, {{ .File1 }}, {{ .Count }}). They must remain exactly as they appear in the source text.
3. **Formatting Preservation**: Retain all command line flags (e.g., --params, -e), backticks, and newlines exactly as formatted in the source descriptions.

[Task 1: General UI Translation]
Translate all user-facing string values in sections "e" (errors), "help" (CLI help menus), and "m" (messages) into natural, professional, and context-appropriate ${langName}.

[Task 2: Special Rules for the "languages" Section]
For the "languages" block at the end of the JSON:
1. **Translate Core Instruction**: Translate the string value of the "_LLM_INSTRUCTIONS_ALIASES" key into ${langName}.
2. **Translate Names**: Translate the "name" string value of each language entry into ${langName} (e.g., "French" becomes the natural translation in ${langName}).
3. **Enrich Aliases**: Expand the "aliases" array for each language entry with a comprehensive set of lowercase search terms a user speaking ${langName} might input to find it.
   - Include standard 2-letter and 3-letter ISO codes (e.g., "ja", "jpn", "es", "spa").
   - Include the language name in English (e.g., "french", "spanish").
   - Include the language name in its native script (e.g., "français", "español").
   - **Localized Scripts**: Include the translated name of the language in ${langName} (e.g., "フランス語" / "西班牙语") and the base region/country name in ${langName} (e.g., "フランス" / "西班牙").
   - **Romanization & Phonetic Inputs**: If ${langName} or the entry language uses a non-Latin script, include its standard romanizations, phonetic spelling variations, and keyboard input sequences (IMEs) used to type it (for Chinese: Pinyin like "zhongwen", "hanyu", "xibanyayu"; for Japanese: Hiragana and Romaji equivalent typing inputs; for Latin languages: diacritic-stripped variants like "espanol").
   - *Constraint 1*: Every alias must refer strictly and exclusively to that specific language entry. Do not contaminate the list with unrelated languages.
   - *Constraint 2*: Ensure all terms are authentic and verified in ${langName}. Avoid literal phonetic machine translations (e.g., do not translate "Tagalog" as "他ガログ").

[Output Format]
Output only the raw, updated JSON data. Do not include any introductory or explanatory text, and do not wrap the output in Markdown code blocks (do not use \`\`\`json).`;

      // prompt doubling version
      const fullPayload = `${instruction}\n\n${sourceContent}\n\n${instruction}\n\n${sourceContent}`;

      // single prompt version
      //const fullPayload = `${instruction}\n\n${sourceContent}`;

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
