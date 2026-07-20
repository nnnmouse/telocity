import fs from "node:fs/promises";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { AppStateSingleton } from "../../src/libs/core/index.ts";
import { main } from "../../src/main.ts";
import {
  initTest,
  setupTestEnvironment,
  teardownTestEnvironment,
  type TestEnvironment,
  withCapturedConsole,
} from "../testutils.ts";

describe("RunJSONL Command", () => {
  let testEnv: TestEnvironment;
  let appState;
  let sourceJsonlPath: string;

  beforeAll(async () => {
    await initTest();
    testEnv = await setupTestEnvironment();
    appState = AppStateSingleton.getInstance();
    Object.defineProperty(appState, "DEBUG_MODE", {
      value: true,
      writable: true,
      configurable: true,
    });

    sourceJsonlPath = path.join(testEnv.tmpDir, "test_source.jsonl");
    const dummyRequest = JSON.stringify({
      custom_id: "req-debug-1",
      method: "POST",
      url: "/v1/chat/completions",
      body: {
        messages: [{ role: "user", content: "JSONL debug test payload" }],
      },
    });
    await fs.writeFile(sourceJsonlPath, dummyRequest + "\n");
  });

  afterAll(async () => {
    await teardownTestEnvironment(testEnv);
  });

  beforeEach(async () => {
    process.env["LC_ALL"] = "en_US.UTF-8";
    process.env["LANG"] = "en_US.UTF-8";
    await fs.rm(testEnv.targetFile, { force: true });
  });

  test("processes a JSONL file correctly", async () => {
    const args = ["br", sourceJsonlPath, testEnv.targetFile];

    const output = await withCapturedConsole(async () => {
      await main(args, false);
    });

    expect(output).toContain("[OK: req-debug-1]");

    const targetContent = await fs.readFile(testEnv.targetFile, "utf-8");
    expect(targetContent).toContain("req-debug-1");
    expect(targetContent).toContain("Mocked LLM Response");
    expect(targetContent).toContain("JSONL debug test payload");
  });
});
