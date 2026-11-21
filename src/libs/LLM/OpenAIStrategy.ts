import type {
  BackendStrategy,
  MappableParamKey,
  Message,
  StrategyContext,
  ParsedStreamChunk,
  ChatCompletionsPayload,
  CompletionsPayload,
  ResponsesPayload,
  ResponsesMessage,
  ResponsesInputContentPart,
  StreamChunkItem,
  JsonlBatchRequest,
  JSONLStrategy,
  ParsedJsonlLine,
} from "../types/index.ts";

import { createError, simpleTemplate, x } from "../core/index.ts";
import { CURRENT_STATE_VERSION } from "../types/index.ts";

// internal to the strategy type definitions, do not reuse
// in places other than strategies that inherit from OpenAIStrategy strategies.
export interface ExtendedStreamChunk {
  type?: string;
  delta?: string;
  text?: string;
  id?: string;
  created?: number;
  model?: string;
  system_fingerprint?: string;
  timings?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    delta?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
    };
  }>;
}

export interface ChatChoiceAccumulator {
  index: number;
  message: {
    role: string;
    content: string;
    reasoning_content?: string;
  };
  finish_reason: string | null;
}

export interface ChatCompletionsAccumulator {
  id: string;
  created: number;
  model: string;
  system_fingerprint: string;
  object: string;
  choices: ChatChoiceAccumulator[];
  usage: Record<string, unknown> | null;
  timings: Record<string, unknown> | null;
}

export interface CompletionChoiceAccumulator {
  index: number;
  text: string;
  finish_reason: string | null;
}

export interface CompletionsAccumulator {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: CompletionChoiceAccumulator[];
  usage: Record<string, unknown> | null;
}

export interface ResponsesAccumulator {
  id: string;
  object: string;
  created_at: number;
  model: string;
  status: string;
  output: Record<string, unknown>[];
  usage: Record<string, unknown> | null;
}

export interface ExtendedResponsesStreamChunk {
  type?: string;
  delta?: string;
  text?: string;
  id?: string;
  model?: string;
  response?: {
    id?: string;
    model?: string;
    created_at?: number;
    status?: string;
    usage?: Record<string, unknown>;
    output?: Record<string, unknown>[];
  };
  usage?: Record<string, unknown>;
  output?: Record<string, unknown>[];
}

function commonProcessStreamBuffer(
  this: BackendStrategy,
  buffer: string,
  ctx: StrategyContext,
) {
  return processSseStreamBuffer(this, buffer, ctx);
}

function commonRecoverTrailingBuffer(
  this: BackendStrategy,
  buffer: string,
  ctx: StrategyContext,
) {
  return recoverOpenAITrailingBuffer(this, buffer, ctx);
}

function checkOpenAIError(payload: unknown): void {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return;
  }
  const record = payload as Record<string, unknown>;
  if ("error" in record && record["error"]) {
    const errorContainer = record["error"];
    if (typeof errorContainer === "object" && errorContainer !== null) {
      const errRecord = errorContainer as Record<string, unknown>;
      if (typeof errRecord["message"] === "string") {
        throw new Error(errRecord["message"]);
      }
    }
    throw new Error(JSON.stringify(errorContainer));
  }

  if (Array.isArray(record["choices"]) && record["choices"].length > 0) {
    const firstChoice = record["choices"][0] as
      | Record<string, unknown>
      | undefined;
    if (firstChoice) {
      const finishReason = firstChoice["finish_reason"];
      const nestedError = firstChoice["error"] as
        | Record<string, unknown>
        | undefined;

      if (finishReason === "length") {
        throw createError(x.a.s.e.lllm.maxTokensLimitReached, {
          code: "MAX_TOKENS_REACHED",
          immediateExitCode: false,
        });
      }

      if (finishReason === "content_filter") {
        throw createError(x.a.s.e.lllm.contentFilterTriggered, {
          code: "CONTENT_FILTER_TRIGGERED",
          immediateExitCode: false,
        });
      }

      if (finishReason === "error" || nestedError) {
        const message =
          nestedError && typeof nestedError["message"] === "string"
            ? nestedError["message"]
            : x.a.s.e.lllm.streamTerminatedError;
        throw new Error(message);
      }
    }
  }

  if (record["status"] === "incomplete") {
    const incompleteDetails = record["incomplete_details"] as
      | Record<string, unknown>
      | undefined;
    const reason = incompleteDetails?.["reason"];

    if (
      incompleteDetails &&
      (reason === "max_output_tokens" || reason === "max_tokens")
    ) {
      throw createError(x.a.s.e.lllm.maxTokensLimitReached, {
        code: "MAX_TOKENS_REACHED",
        immediateExitCode: false,
      });
    }

    if (incompleteDetails && incompleteDetails["reason"] === "content_filter") {
      throw createError(x.a.s.e.lllm.contentFilterTriggered, {
        code: "CONTENT_FILTER_TRIGGERED",
        immediateExitCode: false,
      });
    }
  }
}

