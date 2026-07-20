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

describe("OneShot Command", () => {
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

  test("handles default execution correctly (stdout)", async () => {
    const args = ["os", "Please summarize the text", "-i", SOURCE_FILE];

    const output = await withCapturedConsole(async () => {
      await main(args, false);
    });

    expect(output).toContain("Mocked LLM Response");
    expect(output).toContain("Please summarize the text");
  });

  test("writes dummy output to outfile when specified", async () => {
    const args = [
      "os",
      "Please summarize the text",
      "-i",
      SOURCE_FILE,
      "-o",
      testEnv.targetFile,
    ];

    await withCapturedConsole(async () => {
      await main(args, false);
    });

    const targetContent = await fs.readFile(testEnv.targetFile, "utf-8");
    expect(targetContent).toContain("Mocked LLM Response");
    expect(targetContent).toContain("Please summarize the text");
  });
});
