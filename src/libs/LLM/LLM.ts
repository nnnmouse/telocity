import type {
  AppState,
  BackendStrategy,
  ChatCompletionsPayload,
  CancellableJob,
  CompletionsPayload,
  ConfigMap,
  ConfigParam,
  ImageContentPart,
  IReasoningTracker,
  LLMConfigurableProps,
  LLMDependencies,
  InputAudioContentPart,
  Message,
  NumberParam,
  OutputItem,
  ParsedStreamChunk,
  PromptParam,
  ReasoningEffortValue,
  ResponsesPayload,
  ResponseFormat,
  StrategyContext,
  StringParam,
  TextContentPart,
  CompletionOptions,
  Endpoints,
  StreamChunkItem,
  OpenRouterProviderConfig,
  INetworkContext,
  LLMAPIError,
  IMiniResponseHeaders,
} from "../types/index.ts";

import {
  config as appConfig,
  createError,
  isNodeError,
  resolveConfig,
  simpleTemplate,
  V,
  x,
  errlog,
} from "../core/index.ts";
import { VALID_REASONING_EFFORT_VALUES } from "../types/index.ts";
import { llmFetch, NetworkContext } from "./LLMNetwork.ts";
import { TerminalStreamer } from "./LLMOutputStreamer.ts";
import { resolveStrategy, stripGarbageNewLines } from "./LLMutils.ts";
import { CompletionsStrategy, ResponsesStrategy } from "./OpenAIStrategy.ts";

let _ARG_CONFIG: ConfigMap<LLM & LLMConfigurableProps, LLMConfigurableProps>;

