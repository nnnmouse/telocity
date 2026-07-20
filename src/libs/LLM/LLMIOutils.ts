import type { ReadStream, WriteStream } from "node:fs";

import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { finished, pipeline } from "node:stream/promises";

import { miniGlob } from "../core/index.ts";
import {
  atomicWriteFile,
  createError,
  errlog,
  exitOne,
  isEexistError,
  isEnoentError,
  isNodeError,
  isTypeError,
  log,
  red,
  simpleTemplate,
  x,
} from "../core/index.ts";
import {
  type JSONLStrategy,
  type ParsedJsonlLine,
  type ResolveJSONLStrategyOpts,
} from "../types/LLMTypes.ts";
import { OpenAIJSONLStrategy } from "./OpenAIStrategy.ts";
import { OpenRouterJSONLStrategy } from "./OpenRouterStrategy.ts";

const MAX_SIZE_MB = 100;
const MAX_BYTES = MAX_SIZE_MB * (1 << 20);

export async function validateFiles(sourcePath?: string, targetPath?: string) {
  const { a } = x;

  if (!sourcePath && !targetPath) return;

  // Skip validation checks on sourcePath if standard input or virtual input is used
  if (sourcePath && sourcePath !== "-") {
    try {
      // It serves as both the existence check and size check.
      const stats = await stat(sourcePath);

      if (stats.size > MAX_BYTES) {
        throw createError(
          simpleTemplate(a.s.e.lllm.invalidFileSize, {
            MAX_SIZE_MB: MAX_SIZE_MB,
          }),
          { code: "FILE_TOO_LARGE" },
        );
      }
    } catch (err) {
      if (isEnoentError(err)) {
        throw createError(
          simpleTemplate(a.s.e.lllm.fileNotFound, {
            FilePath: sourcePath,
          }),
          { code: "ENOENT", cause: err },
        );
      }
      throw err;
    }
  }

  if (sourcePath && targetPath && sourcePath === targetPath) {
    throw createError(a.s.e.lllm.sourceAndTargetMustBeDifferent, {
      code: "SOURCE_TARGET_SAME",
    });
  }
}

export async function resolveFileContent(value: string): Promise<string> {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  // A file path cannot contain newlines
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    return value;
  }

  try {
    const stats = await stat(trimmed);
    if (stats.isFile()) {
      if (stats.size > MAX_BYTES) {
        throw createError(
          simpleTemplate(x.a.s.e.lllm.invalidFileSize, {
            MAX_SIZE_MB: MAX_SIZE_MB,
          }),
          { code: "FILE_TOO_LARGE" },
        );
      }
      return await readFile(trimmed, "utf-8");
    }
  } catch (err) {
    if (isNodeError(err) && err.code === "FILE_TOO_LARGE") {
      throw err;
    }
  }

  return value;
}

