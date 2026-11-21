import path from "node:path";

import type {
  BackendStrategy,
  ChatCompletionsPayload,
  ConfigModelVariant,
  LanguageStrings,
  LLMConfigurableProps,
  LLMDependencies,
  MappableParamKey,
  Message,
  ModelConfig,
  ParamConfigs,
  ParsedStreamChunk,
  StrategyContext,
  CompletionOptions,
  Endpoints,
  StreamChunkItem,
  JSONLStrategy,
  ParsedJsonlLine,
  JsonlBatchRequest,
} from "../types/index.ts";
import type { LLM } from "./LLM.ts";

import { enUS } from "../../cmap.ts";
import {
  config as appConfig,
  createError,
  formatAlignedList,
  simpleTemplate,
  x,
} from "../core/index.ts";
import { DeepSeekStrategy } from "./DeepSeekStrategy.ts";
import { ReasoningTracker } from "./LLM.ts";
import {
  ChatCompletionsStrategy,
  CompletionsStrategy,
  ResponsesStrategy,
  OpenAIJSONLStrategy,
} from "./OpenAIStrategy.ts";
import {
  OpenRouterChatCompletionsStrategy,
  OpenRouterResponsesStrategy,
} from "./OpenRouterStrategy.ts";

export class DummyStrategy implements BackendStrategy {
  public readonly supportedParams: ReadonlyArray<MappableParamKey> = [
    "model",
    "temperature",
    "top_p",
    "top_k",
    "presence_penalty",
    "seed",
    "reasoning_effort",
    "chat_template_kwargs",
    "enable_thinking",
    "grammar",
    "provider",
    "max_tokens",
  ];
  public readonly jsonlFormat = "dummy" as const;

  public createAccumulator(
    _messages: Message[],
    _context: StrategyContext,
  ): Record<string, unknown> {
    return {
      id: "dummy-id",
      created: Math.floor(Date.now() / 1000),
      model: "dummy-model",
      system_fingerprint: "dummy-fp",
      object: "chat.completion",
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
      timings: null,
    };
  }

  public accumulateChunk(
    accumulator: unknown,
    chunk: ParsedStreamChunk,
    _context: StrategyContext,
  ): void {
    const acc = accumulator as {
      choices: Array<{
        index: number;
        message: { role: string; content: string };
        finish_reason: string | null;
      }>;
    };
    if (chunk.choices && Array.isArray(chunk.choices)) {
      for (const choice of chunk.choices) {
        const index =
          choice.delta && "index" in choice
            ? (((choice as Record<string, unknown>)["index"] as number) ?? 0)
            : 0;
        let accChoice = acc.choices.find((c) => c.index === index);
        if (!accChoice) {
          accChoice = {
            index,
            message: { role: "assistant", content: "" },
            finish_reason: null,
          };
          acc.choices.push(accChoice);
        }
        if (choice.delta?.content) {
          accChoice.message.content += choice.delta.content;
        }
      }
    }
  }

  public finalizeAccumulator(
    accumulator: unknown,
    finalContent: string,
    context: StrategyContext,
  ): Record<string, unknown> {
    const acc = accumulator as {
      choices: Array<{
        index: number;
        message: { role: string; content: string; reasoning_content?: string };
        finish_reason: string | null;
      }>;
    };
    if (acc.choices.length === 0) {
      acc.choices.push({
        index: 0,
        message: {
          role: "assistant",
          content: finalContent,
          reasoning_content: context.reasoningTracker.unencrypted || undefined,
        },
        finish_reason: "stop",
      });
    } else {
      for (const choice of acc.choices) {
        if (!choice.message.content && finalContent) {
          choice.message.content = finalContent;
        }
      }
    }
    return acc as Record<string, unknown>;
  }

  public buildPayload(
    messages: Message[],
    ctx: StrategyContext,
    isStreaming: boolean,
  ): ChatCompletionsPayload {
    return {
      messages,
      stream: isStreaming,
      model: "dummy-model",
      ...ctx.commonParams,
    } as unknown as ChatCompletionsPayload;
  }