function getArgConfig() {
  if (_ARG_CONFIG) {
    return _ARG_CONFIG;
  }
  const { a } = x;

  const validReasoningEfforts = new Set<string>(VALID_REASONING_EFFORT_VALUES);

  const validateImageArray = (val: unknown): asserts val is string[] => {
    if (!Array.isArray(val)) {
      throw createError(
        simpleTemplate(a.s.e.v.invalidImageArray, {
          Value: String(val),
        }),
        { code: "INVALID_TYPE" },
      );
    }
    for (const item of val) {
      if (typeof item !== "string" || !item.startsWith("data:")) {
        const truncated =
          typeof item === "string"
            ? `${item.substring(0, 70)}...`
            : String(item);
        throw createError(
          simpleTemplate(a.s.e.v.invalidDataURI, { Value: truncated }),
          {
            code: "INVALID_DATA_URI",
          },
        );
      }
    }
  };

  _ARG_CONFIG = {
    chunkSize: {
      prop: "chunkSize" as keyof (LLM & LLMConfigurableProps),
      validate: V.num(
        { minExclusive: 0, max: 500000, integer: true },
        a.s.e.v.invalidChunkSize,
        "INVALID_CHUNK_SIZE",
        "{{ .ChunkSize }}",
      ),
    },
    batchSize: {
      prop: "batchSize" as keyof (LLM & LLMConfigurableProps),
      validate: V.num(
        { minExclusive: 0, max: 1000, integer: true },
        a.s.e.v.invalidBatchSize,
        "INVALID_BATCH_SIZE",
        "{{ .BatchSize }}",
      ),
    },
    parallel: {
      prop: "parallel" as keyof (LLM & LLMConfigurableProps),
      validate: V.num(
        { minExclusive: 0, max: 128, integer: true },
        a.s.e.v.invalidParallelSize,
        "INVALID_PARALLEL_SIZE",
        "{{ .Parallel }}",
      ),
    },
    url: {
      prop: "url" as keyof (LLM & LLMConfigurableProps),
      validate: V.str(
        { notEmpty: true },
        a.s.e.v.invalidURL,
        "INVALID_URL",
        "{{ .URL }}",
        { fn: (v) => v.startsWith("http://") || v.startsWith("https://") },
        a.s.e.v.invalidURLScheme,
        "INVALID_URL_SCHEME",
        "{{ .URL }}",
      ),
    },
    endpoint: {
      prop: "endpoint" as keyof (LLM & LLMConfigurableProps),
      validate: (val: unknown) => {
        if (
          val !== undefined &&
          val !== "chatcompletions" &&
          val !== "completions" &&
          val !== "responses" &&
          val !== "deepseek" &&
          val !== "openrouter-chat" &&
          val !== "openrouter-responses"
        ) {
          throw createError(
            simpleTemplate(a.s.e.lllm.invalidEndpoint, {
              Endpoint: String(val),
              Available:
                "chatcompletions, completions, responses, deepseek, openrouter-chat, openrouter-responses",
            }),
            { code: "INVALID_ENDPOINT" },
          );
        }
      },
    },
    thinking: {
      prop: "thinking" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: (val: unknown) => {
        if (val === undefined || val === null) {
          return;
        }
        if (typeof val !== "object") {
          throw createError(
            simpleTemplate(a.s.e.v.invalidOption, {
              Value: JSON.stringify(val),
            }),
            { code: "INVALID_THINKING_TYPE" },
          );
        }
        const type = (val as { type: unknown }).type;
        if (type !== "enabled" && type !== "disabled") {
          throw createError(
            simpleTemplate(a.s.e.v.invalidOption, {
              Value: JSON.stringify(val),
            }),
            { code: "INVALID_THINKING_VALUE" },
          );
        }
      },
    },
    apiKey: {
      prop: "apiKey" as keyof (LLM & LLMConfigurableProps),
      validate: V.str(
        {},
        a.s.e.v.invalidAPIKey,
        "INVALID_API_KEY",
        "{{ .APIKey }}",
      ),
    },
    images: {
      prop: "images" as keyof (LLM & LLMConfigurableProps),
      validate: validateImageArray,
    },
    audio: {
      prop: "audio" as keyof (LLM & LLMConfigurableProps),
      validate: (val: unknown) => {
        if (val === undefined || val === null) {
          return;
        }
        if (typeof val !== "object" || !("data" in val) || !("format" in val)) {
          throw createError(a.s.e.v.invalidAudioOption, {
            code: "INVALID_AUDIO",
          });
        }
      },
    },
    rpm: {
      prop: "rpm" as keyof (LLM & LLMConfigurableProps),
      validate: V.num(
        { minExclusive: 0 },
        simpleTemplate(a.s.e.v.invalidOption, { Value: "rpm" }),
        "INVALID_RPM_VALUE",
      ),
    },
    retryDelay: {
      prop: "retryDelay" as keyof (LLM & LLMConfigurableProps),
      validate: V.num(
        { min: 0 },
        a.s.e.v.invalidDelayValue,
        "INVALID_RETRY_DELAY_VALUE",
      ),
    },
    maxAttempts: {
      prop: "maxAttempts" as keyof (LLM & LLMConfigurableProps),
      validate: V.num(
        { min: 1, integer: true },
        simpleTemplate(a.s.e.v.invalidOption, { Value: "maxAttempts" }),
        "INVALID_MAX_ATTEMPTS",
      ),
    },
    maxFail: {
      prop: "maxFail" as keyof (LLM & LLMConfigurableProps),
      validate: V.num(
        { min: 0, integer: true },
        simpleTemplate(a.s.e.v.invalidOption, { Value: "maxFail" }),
        "INVALID_MAX_FAIL_VALUE",
      ),
    },
    tempValues: {
      prop: "tempValues" as keyof (LLM & LLMConfigurableProps),
      validate: (val: unknown) => {
        if (val === undefined || val === null) {
          return;
        }
        if (!Array.isArray(val)) {
          throw createError(
            simpleTemplate(a.s.e.v.invalidTempValues, {
              Value: String(val),
            }),
            { code: "INVALID_TEMP_VALUES_TYPE" },
          );
        }
        for (const item of val) {
          if (
            typeof item !== "number" ||
            !Number.isFinite(item) ||
            item < 0 ||
            item > 2
          ) {
            throw createError(
              simpleTemplate(a.s.e.v.invalidTempValueRange, {
                Value: String(item),
              }),
              { code: "INVALID_TEMP_VALUE" },
            );
          }
        }
      },
    },
    model: {
      prop: "model" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: V.str(
        {},
        a.s.e.v.invalidModel,
        "INVALID_MODEL",
        "{{ .Model }}",
      ),
    },
    temperature: {
      prop: "temperature" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: V.num(
        { min: 0, max: 2 },
        a.s.e.v.invalidTemperatureRange,
        "INVALID_TEMPERATURE_RANGE",
      ),
    },
    top_p: {
      prop: "top_p" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: V.num(
        { min: 0, max: 1 },
        a.s.e.v.invalidTopPRange,
        "INVALID_TOP_P_RANGE",
      ),
    },
    top_k: {
      prop: "top_k" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: V.num(
        { min: 0, integer: true },
        a.s.e.v.invalidTopKRange,
        "INVALID_TOP_K_RANGE",
      ),
    },
    presence_penalty: {
      prop: "presence_penalty" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: V.num(
        { min: -2, max: 2 },
        a.s.e.v.invalidPenaltyRange,
        "INVALID_PENALTY_RANGE",
      ),
    },
    seed: {
      prop: "seed" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: V.num(
        { min: 1, integer: true },
        a.s.e.v.seedMustBePositiveInteger,
        "INVALID_SEED",
      ),
    },
    hardTimeout: {
      prop: "hardTimeout" as keyof (LLM & LLMConfigurableProps),
      validate: V.num(
        { min: 0.1, max: Math.floor(2_147_483_647 / 60000) },
        simpleTemplate(a.s.e.v.invalidOption, { Value: "hardTimeout" }),
        "INVALID_HARD_TIMEOUT",
      ),
    },
    idleTimeout: {
      prop: "idleTimeout" as keyof (LLM & LLMConfigurableProps),
      validate: V.num(
        { min: 0.001, max: Math.floor(2_147_483_647 / 60000) },
        simpleTemplate(a.s.e.v.invalidOption, { Value: "idleTimeout" }),
        "INVALID_IDLE_TIMEOUT",
      ),
    },
    reasoning_effort: {
      /* official v1/chat/completions */
      prop: "reasoning_effort" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: (val: unknown) => {
        if (typeof val !== "string" || !validReasoningEfforts.has(val)) {
          throw createError(
            simpleTemplate(a.s.e.v.invalidOption, {
              Value: String(val),
            }),
            { code: "INVALID_REASONING_EFFORT" },
          );
        }
      },
    },
    chat_template_kwargs: {
      /* llama */
      prop: "chat_template_kwargs" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: (val: unknown) => {
        if (val === undefined || val === null) {
          return;
        }
        if (typeof val !== "object") {
          throw createError(
            simpleTemplate(a.s.e.v.invalidOption, {
              Value: JSON.stringify(val),
            }),
            { code: "INVALID_KWARGS_TYPE" },
          );
        }
        const kwargs = val as Record<string, unknown>;
        if ("reasoning_effort" in kwargs) {
          /* gptoss */
          const effort = kwargs["reasoning_effort"];
          if (
            typeof effort !== "string" ||
            !validReasoningEfforts.has(effort)
          ) {
            throw createError(
              simpleTemplate(a.s.e.v.invalidOption, {
                Value: JSON.stringify(val),
              }),
              { code: "INVALID_REASONING_EFFORT" },
            );
          }
        }
        if ("enable_thinking" in kwargs) {
          /* Alibaba Cloud */
          if (typeof kwargs["enable_thinking"] !== "boolean") {
            throw createError(
              simpleTemplate(a.s.e.v.invalidOption, {
                Value: JSON.stringify(val),
              }),
              { code: "INVALID_ENABLE_THINKING" },
            );
          }
        }
      },
    },
    reasoning: {
      /* official v1/responses */
      prop: "reasoning" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: (val: unknown) => {
        if (val === undefined || val === null) {
          return;
        }
        if (typeof val !== "object") {
          throw createError(
            simpleTemplate(a.s.e.v.invalidOption, {
              Value: JSON.stringify(val),
            }),
            { code: "INVALID_REASONING_TYPE" },
          );
        }
        if (!("effort" in val)) {
          return;
        }
        const effort = (val as { effort: unknown }).effort;
        if (typeof effort !== "string" || !validReasoningEfforts.has(effort)) {
          throw createError(
            simpleTemplate(a.s.e.v.invalidOption, {
              Value: JSON.stringify(val),
            }),
            { code: "INVALID_REASONING_EFFORT" },
          );
        }
      },
    },
    include: {
      // v1/responses
      prop: "include" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: (val: unknown) => {
        if (val === undefined || val === null) {
          return;
        }
        if (!Array.isArray(val)) {
          throw createError(
            simpleTemplate(a.s.e.v.invalidOption, {
              Value: JSON.stringify(val),
            }),
            { code: "INVALID_INCLUDE_TYPE" },
          );
        }
        for (const item of val) {
          if (typeof item !== "string") {
            throw createError(
              simpleTemplate(a.s.e.v.invalidOption, {
                Value: JSON.stringify(item),
              }),
              { code: "INVALID_INCLUDE_VALUE" },
            );
          }
        }
      },
    },
    enable_thinking: {
      /* Alibaba Cloud */
      prop: "enable_thinking" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: V.bool(
        { strictTrueFalse: true },
        simpleTemplate(a.s.e.v.invalidOption, {
          Value: "enable_thinking",
        }),
        "INVALID_ENABLE_THINKING",
      ),
    },
    response_format: {
      prop: "response_format" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: (val: unknown) => {
        if (val === undefined || val === null) {
          return;
        }
        if (typeof val !== "object" || Array.isArray(val)) {
          throw createError(
            simpleTemplate(a.s.e.v.invalidOption, {
              Value: JSON.stringify(val),
            }),
            { code: "INVALID_RESPONSE_FORMAT_TYPE" },
          );
        }
      },
    },
    grammar: {
      prop: "grammar" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: (val: unknown) => {
        if (val === undefined || val === null) {
          return;
        }
        if (typeof val !== "string") {
          throw createError(
            simpleTemplate(a.s.e.v.invalidOption, {
              Value: JSON.stringify(val),
            }),
            { code: "INVALID_GRAMMAR_TYPE" },
          );
        }
      },
    },
    provider: {
      /* openrouter exclusive */
      prop: "provider" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: (val: unknown) => {
        if (val === undefined || val === null) {
          return;
        }
        if (typeof val !== "object" || Array.isArray(val)) {
          throw createError(
            simpleTemplate(a.s.e.v.invalidOption, {
              Value: "provider",
            }),
            { code: "INVALID_PROVIDER_TYPE" },
          );
        }
      },
    },
    injectORSessionId: {
      /* openrouter exclusive */
      prop: "injectORSessionId" as keyof (LLM & LLMConfigurableProps),
      validate: (val: unknown) => {
        if (val !== undefined && typeof val !== "boolean") {
          throw createError(
            simpleTemplate(a.s.e.v.invalidOption, {
              Value: "injectORSessionId",
            }),
            { code: "INVALID_OPTION" },
          );
        }
      },
    },
    session_id: {
      /* openrouter exclusive */
      prop: "session_id" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: V.str({}, a.s.e.v.invalidSessionId, "INVALID_SESSION_ID"),
    },
    thinking_budget_tokens: {
      /* llama */
      prop: "thinking_budget_tokens" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: V.num(
        { min: -1, integer: true },
        simpleTemplate(a.s.e.v.invalidOption, {
          Value: "thinking_budget_tokens",
        }),
        "INVALID_THINKING_BUDGET",
      ),
    },
    reasoning_control: {
      /* llama */
      prop: "reasoning_control" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: V.bool(
        { strictTrueFalse: true },
        simpleTemplate(a.s.e.v.invalidOption, { Value: "reasoning_control" }),
        "INVALID_REASONING_CONTROL",
      ),
    },
    max_tokens: {
      prop: "max_tokens" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: V.num(
        { min: 1, integer: true },
        a.s.e.v.invalidMaxTokensRange,
        "INVALID_MAX_TOKENS",
      ),
    },
    systemPrompt: {
      prop: "systemPrompt" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: V.str({}, a.s.e.v.invalidPrompt, "INVALID_PROMPT"),
    },
    prependPrompt: {
      prop: "prependPrompt" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: V.str({}, a.s.e.v.invalidPrompt, "INVALID_PROMPT"),
    },
    prefill: {
      prop: "prefill" as keyof (LLM & LLMConfigurableProps),
      getValue: V.getValueFromArray(a.s.e.v.invalidArgArray, "INVALID_ARRAY"),
      validate: V.str({}, a.s.e.v.invalidPrompt, "INVALID_PROMPT"),
    },
    stripEmpty: {
      prop: "stripEmpty" as keyof (LLM & LLMConfigurableProps),
      validate: (val: unknown) => {
        if (val !== undefined && typeof val !== "boolean") {
          throw createError(
            simpleTemplate(a.s.e.v.invalidOption, {
              Value: "stripEmpty",
            }),
            { code: "INVALID_STRIP_EMPTY" },
          );
        }
      },
    },
    markdownBrainRot: {
      prop: "markdownBrainRot" as keyof (LLM & LLMConfigurableProps),
      validate: (val: unknown) => {
        if (val !== undefined && typeof val !== "boolean") {
          throw createError(
            simpleTemplate(a.s.e.v.invalidOption, {
              Value: "markdownBrainRot",
            }),
            { code: "INVALID_MDBR" },
          );
        }
      },
    },
    failureMeansDeath: {
      prop: "failureMeansDeath" as keyof (LLM & LLMConfigurableProps),
      validate: (val: unknown) => {
        if (val !== undefined && typeof val !== "boolean") {
          throw createError(
            simpleTemplate(a.s.e.v.invalidOption, {
              Value: "failureMeansDeath",
            }),
            { code: "INVALID_FAILURE_MEANS_DEATH" },
          );
        }
      },
    },
    forceStream: {
      prop: "forceStream" as keyof (LLM & LLMConfigurableProps),
      validate: (val: unknown) => {
        if (val !== undefined && typeof val !== "boolean") {
          throw createError(
            simpleTemplate(a.s.e.v.invalidOption, {
              Value: "forceStream",
            }),
            { code: "INVALID_FORCE_STREAM" },
          );
        }
      },
    },
    extra_body: {
      prop: "extra_body" as keyof (LLM & LLMConfigurableProps),
      validate: (val: unknown) => {
        if (val === undefined || val === null) {
          return;
        }
        if (typeof val !== "object" || Array.isArray(val)) {
          throw createError(
            simpleTemplate(a.s.e.v.invalidExtraBodyType, {
              Value: JSON.stringify(val),
            }),
            { code: "INVALID_EXTRA_BODY" },
          );
        }
      },
    },
    allowH2: {
      prop: "allowH2" as keyof (LLM & LLMConfigurableProps),
      validate: (val: unknown) => {
        if (val !== undefined && typeof val !== "boolean") {
          throw createError(
            simpleTemplate(a.s.e.v.invalidAllowH2, {
              Value: String(val),
            }),
            { code: "INVALID_ALLOW_H2" },
          );
        }
      },
    },
  };
  return _ARG_CONFIG;
}

