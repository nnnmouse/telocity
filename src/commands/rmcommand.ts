import { unlink } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";

import type { Command } from "../libs/types/index.ts";

import {
  createError,
  generateHelpText,
  isEnoentError,
  log,
  customParseArgs as parseArgs,
  red,
  runConcur,
  simpleTemplate,
  x,
  yellowBright,
} from "../libs/core/index.ts";
import TcCommand from "./tccommand.ts";

interface TypeMap {
  string: string;
  boolean: boolean;
  number: number;
}

type RMCommandArgs = {
  [K in keyof typeof RMCommand.options]: TypeMap[(typeof RMCommand.options)[K]["type"]];
};

export default class RMCommand implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "file" as const;
  }
  static get options() {
    return {
      help: { type: "boolean", short: "h" },
      all: { type: "boolean", short: "a" },
      force: { type: "boolean", short: "f" },
      model: { type: "boolean", short: "m" },
      bin: { type: "boolean", short: "b" },
    } as const;
  }

  async execute(argv: string[]): Promise<number> {
    const { a } = x;
    const Cmd = this.constructor as typeof RMCommand;

    const { values: argValues, positionals } = parseArgs({
      args: argv,
      allowPositionals: Cmd.allowPositionals,
      strict: true,
      options: Cmd.options,
    }) as { values: RMCommandArgs; positionals: string[] };

    const rmHelp = () => {
      const helpText = generateHelpText(a.s.help.commands.rm, Cmd.options);
      log(helpText);
    };

    if (argValues.help) {
      rmHelp();
      return 0;
    }

    if (!a.isInteractive && !argValues.force) {
      throw createError(a.s.e.lcli.notInteractive, {
        code: "INTERACTIVE_NOT_SUPPORTED",
      });
    }

    const deleteFiles = async (filesToDelete: string[]) => {
      const deleteTasks = filesToDelete.map((file) => async () => {
        try {
          await unlink(file);
        } catch (err) {
          if (!isEnoentError(err)) {
            throw err;
          }
        }
      });
      await runConcur(deleteTasks, { concurrency: 64 });
      log(yellowBright(a.s.m.c.rm.filesDeletedSuccessfully));
    };

    // --- Path A: Model/Bin Deletion Path ---
    if (argValues.model || argValues.bin) {
      const filesToDelete: string[] = [];
      const modelsDir = path.join(a.STATE_DIR, "models");

      let targetModels: string[] = [];

      if (argValues.all) {
        targetModels = Object.keys(TcCommand.MODELS_TO_DOWNLOAD);
      } else {
        const modelName = positionals[1];
        if (!modelName) {
          throw createError(
            argValues.model ? a.s.e.c.rm.modelRequired : a.s.e.c.rm.binRequired,
            { code: "MODEL_NAME_REQUIRED" },
          );
        }
        targetModels = [modelName];
      }

      // Verify targeted models exist in the configuration
      for (const modelName of targetModels) {
        if (!(modelName in TcCommand.MODELS_TO_DOWNLOAD)) {
          throw createError(
            simpleTemplate(a.s.e.c.tc.modelNotFoundForDownload, {
              ModelName: modelName,
            }),
          );
        }
      }

      // Populate file lists depending on boolean flags
      if (argValues.model) {
        for (const modelName of targetModels) {
          filesToDelete.push(
            path.join(modelsDir, `${modelName}.json`),
            path.join(modelsDir, `${modelName}_config.json`),
          );
        }
      }

      if (argValues.bin) {
        for (const modelName of targetModels) {
          filesToDelete.push(path.join(modelsDir, `${modelName}.bin`));
        }
      }

      if (filesToDelete.length === 0) {
        throw createError(a.s.m.c.rm.noFilesToDelete, {
          code: "NO_FILES_TO_DELETE",
        });
      }

      log(red(a.s.m.c.rm.filesToDelete));
      log(filesToDelete.join("\n"));

      if (argValues.force) {
        await deleteFiles(filesToDelete);
        return 0;
      }

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        const answer = (await rl.question(red(a.s.m.lcli.deletionConfirm)))
          .trim()
          .toLowerCase();
        if (answer === a.s.m.lcli.yN) {
          await deleteFiles(filesToDelete);
        } else {
          log(red(a.s.m.lcli.deletionAborted));
        }
      } finally {
        rl.close();
      }
      return 0;
    }

    rmHelp();
    throw createError(a.s.e.lllm.sourceRequired, {
      code: "SOURCE_REQUIRED",
    });
  }
}
