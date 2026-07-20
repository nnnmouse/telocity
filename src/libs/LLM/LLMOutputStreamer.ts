import { stringWidth, x } from "../core/index.ts";

function spanToAnsi(span: TextSpan): string {
  let s = span.text;
  if (span.isAnsi) return s;
  if (span.styles.size > 0) {
    if (span.styles.has("bold")) s = `\x1b[1m${s}\x1b[22m`;
    if (span.styles.has("italic")) s = `\x1b[3m${s}\x1b[23m`;
    if (span.styles.has("code")) s = `\x1b[33m${s}\x1b[39m`;
    if (span.styles.has("link")) s = `\x1b[34m\x1b[4m${s}\x1b[24m\x1b[39m`;
    if (span.styles.has("link-url")) s = `\x1b[2m${s}\x1b[22m`;
    if (span.styles.has("heading-text")) s = `\x1b[33m${s}\x1b[39m`;
    if (span.styles.has("heading-hash"))
      s = `\x1b[1m\x1b[33m${s}\x1b[39m\x1b[22m`;
    if (span.styles.has("dim")) s = `\x1b[2m${s}\x1b[22m`;
  }
  return s;
}

export function renderLineToString(line: RenderLine): string {
  return line.map((span) => spanToAnsi(span)).join("");
}

export type TextStyle =
  | "bold"
  | "italic"
  | "code"
  | "link"
  | "link-url"
  | "heading-text"
  | "heading-hash"
  | "dim";

export interface TextSpan {
  text: string;
  width: number;
  styles: Set<TextStyle>;
  isAnsi?: boolean;
}

export type RenderLine = TextSpan[];

export interface StreamRenderer {
  commit(lines: RenderLine[]): Promise<void> | void;
  update(lines: RenderLine[]): Promise<void> | void;
  flush(): Promise<void> | void;
  writeRaw(text: string): Promise<void> | void;
  reset(): void;
}

export type InlineNode =
  | { type: "text"; content: string }
  | { type: "ansi"; content: string }
  | { type: "bold"; content: InlineNode[] }
  | { type: "italic"; content: InlineNode[] }
  | { type: "code"; content: string }
  | { type: "link"; text: InlineNode[]; url: string };

export type BlockNode =
  | { type: "paragraph"; content: InlineNode[] }
  | { type: "heading"; level: number; content: InlineNode[] }
  | { type: "codeblock"; language: string; content: string }
  | { type: "blockquote"; content: InlineNode[] }
  | {
      type: "list";
      items: {
        indent: string;
        text: InlineNode[];
        ordered: boolean;
        startNumber?: number;
      }[];
    }
  | { type: "table"; rows: InlineNode[][][] };

export type Char = {
  str: string;
  width: number;
  styles: TextStyle[];
  isAnsi?: boolean;
};

export function tokenizeInline(
  src: string,
  useMarkdown: boolean = true,
): InlineNode[] {
  const nodes: InlineNode[] = [];
  let current = 0;

  // eslint-disable-next-line no-control-regex
  const ANSI_REGEX = /^\x1b\[[0-9;?]*[a-zA-Z]/;

  while (current < src.length) {
    const ansiMatch = ANSI_REGEX.exec(src.slice(current));
    if (ansiMatch) {
      nodes.push({ type: "ansi", content: ansiMatch[0]! });
      current += ansiMatch[0]!.length;
      continue;
    }

    if (useMarkdown) {
      if (src[current] === "\\" && current + 1 < src.length) {
        nodes.push({ type: "text", content: src[current + 1]! });
        current += 2;
        continue;
      }

      const boldMatch =
        /^\*\*(?!\s|\*)((?:[^\n]|\n(?!\s*\n))*?[^\s*])\*\*(?!\*)/.exec(
          src.slice(current),
        );
      if (boldMatch) {
        const content = boldMatch[1] || boldMatch[2]!;
        nodes.push({ type: "bold", content: tokenizeInline(content, true) });
        current += boldMatch[0]!.length;
        continue;
      }

      const italicMatch =
        /^\*(?!\s|\*)((?:[^\n]|\n(?!\s*\n))*?[^\s*])\*(?!\*)/.exec(
          src.slice(current),
        );
      if (italicMatch) {
        const content = italicMatch[1] || italicMatch[2]!;
        nodes.push({
          type: "italic",
          content: tokenizeInline(content, true),
        });
        current += italicMatch[0]!.length;
        continue;
      }

      const codeMatch = /^`((?:[^`\n]|\n(?!\s*\n))+)`/.exec(src.slice(current));
      if (codeMatch) {
        nodes.push({ type: "code", content: codeMatch[1]! });
        current += codeMatch[0]!.length;
        continue;
      }

      const linkMatch =
        /^\[((?:[^\]\n]|\n(?!\s*\n))+)\]\(((?:[^)\n]|\n(?!\s*\n))+)\)/.exec(
          src.slice(current),
        );
      if (linkMatch) {
        nodes.push({
          type: "link",
          text: tokenizeInline(linkMatch[1]!, true),
          url: linkMatch[2]!,
        });
        current += linkMatch[0]!.length;
        continue;
      }
    }

    // eslint-disable-next-line no-control-regex
    const searchRegex = useMarkdown ? /[\x1b*`[\\]/ : /\x1b/;
    const nextSpecial = src.slice(current + 1).search(searchRegex);
    const advance = nextSpecial === -1 ? src.length - current : nextSpecial + 1;
    const textContent = src.slice(current, current + advance);

    const lastNode = nodes[nodes.length - 1];
    if (lastNode?.type === "text") {
      lastNode.content += textContent;
    } else {
      nodes.push({ type: "text", content: textContent });
    }

    current += advance;
  }

  return nodes;
}

