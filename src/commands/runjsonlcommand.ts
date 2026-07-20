import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  Command,
  Endpoints,
  LLMConfigurableProps,
} from "../libs/types/index.ts";

import {
  config as appConfig,
  createError,
  exitOne,
  generateHelpText,
  isEexistError,
  isNodeError,
  log,
  customParseArgs as parseArgs,
  simpleTemplate,
  x,
} from "../libs/core/index.ts";
import {
  LLMJSONLBatcher,
  getPresetHelpText,
  resolveModelConfig,
  resolveModelParam,
  extractText,
} from "../libs/LLM/index.ts";

export default class RunJSONLCommand implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "file" as const;
  }
  static get helpReplacements() {
    return {
      BatchSize: appConfig.BATCH_SIZE.toString(),
      Parallel: appConfig.PARALLEL.toString(),
      DefaultModel: appConfig.DEFAULT_MODEL,
    };
  }
  static get options() {
    return {
      batchsize: { type: "string", short: "b" },
      parallel: { type: "string", short: "P" },
      model: { type: "string", short: "m" },
      params: { type: "string", short: "p", default: appConfig.DEFAULT_MODEL },
      url: { type: "string", short: "u" },
      apikey: { type: "string", short: "k" },
      export: { type: "boolean", short: "e" },
      reason: { type: "boolean", short: "r" },
      retry: { type: "string", short: "R" },
      stream: { type: "boolean", short: "T", default: false },
      help: { type: "boolean", short: "h" },
    } as const;
  }

  async execute(argv: string[]): Promise<number> {
    const { a } = x;
    const Cmd = this.constructor as typeof RunJSONLCommand;

    const { values: argValues, positionals } = parseArgs({
      args: argv,
      options: Cmd.options,
      allowPositionals: Cmd.allowPositionals,
      strict: true,
    });

    a.NO_STREAM = !argValues.stream;

    const brHelp = () => {
      const commandsHelp = a.s.help.commands.br;

      const helpText = generateHelpText(commandsHelp, Cmd.options, {
        ModelParamList: getPresetHelpText(appConfig.PARAM_CONFIGS),
        ...RunJSONLCommand.helpReplacements,
      });
      log(helpText);
    };

    if (argValues.help) {
      brHelp();
      return 0;
    }

    if (!positionals[1]) {
      exitOne();
      brHelp();
      throw createError(a.s.e.lllm.sourceTargetRequired, {
        code: "SOURCE_TARGET_REQUIRED",
      });
    }

    const sourcePath = positionals[1];
    let targetPath = positionals[2];

    // Auto-derive target results file path if omitted
    if (!targetPath) {
      const ext = path.extname(sourcePath);
      const dir = path.dirname(sourcePath);
      const base = path.basename(sourcePath, ext);
      targetPath = path.join(dir, `${base}_results${ext}`);
    }

    let retryFailedFrom: string | undefined = undefined;
    let finalTarget = targetPath;

    // Switch targets if running a retry
    if (argValues.retry) {
      retryFailedFrom = targetPath;
      finalTarget = argValues.retry as string;
    }

    if (argValues.export) {
      try {
        const sourceText = await readFile(sourcePath, "utf-8");
        const extracted = extractText(sourceText);

        await writeFile(targetPath, extracted, { flag: "wx" });

        log(
          simpleTemplate(a.s.m.c.br.exportedSuccessfully, {
            TargetPath: targetPath,
          }),
        );
        return 0;
      } catch (err) {
        if (isEexistError(err)) {
          throw createError(
            simpleTemplate(a.s.e.lllm.targetFileExists, {
              TargetPath: targetPath,
            }),
            { code: "TARGET_EXISTS" },
          );
        }
        throw err;
      }
    }

    const paramsKey = argValues.params;
    const modelConfig = appConfig.PARAM_CONFIGS[paramsKey];
    if (!modelConfig) {
      throw createError(
        simpleTemplate(a.s.e.lllm.undefinedParam, { ParamKey: paramsKey }),
        { code: "UNDEFINED_PARAM" },
      );
    }

    const defaultReasoning =
      modelConfig.metadata?.defaultReasoning ?? appConfig.DEFAULT_REASONING;

    const useReasoning = defaultReasoning
      ? !argValues.reason
      : !!argValues.reason;

    const activeConfig = resolveModelConfig(paramsKey, useReasoning);
    const llmModelParams = { ...activeConfig.model };

    const explicitEndpoint: Endpoints | undefined =
      activeConfig.model.endpoint || appConfig.ENDPOINT;

    const resolvedBatchSize = resolveModelParam(
      argValues.batchsize,
      llmModelParams.batchSize,
      appConfig.BATCH_SIZE,
    );

    // --stream only takes effect when batches are processed one‑by‑one
    // different from forceStream from model presets, which is meant
    // to trigger stream in the backend but is not concerned
    // with real time streaming of the output to the terminal
    // might as well automatically set the right batch value
    const batchSize = argValues.stream ? 1 : resolvedBatchSize;

    const options: LLMConfigurableProps = {
      ...llmModelParams,
      stripEmpty: modelConfig.metadata?.stripEmpty,
      markdownBrainRot: modelConfig.metadata?.markdownBrainRot,
      forceStream: modelConfig.metadata?.forceStream,
      batchSize,
      parallel: resolveModelParam(
        argValues.parallel,
        llmModelParams.parallel,
        appConfig.PARALLEL,
      ),
      rpm: resolveModelParam(undefined, llmModelParams.rpm, appConfig.RPM),
      maxFail: resolveModelParam(
        undefined,
        llmModelParams.maxFail,
        appConfig.MAX_FAIL ?? 5,
      ),
      retryDelay: resolveModelParam(
        undefined,
        llmModelParams.retryDelay,
        appConfig.RETRY_DELAY,
      ),

      apiKey:
        argValues.apikey ??
        llmModelParams.apiKey ??
        process.env["TELOCITYKEY"] ??
        "",
      url: argValues.url || llmModelParams.url || appConfig.URL,
      allowH2: modelConfig.metadata?.allowH2 ?? activeConfig.model.allowH2,
      model: argValues.model
        ? [true, argValues.model]
        : llmModelParams.model || [false, ""],
      chunkSize: 1, // unused in JSONL batcher, but structurally required by standard LLMBatcher options
      retryFailedFrom,
    };

    if (explicitEndpoint) {
      options.endpoint = explicitEndpoint;
    }

    try {
      const llm = await LLMJSONLBatcher.create(
        options,
        sourcePath,
        finalTarget,
      );
      a.activeJob = llm;
      await llm.execute();
    } catch (err) {
      if (isNodeError(err) && err.code === "PROCESSING_ALREADY_COMPLETE") {
        process.exitCode = 0;
        if (err.cause instanceof Error) {
          log(err.cause.message);
        }
      } else {
        throw err;
      }
    } finally {
      a.activeJob = null;
    }
    return 0;
  }
}