  public parseChunk(
    chunk: ParsedStreamChunk,
    _ctx: StrategyContext,
  ): Array<StreamChunkItem> {
    const out: Array<StreamChunkItem> = [];
    if (chunk.choices?.[0]?.delta?.content) {
      out.push({ text: chunk.choices[0].delta.content, kind: "delta" });
    } else if (chunk.choices?.[0]?.message?.content) {
      out.push({ text: chunk.choices[0].message.content, kind: "delta" });
    } else if (chunk.text) {
      out.push({ text: chunk.text, kind: "delta" });
    }
    return out;
  }
}

export class DummyJSONLStrategy implements JSONLStrategy {
  private readonly delegate = new OpenAIJSONLStrategy();
  public readonly formatName = "dummy";

  public buildLine(
    customId: string,
    payload: Record<string, unknown>,
    requestUrl: string,
    meta?: Parameters<JSONLStrategy["buildLine"]>[3],
  ): string {
    return this.delegate.buildLine(customId, payload, requestUrl, meta);
  }

  public buildResponse(
    customId: string,
    responseBody: Record<string, unknown> | null,
    errorObj: Record<string, unknown> | null,
  ): string {
    return this.delegate.buildResponse(customId, responseBody, errorObj);
  }

  public parseLine(line: string): ParsedJsonlLine {
    return this.delegate.parseLine(line);
  }

  public parseRequest(line: string): JsonlBatchRequest | null {
    return this.delegate.parseRequest(line);
  }
}

export function segmentText(text: string, chunkSize: number): string[] {
  const lines = text.split("\n");
  return Array.from({ length: Math.ceil(lines.length / chunkSize) }, (_, i) => {
    const start = i * chunkSize;
    const end = start + chunkSize;
    return lines.slice(start, end).join("\n");
  });
}

export function segmentTextByPattern(text: string, pattern: RegExp): string[] {
  // Automatically enforce global (g) and multiline (m) flags for line-based boundary matches
  let flags = pattern.flags;
  if (!flags.includes("g")) flags += "g";
  if (!flags.includes("m")) flags += "m";

  const re = new RegExp(pattern.source, flags);

  const chunks: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      chunks.push(text.substring(lastIndex, match.index));
    }
    lastIndex = match.index;

    if (match[0].length === 0) {
      re.lastIndex++;
    }
  }

  if (lastIndex < text.length) {
    chunks.push(text.substring(lastIndex));
  }

  return chunks;
}

export function calcAvgLineLength(text: string): number {
  const lines = text.split("\n").filter((line) => line.trim() !== "");

  if (!lines.length) return 0;
  const segmenter = x.a.segmenter;
  const totalGraphemes = lines.reduce((sum, line) => {
    const graphemeCount = [...segmenter.segment(line)].length;
    return sum + graphemeCount;
  }, 0);
  return Math.round(totalGraphemes / lines.length);
}

export function calcAvgLineLengthBytes(text: string): number {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (!lines.length) return 0;
  const totalUTF8Bytes = lines.reduce((sum, line) => {
    const byteLength = Buffer.byteLength(line, "utf8");
    return sum + byteLength;
  }, 0);
  return Math.round(totalUTF8Bytes / lines.length);
}

