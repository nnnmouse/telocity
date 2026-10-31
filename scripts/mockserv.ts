#!/usr/bin/env node

import type { IncomingMessage, ServerResponse } from "node:http";

import * as http from "node:http";

// --- Global Constants & Fallback Defaults ---
const PORT = 8080;
const MARKDOWN_HELL_MODE = process.argv.includes("--markdown");
const STREAM_LATENCY_MS = 0;
const DEFAULT_LATENCY_MS = 50;
const MARKDOWN_REPETITIONS = 100;
const CHUNK_SIZE_CHARS = 5;
const TIMEOUT_DELAY_MS = 5000;
const MAX_ATTEMPTS = 7;

// --- Configuration Interface ---
export interface MockServerConfig {
  port: number;
  markdownHell: boolean;
  markdownRepetitions: number;
  chunkSizeChars: number;
  streamLatencyMs: number;
  defaultLatencyMs: number;
  maxAttempts: number;
  timeoutMode: boolean;
  timeoutDelayMs: number;
  streamingFailMode: boolean;
  finishReasonMode: boolean;
  guardrailMode: boolean;
  maxTokensMode: boolean;
  forbiddenMode: boolean;
  rateLimitMode: boolean;
  paymentMode: boolean;
  transportMode: boolean;
  failMode: boolean; // Controls standard immediate fallback HTTP 500 failures
  rateLimitAfterCount?: number;
  failAfterCount?: number;
}

// --- Request State Tracker ---
export interface RequestState {
  globalRequestCount: number;
  failureTracker: Map<string, number>;
}

// --- Payload Formatting System ---
export interface MockPayloadFormatter {
  formatStreamChunk(chunkText: string): Record<string, unknown>;
  formatStreamEnd?(fullText: string): Record<string, unknown>;
  formatBatchResponse(fullText: string): Record<string, unknown>;
}

const chatFormatter: MockPayloadFormatter = {
  formatStreamChunk(chunkText: string) {
    return { choices: [{ delta: { content: chunkText } }] };
  },
  formatBatchResponse(fullText: string) {
    return { choices: [{ message: { role: "assistant", content: fullText } }] };
  },
};

const responsesFormatter: MockPayloadFormatter = {
  formatStreamChunk(chunkText: string) {
    return { type: "response.output_text.delta", delta: chunkText };
  },
  formatStreamEnd(fullText: string) {
    return { type: "response.output_text.done", text: fullText };
  },
  formatBatchResponse(fullText: string) {
    return {
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: fullText }],
        },
      ],
    };
  },
};

const legacyFormatter: MockPayloadFormatter = {
  formatStreamChunk(chunkText: string) {
    return { choices: [{ text: chunkText }] };
  },
  formatBatchResponse(fullText: string) {
    return { choices: [{ text: fullText }] };
  },
};

// --- Pipeline Execution Context ---
export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  payload: Record<string, unknown>;
  promptKey: string;
  isStream: boolean;
  url: string;
  config: MockServerConfig;
  state: RequestState;
  formatter: MockPayloadFormatter;
}

export type InterceptorFn = (ctx: RequestContext) => Promise<boolean>;

// --- Helper Functions ---
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function generateRandomParagraph(): string {
  const chunks = [
    "The integration of the neural architecture allows for seamless transitions between states.",
    "Observations indicate that the temperature parameter significantly alters the stochastic nature of the output tokens.",
    "In a production environment, individual task retries are essential for maintaining the integrity of the batch processing pipeline.",
    "Data streams were analyzed for consistency, ensuring that the simulated inference provides a realistic test case for the client-side logic.",
    "The quick brown fox jumps over the lazy dog, while the system monitors for potential 500 errors and network timeouts.",
    "By incrementing the seed or temperature, the user can explore the latent space of the model's predictive capabilities.",
  ];
  return chunks.sort(() => Math.random() - 0.5).join(" ");
}