export async function splitFile(
  sourcePath: string,
  targetPath: string,
  size = 1,
): Promise<string[]> {
  const { a } = x;
  await validateFiles(sourcePath);

  const sourceStats = await stat(sourcePath);
  const maxBytes = size * (1 << 20);
  const MEMORY_BUFFER_THRESHOLD = 64 * 1024;

  if (sourceStats.size <= maxBytes) {
    return [sourcePath];
  }

  try {
    await stat(targetPath);
    throw createError(
      red(
        simpleTemplate(a.s.e.lllm.targetFileExists, {
          TargetPath: targetPath,
        }),
      ),
      { code: "TARGET_EXISTS" },
    );
  } catch (err) {
    if (isEnoentError(err)) {
      await mkdir(targetPath, { recursive: true });
    } else {
      throw err;
    }
  }

  const sourceExt = path.extname(sourcePath);
  const sourceBaseName = path.basename(sourcePath, sourceExt);

  const partPaths: string[] = [];
  let partNumber = 0;
  let currentWriter: WriteStream | null = null;
  let currentPartSize = 0;
  let readStream: ReadStream | null = null;

  let writeBuffer: Buffer[] = [];
  let bufferedBytes = 0;

  const flushBuffer = async () => {
    if (writeBuffer.length === 0 || !currentWriter) return;

    const data = Buffer.concat(writeBuffer, bufferedBytes);

    if (!currentWriter.write(data)) {
      await once(currentWriter, "drain");
    }

    writeBuffer = [];
    bufferedBytes = 0;
  };

  const createNewPart = async () => {
    await flushBuffer();

    if (currentWriter) {
      currentWriter.end();
      await finished(currentWriter);
    }

    partNumber++;
    const partPath = path.join(
      targetPath,
      `${sourceBaseName}_part${partNumber}${sourceExt}`,
    );
    partPaths.push(partPath);

    currentWriter = createWriteStream(partPath, { flags: "wx" });

    await new Promise<void>((resolve, reject) => {
      currentWriter!.once("open", () => resolve());
      currentWriter!.once("error", reject);
    });

    currentPartSize = 0;
  };

  try {
    await createNewPart();
    readStream = createReadStream(sourcePath);
    let leftover = Buffer.alloc(0);

    for await (const chunk of readStream) {
      const buf = chunk as Uint8Array as Buffer;
      const work = Buffer.concat([leftover, buf]);

      let start = 0;
      for (let i = 0; i < work.length; i++) {
        if (work[i] === 0x0a) {
          const lineBuf = Buffer.from(work.subarray(start, i + 1));
          const lineSize = lineBuf.length;

          if (currentPartSize > 0 && currentPartSize + lineSize > maxBytes) {
            await createNewPart();
          }

          writeBuffer.push(lineBuf);
          bufferedBytes += lineSize;
          currentPartSize += lineSize;

          if (bufferedBytes >= MEMORY_BUFFER_THRESHOLD) {
            await flushBuffer();
          }

          start = i + 1;
        }
      }

      if (start < work.length) {
        leftover = Buffer.from(work.subarray(start));
      } else {
        leftover = Buffer.alloc(0);
      }
    }

    if (leftover.length > 0) {
      const lineBuf = leftover;
      const lineSize = lineBuf.length;

      if (currentPartSize > 0 && currentPartSize + lineSize > maxBytes) {
        await createNewPart();
      }

      writeBuffer.push(lineBuf);
      bufferedBytes += lineSize;
      currentPartSize += lineSize;
    }

    await flushBuffer();
  } catch (err) {
    if (isTypeError(err)) throw err;
    if (isEexistError(err)) {
      throw createError(
        red(
          simpleTemplate(a.s.e.lllm.targetFileExists, {
            TargetPath: a.s.e.lllm.partFileCollision,
          }),
        ),
        { code: "TARGET_EXISTS" },
      );
    }
    throw createError(a.s.e.lcli.unknownErrorOccurred, { cause: err });
  } finally {
    if (readStream) {
      readStream.destroy();
    }
    const finalWriter = currentWriter as WriteStream | null;

    if (finalWriter) {
      try {
        await flushBuffer();
        finalWriter.end();
        await finished(finalWriter);
      } catch {
        finalWriter.destroy();
      }
    }
  }

  return partPaths;
}