export function processSseStreamBuffer(
  strategy: BackendStrategy,
  buffer: string,
  ctx: StrategyContext,
): {
  chunks: Array<{
    text: string;
    kind: "delta" | "output" | "conditional" | "reasoning" | "reasoning_output";
  }>;
  remainingBuffer: string;
  done?: boolean;
} {
  const chunks: Array<{
    text: string;
    kind: "delta" | "output" | "conditional" | "reasoning" | "reasoning_output";
  }> = [];
  let remainingBuffer = buffer;
  let eventEndIndex: number;
  let done = false;

  while ((eventEndIndex = remainingBuffer.indexOf("\n\n")) >= 0) {
    const part = remainingBuffer.slice(0, eventEndIndex);
    remainingBuffer = remainingBuffer.slice(eventEndIndex + 2);

    if (!part.trim()) continue;

    if (part.trim().startsWith("{")) {
      try {
        const parsedError = JSON.parse(part.trim()) as {
          error?: { message?: string };
        };
        if (parsedError.error) {
          throw new Error(
            parsedError.error.message || JSON.stringify(parsedError.error),
          );
        }
      } catch (err) {
        // Only propagate if it's an API error we explicitly threw.
        // Ignore native SyntaxErrors caused by partial/malformed stream fragments.
        if (err instanceof Error && !(err instanceof SyntaxError)) {
          throw err;
        }
      }
    }

    const lines = part.split("\n");
    let eventData = "";

    for (const line of lines) {
      if (line.trim().startsWith(":")) continue;
      if (line.startsWith("data:")) {
        let value = line.slice(5);
        if (value.startsWith(" ")) {
          value = value.slice(1);
        }
        eventData += (eventData ? "\n" : "") + value;
      }
    }

    if (!eventData) continue;
    if (eventData.trim() === "[DONE]") {
      done = true;
      break;
    }

    let parsed: ParsedStreamChunk;
    try {
      parsed = JSON.parse(eventData) as ParsedStreamChunk;
    } catch (err) {
      throw new Error(
        simpleTemplate(x.a.s.e.lllm.failedToParseStreamChunk, {
          Error: err instanceof Error ? err.message : String(err),
        }),
        { cause: err },
      );
    }

    if (parsed.error) {
      throw new Error(parsed.error.message || JSON.stringify(parsed.error));
    }

    if (parsed.choices?.[0]?.finish_reason === "length") {
      throw createError(x.a.s.e.lllm.maxTokensLimitReached, {
        code: "MAX_TOKENS_REACHED",
        immediateExitCode: false,
      });
    }

    if (parsed.choices?.[0]?.finish_reason === "content_filter") {
      throw createError(x.a.s.e.lllm.contentFilterTriggered, {
        code: "CONTENT_FILTER_TRIGGERED",
        immediateExitCode: false,
      });
    }

    if (
      parsed.response?.status === "incomplete" &&
      (parsed.response?.incomplete_details?.reason === "max_output_tokens" ||
        parsed.response?.incomplete_details?.reason === "max_tokens")
    ) {
      throw createError(x.a.s.e.lllm.maxTokensLimitReached, {
        code: "MAX_TOKENS_REACHED",
        immediateExitCode: false,
      });
    }

    if (
      parsed.response?.status === "incomplete" &&
      parsed.response?.incomplete_details?.reason === "content_filter"
    ) {
      throw createError(x.a.s.e.lllm.contentFilterTriggered, {
        code: "CONTENT_FILTER_TRIGGERED",
        immediateExitCode: false,
      });
    }

    if (parsed.choices?.[0]?.finish_reason === "error") {
      throw new Error(x.a.s.e.lllm.streamTerminatedError);
    }

    const items = strategy.parseChunk(parsed, ctx);

    for (const it of items) {
      if (
        it.kind === "conditional" ||
        it.kind === "output" ||
        it.kind === "reasoning_output"
      ) {
        if (!ctx.emittedAnyDelta) {
          chunks.push({
            text: it.text,
            kind: it.kind === "reasoning_output" ? "reasoning" : "output",
          });
        }
      } else if (it.kind === "reasoning" || it.kind === "delta") {
        ctx.emittedAnyDelta = true;
        chunks.push({ text: it.text, kind: it.kind });
      }
    }

    // response.completed is llama.cpp specific
    if (
      parsed.type === "response.done" ||
      parsed.type === "response.completed"
    ) {
      done = true;
      continue;
    }
  }

  return { chunks, remainingBuffer, done };
}