export class ReasoningTracker implements IReasoningTracker {
  public encrypted: string | null = null;
  public unencrypted: string | null = null;
  public summary: string | null = null;

  public processOutputItem(
    item: OutputItem,
  ): { text: string; isReasoning: boolean } | null {
    if (item.type === "message") {
      const text = item.content.map((c) => c.text).join("");
      return { text, isReasoning: false };
    } else if (item.type === "reasoning") {
      if (item.encrypted_content) {
        this.encrypted = item.encrypted_content;
      }

      let text = "";
      if (Array.isArray(item.content)) {
        text = item.content.map((part) => part.text).join("");
        if (text) {
          this.unencrypted = (this.unencrypted ?? "") + text;
        }
      }

      if (Array.isArray(item.summary)) {
        const summaryText = item.summary.map((s) => s.text).join("");
        if (summaryText) {
          this.summary = summaryText;
        }
      }

      return { text, isReasoning: true };
    }
    return null;
  }

  public appendUnencrypted(delta: string) {
    this.unencrypted = (this.unencrypted ?? "") + delta;
  }
}

class StreamController {
  private hardTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController;

  public constructor() {
    this.abortController = new AbortController();
  }

  public startHardTimer(reason: string, timeoutMs: number) {
    if (this.hardTimeoutId) clearTimeout(this.hardTimeoutId);
    const abortError = new Error(reason);
    abortError.name = "AbortError";
    this.hardTimeoutId = setTimeout(() => {
      this.abortController.abort(abortError);
    }, timeoutMs);
  }