export async function mergeFiles(
  sourcePath: string,
  targetPath: string,
  extension: string,
  includePatterns: string[] = [],
  excludePatterns: string[] = [],
): Promise<number> {
  const { a } = x;

  let outputPath = "";
  let isDir = false;

  // Determine if the target path is a directory or a specific file name
  try {
    const stats = await stat(targetPath);
    isDir = stats.isDirectory();
  } catch {
    // If the path doesn't exist, analyze its structure
    const hasExt = !!path.extname(targetPath);
    const endsWithSlash = targetPath.endsWith("/") || targetPath.endsWith("\\");
    isDir = !hasExt || endsWithSlash;
  }

  if (isDir) {
    const mergedFileName = `${extension}_merged.txt`;
    outputPath = path.join(targetPath, mergedFileName);
  } else {
    outputPath = targetPath;
  }

  const ext = extension.startsWith(".") ? extension : `.${extension}`;

  const normalizePattern = (p: string) => {
    let posix = p.replace(/\\/g, "/");

    if (posix.startsWith("./")) posix = posix.slice(2);
    if (posix.startsWith("/")) posix = posix.slice(1);

    if (!posix.includes("/")) {
      return `**/${posix}`;
    }

    return posix;
  };

  const normalizedIncludes = [
    ...new Set(includePatterns.map(normalizePattern)),
  ];
  const normalizedExcludes = [
    ...new Set(excludePatterns.map(normalizePattern)),
  ];

  const searchPatterns =
    normalizedIncludes.length > 0 ? normalizedIncludes : [`**/*${ext}`];

  const matchedFiles = await miniGlob(searchPatterns, {
    cwd: sourcePath,
    ignore: normalizedExcludes,
    nodir: true,
    absolute: true,
  });

  const files: { filePath: string; fileSize: number }[] = [];

  for (const filePath of matchedFiles) {
    if (!filePath.endsWith(ext)) continue;
    const stats = await stat(filePath);
    files.push({ filePath, fileSize: stats.size });
  }

  if (files.length === 0) {
    errlog(
      red(
        simpleTemplate(a.s.e.lllm.noFilesFound, {
          Extension: extension,
        }),
      ),
    );
    exitOne();
    return 1;
  }

  files.sort((a, b) =>
    a.filePath.localeCompare(b.filePath, undefined, { numeric: true }),
  );

  const totalSizeBytes = files.reduce((sum, file) => sum + file.fileSize, 0);
  if (totalSizeBytes > MAX_BYTES) {
    errlog(
      red(
        simpleTemplate(a.s.e.lllm.invalidFileSize, {
          MAX_SIZE_MB: MAX_SIZE_MB,
        }),
      ),
    );
    exitOne();
    return 1;
  }

  async function* generateMergedData() {
    for (const { filePath } of files) {
      const fileHeaderStr = `--- File: ${path.basename(filePath)} ---\n`;

      yield Buffer.from(fileHeaderStr, "utf8");

      const readStream = createReadStream(filePath);
      for await (const chunk of readStream) {
        yield chunk;
      }
    }
  }

  try {
    // Ensure parent directory structure is recursively created
    await mkdir(path.dirname(outputPath), { recursive: true });

    const writer = createWriteStream(outputPath, { flags: "wx" });

    await pipeline(generateMergedData(), writer);

    log(
      simpleTemplate(a.s.m.lllm.filesMerged, {
        MergedFileName: path.basename(outputPath),
      }),
    );
  } catch (err) {
    if (isEexistError(err)) {
      throw createError(
        red(
          simpleTemplate(a.s.e.lllm.targetFileExists, {
            TargetPath: outputPath,
          }),
        ),
        { code: "TARGET_EXISTS" },
      );
    }

    await unlink(outputPath).catch(() => {});

    if (isTypeError(err)) {
      throw err;
    }
    throw createError(a.s.e.lcli.unknownErrorOccurred, { cause: err });
  }

  return 0;
}

export async function buildImageContent(
  imageArg: string | undefined | null,
): Promise<string[]> {
  const { a } = x;
  if (!imageArg) {
    return [];
  }

  const imageURIs: string[] = [];
  const patterns = imageArg.split(/:(?![\\/])/).map((p) => p.trim());

  for (const pattern of patterns) {
    const matches = await miniGlob(pattern, { nodir: true });

    for (const p of matches) {
      const ext = path.extname(p).toLowerCase();
      let mime: string | undefined;

      switch (ext) {
        case ".png":
          mime = "image/png";
          break;
        case ".jpg":
        case ".jpeg":
          mime = "image/jpeg";
          break;
        case ".gif":
          mime = "image/gif";
          break;
        case ".webp":
          mime = "image/webp";
          break;
        default:
          log(
            red(
              simpleTemplate(a.s.e.v.unsupportedImageType2, {
                Ext: ext,
                Image: p,
              }),
            ),
          );
          continue;
      }

      try {
        const stats = await stat(p);
        if (stats.size > MAX_BYTES) {
          throw createError(
            simpleTemplate(a.s.e.lllm.invalidFileSize, {
              MAX_SIZE_MB: MAX_SIZE_MB,
            }),
            { code: "FILE_TOO_LARGE" },
          );
        }

        const buffer = await readFile(p);
        imageURIs.push(`data:${mime};base64,${buffer.toString("base64")}`);
      } catch (err) {
        if (isEnoentError(err)) {
          log(red(simpleTemplate(a.s.e.v.imageNotFound, { Image: p })));
        } else {
          throw err;
        }
        continue;
      }
    }
  }

  if (patterns.length > 0 && imageURIs.length === 0) {
    log(red(simpleTemplate(a.s.e.v.unsupportedImageType, { Args: imageArg })));
  }

  return [...new Set(imageURIs)];
}

