import type {
  Command,
  LLMConfigurableProps,
  Endpoints,
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
  buildTranslationInstructions,
  getDefaultModelParam,
  getPresetHelpText,
  resolveModelConfig,
  resolveModelParam,
  JSONLRequestCompiler,
  resolveFileContent,
  resolveLanguageName,
} from "../libs/LLM/index.ts";
import { EMPTY_FIELD } from "../libs/types/index.ts";

export default class BatchGenCommand implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "file" as const;
  }
  static get helpReplacements() {
    return {
      ChunkSize: getDefaultModelParam("chunkSize"),
      DefaultModel: appConfig.DEFAULT_MODEL,
      FormatsList:
        "openai-chatcompletions, openai-responses, openai-completions",
    };
  }
  static get options() {
    return {
      chunksize: {
        type: "string",
        short: "c",
      },
      model: { type: "string", short: "m" },
      params: { type: "string", short: "p", default: appConfig.DEFAULT_MODEL },
      source: {
        type: "string",
        short: "s",
        default: appConfig.SOURCE_LANGUAGE,
      },
      target: {
        type: "string",
        short: "t",
        default: appConfig.TARGET_LANGUAGE,
      },
      context: { type: "string", short: "i", default: "" },
      regex: { type: "string", short: "x" },
      reason: { type: "boolean", short: "r" },
      help: { type: "boolean", short: "h" },
    } as const;
  }

  async execute(argv: string[]): Promise<number> {
    const { a } = x;
    const Cmd = this.constructor as typeof BatchGenCommand;

    const { values: argValues, positionals } = parseArgs({
      args: argv,
      options: Cmd.options,
      allowPositionals: Cmd.allowPositionals,
      strict: true,
    });

    const batchgenhelptext = () => {
      const helpText = generateHelpText(a.s.help.commands.bg, Cmd.options, {
        ModelParamList: getPresetHelpText(appConfig.PARAM_CONFIGS),
        ...BatchGenCommand.helpReplacements,
      });
      log(helpText);
    };

    if (argValues.help) {
      batchgenhelptext();
      return 0;
    }

    if (!positionals[1] || !positionals[2]) {
      batchgenhelptext();
      exitOne();
      throw createError(a.s.e.lllm.sourceTargetRequired, {
        code: "SOURCE_TARGET_REQUIRED",
      });
    }

    if (argValues.regex) {
      try {
        new RegExp(argValues.regex);
      } catch (err) {
        throw createError(
          simpleTemplate(a.s.e.lllm.invalidRegex, {
            Pattern: argValues.regex,
            Error: err instanceof Error ? err.message : String(err),
          }),
          { code: "INVALID_REGEX_PATTERN", cause: err },
        );
      }
    }

    const sourcePath = positionals[1];
    const targetPath = positionals[2];

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

    let sourceLang = argValues.source;
    let targetLang = argValues.target;

    const subPrefix = modelConfig.metadata?.substitutionPrefix;
    if (subPrefix) {
      sourceLang = resolveLanguageName(sourceLang, subPrefix);
      targetLang = resolveLanguageName(targetLang, subPrefix);
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

    const promptSettings = activeConfig.prompt || {};
    const defSys = promptSettings.defSys || EMPTY_FIELD[0];
    const defPrep = promptSettings.defPrep || EMPTY_FIELD[0];
    const defPrefill = promptSettings.defPrefill || EMPTY_FIELD[1];

    const usePreFlag = defPrep[0];
    const useSystemFlag = defSys[0];
    const roleTag = defSys[2] || "system";
    const roleTag2 = defPrep[2] || "user";

    let sysPromptFinal: PromptParam = EMPTY_FIELD[0];
    if (useSystemFlag) {
      const sysTemplate = defSys[1];
      const systemContent = buildTranslationInstructions(
        sysTemplate,
        sourceLang,
        targetLang,
      );
      sysPromptFinal = [true, systemContent, roleTag];
    }

    let contextContent = "";
    if (argValues.context && argValues.context.trim() !== "") {
      contextContent = await resolveFileContent(argValues.context);
    }

    let finalUserContentTemplate = "";
    if (usePreFlag) {
      const prepTemplate = defPrep[1];
      let processedPrep = buildTranslationInstructions(
        prepTemplate,
        sourceLang,
        targetLang,
      );

      if (processedPrep.includes("{{ .ContextualInformation }}")) {
        processedPrep = simpleTemplate(processedPrep, {
          ContextualInformation: contextContent,
        });
        finalUserContentTemplate = processedPrep;
      } else {
        finalUserContentTemplate = [processedPrep, contextContent]
          .filter(Boolean)
          .join("\n\n");
      }
    } else {
      finalUserContentTemplate = contextContent;
    }

    let prependPromptFinal: PromptParam = EMPTY_FIELD[0];
    if (finalUserContentTemplate) {
      prependPromptFinal = [true, finalUserContentTemplate, roleTag2];
    }

    let prefillPromptFinal: PromptParam = EMPTY_FIELD[1];
    if (defPrefill[0]) {
      const prefillTemplate = defPrefill[1];
      const processedPrefill = buildTranslationInstructions(
        prefillTemplate,
        sourceLang,
        targetLang,
      );
      prefillPromptFinal = [true, processedPrefill];
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
      ...activeConfig.model,
      url: activeConfig.model.url || appConfig.URL,
      allowH2: modelConfig.metadata?.allowH2 ?? activeConfig.model.allowH2,
      stripEmpty: modelConfig.metadata?.stripEmpty,
      markdownBrainRot: modelConfig.metadata?.markdownBrainRot,
      forceStream: modelConfig.metadata?.forceStream,
      injectORSessionId: modelConfig.metadata?.injectORSessionId, // openrouter exclusive
      chunkSize: resolveModelParam(
        argValues.chunksize,
        activeConfig.model.chunkSize,
        appConfig.CHUNK_SIZE,
      ),
      systemPrompt: sysPromptFinal,
      prependPrompt: prependPromptFinal,
      prefill: prefillPromptFinal,
      endpoint: endpointType,
      model: argValues.model
        ? [true, argValues.model]
        : activeConfig.model.model || [false, ""],
      batchSize: 1, // unused in JSONL generator, but structurally required by standard LLMBatcher options
      parallel: 1, // unused in JSONL generator, but structurally required by standard LLMBatcher options
    };

    const generator = new JSONLRequestCompiler(options);
    await generator.compile(sourcePath, targetPath, {
      localJSONL: isLocalJSONL,
      regex: argValues.regex,
    });

    return 0;
  }
}