  public resetIdleTimer(reason: string, timeoutMs: number) {
    if (this.idleTimeoutId) clearTimeout(this.idleTimeoutId);
    const abortError = new Error(reason);
    abortError.name = "AbortError";
    this.idleTimeoutId = setTimeout(() => {
      this.abortController.abort(abortError);
    }, timeoutMs);
  }

  public clearTimers() {
    if (this.hardTimeoutId) {
      clearTimeout(this.hardTimeoutId);
      this.hardTimeoutId = null;
    }
    if (this.idleTimeoutId) {
      clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
  }

  public abort(reason?: unknown) {
    this.abortController.abort(reason);
  }

  public get signal() {
    return this.abortController.signal;
  }
}

interface MakeRequestOptions {
  overrideUrl?: string;
  method?: string;
  isStreaming?: boolean;
  extraHeaders?: Record<string, string>;
  allowH2?: boolean;
  strategy?: BackendStrategy;
}

export class LLM implements CancellableJob {
  public static readonly TerminationState = Object.freeze({
    NONE: "none",
    REQUESTED: "requested",
    FORCEFUL: "forceful",
  } as const);

  protected url: string = "http://localhost:8080/v1/chat/completions";
  protected endpoint?: Endpoints;
  private readonly apiKey: string = "";
  protected readonly rpm: number = 20;
  protected readonly retryDelay: number = 5000;
  protected readonly batchSize: number = 1;
  protected readonly parallel: number = 1;
  protected readonly chunkSize: number = 1;
  protected readonly maxAttempts: number = 2;
  protected readonly maxFail?: number;
  protected readonly tempValues?: number[];
  protected readonly model?: StringParam;
  protected readonly temperature?: NumberParam;
  protected readonly top_p?: NumberParam;
  protected readonly top_k?: NumberParam;
  protected readonly presence_penalty?: NumberParam;
  protected readonly seed?: NumberParam;
  protected readonly hardTimeout?: number;
  protected readonly idleTimeout?: number;
  protected readonly reasoning_effort?: ConfigParam<ReasoningEffortValue>; // v1/chat/completions
  protected readonly chat_template_kwargs?: ConfigParam<{
    reasoning_effort: ReasoningEffortValue;
  }>; // llama
  protected readonly reasoning?: ConfigParam<{ effort: ReasoningEffortValue }>; // v1/responses
  protected readonly thinking?: ConfigParam<{ type: "enabled" | "disabled" }>; // DeepSeek
  protected readonly include?: ConfigParam<string[]>; // v1/responses
  protected readonly enable_thinking?: ConfigParam<boolean>; // Alibaba Cloud
  protected readonly response_format?: ConfigParam<ResponseFormat>;
  protected readonly grammar?: ConfigParam<string>; // llama
  protected readonly provider?: ConfigParam<OpenRouterProviderConfig>; // openrouter exclusive
  protected readonly injectORSessionId?: boolean; // openrouter exclusive
  protected session_id?: StringParam; // openrouter exclusive
  protected readonly thinking_budget_tokens?: NumberParam; // llama
  protected readonly reasoning_control?: ConfigParam<boolean>; // llama
  protected readonly max_tokens?: NumberParam;
  protected readonly systemPrompt?: PromptParam;
  protected readonly prependPrompt?: PromptParam;
  protected readonly prefill?: PromptParam;
  protected readonly images?: string[];
  protected readonly audio?: { data: string; format: string };
  private readonly hardTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  protected readonly appState: AppState;
  protected readonly stripEmpty?: boolean;
  protected readonly markdownBrainRot?: boolean;
  protected readonly failureMeansDeath?: boolean;
  protected readonly forceStream?: boolean;
  protected readonly networkContext: INetworkContext;
  protected readonly extra_body?: Record<string, unknown>;
  protected readonly allowH2?: boolean;

  protected controller: AbortController;
  protected readonly strategy: BackendStrategy;

  public completion: (
    messages: Message[],
    options?: CompletionOptions,
  ) => Promise<string>;