function getTextChunks(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

// --- Stress Test Payload ---
const BASE_MARKDOWN = `
# Markdown Stress Test

This is a paragraph to test basic text rendering, including **bold**, *italics*, and \`inline code\`.

## 1. Tables
| Feature | Supported | Description |
| :--- | :---: | :--- |
| **Streaming** | y | Chunked data delivery |
| **Markdown** | y | Tables, lists, quotes |
| **Latency** | y | Configurable delay |

## 2. Nested Lists
- Parent Item 1
  - Child Item 1.1
    - Grandchild 1.1.1
    - Grandchild 1.1.2
  - Child Item 1.2
- Parent Item 2
  1. Numbered Child 2.1
  2. Numbered Child 2.2

## 3. Code Blocks
> "nyo nyo nyo."

\`\`\`typescript
function stressTest(chunks: string[]) {
  for (const chunk of chunks) {
    process(chunk);
  }
}
\`\`\`

## 4. List Grouping and Number Reset Test
999. Echoes of the Void
The old chronometer ticked, its brass gears grinding in the silence of the library...
No one had wound it for over a century, yet its pendulum swung with persistent, rhythmic defiance.

## 5. Whitespace Stress Test
This paragraph is immediately followed by six consecutive empty newlines.






This paragraph is separated from the one above it by those six empty lines. When 'stripEmpty' is enabled, these paragraphs should render back-to-back with zero blank line gaps. When 'markdownBrainRot' is active, they should render with exactly one blank line gap between them.

The next block tests empty lines that contain invisible spaces or tabs:
  
\t  
 

This line concludes the whitespace stress test.
---
`;

const FULL_MARKDOWN = BASE_MARKDOWN.repeat(MARKDOWN_REPETITIONS);
const TEXT_CHUNKS = getTextChunks(FULL_MARKDOWN, CHUNK_SIZE_CHARS);

// --- Pipeline Interceptors ---
// Interceptors return a boolean value.
// Returning true halts execution (short-circuits).
// Returning false delegates logic to the subsequent interceptor in the chain.

const handleTransportInterceptor: InterceptorFn = (ctx) => {
  if (!ctx.config.transportMode) {
    return Promise.resolve(false);
  }
  const attempts = ctx.state.failureTracker.get(ctx.promptKey) ?? 0;
  // Use 'maxAttempts - 1' to fail exactly maxAttempts - 1 times and allow the maxAttempts-th call to succeed.
  if (attempts < ctx.config.maxAttempts - 1) {
    ctx.state.failureTracker.set(ctx.promptKey, attempts + 1);
    console.log(
      `\x1b[31m[MOCK] TRANSPORT MODE: Abruptly resetting socket prior to headers (Attempt ${attempts + 1}/${ctx.config.maxAttempts})\x1b[0m`,
    );
    ctx.req.socket.destroy();
    return Promise.resolve(true);
  }
  console.log(
    `\x1b[32m[MOCK] TRANSPORT MODE: TCP connection allowed (Attempt ${attempts + 1}/${ctx.config.maxAttempts})\x1b[0m`,
  );
  return Promise.resolve(false);
};

const handleTimeoutInterceptor: InterceptorFn = (ctx) => {
  if (!ctx.config.timeoutMode) {
    return Promise.resolve(false);
  }
  const attempts = ctx.state.failureTracker.get(ctx.promptKey) ?? 0;
  // Apply the same offset constraint so the final retry does not incur timeout latencies
  if (attempts < ctx.config.maxAttempts - 1) {
    ctx.state.failureTracker.set(ctx.promptKey, attempts + 1);
    console.log(
      `\x1b[33m[MOCK] TIMEOUT MODE: Delaying ${ctx.config.timeoutDelayMs}ms (Attempt ${attempts + 1}/${ctx.config.maxAttempts})\x1b[0m`,
    );
    return sleep(ctx.config.timeoutDelayMs).then(() => false);
  }
  console.log(
    `\x1b[32m[MOCK] TIMEOUT MODE: Delay removed (Attempt ${attempts + 1}/${ctx.config.maxAttempts})\x1b[0m`,
  );
  return Promise.resolve(false);
};

const handleStaticErrorsInterceptor: InterceptorFn = (ctx) => {
  if (ctx.config.forbiddenMode) {
    console.log(
      `\x1b[31m[MOCK] FORBIDDEN MODE: Rejecting with HTTP 403 Forbidden\x1b[0m`,
    );
    ctx.res.writeHead(403, { "Content-Type": "application/json" });
    ctx.res.end(
      JSON.stringify({
        error: { message: "Simulated safety guardrail block." },
      }),
    );
    return Promise.resolve(true);
  }
  if (ctx.config.rateLimitMode) {
    console.log(
      `\x1b[31m[MOCK] RATELIMIT MODE: Rejecting with HTTP 429 Too Many Requests\x1b[0m`,
    );
    ctx.res.writeHead(429, { "Content-Type": "application/json" });
    ctx.res.end(
      JSON.stringify({
        error: { message: "Simulated rate limit exceeded." },
      }),
    );
    return Promise.resolve(true);
  }
  if (ctx.config.paymentMode) {
    console.log(
      `\x1b[31m[MOCK] PAYMENT MODE: Rejecting with HTTP 402 Payment Required\x1b[0m`,
    );
    ctx.res.writeHead(402, { "Content-Type": "application/json" });
    ctx.res.end(
      JSON.stringify({
        error: { message: "Simulated insufficient funds/billing error." },
      }),
    );
    return Promise.resolve(true);
  }
  return Promise.resolve(false);
};

const handleCountersInterceptor: InterceptorFn = (ctx) => {
  if (ctx.config.rateLimitAfterCount !== undefined) {
    if (ctx.state.globalRequestCount >= ctx.config.rateLimitAfterCount) {
      console.log(
        `\x1b[31m[MOCK] RATELIMIT AFTER MODE: Throttled (Request ${ctx.state.globalRequestCount + 1} > Limit ${ctx.config.rateLimitAfterCount}) -> HTTP 429\x1b[0m`,
      );
      ctx.res.writeHead(429, { "Content-Type": "application/json" });
      ctx.res.end(
        JSON.stringify({
          error: { message: "Simulated rate limit exceeded (after count)." },
        }),
      );
      return Promise.resolve(true);
    }
    console.log(
      `\x1b[32m[MOCK] RATELIMIT AFTER MODE: Allowed (Progress: ${ctx.state.globalRequestCount}/${ctx.config.rateLimitAfterCount})\x1b[0m`,
    );
  }

  if (ctx.config.failAfterCount !== undefined) {
    if (ctx.state.globalRequestCount >= ctx.config.failAfterCount) {
      console.log(
        `\x1b[31m[MOCK] FAIL AFTER MODE: Failing (Request ${ctx.state.globalRequestCount + 1} > Limit ${ctx.config.failAfterCount}) -> HTTP 500\x1b[0m`,
      );
      ctx.res.writeHead(500, { "Content-Type": "application/json" });
      ctx.res.end(
        JSON.stringify({
          error: { message: "Simulated task failure (after count)." },
        }),
      );
      return Promise.resolve(true);
    }
    console.log(
      `\x1b[32m[MOCK] FAIL AFTER MODE: Allowed (Progress: ${ctx.state.globalRequestCount}/${ctx.config.failAfterCount})\x1b[0m`,
    );
  }
  return Promise.resolve(false);
};

const handleSemanticFailuresInterceptor: InterceptorFn = async (ctx) => {
  const isSemanticFailActive =
    ctx.config.failMode ||
    ctx.config.streamingFailMode ||
    ctx.config.finishReasonMode ||
    ctx.config.guardrailMode ||
    ctx.config.maxTokensMode;

  if (!isSemanticFailActive) {
    return false;
  }

  const attempts = ctx.state.failureTracker.get(ctx.promptKey) ?? 0;
  // Exit the failure interceptor once the final attempt threshold is reached
  if (attempts >= ctx.config.maxAttempts - 1) {
    return false;
  }

  ctx.state.failureTracker.set(ctx.promptKey, attempts + 1);

  // Fallback failure triggers an immediate HTTP 500 across both streaming and non-streaming loops
  if (ctx.config.failMode) {
    console.log(
      `\x1b[31m[MOCK] FAIL MODE: Immediate HTTP 500 fallback (Attempt ${attempts + 1}/${ctx.config.maxAttempts})\x1b[0m`,
    );
    ctx.res.writeHead(500, { "Content-Type": "application/json" });
    ctx.res.end(
      JSON.stringify({ error: { message: "Simulated task failure." } }),
    );
    return true;
  }

  if (ctx.isStream) {
    // Semantic exceptions (guardrails, max tokens, finish reason) initiate with HTTP 200 OK headers
    // and deliver generated tokens up to the failure point, terminating with a structured error packet.
    ctx.res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let partialText = "";
    if (ctx.config.finishReasonMode) {
      partialText =
        "The Empire's declaration of war is merely... [Truncated due to mock network error]";
    } else if (ctx.config.guardrailMode) {
      partialText =
        "I cannot fulfill this request as it violates the system's content policy.";
    } else if (ctx.config.maxTokensMode) {
      partialText =
        "The generated text was cut short because the max token limit... [Truncated]";
    } else if (ctx.config.streamingFailMode) {
      partialText = generateRandomParagraph();
    }

    if (partialText) {
      const words = partialText.split(" ");
      const count = ctx.config.streamingFailMode
        ? Math.max(1, Math.floor(words.length / 2))
        : words.length;
      for (let i = 0; i < count; i++) {
        const chunk = words[i];
        if (chunk === undefined) continue;
        ctx.res.write(
          `data: ${JSON.stringify(ctx.formatter.formatStreamChunk(chunk + " "))}\n\n`,
        );
        await sleep(50);
      }
    }

    let errorPayload: Record<string, unknown> = {};

    if (ctx.config.finishReasonMode) {
      if (ctx.url.includes("/v1/chat/completions")) {
        errorPayload = {
          choices: [
            {
              index: 0,
              finish_reason: "error",
              error: {
                code: 502,
                message: "Network connection lost. (Simulated Stream)",
              },
              delta: { content: null },
            },
          ],
        };
      } else if (ctx.url.includes("/v1/responses")) {
        errorPayload = {
          type: "response.failed",
          response: {
            error: {
              code: 502,
              message: "Network connection lost. (Simulated Stream)",
            },
          },
        };
      } else {
        errorPayload = {
          choices: [
            {
              index: 0,
              finish_reason: "error",
              error: {
                code: 502,
                message: "Network connection lost. (Simulated Stream)",
              },
            },
          ],
        };
      }
    } else if (ctx.config.guardrailMode) {
      if (ctx.url.includes("/v1/chat/completions")) {
        errorPayload = {
          choices: [
            {
              index: 0,
              finish_reason: "content_filter",
              delta: { content: null },
            },
          ],
        };
      } else if (ctx.url.includes("/v1/responses")) {
        errorPayload = {
          type: "response.done",
          response: {
            status: "incomplete",
            incomplete_details: { reason: "content_filter" },
          },
        };
      } else {
        errorPayload = {
          choices: [
            {
              index: 0,
              finish_reason: "content_filter",
            },
          ],
        };
      }
    } else if (ctx.config.maxTokensMode) {
      if (ctx.url.includes("/v1/chat/completions")) {
        errorPayload = {
          choices: [
            {
              index: 0,
              finish_reason: "length",
              delta: { content: null },
            },
          ],
        };
      } else if (ctx.url.includes("/v1/responses")) {
        errorPayload = {
          type: "response.done",
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          },
        };
      } else {
        errorPayload = {
          choices: [
            {
              index: 0,
              finish_reason: "length",
            },
          ],
        };
      }
    } else if (ctx.config.streamingFailMode) {
      errorPayload = {
        error: { message: "Simulated 500 error during streaming." },
      };
      ctx.res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
      ctx.res.end();
      return true;
    }

    ctx.res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
    ctx.res.end();
  } else {
    // Non-streaming completions utilize standard HTTP 200 OK statuses for semantic terminations,
    // while infrastructure/mid-stream crashes output an HTTP 500 Internal Server Error.
    const isHttp500 = ctx.config.streamingFailMode;
    ctx.res.writeHead(isHttp500 ? 500 : 200, {
      "Content-Type": "application/json",
    });

    if (isHttp500) {
      ctx.res.end(
        JSON.stringify({ error: { message: "Simulated task failure." } }),
      );
      return true;
    }

    let payload: Record<string, unknown> = {};
    let truncatedText = "";
    if (ctx.config.finishReasonMode) {
      truncatedText =
        "The Empire's declaration of war is merely... [Truncated due to mock network error]";
    } else if (ctx.config.guardrailMode) {
      truncatedText =
        "I cannot fulfill this request as it violates the system's content policy.";
    } else if (ctx.config.maxTokensMode) {
      truncatedText =
        "The generated text was cut short because the max token limit... [Truncated]";
    }

    if (ctx.url.includes("/v1/chat/completions")) {
      if (ctx.config.finishReasonMode) {
        payload = {
          choices: [
            {
              index: 0,
              finish_reason: "error",
              error: {
                code: 502,
                message: "Network connection lost. (Simulated Non-Stream)",
              },
              message: { role: "assistant", content: truncatedText },
            },
          ],
          error: null,
        };
      } else if (ctx.config.guardrailMode) {
        payload = {
          choices: [
            {
              index: 0,
              finish_reason: "content_filter",
              message: { role: "assistant", content: truncatedText },
            },
          ],
          error: null,
        };
      } else if (ctx.config.maxTokensMode) {
        payload = {
          choices: [
            {
              index: 0,
              finish_reason: "length",
              message: { role: "assistant", content: truncatedText },
            },
          ],
          error: null,
        };
      }
    } else if (ctx.url.includes("/v1/responses")) {
      if (ctx.config.finishReasonMode) {
        payload = {
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: truncatedText }],
            },
          ],
          choices: [
            {
              index: 0,
              finish_reason: "error",
              error: {
                code: 502,
                message: "Network connection lost. (Simulated Non-Stream)",
              },
            },
          ],
          error: null,
        };
      } else if (ctx.config.guardrailMode) {
        payload = {
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: truncatedText }],
            },
          ],
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
          error: null,
        };
      } else if (ctx.config.maxTokensMode) {
        payload = {
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: truncatedText }],
            },
          ],
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          error: null,
        };
      }
    } else {
      // /v1/completions (Legacy)
      if (ctx.config.finishReasonMode) {
        payload = {
          choices: [
            {
              index: 0,
              finish_reason: "error",
              error: {
                code: 502,
                message: "Network connection lost. (Simulated Non-Stream)",
              },
              text: truncatedText,
            },
          ],
          error: null,
        };
      } else if (ctx.config.guardrailMode) {
        payload = {
          choices: [
            {
              index: 0,
              finish_reason: "content_filter",
              text: truncatedText,
            },
          ],
          error: null,
        };
      } else if (ctx.config.maxTokensMode) {
        payload = {
          choices: [
            {
              index: 0,
              finish_reason: "length",
              text: truncatedText,
            },
          ],
          error: null,
        };
      }
    }

    ctx.res.end(JSON.stringify(payload));
  }
  return true;
};

