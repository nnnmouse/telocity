import type {
  MappableParamKey,
  StrategyContext,
  ParsedStreamChunk,
  StreamChunkItem,
  ParsedJsonlLine,
  GetHeadersOpts,
} from "../types/index.ts";
import type {
  ExtendedStreamChunk,
  ChatChoiceAccumulator,
  ChatCompletionsAccumulator,
  ResponsesAccumulator,
  ExtendedResponsesStreamChunk,
} from "./OpenAIStrategy.ts";

import { simpleTemplate, x } from "../core/index.ts";
import {
  ChatCompletionsStrategy,
  OpenAIJSONLStrategy,
  ResponsesStrategy,
} from "./OpenAIStrategy.ts";

interface OpenRouterChatChoiceAccumulator extends Omit<
  ChatChoiceAccumulator,
  "message"
> {
  message: ChatChoiceAccumulator["message"] & {
    reasoning?: string;
    reasoning_details?: OpenRouterReasoningDetail[];
  };
  native_finish_reason?: string | null;
}

interface OpenRouterChatCompletionsAccumulator extends Omit<
  ChatCompletionsAccumulator,
  "choices"
> {
  choices: OpenRouterChatChoiceAccumulator[];
  provider?: string;
}

interface OpenRouterExtendedStreamChunk extends Omit<
  ExtendedStreamChunk,
  "choices"
> {
  provider?: string;
  choices?: Array<
    NonNullable<ExtendedStreamChunk["choices"]>[number] & {
      native_finish_reason?: string | null;
      delta?: {
        role?: string;
        content?: string | null;
        reasoning_content?: string | null;
        reasoning?: string | null;
        reasoning_details?: OpenRouterReasoningDetail[];
      };
    }
  >;
}

interface OpenRouterChoice {
  delta?: {
    content?: string;
    reasoning_content?: string;
    reasoning?: string;
    reasoning_details?: OpenRouterReasoningDetail[];
  };
  message?: {
    content?: string;
    reasoning_content?: string;
    reasoning?: string;
    reasoning_details?: OpenRouterReasoningDetail[];
  };
}

interface OpenRouterResponsesAccumulator extends ResponsesAccumulator {
  provider?: string;
}

interface OpenRouterExtendedResponsesStreamChunk extends Omit<
  ExtendedResponsesStreamChunk,
  "response"
> {
  provider?: string;
  response?: NonNullable<ExtendedResponsesStreamChunk["response"]> & {
    provider?: string;
  };
}

interface OpenRouterReasoningDetail {
  type: string;
  index?: number;
  format?: string;
  text?: string;
  summary?: string;
  data?: string; // For encrypted chunks
  signature?: string | null;
}

export class OpenRouterChatCompletionsStrategy extends ChatCompletionsStrategy {
  public readonly jsonlFormat = "openrouter" as const;
  public override readonly supportedParams: ReadonlyArray<MappableParamKey> = [
    "model",
    "temperature",
    "top_p",
    "top_k",
    "presence_penalty",
    "seed",
    "response_format",
    "reasoning",
    "provider", // OpenRouter exclusive
    "session_id", // OpenRouter exclusive
    "max_tokens",
  ];

  public getHeaders(opts?: GetHeadersOpts): Record<string, string> {
    const { appState } = x;
    const apiKey = opts?.apiKey ?? "";
    return {
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": appState.P_URL,
      "X-OpenRouter-Title": appState.P_NAME,
    };
  }

  public override accumulateChunk(
    accumulator: unknown,
    chunk: ParsedStreamChunk,
    ctx: StrategyContext,
  ): void {
    super.accumulateChunk(accumulator, chunk, ctx);

    const acc = accumulator as OpenRouterChatCompletionsAccumulator;
    const extChunk = chunk as unknown as OpenRouterExtendedStreamChunk;

    if (extChunk.provider) {
      acc.provider = extChunk.provider;
    }

    if (extChunk.choices && Array.isArray(extChunk.choices)) {
      for (const choice of extChunk.choices) {
        const index = typeof choice.index === "number" ? choice.index : 0;
        const accChoice = acc.choices.find((c) => c.index === index);
        if (accChoice) {
          if (typeof choice.native_finish_reason === "string") {
            accChoice.native_finish_reason = choice.native_finish_reason;
          }
          const delta = choice.delta;
          if (delta) {
            if (typeof delta.reasoning === "string") {
              if (!accChoice.message.reasoning) {
                accChoice.message.reasoning = "";
              }
              accChoice.message.reasoning += delta.reasoning;
            }
            if (Array.isArray(delta.reasoning_details)) {
              if (!accChoice.message.reasoning_details) {
                accChoice.message.reasoning_details = [];
              }
              for (const detail of delta.reasoning_details) {
                const existing = accChoice.message.reasoning_details.find(
                  (d) => d.type === detail.type && d.index === detail.index,
                );

                if (existing) {
                  // Merge the string payloads
                  if (typeof detail.text === "string") {
                    existing.text = (existing.text || "") + detail.text;
                  }
                  if (typeof detail.summary === "string") {
                    existing.summary =
                      (existing.summary || "") + detail.summary;
                  }
                  if (typeof detail.data === "string") {
                    existing.data = (existing.data || "") + detail.data;
                  }
                } else {
                  // First time seeing this type/index, clone and push
                  accChoice.message.reasoning_details.push({ ...detail });
                }
              }
            }
          }
        }
      }
    }
  }