  public constructor(
    options: LLMConfigurableProps,
    dependencies?: LLMDependencies,
  ) {
    this.appState = x.a;
    this.controller = new AbortController();

    this.networkContext = options.networkContext || new NetworkContext();

    const argConfig: ConfigMap<
      LLM & LLMConfigurableProps,
      LLMConfigurableProps
    > = getArgConfig();

    const hardTimeoutValidator: ((val: unknown) => void) | undefined =
      argConfig.hardTimeout?.validate;

    if (hardTimeoutValidator) {
      hardTimeoutValidator(appConfig.HARD_TIMEOUT);
    }

    const idleTimeoutValidator: ((val: unknown) => void) | undefined =
      argConfig.idleTimeout?.validate;

    if (idleTimeoutValidator) {
      idleTimeoutValidator(appConfig.IDLE_TIMEOUT);
    }

    const resolvedState = resolveConfig<
      LLM & LLMConfigurableProps,
      LLMConfigurableProps
    >(this as unknown as LLM & LLMConfigurableProps, options, argConfig);

    Object.assign(this, resolvedState);

    if (this.systemPrompt && this.systemPrompt[0]) {
      const sysText = stripGarbageNewLines(this.systemPrompt[1], {
        stripEmpty: false,
        markdownBrainRot: false,
      });
      this.systemPrompt = [
        this.systemPrompt[0],
        sysText,
        this.systemPrompt[2],
      ] as unknown as PromptParam;
    }

    if (this.prependPrompt && this.prependPrompt[0]) {
      const prepText = stripGarbageNewLines(this.prependPrompt[1], {
        stripEmpty: false,
        markdownBrainRot: false,
      });
      this.prependPrompt = [
        this.prependPrompt[0],
        prepText,
        this.prependPrompt[2],
      ] as unknown as PromptParam;
    }

    if (this.prefill && this.prefill[0]) {
      const prefillText = stripGarbageNewLines(this.prefill[1], {
        stripEmpty: false,
        markdownBrainRot: false,
      });
      this.prefill = [this.prefill[0], prefillText];
    }

    if (!this.endpoint) {
      throw createError(this.appState.s.e.lllm.endpointRequired, {
        code: "ENDPOINT_REQUIRED",
      });
    }

    if (dependencies?.strategy) {
      this.strategy = dependencies.strategy;
    } else {
      this.strategy = resolveStrategy(this.endpoint);
    }

    let hTimeoutMs = appConfig.HARD_TIMEOUT * 60000;
    if (this.hardTimeout !== undefined) {
      hTimeoutMs = this.hardTimeout * 60000;
    }
    this.hardTimeoutMs = hTimeoutMs;

    let iTimeoutMs = appConfig.IDLE_TIMEOUT * 60000;
    if (this.idleTimeout !== undefined) {
      iTimeoutMs = this.idleTimeout * 60000;
    }
    this.idleTimeoutMs = iTimeoutMs;

    this.completion = dependencies?.llmcall
      ? dependencies.llmcall.bind(this)
      : this.infer.bind(this);
  }

  protected finalizePayload(
    payload: Record<string, unknown>,
    overrides?: Partial<LLMConfigurableProps>,
  ): Record<string, unknown> {
    const extra = overrides?.extra_body ?? this.extra_body;
    if (extra && typeof extra === "object") {
      Object.assign(payload, extra);
    }
    return payload;
  }

  protected getStrategyContext(
    tracker: IReasoningTracker,
    overrides?: Partial<LLMConfigurableProps>,
  ): StrategyContext {
    const commonParams: Record<string, unknown> = {};

    for (const k of this.strategy.supportedParams) {
      const overrideVal = overrides?.[k as keyof LLMConfigurableProps];
      if (overrideVal !== undefined) {
        commonParams[k] = Array.isArray(overrideVal)
          ? overrideVal[1]
          : overrideVal;
      } else {
        const prop = this[k as keyof this];
        if (Array.isArray(prop) && prop[0]) {
          commonParams[k] = prop[1];
        }
      }
    }

    return {
      commonParams,
      prefill: this.prefill,
      reasoningTracker: tracker,
      previousReasoning: overrides?.previousReasoning,
    };
  }

  public cancel(reason?: string, code?: string): void {
    if (!this.controller.signal.aborted) {
      const message = reason ?? this.appState.s.e.lcli.processingAborted;

      const abortErr = createError(message, {
        code: code ?? "ABORT_ERR",
        immediateExitCode: false,
      });

      this.controller.abort(abortErr);

      this.networkContext.destroy();
    }
  }

  private async makeRequest(
    payload:
      | Record<string, unknown>
      | ChatCompletionsPayload
      | ResponsesPayload
      | CompletionsPayload,
    signal: AbortSignal,
    options: MakeRequestOptions = {},
  ): Promise<Response> {
    const {
      overrideUrl,
      method = "POST",
      isStreaming = false,
      extraHeaders,
      allowH2,
      strategy,
    } = options;

    const activeStrategy = strategy ?? this.strategy;

    let headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": `${this.appState.P_NAME}/${this.appState.P_VERSION}`,
    };

    if (activeStrategy.getHeaders) {
      headers = {
        ...headers,
        ...activeStrategy.getHeaders({ apiKey: this.apiKey }),
      };
    } else {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    if (extraHeaders) {
      headers = { ...headers, ...extraHeaders };
    }

    const targetUrl = overrideUrl ?? this.url;
    let resolvedUrl = targetUrl;

    if (activeStrategy.buildRequestUrl) {
      let activeModel = "";
      if (payload && typeof payload === "object") {
        const modelInPayload = (payload as Record<string, unknown>)["model"];
        if (typeof modelInPayload === "string") {
          activeModel = modelInPayload;
        }
      }
      if (!activeModel) {
        activeModel =
          Array.isArray(this.model) && this.model[0] ? this.model[1] : "";
      }

      resolvedUrl = activeStrategy.buildRequestUrl(
        targetUrl,
        activeModel,
        isStreaming,
      );
    }

    try {
      const response = await llmFetch(resolvedUrl, {
        method,
        headers,
        body: JSON.stringify(payload),
        signal,
        networkContext: this.networkContext,
        allowH2: allowH2 ?? this.allowH2,
        disableTransparentRetry: !isStreaming,
      });

      if (!response.ok) {
        const errorBody = await response.text();

        if (process.env["TELOCITY_ERRLOG"]) {
          const debugTemplate = this.appState.s.m.lllm.apiDebugTemplate;
          errlog(
            { level: "error" },
            simpleTemplate(debugTemplate, {
              Status: response.status.toString(),
              Body: errorBody,
            }),
          );
        }

        let errorMessage = this.appState.s.e.lllm.unknownOpenAIError;
        try {
          const errorJson = JSON.parse(errorBody) as {
            error?: { message?: string };
          };
          errorMessage = errorJson?.error?.message || errorBody;
        } catch {
          errorMessage = errorBody;
        }

        // Extract Retry-After if provided in the response headers
        let retryAfterSeconds: number | undefined;
        const rawHeaders = (
          response as unknown as { headers?: IMiniResponseHeaders }
        ).headers;
        if (rawHeaders && typeof rawHeaders.get === "function") {
          const retryAfterHeader = rawHeaders.get("Retry-After");
          if (retryAfterHeader) {
            const parsed = parseInt(retryAfterHeader, 10);
            if (!isNaN(parsed)) {
              retryAfterSeconds = parsed;
            }
          }
        }

        const apiError = createError(
          simpleTemplate(this.appState.s.e.lllm.openaiApiError, {
            Status: response.status.toString(),
            Message: errorMessage,
          }),
          { code: `API_ERROR_${response.status}` },
        ) as LLMAPIError;

        apiError.status = response.status;
        if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
          apiError.retryAfter = retryAfterSeconds;
        }

        throw apiError;
      }

      return response;
    } catch (err) {
      if (signal.aborted) {
        const reason: unknown = signal.reason;
        if (isNodeError(reason) && reason.code === "ABORT_ERR") {
          throw reason;
        }

        const message =
          reason instanceof Error ? reason.message : String(reason);

        throw createError(
          simpleTemplate(this.appState.s.e.lllm.networkErrorOpenAI, {
            URL: resolvedUrl,
          }) +
            ": " +
            message,
          { code: "TIMEOUT_ERROR", cause: err },
        );
      }

      if (
        err instanceof Error &&
        (err.name === "AbortError" || err.name === "TypeError")
      ) {
        let message = simpleTemplate(
          this.appState.s.e.lllm.networkErrorOpenAI,
          {
            URL: resolvedUrl,
          },
        );

        const cause = err.cause as { code?: string } | undefined;
        if (cause?.code) {
          message +=
            " " +
            simpleTemplate(this.appState.s.e.lllm.networkErrorReason, {
              Code: cause.code,
            });
        } else {
          message += ` (${err.message})`;
        }
        throw createError(message, { cause: err });
      }

      throw err;
    }
  }