// --- Standard Response Delivery Engine ---

async function sendStandardResponse(ctx: RequestContext): Promise<void> {
  const isStream = ctx.isStream;
  const text = ctx.config.markdownHell
    ? FULL_MARKDOWN
    : generateRandomParagraph();

  console.log(
    `\x1b[32m[MOCK] STATUS: SUCCESS | Temp: ${ctx.payload["temperature"] ?? 0} | Stream: ${isStream}\x1b[0m`,
  );

  if (
    ctx.config.rateLimitAfterCount !== undefined ||
    ctx.config.failAfterCount !== undefined
  ) {
    ctx.state.globalRequestCount++;
    if (ctx.config.rateLimitAfterCount !== undefined) {
      console.log(
        `\x1b[34m[MOCK] RATELIMIT AFTER Progress: ${ctx.state.globalRequestCount}/${ctx.config.rateLimitAfterCount} successfully answered\x1b[0m`,
      );
    } else if (ctx.config.failAfterCount !== undefined) {
      console.log(
        `\x1b[34m[MOCK] FAIL AFTER Progress: ${ctx.state.globalRequestCount}/${ctx.config.failAfterCount} successfully answered\x1b[0m`,
      );
    }
  }

  if (isStream) {
    ctx.res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const latency = ctx.config.markdownHell
      ? ctx.config.streamLatencyMs
      : ctx.config.defaultLatencyMs;
    const textChunks = ctx.config.markdownHell
      ? TEXT_CHUNKS
      : getTextChunks(text, ctx.config.chunkSizeChars);

    for (const segment of textChunks) {
      if (segment === undefined) continue;
      // Emit keep-alive comments before streaming payload chunks to protect slow clients from structural timeouts
      ctx.res.write(": keep-alive\n\n");
      ctx.res.write(
        `data: ${JSON.stringify(ctx.formatter.formatStreamChunk(segment))}\n\n`,
      );
      if (latency > 0) {
        await sleep(latency);
      }
    }

    if (ctx.formatter.formatStreamEnd) {
      ctx.res.write(": keep-alive\n\n");
      ctx.res.write(
        `data: ${JSON.stringify(ctx.formatter.formatStreamEnd(text))}\n\n`,
      );
    }

    ctx.res.write(": keep-alive\n\n");
    ctx.res.write("data: [DONE]\n\n");
    ctx.res.end();
  } else {
    ctx.res.writeHead(200, { "Content-Type": "application/json" });

    // Prepend leading blank lines to test robust parsing of payloads with unexpected pre-JSON whitespace
    ctx.res.write("\n\n\n\n\n");
    ctx.res.end(JSON.stringify(ctx.formatter.formatBatchResponse(text)));
  }
}