export async function buildAudioContent(
  audioArg: string | undefined | null,
): Promise<{ data: string; format: string } | undefined> {
  const { a } = x;
  if (!audioArg) {
    return undefined;
  }

  const ext = path.extname(audioArg).toLowerCase();
  const format = ext.slice(1);
  const supported = ["mp3", "mp4", "mpeg", "mpga", "m4a", "wav", "webm"];

  if (!supported.includes(format)) {
    throw createError(
      simpleTemplate(a.s.e.v.unsupportedAudioType, {
        Ext: ext,
        Audio: audioArg,
      }),
      { code: "UNSUPPORTED_AUDIO_TYPE" },
    );
  }

  try {
    const stats = await stat(audioArg);
    if (stats.size > MAX_BYTES) {
      throw createError(
        simpleTemplate(a.s.e.lllm.invalidFileSize, {
          MAX_SIZE_MB: MAX_SIZE_MB,
        }),
        { code: "FILE_TOO_LARGE" },
      );
    }

    const buffer = await readFile(audioArg);
    return { data: buffer.toString("base64"), format };
  } catch (err) {
    if (isEnoentError(err)) {
      throw createError(
        simpleTemplate(a.s.e.v.audioNotFound, { Audio: audioArg }),
        { code: "AUDIO_NOT_FOUND", cause: err },
      );
    }
    throw err;
  }
}

export function parseJsonlBatchLine(
  line: string,
  format?: string,
): ParsedJsonlLine {
  const strategy = resolveJSONLStrategy({ line, format });
  return strategy.parseLine(line);
}

export function extractText(sourceText: string): string {
  function extractFromChoices(body: Record<string, unknown>): string | null {
    const choices = body["choices"];
    if (Array.isArray(choices) && choices[0]) {
      const choice = choices[0] as Record<string, unknown>;
      const message = choice["message"] as Record<string, unknown> | undefined;
      if (message && typeof message["content"] === "string") {
        return message["content"];
      } else if (choice && typeof choice["text"] === "string") {
        return choice["text"];
      }
    }
    return null;
  }

  function extractFromOutput(body: Record<string, unknown>): string | null {
    const output = body["output"];
    if (Array.isArray(output)) {
      let extracted = "";
      for (const item of output) {
        if (item && typeof item === "object") {
          const itemRecord = item as Record<string, unknown>;
          if (
            itemRecord["type"] === "message" &&
            Array.isArray(itemRecord["content"])
          ) {
            for (const part of itemRecord["content"]) {
              if (part && typeof part === "object") {
                const partRecord = part as Record<string, unknown>;
                if (
                  partRecord["type"] === "output_text" &&
                  typeof partRecord["text"] === "string"
                ) {
                  extracted += partRecord["text"];
                }
              }
            }
          }
        }
      }
      return extracted || null;
    }
    return null;
  }

  const lines = sourceText.split("\n").filter((l) => l.trim() !== "");
  let result = "";

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        if (parsed["error"]) {
          continue;
        }

        const response = parsed["response"] as
          | Record<string, unknown>
          | undefined;
        const body = response?.["body"] as Record<string, unknown> | undefined;

        if (body && typeof body === "object") {
          if (body["error"]) {
            continue;
          }

          // Try standard choices format
          const choicesText = extractFromChoices(body);
          if (choicesText !== null) {
            result += choicesText + "\n\n";
            continue;
          }

          // Try structured output format
          const outputText = extractFromOutput(body);
          if (outputText !== null) {
            result += outputText + "\n\n";
            continue;
          }
        }
      }
    } catch {
      // Ignore lines that are incomplete or malformed JSON
    }
  }

  return result.trim() ? result.trim() : sourceText;
}

