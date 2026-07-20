import type {
  Command,
  Endpoints,
  LLMConfigurableProps,
  PromptParam,
} from "../libs/types/index.ts";

import {
  config as appConfig,
  createError,
  exitOne,
  generateHelpText,
  log,
  customParseArgs as parseArgs,
  simpleTemplate,
  x,
} from "../libs/core/index.ts";
import {
  getPresetHelpText,
  JSONLRequestCompiler,
  resolveFileContent,
  resolveModelConfig,
  resolveModelParam,
  resolvePromptPreset,
} from "../libs/LLM/index.ts";
import { EMPTY_FIELD } from "../libs/types/index.ts";

export default class BatchGen2Command implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "file" as const;
  }
  static get defaultChunkSize() {
    return 200000;
  }
  static get helpReplacements() {
    return {
      ChunkSize: this.defaultChunkSize.toString(),
      DefaultModel: appConfig.DEFAULT_MODEL,
      FormatsList:
        "openai-chatcompletions, openai-responses, openai-completions",
    };
  }
  static get options() {
    return {
      chunksize: { type: "string", short: "c" },
      model: { type: "string", short: "m" },
      params: { type: "string", short: "p", default: appConfig.DEFAULT_MODEL },
      prompt: { type: "string", short: "i" },
      sysprompt: { type: "string", short: "s" },
      pselector: { type: "string", short: "S" },
      reason: { type: "boolean", short: "r" },
      help: { type: "boolean", short: "h" },
    } as const;
  }

  async execute(argv: string[]): Promise<number> {
    const { a } = x;
    const Cmd = this.constructor as typeof BatchGen2Command;

    const { values: argValues, positionals } = parseArgs({
      args: argv,
      options: Cmd.options,
      allowPositionals: Cmd.allowPositionals,
      strict: true,
    });

    const batchgen2helptext = () => {
      const helpText = generateHelpText(a.s.help.commands.bg2, Cmd.options, {
        ModelParamList: getPresetHelpText(appConfig.PARAM_CONFIGS),
        ...BatchGen2Command.helpReplacements,
      });
      log(helpText);
    };

    if (argValues.help) {
      batchgen2helptext();
      return 0;
    }

    if (argValues.prompt && argValues.pselector) {
      throw createError(a.s.e.v.mutuallyExclusivePrompts, {
        code: "MUTUALLY_EXCLUSIVE_INPUTS",
      });
    }

    let sourcePath = "-";
    let targetPath = "";

    // If only one positional parameter is provided, treat it as targetPath and default source to stdin ("-").
    if (positionals[2]) {
      sourcePath = positionals[1]!;
      targetPath = positionals[2]!;
    } else if (positionals[1]) {
      targetPath = positionals[1]!;
    } else {
      batchgen2helptext();
      exitOne();
      throw createError(a.s.e.lllm.sourceTargetRequired, {
        code: "SOURCE_TARGET_REQUIRED",
      });
    }

    const paramsKey = argValues.params;
    const modelConfig = appConfig.PARAM_CONFIGS[paramsKey];
    if (!modelConfig) {
      throw createError(
        simpleTemplate(a.s.e.lllm.undefinedParam, {
          ParamKey: paramsKey,
        }),
        { code: "UNDEFINED_PARAM" },
      );
    }
    const isLocalJSONL = !!modelConfig.metadata?.localJSONL;

    const defaultReasoning =
      modelConfig.metadata?.defaultReasoning ?? appConfig.DEFAULT_REASONING;

    const useReasoning = defaultReasoning
      ? !argValues.reason
      : !!argValues.reason;

    const activeConfig = resolveModelConfig(paramsKey, useReasoning);

    const endpointType: Endpoints | undefined =
      activeConfig.model.endpoint || appConfig.ENDPOINT;

    const llmModelParams = { ...activeConfig.model };

    const promptSettings = activeConfig.prompt || {};
    const defSys = promptSettings.defSys || EMPTY_FIELD[0];
    const defPrep = promptSettings.defPrep || EMPTY_FIELD[0];
    const defPrefill = promptSettings.defPrefill || EMPTY_FIELD[1];

    const roletag = defSys[2] || "system";
    const roletag2 = defPrep[2] || "user";

    let sysPromptFinal: PromptParam = EMPTY_FIELD[0];
    let prependPromptFinal: PromptParam = EMPTY_FIELD[0];

    const useDefaultSystemPrompt = defSys[0];

    if (argValues.sysprompt) {
      const resolvedSys = await resolveFileContent(argValues.sysprompt);
      sysPromptFinal = [true, resolvedSys, roletag];
    } else if (useDefaultSystemPrompt) {
      sysPromptFinal = [true, defSys[1], roletag];
    }

    if (argValues.prompt) {
      const resolvedPrompt = await resolveFileContent(argValues.prompt);
      prependPromptFinal = [true, resolvedPrompt, roletag2];
    } else if (argValues.pselector) {
      const resolvedPrompt = resolvePromptPreset(argValues.pselector);
      prependPromptFinal = [true, resolvedPrompt, roletag2];
    }

    let prefillPromptFinal: PromptParam = EMPTY_FIELD[1];

    if (defPrefill[0]) {
      prefillPromptFinal = defPrefill;
    }

    const hasInstructions =
      (prependPromptFinal[0] && prependPromptFinal[1].trim() !== "") ||
      (prefillPromptFinal[0] && prefillPromptFinal[1].trim() !== "");

    if (!hasInstructions) {
      throw createError(a.s.e.lllm.promptMissing, {
        code: "PROMPT_MISSING",
      });
    }

    const options: LLMConfigurableProps = {
      ...llmModelParams,
      url: activeConfig.model.url || appConfig.URL,
      allowH2: modelConfig.metadata?.allowH2 ?? activeConfig.model.allowH2,
      stripEmpty: modelConfig.metadata?.stripEmpty,
      markdownBrainRot: modelConfig.metadata?.markdownBrainRot,
      forceStream: modelConfig.metadata?.forceStream,
      injectORSessionId: modelConfig.metadata?.injectORSessionId, // openrouter exclusive
      chunkSize: resolveModelParam(
        argValues.chunksize,
        undefined,
        BatchGen2Command.defaultChunkSize,
      ),
      systemPrompt: sysPromptFinal,
      prependPrompt: prependPromptFinal,
      prefill: prefillPromptFinal,
      endpoint: endpointType,
      model: argValues.model
        ? [true, argValues.model]
        : activeConfig.model.model || [false, ""],
      batchSize: 1,
      parallel: 1,
    };

    const generator = new JSONLRequestCompiler(options);
    await generator.compile(sourcePath, targetPath, {
      localJSONL: isLocalJSONL,
    });

    return 0;
  }
}