// --- Combined Interceptor Pipeline ---

const pipeline: InterceptorFn[] = [
  handleTransportInterceptor,
  handleTimeoutInterceptor,
  handleStaticErrorsInterceptor,
  handleCountersInterceptor,
  handleSemanticFailuresInterceptor,
];

// --- Server Request Routing & Lifecycle ---

const state: RequestState = {
  globalRequestCount: 0,
  failureTracker: new Map<string, number>(),
};

// Global Configuration Initialization
const args = process.argv.slice(2);
const config: MockServerConfig = {
  port: PORT,
  markdownHell: MARKDOWN_HELL_MODE,
  markdownRepetitions: MARKDOWN_REPETITIONS,
  chunkSizeChars: CHUNK_SIZE_CHARS,
  streamLatencyMs: STREAM_LATENCY_MS,
  defaultLatencyMs: DEFAULT_LATENCY_MS,
  maxAttempts: MAX_ATTEMPTS,
  timeoutMode: process.argv.includes("--timeout"),
  timeoutDelayMs: TIMEOUT_DELAY_MS,
  streamingFailMode: process.argv.includes("--streamingfail"),
  finishReasonMode: process.argv.includes("--finishreason"),
  guardrailMode: process.argv.includes("--guardrail"),
  maxTokensMode: process.argv.includes("--maxtokens"),
  forbiddenMode: process.argv.includes("--forbidden"),
  rateLimitMode: process.argv.includes("--ratelimit"),
  paymentMode: process.argv.includes("--payment"),
  transportMode: process.argv.includes("--transport"),
  failMode: process.argv.includes("--fail"),
};