export function recoverOpenAITrailingBuffer(
  strategy: BackendStrategy,
  buffer: string,
  ctx: StrategyContext,
): {
  chunks: Array<{
    text: string;
    kind: "delta" | "output" | "conditional" | "reasoning" | "reasoning_output";
  }>;
  done?: boolean;
} | null {
  const trimmedBuf = buffer.trim();
  if (!trimmedBuf) return null;

  let doneSignalReceived = false;
  const chunks: Array<{
    text: string;
    kind: "delta" | "output" | "conditional" | "reasoning" | "reasoning_output";
  }> = [];

  const lines = trimmedBuf.split("\n");
  let extractedData = "";

  for (const line of lines) {
    const l = line.trim();
    if (l.startsWith("data:")) {
      const val = l.slice(5).trim();
      if (val === "[DONE]") {
        doneSignalReceived = true;
        break;
      }
      extractedData += val;
    } else if (l.startsWith("{")) {
      extractedData += l;
    }
  }

  if (!doneSignalReceived && extractedData.startsWith("{")) {
    try {
      const parsed = JSON.parse(extractedData) as ParsedStreamChunk;
      if (parsed.error) {
        const errorMsg = parsed.error.message || JSON.stringify(parsed.error);
        const err = new Error(errorMsg) as Error & { code?: string };
        err.code = "LLM_API_ERROR";
        throw err;
      }

      if (parsed.choices?.[0]?.finish_reason === "length") {
        throw createError(x.a.s.e.lllm.maxTokensLimitReached, {
          code: "MAX_TOKENS_REACHED",
          immediateExitCode: false,
        });
      }

      if (parsed.choices?.[0]?.finish_reason === "content_filter") {
        throw createError(x.a.s.e.lllm.contentFilterTriggered, {
          code: "CONTENT_FILTER_TRIGGERED",
          immediateExitCode: false,
        });
      }

      if (
        parsed.response?.status === "incomplete" &&
        (parsed.response?.incomplete_details?.reason === "max_output_tokens" ||
          parsed.response?.incomplete_details?.reason === "max_tokens")
      ) {
        throw createError(x.a.s.e.lllm.maxTokensLimitReached, {
          code: "MAX_TOKENS_REACHED",
          immediateExitCode: false,
        });
      }

      if (
        parsed.response?.status === "incomplete" &&
        parsed.response?.incomplete_details?.reason === "content_filter"
      ) {
        throw createError(x.a.s.e.lllm.contentFilterTriggered, {
          code: "CONTENT_FILTER_TRIGGERED",
          immediateExitCode: false,
        });
      }

      if (parsed.choices?.[0]?.finish_reason === "error") {
        const err = new Error(x.a.s.e.lllm.streamTerminatedError) as Error & {
          code?: string;
        };
        err.code = "LLM_API_ERROR";
        throw err;
      }

      const items = strategy.parseChunk(parsed, ctx);
      for (const it of items) {
        if (
          it.kind === "conditional" ||
          it.kind === "output" ||
          it.kind === "reasoning_output"
        ) {
          if (!ctx.emittedAnyDelta) {
            chunks.push({
              text: it.text,
              kind: it.kind === "reasoning_output" ? "reasoning" : "output",
            });
          }
        } else if (it.kind === "reasoning" || it.kind === "delta") {
          ctx.emittedAnyDelta = true;
          chunks.push({ text: it.text, kind: it.kind });
        }
      }

      if (
        parsed.type === "response.done" ||
        parsed.type === "response.completed"
      ) {
        doneSignalReceived = true;
      }
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err.code === "LLM_API_ERROR" ||
          err.code === "MAX_TOKENS_REACHED" ||
          err.code === "CONTENT_FILTER_TRIGGERED")
      ) {
        throw err;
      }
      // Non-critical JSON parse errors on truncated trailing fragments are ignored
    }
  }

  return {
    chunks,
    done: doneSignalReceived,
  };
}

export class ChatCompletionsStrategy implements BackendStrategy {
  public readonly supportedParams: ReadonlyArray<MappableParamKey> = [
    "model",
    "temperature",
    "top_p",
    "top_k",
    "presence_penalty",
    "seed",
    "reasoning_effort", // v1/chat/completions
    "reasoning" /* official v1/responses API */,
    "chat_template_kwargs" /* llama */,
    "enable_thinking" /* Alibaba Cloud */,
    "response_format",
    "grammar" /* llama */,
    "thinking_budget_tokens" /* llama */,
    "reasoning_control" /* llama */,
    "max_tokens",
  ];
  public readonly processStreamBuffer = commonProcessStreamBuffer;
  public readonly recoverTrailingBuffer = commonRecoverTrailingBuffer;
  public readonly checkPayloadError = checkOpenAIError;

  public createAccumulator(
    _messages: Message[],
    _context: StrategyContext,
  ): ChatCompletionsAccumulator {
    return {
      id: "",
      created: 0,
      model: "",
      system_fingerprint: "",
      object: "chat.completion",
      choices: [],
      usage: null,
      timings: null,
    };
  }

