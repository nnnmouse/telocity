import type {
  MappableParamKey,
  Message,
  StrategyContext,
  ChatCompletionsPayload,
} from "../types/LLMTypes.ts";

import { ChatCompletionsStrategy } from "./OpenAIStrategy.ts";

export class DeepSeekStrategy extends ChatCompletionsStrategy {
  public override readonly supportedParams: ReadonlyArray<MappableParamKey> = [
    "model",
    "temperature",
    "top_p",
    "top_k",
    "presence_penalty",
    "seed",
    "reasoning_effort",
    "thinking", // DeepSeek
    "response_format",
    "max_tokens",
  ];

  public override buildPayload(
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
      type DeepSeekMessage = Message & { prefix?: boolean };
      const assistantMsg: DeepSeekMessage = {
        role: "assistant",
        content: hasPrefill ? ctx.prefill![1] : "",
      };

      if (hasPrefill) {
        // DeepSeek requires the prefix parameter for the last assistant message
        assistantMsg.prefix = true;
      }

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
}