export function stripGarbageNewLines(
  text: string | string[],
  options: { stripEmpty?: boolean; markdownBrainRot?: boolean } = {},
): string {
  const { stripEmpty = false, markdownBrainRot = false } = options;
  const shouldStripEmpty = stripEmpty || markdownBrainRot;

  // Normalize type
  let flatText = Array.isArray(text) ? text.join("\n") : text;

  if (typeof flatText !== "string") {
    throw new TypeError("Input must be a string or an array of strings.");
  }

  // Perform global sanitization over the entire text block at once
  flatText = flatText
    .replace(/\r\n|\r/g, "\n") // Normalize all line endings to LF
    // Strip Unicode layout separators, zero-width/BiDi formatting, BOM, and non-essential ASCII controls
    .replace(
      // oxlint-disable-next-line no-control-regex
      /[\u2028\u2029\u200B\u200E\u200F\uFEFF\u202A-\u202E\u2060-\u206F\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,
      "",
    );

  // Conditional empty-line stripping
  if (shouldStripEmpty) {
    // Matches any sequence of blank lines (possibly containing spaces/tabs) bounded by newlines
    flatText = flatText
      .replace(/^[ \t]*\n/gm, "") // Remove empty lines at start or middle
      .replace(/\n[ \t]*$/g, ""); // Remove trailing empty lines
  }

  // Double newline expansion
  if (markdownBrainRot) {
    return flatText.replace(/\n+/g, "\n\n");
  }

  return flatText;
}

export function resolveStrategy(endpoint: Endpoints): BackendStrategy {
  switch (endpoint) {
    case "chatcompletions":
      return new ChatCompletionsStrategy();
    case "completions":
      return new CompletionsStrategy();
    case "responses":
      return new ResponsesStrategy();
    case "deepseek":
      return new DeepSeekStrategy();
    case "openrouter-chat":
      return new OpenRouterChatCompletionsStrategy();
    case "openrouter-responses":
      return new OpenRouterResponsesStrategy();
    default:
      return new ChatCompletionsStrategy();
  }
}

export function getRelativePathForEndpoint(endpoint: Endpoints): string {
  switch (endpoint) {
    case "completions":
      return "/v1/completions";
    case "responses":
    case "openrouter-responses":
      return "/v1/responses";
    case "chatcompletions":
    case "deepseek":
    case "openrouter-chat":
    default:
      return "/v1/chat/completions";
  }
}

export function resolveModelConfig(
  paramsKey: string,
  useReasoning: boolean,
): ConfigModelVariant {
  const { a } = x;
  const modelConfig = appConfig.PARAM_CONFIGS[paramsKey];

  if (!modelConfig) {
    throw createError(
      simpleTemplate(a.s.e.lllm.undefinedParam, {
        ParamKey: paramsKey,
      }),
      {
        code: "UNDEFINED_PARAM",
      },
    );
  }

  let activeConfig: ConfigModelVariant;

  switch (modelConfig.reasoningType) {
    case "reason_and_instruct":
      activeConfig = useReasoning
        ? modelConfig.reasoning
        : modelConfig.instruct;
      break;
    case "instruct_only":
      activeConfig = modelConfig.default;
      break;
    case "reason_only":
      activeConfig = modelConfig.default;
      break;
    default:
      throw createError(
        simpleTemplate(a.s.e.lllm.invalidReasoningType, {
          Model: paramsKey,
          // @ts-expect-error - purely for error reporting
          Type: String(modelConfig.reasoningType),
        }),
        { code: "INVALID_REASONING_TYPE" },
      );
  }

  return activeConfig;
}

export const dummyDependencies: LLMDependencies = {
  strategy: new DummyStrategy(),
  llmcall: async function (
    this: LLM,
    messages: Message[],
    options?: CompletionOptions,
  ): Promise<string> {
    const llmInstance = this as unknown as {
      readonly strategy: BackendStrategy;
      readonly url: string;
      readonly apiKey: string;
      readonly rpm: number;
      getStrategyContext(
        tracker: ReasoningTracker,
        overrides?: Partial<LLMConfigurableProps>,
      ): StrategyContext;
    };

    const tracker = options?.tracker ?? new ReasoningTracker();
    const strategy = options?.endpointOptions?.strategy ?? llmInstance.strategy;
    const ctx = llmInstance.getStrategyContext(tracker, options?.overrides);
    const payload =
      options?.endpointOptions?.payload ??
      strategy.buildPayload(messages, ctx, false);
    const url = options?.endpointOptions?.url ?? llmInstance.url;

    function* dummyStream(): Generator<string, void, unknown> {
      const summaryLines = [
        "--- Dummy LLM Call (Debug Mode) ---",
        `Timestamp: ${Temporal.Now.instant().toString()}`,
        `URL: ${url ?? "N/A"}`,
        `API Key: ${llmInstance.apiKey ? "[PRESENT]" : "[NOT PRESENT]"}`,
        `Pre-call RPM: ${String(llmInstance.rpm ?? "N/A")}`,
        "--- Final Payload (From Injected DummyStrategy) ---",
        JSON.stringify(payload, null, 2),
        "\n--- End Dummy Call ---",
      ];

      for (const line of summaryLines) {
        yield line + "\n";
        //await new Promise((resolve) => setTimeout(resolve, 666));
      }
    }

    const { verbose = false } = options ?? {};
    let result = "";

    for (const chunk of dummyStream()) {
      if (typeof verbose === "function") {
        await verbose(chunk, false);
      } else if (verbose) {
        process.stdout.write(chunk);
      }
      result += chunk;
    }

    return Promise.resolve(result);
  },
};

type PathString<T> = {
  [K in keyof T & string]: T[K] extends object
    ? `${K}` | `${K}.${PathString<T[K]>}`
    : `${K}`;
}[keyof T & string];

export function resolveStringKey<T>(
  obj: T,
  path: PathString<T>,
): string | undefined {
  return path.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object" && part in acc) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj) as string | undefined;
}

function processPresets(
  configs: ParamConfigs,
  processor: (modelConfig: ModelConfig) => string | null,
): string {
  const items = Object.entries(configs)
    .map(([key, modelConfig]) => {
      const description = processor(modelConfig);
      if (description !== null) {
        return { key, description };
      }
      return null;
    })
    .filter(
      (item): item is { key: string; description: string } => item !== null,
    );

  return formatAlignedList(items, { listIndentWidth: 2 });
}

export function getPresetHelpText(configs: ParamConfigs): string {
  const { a } = x;

  return processPresets(configs, (modelConfig) => {
    const metadata = modelConfig.metadata;
    const helptextKey = metadata?.helptext_key;
    const display = metadata?.display;

    if (!display) {
      return null;
    }

    if (helptextKey) {
      const startsWithModels = helptextKey.startsWith("models.");
      const fullPath = `m.c.${helptextKey}`;
      const resolvedValue = resolveStringKey(
        a.s,
        fullPath as PathString<LanguageStrings>,
      );

      if (startsWithModels) {
        return resolvedValue ?? a.s.m.c.models.noHelp;
      }

      if (resolvedValue !== undefined && resolvedValue !== null) {
        return resolvedValue;
      }

      return helptextKey;
    }

    return a.s.m.c.models.noHelp;
  });
}

export function getThinkTags(configs: ParamConfigs): string {
  const { a } = x;
  return processPresets(configs, (modelConfig) => {
    const stripTags = modelConfig.metadata?.stripTags;
    if (stripTags?.start && stripTags?.end) {
      return `${a.s.m.lllm.openingTag}: '${stripTags.start}' ${a.s.m.lllm.closingTag}: '${stripTags.end}'`;
    }
    return null;
  });
}

export function levenshteinWithCollator(
  a: string,
  b: string,
  collator: Intl.Collator,
): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array(m + 1);
  for (let i = 0; i <= m; i++) dp[i] = Array(n + 1);
  for (let i = 0; i <= m; i++) dp[i]![0]! = i;
  for (let j = 0; j <= n; j++) dp[0]![j]! = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = collator.compare(a[i - 1]!, b[j - 1]!) === 0 ? 0 : 1;
      dp[i]![j]! = Math.min(
        dp[i - 1]![j]! + 1, // deletion
        dp[i]![j - 1]! + 1, // insertion
        dp[i - 1]![j - 1]! + cost, // substitution
      );
    }
  }
  return dp[m]![n]!;
}