  public accumulateChunk(
    accumulator: unknown,
    chunk: ParsedStreamChunk,
    _context: StrategyContext,
  ): void {
    const acc = accumulator as ChatCompletionsAccumulator;
    const extChunk = chunk as unknown as ExtendedStreamChunk;

    if (extChunk.id) acc.id = extChunk.id;
    if (extChunk.created) acc.created = extChunk.created;
    if (extChunk.model) acc.model = extChunk.model;
    if (extChunk.system_fingerprint)
      acc.system_fingerprint = extChunk.system_fingerprint;

    if (extChunk.timings) {
      acc.timings = { ...(acc.timings || {}), ...extChunk.timings };
    }
    if (extChunk.usage) {
      acc.usage = { ...(acc.usage || {}), ...extChunk.usage };
    }

    if (extChunk.choices && Array.isArray(extChunk.choices)) {
      for (const choice of extChunk.choices) {
        const choiceAsAny = choice as Record<string, unknown>;
        const index =
          typeof choiceAsAny["index"] === "number" ? choiceAsAny["index"] : 0;

        let accChoice = acc.choices.find((c) => c.index === index);
        if (!accChoice) {
          accChoice = {
            index,
            message: { role: "assistant", content: "" },
            finish_reason: null,
          };
          acc.choices.push(accChoice);
        }

        if (typeof choiceAsAny["finish_reason"] === "string") {
          accChoice.finish_reason = choiceAsAny["finish_reason"];
        }

        const delta = choiceAsAny["delta"] as
          | Record<string, unknown>
          | undefined;
        if (delta) {
          if (typeof delta["role"] === "string") {
            accChoice.message.role = delta["role"];
          }
          if (typeof delta["content"] === "string") {
            accChoice.message.content += delta["content"];
          }
          if (typeof delta["reasoning_content"] === "string") {
            if (!accChoice.message.reasoning_content) {
              accChoice.message.reasoning_content = "";
            }
            accChoice.message.reasoning_content += delta["reasoning_content"];
          }
        }
      }
    }
  }

  public finalizeAccumulator(
    accumulator: unknown,
    finalContent: string,
    context: StrategyContext,
  ): Record<string, unknown> {
    const acc = accumulator as ChatCompletionsAccumulator;
    const unencryptedReasoning =
      context.reasoningTracker.unencrypted || undefined;

    if (acc.choices.length === 0) {
      acc.choices.push({
        index: 0,
        message: {
          role: "assistant",
          content: finalContent,
          reasoning_content: unencryptedReasoning,
        },
        finish_reason: "stop",
      });
    } else {
      for (const choice of acc.choices) {
        if (!choice.message.content && finalContent) {
          choice.message.content = finalContent;
        }
        if (!choice.message.reasoning_content && unencryptedReasoning) {
          choice.message.reasoning_content = unencryptedReasoning;
        }
      }
    }
    return acc as unknown as Record<string, unknown>;
  }

  public buildPayload(
    messages: Message[],
    ctx: StrategyContext,
    isStreaming: boolean,
  ): ChatCompletionsPayload {
    const finalMessages: Message[] = [...messages];

    const hasPrefill = ctx.prefill?.[0];
    const prevReasoning = ctx.previousReasoning;
    const hasReasoning = !!(
      prevReasoning &&
      (prevReasoning.unencrypted || prevReasoning.encrypted)
    );

    if (hasPrefill || hasReasoning) {
      const assistantMsg: Message = {
        role: "assistant",
        content: hasPrefill ? ctx.prefill![1] : "",
      };

      if (hasReasoning) {
        if (prevReasoning?.unencrypted) {
          assistantMsg.reasoning_content = prevReasoning.unencrypted;
        }
        if (prevReasoning?.encrypted) {
          assistantMsg.encrypted_reasoning = prevReasoning.encrypted;
        }
      }

      finalMessages.push(assistantMsg);
    }

    return {
      messages: finalMessages,
      ...ctx.commonParams,
      stream: isStreaming,
    } as ChatCompletionsPayload;
  }

  public parseChunk(
    chunk: ParsedStreamChunk,
    ctx: StrategyContext,
  ): Array<StreamChunkItem> {
    const out: Array<StreamChunkItem> = [];

    if (ctx.accumulator && this.accumulateChunk) {
      this.accumulateChunk(ctx.accumulator, chunk, ctx);
    }

    const delta = chunk.choices?.[0]?.delta;
    const message = chunk.choices?.[0]?.message;

    // llama.cpp and deepseek APIs
    const reasoningText =
      delta?.reasoning_content || message?.reasoning_content;

    if (reasoningText) {
      ctx.reasoningTracker.appendUnencrypted(reasoningText);
      out.push({ text: reasoningText, kind: "reasoning" });
    }

    if (delta?.content) {
      out.push({ text: delta.content, kind: "delta" });
    } else if (message?.content) {
      out.push({ text: message.content, kind: "conditional" });
    }

    return out;
  }

