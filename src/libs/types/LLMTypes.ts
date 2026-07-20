import type { INetworkContext } from "./types.ts";

export interface GenerateOptions {
  localJSONL?: boolean;
  regex?: string;
}

export interface LLMAPIError extends Error {
  code?: string;
  status?: number;
  retryAfter?: number;
}

export type OutputTextPart = {
  type: "output_text";
  text: string;
};

export type ReasoningTextPart = {
  type: "reasoning_text";
  text: string;
};

export type OutputContentItem = OutputTextPart | ReasoningTextPart;

export type MessageOutputItem = {
  type: "message";
  id?: string;
  role?: "assistant";
  content: OutputTextPart[];
};

export type ReasoningOutputItem = {
  type: "reasoning";
  id?: string;
  summary?: { type: "summary_text"; text: string }[];
  encrypted_content?: string | null;
  content?: ReasoningTextPart[];
};

export type FunctionCallOutputItem = {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
};

export type FunctionCallOutputResultItem = {
  type: "function_call_output";
  call_id: string;
  output: string;
};

export type OutputItem =
  | MessageOutputItem
  | ReasoningOutputItem
  | FunctionCallOutputItem
  | FunctionCallOutputResultItem;

export type ParsedStreamChunk = {
  type?: string;
  delta?: string;
  text?: string;
  error?: { message?: string; type?: string; code?: string | number };
  response?: {
    id?: string;
    status?: string;
    error?: { message?: string; code?: string | number };
    output?: OutputItem[];
    incomplete_details?: {
      reason?: string;
    };
  };
  output?: OutputItem[];
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    delta?: {
      content?: string;
      reasoning_content?: string; // llama and deepseek APIs
      reasoning?: string; // openrouter
    };
    message?: {
      content?: string;
      reasoning_content?: string; // llama and deepseek APIs
      reasoning?: string; // openrouter
    };
    text?: string;
  }>;
  item?: OutputItem;
};

export type RawStreamChunk = {
  // ChatCompletions
  choices?: {
    delta?: {
      content?: string;
      reasoning_content?: string; // llama and deepseek APIs
    };
    message?: {
      content?: string;
      reasoning_content?: string; // llama and deepseek APIs
    };
  }[];
  // Responses API
  output?: {
    type?: "message" | "reasoning";
    content?: { type: "output_text"; text: string }[];
  }[];
};

export type ImageContentPart = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
};

export type InputAudioContentPart = {
  type: "input_audio";
  input_audio: {
    data: string;
    format: string;
  };
};

export type TextContentPart = {
  type: "text";
  text: string;
};

export type MessageContent =
  | string
  | (TextContentPart | ImageContentPart | InputAudioContentPart)[];

export interface Message {
  role: string;
  content: MessageContent;
  reasoning_content?: string;
  encrypted_reasoning?: string;
}

export type ResponsesInputContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | {
      type: "input_image";
      image_url?: string;
      image_base64?: string;
    };

export interface ResponsesMessage {
  type: "message";
  role: string;
  content: ResponsesInputContentPart[];
}

export type StreamChunkKind =
  | "delta"
  | "output"
  | "conditional"
  | "reasoning"
  | "reasoning_output";

export interface StreamChunkItem {
  text: string;
  kind: StreamChunkKind;
}

export const VALID_REASONING_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffortValue =
  (typeof VALID_REASONING_EFFORT_VALUES)[number];

