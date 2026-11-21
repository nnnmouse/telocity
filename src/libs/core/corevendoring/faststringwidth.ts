/**
 * Vendored implementation of fast-string-width and fast-string-truncated-width.
 * Licensed under MIT. Copyright (c) 2024-present Fabio Spampinato
 * https://github.com/fabiospampinato/fast-string-width
 * https://github.com/fabiospampinato/fast-string-truncated-width
 */

/* TYPES */

export interface TruncationOptions {
  limit?: number;
  ellipsis?: string;
  ellipsisWidth?: number;
}

export interface WidthOptions {
  controlWidth?: number;
  tabWidth?: number;
  emojiWidth?: number;
  regularWidth?: number;
  wideWidth?: number;
}

export interface TruncationResult {
  width: number;
  index: number;
  truncated: boolean;
  ellipsed: boolean;
}

/* CONSTANTS & REGULAR EXPRESSIONS */

const SURROGATE_PAIR_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

// oxlint-disable-next-line no-control-regex
const ANSI_RE =
  // oxlint-disable-next-line no-control-regex
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|\u001b\]8;[^;]*;.*?(?:\u0007|\u001b\u005c)/y;
// oxlint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0A-\x1F\x7F-\x9F]{1,1000}/y;
const CJKT_WIDE_RE =
  /(?:(?![\uFF61-\uFF9F\uFF00-\uFFEF])[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Tangut}]){1,1000}/uy;
const TAB_RE = /\t{1,1000}/y;
const EMOJI_RE =
  /[\u{1F1E6}-\u{1F1FF}]{2}|\u{1F3F4}[\u{E0061}-\u{E007A}]{2}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,3}\u{E007F}|(?:\p{Emoji}\uFE0F\u20E3?|\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?|\p{Emoji_Presentation})(?:\u200D(?:\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?|\p{Emoji_Presentation}|\p{Emoji}\uFE0F\u20E3?))*/uy;
const LATIN_RE = /(?:[\x20-\x7E\xA0-\xFF](?!\uFE0F)){1,1000}/y;
const MODIFIER_RE = /\p{M}+/gu;

const NO_TRUNCATION_OPTS: TruncationOptions = {
  limit: Infinity,
  ellipsis: "",
  ellipsisWidth: 0,
};

/* UTILS */

export function getCodePointsLength(input: string): number {
  let surrogatePairsCount = 0;
  SURROGATE_PAIR_RE.lastIndex = 0;

  while (SURROGATE_PAIR_RE.test(input)) {
    surrogatePairsCount += 1;
  }

  return input.length - surrogatePairsCount;
}

export function isFullWidth(codePoint: number): boolean {
  return (
    codePoint === 0x3000 ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  );
}

export function isWideNotCJKTNotEmoji(codePoint: number): boolean {
  return (
    codePoint === 0x231b ||
    codePoint === 0x2329 ||
    (codePoint >= 0x2ff0 && codePoint <= 0x2fff) ||
    (codePoint >= 0x3001 && codePoint <= 0x303e) ||
    (codePoint >= 0x3099 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3105 && codePoint <= 0x312f) ||
    (codePoint >= 0x3131 && codePoint <= 0x318e) ||
    (codePoint >= 0x3190 && codePoint <= 0x31e3) ||
    (codePoint >= 0x31ef && codePoint <= 0x321e) ||
    (codePoint >= 0x3220 && codePoint <= 0x3247) ||
    (codePoint >= 0x3250 && codePoint <= 0x4dbf) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe52) ||
    (codePoint >= 0xfe54 && codePoint <= 0xfe66) ||
    (codePoint >= 0xfe68 && codePoint <= 0xfe6b) ||
    (codePoint >= 0x1f200 && codePoint <= 0x1f202) ||
    (codePoint >= 0x1f210 && codePoint <= 0x1f23b) ||
    (codePoint >= 0x1f240 && codePoint <= 0x1f248) ||
    (codePoint >= 0x20000 && codePoint <= 0x2fffd) ||
    (codePoint >= 0x30000 && codePoint <= 0x3fffd)
  );
}

/* CORE FUNCTIONS */