  public updateResponseContent(
    responseBody: Record<string, unknown>,
    formattedText: string,
  ): Record<string, unknown> {
    const body = responseBody as {
      choices?: Array<{ message?: { content: string } }>;
    };
    if (body.choices?.[0]?.message) {
      body.choices[0].message.content = formattedText;
    }
    return body as Record<string, unknown>;
  }
}

export class CompletionsStrategy implements BackendStrategy {
  public readonly supportedParams: ReadonlyArray<MappableParamKey> = [
    "model",
    "temperature",
    "top_p",
    "top_k",
    "presence_penalty",
    "seed",
    "grammar" /* llama */,
    "thinking_budget_tokens" /* llama */,
    "reasoning_control" /* llama */,
    "max_tokens",
  ];

  public readonly processStreamBuffer = commonProcessStreamBuffer;
  public readonly recoverTrailingBuffer = commonRecoverTrailingBuffer;
  public readonly checkPayloadError = checkOpenAIError;

  public createAccumulator(
    _messages: Message[],
    _context: StrategyContext,
  ): CompletionsAccumulator {
    return {
      id: "",
      object: "text_completion",
      created: Math.floor(Date.now() / 1000),
      model: "",
      choices: [],
      usage: null,
    };
  }

  public accumulateChunk(
    accumulator: unknown,
    chunk: ParsedStreamChunk,
    _context: StrategyContext,
  ): void {
    const acc = accumulator as CompletionsAccumulator;
    const extChunk = chunk as unknown as ExtendedStreamChunk;

    if (extChunk.id) acc.id = extChunk.id;
    if (extChunk.created) acc.created = extChunk.created;
    if (extChunk.model) acc.model = extChunk.model;

    if (extChunk.usage) {
      acc.usage = { ...(acc.usage || {}), ...extChunk.usage };
    }

    if (extChunk.choices && Array.isArray(extChunk.choices)) {
      for (const choice of extChunk.choices) {
        const choiceAsAny = choice as Record<string, unknown>;
        const index =
          typeof choiceAsAny["index"] === "number" ? choiceAsAny["index"] : 0;
        let accChoice = acc.choices.find((c) => c.index === index);
        if (!accChoice) {
          accChoice = {
            index,
            text: "",
            finish_reason: null,
          };
          acc.choices.push(accChoice);
        }
        if (typeof choiceAsAny["finish_reason"] === "string") {
          accChoice.finish_reason = choiceAsAny["finish_reason"];
        }
        if (typeof choiceAsAny["text"] === "string") {
          accChoice.text += choiceAsAny["text"];
        }
      }
    }
  }

  public finalizeAccumulator(
    accumulator: unknown,
    finalContent: string,
    _context: StrategyContext,
  ): Record<string, unknown> {
    const acc = accumulator as CompletionsAccumulator;
    if (acc.choices.length === 0) {
      acc.choices.push({
        index: 0,
        text: finalContent,
        finish_reason: "stop",
      });
    } else {
      for (const choice of acc.choices) {
        if (!choice.text && finalContent) {
          choice.text = finalContent;
        }
      }
    }
    return acc as unknown as Record<string, unknown>;
  }

  public buildPayload(
    messages: Message[],
    ctx: StrategyContext,
    isStreaming: boolean,
  ): CompletionsPayload {
    const finalMessages: Message[] = [...messages];
    if (ctx.prefill?.[0]) {
      finalMessages.push({
        role: "assistant",
        content: ctx.prefill[1],
      });
    }

    const prompt = finalMessages.reduce((acc, msg) => {
      let content;
      if (typeof msg.content === "string") {
        content = msg.content;
      } else {
        content = msg.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("");
      }
      return acc + content;
    }, "");

    return {
      prompt,
      ...ctx.commonParams,
      stream: isStreaming,
    } as CompletionsPayload;
  }

  public parseChunk(
    chunk: ParsedStreamChunk,
    ctx: StrategyContext,
  ): Array<StreamChunkItem> {
    if (ctx.accumulator && this.accumulateChunk) {
      this.accumulateChunk(ctx.accumulator, chunk, ctx);
    }

    const completionsChunk = chunk as unknown as {
      choices?: Array<{ text?: string }>;
    };
    const text = completionsChunk.choices?.[0]?.text;
    return typeof text === "string" ? [{ text, kind: "delta" }] : [];
  }

  public updateResponseContent(
    responseBody: Record<string, unknown>,
    formattedText: string,
  ): Record<string, unknown> {
    const body = responseBody as {
      choices?: Array<{ text: string }>;
    };
    if (body.choices?.[0]?.text !== undefined) {
      body.choices[0].text = formattedText;
    }
    return body as Record<string, unknown>;
  }
}