  private async *executeStreamRequest(
    payload:
      | Record<string, unknown>
      | ChatCompletionsPayload
      | ResponsesPayload
      | CompletionsPayload,
    ctx: StrategyContext,
    options: {
      signal?: AbortSignal;
      url?: string;
      strategy?: BackendStrategy;
      method?: string;
      hardTimeout?: number;
      idleTimeout?: number;
      headers?: Record<string, string>;
      allowH2?: boolean;
    } = {},
  ): AsyncGenerator<
    {
      text: string;
      kind:
        | "delta"
        | "output"
        | "conditional"
        | "reasoning"
        | "reasoning_output";
    },
    void,
    unknown
  > {
    const streamCtrl = new StreamController();
    const strategy = options.strategy ?? this.strategy;

    const onAbort = () => {
      const reason = options.signal?.aborted
        ? options.signal.reason
        : this.controller.signal.reason;
      streamCtrl.abort(reason);
    };

    if (options.signal) {
      if (options.signal.aborted) {
        streamCtrl.abort(options.signal.reason);
      } else {
        options.signal.addEventListener("abort", onAbort);
      }
    }

    if (this.controller.signal.aborted) {
      streamCtrl.abort(this.controller.signal.reason);
    } else {
      this.controller.signal.addEventListener("abort", onAbort);
    }

    const hardTimeoutStr = this.appState.s.e.lllm.hardTimeOut;
    const idleTimeoutStr = this.appState.s.e.lllm.idleTimeOut;
    const tExceededStr = this.appState.s.e.lllm.tExceeded;

    const hardTimeoutMs =
      options.hardTimeout !== undefined
        ? options.hardTimeout * 60000
        : this.hardTimeoutMs;
    const idleTimeoutMs =
      options.idleTimeout !== undefined
        ? options.idleTimeout * 60000
        : this.idleTimeoutMs;

    streamCtrl.startHardTimer(hardTimeoutStr, hardTimeoutMs);
    streamCtrl.resetIdleTimer(idleTimeoutStr, idleTimeoutMs);

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let response: Response | null;
    let doneSignalReceived = false;
    let streamEOF = false;

    try {
      try {
        response = await this.makeRequest(payload, streamCtrl.signal, {
          overrideUrl: options.url,
          method: options.method,
          isStreaming: true,
          extraHeaders: options.headers,
          allowH2: options.allowH2,
          strategy,
        });
      } catch (err) {
        streamCtrl.clearTimers();
        throw err;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      if (!response.body) {
        throw createError(this.appState.s.e.lllm.responseNull, {
          code: "NULL_RESPONSE_BODY",
        });
      }
      reader =
        response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            streamEOF = true;
          }

          streamCtrl.resetIdleTimer(tExceededStr, idleTimeoutMs);

          if (value) {
            buffer += decoder.decode(value, { stream: true });
          }

          if (done) {
            buffer += decoder.decode();
          }

          if (buffer.includes("\r")) {
            buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          }

          if (strategy.processStreamBuffer) {
            try {
              const res = strategy.processStreamBuffer(buffer, ctx);
              buffer = res.remainingBuffer;
              if (res.done) {
                doneSignalReceived = true;
              }
              for (const chunk of res.chunks) {
                if (chunk.kind === "delta" || chunk.kind === "reasoning") {
                  ctx.emittedAnyDelta = true;
                }
                yield chunk;
              }
            } catch (err) {
              if (
                isNodeError(err) &&
                (err.code === "MAX_TOKENS_REACHED" ||
                  err.code === "CONTENT_FILTER_TRIGGERED")
              ) {
                throw err;
              }
              const errMsg = err instanceof Error ? err.message : String(err);
              throw createError(errMsg, { code: "LLM_API_ERROR" });
            }
          }

          if (doneSignalReceived) break;
          if (done) {
            break;
          }
        }

        if (!doneSignalReceived) {
          if (strategy.requiresDoneSignal === false) {
            doneSignalReceived = true;
          }
        }

        if (!doneSignalReceived) {
          if (strategy.recoverTrailingBuffer) {
            try {
              const recovery = strategy.recoverTrailingBuffer(buffer, ctx);
              if (recovery) {
                for (const chunk of recovery.chunks) {
                  yield chunk as StreamChunkItem;
                }
                if (recovery.done) {
                  doneSignalReceived = true;
                }
              }
            } catch (err) {
              if (
                isNodeError(err) &&
                (err.code === "LLM_API_ERROR" ||
                  err.code === "MAX_TOKENS_REACHED" ||
                  err.code === "CONTENT_FILTER_TRIGGERED")
              ) {
                throw err;
              }
            }
          }

          if (!doneSignalReceived) {
            const trimmedBuf = buffer.trim();
            if (trimmedBuf) {
              const lowerBuffer = trimmedBuf.toLowerCase();
              if (
                lowerBuffer.includes("error") ||
                lowerBuffer.includes("502 bad gateway") ||
                lowerBuffer.includes("503 service") ||
                lowerBuffer.includes("500 internal") ||
                lowerBuffer.includes("504 gateway")
              ) {
                throw createError(
                  simpleTemplate(this.appState.s.e.lllm.streamInterrupted, {
                    ErrorContent: trimmedBuf.substring(0, 200),
                  }),
                  { code: "LLM_API_ERROR" },
                );
              }
            }

            throw createError(this.appState.s.e.lllm.streamEndedPrematurely, {
              code: "LLM_API_ERROR",
            });
          }
        }
      } finally {
        try {
          if (reader) {
            if (!streamEOF) {
              await reader.cancel();
            } else {
              reader.releaseLock();
            }
          }
        } catch {
          /* ignore */
        }
        streamCtrl.clearTimers();
      }
    } catch (err) {
      try {
        if (reader) await reader.cancel(err);
      } catch {
        /* ignore */
      }
      streamCtrl.clearTimers();
      throw err;
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      this.controller.signal.removeEventListener("abort", onAbort);
    }
  }

  private async *inferStream(
    messages: Message[],
    options: CompletionOptions & { _ctx?: StrategyContext } = {},
  ): AsyncGenerator<
    {
      text: string;
      kind:
        | "delta"
        | "output"
        | "conditional"
        | "reasoning"
        | "reasoning_output";
    },
    void,
    unknown
  > {
    const tracker = options.tracker ?? new ReasoningTracker();
    const strategy = options.endpointOptions?.strategy ?? this.strategy;
    // Utilize the pre-initialized StrategyContext if passed down
    const ctx =
      options._ctx ?? this.getStrategyContext(tracker, options.overrides);
    let payload =
      options.endpointOptions?.payload ??
      strategy.buildPayload(messages, ctx, true);

    payload = this.finalizePayload(
      payload as Record<string, unknown>,
      options.overrides,
    );

    yield* this.executeStreamRequest(payload, ctx, {
      signal: options.signal,
      url: options.endpointOptions?.url,
      strategy: options.endpointOptions?.strategy,
      method: options.endpointOptions?.method,
      hardTimeout: options.endpointOptions?.hardTimeout,
      idleTimeout: options.endpointOptions?.idleTimeout,
      headers: options.endpointOptions?.headers,
      allowH2: options.overrides?.allowH2 ?? this.allowH2,
    });
  }

  private async infer(
    messages: Message[],
    options: CompletionOptions = {},
  ): Promise<string> {
    const { verbose, overrides, signal, tracker, endpointOptions } = options;
    const isStreaming = endpointOptions?.isStreaming ?? true;
    const activeStripEmpty = overrides?.stripEmpty ?? this.stripEmpty;
    const activeMarkdownBrainRot =
      overrides?.markdownBrainRot ?? this.markdownBrainRot;
    const outMarkdownBrainRot =
      activeStripEmpty && activeMarkdownBrainRot
        ? false
        : activeMarkdownBrainRot;

    const wrapper =
      verbose === true
        ? new TerminalStreamer(
            this.appState.TERMINAL_WIDTH,
            async (c) => {
              await new Promise<void>((resolve) => {
                if (process.stdout.write(c)) resolve();
                else process.stdout.once("drain", resolve);
              });
            },
            !this.appState.NO_MARKDOWN,
            {
              stripEmpty: activeStripEmpty,
              markdownBrainRot: outMarkdownBrainRot,
              streaming: isStreaming,
            },
          )
        : null;

    const renderer = new OutputRenderer(verbose, wrapper);

    if (isStreaming) {
      const chunks: string[] = [];
      const activeTracker = tracker ?? new ReasoningTracker();
      const strategy = endpointOptions?.strategy ?? this.strategy;
      const ctx = this.getStrategyContext(activeTracker, overrides);

      // Create accumulator instance for this specific execution stream
      const accumulator = strategy.createAccumulator
        ? strategy.createAccumulator(messages, ctx)
        : null;
      ctx.accumulator = accumulator;

      const streamOptions: CompletionOptions & { _ctx?: StrategyContext } = {
        ...options,
        tracker: activeTracker,
        _ctx: ctx,
      };

      for await (const item of this.inferStream(messages, streamOptions)) {
        await renderer.processItem(item);
        if (item.kind !== "reasoning" && item.kind !== "reasoning_output") {
          chunks.push(item.text);
        }
      }

      await renderer.flush();
      const finalContent = chunks.join("");

      // Compile, build, and emit the final response block with reconstructed metadata
      if (accumulator && strategy.finalizeAccumulator) {
        const finalBody = strategy.finalizeAccumulator(
          accumulator,
          finalContent,
          ctx,
        );
        if (endpointOptions?.onRawResponse) {
          endpointOptions.onRawResponse(finalBody);
        }
      }

      // Format output at final source step
      return stripGarbageNewLines(finalContent, {
        stripEmpty: activeStripEmpty,
        markdownBrainRot: outMarkdownBrainRot,
      });
    } else {
      // Non-streaming native execution path
      const activeTracker = tracker ?? new ReasoningTracker();
      const strategy = endpointOptions?.strategy ?? this.strategy;
      const ctx = this.getStrategyContext(activeTracker, overrides);
      let payload =
        endpointOptions?.payload ?? strategy.buildPayload(messages, ctx, false);

      payload = this.finalizePayload(
        payload as Record<string, unknown>,
        overrides,
      );

      if (payload && typeof payload === "object") {
        (payload as Record<string, unknown>)["stream"] = false;
      }

      const url = endpointOptions?.url ?? this.url;
      const method = endpointOptions?.method ?? "POST";

      const streamCtrl = new StreamController();

      const onAbort = () => {
        const reason = signal?.aborted
          ? signal.reason
          : this.controller.signal.reason;
        streamCtrl.abort(reason);
      };

      if (signal) {
        if (signal.aborted) streamCtrl.abort(signal.reason);
        else signal.addEventListener("abort", onAbort);
      }
      if (this.controller.signal.aborted) {
        streamCtrl.abort(this.controller.signal.reason);
      } else {
        this.controller.signal.addEventListener("abort", onAbort);
      }

      const hardTimeoutMs =
        endpointOptions?.hardTimeout !== undefined
          ? endpointOptions.hardTimeout * 60000
          : this.hardTimeoutMs;

      streamCtrl.startHardTimer(
        this.appState.s.e.lllm.hardTimeOut,
        hardTimeoutMs,
      );

      try {
        const response = await this.makeRequest(
          payload as Record<string, unknown>,
          streamCtrl.signal,
          {
            overrideUrl: url,
            method,
            isStreaming: false,
            extraHeaders: endpointOptions?.headers,
            allowH2: overrides?.allowH2 ?? this.allowH2,
            strategy,
          },
        );

        const json = (await response.json()) as ParsedStreamChunk;

        if (endpointOptions?.onRawResponse) {
          endpointOptions.onRawResponse(json);
        }

        if (strategy.checkPayloadError) {
          try {
            strategy.checkPayloadError(json);
          } catch (err) {
            if (
              isNodeError(err) &&
              (err.code === "MAX_TOKENS_REACHED" ||
                err.code === "CONTENT_FILTER_TRIGGERED")
            ) {
              throw err;
            }
            const errMsg = err instanceof Error ? err.message : String(err);
            throw createError(
              simpleTemplate(this.appState.s.e.lllm.openaiApiError, {
                Status: response.status.toString(),
                Message: errMsg,
              }),
              { code: "LLM_API_ERROR" },
            );
          }
        }

        const items = strategy.parseChunk(json, ctx);

        let result = "";

        for (const item of items) {
          await renderer.processItem(item);
          if (
            item.kind === "delta" ||
            item.kind === "output" ||
            item.kind === "conditional"
          ) {
            result += item.text;
          }
        }

        await renderer.flush();

        // Format output at final source step
        return stripGarbageNewLines(result, {
          stripEmpty: activeStripEmpty,
          markdownBrainRot: outMarkdownBrainRot,
        });
      } finally {
        streamCtrl.clearTimers();
        if (signal) signal.removeEventListener("abort", onAbort);
        this.controller.signal.removeEventListener("abort", onAbort);
      }
    }
  }

  public newPrompt(chunk: string): Message[] {
    const messages: Message[] = [];

    if (this.systemPrompt?.[0]) {
      const systemMessage: Message = {
        role: this.systemPrompt[2] as "system",
        content: this.systemPrompt[1],
      };
      messages.push(systemMessage);
    }

    const rawPrepPrompt = this.prependPrompt?.[0] ? this.prependPrompt[1] : "";
    let userText: string;

    // Strip leading and trailing newlines from the chunk, preserving horizontal indents
    const cleanedChunk = chunk.replace(/^[\r\n]+|[\r\n]+$/g, "");

    if (rawPrepPrompt.includes("{{ .TextToInject }}")) {
      userText = simpleTemplate(rawPrepPrompt, { TextToInject: cleanedChunk });
    } else {
      if (rawPrepPrompt && cleanedChunk) {
        // Guarantee exactly a double-newline separation with no formatting bleed-through
        userText = rawPrepPrompt.trimEnd() + "\n\n" + cleanedChunk;
      } else {
        userText = rawPrepPrompt + cleanedChunk;
      }
    }

    const userRole = this.prependPrompt?.[2] ?? "user";

    let userMessage: Message = {
      role: userRole as "user" | "assistant",
      content: userText,
    };

    userMessage = this.injectMedia(userMessage);

    messages.push(userMessage);

    return messages;
  }

  private injectMedia(
    message: Message,
    images?: string[],
    audio?: { data: string; format: string },
  ): Message {
    const imagesToInject = images ?? this.images;
    const audioToInject = audio ?? this.audio;

    if (!imagesToInject?.length && !audioToInject) {
      return message;
    }

    if (imagesToInject?.length && audioToInject) {
      throw createError(this.appState.s.e.v.mutuallyExclusiveMedia, {
        code: "MUTUALLY_EXCLUSIVE_MEDIA",
      });
    }

    if (
      audioToInject &&
      (this.strategy instanceof ResponsesStrategy ||
        this.strategy instanceof CompletionsStrategy)
    ) {
      throw createError(this.appState.s.e.lllm.audioNotSupportedModality, {
        code: "AUDIO_NOT_SUPPORTED",
      });
    }

    if (
      imagesToInject?.length &&
      this.strategy instanceof CompletionsStrategy
    ) {
      throw createError(this.appState.s.e.lllm.mediaNotSupportedCompletions, {
        code: "MEDIA_NOT_SUPPORTED",
      });
    }

    if (typeof message.content !== "string") {
      return message;
    }

    const contentParts: (
      | TextContentPart
      | ImageContentPart
      | InputAudioContentPart
    )[] = [];

    if (imagesToInject) {
      for (const imageUrl of imagesToInject) {
        contentParts.push({
          type: "image_url",
          image_url: { url: imageUrl },
        });
      }
      contentParts.push({ type: "text", text: message.content });
    } else if (audioToInject) {
      contentParts.push({ type: "text", text: message.content });
      contentParts.push({
        type: "input_audio",
        input_audio: {
          data: audioToInject.data,
          format: audioToInject.format,
        },
      });
    }

    return {
      ...message,
      content: contentParts,
    };
  }

  public toString(): string {
    return JSON.stringify(this, (key: string, value: unknown) => {
      if (
        key === "chunks" ||
        key === "text" ||
        key === "processedBatch" ||
        key === "appState" ||
        key === "controller" ||
        key === "strategy" ||
        key === "networkContext"
      ) {
        return undefined;
      }
      if (key === "apiKey" && value) {
        return this.appState.s.m.lcli.redacted;
      }

      if (key === "images" && Array.isArray(value)) {
        return value.map((uri) =>
          typeof uri === "string"
            ? `[Base64 Image Data - Length: ${uri.length} chars]`
            : uri,
        );
      }

      if (key === "audio" && value && typeof value === "object") {
        const aud = value as { data?: string; format?: string };
        return {
          format: aud.format,
          data:
            typeof aud.data === "string"
              ? `[Base64 Audio Data - Length: ${aud.data.length} chars]`
              : undefined,
        };
      }

      return value;
    });
  }
}

