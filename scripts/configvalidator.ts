#!/usr/bin/env node
import type { ErrorObject } from "ajv";

import Ajv from "ajv";
import { readFile } from "node:fs/promises";

import type { AppConfig } from "../src/libs/types/index.ts";

const VALID_REASONING_EFFORT_VALUES = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

const definitions = {
  stringParam: {
    type: "array",
    items: [{ type: "boolean" }, { type: "string" }],
    minItems: 2,
    maxItems: 2,
    additionalItems: false,
  },
  numberParam: {
    type: "array",
    items: [{ type: "boolean" }, { type: "number" }],
    minItems: 2,
    maxItems: 2,
    additionalItems: false,
  },
  booleanParam: {
    type: "array",
    items: [{ type: "boolean" }, { type: "boolean" }],
    minItems: 2,
    maxItems: 2,
    additionalItems: false,
  },
  objectParam: {
    type: "array",
    items: [{ type: "boolean" }, { type: "object" }],
    minItems: 2,
    maxItems: 2,
    additionalItems: false,
  },
  stringArrayParam: {
    type: "array",
    items: [
      { type: "boolean" },
      {
        type: "array",
        items: { type: "string" },
      },
    ],
    minItems: 2,
    maxItems: 2,
    additionalItems: false,
  },
  responseFormatParam: {
    type: "array",
    items: [
      { type: "boolean" },
      {
        type: "object",
        anyOf: [
          {
            type: "object",
            properties: {
              type: { enum: ["text", "json_object"] },
            },
            required: ["type"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              type: { const: "json_schema" },
              json_schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  description: { type: "string" },
                  schema: { type: "object" },
                  strict: { type: "boolean" },
                },
                required: ["name", "schema"],
                additionalProperties: false,
              },
            },
            required: ["type", "json_schema"],
            additionalProperties: false,
          },
          {
            type: "object",
          },
        ],
      },
    ],
    minItems: 2,
    maxItems: 2,
    additionalItems: false,
  },
  reasoningEffortParam: {
    type: "array",
    items: [
      { type: "boolean" },
      { type: "string", enum: [...VALID_REASONING_EFFORT_VALUES] },
    ],
    minItems: 2,
    maxItems: 2,
    additionalItems: false,
  },
  thinkingParam: {
    type: "array",
    items: [
      { type: "boolean" },
      {
        type: "object",
        properties: {
          type: { enum: ["enabled", "disabled"] },
        },
        required: ["type"],
        additionalProperties: false,
      },
    ],
    minItems: 2,
    maxItems: 2,
    additionalItems: false,
  },
  promptParam: {
    oneOf: [
      {
        type: "array",
        items: [{ type: "boolean" }, { type: "string" }],
        minItems: 2,
        maxItems: 2,
        additionalItems: false,
      },
      {
        type: "array",
        items: [{ type: "boolean" }, { type: "string" }, { type: "string" }],
        minItems: 3,
        maxItems: 3,
        additionalItems: false,
      },
    ],
  },
  providerParam: {
    type: "array",
    items: [
      { type: "boolean" },
      {
        type: "object",
        properties: {
          order: {
            type: "array",
            items: { type: "string" },
          },
          allow_fallbacks: { type: "boolean" },
          require_parameters: { type: "boolean" },
          data_collection: { type: "string", enum: ["allow", "deny"] },
          zdr: { type: "boolean" },
          enforce_distillable_text: { type: "boolean" },
          only: {
            type: "array",
            items: { type: "string" },
          },
          ignore: {
            type: "array",
            items: { type: "string" },
          },
          quantizations: {
            type: "array",
            items: { type: "string" },
          },
          sort: {
            oneOf: [
              { type: "string", enum: ["price", "throughput", "latency"] },
              {
                type: "object",
                properties: {
                  by: {
                    type: "string",
                    enum: ["price", "throughput", "latency"],
                  },
                  partition: { type: "string", enum: ["model", "none"] },
                },
                required: ["by"],
                additionalProperties: false,
              },
            ],
          },
          preferred_min_throughput: {
            oneOf: [
              { type: "number" },
              {
                type: "object",
                properties: {
                  p50: { type: "number" },
                  p75: { type: "number" },
                  p90: { type: "number" },
                  p99: { type: "number" },
                },
                additionalProperties: false,
              },
            ],
          },
          preferred_max_latency: {
            oneOf: [
              { type: "number" },
              {
                type: "object",
                properties: {
                  p50: { type: "number" },
                  p75: { type: "number" },
                  p90: { type: "number" },
                  p99: { type: "number" },
                },
                additionalProperties: false,
              },
            ],
          },
          max_price: {
            type: "object",
            properties: {
              prompt: { type: "number" },
              completion: { type: "number" },
              request: { type: "number" },
              image: { type: "number" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    ],
    minItems: 2,
    maxItems: 2,
    additionalItems: false,
  },
  configMetadata: {
    type: "object",
    properties: {
      helptext_key: { type: "string" },
      stripTags: {
        type: "object",
        properties: {
          start: { type: "string" },
          end: { type: "string" },
        },
        required: ["start", "end"],
        additionalProperties: false,
      },
      display: { type: "boolean" },
      localJSONL: { type: "boolean" },
      defaultReasoning: { type: "boolean" },
      stripEmpty: { type: "boolean" },
      markdownBrainRot: { type: "boolean" },
      substitutionPrefix: { type: "string" },
      forceStream: { type: "boolean" },
      injectORSessionId: { type: "boolean" },
      allowH2: { type: "boolean" },
    },
    additionalProperties: false,
  },
  configModelParams: {
    type: "object",
    properties: {
      chunkSize: { type: "number", minimum: 1 },
      batchSize: { type: "number", minimum: 1 },
      parallel: { type: "number", minimum: 1 },
      url: { type: "string", format: "uri" },
      endpoint: {
        type: "string",
        enum: [
          "chatcompletions",
          "deepseek",
          "responses",
          "completions",
          "openrouter-chat",
          "openrouter-responses",
        ],
      },
      apiKey: { type: "string" },
      rpm: { type: "number", minimum: 1 },
      retryDelay: { type: "number", minimum: 1 },
      maxAttempts: { type: "number", minimum: 1 },
      maxFail: { type: "number", minimum: 0 },
      tempValues: {
        type: "array",
        items: { type: "number", minimum: 0, maximum: 2 },
      },
      hardTimeout: { type: "number", minimum: 0.1 },
      idleTimeout: { type: "number", minimum: 0.001 },
      stripEmpty: { type: "boolean" },
      markdownBrainRot: { type: "boolean" },
      failureMeansDeath: { type: "boolean" },
      allowH2: { type: "boolean" },

      model: { $ref: "#/definitions/stringParam" },
      temperature: { $ref: "#/definitions/numberParam" },
      top_p: { $ref: "#/definitions/numberParam" },
      top_k: { $ref: "#/definitions/numberParam" },
      presence_penalty: { $ref: "#/definitions/numberParam" },
      seed: { $ref: "#/definitions/numberParam" },

      reasoning_effort: { $ref: "#/definitions/reasoningEffortParam" },
      thinking: { $ref: "#/definitions/thinkingParam" },
      enable_thinking: { $ref: "#/definitions/booleanParam" },
      chat_template_kwargs: { $ref: "#/definitions/objectParam" },
      reasoning: { $ref: "#/definitions/objectParam" },
      include: { $ref: "#/definitions/stringArrayParam" },
      response_format: { $ref: "#/definitions/responseFormatParam" },
      grammar: { $ref: "#/definitions/stringParam" },
      provider: { $ref: "#/definitions/providerParam" },
      thinking_budget_tokens: { $ref: "#/definitions/numberParam" },
      reasoning_control: { $ref: "#/definitions/booleanParam" },
      max_tokens: { $ref: "#/definitions/numberParam" },
    },
    additionalProperties: false,
  },
  configPrompt: {
    type: "object",
    properties: {
      defSys: { $ref: "#/definitions/promptParam" },
      defPrep: { $ref: "#/definitions/promptParam" },
      defPrefill: { $ref: "#/definitions/promptParam" },
    },
    minProperties: 1,
    additionalProperties: false,
  },
  configModelVariant: {
    type: "object",
    properties: {
      prompt: { $ref: "#/definitions/configPrompt" },
      model: { $ref: "#/definitions/configModelParams" },
    },
    required: ["model"],
    additionalProperties: false,
  },
  instructOnlyModelConfig: {
    type: "object",
    properties: {
      reasoningType: { const: "instruct_only" },
      metadata: { $ref: "#/definitions/configMetadata" },
      default: { $ref: "#/definitions/configModelVariant" },
    },
    required: ["reasoningType", "default"],
  },
  reasonOnlyModelConfig: {
    type: "object",
    properties: {
      reasoningType: { const: "reason_only" },
      metadata: { $ref: "#/definitions/configMetadata" },
      default: { $ref: "#/definitions/configModelVariant" },
    },
    required: ["reasoningType", "default"],
  },
  reasonAndInstructModelConfig: {
    type: "object",
    properties: {
      reasoningType: { const: "reason_and_instruct" },
      metadata: { $ref: "#/definitions/configMetadata" },
      instruct: { $ref: "#/definitions/configModelVariant" },
      reasoning: { $ref: "#/definitions/configModelVariant" },
    },
    required: ["reasoningType", "instruct", "reasoning"],
  },
} as const;

const appConfigSchema = {
  type: "object",
  properties: {
    DEFAULT_MODEL: { type: "string" },
    DEFAULT_REASONING: { type: "boolean" },
    HARD_TIMEOUT: { type: "number", minimum: 0.1 },
    IDLE_TIMEOUT: { type: "number", minimum: 0.001 },
    CHUNK_SIZE: { type: "number", minimum: 1 },
    BATCH_SIZE: { type: "number", minimum: 1 },
    PARALLEL: { type: "number", minimum: 1 },
    URL: { type: "string", format: "uri" },
    ENDPOINT: {
      type: "string",
      enum: [
        "chatcompletions",
        "deepseek",
        "responses",
        "completions",
        "openrouter-chat",
        "openrouter-responses",
      ],
    },
    RPM: { type: "number", minimum: 1 },
    MAX_FAIL: { type: "number", minimum: 0 },
    RETRY_DELAY: { type: "number", minimum: 1 },
    SOURCE_LANGUAGE: { type: "string" },
    TARGET_LANGUAGE: { type: "string" },
    TEMPLATES: {
      type: "object",
      patternProperties: {
        "^.+$": { type: "string" },
      },
    },
    PREFIX_REPLACEMENTS: {
      type: "object",
      patternProperties: {
        "^.+$": { type: "string" },
      },
      additionalProperties: false,
    },
    PARAM_CONFIGS: {
      type: "object",
      patternProperties: {
        "^.+$": {
          type: "object",
          oneOf: [
            { $ref: "#/definitions/instructOnlyModelConfig" },
            { $ref: "#/definitions/reasonOnlyModelConfig" },
            { $ref: "#/definitions/reasonAndInstructModelConfig" },
          ],
          discriminator: { propertyName: "reasoningType" },
        },
      },
      additionalProperties: false,
    },
    VERSION: { type: "integer", minimum: 1 },
    FAILURE_MEANS_DEATH: { type: "boolean" },
  },
  required: [
    "DEFAULT_MODEL",
    "DEFAULT_REASONING",
    "HARD_TIMEOUT",
    "IDLE_TIMEOUT",
    "CHUNK_SIZE",
    "BATCH_SIZE",
    "PARALLEL",
    "URL",
    "ENDPOINT",
    "RPM",
    "MAX_FAIL",
    "RETRY_DELAY",
    "SOURCE_LANGUAGE",
    "TARGET_LANGUAGE",
    "TEMPLATES",
    "PARAM_CONFIGS",
    "VERSION",
  ],
  additionalProperties: false,
  definitions,
} as const;

const ajv = new Ajv.default({
  allErrors: true,
  strict: true,
  discriminator: true,
});

ajv.addFormat("uri", (data: string) => {
  try {
    new URL(data);
    return true;
  } catch {
    return false;
  }
});

const validate = ajv.compile<AppConfig>(appConfigSchema);

type ValidationResult =
  | { isValid: true; data: AppConfig }
  | { isValid: false; errors: typeof validate.errors };

function validatePrefixReplacements(config: AppConfig): ErrorObject[] {
  const errors: ErrorObject[] = [];
  const replacements = config.PREFIX_REPLACEMENTS;
  if (!replacements) {
    return errors;
  }

  // Group keys by the part before the first underscore
  const groups: Record<string, Set<string>> = {};
  for (const key of Object.keys(replacements)) {
    const underscoreIdx = key.indexOf("_");
    if (underscoreIdx === -1) {
      errors.push({
        instancePath: "/PREFIX_REPLACEMENTS",
        schemaPath: "#/properties/PREFIX_REPLACEMENTS/patternProperties",
        keyword: "custom",
        params: { key },
        message: `Invalid PREFIX_REPLACEMENTS key "${key}": missing underscore separator`,
      });
      continue;
    }
    const prefix = key.substring(0, underscoreIdx);
    const suffix = key.substring(underscoreIdx + 1);
    if (!groups[prefix]) groups[prefix] = new Set();
    groups[prefix].add(suffix);
  }

  const referencePrefix = "CN";
  const referenceSet = groups[referencePrefix];
  if (!referenceSet) {
    errors.push({
      instancePath: "/PREFIX_REPLACEMENTS",
      schemaPath: "#/properties/PREFIX_REPLACEMENTS",
      keyword: "custom",
      params: { referencePrefix },
      message: `Reference prefix "${referencePrefix}_" not found in PREFIX_REPLACEMENTS`,
    });
    return errors;
  }

  for (const [prefix, suffixSet] of Object.entries(groups)) {
    if (prefix === referencePrefix) continue;
    if (suffixSet.size !== referenceSet.size) {
      errors.push({
        instancePath: "/PREFIX_REPLACEMENTS",
        schemaPath: "#/properties/PREFIX_REPLACEMENTS",
        keyword: "custom",
        params: {
          prefix,
          expectedSize: referenceSet.size,
          actualSize: suffixSet.size,
        },
        message: `Prefix "${prefix}_" has ${suffixSet.size} suffixes, but "${referencePrefix}_" has ${referenceSet.size}. All suffix sets must be identical.`,
      });
      continue;
    }
    for (const suffix of suffixSet) {
      if (!referenceSet.has(suffix)) {
        errors.push({
          instancePath: "/PREFIX_REPLACEMENTS",
          schemaPath: "#/properties/PREFIX_REPLACEMENTS",
          keyword: "custom",
          params: { prefix, suffix, referencePrefix },
          message: `Prefix "${prefix}_" contains extra suffix "${suffix}" that is not present in "${referencePrefix}_"`,
        });
      }
    }
    for (const suffix of referenceSet) {
      if (!suffixSet.has(suffix)) {
        errors.push({
          instancePath: "/PREFIX_REPLACEMENTS",
          schemaPath: "#/properties/PREFIX_REPLACEMENTS",
          keyword: "custom",
          params: { prefix, suffix, referencePrefix },
          message: `Prefix "${prefix}_" is missing suffix "${suffix}" which is present in "${referencePrefix}_"`,
        });
      }
    }
  }

  return errors;
}

export function validateConfig(data: unknown): ValidationResult {
  if (isAppConfig(data)) {
    // Run the custom semantic check on PREFIX_REPLACEMENTS
    const prefixErrors = validatePrefixReplacements(data);
    if (prefixErrors.length > 0) {
      return {
        isValid: false,
        errors: prefixErrors,
      };
    }
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

function isAppConfig(data: unknown): data is AppConfig {
  return validate(data);
}

async function main() {
  console.log("Attempting to validate 'config.json'...");

  try {
    const configPath = "./data/config/template.config.json";
    const fileContent = await readFile(configPath, "utf-8");
    const configData: unknown = JSON.parse(fileContent);

    const result = validateConfig(configData);

    if (result.isValid) {
      console.log("\nConfiguration is valid!");
      console.log(`Default Model: ${result.data.DEFAULT_MODEL}`);
    } else {
      console.error("\nConfiguration is invalid. Errors:");
      console.error(JSON.stringify(result.errors, null, 2));
      process.exit(1);
    }
  } catch (err) {
    console.error(
      "An error occurred while reading or parsing the config file:",
      err,
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
