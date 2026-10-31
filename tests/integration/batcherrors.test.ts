// oxlint-disable require-await
import fs from "node:fs/promises";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { LLMJSONLBatcher } from "../../src/libs/LLM/LLMJSONLBatcher.ts";
import * as llmNetwork from "../../src/libs/LLM/LLMNetwork.ts";
import { main } from "../../src/main.ts";
import {
  initTest,
  setupTestEnvironment,
  teardownTestEnvironment,
  type TestEnvironment,
  withCapturedConsole,
} from "../testutils.ts";

interface LLMBatcherWithDelay {
  interruptibleDelay(ms: number): Promise<void>;
}

describe("Batch Error Boundary Handling", () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    await initTest();
    testEnv = await setupTestEnvironment();
  });

  afterAll(async () => {
    await teardownTestEnvironment(testEnv);
  });

  beforeEach(async () => {
    process.env["LC_ALL"] = "en_US.UTF-8";
    process.env["LANG"] = "en_US.UTF-8";
    await fs.rm(testEnv.targetFile, { force: true });
  });

  test("bypasses automatic retries on HTTP 403 but allows other requests in the batch to continue", async () => {
    const sourceJsonlPath = path.join(testEnv.tmpDir, "test_403.jsonl");

    const request1 = {
      custom_id: "req-fail-403",
      method: "POST",
      url: "/v1/chat/completions",
      body: { messages: [{ role: "user", content: "trigger 403 error" }] },
      telocity: {
        rpm: 10000,
        retryDelay: 1,
      },
    };
    const request2 = {
      custom_id: "req-success-ok",
      method: "POST",
      url: "/v1/chat/completions",
      body: { messages: [{ role: "user", content: "successful request" }] },
      telocity: {
        rpm: 10000,
        retryDelay: 1,
      },
    };

    await fs.writeFile(
      sourceJsonlPath,
      JSON.stringify(request1) + "\n" + JSON.stringify(request2) + "\n",
    );

    let reqFail403Attempts = 0;
    let reqSuccessOkAttempts = 0;

    const fetchSpy = vi
      .spyOn(llmNetwork, "llmFetch")
      .mockImplementation(async (url, options) => {
        const is403Request =
          url.includes("trigger 403 error") ||
          (typeof options.body === "string" &&
            options.body.includes("trigger 403 error"));

        if (is403Request) {
          reqFail403Attempts++;
          const mockErrorJson = {
            error: {
              message: "Rejected by Safety Guardrails",
              type: "invalid_request_error",
              code: "safety_policy_violation",
            },
          };
          return {
            ok: false,
            status: 403,
            headers: {
              get: () => null,
            },
            text: async () => JSON.stringify(mockErrorJson),
            json: async () => mockErrorJson,
            body: null,
          } as unknown as Response;
        }

        reqSuccessOkAttempts++;
        const mockSuccessJson = {
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: 1677652288,
          model: "mock-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Successful response text",
              },
              finish_reason: "stop",
            },
          ],
        };
        return {
          ok: true,
          status: 200,
          headers: {
            get: () => null,
          },
          text: async () => JSON.stringify(mockSuccessJson),
          json: async () => mockSuccessJson,
          body: null,
        } as unknown as Response;
      });

    // Force sequential processing (one-by-one) via batch size and parallel constraints to test isolation
    const args = [
      "br",
      sourceJsonlPath,
      testEnv.targetFile,
      "-b",
      "1",
      "-P",
      "1",
    ];

    const output = await withCapturedConsole(async () => {
      await main(args, false);
    });

    expect(output).toContain("[FAILED: req-fail-403]");
    expect(output).toContain("[OK: req-success-ok]");

    // Verify that the failed 403 request made exactly ONE attempt (proving automatic retries were bypassed)
    expect(reqFail403Attempts).toBe(1);
    expect(reqSuccessOkAttempts).toBe(1);

    // Verify the content written to the target results file
    const targetContent = await fs.readFile(testEnv.targetFile, "utf-8");
    const lines = targetContent.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(2);

    const parsedLine1 = JSON.parse(lines[0]!);
    const parsedLine2 = JSON.parse(lines[1]!);

    expect(parsedLine1.custom_id).toBe("req-fail-403");
    expect(parsedLine1.error).not.toBeNull();
    expect(parsedLine1.error.message).toContain("status 403");

    expect(parsedLine2.custom_id).toBe("req-success-ok");
    expect(parsedLine2.response.body.choices[0].message.content).toBe(
      "Successful response text",
    );

    fetchSpy.mockRestore();
  });

  test("honors the Retry-After header on transient/retryable errors to dynamically adjust the backoff delay", async () => {
    const sourceJsonlPath = path.join(testEnv.tmpDir, "test_retry_after.jsonl");

    const request = {
      custom_id: "req-retry-after",
      method: "POST",
      url: "/v1/chat/completions",
      body: { messages: [{ role: "user", content: "test retry after" }] },
      telocity: {
        rpm: 10000,
        retryDelay: 1,
      },
    };

    await fs.writeFile(sourceJsonlPath, JSON.stringify(request) + "\n");

    let attempts = 0;
    const delaySpy = vi
      .spyOn(
        LLMJSONLBatcher.prototype as unknown as LLMBatcherWithDelay,
        "interruptibleDelay",
      )
      .mockImplementation(async () => {});

    const fetchSpy = vi
      .spyOn(llmNetwork, "llmFetch")
      .mockImplementation(async () => {
        attempts++;
        if (attempts === 1) {
          const mockErrorJson = {
            error: {
              message: "Bad Gateway",
              type: "server_error",
              code: "bad_gateway",
            },
          };
          return {
            ok: false,
            status: 502,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === "retry-after" ? "3" : null,
            },
            text: async () => JSON.stringify(mockErrorJson),
            json: async () => mockErrorJson,
            body: null,
          } as unknown as Response;
        }

        const mockSuccessJson = {
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: 1677652288,
          model: "mock-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Recovered successfully",
              },
              finish_reason: "stop",
            },
          ],
        };
        return {
          ok: true,
          status: 200,
          headers: {
            get: () => null,
          },
          text: async () => JSON.stringify(mockSuccessJson),
          json: async () => mockSuccessJson,
          body: null,
        } as unknown as Response;
      });

    const args = [
      "br",
      sourceJsonlPath,
      testEnv.targetFile,
      "-b",
      "1",
      "-P",
      "1",
    ];

    await withCapturedConsole(async () => {
      await main(args, false);
    });

    expect(attempts).toBe(2);
    expect(delaySpy).toHaveBeenCalled();

    const calls = delaySpy.mock.calls as unknown as [number][];
    const firstCallDelay = calls[1]?.[0];
    expect(firstCallDelay).toBeDefined();
    expect(firstCallDelay).toBeGreaterThanOrEqual(3000);
    expect(firstCallDelay).toBeLessThan(4100);

    fetchSpy.mockRestore();
    delaySpy.mockRestore();
  });

  test("handles Responses API mid-stream failures correctly by parsing response.failed SSE events", async () => {
    const sourceJsonlPath = path.join(
      testEnv.tmpDir,
      "test_responses_failed.jsonl",
    );

    const request = {
      custom_id: "req-responses-fail",
      method: "POST",
      url: "/v1/responses",
      body: { stream: true },
      telocity: {
        endpoint: "responses",
        rpm: 10000,
        retryDelay: 1,
      },
    };

    await fs.writeFile(sourceJsonlPath, JSON.stringify(request) + "\n");

    const sseChunks = [
      `data: ${JSON.stringify({
        type: "response.failed",
        response: {
          id: "resp_abc",
          status: "failed",
          error: {
            code: "server_error",
            message: "Responses failed midstream",
          },
        },
      })}\n\n`,
      "data: [DONE]\n\n",
    ];

    const encoder = new TextEncoder();

    const delaySpy = vi
      .spyOn(
        LLMJSONLBatcher.prototype as unknown as LLMBatcherWithDelay,
        "interruptibleDelay",
      )
      .mockImplementation(async () => {});

    const fetchSpy = vi
      .spyOn(llmNetwork, "llmFetch")
      .mockImplementation(async () => {
        // Construct a fresh, unconsumed stream on every call to prevent stream-locking across retries
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
          headers: {
            get: () => null,
          },
          text: async () => sseChunks.join(""),
          json: async () => ({}),
          body: stream,
        } as unknown as Response;
      });

    const args = [
      "br",
      sourceJsonlPath,
      testEnv.targetFile,
      "-b",
      "1",
      "-P",
      "1",
      "-T",
    ];

    const output = await withCapturedConsole(async () => {
      await main(args, false);
    });

    expect(output).toContain("[FAILED: req-responses-fail]");

    // Verify the failure content is written to the destination file
    const targetContent = await fs.readFile(testEnv.targetFile, "utf-8");
    expect(targetContent.toLowerCase()).toContain("responses failed midstream");

    fetchSpy.mockRestore();
    delaySpy.mockRestore();
  });

  test("abruptly halts and cancels the entire batch execution pool on HTTP 429", async () => {
    const sourceJsonlPath = path.join(testEnv.tmpDir, "test_429.jsonl");

    const request1 = {
      custom_id: "req-fail-429",
      method: "POST",
      url: "/v1/chat/completions",
      body: { messages: [{ role: "user", content: "rate limit me" }] },
      telocity: {
        rpm: 10000,
        retryDelay: 1,
      },
    };
    const request2 = {
      custom_id: "req-should-not-run",
      method: "POST",
      url: "/v1/chat/completions",
      body: {
        messages: [{ role: "user", content: "this should never execute" }],
      },
      telocity: {
        rpm: 10000,
        retryDelay: 1,
      },
    };

    await fs.writeFile(
      sourceJsonlPath,
      JSON.stringify(request1) + "\n" + JSON.stringify(request2) + "\n",
    );

    let reqFail429Attempts = 0;
    let reqShouldNotRunAttempts = 0;

    const fetchSpy = vi
      .spyOn(llmNetwork, "llmFetch")
      .mockImplementation(async (url, options) => {
        const is429Request =
          url.includes("rate limit me") ||
          (typeof options.body === "string" &&
            options.body.includes("rate limit me"));

        if (is429Request) {
          reqFail429Attempts++;
          const mockErrorJson = {
            error: {
              message: "Rate limit exceeded. Please try again later.",
              type: "requests",
              code: "rate_limit_exceeded",
            },
          };
          return {
            ok: false,
            status: 429,
            headers: {
              get: () => null,
            },
            text: async () => JSON.stringify(mockErrorJson),
            json: async () => mockErrorJson,
            body: null,
          } as unknown as Response;
        }

        reqShouldNotRunAttempts++;
        return {
          ok: true,
          status: 200,
          headers: {
            get: () => null,
          },
          text: async () => "{}",
          json: async () => ({}),
          body: null,
        } as unknown as Response;
      });

    // Force sequential batches to prove early cancellation halts downstream queue items
    const args = [
      "br",
      sourceJsonlPath,
      testEnv.targetFile,
      "-b",
      "1",
      "-P",
      "1",
    ];

    const output = await withCapturedConsole(async () => {
      await main(args, false);
    });

    expect(output.toLowerCase()).toContain("error 429");
    expect(output.toLowerCase()).toContain("terminated");

    // Verify that the subsequent request was never executed
    expect(reqFail429Attempts).toBe(1);
    expect(reqShouldNotRunAttempts).toBe(0);

    // Verify that progress was partially saved with the failure block
    const targetContent = await fs.readFile(testEnv.targetFile, "utf-8");
    const lines = targetContent.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);

    const parsedLine = JSON.parse(lines[0]!);
    expect(parsedLine.custom_id).toBe("req-fail-429");
    expect(parsedLine.error).not.toBeNull();
    expect(parsedLine.error.message).toContain("status 429");

    fetchSpy.mockRestore();
  });

  test("abruptly halts and cancels the entire batch execution pool on HTTP 402", async () => {
    const sourceJsonlPath = path.join(testEnv.tmpDir, "test_402.jsonl");

    const request1 = {
      custom_id: "req-fail-402",
      method: "POST",
      url: "/v1/chat/completions",
      body: { messages: [{ role: "user", content: "out of budget" }] },
      telocity: {
        rpm: 10000,
        retryDelay: 1,
      },
    };
    const request2 = {
      custom_id: "req-should-not-run",
      method: "POST",
      url: "/v1/chat/completions",
      body: {
        messages: [{ role: "user", content: "this should never execute" }],
      },
      telocity: {
        rpm: 10000,
        retryDelay: 1,
      },
    };

    await fs.writeFile(
      sourceJsonlPath,
      JSON.stringify(request1) + "\n" + JSON.stringify(request2) + "\n",
    );

    let reqFail402Attempts = 0;
    let reqShouldNotRunAttempts = 0;

    const fetchSpy = vi
      .spyOn(llmNetwork, "llmFetch")
      .mockImplementation(async (url, options) => {
        const is402Request =
          url.includes("out of budget") ||
          (typeof options.body === "string" &&
            options.body.includes("out of budget"));

        if (is402Request) {
          reqFail402Attempts++;
          const mockErrorJson = {
            error: {
              message: "Insufficient Credits / Payment Required",
              type: "billing",
              code: "insufficient_funds",
            },
          };
          return {
            ok: false,
            status: 402,
            headers: {
              get: () => null,
            },
            text: async () => JSON.stringify(mockErrorJson),
            json: async () => mockErrorJson,
            body: null,
          } as unknown as Response;
        }

        reqShouldNotRunAttempts++;
        return {
          ok: true,
          status: 200,
          headers: {
            get: () => null,
          },
          text: async () => "{}",
          json: async () => ({}),
          body: null,
        } as unknown as Response;
      });

    // Force sequential batches to prove early cancellation halts downstream queue items
    const args = [
      "br",
      sourceJsonlPath,
      testEnv.targetFile,
      "-b",
      "1",
      "-P",
      "1",
    ];

    const output = await withCapturedConsole(async () => {
      await main(args, false);
    });

    expect(output.toLowerCase()).toContain("error 402");
    expect(output.toLowerCase()).toContain("terminated");

    // Verify that the subsequent request was never executed
    expect(reqFail402Attempts).toBe(1);
    expect(reqShouldNotRunAttempts).toBe(0);

    // Verify that progress was partially saved with the failure block
    const targetContent = await fs.readFile(testEnv.targetFile, "utf-8");
    const lines = targetContent.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);

    const parsedLine = JSON.parse(lines[0]!);
    expect(parsedLine.custom_id).toBe("req-fail-402");
    expect(parsedLine.error).not.toBeNull();
    expect(parsedLine.error.message).toContain("status 402");

    fetchSpy.mockRestore();
  });

  test("abruptly halts and cancels the entire batch execution pool on HTTP 503", async () => {
    const sourceJsonlPath = path.join(testEnv.tmpDir, "test_503.jsonl");

    const request1 = {
      custom_id: "req-fail-503",
      method: "POST",
      url: "/v1/chat/completions",
      body: { messages: [{ role: "user", content: "service unavailable" }] },
      telocity: {
        rpm: 10000,
        retryDelay: 1,
      },
    };
    const request2 = {
      custom_id: "req-should-not-run",
      method: "POST",
      url: "/v1/chat/completions",
      body: {
        messages: [{ role: "user", content: "this should never execute" }],
      },
      telocity: {
        rpm: 10000,
        retryDelay: 1,
      },
    };

    await fs.writeFile(
      sourceJsonlPath,
      JSON.stringify(request1) + "\n" + JSON.stringify(request2) + "\n",
    );

    let reqFail503Attempts = 0;
    let reqShouldNotRunAttempts = 0;

    const fetchSpy = vi
      .spyOn(llmNetwork, "llmFetch")
      .mockImplementation(async (url, options) => {
        const is503Request =
          url.includes("service unavailable") ||
          (typeof options.body === "string" &&
            options.body.includes("service unavailable"));

        if (is503Request) {
          reqFail503Attempts++;
          const mockErrorJson = {
            error: {
              message: "No available model provider meets routing requirements",
              type: "routing_error",
              code: "no_provider_available",
            },
          };
          return {
            ok: false,
            status: 503,
            headers: {
              get: () => null,
            },
            text: async () => JSON.stringify(mockErrorJson),
            json: async () => mockErrorJson,
            body: null,
          } as unknown as Response;
        }

        reqShouldNotRunAttempts++;
        return {
          ok: true,
          status: 200,
          headers: {
            get: () => null,
          },
          text: async () => "{}",
          json: async () => ({}),
          body: null,
        } as unknown as Response;
      });

    const args = [
      "br",
      sourceJsonlPath,
      testEnv.targetFile,
      "-b",
      "1",
      "-P",
      "1",
    ];

    const output = await withCapturedConsole(async () => {
      await main(args, false);
    });

    expect(output.toLowerCase()).toContain("error 503");
    expect(output.toLowerCase()).toContain("terminated");

    expect(reqFail503Attempts).toBe(1);
    expect(reqShouldNotRunAttempts).toBe(0);

    // Verify that progress was partially saved with the failure block
    const targetContent = await fs.readFile(testEnv.targetFile, "utf-8");
    const lines = targetContent.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);

    const parsedLine = JSON.parse(lines[0]!);
    expect(parsedLine.custom_id).toBe("req-fail-503");
    expect(parsedLine.error).not.toBeNull();
    expect(parsedLine.error.message).toContain("status 503");

    fetchSpy.mockRestore();
  });
});