export interface JsonSchemaResponseFormat {
  type: "json_schema";
  json_schema: {
    name: string;
    description?: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}
export type ResponseFormat =
  | JsonSchemaResponseFormat
  | { type: "text" | "json_object" }
  | Record<string, unknown>;

export type ResponsesPayload = {
  input: ResponsesMessage[] | string;
  instructions?: string;
  model?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  seed?: number;
  tools?: unknown[];
  store?: boolean;
  include?: string[];
  reasoning?: {
    effort?: ReasoningEffortValue;
    summary?: "auto" | boolean;
  }; // official v1/responses API
  response_format?: ResponseFormat;
  grammar?: string; // llama
  chat_template_kwargs?: {
    reasoning_effort?: ReasoningEffortValue; // gptoss
    enable_thinking?: boolean /* Alibaba Cloud */;
    [key: string]: unknown;
  }; // llama
  provider?: OpenRouterProviderConfig; // openrouter exclusive
  session_id?: string; // openrouter exclusive
  max_tokens?: number;
};

export interface OpenRouterProviderConfig {
  order?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "allow" | "deny";
  zdr?: boolean;
  enforce_distillable_text?: boolean;
  only?: string[];
  ignore?: string[];
  quantizations?: string[];
  sort?: string | { by: string; partition?: string };
  preferred_min_throughput?:
    | number
    | { p50?: number; p75?: number; p90?: number; p99?: number };
  preferred_max_latency?:
    | number
    | { p50?: number; p75?: number; p90?: number; p99?: number };
  max_price?: {
    prompt?: number;
    completion?: number;
    request?: number;
    image?: number;
  };
}

export type ChatCompletionsPayload = {
  messages: Message[];
  stream: boolean;
  model?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  presence_penalty?: number;
  seed?: number;
  reasoning_effort?: ReasoningEffortValue; // official v1/chat/completions
  reasoning?: { effort?: ReasoningEffortValue; enabled?: boolean };
  thinking?: { type: "enabled" | "disabled" }; // DeepSeek
  chat_template_kwargs?: {
    reasoning_effort?: ReasoningEffortValue; // gptoss
    enable_thinking?: boolean /* Alibaba Cloud */;
    [key: string]: unknown;
  }; // llama
  enable_thinking?: boolean; // Alibaba Cloud
  response_format?: ResponseFormat;
  grammar?: string; // llama
  provider?: OpenRouterProviderConfig; // openrouter exclusive
  session_id?: string; // openrouter exclusive
  thinking_budget_tokens?: number; // llama
  reasoning_control?: boolean; // llama
  max_tokens?: number;
};

export type CompletionsPayload = {
  prompt: string;
  stream: boolean;
  model?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  presence_penalty?: number;
  seed?: number;
  reasoning_effort?: ReasoningEffortValue;
  chat_template_kwargs?: {
    reasoning_effort?: ReasoningEffortValue; // gptoss
    enable_thinking?: boolean /* Alibaba Cloud */;
    [key: string]: unknown;
  };
  grammar?: string; // llama
  max_tokens?: number;
};

export type ConfigParam<T> = readonly [enabled: boolean, value: T];

export type PromptParam =
  | ConfigParam<string>
  | readonly [enabled: boolean, value: string, role: string];

export type StringParam = ConfigParam<string>;
export type NumberParam = ConfigParam<number>;

export type Endpoints =
  | "chatcompletions"
  | "completions"
  | "responses"
  | "deepseek"
  | "openrouter-chat"
  | "openrouter-responses";

export interface LLMConfigurableProps {
  url?: string;
  endpoint?: Endpoints;
  apiKey?: string;
  rpm?: number;
  retryDelay?: number;
  maxAttempts?: number;
  maxFail?: number;
  tempValues?: number[];
  model?: StringParam;
  images?: string[];
  audio?: { data: string; format: string };
  temperature?: NumberParam;
  top_p?: NumberParam;
  top_k?: NumberParam;
  presence_penalty?: NumberParam;
  seed?: NumberParam;
  hardTimeout?: number;
  idleTimeout?: number;
  reasoning_effort?: ConfigParam<ReasoningEffortValue>; // official v1/chat/completions
  chat_template_kwargs?: ConfigParam<{
    /* llama */
    reasoning_effort: ReasoningEffortValue; // gptoss
    enable_thinking?: boolean /* Alibaba Cloud */;
  }>;
  reasoning?: ConfigParam<{ effort?: ReasoningEffortValue; enabled?: boolean }>; // official v1/responses API
  thinking?: ConfigParam<{ type: "enabled" | "disabled" }>; // DeepSeek
  include?: ConfigParam<string[]>; // v1/responses
  enable_thinking?: ConfigParam<boolean>; // Alibaba Cloud
  response_format?: ConfigParam<ResponseFormat>;
  grammar?: ConfigParam<string>; // llama
  provider?: ConfigParam<OpenRouterProviderConfig>; // openrouter exclusive
  thinking_budget_tokens?: NumberParam; // llama
  reasoning_control?: ConfigParam<boolean>; // llama
  max_tokens?: NumberParam;
  systemPrompt?: PromptParam;
  prependPrompt?: PromptParam;
  prefill?: PromptParam;
  lastIndex?: number;
  chunkSize: number;
  batchSize: number;
  parallel: number;
  previousReasoning?: {
    encrypted?: string | null;
    unencrypted?: string | null;
    preferred?: string | null;
  };
  retryFailedFrom?: string;
  stripEmpty?: boolean;
  markdownBrainRot?: boolean;
  failureMeansDeath?: boolean;
  forceStream?: boolean;
  injectORSessionId?: boolean; // openrouter exclusive
  session_id?: StringParam; // openrouter exclusive
  networkContext?: INetworkContext;
  extra_body?: Record<string, unknown>;
  allowH2?: boolean;
}

export type MappableParamKey = Extract<
  keyof LLMConfigurableProps,
  keyof ChatCompletionsPayload | keyof ResponsesPayload
>;

export type MappableParamValue =
  | ChatCompletionsPayload[keyof ChatCompletionsPayload]
  | ResponsesPayload[keyof ResponsesPayload]
  | CompletionsPayload[keyof CompletionsPayload];

export type TerminationState = "none" | "requested" | "forceful";

export const CURRENT_STATE_VERSION = 1;

interface ConfigMetadata {
  helptext_key?: string;
  stripTags?: { start: string; end: string };
  display?: boolean;
  localJSONL?: boolean;
  stripEmpty?: boolean;
  markdownBrainRot?: boolean;
  defaultReasoning?: boolean;
  substitutionPrefix?: string;
  forceStream?: boolean;
  injectORSessionId?: boolean; // openrouter exclusive
  allowH2?: boolean;
}

type ConfigModelParams = Pick<
  LLMConfigurableProps,
  | "chunkSize"
  | "batchSize"
  | "parallel"
  | "maxAttempts"
  | "tempValues"
  | "url"
  | "endpoint"
  | "apiKey"
  | "rpm"
  | "retryDelay"
  | "maxFail"
  | "stripEmpty"
  | "markdownBrainRot"
  | "failureMeansDeath"
  | "model"
  | "temperature"
  | "top_p"
  | "top_k"
  | "presence_penalty"
  | "seed"
  | "hardTimeout"
  | "idleTimeout"
  | "reasoning_effort" // official v1/chat/completions
  | "chat_template_kwargs" // llama
  | "reasoning" // official v1/responses
  | "thinking" // DeepSeek
  | "include" // v1/responses
  | "enable_thinking" // Alibaba Cloud
  | "response_format"
  | "grammar" // llama
  | "provider" // openrouter exclusive
  | "session_id" // openrouter exclusive
  | "thinking_budget_tokens" // llama
  | "reasoning_control" // llama
  | "max_tokens"
  | "extra_body"
  | "allowH2"
>;

export interface ConfigPrompt {
  defSys?: PromptParam;
  defPrep?: PromptParam;
  defPrefill?: PromptParam;
}

export interface ConfigModelVariant {
  prompt?: ConfigPrompt;
  model: Partial<ConfigModelParams>;
}

interface ModelConfigBase {
  reasoningType: "reason_and_instruct" | "instruct_only" | "reason_only";
  metadata: ConfigMetadata;
}

export interface InstructOnlyModelConfig extends ModelConfigBase {
  reasoningType: "instruct_only";
  default: ConfigModelVariant;
}

export interface ReasonOnlyModelConfig extends ModelConfigBase {
  reasoningType: "reason_only";
  default: ConfigModelVariant;
}

export interface ReasonAndInstructModelConfig extends ModelConfigBase {
  reasoningType: "reason_and_instruct";
  instruct: ConfigModelVariant;
  reasoning: ConfigModelVariant;
}

export type ModelConfig =
  | InstructOnlyModelConfig
  | ReasonOnlyModelConfig
  | ReasonAndInstructModelConfig;

export type ParamConfigs = Record<string, ModelConfig>;

export const CURRENT_CONFIG_VERSION = 1;

export interface AppConfig {
  DEFAULT_MODEL: string;
  DEFAULT_REASONING: boolean;
  HARD_TIMEOUT: number;
  IDLE_TIMEOUT: number;
  CHUNK_SIZE: number;
  BATCH_SIZE: number;
  PARALLEL: number;
  URL: string;
  ENDPOINT?: Endpoints;
  RPM: number;
  MAX_FAIL?: number;
  RETRY_DELAY: number;
  FAILURE_MEANS_DEATH?: boolean;
  SOURCE_LANGUAGE: string;
  TARGET_LANGUAGE: string;
  TEMPLATES?: Record<string, string>;
  PARAM_CONFIGS: ParamConfigs;
  PREFIX_REPLACEMENTS?: Record<string, string>;
  VERSION?: number;
}

export interface IReasoningTracker {
  encrypted: string | null;
  unencrypted: string | null;
  summary: string | null;

