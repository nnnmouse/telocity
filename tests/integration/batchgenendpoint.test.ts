import fs from "node:fs/promises";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  test,
} from "vitest";

import type { Endpoints, ModelConfig } from "../../src/libs/types/index.ts";

import * as appCore from "../../src/libs/core/index.ts";
import { main } from "../../src/main.ts";
import {
  initTest,
  setupTestEnvironment,
  SOURCE_FILE,
  teardownTestEnvironment,
  type TestEnvironment,
  withCapturedConsole,
} from "../testutils.ts";

await initTest();

describe("BatchGen Endpoints & URL Handling Torture Test Suite", () => {
  let testEnv: TestEnvironment;
  let originalGlobalEndpoint: Endpoints | undefined;
  let originalDeepseekPreset: ModelConfig | undefined;
  let originalDefaultModelPreset: ModelConfig | undefined;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
    await appCore.configInit(false);

    const activeConfig = appCore.config;
    originalGlobalEndpoint = activeConfig.ENDPOINT;

    const deepseekConfig = activeConfig.PARAM_CONFIGS["deepseek"];
    if (deepseekConfig) {
      originalDeepseekPreset = structuredClone(deepseekConfig);
    }

    const defaultModel = activeConfig.DEFAULT_MODEL;
    const defaultConfig = activeConfig.PARAM_CONFIGS[defaultModel];
    if (defaultConfig) {
      originalDefaultModelPreset = structuredClone(defaultConfig);
    }
  });

  afterAll(async () => {
    await teardownTestEnvironment(testEnv);
  });

  beforeEach(async () => {
    process.env["LC_ALL"] = "en_US.UTF-8";
    process.env["LANG"] = "en_US.UTF-8";
    await fs.rm(testEnv.targetFile, { force: true });
  });

  afterEach(() => {
    const activeConfig = appCore.config;
    activeConfig.ENDPOINT = originalGlobalEndpoint;

    if (originalDeepseekPreset && activeConfig.PARAM_CONFIGS["deepseek"]) {
      activeConfig.PARAM_CONFIGS["deepseek"] = structuredClone(
        originalDeepseekPreset,
      );
    }

    const defaultModel = activeConfig.DEFAULT_MODEL;
    if (
      originalDefaultModelPreset &&
      activeConfig.PARAM_CONFIGS[defaultModel]
    ) {
      activeConfig.PARAM_CONFIGS[defaultModel] = structuredClone(
        originalDefaultModelPreset,
      );
    }
  });

  const saveConfigToDisk = async () => {
    const stateDir = appCore.x.appState.STATE_DIR;
    const configPath = path.join(stateDir, "config.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(appCore.config, null, 2),
      "utf-8",
    );
  };

  const mutateModelPresetEndpoint = (
    model: string,
    endpoint: Endpoints | undefined,
  ) => {
    const activeConfig = appCore.config;
    const preset = activeConfig.PARAM_CONFIGS[model];
    if (!preset) return;

    if (preset.reasoningType === "instruct_only") {
      preset.default.model.endpoint = endpoint;
    } else if (preset.reasoningType === "reason_only") {
      preset.default.model.endpoint = endpoint;
    } else if (preset.reasoningType === "reason_and_instruct") {
      preset.instruct.model.endpoint = endpoint;
      preset.reasoning.model.endpoint = endpoint;
    }
  };

  test("bg with openai-chatcompletions format uses the relative chat/completions endpoint URL", async () => {
    const activeConfig = appCore.config;
    activeConfig.ENDPOINT = "chatcompletions";
    mutateModelPresetEndpoint(activeConfig.DEFAULT_MODEL, undefined);
    await saveConfigToDisk();

    const args = ["bg", SOURCE_FILE, testEnv.targetFile];
    await withCapturedConsole(async () => {
      await main(args, false);
    });
    const content = await fs.readFile(testEnv.targetFile, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.url).toBe("/v1/chat/completions");
  });

  test("bg with openai-responses format uses the relative responses endpoint URL", async () => {
    const activeConfig = appCore.config;
    activeConfig.ENDPOINT = "responses";
    mutateModelPresetEndpoint(activeConfig.DEFAULT_MODEL, undefined);
    await saveConfigToDisk();

    const args = ["bg", SOURCE_FILE, testEnv.targetFile];
    await withCapturedConsole(async () => {
      await main(args, false);
    });
    const content = await fs.readFile(testEnv.targetFile, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.url).toBe("/v1/responses");
  });

  test("bg with openai-completions format uses the relative completions endpoint URL", async () => {
    const activeConfig = appCore.config;
    activeConfig.ENDPOINT = "completions";
    mutateModelPresetEndpoint(activeConfig.DEFAULT_MODEL, undefined);
    await saveConfigToDisk();

    const args = ["bg", SOURCE_FILE, testEnv.targetFile];
    await withCapturedConsole(async () => {
      await main(args, false);
    });
    const content = await fs.readFile(testEnv.targetFile, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.url).toBe("/v1/completions");
  });

  test("bg with OpenRouter chatcompletions strategy outputs relative path and absolute URL in telocity meta", async () => {
    mutateModelPresetEndpoint("deepseek", "openrouter-chat");
    await saveConfigToDisk();

    const args = [
      "bg",
      SOURCE_FILE,
      testEnv.targetFile,
      "--params",
      "deepseek",
    ];
    await withCapturedConsole(async () => {
      await main(args, false);
    });
    const content = await fs.readFile(testEnv.targetFile, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.url).toBe("/v1/chat/completions");
    expect(parsed.telocity.url).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });

  test("bg with OpenRouter responses strategy outputs relative path and absolute URL in telocity meta", async () => {
    mutateModelPresetEndpoint("deepseek", "openrouter-responses");
    await saveConfigToDisk();

    const args = [
      "bg",
      SOURCE_FILE,
      testEnv.targetFile,
      "--params",
      "deepseek",
    ];
    await withCapturedConsole(async () => {
      await main(args, false);
    });
    const content = await fs.readFile(testEnv.targetFile, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.url).toBe("/v1/responses");
    // always use the real absolute url in telocity even if endpoint is set to something incompatible
    expect(parsed.telocity.url).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });
});
