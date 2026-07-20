import type {
  AnsiStyle,
  CommandConstructor,
  CustomOptionConfig,
  CustomParseArgsConfig,
  CustomParsedResults,
  EnforceUniqueShorts,
  FormatAlignedListOptions,
  GenericHelpSection,
  HelpSection,
} from "../types/index.ts";

import { createError, stringWidth, x } from "./context.ts";

type InternalOptionConfig = CustomOptionConfig & { key: string };

function buildOptionMaps(
  options: Record<string, CustomOptionConfig> | undefined,
): {
  long: Map<string, InternalOptionConfig>;
  short: Map<string, InternalOptionConfig>;
} {
  const long = new Map<string, InternalOptionConfig>();
  const short = new Map<string, InternalOptionConfig>();

  if (!options) {
    return { long, short };
  }

  for (const [key, config] of Object.entries(options)) {
    const optionConfig: InternalOptionConfig = {
      key,
      ...config,
    };

    long.set(key, optionConfig);
    if (config.short) {
      short.set(config.short, optionConfig);
    }
  }
  return { long, short };
}

export function customParseArgs<
  T extends CustomParseArgsConfig<{
    options?: { [longOption: string]: CustomOptionConfig };
  }>,
>(
  config: T & { options?: EnforceUniqueShorts<T["options"]> },
): CustomParsedResults<T> {
  const { appState } = x;
  const {
    args = [],
    options = {},
    allowPositionals = false,
    strict = false,
  } = config;

  const optionMaps = buildOptionMaps(options);

  const results: {
    values: { [key: string]: string | boolean };
    positionals: string[];
  } = {
    values: {},
    positionals: [],
  };

  let i = 0;
  let parsingOptions = true;

  while (i < args.length) {
    const arg = args[i]!;

    if (arg === "--") {
      parsingOptions = false;
      i++;
      continue;
    }

    if (parsingOptions && arg.startsWith("-") && arg !== "-") {
      if (arg.startsWith("--")) {
        const [optName, optValue] = arg.slice(2).split("=", 2);
        const optConfig = optionMaps.long.get(optName!);

        if (!optConfig) {
          if (strict) {
            throw createError(
              simpleTemplate(appState.s.e.lcli.unknownOption, { Option: arg }),
              { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" },
            );
          }
          i++;
          continue;
        }

        if (optConfig.type === "boolean") {
          if (optValue !== undefined) {
            throw createError(
              simpleTemplate(appState.s.e.lcli.booleanWithValue, {
                Option: optName!,
              }),
              { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" },
            );
          }
          results.values[optConfig.key] = true;
        } else {
          if (optValue !== undefined) {
            results.values[optConfig.key] = optValue;
          } else if (
            i + 1 < args.length &&
            (args[i + 1] === "-" || !args[i + 1]?.startsWith("-"))
          ) {
            results.values[optConfig.key] = args[i + 1]!;
            i++;
          } else {
            throw createError(
              simpleTemplate(appState.s.e.lcli.missingValue, {
                Option: optName!,
              }),
              { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" },
            );
          }
        }
      } else {
        const shortOpts = arg.slice(1);
        for (let j = 0; j < shortOpts.length; j++) {
          const optChar = shortOpts[j]!;
          const optConfig = optionMaps.short.get(optChar);

          if (!optConfig) {
            if (strict) {
              throw createError(
                simpleTemplate(appState.s.e.lcli.unknownOption, {
                  Option: `-${optChar}`,
                }),
                { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" },
              );
            }
            continue;
          }

          if (optConfig.type === "boolean") {
            results.values[optConfig.key] = true;
          } else {
            if (j < shortOpts.length - 1) {
              results.values[optConfig.key] = shortOpts.slice(j + 1);
              break;
            } else if (
              i + 1 < args.length &&
              (args[i + 1] === "-" || !args[i + 1]?.startsWith("-"))
            ) {
              results.values[optConfig.key] = args[i + 1]!;
              i++;
            } else {
              throw createError(
                simpleTemplate(appState.s.e.lcli.missingValue, {
                  Option: `-${optChar}`,
                }),
                { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" },
              );
            }
          }
        }
      }
      i++;
    } else {
      if (allowPositionals || !parsingOptions) {
        results.positionals.push(arg);
      } else if (strict) {
        throw createError(
          simpleTemplate(appState.s.e.lcli.unexpectedPositional, {
            Argument: arg,
          }),
          { code: "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL" },
        );
      }
      i++;
    }
  }

  for (const config of optionMaps.long.values()) {
    const current = results.values[config.key];
    if (current !== undefined) continue;

    if (config.type === "boolean") {
      results.values[config.key] =
        config.default !== undefined ? config.default : false;
      continue;
    }

    if (config.default !== undefined) {
      results.values[config.key] = config.default;
    }
  }

  return results as CustomParsedResults<T>;
}

export function simpleTemplate(
  template: string,
  data: Record<string, string | number | boolean>,
): string {
  if (!template) return "";

  return template.replace(
    /\{\{\s*\.\s*(\w+)\s*\}\}/g,
    (match: string, key: string): string => {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        return String(data[key]);
      }
      return match;
    },
  );
}

export interface WrapTextOptions {
  width: number;
}

function commitLine(parts: string[], activeAnsi: string[]): string {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith("\x1b[")) continue;
    if (/^\s+$/.test(p)) {
      parts[i] = "";
    } else {
      parts[i] = p.trimEnd();
      break;
    }
  }
  let line = parts.join("");
  if (activeAnsi.length > 0) {
    line += "\x1b[0m";
  }
  return line;
}

export function wrapText(text: string, options: WrapTextOptions): string[] {
  if (!text) return [];

  const { width } = options;
  const paragraphs = text.split("\n");
  const result: string[] = [];
  const { appState } = x;
  const wordSegmenter = appState.wordSegmenter;
  const graphemeSegmenter = appState.segmenter;

  // eslint-disable-next-line no-control-regex
  const ANSI_REGEX = /\x1b\[[0-9;?]*[a-zA-Z]/g;

  const isSpace = (s: string) => /^\s+$/.test(s);
  const isClosePunct = (s: string) =>
    /^[.,!?:;)\]}>”’。，、！？：；）】》」』\-"']+$/.test(s);
  const isOpenPunct = (s: string) => /^[([{<“‘「『【《]+$/.test(s);

  for (const p of paragraphs) {
    if (p.length === 0) {
      result.push("");
      continue;
    }

    let pureText = "";
    const ansiTokens: { index: number; value: string }[] = [];
    let match: RegExpExecArray | null;
    ANSI_REGEX.lastIndex = 0;
    let lastIndex = 0;

    while ((match = ANSI_REGEX.exec(p)) !== null) {
      if (match.index > lastIndex) {
        pureText += p.substring(lastIndex, match.index);
      }
      ansiTokens.push({ index: pureText.length, value: match[0] });
      lastIndex = ANSI_REGEX.lastIndex;
    }
    if (lastIndex < p.length) {
      pureText += p.substring(lastIndex);
    }

    interface ChunkDef {
      text: string;
      startIndex: number;
      endIndex: number;
      isWhitespace: boolean;
    }

    const chunks: ChunkDef[] = [];
    let currentText = "";
    let currentStart = 0;

    for (const { segment, index } of wordSegmenter.segment(pureText)) {
      if (!currentText) {
        currentText = segment;
        currentStart = index;
        continue;
      }

      let canBreak = false;
      const lastChar = currentText.slice(-1);

      if (isSpace(segment)) {
        canBreak = !isSpace(currentText);
      } else if (isSpace(currentText)) {
        canBreak = true;
      } else if (isClosePunct(segment)) {
        canBreak = false;
      } else if (isOpenPunct(lastChar)) {
        canBreak = false;
      } else if (
        (lastChar === '"' || lastChar === "'" || lastChar === "-") &&
        currentText.trim().length === 1
      ) {
        canBreak = false;
      } else if (isClosePunct(lastChar)) {
        canBreak = true;
      } else {
        canBreak = true;
      }

      if (canBreak) {
        chunks.push({
          text: currentText,
          startIndex: currentStart,
          endIndex: currentStart + currentText.length,
          isWhitespace: isSpace(currentText),
        });
        currentText = segment;
        currentStart = index;
      } else {
        currentText += segment;
      }
    }

    if (currentText) {
      chunks.push({
        text: currentText,
        startIndex: currentStart,
        endIndex: currentStart + currentText.length,
        isWhitespace: isSpace(currentText),
      });
    }

    const chunkObjects: {
      parts: { type: "text" | "ansi"; value: string }[];
      width: number;
      isWhitespace: boolean;
    }[] = [];
    let ansiIndex = 0;

    for (const chunk of chunks) {
      const parts: { type: "text" | "ansi"; value: string }[] = [];

      while (
        ansiIndex < ansiTokens.length &&
        ansiTokens[ansiIndex]!.index <= chunk.startIndex
      ) {
        parts.push({ type: "ansi", value: ansiTokens[ansiIndex]!.value });
        ansiIndex++;
      }

      let textOffset = chunk.startIndex;
      while (
        ansiIndex < ansiTokens.length &&
        ansiTokens[ansiIndex]!.index < chunk.endIndex
      ) {
        const ansiToken = ansiTokens[ansiIndex]!;
        if (ansiToken.index > textOffset) {
          parts.push({
            type: "text",
            value: pureText.substring(textOffset, ansiToken.index),
          });
          textOffset = ansiToken.index;
        }
        parts.push({ type: "ansi", value: ansiToken.value });
        ansiIndex++;
      }

      if (textOffset < chunk.endIndex) {
        parts.push({
          type: "text",
          value: pureText.substring(textOffset, chunk.endIndex),
        });
      }

      chunkObjects.push({
        parts,
        width: stringWidth(chunk.text),
        isWhitespace: chunk.isWhitespace,
      });
    }

    const trailingAnsi: { type: "text" | "ansi"; value: string }[] = [];
    while (ansiIndex < ansiTokens.length) {
      trailingAnsi.push({ type: "ansi", value: ansiTokens[ansiIndex]!.value });
      ansiIndex++;
    }
    if (trailingAnsi.length > 0) {
      if (chunkObjects.length > 0) {
        chunkObjects[chunkObjects.length - 1]!.parts.push(...trailingAnsi);
      } else {
        chunkObjects.push({
          parts: trailingAnsi,
          width: 0,
          isWhitespace: true,
        });
      }
    }

    let currentLineParts: string[] = [];
    let currentLineWidth = 0;
    let activeAnsi: string[] = [];
    let hasNonWhitespace = false;

    const startNewLine = () => {
      currentLineParts = [];
      currentLineWidth = 0;
      hasNonWhitespace = false;
      if (activeAnsi.length > 0) {
        currentLineParts.push(activeAnsi.join(""));
      }
    };

    for (const chunk of chunkObjects) {
      if (chunk.isWhitespace) {
        for (const part of chunk.parts) {
          if (part.type === "ansi") {
            if (part.value.endsWith("m")) {
              if (part.value === "\x1b[0m" || part.value === "\x1b[m") {
                activeAnsi = [];
              } else {
                activeAnsi.push(part.value);
              }
            }
          }
          currentLineParts.push(part.value);
        }
        currentLineWidth += chunk.width;
      } else {
        if (hasNonWhitespace && currentLineWidth + chunk.width > width) {
          result.push(commitLine(currentLineParts, activeAnsi));
          startNewLine();
        }

        if (chunk.width > width || currentLineWidth + chunk.width > width) {
          const longWordParts: string[] = [];
          let longWordPartWidth = 0;

          for (const part of chunk.parts) {
            if (part.type === "ansi") {
              if (part.value.endsWith("m")) {
                if (part.value === "\x1b[0m" || part.value === "\x1b[m") {
                  activeAnsi = [];
                } else {
                  activeAnsi.push(part.value);
                }
              }
              longWordParts.push(part.value);
            } else {
              for (const { segment: grapheme } of graphemeSegmenter.segment(
                part.value,
              )) {
                const graphemeWidth = stringWidth(grapheme);
                if (
                  currentLineWidth + longWordPartWidth + graphemeWidth >
                  width
                ) {
                  currentLineParts.push(longWordParts.join(""));
                  result.push(commitLine(currentLineParts, activeAnsi));
                  startNewLine();

                  longWordParts.length = 0;
                  longWordParts.push(grapheme);
                  longWordPartWidth = graphemeWidth;
                } else {
                  longWordParts.push(grapheme);
                  longWordPartWidth += graphemeWidth;
                }
              }
            }
          }
          if (longWordParts.length > 0) {
            currentLineParts.push(longWordParts.join(""));
            currentLineWidth += longWordPartWidth;
            hasNonWhitespace = true;
          }
        } else {
          for (const part of chunk.parts) {
            if (part.type === "ansi") {
              if (part.value.endsWith("m")) {
                if (part.value === "\x1b[0m" || part.value === "\x1b[m") {
                  activeAnsi = [];
                } else {
                  activeAnsi.push(part.value);
                }
              }
            }
            currentLineParts.push(part.value);
          }
          currentLineWidth += chunk.width;
          hasNonWhitespace = true;
        }
      }
    }

    if (currentLineParts.length > 0) {
      const visibleContent = currentLineParts.some(
        (part) => !part.startsWith("\x1b[") && part.length > 0,
      );

      if (visibleContent || result.length === 0) {
        result.push(commitLine(currentLineParts, activeAnsi));
      }
    }
  }

  return result;
}

export function formatAlignedList(
  items: Array<{ key: string; description: string }>,
  options: FormatAlignedListOptions = {},
): string {
  const { appState } = x;
  if (items.length === 0) return "";

  const {
    terminalWidth: termWidth = appState.TERMINAL_WIDTH,
    columnGap = appState.LIST_INDENT_WIDTH,
    firstColumnSeparator = "",
    forceFirstColumnWidth,
    listIndentWidth = 0,
  } = options;

  const indentString = " ".repeat(listIndentWidth);
  const interstitial = firstColumnSeparator || " ".repeat(columnGap);
  const interstitialWidth = stringWidth(interstitial);

  // Minimum description width to preserve for aligned layout.
  // If rendering the description has less space than this, we stack the item.
  const MIN_DESC_WIDTH = 15;

  const stackedIndices = new Set<number>();
  const alignedCandidates: typeof items = [];

  // Identify which items must be stacked based on individual key length
  items.forEach((item, index) => {
    const keyWidth = stringWidth(`${indentString}${item.key}`);
    const availableSpace = termWidth - (keyWidth + interstitialWidth);

    if (availableSpace < MIN_DESC_WIDTH) {
      stackedIndices.add(index);
    } else {
      alignedCandidates.push(item);
    }
  });

  let alignmentWidth = 0;
  let finalWrapWidth = termWidth;

  if (alignedCandidates.length > 0) {
    const firstColumnParts = alignedCandidates.map(
      (item) => `${indentString}${item.key}`,
    );
    alignmentWidth =
      forceFirstColumnWidth ??
      Math.max(...firstColumnParts.map((part) => stringWidth(part)));
    finalWrapWidth = termWidth - (alignmentWidth + interstitialWidth);

    // If collective key lengths force the aligned column to squish the description too much,
    // degrade all items in this list block to a stacked layout for consistency.
    if (finalWrapWidth < MIN_DESC_WIDTH && !forceFirstColumnWidth) {
      items.forEach((_, idx) => stackedIndices.add(idx));
    }
  } else {
    items.forEach((_, idx) => stackedIndices.add(idx));
  }

  const alignmentIndent = " ".repeat(alignmentWidth + interstitialWidth);
  const lines: string[] = [];

  items.forEach((item, index) => {
    if (stackedIndices.has(index)) {
      // Stacked Layout: Wrap key and description on dedicated lines
      const wrappedKey = wrapText(item.key, {
        width: Math.max(10, termWidth - listIndentWidth),
      });
      wrappedKey.forEach((line) => {
        lines.push(`${indentString}${line}`);
      });

      if (item.description.trim() !== "") {
        // Indent description slightly further to denote nesting (e.g., listIndentWidth + 2)
        const descIndentAmount = listIndentWidth + 2;
        const descIndent = " ".repeat(descIndentAmount);
        const wrappedDesc = wrapText(item.description, {
          width: Math.max(10, termWidth - descIndentAmount),
        });
        wrappedDesc.forEach((line) => {
          lines.push(`${descIndent}${line}`);
        });
      }
    } else {
      // Aligned Layout: Two-column formatting
      const keyPart = `${indentString}${item.key}`;
      const padding = " ".repeat(
        Math.max(0, alignmentWidth - stringWidth(keyPart)),
      );
      const wrappedDesc = wrapText(item.description, { width: finalWrapWidth });

      lines.push(`${keyPart}${padding}${interstitial}${wrappedDesc[0] ?? ""}`);
      for (let i = 1; i < wrappedDesc.length; i++) {
        lines.push(`${alignmentIndent}${wrappedDesc[i]!}`);
      }
    }
  });

  return lines.join("\n");
}

export function generateHelpText(
  helpSection: HelpSection | GenericHelpSection,
  optionsConfig?: CommandConstructor["options"],
  replacements: Record<string, string> = {},
): string {
  const { appState } = x;
  const lines: string[] = [];

  const tpl = (s?: string) => (s ? simpleTemplate(s, replacements) : "");

  if ("commandDescriptions" in helpSection && "commandHeader" in helpSection) {
    const genericSection = helpSection;

    const headerText = tpl(genericSection.header);
    const usageText = tpl(genericSection.usage);
    const footerText = tpl(genericSection.footer);
    const commandHeaderText = tpl(genericSection.commandHeader);
    const globalOptionsHeaderText = tpl(genericSection.globalOptionsHeader);

    const commandItems = Object.entries(genericSection.commandDescriptions).map(
      ([cmd, desc]) => ({
        key: cmd,
        description: tpl(desc ?? ""),
      }),
    );

    const flagItems = genericSection.flags
      ? Object.entries(genericSection.flags).map(([flag, desc]) => ({
          key: `--${flag}`,
          description: tpl(desc ?? ""),
        }))
      : [];

    const allKeys = [
      ...commandItems.map((i) => i.key),
      ...flagItems.map((i) => i.key),
    ];
    const longestRawKeyWidth = Math.max(...allKeys.map((k) => stringWidth(k)));
    const forcedWidth = longestRawKeyWidth + appState.LIST_INDENT_WIDTH;
    const listOptions = {
      forceFirstColumnWidth: forcedWidth,
      listIndentWidth: appState.LIST_INDENT_WIDTH,
    };

    lines.push(...wrapText(headerText, { width: appState.TERMINAL_WIDTH }));
    lines.push("", ...wrapText(usageText, { width: appState.TERMINAL_WIDTH }));
    lines.push(`\n${commandHeaderText}`);
    lines.push(formatAlignedList(commandItems, listOptions));

    if (footerText) {
      lines.push(
        "",
        ...wrapText(footerText, { width: appState.TERMINAL_WIDTH }),
      );
    }

    if (flagItems.length > 0) {
      lines.push(`\n${globalOptionsHeaderText}`);
      lines.push(formatAlignedList(flagItems, listOptions));
    }
  } else {
    const specificSection = helpSection;

    const usageText = tpl(specificSection.usage);
    const descriptionText = tpl(specificSection.description);
    const footerText = tpl(specificSection.footer);

    lines.push(...wrapText(usageText, { width: appState.TERMINAL_WIDTH }));
    lines.push(
      "",
      ...wrapText(descriptionText, { width: appState.TERMINAL_WIDTH }),
    );

    if (specificSection.flags && optionsConfig) {
      lines.push(`\n${appState.s.help.optionsHeader}:`);

      const itemsToFormat = Object.entries(optionsConfig).map(
        ([longName, config]) => {
          const parts: string[] = [];
          if (config.short) parts.push(`-${config.short},`);
          parts.push(`--${longName}`);
          if (config.type === "string") parts.push("<value>");

          return {
            key: parts.join(" "),
            description: tpl(specificSection.flags?.[longName] ?? ""),
          };
        },
      );

      lines.push(
        formatAlignedList(itemsToFormat, {
          listIndentWidth: appState.LIST_INDENT_WIDTH,
        }),
      );
    }

    if (footerText) {
      lines.push(
        "",
        ...wrapText(footerText, { width: appState.TERMINAL_WIDTH }),
      );
    }
  }

  return lines.join("\n");
}

export function generateLocaleList(
  localeData: Record<string, { name: string }>,
): string {
  const { appState } = x;
  const items = Object.entries(localeData).map(([code, { name }]) => ({
    key: code,
    description: name,
  }));

  return formatAlignedList(items, {
    listIndentWidth: appState.LIST_INDENT_WIDTH,
    firstColumnSeparator: appState.SEPARATOR,
  });
}

export function log(...msg: unknown[]): void {
  try {
    const appState = x.appState;
    if (appState.hasActiveProgressLine) {
      process.stdout.write("\r\x1b[K");
      appState.hasActiveProgressLine = false;
    }
  } catch {
    /* ignore */
  }
  console.log(...msg);
}

export const ANSI_CODES = {
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  yellowBright: "\x1b[93m",
  blue: "\x1b[34m",

  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  strikethrough: "\x1b[9m",

  reset: "\x1b[0m",
  resetBoldDim: "\x1b[22m",
  resetItalic: "\x1b[23m",
  resetUnderline: "\x1b[24m",
  resetStrikethrough: "\x1b[29m",
} as const;

export const style =
  (start: string, end: string): AnsiStyle =>
  (text: string) =>
    `${start}${text}${end}`;

export const colorize = (color: keyof typeof ANSI_CODES): AnsiStyle =>
  style(ANSI_CODES[color], ANSI_CODES.reset);

export const noop: AnsiStyle = (text) => text;

const noColor = !!process.env["NO_COLOR"];
const useAnsi = process.stdout.isTTY === true && !noColor;

export const red = useAnsi ? colorize("red") : noop;
export const yellow = useAnsi ? colorize("yellow") : noop;
export const yellowBright = useAnsi ? colorize("yellowBright") : noop;
export const blue = useAnsi ? colorize("blue") : noop;

export const bold = useAnsi
  ? style(ANSI_CODES.bold, ANSI_CODES.resetBoldDim)
  : noop;
export const dim = useAnsi
  ? style(ANSI_CODES.dim, ANSI_CODES.resetBoldDim)
  : noop;
export const italic = useAnsi
  ? style(ANSI_CODES.italic, ANSI_CODES.resetItalic)
  : noop;
export const underline = useAnsi
  ? style(ANSI_CODES.underline, ANSI_CODES.resetUnderline)
  : noop;
export const strikethrough = useAnsi
  ? style(ANSI_CODES.strikethrough, ANSI_CODES.resetStrikethrough)
  : noop;

export const compose =
  (...fns: AnsiStyle[]): AnsiStyle =>
  (x: string) =>
    fns.reduceRight((v, f) => f(v), x);

export async function readStdin(): Promise<string> {
  let result = "";
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of process.stdin) {
    if (typeof chunk === "string") {
      result += chunk;
    } else {
      result += decoder.decode(chunk, { stream: true });
    }
  }
  result += decoder.decode();
  return result;
}