  processOutputItem(
    item: OutputItem,
  ): { text: string; isReasoning: boolean } | null;
  appendUnencrypted(delta: string): void;
}

export interface StrategyContext {
  commonParams: Record<string, unknown>;
  prefill?: PromptParam;
  previousReasoning?: {
    encrypted?: string | null;
    unencrypted?: string | null;
    preferred?: string | null;
  };
  reasoningTracker: IReasoningTracker;
  emittedAnyDelta?: boolean;
  accumulator?: unknown;
}

export interface GetHeadersOpts {
  apiKey?: string;
}

export interface BackendStrategy {
  readonly supportedParams: ReadonlyArray<MappableParamKey>;
  readonly jsonlFormat?: "openai" | "openrouter" | "dummy";
  readonly requiresDoneSignal?: boolean;

  checkPayloadError?(payload: unknown): void;

  buildPayload(
    messages: Message[],
    context: StrategyContext,
    isStreaming: boolean,
  ):
    | ChatCompletionsPayload
    | ResponsesPayload
    | CompletionsPayload
    | Record<string, unknown>;

  parseChunk(
    chunk: ParsedStreamChunk,
    context: StrategyContext,
  ): Array<StreamChunkItem>;

  getHeaders?(opts?: GetHeadersOpts): Record<string, string>;
  buildRequestUrl?(
    baseUrl: string,
    model: string,
    isStreaming: boolean,
  ): string;