// Parse CLI options directly to targeted configuration parameters
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === undefined) continue;

  if (arg === "--port") {
    const val = args[i + 1];
    if (val !== undefined) {
      config.port = parseInt(val, 10);
      i++;
    }
  } else if (arg === "--markdown") {
    config.markdownHell = true;
  } else if (arg === "--timeout") {
    config.timeoutMode = true;
  } else if (arg === "--streamingfail") {
    config.streamingFailMode = true;
  } else if (arg === "--finishreason") {
    config.finishReasonMode = true;
  } else if (arg === "--guardrail") {
    config.guardrailMode = true;
  } else if (arg === "--maxtokens") {
    config.maxTokensMode = true;
  } else if (arg === "--forbidden") {
    config.forbiddenMode = true;
  } else if (arg === "--ratelimit") {
    config.rateLimitMode = true;
  } else if (arg === "--payment") {
    config.paymentMode = true;
  } else if (arg === "--transport") {
    config.transportMode = true;
    const val = args[i + 1];
    if (val !== undefined && !val.startsWith("-")) {
      config.maxAttempts = parseInt(val, 10);
      i++;
    } else {
      config.maxAttempts = 2; // Default to 2 attempts (1 failure) for transport simulations
    }
  } else if (arg === "--ratelimitafter") {
    const val = args[i + 1];
    if (val !== undefined) {
      config.rateLimitAfterCount = parseInt(val, 10);
      i++;
    }
  } else if (arg === "--failafter") {
    const val = args[i + 1];
    if (val !== undefined) {
      config.failAfterCount = parseInt(val, 10);
      i++;
    }
  } else if (arg === "--fail") {
    config.failMode = true;
  }
}

