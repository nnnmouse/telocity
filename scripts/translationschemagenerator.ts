#!/usr/bin/env node
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

const TARGET_PRESET = "internaltranslation";
const CONFIG_PATH = "./data/config/template.config.json";
const I18N_PATH = "./data/i18n/en-US.json";
const I18N_DIR = path.dirname(I18N_PATH);

// ----------------------------------------------------------------------
//  Deterministic formatting helpers
// ----------------------------------------------------------------------

/**
 * Recursively converts any "aliases" field that is a string into an array.
 * Splits by commas, trims whitespace, filters empty strings.
 * Leaves existing arrays untouched.
 */
function normalizeAliases(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map(normalizeAliases);
  }

  const record = obj as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (key === "aliases" && typeof value === "string") {
      const aliasesArray = value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      result[key] = aliasesArray;
    } else {
      result[key] = normalizeAliases(value);
    }
  }
  return result;
}

/**
 * Recursively sorts array elements (primitive values) alphabetically.
 * Does NOT change order of objects inside arrays (keeps them as-is).
 */
function sortArrayElements(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    const sortedArray = obj.map((item) => sortArrayElements(item));
    // Only sort if all items are primitive (string/number)
    if (
      sortedArray.every(
        (item) => typeof item === "string" || typeof item === "number",
      )
    ) {
      sortedArray.sort((a, b) => String(a).localeCompare(String(b)));
    }
    return sortedArray;
  }
  if (obj !== null && typeof obj === "object") {
    const record = obj as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      result[key] = sortArrayElements(record[key]);
    }
    return result;
  }
  return obj;
}

/**
 * Recursively sorts object keys alphabetically.
 */
function sortJsonObject(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return obj;
  }

  const record = obj as Record<string, unknown>;
  const sortedRecord: Record<string, unknown> = {};
  const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));

  for (const k of keys) {
    sortedRecord[k] = sortJsonObject(record[k]);
  }

  return sortedRecord;
}

/**
 * Pretty‑prints an object with compact (short) and expanded (long) formatting.
 * Guarantees a trailing newline.
 */
function stringifyReadable(obj: unknown, maxLength = 80, indent = 2): string {
  const space = " ".repeat(indent);

  function toCompact(val: unknown): string {
    if (val === null || typeof val !== "object") {
      return JSON.stringify(val);
    }

    if (Array.isArray(val)) {
      const items = (val as unknown[]).map((v: unknown): string => {
        return toCompact(v === undefined ? null : v);
      });
      return `[${items.join(", ")}]`;
    }

    const record = val as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(record)) {
      const v = record[k];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(k)}: ${toCompact(v)}`);
    }

    if (parts.length === 0) {
      return "{}";
    }
    return `{ ${parts.join(", ")} }`;
  }

  function _stringify(val: unknown, currentIndent: string): string {
    if (val === null || typeof val !== "object") {
      return JSON.stringify(val);
    }

    const compact = toCompact(val);
    if (compact.length <= maxLength) {
      return compact;
    }

    const nextIndent = currentIndent + space;

    if (Array.isArray(val)) {
      const expanded = (val as unknown[]).map((v: unknown): string => {
        return _stringify(v === undefined ? null : v, nextIndent);
      });
      return `[\n${nextIndent}${expanded.join(`,\n${nextIndent}`)}\n${currentIndent}]`;
    }

    const record = val as Record<string, unknown>;
    const keys = Object.keys(record);
    const parts: string[] = [];
    for (const k of keys) {
      const v = record[k];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(k)}: ${_stringify(v, nextIndent)}`);
    }

    if (parts.length === 0) {
      return "{}";
    }
    return `{\n${nextIndent}${parts.join(`,\n${nextIndent}`)}\n${currentIndent}}`;
  }

  return _stringify(obj, "") + "\n";
}

/**
 * Generates a strict JSON Schema from an object, correctly handling arrays.
 */
function generateStrictJsonSchema(obj: unknown): Record<string, unknown> {
  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      return { type: "array", items: { type: "string" } };
    }
    const itemSchema = generateStrictJsonSchema(obj[0]);
    return { type: "array", items: itemSchema };
  }

  if (typeof obj === "string") {
    return { type: "string" };
  }

  if (typeof obj === "object" && obj !== null) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    const sortedEntries = Object.entries(obj).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );

    for (const [key, value] of sortedEntries) {
      properties[key] = generateStrictJsonSchema(value);
      required.push(key);
    }

    return {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    };
  }

  return { type: "string" };
}

// ----------------------------------------------------------------------
//  Main: normalise + sort + format ALL i18n files, then update config
// ----------------------------------------------------------------------

async function main() {
  try {
    // 1. Process ALL i18n JSON files (including en-US) deterministically
    const files = await readdir(I18N_DIR);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    console.log(
      `Formatting ${jsonFiles.length} locale file(s) in '${I18N_DIR}'...`,
    );

    let enData: unknown = null;

    for (const file of jsonFiles) {
      const filePath = path.join(I18N_DIR, file);
      const content = await readFile(filePath, "utf-8");
      let parsed = JSON.parse(content);

      // Apply all deterministic transformations
      parsed = normalizeAliases(parsed);
      parsed = sortArrayElements(parsed);
      parsed = sortJsonObject(parsed);

      const formatted = stringifyReadable(parsed);
      await writeFile(filePath, formatted, "utf-8");
      console.log(`✓ Formatted: ${filePath}`);

      if (file === path.basename(I18N_PATH)) {
        enData = parsed; // keep for schema generation
      }
    }

    if (!enData) {
      throw new Error(`Could not find or parse ${I18N_PATH}`);
    }

    // 2. Generate strict JSON Schema from the cleaned en-US data
    console.log(
      `Generating strict JSON Schema for preset '${TARGET_PRESET}'...`,
    );
    const strictSchema = generateStrictJsonSchema(enData);

    // 3. Update template.config.json with the new response_format
    const configContent = await readFile(CONFIG_PATH, "utf-8");
    const configData = JSON.parse(configContent) as Record<string, unknown>;

    const paramConfigs = configData["PARAM_CONFIGS"] as
      | Record<string, Record<string, unknown>>
      | undefined;

    if (!paramConfigs || !paramConfigs[TARGET_PRESET]) {
      console.error(
        `Error: Preset '${TARGET_PRESET}' not found under PARAM_CONFIGS in ${CONFIG_PATH}`,
      );
      process.exit(1);
    }

    const preset = paramConfigs[TARGET_PRESET]!;
    const reasoningType = preset["reasoningType"] as string | undefined;
    let variant: Record<string, unknown> | undefined;

    if (reasoningType === "instruct_only" || reasoningType === "reason_only") {
      variant = preset["default"] as Record<string, unknown> | undefined;
    } else if (reasoningType === "reason_and_instruct") {
      variant = (preset["reasoning"] ?? preset["instruct"]) as
        | Record<string, unknown>
        | undefined;
    }

    if (!variant || !variant["model"]) {
      console.error(
        `Error: Could not locate variant or model parameters inside preset '${TARGET_PRESET}'`,
      );
      process.exit(1);
    }

    const modelParams = variant["model"] as Record<string, unknown>;

    modelParams["response_format"] = [
      true,
      {
        type: "json_schema",
        json_schema: {
          name: "telocity_i18n_translation",
          strict: true,
          schema: strictSchema,
        },
      },
    ];

    await writeFile(CONFIG_PATH, stringifyReadable(configData), "utf-8");
    console.log(`Successfully updated response_format in '${CONFIG_PATH}'!`);
  } catch (err) {
    console.error("An error occurred during execution:", err);
    process.exit(1);
  }
}

await main();