export class ResponsesStrategy implements BackendStrategy {
  public readonly supportedParams: ReadonlyArray<MappableParamKey> = [
    "model",
    "temperature",
    "top_p",
    "presence_penalty",
    "seed",
    "chat_template_kwargs" /* llama */,
    "reasoning" /* official v1/responses API */,
    "include" /* official v1/responses API */,
    "response_format",
    "grammar" /* llama */,
    "thinking_budget_tokens" /* llama */,
    "reasoning_control" /* llama */,
    "max_tokens",
  ];

  public readonly processStreamBuffer = commonProcessStreamBuffer;
  public readonly recoverTrailingBuffer = commonRecoverTrailingBuffer;
  public readonly checkPayloadError = checkOpenAIError;

  public createAccumulator(
    _messages: Message[],
    _context: StrategyContext,
  ): ResponsesAccumulator {
    return {
      id: "",
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: "",
      status: "completed",
      output: [],
      usage: null,
    };
  }

  public accumulateChunk(
    accumulator: unknown,
    chunk: ParsedStreamChunk,
    _context: StrategyContext,
  ): void {
    const acc = accumulator as ResponsesAccumulator;
    const extChunk = chunk as unknown as ExtendedResponsesStreamChunk;

    if (extChunk.id) acc.id = extChunk.id;
    if (extChunk.model) acc.model = extChunk.model;

    if (extChunk.response) {
      const respObj = extChunk.response;
      if (respObj.id) acc.id = respObj.id;
      if (respObj.model) acc.model = respObj.model;
      if (respObj.created_at) acc.created_at = respObj.created_at;
      if (respObj.status) acc.status = respObj.status;
      if (respObj.usage) {
        acc.usage = { ...(acc.usage || {}), ...respObj.usage };
      }
      if (Array.isArray(respObj.output)) {
        acc.output = respObj.output;
      }
    }

    if (extChunk.usage) {
      acc.usage = { ...(acc.usage || {}), ...extChunk.usage };
    }

    if (Array.isArray(extChunk.output)) {
      acc.output = extChunk.output as Record<string, unknown>[];
    }
  }

  public finalizeAccumulator(
    accumulator: unknown,
    finalContent: string,
    context: StrategyContext,
  ): Record<string, unknown> {
    const acc = accumulator as ResponsesAccumulator;

    if (acc.output.length === 0) {
      const outputParts = [];
      if (context.reasoningTracker.unencrypted) {
        outputParts.push({
          type: "reasoning" as const,
          content: [
            {
              type: "reasoning_text" as const,
              text: context.reasoningTracker.unencrypted,
            },
          ],
        });
      }
      outputParts.push({
        type: "message" as const,
        role: "assistant",
        content: [{ type: "output_text" as const, text: finalContent }],
      });
      acc.output = outputParts;
    }
    return acc as unknown as Record<string, unknown>;
  }

  public buildPayload(
    messages: Message[],
    ctx: StrategyContext,
    isStreaming: boolean,
  ): ResponsesPayload {
    const finalMessages: Message[] = [...messages];

    const hasPrefill = ctx.prefill?.[0];
    const prevReasoning = ctx.previousReasoning;
    const hasReasoning = !!(
      prevReasoning &&
      (prevReasoning.unencrypted || prevReasoning.encrypted)
    );

    if (hasPrefill || hasReasoning) {
      const assistantMsg: Message = {
        role: "assistant",
        content: hasPrefill ? ctx.prefill![1] : "",
      };

      if (hasReasoning) {
        if (prevReasoning?.unencrypted) {
          assistantMsg.reasoning_content = prevReasoning.unencrypted;
        }
        if (prevReasoning?.encrypted) {
          assistantMsg.encrypted_reasoning = prevReasoning.encrypted;
        }
      }

      finalMessages.push(assistantMsg);
    }

    let instructions: string | undefined;

    const inputMessages = finalMessages.reduce<ResponsesMessage[]>(
      (acc, msg) => {
        if (msg.role === "system") {
          const content =
            typeof msg.content === "string" ? msg.content : "System Prompt";
          instructions = instructions ? instructions + "\n" + content : content;
        } else {
          const newContent: ResponsesInputContentPart[] = [];
          const textType =
            msg.role === "assistant" ? "output_text" : "input_text";

          if (typeof msg.content === "string") {
            if (msg.content !== "") {
              newContent.push({ type: textType, text: msg.content });
            }
          } else {
            for (const part of msg.content) {
              if (part.type === "text" && part.text !== "") {
                newContent.push({ type: textType, text: part.text });
              } else if (part.type === "image_url") {
                newContent.push({
                  type: "input_image",
                  image_url: part.image_url.url,
                });
              }
            }
          }

          type ExtendedResponsesMessage = ResponsesMessage & {
            reasoning_content?: string;
            encrypted_reasoning?: string;
          };

          const responseMsg: ExtendedResponsesMessage = {
            type: "message",
            role: msg.role,
            content: newContent,
          };

          if (msg.reasoning_content) {
            responseMsg.reasoning_content = msg.reasoning_content;
          }
          if (msg.encrypted_reasoning) {
            responseMsg.encrypted_reasoning = msg.encrypted_reasoning;
          }

          acc.push(responseMsg);
        }
        return acc;
      },
      [],
    );

    const payload = {
      input: inputMessages,
      instructions,
      store: false,
      ...ctx.commonParams,
      stream: isStreaming,
    } as ResponsesPayload;

    return payload;
  }