async function requestHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  console.log(
    "\n================================================================",
  );
  console.log(
    `[MOCK] Received request: ${req.method ?? "UNKNOWN"} ${req.url ?? ""}`,
  );
  if (!config.markdownHell) {
    console.log("[MOCK] Request Headers:", req.headers);
  }

  let body = "";
  try {
    for await (const chunk of req) {
      body += (chunk as Buffer).toString("utf-8");
    }
  } catch (err) {
    console.error("[MOCK] Request streaming payload error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Payload stream broken" }));
    return;
  }

  if (!config.markdownHell) {
    console.log("[MOCK] Request Body:", body);
  }

  let payload: Record<string, unknown> = {};
  if (body) {
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      console.error("[MOCK] Warning: Could not parse request body as JSON.");
    }
  }

  const url = req.url ?? "";
  const isStream = payload["stream"] === true;

  // Select response formatting system matching the current context URL pathing
  let formatter: MockPayloadFormatter = chatFormatter;
  if (url.includes("/v1/responses")) {
    formatter = responsesFormatter;
  } else if (url.includes("/v1/completions")) {
    formatter = legacyFormatter;
  }

  // Generate a tracking key from payload data to maintain state consistency across retry attempts
  let promptKey = body;
  const messages = payload["messages"];
  const input = payload["input"];
  const prompt = payload["prompt"];

  if (messages !== undefined) {
    promptKey = JSON.stringify(messages);
  } else if (input !== undefined) {
    promptKey = JSON.stringify(input);
  } else if (prompt !== undefined) {
    promptKey = JSON.stringify(prompt);
  }

  const ctx: RequestContext = {
    req,
    res,
    payload,
    promptKey,
    isStream,
    url,
    config,
    state,
    formatter,
  };

  // Run the sequential request pipeline
  for (const interceptor of pipeline) {
    try {
      const isIntercepted = await interceptor(ctx);
      if (isIntercepted) {
        return; // Interceptor handled request lifecycle early
      }
    } catch (err) {
      console.error("[MOCK] Pipeline processing failed:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Pipeline processing failure" }));
      }
      return;
    }
  }

  // Routing validation
  const isRecognizedUrl =
    url.includes("/v1/chat/completions") ||
    url.includes("/v1/responses") ||
    url.includes("/v1/completions");

  if (!isRecognizedUrl) {
    console.log(`\x1b[31m[MOCK] Unknown endpoint requested: ${url}\x1b[0m`);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Endpoint not mocked." }));
    return;
  }

  // Deliver response payload
  try {
    await sendStandardResponse(ctx);
  } catch (err) {
    console.error("[MOCK] Error handling standard output response:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Mock Response Error" }));
    }
  }
}

