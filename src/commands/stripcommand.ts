import { readFile, writeFile } from "node:fs/promises";

import type { Command } from "../libs/types/index.ts";

import {
  config as appConfig,
  createError,
  errlog,
  exitOne,
  generateHelpText,
  isEexistError,
  log,
  customParseArgs as parseArgs,
  readStdin,
  red,
  simpleTemplate,
  x,
} from "../libs/core/index.ts";
import {
  getThinkTags,
  stripGarbageNewLines,
  stripMarkdownFormatting,
  validateFiles,
} from "../libs/LLM/index.ts";

export default class StripCommand implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "file" as const;
  }
  static get options() {
    return {
      startdelimiter: { type: "string", short: "s" },
      enddelimiter: { type: "string", short: "e" },
      params: { type: "string", short: "p" },
      extracttag: { type: "boolean", short: "x" },
      compress: { type: "boolean", short: "c", default: false },
      brainrot: { type: "boolean", short: "b", default: false },
      unformat: { type: "boolean", short: "u", default: false },
      help: { type: "boolean", short: "h" },
    } as const;
  }
  async execute(argv: string[]): Promise<number> {
    const { a } = x;
    const Cmd = this.constructor as typeof StripCommand;
    const { values: argValues, positionals } = parseArgs({
      args: argv,
      allowPositionals: Cmd.allowPositionals,
      strict: true,
      options: Cmd.options,
    });
    let { startdelimiter, enddelimiter } = argValues;

    const stripHelp = () => {
      const helpText = generateHelpText(a.s.help.commands.st, Cmd.options, {
        ReasoningTagParamList: getThinkTags(appConfig.PARAM_CONFIGS),
      });
      log(helpText);
    };
    if (argValues.help) {
      stripHelp();
      return 0;
    }

    if (argValues.params) {
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

      startdelimiter ??= modelConfig.metadata?.stripTags?.start;
      enddelimiter ??= modelConfig.metadata?.stripTags?.end;
    }

    let sourcePath = "-";
    let targetPath = "";

    if (positionals[2]) {
      sourcePath = positionals[1]!;
      targetPath = positionals[2]!;
    } else if (positionals[1]) {
      // If stdin is a pipe, the single parameter is the output destination
      if (!process.stdin.isTTY) {
        targetPath = positionals[1]!;
      } else {
        sourcePath = positionals[1]!;
      }
    } else if (process.stdin.isTTY) {
      exitOne();
      stripHelp();
      errlog(red(a.s.e.lllm.sourceTargetRequired));
      return 1;
    }

    await validateFiles(sourcePath, targetPath);
    if (
      (startdelimiter && !enddelimiter) ||
      (!startdelimiter && enddelimiter)
    ) {
      exitOne();
      stripHelp();
      errlog(red(a.s.e.c.st.delimiterPairRequired));
      return 1;
    }

    let text = "";
    if (sourcePath === "-") {
      if (!process.stdin.isTTY) {
        text = await readStdin();
      }
    } else {
      text = await readFile(sourcePath, "utf-8");
    }

    const finalMessage = [];
    if (startdelimiter && enddelimiter) {
      const action = argValues.extracttag ? "extract" : "delete";
      const extractorRegex = new RegExp(
        `${RegExp.escape(startdelimiter)}(.*?)${RegExp.escape(enddelimiter)}`,
        "gs",
      );

      switch (action) {
        case "extract": {
          const matches = text.matchAll(extractorRegex);
          const extractedContents = [];
          for (const match of matches) {
            if (match[1]) {
              extractedContents.push(match[1].trim());
            }
          }
          text = extractedContents.join("\n\n");
          finalMessage.push(a.s.m.c.st.blockExtracted);
          break;
        }
        case "delete":
          text = text.replace(extractorRegex, "");
          finalMessage.push(a.s.m.c.st.blockDeleted);
          break;
      }
    }

    if (argValues.unformat) {
      text = stripMarkdownFormatting(text);
      finalMessage.push("Markdown bold/italics stripped.");
    }

    text = stripGarbageNewLines(text, {
      stripEmpty: argValues.compress,
      markdownBrainRot: argValues.brainrot,
    });

    try {
      if (targetPath) {
        await writeFile(targetPath, text, { flag: "wx" });
      } else {
        process.stdout.write(text + "\n");
      }
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

    if (targetPath) {
      if (argValues.compress) {
        finalMessage.push(a.s.m.c.st.compressed);
      }
      finalMessage.push(a.s.m.c.st.newlinesNormalized);
      log(finalMessage.join("\n"));
    } else {
      if (argValues.compress) {
        finalMessage.push(a.s.m.c.st.compressed);
      }
      finalMessage.push(a.s.m.c.st.newlinesNormalized);
      // Avoid polluting standard stdout streams by outputting execution logs to stderr
      process.stderr.write(finalMessage.join("\n") + "\n");
    }
    return 0;
  }
}