  public parseChunk(
    chunk: ParsedStreamChunk,
    ctx: StrategyContext,
  ): Array<StreamChunkItem> {
    const out: Array<StreamChunkItem> = [];

    if (ctx.accumulator && this.accumulateChunk) {
      this.accumulateChunk(ctx.accumulator, chunk, ctx);
    }

    // Intercept Responses API Mid-Stream Failure Events
    if (chunk.type === "response.failed" && chunk.response?.error) {
      throw new Error(
        chunk.response.error.message || JSON.stringify(chunk.response.error),
      );
    }

    if (
      (chunk.type === "response.error" || chunk.type === "error") &&
      chunk.error
    ) {
      throw new Error(chunk.error.message || JSON.stringify(chunk.error));
    }

    if (
      (chunk.type === "response.output_text.delta" ||
        chunk.type === "response.refusal.delta") &&
      chunk.delta
    ) {
      out.push({ text: chunk.delta, kind: "delta" });
    } else if (chunk.type === "response.reasoning_text.delta" && chunk.delta) {
      ctx.reasoningTracker.appendUnencrypted(chunk.delta);
      out.push({ text: chunk.delta, kind: "reasoning" });
    } else if (
      (chunk.type === "response.output_text.done" ||
        chunk.type === "response.refusal.done") &&
      chunk.text
    ) {
      out.push({ text: chunk.text, kind: "conditional" });
    } else if (
      (chunk.type === "response.output_item.added" ||
        chunk.type === "response.output_item.done") &&
      chunk.item
    ) {
      const result = ctx.reasoningTracker.processOutputItem(chunk.item);
      if (result?.text) {
        out.push({
          text: result.text,
          kind: result.isReasoning ? "reasoning_output" : "output",
        });
      }
    } else if (Array.isArray(chunk.output)) {
      for (const item of chunk.output) {
        const result = ctx.reasoningTracker.processOutputItem(item);
        if (result?.text) {
          out.push({
            text: result.text,
            kind: result.isReasoning ? "reasoning_output" : "output",
          });
        }
      }
    } else if (chunk.choices?.[0]?.delta?.content) {
      out.push({ text: chunk.choices[0].delta.content, kind: "delta" });
    }

    return out;
  }
  public updateResponseContent(
    responseBody: Record<string, unknown>,
    formattedText: string,
  ): Record<string, unknown> {
    const body = responseBody as {
      output?: Array<{
        type: string;
        role?: string;
        content?: Array<{ type: string; text: string }>;
      }>;
    };
    if (body.output) {
      for (const item of body.output) {
        if (
          item.type === "message" &&
          item.role === "assistant" &&
          item.content
        ) {
          for (const part of item.content) {
            if (part.type === "output_text") {
              part.text = formattedText;
            }
          }
        }
      }
    }
    return body as Record<string, unknown>;
  }
}

export class OpenAIJSONLStrategy implements JSONLStrategy {
  public readonly formatName: string = "openai";

  public buildLine(
    customId: string,
    payload: Record<string, unknown>,
    requestUrl: string,
    meta?: Record<string, unknown>,
  ): string {
    const bodyObj = {
      custom_id: customId,
      method: "POST",
      url: requestUrl,
      body: payload,
      ...(meta
        ? { telocity: { version: CURRENT_STATE_VERSION, ...meta } }
        : {}),
    };
    return JSON.stringify(bodyObj);
  }

  public buildResponse(
    customId: string,
    responseBody: Record<string, unknown> | null,
    errorObj: Record<string, unknown> | null,
  ): string {
    return JSON.stringify({
      custom_id: customId,
      response: responseBody
        ? {
            status_code: 200,
            request_id: "batch",
            body: responseBody,
          }
        : null,
      error: errorObj,
    });
  }

