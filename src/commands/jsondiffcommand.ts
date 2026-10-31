import { mkdir, readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import path from "node:path";

import type { Command } from "../libs/types/index.ts";

import {
  atomicWriteFile,
  createError,
  errlog,
  exitOne,
  generateHelpText,
  isEnoentError,
  log,
  customParseArgs as parseArgs,
  red,
  blue,
  simpleTemplate,
  x,
} from "../libs/core/index.ts";
import { validateFiles } from "../libs/LLM/index.ts";

export default class JsonDiffCommand implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "file" as const;
  }
  static get options() {
    return {
      merge: { type: "boolean", short: "m", default: false },
      split: { type: "boolean", short: "s", default: false },
      size: { type: "string", short: "S" },
      help: { type: "boolean", short: "h" },
    } as const;
  }

  async execute(argv: string[]): Promise<number> {
    const { a } = x;
    const Cmd = this.constructor as typeof JsonDiffCommand;

    const { values: argValues, positionals } = parseArgs({
      args: argv,
      options: Cmd.options,
      allowPositionals: Cmd.allowPositionals,
      strict: true,
    });

    const displayHelp = () => {
      const helpText = generateHelpText(a.s.help.commands.jd, Cmd.options);
      log(helpText);
    };

    if (argValues.help) {
      displayHelp();
      return 0;
    }

    if (!positionals[1] || !positionals[2]) {
      exitOne();
      displayHelp();
      errlog(red(a.s.e.lllm.sourceTargetRequired));
      return 1;
    }

    const firstPath = path.resolve(process.cwd(), positionals[1]);
    const secondPath = path.resolve(process.cwd(), positionals[2]);

    if (argValues.split) {
      // Split Mode
      // Position 1: JSON file to split
      // Position 2: Output Directory
      await validateFiles(firstPath);

      try {
        await stat(secondPath);
      } catch (err) {
        if (isEnoentError(err)) {
          await mkdir(secondPath, { recursive: true });
        } else {
          throw err;
        }
      }

      const sizeKb = argValues.size ? parseInt(argValues.size, 10) : 20;
      if (isNaN(sizeKb) || sizeKb <= 0) {
        throw createError(
          simpleTemplate(a.s.e.c.jd.invalidSplitSize, {
            Size: argValues.size || "",
          }),
          { code: "INVALID_SPLIT_SIZE" },
        );
      }

      const maxBytes = sizeKb * 1024;
      let fileData: unknown;

      try {
        fileData = JSON.parse(await readFile(firstPath, "utf-8"));
      } catch (err) {
        throw createError(
          simpleTemplate(a.s.e.c.jd.invalidJson, { FilePath: firstPath }),
          { cause: err, code: "INVALID_JSON" },
        );
      }

      const leaves = this.flatten(fileData);
      if (leaves.length === 0) {
        throw createError(a.s.e.c.jd.emptyJson, {
          code: "EMPTY_JSON",
        });
      }

      const partitions: Array<Array<{ path: string[]; value: unknown }>> = [[]];
      let currentPartition = partitions[0]!;

      for (const leaf of leaves) {
        const testPartition = [...currentPartition, leaf];
        const testJsonStr = a.stringifyReadable(this.unflatten(testPartition));
        const sizeBytes = Buffer.byteLength(testJsonStr, "utf8");

        if (sizeBytes > maxBytes && currentPartition.length > 0) {
          currentPartition = [leaf];
          partitions.push(currentPartition);
        } else {
          currentPartition.push(leaf);
        }
      }

      const sourceExt = path.extname(firstPath);
      const sourceBaseName = path.basename(firstPath, sourceExt);

      for (let i = 0; i < partitions.length; i++) {
        const partObj = this.unflatten(partitions[i]!);
        const partFileName = `${sourceBaseName}_part${i + 1}${sourceExt}`;
        const partFilePath = path.join(secondPath, partFileName);

        await atomicWriteFile(partFilePath, a.stringifyReadable(partObj));
        log(
          simpleTemplate(a.s.m.c.jd.partCreated, {
            PartNumber: i + 1,
            PartPath: partFilePath,
          }),
        );
      }

      log(
        blue(
          simpleTemplate(a.s.m.c.jd.splitSuccess, {
            Count: partitions.length,
          }),
        ),
      );
      return 0;
    }

    if (argValues.merge) {
      // Merge Mode
      await validateFiles(firstPath, secondPath);

      let targetData: unknown;
      let translationData: unknown;

      try {
        targetData = JSON.parse(await readFile(firstPath, "utf-8"));
      } catch (err) {
        throw createError(
          simpleTemplate(a.s.e.c.jd.invalidJson, { FilePath: firstPath }),
          { cause: err, code: "INVALID_JSON" },
        );
      }

      try {
        translationData = JSON.parse(await readFile(secondPath, "utf-8"));
      } catch (err) {
        throw createError(
          simpleTemplate(a.s.e.c.jd.invalidJson, { FilePath: secondPath }),
          { cause: err, code: "INVALID_JSON" },
        );
      }

      const merged = this.deepMerge(targetData, translationData);
      await atomicWriteFile(firstPath, a.stringifyReadable(merged));

      log(
        blue(
          simpleTemplate(a.s.m.c.jd.mergedSuccess, {
            TranslationFile: path.basename(secondPath),
            TargetFile: path.basename(firstPath),
          }),
        ),
      );
      return 0;
    } else {
      // Comparison Mode
      await validateFiles(firstPath, secondPath);

      const outputPath = positionals[3]
        ? path.resolve(process.cwd(), positionals[3])
        : path.join(process.cwd(), "missing_strings.json");

      let sourceData: unknown;
      let targetData: unknown;

      try {
        sourceData = JSON.parse(await readFile(firstPath, "utf-8"));
      } catch (err) {
        throw createError(
          simpleTemplate(a.s.e.c.jd.invalidJson, { FilePath: firstPath }),
          { cause: err, code: "INVALID_JSON" },
        );
      }

      try {
        targetData = JSON.parse(await readFile(secondPath, "utf-8"));
      } catch (err) {
        throw createError(
          simpleTemplate(a.s.e.c.jd.invalidJson, { FilePath: secondPath }),
          { cause: err, code: "INVALID_JSON" },
        );
      }

      const missing = this.findMissing(sourceData, targetData);

      if (!missing) {
        log(blue(a.s.m.c.jd.fullyAligned));
        return 0;
      }

      await atomicWriteFile(outputPath, a.stringifyReadable(missing));
      log(
        blue(
          simpleTemplate(a.s.m.c.jd.savedSuccess, {
            OutputPath: outputPath,
          }),
        ),
      );
      return 0;
    }
  }

  private findMissing(source: unknown, target: unknown): unknown {
    if (typeof source !== "object" || source === null) {
      return undefined;
    }

    const sourceObj = source as Record<string, unknown>;
    const targetObj =
      typeof target === "object" && target !== null
        ? (target as Record<string, unknown>)
        : undefined;

    const missing: Record<string, unknown> = {};
    let hasMissing = false;

    for (const key of Object.keys(sourceObj)) {
      if (!targetObj || !(key in targetObj)) {
        missing[key] = sourceObj[key];
        hasMissing = true;
      } else {
        const sourceVal = sourceObj[key];
        const targetVal = targetObj[key];

        if (typeof sourceVal === "object" && sourceVal !== null) {
          const subMissing = this.findMissing(sourceVal, targetVal);
          if (subMissing !== undefined) {
            missing[key] = subMissing;
            hasMissing = true;
          }
        }
      }
    }

    return hasMissing ? missing : undefined;
  }

  private deepMerge(target: unknown, source: unknown): unknown {
    if (typeof source !== "object" || source === null) {
      return source;
    }

    const sourceObj = source as Record<string, unknown>;
    let targetObj =
      typeof target === "object" && target !== null
        ? (target as Record<string, unknown>)
        : {};

    targetObj = { ...targetObj };

    for (const key of Object.keys(sourceObj)) {
      const sourceVal = sourceObj[key];
      const targetVal = targetObj[key];

      if (typeof sourceVal === "object" && sourceVal !== null) {
        targetObj[key] = this.deepMerge(targetVal, sourceVal);
      } else {
        targetObj[key] = sourceVal;
      }
    }

    return targetObj;
  }

  private flatten(
    obj: unknown,
    pathParts: string[] = [],
  ): Array<{ path: string[]; value: unknown }> {
    if (typeof obj !== "object" || obj === null) {
      return [{ path: pathParts, value: obj }];
    }

    const results: Array<{ path: string[]; value: unknown }> = [];
    const record = obj as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      results.push(...this.flatten(record[key], [...pathParts, key]));
    }
    return results;
  }

  private unflatten(
    leaves: Array<{ path: string[]; value: unknown }>,
  ): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    for (const { path: p, value } of leaves) {
      let current = root;
      for (let i = 0; i < p.length; i++) {
        const part = p[i]!;
        if (i === p.length - 1) {
          current[part] = value;
        } else {
          if (
            !(part in current) ||
            typeof current[part] !== "object" ||
            current[part] === null
          ) {
            current[part] = {};
          }
          current = current[part] as Record<string, unknown>;
        }
      }
    }
    return root;
  }
}