const server = http.createServer((req, res) => {
  void requestHandler(req, res);
});

server.listen(config.port, () => {
  console.log(
    "================================================================",
  );
  console.log(
    `  Unified Mock Server running on http://localhost:${config.port}`,
  );
  console.log(`  SUPPORTED ENDPOINTS:`);
  console.log(`   - /v1/chat/completions`);
  console.log(`   - /v1/responses`);
  console.log(`   - /v1/completions`);
  console.log("");

  if (config.markdownHell) {
    console.log(`  MODE: \x1b[35mMARKDOWN HELL (Stress Test)\x1b[0m`);
    console.log(
      `  - Repetitions: ${config.markdownRepetitions} (${FULL_MARKDOWN.length} chars)`,
    );
    console.log(`  - Stream Latency: ${config.streamLatencyMs}ms per chunk`);
    console.log(`  - Chunk Size: ${config.chunkSizeChars} characters`);
  } else if (config.timeoutMode) {
    console.log(`  MODE: \x1b[33mTIMEOUT SIMULATION\x1b[0m`);
    console.log(
      `  BEHAVIOR: ${config.maxAttempts} Delays (${config.timeoutDelayMs / 1000}s) -> 1 Success (No delay)`,
    );
  } else if (config.transportMode) {
    console.log(`  MODE: \x1b[31mTRANSPORT SIMULATION\x1b[0m`);
    console.log(
      `  BEHAVIOR: ${config.maxAttempts} Abrupt Connection Resets (Socket destroy prior to headers) -> 1 Success`,
    );
  } else if (config.streamingFailMode) {
    console.log(`  MODE: \x1b[31mSTREAMING FAILURE SIMULATION\x1b[0m`);
    console.log(
      `  BEHAVIOR: ${config.maxAttempts} Failures (Mid-stream 500 error) -> 1 Success`,
    );
  } else if (config.finishReasonMode) {
    console.log(`  MODE: \x1b[31mFINISH REASON SIMULATION\x1b[0m`);
    console.log(
      `  BEHAVIOR: ${config.maxAttempts} Nested Error HTTP 200 Failures (finish_reason: 'error') -> 1 Success`,
    );
  } else if (config.guardrailMode) {
    console.log(`  MODE: \x1b[31mGUARDRAIL / CONTENT FILTER SIMULATION\x1b[0m`);
    console.log(
      `  BEHAVIOR: ${config.maxAttempts} HTTP 200 Content Filter Blocks (finish_reason: 'content_filter') -> 1 Success`,
    );
  } else if (config.maxTokensMode) {
    console.log(`  MODE: \x1b[31mMAX TOKENS / EXHAUSTION SIMULATION\x1b[0m`);
    console.log(
      `  BEHAVIOR: ${config.maxAttempts} HTTP 200 Length Limits (finish_reason: 'length') -> 1 Success`,
    );
  } else if (config.forbiddenMode) {
    console.log(`  MODE: \x1b[31mFORBIDDEN (403) SIMULATION\x1b[0m`);
  } else if (config.rateLimitMode) {
    console.log(`  MODE: \x1b[31mRATELIMIT (429) SIMULATION\x1b[0m`);
  } else if (config.paymentMode) {
    console.log(`  MODE: \x1b[31mPAYMENT (402) SIMULATION\x1b[0m`);
  } else if (config.rateLimitAfterCount !== undefined) {
    console.log(
      `  MODE: \x1b[31mRATELIMIT AFTER (${config.rateLimitAfterCount}) SIMULATION\x1b[0m`,
    );
  } else if (config.failAfterCount !== undefined) {
    console.log(
      `  MODE: \x1b[31mFAIL AFTER (${config.failAfterCount}) SIMULATION\x1b[0m`,
    );
  } else if (config.failMode) {
    console.log(`  MODE: \x1b[34mSTANDARD ERROR SIMULATION\x1b[0m`);
    console.log(
      `  BEHAVIOR: ${config.maxAttempts} Failures (HTTP 500) -> 1 Success`,
    );
  } else {
    console.log(`  MODE: \x1b[32mPURE MOCK MODE (No Failures)\x1b[0m`);
  }
  console.log(
    "================================================================",
  );
});