  public override finalizeAccumulator(
    accumulator: unknown,
    finalContent: string,
    context: StrategyContext,
  ): Record<string, unknown> {
    // Run the base finalizer
    const acc = super.finalizeAccumulator(accumulator, finalContent, context);
    const unencryptedReasoning =
      context.reasoningTracker.unencrypted || undefined;

    const accCast = acc as unknown as OpenRouterChatCompletionsAccumulator;
    if (accCast.choices && Array.isArray(accCast.choices)) {
      for (const choice of accCast.choices) {
        if (!choice.message) continue;

        // Ensure OpenRouter's string property is populated if missing
        if (!choice.message.reasoning && unencryptedReasoning) {
          choice.message.reasoning = unencryptedReasoning;
        }

        // CLEANUP REDUNDANCY: Prune the duplicate keys to save disk space.
        if (
          Array.isArray(choice.message.reasoning_details) &&
          choice.message.reasoning_details.length > 0
        ) {
          // If we have the rich structured array, delete the flat string copies
          delete choice.message.reasoning;
          delete choice.message.reasoning_content;
        } else {
          // Otherwise, rely on OpenRouter's 'reasoning' string, and drop the OpenAI alias
          delete choice.message.reasoning_content;
        }
      }
    }
    return acc;
  }

  public override parseChunk(
    chunk: ParsedStreamChunk,
    ctx: StrategyContext,
  ): Array<StreamChunkItem> {
    const out: Array<StreamChunkItem> = [];

    if (ctx.accumulator && this.accumulateChunk) {
      this.accumulateChunk(ctx.accumulator, chunk, ctx);
    }

    const choices = chunk.choices as OpenRouterChoice[] | undefined;
    const firstChoice = choices?.[0];
    const delta = firstChoice?.delta;
    const message = firstChoice?.message;

    let reasoningText = "";

    // 1. Try structured details array first (e.g., Claude 3.7)
    const details = delta?.reasoning_details || message?.reasoning_details;
    if (Array.isArray(details)) {
      reasoningText = details
        .filter(
          (item) =>
            item &&
            item.type === "reasoning.text" &&
            typeof item.text === "string",
        )
        .map((item) => item.text)
        .join("");
    }

    // 2. Fall back to raw string fields ONLY if details array did not yield text
    if (!reasoningText) {
      reasoningText =
        delta?.reasoning_content ||
        message?.reasoning_content ||
        delta?.reasoning ||
        message?.reasoning ||
        "";
    }

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
}

export class OpenRouterResponsesStrategy extends ResponsesStrategy {
  public readonly jsonlFormat = "openrouter" as const;
  public override readonly supportedParams: ReadonlyArray<MappableParamKey> = [
    "model",
    "temperature",
    "top_p",
    "presence_penalty",
    "seed",
    "reasoning",
    "include",
    "response_format",
    "provider", // OpenRouter exclusive
    "session_id", // OpenRouter exclusive
    "max_tokens",
  ];

  public getHeaders(opts?: GetHeadersOpts): Record<string, string> {
    const { appState } = x;
    const apiKey = opts?.apiKey ?? "";
    return {
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": appState.P_URL,
      "X-OpenRouter-Title": appState.P_NAME,
    };
  }

  public override accumulateChunk(
    accumulator: unknown,
    chunk: ParsedStreamChunk,
    ctx: StrategyContext,
  ): void {
    super.accumulateChunk(accumulator, chunk, ctx);

    const acc = accumulator as OpenRouterResponsesAccumulator;
    const extChunk = chunk as unknown as OpenRouterExtendedResponsesStreamChunk;

    if (extChunk.provider) {
      acc.provider = extChunk.provider;
    }

    if (extChunk.response && extChunk.response.provider) {
      acc.provider = extChunk.response.provider;
    }
  }
}

export class OpenRouterJSONLStrategy extends OpenAIJSONLStrategy {
  public override readonly formatName = "openrouter";

  public override parseLine(line: string): ParsedJsonlLine {
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
              message?: {
                content?: string;
                reasoning_content?: string;
                reasoning?: string;
                reasoning_details?: unknown[];
              };
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

            // Resolve standard or OpenRouter plaintext reasoning fields
            let rText = msg.reasoning_content || msg.reasoning;

            // Check and resolve structured details array blocks
            if (!rText && Array.isArray(msg.reasoning_details)) {
              const details = msg.reasoning_details as Array<{
                type: string;
                text?: string;
              }>;
              rText = details
                .filter(
                  (item) =>
                    item &&
                    item.type === "reasoning.text" &&
                    typeof item.text === "string",
                )
                .map((item) => item.text)
                .join("");
            }

            return {
              customId,
              isError: false,
              text: msg.content || "",
              reasoningText: rText || undefined,
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
}