export function resolvePromptPreset(key: string): string {
  const appState = x.a;
  const templates = appConfig.TEMPLATES;
  const preset = templates?.[key];
  if (typeof preset !== "string" || preset.trim() === "") {
    throw createError(
      simpleTemplate(appState.s.e.lllm.undefinedPromptPreset, {
        PresetKey: key,
      }),
      { code: "UNDEFINED_PROMPT_PRESET" },
    );
  }
  return preset;
}

export function resolveLanguageName(input: string, prefix: string): string {
  const appState = x.a;
  const collator = appState.collator;

  const normalizedInput = input.trim();
  const normalizedInputLower = normalizedInput.toLowerCase();
  const prefixUpper = prefix.toUpperCase();

  let exactMatchedKey: string | undefined = undefined;
  const candidates: { key: string; name: string; distance: number }[] = [];

  const evaluateDictionary = (
    dict: Record<string, unknown>,
    populateCandidates: boolean,
  ) => {
    for (const [key, langObj] of Object.entries(dict)) {
      if (key.startsWith("_")) continue;
      const typedLangObj = langObj as { name: string; aliases?: string[] };
      const localizedName = typedLangObj.name;

      if (collator.compare(normalizedInput, localizedName) === 0) {
        return key;
      }

      if (typedLangObj.aliases) {
        const matchedAlias = typedLangObj.aliases.find(
          (alias) =>
            collator.compare(normalizedInput, alias) === 0 ||
            collator.compare(normalizedInputLower, alias) === 0,
        );
        if (matchedAlias) return key;
      }

      if (populateCandidates) {
        let minDistance = levenshteinWithCollator(
          normalizedInput,
          localizedName,
          collator,
        );

        if (typedLangObj.aliases) {
          for (const alias of typedLangObj.aliases) {
            if (alias.length > 3) {
              const aliasDist = levenshteinWithCollator(
                normalizedInputLower,
                alias,
                collator,
              );
              if (aliasDist < minDistance) {
                minDistance = aliasDist;
              }
            }
          }
        }

        candidates.push({ key, name: localizedName, distance: minDistance });
      }
    }
    return undefined;
  };

  exactMatchedKey = evaluateDictionary(appState.s.languages, true);

  if (!exactMatchedKey) {
    exactMatchedKey = evaluateDictionary(enUS.languages, false);
  }

  const templatesObj = appConfig.PREFIX_REPLACEMENTS;

  if (exactMatchedKey) {
    const templateKey = `${prefixUpper}_${exactMatchedKey}`;
    const templateValue = templatesObj?.[templateKey];
    if (templateValue !== undefined) return templateValue;
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => a.distance - b.distance);
    const bestCandidate = candidates[0]!;

    const threshold = Math.max(1, Math.floor(bestCandidate.name.length * 0.3));
    if (bestCandidate.distance <= threshold) {
      const templateKey = `${prefixUpper}_${bestCandidate.key}`;
      const templateValue = templatesObj?.[templateKey];
      if (templateValue !== undefined) return templateValue;
    }
    const availableOptions = candidates.map((c) => c.name).join(", ");
    throw createError(
      simpleTemplate(appState.s.e.lllm.invalidLanguageInput, {
        Input: input,
        Closest: bestCandidate.name,
      }) +
        "\n" +
        simpleTemplate(appState.s.e.lllm.availableLanguagesList, {
          List: availableOptions,
        }),
      { code: "INVALID_LANGUAGE_INPUT" },
    );
  }

  throw createError(
    simpleTemplate(appState.s.e.lllm.invalidLanguageInputNoSuggestion, {
      Input: input,
    }),
    { code: "INVALID_LANGUAGE_INPUT" },
  );
}

