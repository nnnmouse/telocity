// oxlint-disable require-await
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

import type { Message } from "../src/index.ts";

import * as appCore from "../src/libs/core/index.ts";
import { stripGarbageNewLines } from "../src/libs/LLM/index.ts";
import * as llmNetwork from "../src/libs/LLM/LLMNetwork.ts";

let initialized: boolean;
export let appState: Awaited<ReturnType<typeof appCore.AppStateSingleton.init>>;

export const SOURCE_FILE = "./tests/data/source.txt";
export const SOURCE_FILE2 = "./tests/data/source2.txt";
export let sourceFileContent: string;
export let sourceFileContent2: string;
export let sourceFileHash: string;
export let sourceFileHash2: string;

export async function withCapturedConsole(fn: () => Promise<void>) {
  const capturedChunks: string[] = [];
  const spies: ReturnType<typeof vi.spyOn>[] = [];

  const captureString = (chunk: string | Buffer): void => {
    const str = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    capturedChunks.push(str);
  };

  spies.push(
    vi.spyOn(appCore, "log").mockImplementation((...msgs: unknown[]) => {
      const line = msgs.map((msg) => String(msg)).join(" ");
      capturedChunks.push(line);
    }),
    vi.spyOn(appCore, "errlog").mockImplementation((...msgs: unknown[]) => {
      const line = msgs.map((msg) => String(msg)).join(" ");
      capturedChunks.push(line);
    }),
  );

  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  process.stdout.write = ((chunk: string | Buffer): boolean => {
    captureString(chunk);
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Buffer): boolean => {
    captureString(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    await fn();
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    spies.forEach((spy) => spy.mockRestore());
  }

  return capturedChunks.join("\n");
}

export type TestEnvironment = {
  tmpDir: string;
  outDir: string;
  targetFile: string;
  originalStateDir: string;
};

export async function setupTestEnvironment(): Promise<TestEnvironment> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "integration-test-"));
  const outDir = path.join(tmpDir, "output");
  await fs.mkdir(outDir, { recursive: true });
  const targetFile = path.join(outDir, "processed.txt");

  const originalStateDir = appState.STATE_DIR;
  Object.defineProperty(appState, "STATE_DIR", {
    value: path.join(tmpDir, "state"),
    writable: true,
    configurable: true,
  });
  await fs.mkdir(appState.STATE_DIR, { recursive: true });

  return { tmpDir, outDir, targetFile, originalStateDir };
}

export async function teardownTestEnvironment({
  tmpDir,
  originalStateDir,
}: Partial<TestEnvironment>): Promise<void> {
  if (originalStateDir) {
    const appState = appCore.AppStateSingleton.getInstance();
    Object.defineProperty(appState, "STATE_DIR", {
      value: originalStateDir,
      writable: true,
      configurable: true,
    });
  }

  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

interface MockPayload {
  stream?: boolean;
  model?: string;
  messages?: Message[];
  prompt?: string;
  input?: string | unknown;
}

export function setupLlmFetchMock(): void {
  vi.spyOn(llmNetwork, "llmFetch").mockImplementation(async (url, options) => {
    const bodyParsed: MockPayload = options.body
      ? (JSON.parse(options.body) as MockPayload)
      : {};
    const isStreaming = bodyParsed.stream === true;

    // Extract prompt/message content dynamically using safe type narrowing
    let promptContent = "";
    if (bodyParsed.messages && Array.isArray(bodyParsed.messages)) {
      const userMsg = bodyParsed.messages.find(
        (m: Message) => m.role === "user",
      );
      if (userMsg) {
        const content = userMsg.content;
        promptContent =
          typeof content === "string" ? content : JSON.stringify(content);
      }
    } else if (bodyParsed.prompt) {
      promptContent = bodyParsed.prompt;
    } else if (bodyParsed.input) {
      const inputVal = bodyParsed.input;
      promptContent =
        typeof inputVal === "string" ? inputVal : JSON.stringify(inputVal);
    } else {
      promptContent = JSON.stringify(bodyParsed);
    }

    // Standardize expected dummy text for matching test assertions
    const mockResponseText = `Mocked LLM Response for: ${promptContent}. Dummy LLM Call included here.`;

    const isResponsesEndpoint = url.endsWith("/responses");
    const isLegacyCompletions =
      url.endsWith("/completions") && !url.endsWith("/chat/completions");

    // 1. Build standard non-streaming response payloads
    let mockJson: Record<string, unknown>;
    if (isResponsesEndpoint) {
      mockJson = {
        id: "resp-mock",
        object: "response",
        model: bodyParsed.model || "mock-model",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: mockResponseText }],
          },
        ],
      };
    } else if (isLegacyCompletions) {
      mockJson = {
        id: "cmpl-mock",
        object: "text_completion",
        created: 1677652288,
        model: bodyParsed.model || "mock-model",
        choices: [{ index: 0, text: mockResponseText, finish_reason: "stop" }],
      };
    } else {
      mockJson = {
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: 1677652288,
        model: bodyParsed.model || "mock-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: mockResponseText },
            finish_reason: "stop",
          },
        ],
      };
    }

    // 2. Handle Streaming requests
    if (isStreaming) {
      let sseChunks: string[] = [];

      if (isResponsesEndpoint) {
        sseChunks = [
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: `Mocked LLM Response for: ${promptContent}. ` })}\n\n`,
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Dummy LLM Call stream chunk." })}\n\n`,
          "data: [DONE]\n\n",
        ];
      } else if (isLegacyCompletions) {
        sseChunks = [
          `data: ${JSON.stringify({ choices: [{ text: `Mocked LLM Response for: ${promptContent}. ` }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ text: "Dummy LLM Call stream chunk." }] })}\n\n`,
          "data: [DONE]\n\n",
        ];
      } else {
        sseChunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: `Mocked LLM Response for: ${promptContent}. ` } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Dummy LLM Call stream chunk." } }] })}\n\n`,
          "data: [DONE]\n\n",
        ];
      }

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of sseChunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      return {
        ok: true,
        status: 200,
        text: async () => sseChunks.join(""),
        json: async () => mockJson,
        body: stream,
      } as unknown as Response;
    }

    // Non-streaming response return
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(mockJson),
      json: async () => mockJson,
      body: null,
    } as unknown as Response;
  });
}

export async function initTest() {
  if (initialized) return;
  appState = await appCore.AppStateSingleton.init(true);

  // Register standard network boundary spy
  setupLlmFetchMock();

  sourceFileContent = await fs.readFile(SOURCE_FILE, "utf-8");
  sourceFileContent2 = await fs.readFile(SOURCE_FILE2, "utf-8");
  sourceFileHash = appCore.fastHash(stripGarbageNewLines(sourceFileContent));
  sourceFileHash2 = appCore.fastHash(stripGarbageNewLines(sourceFileContent2));
  initialized = true;
}

export interface CapturedRunnerState {
  chunkSize?: number;
  batchSize?: number;
  model?: [boolean, string];
  url?: string;
  endpoint?: string;
}