  processStreamBuffer?(
    buffer: string,
    context: StrategyContext,
  ): {
    chunks: Array<StreamChunkItem>;
    remainingBuffer: string;
    done?: boolean;
  };

  recoverTrailingBuffer?(
    buffer: string,
    context: StrategyContext,
  ): {
    chunks: Array<StreamChunkItem>;
    done?: boolean;
  } | null;

  createAccumulator?(messages: Message[], context: StrategyContext): unknown;
  accumulateChunk?(
    accumulator: unknown,
    chunk: ParsedStreamChunk,
    context: StrategyContext,
  ): void;
  finalizeAccumulator?(
    accumulator: unknown,
    finalContent: string,
    context: StrategyContext,
  ): Record<string, unknown>;

  updateResponseContent?(
    responseBody: Record<string, unknown>,
    formattedText: string,
  ): Record<string, unknown>;
}

export interface EndpointOptions {
  url?: string;
  strategy?: BackendStrategy;
  payload?: Record<string, unknown>;
  method?: string;
  isStreaming?: boolean;
  onRawResponse?: (data: unknown) => void;
  hardTimeout?: number;
  idleTimeout?: number;
  headers?: Record<string, string>;
}

export interface CompletionOptions {
  verbose?: boolean | ((chunk: string, isReasoning?: boolean) => Promise<void>);
  overrides?: Partial<LLMConfigurableProps>;
  signal?: AbortSignal;
  tracker?: IReasoningTracker;
  endpointOptions?: EndpointOptions;
}

export interface LLMDependencies {
  llmcall?: (
    messages: Message[],
    options?: CompletionOptions,
  ) => Promise<string>;
  strategy?: BackendStrategy;
}

export const EMPTY_FIELD: readonly [PromptParam, PromptParam] = Object.freeze([
  [false, "", ""],
  [false, ""],
]);

export interface ParsedJsonlLine {
  customId: string;
  isError: boolean;
  text: string;
  reasoningText?: string;
}

export interface JsonlBatchResponse {
  custom_id: string;
  response: {
    status_code: number;
    request_id: string;
    body: ParsedStreamChunk;
  } | null;
  error: {
    message?: string;
    code?: string;
    type?: string;
  } | null;
}

export interface JsonlBatchRequest {
  custom_id: string;
  method: string;
  url: string;
  body: Record<string, unknown>;
  telocity?: Partial<LLMConfigurableProps> & {
    version?: number;
  };
}

export interface ResolveJSONLStrategyOpts {
  line?: string;
  format?: string;
}

export interface JSONLStrategy {
  readonly formatName: string;
  buildLine(
    customId: string,
    payload: Record<string, unknown>,
    requestUrl: string,
    meta?: Partial<LLMConfigurableProps>,
  ): string;
  buildResponse(
    customId: string,
    responseBody: Record<string, unknown> | null,
    errorObj: Record<string, unknown> | null,
  ): string;
  parseLine(line: string): ParsedJsonlLine;
  parseRequest(line: string): JsonlBatchRequest | null;
}

export interface ResolveUrlOptions {
  telocityUrl?: string;
  requestUrl?: string;
  endpoint?: Endpoints;
}

export interface BatchProcessOptions {
  verbose?: boolean | ((chunk: string, isReasoning?: boolean) => Promise<void>);
  onRetry?: () => void;
  onProgress?: (completed: number, total: number) => void;
}

export interface GenerateProcessedBatchesOptions {
  verbose?: boolean | ((chunk: string, isReasoning?: boolean) => Promise<void>);
  onRetry?: () => void;
  onProgress?: (completed: number, total: number) => void;
}