export function isJsonl(sourceText: string): boolean {
  const firstLine = sourceText.split("\n").find((l) => l.trim() !== "");
  if (!firstLine || !firstLine.trim().startsWith("{")) return false;
  try {
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    return !!(
      parsed &&
      typeof parsed === "object" &&
      ("custom_id" in parsed ||
        "response" in parsed ||
        "error" in parsed ||
        "body" in parsed)
    );
  } catch {
    return false;
  }
}

export async function mergeFailedRetries(
  originalPath: string,
  retryPath: string,
  outputPath: string,
  format?: string,
): Promise<void> {
  const { a } = x;
  const originalText = await readFile(originalPath, "utf-8");
  const retryText = await readFile(retryPath, "utf-8");

  const retryLines = retryText.split("\n").filter((l) => l.trim() !== "");
  const retryMap = new Map<string, string>();

  for (const line of retryLines) {
    const parsed = parseJsonlBatchLine(line, format);
    if (parsed.customId && parsed.customId !== "unknown") {
      // If a retry was run multiple times, this keeps the LAST generated line
      retryMap.set(parsed.customId, line);
    }
  }

  const originalLines = originalText.split("\n").filter((l) => l.trim() !== "");
  const used = new Set<string>();

  const finalLines = originalLines.map((line) => {
    const parsed = parseJsonlBatchLine(line, format);

    // If this line failed originally, and we have a retry for it...
    if (
      parsed.customId &&
      parsed.customId !== "unknown" &&
      retryMap.has(parsed.customId)
    ) {
      const retryLine = retryMap.get(parsed.customId)!;
      const retryParsed = parseJsonlBatchLine(retryLine, format);

      // Only replace with successfully completed requests
      if (!retryParsed.isError) {
        used.add(parsed.customId);
        return retryLine;
      }
    }
    return line;
  });

  // Append any retries that weren't in the original mapping
  // (just in case they were lost during a crash)
  for (const [cid, line] of retryMap.entries()) {
    if (!used.has(cid)) {
      const retryParsed = parseJsonlBatchLine(line, format);
      if (!retryParsed.isError) {
        finalLines.push(line);
      }
    }
  }

  const outputText = finalLines.join("\n") + "\n";
  await atomicWriteFile(outputPath, outputText);
  log(
    simpleTemplate(a.s.m.lllm.filesMerged, {
      MergedFileName: outputPath,
    }),
  );
}

export function resolveJSONLStrategy(
  opts: ResolveJSONLStrategyOpts = {},
): JSONLStrategy {
  const { format, line } = opts;

  // OpenAI JSONL format
  if (format === "openai" || format?.startsWith("openai-")) {
    return new OpenAIJSONLStrategy();
  }

  // OpenRouter
  if (format === "openrouter") {
    return new OpenRouterJSONLStrategy();
  }

  if (line) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        // Check for telocity metadata block on compiled requests
        const telocityEndpoint = parsed.telocity?.endpoint;
        if (
          typeof telocityEndpoint === "string" &&
          telocityEndpoint.startsWith("openrouter-")
        ) {
          return new OpenRouterJSONLStrategy();
        }

        // Check structured processed response bodies
        const body = parsed.response?.body;
        if (body && typeof body === "object") {
          if ("provider" in body) {
            return new OpenRouterJSONLStrategy();
          }

          const choices = body.choices;
          if (Array.isArray(choices) && choices[0]) {
            const firstChoice = choices[0];
            if (
              "native_finish_reason" in firstChoice ||
              firstChoice.message?.reasoning_details ||
              firstChoice.message?.reasoning
            ) {
              return new OpenRouterJSONLStrategy();
            }
          }
        }
      }
    } catch {
      // Downstream JSONL parsers will catch the malformed JSON syntax natively
    }
  }

  // Fallback
  return new OpenAIJSONLStrategy();
}