export function buildTranslationInstructions(
  baseTemplate: string,
  sourceLanguage: string,
  targetLanguage: string,
) {
  return baseTemplate
    .replace(/\{\{\s*\.LanguageSource\s*\}\}/g, sourceLanguage)
    .replace(/\{\{\s*\.LanguageTarget\s*\}\}/g, targetLanguage);
}

export function getDefaultModelParam(
  param: "chunkSize" | "batchSize" | "parallel" | "rpm" | "retryDelay",
): string {
  const fallbacks = {
    chunkSize: appConfig.CHUNK_SIZE,
    batchSize: appConfig.BATCH_SIZE,
    parallel: appConfig.PARALLEL,
    rpm: appConfig.RPM,
    retryDelay: appConfig.RETRY_DELAY,
  };

  const modelConfig = appConfig.PARAM_CONFIGS[appConfig.DEFAULT_MODEL];
  let val: number | undefined;

  if (modelConfig) {
    const defaultReasoning =
      modelConfig.metadata?.defaultReasoning ?? appConfig.DEFAULT_REASONING;

    const activeVariant =
      modelConfig.reasoningType === "reason_and_instruct"
        ? defaultReasoning
          ? modelConfig.reasoning
          : modelConfig.instruct
        : modelConfig.default;

    val = activeVariant.model[param];
  }

  const result = val !== undefined && val !== null ? val : fallbacks[param];

  if (param === "retryDelay") {
    return String(result / 1000);
  }

  return String(result);
}

