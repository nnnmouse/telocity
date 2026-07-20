import path from "node:path";

import type { Command } from "../libs/types/index.ts";

import {
  createError,
  errlog,
  exitOne,
  generateHelpText,
  log,
  customParseArgs as parseArgs,
  red,
  simpleTemplate,
  x,
} from "../libs/core/index.ts";
import { splitFile } from "../libs/LLM/index.ts";

export const defaultSize = "5";

export default class SplitCommand implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "file" as const;
  }
  static get helpReplacements() {
    return { Size: defaultSize };
  }
  static get options() {
    return {
      size: { type: "string", short: "s", default: defaultSize },
      help: { type: "boolean", short: "h" },
    } as const;
  }
  async execute(argv: string[]): Promise<number> {
    const { a } = x;
    const Cmd = this.constructor as typeof SplitCommand;

    const { values: argValues, positionals } = parseArgs({
      args: argv,
      options: Cmd.options,
      allowPositionals: Cmd.allowPositionals,
      strict: true,
    });

    const splitHelp = () => {
      const helpText = generateHelpText(a.s.help.commands.sp, Cmd.options, {
        Size: argValues.size,
      });
      log(helpText);
    };

    if (argValues.help) {
      splitHelp();
      return 0;
    }

    if (!positionals[1]) {
      exitOne();
      splitHelp();
      errlog(red(a.s.e.lllm.sourceTargetRequired));
      return 1;
    }

    const sourcePath = positionals[1];
    let targetPath = positionals[2];

    // Auto-derive target subfolder path if omitted
    if (!targetPath) {
      const ext = path.extname(sourcePath);
      const dir = path.dirname(sourcePath);
      const base = path.basename(sourcePath, ext);
      targetPath = path.join(dir, `${base}_split`);
    }

    const size = +argValues.size;

    if (isNaN(size) || size <= 0) {
      throw createError(
        simpleTemplate(a.s.e.c.sp.invalidSplitSize, {
          Size: argValues.size,
        }),
        { code: "INVALID_SPLIT_SIZE" },
      );
    }

    const partPaths = await splitFile(sourcePath, targetPath, size);

    log(
      simpleTemplate(a.s.m.c.sp.fileSplitSuccess, {
        SourcePath: sourcePath,
      }),
    );

    partPaths.forEach((partPath, index) => {
      log(
        simpleTemplate(a.s.m.c.sp.partCreated, {
          PartNumber: index + 1,
          PartPath: partPath,
        }),
      );
    });
    return 0;
  }
}
