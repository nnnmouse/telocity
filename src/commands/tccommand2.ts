import { readFile } from "node:fs/promises";

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
  simpleTemplate,
  x,
  yellow,
} from "../libs/core/index.ts";
import {
  segmentText,
  resolveModelConfig,
  validateFiles,
} from "../libs/LLM/index.ts";
import {
  countTokensInParallel,
  shutdownTokenCounter,
} from "../libs/vendoring/index.ts";
import TcCommand, { type RequestTokenMeta } from "./tccommand.ts";

export default class Tc2Command extends TcCommand {
  static override get helpReplacements() {
    return { DefaultModel: appConfig.DEFAULT_MODEL };
  }

  static override get options() {
    return {
      params: { type: "string", short: "p", default: appConfig.DEFAULT_MODEL },
      chunksize: { type: "string", short: "c" },
      help: { type: "boolean", short: "h" },
    } as const;
  }

  protected override async countTok(
    extractedMetas: RequestTokenMeta[],
    model: string,
  ) {
    const { a } = x;

    const inputs = extractedMetas.map((meta) => ({
      text: meta.text,
      options: { add_special_tokens: true },
    }));

    const counts = await countTokensInParallel(model, inputs);
    const tokenCount = counts.reduce((sum, count) => sum + count, 0);

    const chunkCount = extractedMetas.length;
    const avgPerChunkStr =
      chunkCount > 0 ? (tokenCount / chunkCount).toFixed(2) : "0.00";

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

    const medianPerChunkStr = median.toFixed(2);

    log(`${model}:`);
    log(`${a.s.m.c.tc2.tc}`, yellow(tokenCount.toString()));
    log(`${a.s.m.c.tc2.avgTc}`, yellow(avgPerChunkStr));
    log(`${a.s.m.c.tc2.medianTc}`, yellow(medianPerChunkStr));

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
          lineNumber: meta.lineNumber,
          customId: meta.customId,
          tokens: count,
        });
      } else if (count >= doubleThreshold) {
        doubleToTripleAnomalies.push({
          lineNumber: meta.lineNumber,
          customId: meta.customId,
          tokens: count,
        });
      }
    }

    if (doubleToTripleAnomalies.length > 0) {
      log("\n" + a.s.m.c.tc2.doubleToTripleHeader);
      for (const item of doubleToTripleAnomalies) {
        if (!item) continue;
        log(
          simpleTemplate(a.s.m.c.tc2.anomalyRow, {
            Line: item.lineNumber,
            CustomId: yellow(`[${item.customId}]`),
            Tokens: yellow(item.tokens.toString()),
          }),
        );
      }
    }

    if (aboveTripleAnomalies.length > 0) {
      log("\n" + a.s.m.c.tc2.aboveTripleHeader);
      for (const item of aboveTripleAnomalies) {
        if (!item) continue;
        log(
          simpleTemplate(a.s.m.c.tc2.anomalyRow, {
            Line: item.lineNumber,
            CustomId: yellow(`[${item.customId}]`),
            Tokens: yellow(item.tokens.toString()),
          }),
        );
      }
    }
  }

  override async execute(argv: string[]): Promise<number> {
    try {
      const { a } = x;
      const Cmd = this.constructor as typeof Tc2Command;

      const { values: argValues, positionals } = parseArgs({
        args: argv,
        allowPositionals: Cmd.allowPositionals,
        strict: true,
        options: Cmd.options,
      });

      const tc2Help = () => {
        const helpText = generateHelpText(a.s.help.commands.tc2, Cmd.options, {
          TokenParamList: TcCommand.availableModels,
          DefaultModel: appConfig.DEFAULT_MODEL,
        });
        log(helpText);
      };

      if (argValues.help) {
        tc2Help();
        return 0;
      }

      let rawInputText: string;

      if (a.isInteractive && !process.stdin.isTTY) {
        rawInputText = await readStdin();
      } else {
        if (!positionals[1]) {
          exitOne();
          tc2Help();
          throw createError(a.s.e.lllm.sourceRequired, {
            code: "SOURCE_REQUIRED",
          });
        }

        const sourcePath = positionals[1];
        await validateFiles(sourcePath);

        rawInputText = await readFile(sourcePath, "utf-8");
      }

      // --- Chunk Size Resolution Cascade ---
      let resolvedChunkSize = appConfig.CHUNK_SIZE;

      if (argValues.chunksize !== undefined) {
        resolvedChunkSize = +argValues.chunksize;
      } else {
        const requestedPreset = argValues.params;
        const modelConfig = appConfig.PARAM_CONFIGS[requestedPreset];
        if (modelConfig) {
          const defaultReasoning =
            modelConfig.metadata?.defaultReasoning ??
            appConfig.DEFAULT_REASONING;
          const activeConfig = resolveModelConfig(
            requestedPreset,
            defaultReasoning,
          );
          if (activeConfig.model.chunkSize !== undefined) {
            resolvedChunkSize = activeConfig.model.chunkSize;
          }
        } else {
          // Fallback to default model config chunkSize
          const defaultPreset = appConfig.DEFAULT_MODEL;
          const defaultModelConfig = appConfig.PARAM_CONFIGS[defaultPreset];
          if (defaultModelConfig) {
            const defaultReasoning =
              defaultModelConfig.metadata?.defaultReasoning ??
              appConfig.DEFAULT_REASONING;
            const activeConfig = resolveModelConfig(
              defaultPreset,
              defaultReasoning,
            );
            if (activeConfig.model.chunkSize !== undefined) {
              resolvedChunkSize = activeConfig.model.chunkSize;
            }
          }
        }
      }

      const chunks = segmentText(rawInputText, resolvedChunkSize);
      const extractedMetas: RequestTokenMeta[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunkText = chunks[i];
        if (chunkText === undefined || chunkText.trim() === "") continue;

        extractedMetas.push({
          lineNumber: i + 1,
          customId: `chunk-${i + 1}`,
          text: chunkText,
        });
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
          tc2Help();
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