export function getStringTruncatedWidth(
  input: string,
  truncationOptions: TruncationOptions = {},
  widthOptions: WidthOptions = {},
): TruncationResult {
  const limit = truncationOptions.limit ?? Infinity;
  const ellipsis = truncationOptions.ellipsis ?? "";
  const ellipsisWidth =
    truncationOptions.ellipsisWidth ??
    (ellipsis
      ? getStringTruncatedWidth(ellipsis, NO_TRUNCATION_OPTS, widthOptions)
          .width
      : 0);

  const ansiWidth = 0;
  const controlWidth = widthOptions.controlWidth ?? 0;
  const tabWidth = widthOptions.tabWidth ?? 8;

  const emojiWidth = widthOptions.emojiWidth ?? 2;
  const fullWidthWidth = 2;
  const regularWidth = widthOptions.regularWidth ?? 1;
  const wideWidth = widthOptions.wideWidth ?? fullWidthWidth;

  const parseBlocks: [RegExp, number][] = [
    [LATIN_RE, regularWidth],
    [ANSI_RE, ansiWidth],
    [CONTROL_RE, controlWidth],
    [TAB_RE, tabWidth],
    [EMOJI_RE, emojiWidth],
    [CJKT_WIDE_RE, wideWidth],
  ];

  let indexPrev = 0;
  let index = 0;
  const length = input.length;
  let lengthExtra = 0;
  let truncationEnabled = false;
  let truncationIndex = length;
  const truncationLimit = Math.max(0, limit - ellipsisWidth);
  let unmatchedStart = 0;
  let unmatchedEnd = 0;
  let width = 0;
  let widthExtra = 0;

  outer: while (true) {
    if (
      unmatchedEnd > unmatchedStart ||
      (index >= length && index > indexPrev)
    ) {
      const unmatched =
        input.slice(unmatchedStart, unmatchedEnd) ||
        input.slice(indexPrev, index);

      lengthExtra = 0;

      for (const char of unmatched.replaceAll(MODIFIER_RE, "")) {
        const codePoint = char.codePointAt(0) || 0;

        if (isFullWidth(codePoint)) {
          widthExtra = fullWidthWidth;
        } else if (isWideNotCJKTNotEmoji(codePoint)) {
          widthExtra = wideWidth;
        } else {
          widthExtra = regularWidth;
        }

        if (width + widthExtra > truncationLimit) {
          truncationIndex = Math.min(
            truncationIndex,
            Math.max(unmatchedStart, indexPrev) + lengthExtra,
          );
        }

        if (width + widthExtra > limit) {
          truncationEnabled = true;
          break outer;
        }

        lengthExtra += char.length;
        width += widthExtra;
      }

      unmatchedStart = unmatchedEnd = 0;
    }

    if (index >= length) {
      break outer;
    }

    for (let i = 0, l = parseBlocks.length; i < l; i++) {
      const [blockRe, blockWidth] = parseBlocks[i]!;

      blockRe.lastIndex = index;

      if (blockRe.test(input)) {
        lengthExtra =
          blockRe === CJKT_WIDE_RE
            ? getCodePointsLength(input.slice(index, blockRe.lastIndex))
            : blockRe === EMOJI_RE
              ? 1
              : blockRe.lastIndex - index;
        widthExtra = lengthExtra * blockWidth;

        if (width + widthExtra > truncationLimit) {
          truncationIndex = Math.min(
            truncationIndex,
            index + Math.floor((truncationLimit - width) / blockWidth),
          );
        }

        if (width + widthExtra > limit) {
          truncationEnabled = true;
          break outer;
        }

        width += widthExtra;
        unmatchedStart = indexPrev;
        unmatchedEnd = index;
        index = indexPrev = blockRe.lastIndex;

        continue outer;
      }
    }

    index += 1;
  }

  return {
    width: truncationEnabled ? truncationLimit : width,
    index: truncationEnabled ? truncationIndex : length,
    truncated: truncationEnabled,
    ellipsed: truncationEnabled && limit >= ellipsisWidth,
  };
}

export default function fastStringWidth(
  input: string,
  options: WidthOptions = {},
): number {
  return getStringTruncatedWidth(input, NO_TRUNCATION_OPTS, options).width;
}