export function parseBlocks(
  text: string,
  isCodeBlock: boolean,
  useMarkdown: boolean,
): BlockNode[] {
  if (!useMarkdown) {
    return [{ type: "paragraph", content: tokenizeInline(text, false) }];
  }

  if (isCodeBlock) {
    const match = text.match(/^```(\w*)\n([\s\S]*?)(\n```\n?)?$/);
    const lang = match ? match[1]! : "";
    const code = match ? match[2]! : text.replace(/^```(\w*)\n?/, "");
    return [{ type: "codeblock", language: lang, content: code }];
  }

  const blocks: BlockNode[] = [];
  const lines = text.split("\n");
  let currentBlockLines: string[] = [];
  let currentType: string | null = null;

  const flush = () => {
    if (currentBlockLines.length === 0) return;
    const blockText = currentBlockLines.join("\n");

    if (currentType === "heading") {
      const match = blockText.match(/^(#{1,6})\s+([\s\S]*)/);
      if (match) {
        blocks.push({
          type: "heading",
          level: match[1]!.length,
          content: tokenizeInline(match[2]!),
        });
      }
    } else if (currentType === "blockquote") {
      const content = currentBlockLines
        .map((l) => l.replace(/^>\s?/, ""))
        .join("\n");
      blocks.push({
        type: "blockquote",
        content: tokenizeInline(content),
      });
    } else if (currentType === "list") {
      const items: {
        indent: string;
        text: InlineNode[];
        ordered: boolean;
        startNumber?: number;
      }[] = [];
      let currentItemText = "";
      let currentIndent = "";
      let currentOrdered = false;
      let currentStartNumber: number | undefined = undefined;

      for (const line of currentBlockLines) {
        const match = line.match(/^(\s*)([-*•]|\d+\.)\s+(.*)/);
        if (match) {
          if (currentItemText) {
            items.push({
              indent: currentIndent,
              text: tokenizeInline(currentItemText),
              ordered: currentOrdered,
              startNumber: currentStartNumber,
            });
          }
          currentIndent = match[1]!;
          currentOrdered = /\d+\./.test(match[2]!);
          if (currentOrdered) {
            currentStartNumber = parseInt(match[2]!, 10);
          } else {
            currentStartNumber = undefined;
          }
          currentItemText = match[3]!;
        } else {
          currentItemText += (currentItemText ? " " : "") + line.trim();
        }
      }
      if (currentItemText) {
        items.push({
          indent: currentIndent,
          text: tokenizeInline(currentItemText),
          ordered: currentOrdered,
          startNumber: currentStartNumber,
        });
      }
      blocks.push({ type: "list", items });
    } else if (currentType === "table") {
      const rows = currentBlockLines.map((l) => {
        const cells = l.split("|").map((c) => c.trim());
        if (cells.length > 0 && cells[0] === "") cells.shift();
        if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
        return cells.map((c) => tokenizeInline(c));
      });

      if (
        rows.length > 1 &&
        /^[\s|:-]+$/.test(currentBlockLines[1]!) &&
        currentBlockLines[1]!.includes("-") &&
        currentBlockLines[1]!.includes("|")
      ) {
        rows.splice(1, 1);
      }
      blocks.push({ type: "table", rows });
    } else {
      blocks.push({
        type: "paragraph",
        content: tokenizeInline(blockText),
      });
    }
    currentBlockLines = [];
    currentType = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (!trimmed) {
      flush();
      continue;
    }

    if (trimmed.startsWith("#")) {
      flush();
      currentType = "heading";
      currentBlockLines.push(line);
      flush();
    } else if (trimmed.startsWith(">")) {
      if (currentType !== "blockquote") flush();
      currentType = "blockquote";
      currentBlockLines.push(line);
    } else if (/^\s*[-*•]\s|^\s*\d+\.\s/.test(line)) {
      if (currentType !== "list") flush();
      currentType = "list";
      currentBlockLines.push(line);
    } else if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      if (currentType !== "table") flush();
      currentType = "table";
      currentBlockLines.push(line);
    } else {
      // 1. Lists: Terminate if the line is unindented and has no list prefix
      if (currentType === "list" && !/^\s/.test(line)) {
        flush();
      }
      // 2. Blockquotes: Terminate strictly if the line is unindented and has no quote prefix
      if (currentType === "blockquote" && !/^\s/.test(line)) {
        flush();
      }
      // 3. Tables: Terminate strictly if the line does not match the table syntax wrapping
      if (currentType === "table") {
        flush();
      }

      if (
        currentType === "list" ||
        currentType === "blockquote" ||
        currentType === "table"
      ) {
        currentBlockLines.push(line);
      } else {
        if (currentType !== "paragraph") flush();
        currentType = "paragraph";
        currentBlockLines.push(line);
      }
    }
  }
  flush();
  return blocks;
}

function flattenToChars(
  nodes: InlineNode[],
  activeStyles: TextStyle[] = [],
): Char[] {
  const { segmenter: graphemeSegmenter } = x.appState;
  const chars: Char[] = [];
  for (const n of nodes) {
    if (n.type === "text") {
      for (const { segment: r } of graphemeSegmenter.segment(n.content)) {
        chars.push({ str: r, width: stringWidth(r), styles: activeStyles });
      }
    } else if (n.type === "ansi") {
      for (const { segment: r } of graphemeSegmenter.segment(n.content)) {
        chars.push({ str: r, width: 0, styles: activeStyles, isAnsi: true });
      }
    } else if (n.type === "bold") {
      chars.push(...flattenToChars(n.content, [...activeStyles, "bold"]));
    } else if (n.type === "italic") {
      chars.push(...flattenToChars(n.content, [...activeStyles, "italic"]));
    } else if (n.type === "code") {
      for (const { segment: r } of graphemeSegmenter.segment(n.content)) {
        chars.push({
          str: r,
          width: stringWidth(r),
          styles: [...activeStyles, "code"],
        });
      }
    } else if (n.type === "link") {
      chars.push(...flattenToChars(n.text, [...activeStyles, "link"]));
      for (const { segment: r } of graphemeSegmenter.segment(` (${n.url})`)) {
        chars.push({ str: r, width: stringWidth(r), styles: ["link-url"] });
      }
    }
  }
  return chars;
}

function wrapChars(chars: Char[], maxWidth: number): Char[][] {
  if (chars.length === 0) return [[]];
  const { wordSegmenter } = x.appState;

  const pureChars: Char[] = [];
  const ansiTokens: { index: number; char: Char }[] = [];
  let pureText = "";

  for (const c of chars) {
    if (c.isAnsi) {
      ansiTokens.push({ index: pureChars.length, char: c });
    } else {
      pureChars.push(c);
      pureText += c.str;
    }
  }

  const isSpace = (s: string) => /^\s+$/.test(s);
  const isClosePunct = (s: string) =>
    /^[.,!?:;)\]}>”’。，、！？：；）】》」』\-"']+$/.test(s);
  const isOpenPunct = (s: string) => /^[([{<“‘「『【《]+$/.test(s);

  interface ChunkDef {
    text: string;
    chars: Char[];
    width: number;
    isWhitespace: boolean;
  }

  const chunks: ChunkDef[] = [];
  let currentText = "";
  let currentChars: Char[] = [];
  let currentWidth = 0;
  let pureCharIndex = 0;

  for (const { segment } of wordSegmenter.segment(pureText)) {
    const segmentChars: Char[] = [];
    let segWidth = 0;
    let accumulated = "";

    while (
      accumulated.length < segment.length &&
      pureCharIndex < pureChars.length
    ) {
      const pc = pureChars[pureCharIndex]!;
      segmentChars.push(pc);
      accumulated += pc.str;
      segWidth += pc.width;
      pureCharIndex++;
    }

    if (!currentText) {
      currentText = segment;
      currentChars = segmentChars;
      currentWidth = segWidth;
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
        chars: currentChars,
        width: currentWidth,
        isWhitespace: isSpace(currentText),
      });
      currentText = segment;
      currentChars = segmentChars;
      currentWidth = segWidth;
    } else {
      currentText += segment;
      currentChars.push(...segmentChars);
      currentWidth += segWidth;
    }
  }

  if (currentText) {
    chunks.push({
      text: currentText,
      chars: currentChars,
      width: currentWidth,
      isWhitespace: isSpace(currentText),
    });
  }

  let ansiTokensIdx = 0;
  let pureOffset = 0;

  for (const chunk of chunks) {
    const finalChars: Char[] = [];

    while (
      ansiTokensIdx < ansiTokens.length &&
      ansiTokens[ansiTokensIdx]!.index <= pureOffset
    ) {
      finalChars.push(ansiTokens[ansiTokensIdx]!.char);
      ansiTokensIdx++;
    }

    for (const pc of chunk.chars) {
      finalChars.push(pc);
      pureOffset++;
      while (
        ansiTokensIdx < ansiTokens.length &&
        ansiTokens[ansiTokensIdx]!.index === pureOffset
      ) {
        finalChars.push(ansiTokens[ansiTokensIdx]!.char);
        ansiTokensIdx++;
      }
    }
    chunk.chars = finalChars;
  }

  while (ansiTokensIdx < ansiTokens.length) {
    if (chunks.length > 0) {
      chunks[chunks.length - 1]!.chars.push(ansiTokens[ansiTokensIdx]!.char);
    } else {
      chunks.push({
        text: "",
        chars: [ansiTokens[ansiTokensIdx]!.char],
        width: 0,
        isWhitespace: true,
      });
    }
    ansiTokensIdx++;
  }

  const lines: Char[][] = [];
  let currentLine: Char[] = [];
  let currentLineWidth = 0;

  for (const chunk of chunks) {
    if (chunk.isWhitespace) {
      for (const c of chunk.chars) {
        if (c.str === "\n") {
          lines.push(currentLine);
          currentLine = [];
          currentLineWidth = 0;
        } else {
          if (currentLineWidth + c.width <= maxWidth) {
            currentLine.push(c);
            currentLineWidth += c.width;
          }
        }
      }
    } else {
      if (currentLineWidth > 0 && currentLineWidth + chunk.width > maxWidth) {
        lines.push(currentLine);
        currentLine = [];
        currentLineWidth = 0;
      }

      if (chunk.width > maxWidth || currentLineWidth + chunk.width > maxWidth) {
        for (const c of chunk.chars) {
          if (currentLineWidth + c.width > maxWidth) {
            lines.push(currentLine);
            currentLine = [];
            currentLineWidth = 0;
          }
          currentLine.push(c);
          currentLineWidth += c.width;
        }
      } else {
        currentLine.push(...chunk.chars);
        currentLineWidth += chunk.width;
      }
    }
  }

  if (currentLine.length > 0) lines.push(currentLine);
  return lines.length > 0 ? lines : [[]];
}

function areSetsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function charsToRenderLine(chars: Char[]): RenderLine {
  const spans: TextSpan[] = [];
  let currentSpan: TextSpan | null = null;

  for (const c of chars) {
    const styleSet = new Set(c.styles);
    if (
      !currentSpan ||
      !areSetsEqual(currentSpan.styles, styleSet) ||
      currentSpan.isAnsi !== c.isAnsi
    ) {
      if (currentSpan) spans.push(currentSpan);
      currentSpan = {
        text: c.str,
        width: c.width,
        styles: styleSet,
        isAnsi: c.isAnsi,
      };
    } else {
      currentSpan.text += c.str;
      currentSpan.width += c.width;
    }
  }
  if (currentSpan) spans.push(currentSpan);
  return spans;
}

function createSpan(text: string, styles: TextStyle[] = []): TextSpan {
  return { text, width: stringWidth(text), styles: new Set(styles) };
}

export interface ChunkAction {
  type: "commit" | "update";
  text: string;
  isCodeBlock: boolean;
}

export class MarkdownAccumulator {
  private activeBuffer = "";
  private isCodeBlock = false;
  public useMarkdown: boolean;

  constructor(useMarkdown: boolean) {
    this.useMarkdown = useMarkdown;
  }

  public process(chunk: string): ChunkAction[] {
    this.activeBuffer += chunk;
    const actions: ChunkAction[] = [];

    while (true) {
      if (!this.useMarkdown) {
        const newlineIdx = this.activeBuffer.indexOf("\n");
        if (newlineIdx !== -1) {
          const block = this.activeBuffer.slice(0, newlineIdx + 1);
          actions.push({ type: "commit", text: block, isCodeBlock: false });
          this.activeBuffer = this.activeBuffer.slice(newlineIdx + 1);
          continue;
        } else {
          actions.push({
            type: "update",
            text: this.activeBuffer,
            isCodeBlock: false,
          });
          break;
        }
      }

      if (!this.isCodeBlock) {
        const codeBlockMatch = this.activeBuffer.match(/```(\w*)\n/);
        if (codeBlockMatch && codeBlockMatch.index !== undefined) {
          if (codeBlockMatch.index > 0) {
            const preText = this.activeBuffer.slice(0, codeBlockMatch.index);
            actions.push({ type: "commit", text: preText, isCodeBlock: false });
            this.activeBuffer = this.activeBuffer.slice(codeBlockMatch.index);
            continue;
          }
          this.isCodeBlock = true;
        }
      }

      if (this.isCodeBlock) {
        const endMatch = this.activeBuffer.match(/\n```\n/);
        if (endMatch) {
          const blockEnd = endMatch.index! + endMatch[0]!.length;
          const blockContent = this.activeBuffer.slice(0, blockEnd);
          actions.push({
            type: "commit",
            text: blockContent,
            isCodeBlock: true,
          });
          this.activeBuffer = this.activeBuffer.slice(blockEnd);
          this.isCodeBlock = false;
          continue;
        } else {
          actions.push({
            type: "update",
            text: this.activeBuffer,
            isCodeBlock: true,
          });
          break;
        }
      } else {
        const paragraphEnd = this.activeBuffer.match(/\n\s*\n/);
        if (paragraphEnd) {
          const blockEnd = paragraphEnd.index! + paragraphEnd[0]!.length;
          const blockContent = this.activeBuffer.slice(0, blockEnd);
          actions.push({
            type: "commit",
            text: blockContent,
            isCodeBlock: false,
          });
          this.activeBuffer = this.activeBuffer.slice(blockEnd);
          continue;
        } else {
          actions.push({
            type: "update",
            text: this.activeBuffer,
            isCodeBlock: false,
          });
          break;
        }
      }
    }

    return actions;
  }

  public flush(): ChunkAction[] {
    const actions: ChunkAction[] = [];
    if (this.activeBuffer) {
      actions.push({
        type: "commit",
        text: this.activeBuffer,
        isCodeBlock: this.isCodeBlock,
      });
      this.activeBuffer = "";
    }
    return actions;
  }

  public reset(): void {
    this.activeBuffer = "";
    this.isCodeBlock = false;
  }
}

export class LayoutEngine {
  private lockedTableWidths: number[] | null = null;
  private useMarkdown: boolean;

  constructor(useMarkdown: boolean) {
    this.useMarkdown = useMarkdown;
  }

  public clearState() {
    this.lockedTableWidths = null;
  }

  public reset(): void {
    this.clearState();
  }

  public layout(
    text: string,
    isCodeBlock: boolean,
    maxWidth: number,
    termHeight: number,
  ): RenderLine[] {
    const astBlocks = parseBlocks(text, isCodeBlock, this.useMarkdown);
    const lines: RenderLine[] = [];
    let newLockedWidths: number[] | null = null;

    for (const block of astBlocks) {
      const result = this.layoutBlock(block, maxWidth);
      lines.push(...result.lines);
      if (result.tableWidths) {
        newLockedWidths = result.tableWidths;
      }
    }

    // Lock widths if we are rendering a table and its height approaches terminal boundaries
    if (
      lines.length >= termHeight - 2 &&
      newLockedWidths &&
      !this.lockedTableWidths
    ) {
      this.lockedTableWidths = newLockedWidths;
    }

    return lines;
  }

  private layoutBlock(
    node: BlockNode,
    width: number,
  ): { lines: RenderLine[]; tableWidths?: number[] } {
    const { segmenter: graphemeSegmenter } = x.appState;
    switch (node.type) {
      case "paragraph": {
        const chars = flattenToChars(node.content);
        const wrapped = wrapChars(chars, width);
        return { lines: wrapped.map(charsToRenderLine) };
      }
      case "heading": {
        const chars = flattenToChars(node.content, ["heading-text"]);
        const hashStr = "#".repeat(node.level) + " ";
        const hashChars: Char[] = [];
        for (const { segment: r } of graphemeSegmenter.segment(hashStr)) {
          hashChars.push({
            str: r,
            width: stringWidth(r),
            styles: ["heading-hash"],
          });
        }
        chars.unshift(...hashChars);
        const wrapped = wrapChars(chars, width);
        return { lines: wrapped.map(charsToRenderLine) };
      }
      case "blockquote": {
        const chars = flattenToChars(node.content);
        const wrapped = wrapChars(chars, Math.max(10, width - 2));
        const lines = wrapped.map((charLine) => {
          const renderLine = charsToRenderLine(charLine);
          renderLine.unshift(createSpan("▎ ", ["dim"]));
          return renderLine;
        });
        return { lines };
      }
      case "list": {
        const lines: RenderLine[] = [];
        let orderCount = 1;
        node.items.forEach((item) => {
          const chars = flattenToChars(item.text);
          if (item.ordered && item.startNumber !== undefined) {
            orderCount = item.startNumber;
          }
          const prefixStr = item.ordered ? `${orderCount++}. ` : `• `;
          const fullPrefix = `${item.indent}${prefixStr}`;
          const pWidth = stringWidth(fullPrefix);
          const wrapped = wrapChars(chars, Math.max(10, width - pWidth));

          wrapped.forEach((charLine, i) => {
            const renderLine = charsToRenderLine(charLine);
            if (i === 0) {
              renderLine.unshift(createSpan(fullPrefix, ["bold"]));
            } else {
              renderLine.unshift(createSpan(" ".repeat(pWidth)));
            }
            lines.push(renderLine);
          });
        });
        return { lines };
      }
      case "codeblock": {
        const lines: RenderLine[] = [];
        const borderStr = "─".repeat(Math.min(width, 40));

        // Top border
        const topBorder: RenderLine = [createSpan(borderStr, ["dim"])];
        if (node.language) {
          topBorder.push(createSpan(` ${node.language}`, ["dim"]));
        }
        lines.push(topBorder);

        // Code content - wrapped to prevent terminal auto-wrapping bugs
        const codeLines = node.content.split("\n");
        for (const cl of codeLines) {
          const chars = flattenToChars([{ type: "text", content: cl }]);
          const wrapped = wrapChars(chars, width);
          for (const charLine of wrapped) {
            const renderLine = charsToRenderLine(charLine);
            // Apply the 'code' style to each wrapped span
            renderLine.forEach((span) => span.styles.add("code"));
            lines.push(renderLine);
          }
        }

        // Bottom border
        lines.push([createSpan(borderStr, ["dim"])]);

        return { lines };
      }
      case "table": {
        const colCounts = node.rows.map((r) => r.length);
        const maxCols = Math.max(...colCounts);
        if (maxCols === 0) return { lines: [] };

        let colWidths: number[];

        if (
          this.lockedTableWidths &&
          this.lockedTableWidths.length >= maxCols
        ) {
          colWidths = this.lockedTableWidths.slice(0, maxCols);
        } else {
          colWidths = new Array(maxCols).fill(3);
          for (const row of node.rows) {
            for (let i = 0; i < row.length; i++) {
              if (!row[i]) continue;
              const cellChars = flattenToChars(row[i]!);
              let maxLineLen = 0;
              let currentLineLen = 0;
              for (const c of cellChars) {
                if (c.str === "\n") {
                  maxLineLen = Math.max(maxLineLen, currentLineLen);
                  currentLineLen = 0;
                } else {
                  currentLineLen += c.width;
                }
              }
              maxLineLen = Math.max(maxLineLen, currentLineLen);
              const currentCW = colWidths[i] ?? 3;
              colWidths[i] = Math.max(currentCW, maxLineLen);
            }
          }

          const totalPaddingAndBorders = (maxCols + 1) * 3;
          const availableWidth = Math.max(
            maxCols,
            width - totalPaddingAndBorders,
          );
          const totalContentWidth = colWidths.reduce((a, b) => a + (b ?? 3), 0);

          if (totalContentWidth > availableWidth) {
            // Water-filling sort algorithm: grant smallest required space first.
            const sortedIndices = colWidths
              .map((w, i) => ({ w: w ?? 3, i }))
              .sort((a, b) => a.w - b.w);

            let remainingWidth = availableWidth;
            let remainingCols = maxCols;

            for (const item of sortedIndices) {
              const fairShare = Math.floor(remainingWidth / remainingCols);
              const granted = Math.min(item.w, fairShare);
              const actualGranted = Math.max(1, granted);

              colWidths[item.i] = actualGranted;
              remainingWidth -= actualGranted;
              remainingCols--;
            }
          }
        }

        const lines: RenderLine[] = [];

        // Build row separator
        const rowSep: RenderLine = [createSpan("|", ["dim"])];
        for (let i = 0; i < maxCols; i++) {
          rowSep.push(createSpan("─".repeat((colWidths[i] ?? 1) + 2), ["dim"]));
          rowSep.push(createSpan("|", ["dim"]));
        }

        lines.push(rowSep);

        node.rows.forEach((row, rIdx) => {
          const cellLines = new Array(maxCols).fill(0).map((_, cIdx) => {
            const cell = row[cIdx] || [];
            const chars = flattenToChars(cell);
            return wrapChars(chars, colWidths[cIdx] ?? 1).map(
              charsToRenderLine,
            );
          });

          const maxRowLines = Math.max(1, ...cellLines.map((cl) => cl.length));
          for (let i = 0; i < maxRowLines; i++) {
            const line: RenderLine = [
              createSpan("|", ["dim"]),
              createSpan(" "),
            ];

            for (let cIdx = 0; cIdx < maxCols; cIdx++) {
              const cellLine = cellLines[cIdx]![i] || [];
              const textLength = cellLine.reduce((acc, c) => acc + c.width, 0);
              const cw = colWidths[cIdx] ?? 1;
              const pad = " ".repeat(Math.max(0, cw - textLength));

              if (rIdx === 0) {
                cellLine.forEach((span) => span.styles.add("bold"));
              }

              line.push(...cellLine);
              line.push(createSpan(`${pad} `));
              line.push(createSpan("|", ["dim"]));
              if (cIdx < maxCols - 1) line.push(createSpan(" "));
            }
            lines.push(line);
          }

          lines.push(rowSep);
        });

        return { lines, tableWidths: colWidths };
      }
    }
  }
}

export class AnsiTerminalRenderer implements StreamRenderer {
  private printedLines: string[] = [];
  private writeFn: (s: string) => Promise<void> | void;
  private useMarkdown: boolean;
  private stripEmpty: boolean;
  private markdownBrainRot: boolean;

  constructor(
    writeFn: (s: string) => Promise<void> | void,
    useMarkdown: boolean,
    formatting?: { stripEmpty?: boolean; markdownBrainRot?: boolean },
  ) {
    this.writeFn = writeFn;
    this.useMarkdown = useMarkdown;
    this.stripEmpty = formatting?.stripEmpty ?? false;
    this.markdownBrainRot = formatting?.markdownBrainRot ?? false;
  }

  public reset(): void {
    this.printedLines = [];
  }

  public async commit(lines: RenderLine[]): Promise<void> {
    const strLines = lines.map((l) => renderLineToString(l));
    await this.updateTerminal(strLines);

    if (strLines.length > 0 && !this.stripEmpty) {
      // Append separating newline if using markdown, OR if in NOMD path with markdownBrainRot
      if (this.useMarkdown || this.markdownBrainRot) {
        await this.writeFn("\n");
      }
    }
    this.printedLines = [];
  }

  public async update(lines: RenderLine[]): Promise<void> {
    const strLines = lines.map((l) => renderLineToString(l));
    await this.updateTerminal(strLines);
  }

  public async writeRaw(text: string): Promise<void> {
    await this.writeFn(text);
  }

  public async flush(): Promise<void> {
    await this.writeFn("\x1b[0m"); // Safety reset
  }

  private async updateTerminal(newLines: string[]) {
    let diffIdx = 0;
    while (
      diffIdx < this.printedLines.length &&
      diffIdx < newLines.length &&
      this.printedLines[diffIdx] === newLines[diffIdx]
    ) {
      diffIdx++;
    }

    if (diffIdx === this.printedLines.length && diffIdx === newLines.length) {
      return;
    }

    const termHeight = process?.stdout?.rows ?? 24;
    let linesToMoveUp = this.printedLines.length - diffIdx;

    if (linesToMoveUp >= termHeight) {
      diffIdx = this.printedLines.length - (termHeight - 1);
      linesToMoveUp = termHeight - 1;
    }

    let out = "";
    if (linesToMoveUp > 0) {
      out += `\x1b[${linesToMoveUp}A`;
    }

    for (let i = diffIdx; i < newLines.length; i++) {
      // Encapsulate ANSI to prevent bleeds
      out += `\x1b[G\x1b[0m${newLines[i]!}\x1b[0m\x1b[K\n`;
    }

    const orphanedLines = this.printedLines.length - newLines.length;
    if (orphanedLines > 0) {
      for (let i = 0; i < orphanedLines; i++) {
        // Encapsulate ANSI on clear line actions
        out += `\x1b[G\x1b[0m\x1b[K\n`;
      }
      out += `\x1b[${orphanedLines}A`;
    }

    if (out) {
      await this.writeFn(out);
    }

    this.printedLines = newLines;
  }
}

export class TerminalStreamer {
  private accumulator: MarkdownAccumulator;
  private layoutEngine: LayoutEngine;
  private renderer: StreamRenderer;

  private renderPromise: Promise<void> | null = null;
  private pendingChunks: string[] = [];

  private maxWidth: number;
  private stripEmpty: boolean;
  private markdownBrainRot: boolean;
  private streaming: boolean;
  private useMarkdown: boolean;

  // Local buffer for static, non-streaming sequential output
  private rawBuffer = "";
  private consecutiveNewlines = 0;

  constructor(
    maxWidth: number,
    writeFn: (s: string) => Promise<void> | void,
    useMarkdown: boolean = true,
    formatting?: {
      stripEmpty?: boolean;
      markdownBrainRot?: boolean;
      streaming?: boolean;
    },
  ) {
    this.maxWidth = maxWidth;
    this.useMarkdown = useMarkdown;
    this.stripEmpty = formatting?.stripEmpty ?? false;
    this.streaming = formatting?.streaming ?? true;

    // Apply the asymmetry rule: if both are enabled, suppress markdownBrainRot.
    this.markdownBrainRot =
      formatting?.stripEmpty && formatting?.markdownBrainRot
        ? false
        : (formatting?.markdownBrainRot ?? false);

    this.accumulator = new MarkdownAccumulator(useMarkdown);
    this.layoutEngine = new LayoutEngine(useMarkdown);

    // Pass the active configuration to the renderer
    this.renderer = new AnsiTerminalRenderer(writeFn, useMarkdown, {
      stripEmpty: this.stripEmpty,
      markdownBrainRot: this.markdownBrainRot,
    });
  }

  // oxlint-disable-next-line require-await
  public async process(chunk: string): Promise<void> {
    if (!this.streaming) {
      this.rawBuffer += chunk;
      return;
    }

    this.pendingChunks.push(chunk);

    if (!this.renderPromise) {
      this.renderPromise = this.processQueue();
    }
  }

  private async processQueue() {
    try {
      while (this.pendingChunks.length > 0) {
        const chunk = this.pendingChunks.shift()!;
        const actions = this.accumulator.process(chunk);

        for (const action of actions) {
          await this.executeAction(action);
        }
      }
    } finally {
      this.renderPromise = null;
    }
  }

  private async executeAction(action: ChunkAction) {
    if (!action.text.trim() && !action.isCodeBlock) {
      if (action.type === "commit") {
        let newlines = action.text.match(/\n/g)?.length || 0;

        if (this.accumulator.useMarkdown) {
          // Markdown Path
          if (this.stripEmpty) {
            const allowed = 1 - this.consecutiveNewlines;
            newlines = Math.max(0, allowed);
          } else if (this.markdownBrainRot) {
            const allowed = 2 - this.consecutiveNewlines;
            newlines = Math.max(0, allowed);
          } else {
            // Standard Markdown Mode: cap consecutive blank lines at 2 (exactly 1 blank line gap)
            const allowed = 2 - this.consecutiveNewlines;
            newlines = Math.max(0, Math.min(newlines, allowed));
          }
        } else {
          // Plain Text Path (NOMD)
          if (this.stripEmpty) {
            newlines = 0; // Discard all empty lines
          } else if (this.markdownBrainRot) {
            // Double space mode: collapse multiple consecutive newlines down to exactly one blank line
            const allowed = 2 - this.consecutiveNewlines;
            newlines = Math.max(0, allowed);
          } else {
            // Pass-through mode: preserve empty lines exactly as they are in the stream
          }
        }

        if (newlines > 0) {
          await this.renderer.writeRaw("\n".repeat(newlines));
          this.consecutiveNewlines += newlines;
        }
        this.layoutEngine.clearState();
      }
      return;
    }

    const termCols = process?.stdout?.columns ?? this.maxWidth;
    const termHeight = process?.stdout?.rows ?? 24;
    // Adapt to terminal dimensions, with a sane minimum of 20 columns and user config upper limit
    const effectiveWidth = Math.max(20, Math.min(this.maxWidth, termCols));

    // Suppress purely blank lines in non-markdown raw plain text streaming
    if (
      !this.accumulator.useMarkdown &&
      this.stripEmpty &&
      !action.text.trim()
    ) {
      return;
    }

    const lines = this.layoutEngine.layout(
      action.text,
      action.isCodeBlock,
      effectiveWidth,
      termHeight,
    );

    if (action.type === "commit") {
      await this.renderer.commit(lines);
      this.layoutEngine.clearState();

      // Update our newline counter based on whether the renderer wrote the separator newline.
      // - If we are in Markdown mode with stripEmpty: false, we printed 2 newlines (text line ending + separator).
      // - If we are in Plain Text mode with markdownBrainRot: true, we printed 2 newlines (text line ending + separator).
      // - Otherwise, we only printed 1 newline (the line ending).
      const printedSeparator =
        !this.stripEmpty &&
        (this.accumulator.useMarkdown || this.markdownBrainRot);

      this.consecutiveNewlines = printedSeparator ? 2 : 1;
    } else {
      await this.renderer.update(lines);
    }
  }

  public async flush(): Promise<void> {
    if (!this.streaming) {
      if (this.rawBuffer) {
        const termCols = process?.stdout?.columns ?? this.maxWidth;
        const effectiveWidth = Math.max(20, Math.min(this.maxWidth, termCols));

        // Parse the contiguous raw buffer into an array of BlockNode elements (AST)
        const astBlocks = parseBlocks(this.rawBuffer, false, this.useMarkdown);

        // Render each block sequentially, inserting layout separations as rendering choices
        for (let i = 0; i < astBlocks.length; i++) {
          const block = astBlocks[i]!;

          // Accessing the private layoutBlock method via bracket notation
          const result = this.layoutEngine["layoutBlock"](
            block,
            effectiveWidth,
          );

          for (const line of result.lines) {
            const ansified = renderLineToString(line);
            await this.renderer.writeRaw(ansified + "\n");
          }

          // Write a separating newline between consecutive blocks if stripEmpty is inactive
          if (
            i < astBlocks.length - 1 &&
            !this.stripEmpty &&
            (this.useMarkdown || this.markdownBrainRot)
          ) {
            await this.renderer.writeRaw("\n");
          }
        }

        // Output one final trailing separating newline block to separate from terminal prompt
        if (
          astBlocks.length > 0 &&
          !this.stripEmpty &&
          (this.useMarkdown || this.markdownBrainRot)
        ) {
          await this.renderer.writeRaw("\n");
        }
      }
      await this.renderer.flush();
      this.reset();
      return;
    }

    if (this.renderPromise) {
      await this.renderPromise;
    }

    const finalActions = this.accumulator.flush();
    for (const action of finalActions) {
      await this.executeAction(action);
    }

    await this.renderer.flush();
    this.reset();
  }

  public reset(): void {
    this.consecutiveNewlines = 0;
    this.accumulator.reset();
    this.layoutEngine.reset();
    this.renderer.reset();
    this.pendingChunks = [];
    this.renderPromise = null;
    this.rawBuffer = "";
  }
}

export function stripMarkdownFormatting(text: string): string {
  const blocks = parseBlocks(text, false, true);
  function inlineToPlainText(nodes: InlineNode[]): string {
    let result = "";
    for (const n of nodes) {
      if (n.type === "text" || n.type === "ansi" || n.type === "code") {
        result += n.content;
      } else if (n.type === "bold" || n.type === "italic") {
        result += inlineToPlainText(n.content);
      } else if (n.type === "link") {
        result += inlineToPlainText(n.text);
      }
    }
    return result;
  }

  let result = "";
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (
      b.type === "paragraph" ||
      b.type === "heading" ||
      b.type === "blockquote"
    ) {
      result += inlineToPlainText(b.content);
    } else if (b.type === "codeblock") {
      result += b.content;
    } else if (b.type === "list") {
      let orderCount = 1;
      const items = b.items.map((item) => {
        if (item.ordered && item.startNumber !== undefined) {
          orderCount = item.startNumber;
        }
        const prefix = item.ordered ? `${orderCount++}. ` : "- ";
        return item.indent + prefix + inlineToPlainText(item.text);
      });
      result += items.join("\n");
    } else if (b.type === "table") {
      const rows = b.rows.map((row) => {
        return row.map((cell) => inlineToPlainText(cell)).join(" | ");
      });
      result += rows.join("\n");
    }
    if (i < blocks.length - 1) {
      result += "\n\n";
    }
  }
  return result;
}