  public parseLine(line: string): ParsedJsonlLine {
    try {
      const parsed = JSON.parse(line) as {
        custom_id?: string;
        error?: { message?: string };
        response?: {
          status_code?: number;
          body?: {
            error?: { message?: string };
            status?: string;
            incomplete_details?: {
              reason?: string;
            };
            choices?: Array<{
              message?: { content?: string; reasoning_content?: string };
              text?: string;
              finish_reason?: string;
            }>;
            output?: Array<{
              type: string;
              content?: Array<{ type: string; text: string }>;
            }>;
          };
        };
      };
      const customId = parsed.custom_id || "unknown";

      if (parsed.error) {
        return {
          customId,
          isError: true,
          text: simpleTemplate(x.a.s.e.lllm.jsonlError, {
            Message: parsed.error.message || JSON.stringify(parsed.error),
          }),
        };
      }

      const response = parsed.response;
      if (response) {
        const statusCode = response.status_code;
        if (statusCode !== undefined && statusCode !== 200) {
          let errMsg = x.a.s.e.lllm.unknownStatusCodeError;
          const body = response.body;
          if (body && typeof body === "object") {
            if (body.error) {
              errMsg = body.error.message || JSON.stringify(body.error);
            } else {
              errMsg = JSON.stringify(body);
            }
          }
          return {
            customId,
            isError: true,
            text: simpleTemplate(x.a.s.e.lllm.jsonlStatusError, {
              Status: statusCode,
              Message: errMsg,
            }),
          };
        }

        const body = response.body;
        if (body) {
          if (body.error) {
            return {
              customId,
              isError: true,
              text: simpleTemplate(x.a.s.e.lllm.jsonlError, {
                Message: body.error.message || JSON.stringify(body.error),
              }),
            };
          }

          const firstChoice = body.choices?.[0];
          if (firstChoice) {
            const finishReason = firstChoice.finish_reason;
            if (finishReason === "error") {
              return {
                customId,
                isError: true,
                text: x.a.s.e.lllm.jsonlStreamTerminatedError,
              };
            }
            if (finishReason === "length") {
              return {
                customId,
                isError: true,
                text: x.a.s.e.lllm.jsonlMaxTokensLength,
              };
            }
            if (finishReason === "content_filter") {
              return {
                customId,
                isError: true,
                text: x.a.s.e.lllm.jsonlContentFilter,
              };
            }
          }

          if (body.status === "incomplete") {
            const reason = body.incomplete_details?.reason;
            if (reason === "max_output_tokens" || reason === "max_tokens") {
              return {
                customId,
                isError: true,
                text: simpleTemplate(x.a.s.e.lllm.jsonlMaxTokensIncomplete, {
                  Reason: reason || "unknown",
                }),
              };
            }
            if (reason === "content_filter") {
              return {
                customId,
                isError: true,
                text: x.a.s.e.lllm.jsonlContentFilterIncomplete,
              };
            }
            if (reason === "failed" || reason === "cancelled") {
              return {
                customId,
                isError: true,
                text: simpleTemplate(x.a.s.e.lllm.jsonlExecutionIncomplete, {
                  Reason: reason || "unknown",
                }),
              };
            }
          }

          if (body.output) {
            let content = "";
            let reasoningText = "";
            for (const item of body.output) {
              if (item.type === "reasoning" && item.content) {
                reasoningText += item.content.map((c) => c.text).join("");
              } else if (item.type === "message" && item.content) {
                content += item.content
                  .filter((c) => c.type === "output_text")
                  .map((c) => c.text)
                  .join("");
              }
            }
            return {
              customId,
              isError: false,
              text: content,
              reasoningText: reasoningText || undefined,
            };
          }

          if (body.choices?.[0]?.message) {
            const msg = body.choices[0].message;
            return {
              customId,
              isError: false,
              text: msg.content || "",
              reasoningText: msg.reasoning_content || undefined,
            };
          }

          if (body.choices?.[0]?.text !== undefined) {
            return {
              customId,
              isError: false,
              text: body.choices[0].text,
            };
          }
        }
      }

      return {
        customId,
        isError: true,
        text: simpleTemplate(x.a.s.e.lllm.jsonlUnrecognizedFormat, {
          CustomId: customId,
        }),
      };
    } catch {
      return {
        customId: "unknown",
        isError: true,
        text: x.a.s.e.lllm.jsonlMalformedLine,
      };
    }
  }

  public parseRequest(line: string): JsonlBatchRequest | null {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const customId = parsed["custom_id"] as string;
      if (!customId) return null;

      if ("response" in parsed || ("error" in parsed && !("body" in parsed))) {
        return null;
      }

      const body = parsed["body"];
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return null;
      }

      return {
        custom_id: customId,
        method: (parsed["method"] as string) || "POST",
        url: (parsed["url"] as string) || "",
        body: (parsed["body"] as Record<string, unknown>) || {},
        telocity: parsed["telocity"] as JsonlBatchRequest["telocity"],
      };
    } catch {
      return null;
    }
  }
}
