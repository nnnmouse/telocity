import { randomBytes } from "node:crypto";
import { createWriteStream, constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { Command } from "../libs/types/index.ts";

import {
  config as appConfig,
  createError,
  errlog,
  exitOne,
  generateHelpText,
  log,
  customParseArgs as parseArgs,
  readStdin,
  red,
  runConcur,
  simpleTemplate,
  x,
  yellow,
} from "../libs/core/index.ts";
import {
  isJsonl,
  resolveJSONLStrategy,
  validateFiles,
} from "../libs/LLM/index.ts";
import {
  countTokensInParallel,
  shutdownTokenCounter,
} from "../libs/vendoring/index.ts";

export interface RequestTokenMeta {
  lineNumber: number;
  customId: string;
  text: string;
}

export default class TcCommand implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "file" as const;
  }
  static get helpReplacements() {
    return { DefaultModel: appConfig.DEFAULT_MODEL };
  }
  static get options() {
    return {
      params: { type: "string", short: "p", default: appConfig.DEFAULT_MODEL },
      help: { type: "boolean", short: "h" },
    } as const;
  }

  static get MODELS_TO_DOWNLOAD(): Readonly<{
    readonly [key: string]: readonly string[];
  }> {
    return {
      gemma: [
        "https://huggingface.co/google/gemma-4-E4B-it/resolve/main/tokenizer.json",
        "https://huggingface.co/google/gemma-4-E4B-it/resolve/main/tokenizer_config.json",
      ],
      hymt: [
        "https://huggingface.co/tencent/Hy-MT2-7B/resolve/main/tokenizer.json",
        "https://huggingface.co/tencent/Hy-MT2-7B/resolve/main/tokenizer_config.json",
      ],
      deepseek: [
        "https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/resolve/main/tokenizer.json",
        "https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/resolve/main/tokenizer_config.json",
      ],
      hy3: [
        "https://huggingface.co/tencent/Hy3-preview/resolve/main/tokenizer.json",
        "https://huggingface.co/tencent/Hy3-preview/resolve/main/tokenizer_config.json",
      ],
      gptoss: [
        "https://huggingface.co/openai/gpt-oss-20b/resolve/main/tokenizer.json",
        "https://huggingface.co/openai/gpt-oss-20b/resolve/main/tokenizer_config.json",
      ],
      qwen: [
        "https://huggingface.co/Qwen/Qwen3.6-35B-A3B/resolve/main/tokenizer.json",
        "https://huggingface.co/Qwen/Qwen3.6-35B-A3B/resolve/main/tokenizer_config.json",
      ],
      glmair: [
        "https://huggingface.co/zai-org/GLM-4.5-Air/resolve/main/tokenizer.json",
        "https://huggingface.co/zai-org/GLM-4.5-Air/resolve/main/tokenizer_config.json",
      ],
      minimax: [
        "https://huggingface.co/MiniMaxAI/MiniMax-M2.7/resolve/main/tokenizer.json",
        "https://huggingface.co/MiniMaxAI/MiniMax-M2.7/resolve/main/tokenizer_config.json",
      ],
      nemotronnano: [
        "https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16/resolve/main/tokenizer.json",
        "https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16/resolve/main/tokenizer_config.json",
      ],
    } as const;
  }

  protected static get availableModels() {
    return Object.keys(TcCommand.MODELS_TO_DOWNLOAD).join(", ");
  }

  protected async handleModelDownload(modelName: string): Promise<void> {
    const { a } = x;
    const modelUrls =
      TcCommand.MODELS_TO_DOWNLOAD[
        modelName as keyof typeof TcCommand.MODELS_TO_DOWNLOAD
      ];

    if (!modelUrls) {
      throw createError(
        simpleTemplate(a.s.e.c.tc.modelNotFoundForDownload, {
          ModelName: modelName,
        }) +
          `\n${simpleTemplate(a.s.m.c.tc.availableModelsForDownload, {
            AvailableModels: TcCommand.availableModels,
          })}`,
      );
    }

    const baseDir = path.join(a.STATE_DIR, "models");
    const [modelUrl, configUrl] = modelUrls;
    const modelDestPath = path.join(baseDir, `${modelName}.json`);
    const configDestPath = path.join(baseDir, `${modelName}_config.json`);

    try {
      await access(modelDestPath, fsConstants.F_OK);
      await access(configDestPath, fsConstants.F_OK);
      return;
    } catch {
      /* ignore */
    }

    log(
      simpleTemplate(a.s.m.c.tc.downloadingModelFiles, {
        ModelName: modelName,
      }),
    );

    try {
      await mkdir(baseDir, { recursive: true });

      log(
        simpleTemplate(a.s.m.c.tc.writingFilesTo, {
          StateDir: baseDir,
        }),
      );

      const HARD_TIMEOUT = 5 * 60 * 1000;
      const sharedController = new AbortController();

      const timeoutId = setTimeout(
        () => sharedController.abort(),
        HARD_TIMEOUT,
      );
      timeoutId.unref();

      const downloadAndSave = async (
        url: string,
        destPath: string,
        signal: AbortSignal,
      ) => {
        const randomSuffix = randomBytes(4).toString("hex");
        const tmpPath = `${destPath}.${randomSuffix}.tmp`;

        try {
          const res = await fetch(url, { signal });

          if (!res.ok) {
            if (res.body) {
              await res.body.cancel().catch(() => {});
            }
            throw createError(
              simpleTemplate(a.s.e.c.tc.failedToDownload, {
                ModelUrl: url,
                Status: res.status,
                StatusText: res.statusText,
              }),
            );
          }
          if (!res.body) {
            throw createError(a.s.e.lllm.responseNull, {
              code: "NULL_RESPONSE_BODY",
            });
          }

          await pipeline(
            Readable.fromWeb(
              res.body as import("stream/web").ReadableStream<Uint8Array>,
            ),
            createWriteStream(tmpPath),
          );

          await rename(tmpPath, destPath);
        } catch (err) {
          try {
            await unlink(tmpPath);
          } catch {
            /* ignore */
          }
          throw err;
        }
      };

      try {
        await runConcur(
          [
            () =>
              downloadAndSave(
                modelUrl!,
                modelDestPath,
                sharedController.signal,
              ),
            () =>
              downloadAndSave(
                configUrl!,
                configDestPath,
                sharedController.signal,
              ),
          ],
          { concurrency: 2 },
        );
      } catch (err) {
        sharedController.abort();
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }

      log(
        simpleTemplate(a.s.m.c.tc.downloadSuccess, {
          ModelName: modelName,
        }),
      );
      log(`- ${modelDestPath}`);
      log(`- ${configDestPath}`);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw createError(a.s.e.lllm.hardTimeOut);
      } else if (err instanceof Error) {
        throw createError(
          simpleTemplate(a.s.e.c.tc.modelDownloadError, {
            ErrorMessage: err.message,
          }),
        );
      }
      throw err;
    }
  }

  protected async countTok(extractedMetas: RequestTokenMeta[], model: string) {
    const { a } = x;

    const inputs = extractedMetas.map((meta) => ({
      text: meta["text"],
      options: { add_special_tokens: true },
    }));

    const counts = await countTokensInParallel(model, inputs);
    const tokenCount = counts.reduce((sum, count) => sum + count, 0);

    const requestCount = extractedMetas.length;
    const avgPerRequestStr =
      requestCount > 0 ? (tokenCount / requestCount).toFixed(2) : "0.00";

    const sortedCounts = [...counts].sort((a, b) => a - b);
    let median = 0;
    const half = Math.floor(sortedCounts.length / 2);

    if (sortedCounts.length > 0) {
      if (sortedCounts.length % 2 !== 0) {
        const val = sortedCounts[half];
        if (val !== undefined) {
          median = val;
        }
      } else {
        const val1 = sortedCounts[half - 1];
        const val2 = sortedCounts[half];
        if (val1 !== undefined && val2 !== undefined) {
          median = (val1 + val2) / 2;
        }
      }
    }

    const medianPerRequestStr = median.toFixed(2);

    log(`${model}:`);
    log(`${a.s.m.c.tc.tc}`, yellow(tokenCount.toString()));
    log(`${a.s.m.c.tc.avgTc}`, yellow(avgPerRequestStr));
    log(`${a.s.m.c.tc.medianTc}`, yellow(medianPerRequestStr));

    const doubleToTripleAnomalies: {
      lineNumber: number;
      customId: string;
      tokens: number;
    }[] = [];
    const aboveTripleAnomalies: {
      lineNumber: number;
      customId: string;
      tokens: number;
    }[] = [];

    const doubleThreshold = median * 2;
    const tripleThreshold = median * 3;

    for (let i = 0; i < extractedMetas.length; i++) {
      const meta = extractedMetas[i];
      if (!meta) continue;

      const count = counts[i];
      if (count === undefined) continue;

      if (count >= tripleThreshold) {
        aboveTripleAnomalies.push({
          lineNumber: meta["lineNumber"],
          customId: meta["customId"],
          tokens: count,
        });
      } else if (count >= doubleThreshold) {
        doubleToTripleAnomalies.push({
          lineNumber: meta["lineNumber"],
          customId: meta["customId"],
          tokens: count,
        });
      }
    }

    if (doubleToTripleAnomalies.length > 0) {
      log("\n" + a.s.m.c.tc.doubleToTripleHeader);
      for (const item of doubleToTripleAnomalies) {
        if (!item) continue;
        log(
          simpleTemplate(a.s.m.c.tc.anomalyRow, {
            Line: item["lineNumber"],
            CustomId: yellow(`[${item["customId"]}]`),
            Tokens: yellow(item["tokens"].toString()),
          }),
        );
      }
    }

    if (aboveTripleAnomalies.length > 0) {
      log("\n" + a.s.m.c.tc.aboveTripleHeader);
      for (const item of aboveTripleAnomalies) {
        if (!item) continue;
        log(
          simpleTemplate(a.s.m.c.tc.anomalyRow, {
            Line: item["lineNumber"],
            CustomId: yellow(`[${item["customId"]}]`),
            Tokens: yellow(item["tokens"].toString()),
          }),
        );
      }
    }
  }

  async execute(argv: string[]): Promise<number> {
    try {
      const { a } = x;
      const Cmd = this.constructor as typeof TcCommand;

      const { values: argValues, positionals } = parseArgs({
        args: argv,
        allowPositionals: Cmd.allowPositionals,
        strict: true,
        options: Cmd.options,
      });

      const tcHelp = () => {
        const helpText = generateHelpText(a.s.help.commands.tc, Cmd.options, {
          TokenParamList: TcCommand.availableModels,
          DefaultModel: appConfig.DEFAULT_MODEL,
        });
        log(helpText);
      };

      if (argValues.help) {
        tcHelp();
        return 0;
      }

      let rawInputText: string;

      if (a.isInteractive && !process.stdin.isTTY) {
        rawInputText = await readStdin();
      } else {
        if (!positionals[1]) {
          exitOne();
          tcHelp();
          throw createError(a.s.e.lllm.sourceRequired, {
            code: "SOURCE_REQUIRED",
          });
        }

        const sourcePath = positionals[1];
        await validateFiles(sourcePath);

        rawInputText = await readFile(sourcePath, "utf-8");
      }

      if (!isJsonl(rawInputText)) {
        exitOne();
        errlog(red(a.s.e.c.tc.invalidJsonlSource));
        return 1;
      }

      const lines = rawInputText.split("\n");
      const extractedMetas: RequestTokenMeta[] = [];
      let originalLineNum = 0;

      for (const line of lines) {
        originalLineNum++;
        if (line.trim() === "") continue;

        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;

          if (
            parsed["response"] !== undefined ||
            (parsed["error"] !== undefined && parsed["body"] === undefined)
          ) {
            // Output JSONL format (Completed responses)
            const strategy = resolveJSONLStrategy({ line });
            const parsedLine = strategy.parseLine(line);

            if (!parsedLine["isError"]) {
              let content = parsedLine["text"] || "";
              if (parsedLine["reasoningText"]) {
                content = parsedLine["reasoningText"] + "\n" + content;
              }
              if (content.trim()) {
                extractedMetas.push({
                  lineNumber: originalLineNum,
                  customId: parsedLine["customId"] || `line-${originalLineNum}`,
                  text: content,
                });
              }
            }
          } else if (parsed["body"] !== undefined) {
            // Source JSONL format (Requests)
            const strategy = resolveJSONLStrategy({ line });
            const parsedRequest = strategy.parseRequest(line);

            if (parsedRequest && parsedRequest["body"]) {
              const body = parsedRequest["body"];
              let promptContent = "";

              if (Array.isArray(body["messages"])) {
                promptContent = (body["messages"] as Record<string, unknown>[])
                  .map((msg) => {
                    const content = msg["content"];
                    if (typeof content === "string") {
                      return content;
                    } else if (Array.isArray(content)) {
                      return content
                        .map((part) => {
                          if (
                            part &&
                            typeof part === "object" &&
                            part["type"] === "text" &&
                            typeof part["text"] === "string"
                          ) {
                            return part["text"];
                          }
                          return "";
                        })
                        .join("");
                    }
                    return "";
                  })
                  .join("\n");
              } else if (typeof body["prompt"] === "string") {
                promptContent = body["prompt"];
              } else if (typeof body["input"] === "string") {
                promptContent = body["input"];
              } else if (Array.isArray(body["input"])) {
                promptContent = (body["input"] as Record<string, unknown>[])
                  .map((msg) => {
                    const content = msg["content"];
                    if (Array.isArray(content)) {
                      return content
                        .map((part) => {
                          if (
                            part &&
                            (part["type"] === "input_text" ||
                              part["type"] === "output_text") &&
                            typeof part["text"] === "string"
                          ) {
                            return part["text"];
                          }
                          return "";
                        })
                        .join("");
                    }
                    return "";
                  })
                  .join("\n");
              }

              if (promptContent.trim()) {
                extractedMetas.push({
                  lineNumber: originalLineNum,
                  customId:
                    parsedRequest["custom_id"] || `line-${originalLineNum}`,
                  text: promptContent,
                });
              }
            }
          }
        } catch {
          // Bypass parsing errors for isolated malformed lines
        }
      }

      if (extractedMetas.length === 0) {
        exitOne();
        throw createError(a.s.e.lllm.emptyFile, {
          code: "EMPTY_FILE",
        });
      }

      const presetName = argValues.params;
      let resolvedTokenizer = presetName;

      if (!(resolvedTokenizer in TcCommand.MODELS_TO_DOWNLOAD)) {
        const lowerPreset = presetName.toLowerCase();
        const fallback = Object.keys(TcCommand.MODELS_TO_DOWNLOAD).find((t) =>
          lowerPreset.includes(t.toLowerCase()),
        );

        if (fallback) {
          resolvedTokenizer = fallback;
        } else {
          exitOne();
          tcHelp();
          errlog(
            red(
              simpleTemplate(a.s.e.c.tc.tokenizerDoesNotExist, {
                PresetName: presetName,
              }),
            ),
          );
          return 1;
        }
      }

      await this.handleModelDownload(resolvedTokenizer);
      await this.countTok(extractedMetas, resolvedTokenizer);

      return 0;
    } finally {
      shutdownTokenCounter();
    }
  }
}
