import { stat, readFile } from "node:fs/promises";
import path from "node:path";

import type { Command } from "../libs/types/index.ts";

import {
  config as appConfig,
  createError,
  errlog,
  exitOne,
  generateHelpText,
  isEnoentError,
  log,
  customParseArgs as parseArgs,
  red,
  simpleTemplate,
  x,
} from "../libs/core/index.ts";
import {
  mergeFiles,
  mergeFailedRetries,
  resolveModelConfig,
  resolveStrategy,
} from "../libs/LLM/index.ts";

export default class MergeCommand implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "file" as const;
  }
  static get options() {
    return {
      extension: { type: "string", short: "e" },
      include: { type: "string", short: "i" },
      exclude: { type: "string", short: "x" },
      noignore: { type: "boolean", short: "n" },
      failed: { type: "boolean", short: "F" },
      params: { type: "string", short: "p" },
      help: { type: "boolean", short: "h" },
    } as const;
  }
  async execute(argv: string[]): Promise<number> {
    const { a } = x;
    const Cmd = this.constructor as typeof MergeCommand;

    const { values: argValues, positionals } = parseArgs({
      args: argv,
      options: Cmd.options,
      allowPositionals: Cmd.allowPositionals,
      strict: true,
    });

    const mergeHelp = () => {
      const helpText = generateHelpText(a.s.help.commands.mg, Cmd.options);
      log(helpText);
    };

    if (argValues.help) {
      mergeHelp();
      return 0;
    }

    if (argValues.failed) {
      if (!positionals[1] || !positionals[2]) {
        exitOne();
        mergeHelp();
        throw createError(a.s.e.lllm.sourceRequired, {
          code: "SOURCE_REQUIRED",
        });
      }
      const originalPath = positionals[1];
      const retryPath = positionals[2];
      const outputPath = positionals[3] ? positionals[3] : originalPath;

      let resolvedFormat: string | undefined;

      if (argValues.params) {
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

        const defaultReasoning =
          modelConfig.metadata?.defaultReasoning ?? appConfig.DEFAULT_REASONING;
        const activeConfig = resolveModelConfig(paramsKey, defaultReasoning);
        const endpointType = activeConfig.model.endpoint || appConfig.ENDPOINT;

        if (endpointType) {
          resolvedFormat = resolveStrategy(endpointType).jsonlFormat;
        }
      }

      await mergeFailedRetries(
        originalPath,
        retryPath,
        outputPath,
        resolvedFormat,
      );
      return 0;
    }

    if (!positionals[1]) {
      exitOne();
      mergeHelp();
      throw createError(a.s.e.lllm.sourceRequired, {
        code: "SOURCE_REQUIRED",
      });
    }

    const sourcePath = positionals[1];
    const targetPath = positionals[2] ? positionals[2] : process.cwd();
    const extension = argValues.extension;

    if (!extension) {
      exitOne();
      errlog(red(a.s.e.c.mg.extensionRequired));
      return 1;
    }

    const includePatterns: string[] = [];
    const excludePatterns: string[] = [];

    const resolvePatternInput = async (input: string): Promise<string[]> => {
      const trimmed = input.trim();
      if (!trimmed) return [];

      if (!trimmed.includes("\n") && !trimmed.includes("\r")) {
        try {
          const stats = await stat(trimmed);
          if (stats.isFile()) {
            const content = await readFile(trimmed, "utf-8");
            return content
              .split(/\r?\n/)
              .map((p) => p.trim())
              .filter((p) => p && !p.startsWith("#"));
          }
        } catch {
          // Fall through to inline colon-separated parsing if file not found or unreadable
        }
      }

      return trimmed
        .split(":")
        .map((p) => p.trim())
        .filter(Boolean);
    };

    if (argValues.include) {
      includePatterns.push(...(await resolvePatternInput(argValues.include)));
    }

    if (argValues.exclude) {
      excludePatterns.push(...(await resolvePatternInput(argValues.exclude)));
    }

    const readGlobFile = async (filePath: string, destArray: string[]) => {
      try {
        const content = await readFile(filePath, "utf-8");
        const patterns = content
          .split(/\r?\n/)
          .map((p) => p.trim())
          .filter((p) => p && !p.startsWith("#"));
        if (patterns.length > 0) {
          destArray.push(...patterns);
        }
      } catch (err) {
        if (!isEnoentError(err)) {
          throw err;
        }
      }
    };

    const cwd = process.cwd();
    const resolvedSource = path.resolve(cwd, sourcePath);

    const checkPaths = new Set<string>();
    checkPaths.add(cwd);
    checkPaths.add(resolvedSource);

    for (const dir of checkPaths) {
      await readGlobFile(path.join(dir, ".mginclude"), includePatterns);

      if (!argValues.noignore) {
        await readGlobFile(path.join(dir, ".mgignore"), excludePatterns);
      }
    }

    const uniqueIncludes = [...new Set(includePatterns)];
    const uniqueExcludes = [...new Set(excludePatterns)];

    await mergeFiles(
      sourcePath,
      targetPath,
      extension,
      uniqueIncludes,
      uniqueExcludes,
    );

    return 0;
  }
}
