import { readFile } from "node:fs/promises";

import type { Command } from "../libs/types/index.ts";

import {
  createError,
  generateHelpText,
  log,
  customParseArgs as parseArgs,
  readStdin,
  simpleTemplate,
  x,
} from "../libs/core/index.ts";
import {
  calcAvgLineLength,
  calcAvgLineLengthBytes,
  stripGarbageNewLines,
  validateFiles,
} from "../libs/LLM/index.ts";

export default class AvgCommand implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "file" as const;
  }
  static get options() {
    return { help: { type: "boolean", short: "h" } } as const;
  }
  async execute(argv: string[]): Promise<number> {
    const { a } = x;
    const Cmd = this.constructor as typeof AvgCommand;
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: Cmd.allowPositionals,
      strict: true,
      options: Cmd.options,
    });

    const avgHelp = () => {
      const helpText = generateHelpText(a.s.help.commands.avg, Cmd.options);
      log(helpText);
    };

    if (values.help) {
      avgHelp();
      return 0;
    }

    let avgBytes;
    let avgGraphemes;

    if (a.isInteractive && !process.stdin.isTTY) {
      const rawText = await readStdin();
      const text = stripGarbageNewLines(rawText);
      avgBytes = calcAvgLineLengthBytes(text);
      avgGraphemes = calcAvgLineLength(text);
    } else {
      const sourcePath = positionals[1];
      if (!sourcePath) {
        avgHelp();
        throw createError(a.s.e.lllm.sourceRequired, {
          code: "SOURCE_REQUIRED",
        });
      }
      await validateFiles(sourcePath);

      const rawText = await readFile(sourcePath, "utf-8");
      const text = stripGarbageNewLines(rawText);
      avgBytes = calcAvgLineLengthBytes(text);
      avgGraphemes = calcAvgLineLength(text);
    }
    log(
      simpleTemplate(a.s.m.c.avg.averageCharsPerLine, {
        AvgChars: avgGraphemes,
      }),
    );
    log(
      simpleTemplate(a.s.m.c.avg.averageBytesPerLine, {
        AvgBytes: avgBytes,
      }),
    );

    return 0;
  }
}
