import { readFile, writeFile } from "node:fs/promises";

import type {
  Command,
  Endpoints,
  LLMConfigurableProps,
  PromptParam,
} from "../libs/types/index.ts";

import {
  config as appConfig,
  createError,
  errlog,
  exitOne,
  generateHelpText,
  isEexistError,
  isEnoentError,
  log,
  customParseArgs as parseArgs,
  readStdin,
  red,
  simpleTemplate,
  x,
} from "../libs/core/index.ts";
import {
  buildImageContent,
  buildAudioContent,
  TerminalStreamer,
  getPresetHelpText,
  LLM,
  resolveModelConfig,
  stripGarbageNewLines,
  resolveModelParam,
  validateFiles,
  resolveFileContent,
  segmentText,
  resolvePromptPreset,
} from "../libs/LLM/index.ts";
import { EMPTY_FIELD } from "../libs/types/index.ts";

export default class OneShotCommand implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "file" as const;
  }
  static get defaultChunkSize() {
    return 200000;
  }
  static get defaultBatchSize() {
    return 1;
  }
  static get defaultParallel() {
    return 1;
  }
  static get helpReplacements() {
    return {
      DefaultModel: appConfig.DEFAULT_MODEL,
      ChunkSize: this.defaultChunkSize.toString(),
      BatchSize: this.defaultBatchSize.toString(),
    };
  }
  static get options() {
    return {
      file: { type: "string", short: "i" },
      outfile: { type: "string", short: "o" },
      image: { type: "string", short: "I" },
      audio: { type: "string", short: "a" },
      model: { type: "string", short: "m" },
      params: { type: "string", short: "p", default: appConfig.DEFAULT_MODEL },
      url: { type: "string", short: "u" },
      apikey: { type: "string", short: "k" },
      chunksize: { type: "string", short: "c" },
      partial: { type: "string", short: "P" },
      pselector: { type: "string", short: "S" },
      reason: { type: "boolean", short: "r" },
      help: { type: "boolean", short: "h" },
    } as const;
  }
  async execute(argv: string[]): Promise<number> {
    const { a } = x;
    const Cmd = this.constructor as typeof OneShotCommand;
    const { values: argValues, positionals } = parseArgs({
      args: argv,
      options: Cmd.options,
      allowPositionals: Cmd.allowPositionals,
      strict: true,
    });

    const oneshotHelp = () => {
      const replacements = {
        ModelParamList: getPresetHelpText(appConfig.PARAM_CONFIGS),
        ...OneShotCommand.helpReplacements,
      };
      const helpText = generateHelpText(
        a.s.help.commands.os,
        Cmd.options,
        replacements,
      );
      log(helpText);
    };

    if (argValues.help) {
      oneshotHelp();
      return 0;
    }

    if (argValues.image && argValues.audio) {
      exitOne();
      oneshotHelp();
      errlog(red(a.s.e.v.mutuallyExclusiveMedia));
      return 1;
    }

    const hasPositionalPrompt = !!positionals[1];
    const hasPselector = !!argValues.pselector;
    const hasPartial = !!argValues.partial;

    let activeInputCount = 0;
    if (hasPositionalPrompt) activeInputCount++;
    if (hasPselector) activeInputCount++;
    if (hasPartial) activeInputCount++;

    if (activeInputCount > 1) {
      throw createError(a.s.e.v.mutuallyExclusivePrompts, {
        code: "MUTUALLY_EXCLUSIVE_INPUTS",
      });
    }

    const paramsKey = argValues.params;
    const modelConfig = appConfig.PARAM_CONFIGS[paramsKey];
    if (!modelConfig) {
      throw createError(
        simpleTemplate(a.s.e.lllm.undefinedParam, {
          ParamKey: paramsKey,
        }),
        {
          code: "UNDEFINED_PARAM",
        },
      );
    }

    const imageURIs = await buildImageContent(argValues.image);
    const audioData = await buildAudioContent(argValues.audio);

    let text = "";

    if (argValues.file) {
      const fpath = argValues.file;
      try {
        const rawFileContent = await readFile(fpath, "utf-8");
        await validateFiles(fpath);
        text = stripGarbageNewLines(rawFileContent, {
          markdownBrainRot: modelConfig.metadata?.markdownBrainRot,
        });
      } catch (err) {
        if (isEnoentError(err)) {
          throw createError(
            simpleTemplate(a.s.e.lllm.fileNotFound, { FilePath: fpath }),
            {
              code: "SOURCE_FILE_NOT_FOUND",
              cause: err,
            },
          );
        }
        throw err;
      }
    } else if (a.isInteractive && !process.stdin.isTTY) {
      text = stripGarbageNewLines(await readStdin(), {
        markdownBrainRot: modelConfig.metadata?.markdownBrainRot,
      });
    }

    const rawPositionalPrompt = positionals[1] ?? "";
    let resolvedUserPrompt = "";

    if (hasPselector) {
      resolvedUserPrompt = resolvePromptPreset(argValues.pselector);
    } else if (hasPartial) {
      resolvedUserPrompt = resolvePromptPreset(argValues.partial);
    } else {
      resolvedUserPrompt = await resolveFileContent(rawPositionalPrompt);
    }

    if (!resolvedUserPrompt && !text) {
      exitOne();
      oneshotHelp();
      errlog(red(a.s.e.lllm.promptMissing));
      return 1;
    }

    const defaultReasoning =
      modelConfig.metadata?.defaultReasoning ?? appConfig.DEFAULT_REASONING;

    const useReasoning = defaultReasoning
      ? !argValues.reason
      : !!argValues.reason;
    const activeConfig = resolveModelConfig(paramsKey, useReasoning);

    // If partial execution is requested, segment the text and slice to the first chunk
    if (hasPartial && text) {
      const chunkSize = resolveModelParam(
        argValues.chunksize,
        activeConfig.model.chunkSize,
        appConfig.CHUNK_SIZE,
      );
      const chunks = segmentText(text, chunkSize);
      text = chunks[0] ?? "";
    } else if (argValues.chunksize && text) {
      const chunks = segmentText(text, +argValues.chunksize);
      text = chunks[0] ?? "";
    }

    const llmModelParams = { ...activeConfig.model };

    let oneshotSessionId = "oneshot";
    if (modelConfig.metadata?.injectORSessionId) {
      const now = Temporal.Now.zonedDateTimeISO();
      const ym = `${now.year}_${String(now.month).padStart(2, "0")}`;
      oneshotSessionId = `oneshot_${ym}`;
    }

    const explicitEndpoint: Endpoints | undefined =
      activeConfig.model.endpoint || appConfig.ENDPOINT;

    const promptSettings = activeConfig.prompt || {};
    const defSys = promptSettings.defSys || EMPTY_FIELD[0];
    const defPrep = promptSettings.defPrep || EMPTY_FIELD[0];
    const defPrefill = promptSettings.defPrefill || EMPTY_FIELD[1];

    const roletag = defSys[2] || "system";
    const roletag2 = defPrep[2] || "user";

    let sysPromptFinal: PromptParam = EMPTY_FIELD[0];

    const useDefaultSystemPrompt = defSys[0];

    if (useDefaultSystemPrompt) {
      sysPromptFinal = [true, defSys[1], roletag];
    }

    const prependPromptFinal: PromptParam = [
      true,
      resolvedUserPrompt,
      roletag2,
    ];

    let prefillPromptFinal: PromptParam = EMPTY_FIELD[1];

    if (defPrefill[0]) {
      prefillPromptFinal = defPrefill;
    }

    const hasInstructions =
      (prependPromptFinal[0] && prependPromptFinal[1].trim() !== "") ||
      (prefillPromptFinal[0] && prefillPromptFinal[1].trim() !== "") ||
      (text && text.trim() !== "");

    if (!hasInstructions) {
      throw createError(a.s.e.lllm.promptMissing, {
        code: "PROMPT_MISSING",
      });
    }

    const options: LLMConfigurableProps = {
      ...llmModelParams,
      stripEmpty: modelConfig.metadata?.stripEmpty,
      markdownBrainRot: modelConfig.metadata?.markdownBrainRot,
      forceStream: modelConfig.metadata?.forceStream,
      injectORSessionId: modelConfig.metadata?.injectORSessionId, // openrouter exclusive
      // No chunking or parallelism for oneshot, so never use the defaults
      // from the presets json, only hardcoded values.
      // This command itself is allowed to do its own chunking
      // of text to do partial prompting of the head.
      chunkSize: resolveModelParam(
        undefined,
        undefined,
        OneShotCommand.defaultChunkSize,
      ),
      batchSize: resolveModelParam(
        undefined,
        undefined,
        OneShotCommand.defaultBatchSize,
      ),
      parallel: resolveModelParam(
        undefined,
        undefined,
        OneShotCommand.defaultParallel,
      ),
      rpm: resolveModelParam(undefined, llmModelParams.rpm, appConfig.RPM),
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
      systemPrompt: sysPromptFinal,
      prependPrompt: prependPromptFinal,
      prefill: prefillPromptFinal,
      url: argValues.url || llmModelParams.url || appConfig.URL,
      allowH2: modelConfig.metadata?.allowH2 ?? activeConfig.model.allowH2,
      model: argValues.model
        ? [true, argValues.model]
        : llmModelParams.model || [false, ""],
      ...(modelConfig.metadata?.injectORSessionId
        ? { session_id: [true, oneshotSessionId] }
        : {}),
    };

    if (explicitEndpoint) {
      options.endpoint = explicitEndpoint;
    }

    if (Array.isArray(imageURIs) && imageURIs.length > 0) {
      options.images = imageURIs;
    }

    if (audioData) {
      options.audio = audioData;
    }

    const llm = new LLM(options);
    const messages = llm.newPrompt(text);

    const targetFile = argValues.outfile || positionals[2];
    let responseText;

    try {
      a.activeJob = llm;

      if (targetFile) {
        responseText = await llm.completion(messages, { verbose: false });

        try {
          await writeFile(targetFile, responseText, { flag: "wx" });
        } catch (err) {
          if (isEexistError(err)) {
            throw createError(
              simpleTemplate(a.s.e.lllm.targetFileExists, {
                TargetPath: targetFile,
              }),
              { code: "TARGET_EXISTS" },
            );
          }
          throw err;
        }
      } else {
        const streamer = new TerminalStreamer(
          a.TERMINAL_WIDTH,
          async (chunk) => {
            await new Promise<void>((resolve) => {
              if (process.stdout.write(chunk)) resolve();
              else process.stdout.once("drain", resolve);
            });
          },
          !a.NO_MARKDOWN,
          {
            stripEmpty: modelConfig.metadata?.stripEmpty,
            markdownBrainRot: modelConfig.metadata?.markdownBrainRot,
            streaming: !a.NO_STREAM,
          },
        );

        responseText = await llm.completion(messages, {
          verbose: async (chunk, isReasoning) => {
            if (isReasoning) {
              if (process.env["REASONING_CONTENT"]) {
                // Safeguard stdout redirection pipe or stream deactivation by routing reasoning to stderr
                if (!process.stdout.isTTY || a.NO_STREAM) {
                  await new Promise<void>((resolve) => {
                    if (process.stderr.write(chunk)) resolve();
                    else process.stderr.once("drain", resolve);
                  });
                  return;
                }
                await streamer.process(chunk);
              }
              return;
            }
            await streamer.process(chunk);
          },
        });

        await streamer.flush();
      }
    } finally {
      a.activeJob = null;
    }

    return 0;
  }
}