export class OutputRenderer {
  private wasReasoning = false;
  private wrapper: TerminalStreamer | null;
  private verboseCallback?:
    | boolean
    | ((chunk: string, isReasoning?: boolean) => Promise<void>);
  private showReasoning: boolean;

  public constructor(
    verbose?:
      | boolean
      | ((chunk: string, isReasoning?: boolean) => Promise<void>),
    wrapper?: TerminalStreamer | null,
  ) {
    this.verboseCallback = verbose;
    this.wrapper = wrapper ?? null;
    this.showReasoning = !!process.env["REASONING_CONTENT"];
  }

  public async processItem(item: { text: string; kind: string }) {
    if (item.kind === "reasoning" || item.kind === "reasoning_output") {
      this.wasReasoning = true;
      if (typeof this.verboseCallback === "function") {
        await this.verboseCallback(item.text, true);
      } else if (this.wrapper && this.showReasoning) {
        await this.wrapper.process(item.text);
      }
    } else if (
      item.kind === "delta" ||
      item.kind === "output" ||
      item.kind === "conditional"
    ) {
      if (this.wasReasoning) {
        if (typeof this.verboseCallback === "function") {
          await this.verboseCallback("\n\n", true);
        } else if (this.wrapper && this.showReasoning) {
          await this.wrapper.process("\n\n");
        }
        this.wasReasoning = false;
      }

      if (typeof this.verboseCallback === "function") {
        await this.verboseCallback(item.text, false);
      } else if (this.wrapper) {
        await this.wrapper.process(item.text);
      }
    }
  }

  public async flush() {
    if (this.wrapper) {
      await this.wrapper.flush();
    }
  }
}
