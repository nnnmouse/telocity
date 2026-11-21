#!/usr/bin/env node
import Ajv from "ajv";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { LanguageStrings } from "../src/libs/types/index.ts";

const definitions = {
  languageEntry: {
    type: "object",
    properties: {
      name: { type: "string" },
      aliases: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  languagesObject: {
    type: "object",
    patternProperties: {
      "^.+$": {
        oneOf: [
          { type: "string" }, // for metadata like _LLM_INSTRUCTIONS_ALIASES
          { $ref: "#/definitions/languageEntry" },
        ],
      },
    },
    additionalProperties: false,
  },
  stringOrNestedObject: {
    oneOf: [
      { type: "string" },
      {
        type: "object",
        patternProperties: {
          "^.+$": { $ref: "#/definitions/stringOrNestedObject" },
        },
        additionalProperties: false,
      },
    ],
  },
  stringObject: {
    type: "object",
    patternProperties: {
      "^.+$": { type: "string" },
    },
    additionalProperties: false,
  },
  helpCommand: {
    type: "object",
    properties: {
      usage: { type: "string" },
      description: { type: "string" },
      flags: { $ref: "#/definitions/stringObject" },
      footer: { type: "string" },
    },
    required: ["usage", "description"],
    additionalProperties: false,
  },
} as const;

const i18nSchema = {
  type: "object",
  properties: {
    m: { $ref: "#/definitions/stringOrNestedObject" },
    e: { $ref: "#/definitions/stringOrNestedObject" },
    languages: { $ref: "#/definitions/languagesObject" },
    help: {
      type: "object",
      properties: {
        generic: {
          type: "object",
          properties: {
            header: { type: "string" },
            usage: { type: "string" },
            commandHeader: { type: "string" },
            commandDescriptions: { $ref: "#/definitions/stringObject" },
            footer: { type: "string" },
            globalOptionsHeader: { type: "string" },
            flags: { $ref: "#/definitions/stringObject" },
          },
          required: [
            "header",
            "usage",
            "commandHeader",
            "commandDescriptions",
            "footer",
            "globalOptionsHeader",
            "flags",
          ],
          additionalProperties: false,
        },
        commands: {
          type: "object",
          patternProperties: {
            "^.+$": { $ref: "#/definitions/helpCommand" },
          },
          additionalProperties: false,
        },
        optionsHeader: { type: "string" },
      },
      required: ["generic", "commands", "optionsHeader"],
      additionalProperties: false,
    },
  },
  required: ["m", "e", "help", "languages"],
  additionalProperties: false,
  definitions,
} as const;

const ajv = new Ajv.default({
  allErrors: true,
  discriminator: true,
});

const validate = ajv.compile<LanguageStrings>(i18nSchema);

type ValidationResult =
  | { isValid: true; data: LanguageStrings }
  | { isValid: false; errors: typeof validate.errors };

export function validateI18nFile(data: unknown): ValidationResult {
  if (validate(data)) {
    return {
      isValid: true,
      data,
    };
  }
  return {
    isValid: false,
    errors: validate.errors,
  };
}

async function main() {
  const i18nDir = "./data/i18n";
  console.log(`Attempting to validate all i18n files in '${i18nDir}'...`);

  try {
    const files = await readdir(i18nDir);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    if (jsonFiles.length === 0) {
      console.error(`No translation files found in ${i18nDir}`);
      process.exit(1);
    }

    let allValid = true;

    for (const file of jsonFiles) {
      const filePath = path.join(i18nDir, file);
      console.log(`\nValidating '${filePath}'...`);

      try {
        const fileContent = await readFile(filePath, "utf-8");
        const i18nData: unknown = JSON.parse(fileContent);

        const result = validateI18nFile(i18nData);

        if (result.isValid) {
          console.log(`✔ i18n file '${file}' is valid!`);
          console.log(
            `  Top-level keys: ${Object.keys(result.data).join(", ")}`,
          );
        } else {
          console.error(`✘ i18n file '${file}' is invalid. Errors:`);
          console.error(JSON.stringify(result.errors, null, 2));
          allValid = false;
        }
      } catch (err) {
        console.error(`An error occurred while validating '${file}':`, err);
        allValid = false;
      }
    }

    if (!allValid) {
      process.exit(1);
    } else {
      console.log("\nAll i18n files validated successfully!");
    }
  } catch (err) {
    console.error("An error occurred while reading the i18n directory:", err);
    process.exit(1);
  }
}

await main();