export function resolveModelParam(
  cliValue: string | undefined,
  configValue: number | undefined,
  fallback: number,
): number {
  if (cliValue !== undefined) {
    return +cliValue;
  }
  if (configValue !== undefined) {
    return configValue;
  }
  return fallback;
}

export function getAPIErrorStatus(err: unknown): number | null {
  if (err instanceof Error && "code" in err) {
    const errorCode = (err as { code: unknown }).code;
    if (typeof errorCode === "string" && errorCode.startsWith("API_ERROR_")) {
      const statusCode = parseInt(errorCode.slice(10), 10);
      if (!isNaN(statusCode)) {
        return statusCode;
      }
    }
  }
  return null;
}

/**
 * Generates a uniquely identifiable session ID for OpenRouter batch runs.
 *
 * Enforces a strict 40-character maximum length to ensure the payload remains
 * safely under a 128-byte limit. (the API doc says 128 characters)
 * but when in doubt, I'd rather use the lowest common denominator
 * their sdk even says 256 chara in type definitions, I don't like vague
 * stuff.
 *
 * @param filePath The path of the source file being processed.
 * @param segmenter An instance of Intl.Segmenter configured for safe grapheme parsing.
 * @returns A sanitized, formatted session ID string.
 */
export function buildSessionId(
  filePath: string,
  segmenter: Intl.Segmenter,
): string {
  const baseName = path.basename(filePath, path.extname(filePath));

  // Sanitize the filename to contain ONLY letters (including CJK characters), numbers, underscores, and hyphens.
  // This preserves multi-language support (via \p{L} and \p{N}) while safely stripping spaces, emojis,
  // and punctuation symbols.
  const sanitized = baseName.replace(/[^\p{L}\p{N}_-]/gu, "");

  let filenameFragment = "";

  // Loop over logical characters (grapheme clusters) using Intl.Segmenter.
  // This prevents cutting in the middle of multi-unit Unicode characters (such as surrogate pairs),
  // avoiding unmatched surrogates or corrupted string values.
  //
  // Limit the filename fragment to 28 characters. Because the structural prefix and suffix
  // occupy exactly 12 characters, a 28-character limit on the filename guarantees that the
  // entire session ID will never exceed 40 characters. This remains completely safe under
  // the 128-byte limit even in multi-byte languages.
  // We could allow longer char limits for ASCII but.. no. Everyone is equal.
  for (const { segment } of segmenter.segment(sanitized)) {
    if (filenameFragment.length + segment.length > 28) {
      break;
    }
    filenameFragment += segment;
  }

  const now = Temporal.Now.zonedDateTimeISO();
  const yyyy = now.year;
  const mm = String(now.month).padStart(2, "0");
  const dd = String(now.day).padStart(2, "0");
  const dateStr = `${yyyy}${mm}${dd}`;

  // The total footprint is guaranteed to be <= 40 characters:
  // "tc_" (3) + filenameFragment (max 28) + "_" (1) + Date (8) = 40 characters.
  return `tc_${filenameFragment}_${dateStr}`;
}

/**
 * Determines whether an API error represents a prompt-specific content moderation or safety block.
 *
 * @param status The HTTP status code returned by the API response.
 * @param errorCode The internal application error code.
 * @param errorMessage The raw or formatted error message string.
 * @returns A boolean indicating whether this is a prompt-specific block.
 */
export function isModerationBlock(
  status: number | null,
  errorCode: string | undefined,
  errorMessage: string,
): boolean {
  if (errorCode === "CONTENT_FILTER_TRIGGERED") {
    return true;
  }

  if (status === 403) {
    const normalized = errorMessage.toLowerCase();
    return (
      normalized.includes("content filter") ||
      normalized.includes("moderation") ||
      normalized.includes("safety") ||
      normalized.includes("policy") ||
      normalized.includes("flagged")
    );
  }

  return false;
}
