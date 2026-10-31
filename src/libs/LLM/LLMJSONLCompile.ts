import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { finished } from "node:stream/promises";

import {
  createError,
  isEnoentError,
  log,
  simpleTemplate,
  x,
  readStdin,
} from "../core/index.ts";
import {
  type LLMConfigurableProps,
  type LLMDependencies,
  type GenerateOptions,
} from "../types/index.ts";
import { LLM, ReasoningTracker } from "./LLM.ts";
import { parseJsonlBatchLine, resolveJSONLStrategy } from "./LLMIOutils.ts";
import {
  buildSessionId,
  getRelativePathForEndpoint,
  resolveStrategy,
} from "./LLMutils.ts";
import {
  segmentText,
  stripGarbageNewLines,
  segmentTextByPattern,
} from "./LLMutils.ts";

export class JSONLRequestCompiler extends LLM {
  public constructor(
    options: LLMConfigurableProps,
    dependencies?: LLMDependencies,
  ) {
    if (!options.endpoint) {
      throw createError(x.a.s.e.lllm.endpointRequired, {
        code: "ENDPOINT_REQUIRED",
      });
    }

    const strat = dependencies?.strategy ?? resolveStrategy(options.endpoint);
    super(options, { ...dependencies, strategy: strat });
  }

  public async compile(
    sourcePath: string,
    targetPath: string,
    options?: GenerateOptions,
  ): Promise<void> {
    const { a } = x;
    let sourceText: string;

    if (sourcePath === "-") {
      if (!process.stdin.isTTY) {
        sourceText = await readStdin();
      } else {
        sourceText = "";
      }
    } else {
      try {
        sourceText = await readFile(sourcePath, "utf-8");
      } catch (err) {
        if (isEnoentError(err)) {
          throw createError(
            simpleTemplate(a.s.e.lllm.fileNotFound, { FilePath: sourcePath }),
            { code: "ENOENT", cause: err },
          );
        }
        throw err;
      }
    }

    const normalizedText = stripGarbageNewLines(sourceText, {
      markdownBrainRot: this.markdownBrainRot,
    });

    let textChunks: string[];

    if (options?.regex) {
      const pattern = new RegExp(options.regex);
      textChunks = segmentTextByPattern(normalizedText, pattern).filter(
        (chunk) => chunk.trim() !== "",
      );
    } else {
      textChunks = segmentText(normalizedText, this.chunkSize).filter(
        (chunk) => chunk.trim() !== "",
      );
    }

    // If there is no input text, generate exactly one line utilizing the system/prep prompts
    if (textChunks.length === 0 && sourcePath === "-") {
      textChunks.push("");
    }

    if (textChunks.length === 0) {
      log(a.s.m.lllm.sourceEmpty);
      return;
    }

    log(
      simpleTemplate(a.s.m.lllm.generatingRequests, {
        Count: textChunks.length,
      }),
    );

    let startingIndex = 1;
    let fileExisted = false;
    let needsNewlinePrefix = false;

    try {
      const existingText = await readFile(targetPath, "utf-8");
      fileExisted = true;

      if (existingText.length > 0 && !existingText.endsWith("\n")) {
        needsNewlinePrefix = true;
      }

      const lines = existingText.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = parseJsonlBatchLine(line);
        if (parsed.customId && parsed.customId.startsWith("request-")) {
          const numStr = parsed.customId.slice(8);
          const num = parseInt(numStr, 10);
          if (!isNaN(num)) {
            startingIndex = Math.max(startingIndex, num + 1);
          }
        }
      }
    } catch (err) {
      if (!isEnoentError(err)) {
        throw err;
      }
    }

    const writer = createWriteStream(targetPath, {
      flags: "a",
      encoding: "utf-8",
    });

    await new Promise<void>((resolve, reject) => {
      writer.once("open", () => resolve());
      writer.once("error", reject);
    });

    try {
      if (needsNewlinePrefix) {
        writer.write("\n");
      }

      if (this.injectORSessionId) {
        const computedSessionId = buildSessionId(
          sourcePath,
          this.appState.segmenter,
        );
        this.session_id = [true, computedSessionId];
      }

      const tracker = new ReasoningTracker();
      const ctx = this.getStrategyContext(tracker);
      const jsonlStrat = resolveJSONLStrategy({
        format: this.strategy.jsonlFormat ?? "openai",
      });

      const requestUrl = getRelativePathForEndpoint(this.endpoint!);

      for (const chunk of textChunks) {
        const requestId = `request-${startingIndex++}`;
        const messages = this.newPrompt(chunk);

        let payload = this.strategy.buildPayload(
          messages,
          ctx,
          false,
        ) as Record<string, unknown>;

        payload = this.finalizePayload(payload);

        if (jsonlStrat.formatName === "openai" && "stream" in payload) {
          delete payload["stream"];
        }

        const meta = options?.localJSONL
          ? {
              url: this.url, // Embedded fully-qualified raw absolute URL
              endpoint: this.endpoint,
              rpm: this.rpm,
              retryDelay: this.retryDelay,
              maxAttempts: this.maxAttempts,
              maxFail: this.maxFail,
              tempValues: this.tempValues,
              hardTimeout: this.hardTimeout,
              idleTimeout: this.idleTimeout,
              stripEmpty: this.stripEmpty,
              markdownBrainRot: this.markdownBrainRot,
              failureMeansDeath: this.failureMeansDeath,
              forceStream: this.forceStream,
              injectORSessionId: this.injectORSessionId, // openrouter exclusive
              extra_body: this.extra_body,
              allowH2: this.allowH2,
            }
          : undefined;

        const jsonlLine = jsonlStrat.buildLine(
          requestId,
          payload,
          requestUrl,
          meta,
        );

        if (!writer.write(jsonlLine + "\n")) {
          await once(writer, "drain");
        }
      }

      writer.end();
      await finished(writer);

      log(
        simpleTemplate(a.s.m.lllm.wroteEntries, {
          Count: textChunks.length,
          TargetPath: targetPath,
        }),
      );
    } catch (err) {
      writer.destroy();
      if (!fileExisted) {
        await unlink(targetPath).catch(() => {});
      }
      throw createError(a.s.e.lllm.jsonlGenError, { cause: err });
    }
  }
}
