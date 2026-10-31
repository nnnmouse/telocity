import { readFile, writeFile } from "node:fs/promises";

import type { Command } from "../libs/types/index.ts";

import {
  createError,
  errlog,
  exitOne,
  generateHelpText,
  isEexistError,
  log,
  customParseArgs as parseArgs,
  red,
  simpleTemplate,
  stringWidth,
  wrapText,
  x,
} from "../libs/core/index.ts";
import { stripGarbageNewLines, validateFiles } from "../libs/LLM/index.ts";

export const defaultWidth = "40";

export default class CompareCommand implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "file" as const;
  }
  static get helpReplacements() {
    return { Width: defaultWidth };
  }
  static get options() {
    return {
      width: { type: "string", short: "w", default: defaultWidth },
      force: { type: "boolean", short: "f" },
      help: { type: "boolean", short: "h" },
    } as const;
  }

  async execute(argv: string[]): Promise<number> {
    const { a } = x;
    const Cmd = this.constructor as typeof CompareCommand;
    const { values: argValues, positionals } = parseArgs({
      args: argv,
      options: Cmd.options,
      allowPositionals: Cmd.allowPositionals,
      strict: true,
    });

    const compareHelp = () => {
      const helpText = generateHelpText(a.s.help.commands.cm, Cmd.options, {
        Width: String(argValues.width),
      });
      log(helpText);
    };

    if (argValues.help) {
      compareHelp();
      return 0;
    }

    if (!positionals[1] || !positionals[2] || !positionals[3]) {
      exitOne();
      compareHelp();
      errlog(red(a.s.e.c.cm.missingArgs));
      return 1;
    }

    const file1Path = positionals[1];
    const file2Path = positionals[2];
    const targetPath = positionals[3];
    const width = parseInt(String(argValues.width), 10);

    if (isNaN(width) || width <= 0) {
      throw createError(
        simpleTemplate(a.s.e.c.cm.invalidWidth, { Width: argValues.width }),
        { code: "INVALID_WIDTH_SIZE" },
      );
    }

    await validateFiles(file1Path);
    await validateFiles(file2Path);

    const text1 = await readFile(file1Path, "utf-8");
    const text2 = await readFile(file2Path, "utf-8");

    const lines1 = stripGarbageNewLines(text1, { stripEmpty: true }).split(
      "\n",
    );
    const lines2 = stripGarbageNewLines(text2, { stripEmpty: true }).split(
      "\n",
    );

    if (lines1.length !== lines2.length && !argValues.force) {
      exitOne();
      errlog(red(a.s.e.c.cm.diffLineCount));
      errlog(
        red(
          simpleTemplate(a.s.e.c.cm.diffLineCount1, {
            File1: file1Path,
            Lines1: lines1.length,
          }),
        ),
      );
      errlog(
        red(
          simpleTemplate(a.s.e.c.cm.diffLineCount2, {
            File2: file2Path,
            Lines2: lines2.length,
          }),
        ),
      );
      return 1;
    }

    const outputLines = CompareCommand.mergeSideBySide(lines1, lines2, width);

    try {
      await writeFile(targetPath, outputLines.join("\n"), { flag: "wx" });
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

    log(
      simpleTemplate(a.s.m.c.cm.success, {
        Lines: lines1.length,
        Target: targetPath,
      }),
    );
    return 0;
  }

  private static mergeSideBySide(
    lines1: string[],
    lines2: string[],
    width: number,
  ): string[] {
    const { a } = x;
    const SEPARATOR = a.SEPARATOR || " ——— ";
    const outputLines: string[] = [];

    const maxLinesTotal = Math.max(lines1.length, lines2.length);

    // Regex catches any East Asian scripts, Full-Width forms, and Emojis
    // \u1100-\u115F: Hangul Jamo
    // \u2E80-\uA4CF: Covers CJK Radicals, Hiragana, Katakana, Bopomofo, CJK Unified Ideographs, etc.
    // \uAC00-\uD7A3: Hangul Syllables
    // \uFF00-\uFF60: Full-width Latin letters and punctuation
    // \p{Emoji_Presentation}: Any Emoji character
    const wideCharRegex =
      /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Emoji_Presentation}/u;

    const fileHasWideChars = lines1.some((l) => wideCharRegex.test(l));

    for (let i = 0; i < maxLinesTotal; i++) {
      const l1 = lines1[i] ?? "";
      const l2 = lines2[i] ?? "";

      const leftWrapped = wrapText(l1, { width });
      const rightWrapped = wrapText(l2, { width });

      const maxLines = Math.max(leftWrapped.length, rightWrapped.length);

      for (let j = 0; j < maxLines; j++) {
        const leftLine = leftWrapped[j] ?? "";
        const rightLine = rightWrapped[j] ?? "";

        const leftWidth = stringWidth(leftLine);
        const diff = Math.max(0, width - leftWidth);
        let padding = "";

        if (diff > 0) {
          if (fileHasWideChars) {
            // Distribute the needed space using ideographic full-width spaces
            const fullSpaces = Math.floor(diff / 2);
            const halfSpaces = diff % 2;
            padding = "　".repeat(fullSpaces) + " ".repeat(halfSpaces);
          } else {
            padding = " ".repeat(diff);
          }
        }

        outputLines.push(`${leftLine}${padding}${SEPARATOR}${rightLine}`);
      }
    }

    return outputLines;
  }
}
