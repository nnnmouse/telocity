import fs from "node:fs/promises";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { main } from "../../src/main.ts";
import {
  initTest,
  setupTestEnvironment,
  SOURCE_FILE,
  teardownTestEnvironment,
  type TestEnvironment,
  withCapturedConsole,
} from "../testutils.ts";

describe("BatchGen Commands (JSONL Creators)", () => {
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

  test("bg command generates valid JSONL payload for translation", async () => {
    const args = ["bg", SOURCE_FILE, testEnv.targetFile];

    const output = await withCapturedConsole(async () => {
      await main(args, false);
    });

    expect(output).toMatch(/Generating \d+ request/i);

    const targetContent = await fs.readFile(testEnv.targetFile, "utf-8");
    const lines = targetContent.split("\n").filter((l) => l.trim().length > 0);

    expect(lines.length).toBeGreaterThan(0);

    const firstPayload = JSON.parse(lines[0]!);
    expect(firstPayload).toHaveProperty("custom_id");
    expect(firstPayload.custom_id).toMatch(/^request-\d+$/);
    expect(firstPayload).toHaveProperty("method", "POST");
    expect(firstPayload).toHaveProperty("body");
    expect(firstPayload.body).toHaveProperty("messages");
  });

  test("bg2 command generates valid JSONL payload for transformation", async () => {
    const customPrompt = "Please summarize the following text";
    const args = ["bg2", SOURCE_FILE, testEnv.targetFile, "-i", customPrompt];

    const output = await withCapturedConsole(async () => {
      await main(args, false);
    });

    expect(output).toMatch(/Generating \d+ request/i);

    const targetContent = await fs.readFile(testEnv.targetFile, "utf-8");
    const lines = targetContent.split("\n").filter((l) => l.trim().length > 0);

    expect(lines.length).toBeGreaterThan(0);

    const firstPayload = JSON.parse(lines[0]!);
    expect(firstPayload).toHaveProperty("custom_id");
    expect(firstPayload).toHaveProperty("body");
    expect(firstPayload.body).toHaveProperty("messages");

    const messages = firstPayload.body.messages;
    const stringifiedMessages = JSON.stringify(messages);
    expect(stringifiedMessages).toContain(customPrompt);
  });
});
