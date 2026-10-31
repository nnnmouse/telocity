/* ⚠ MUST READ BEFORE EDITING ⚠
 * ARCHITECTURE AND DEVELOPMENT GUIDELINES FOR THE WEB COMPONENT PAGINATED READER
 *
 * 1. COMPONENT-DRIVEN ORCHESTRATION (paginatedreader.ts):
 *    Constructs the base HTML document. It bootstraps the entire application using a single
 *    unified root Custom Element: <telocity-reader></telocity-reader>.
 *
 * 2. SHADOW DOM STYLE ENCAPSULATION (paginatedreader.css.ts & Components):
 *    - Global Styles (paginatedreader.css.ts): Declares root CSS variables (themes, color tokens,
 *      and global layout parameters) that naturally cascade across shadow boundaries.
 *    - Scoped Styles: Component-specific layouts (e.g., buttons, inputs, modal containers) are
 *      encapsulated within each element's shadow root style block to prevent style pollution.
 *
 * 3. CLIENT-SIDE ARCHITECTURE (readerClient.js):
 *    Divided into five native, decoupled custom elements that communicate via standard DOM events:
 *    - <telocity-reader>: Main orchestrator, manages state (active book data) and DB transactions.
 *    - <telocity-header>: Hosts document title, font size selectors, theme toggling, and triple-tap recalc.
 *    - <telocity-viewport>: The binary-search pagination layout engine and sliding virtual pages.
 *    - <telocity-navigation>: Hosts prev/next actions, P/L input processing, and status text targets.
 *    - <telocity-library>: Modal overlay displaying local IndexedDB storage, manual imports, and CLI sync.
 *
 * PRACTICES AND DEVELOPER REQUIREMENTS:
 *
 * - EVENT-DRIVEN COMMUNICATION:
 *   Components must remain strictly decoupled. State flows downward from `<telocity-reader>` via properties
 *   and attributes. Actions and changes flow upward from child components using standard custom events
 *   with `{ bubbles: true, composed: true }` to traverse shadow boundaries.
 *
 * - BUILD SYSTEM COPY TASK:
 *   Because 'paginatedreader.ts' relies on runtime filesystem resolution (via fs.readFileSync)
 *   to load the client script, 'readerClient.js' must reside alongside the executable at runtime.
 *   The build script ('build.ts') automatically copies 'readerClient.js' from the source directory
 *   into 'dist/readerClient.js' upon compilation. Update the copy paths in 'build.ts' if files are moved.
 *
 * - RUNTIME DEPENDENCY INJECTION:
 *   Several utilities maintained in CLI modules (e.g., stripGarbageNewLines) are injected dynamically.
 *   The file 'readerClient.js' declares placeholder assignments paired with injection target comments:
 *     let stripGarbageNewLines = null; // [INJECT_STRIP_GARBAGE]
 *   These markers must remain unchanged to ensure that 'preprocessPaginator' can execute string
 *   substitutions successfully.
 *
 * - SAFE DATA BOUNDARIES (STATE PASSING):
 *   To pass structured server data securely to the client without causing document format or
 *   parsing exceptions, data must be serialized as JSON into a non-executable script container:
 *     <script id="page-data-container" type="application/json">
 *   The client script can then access and compile this block at runtime using JSON.parse().
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";

import type { LanguageStrings } from "../types/index.ts";

import { fastHash, resolveAsset } from "../core/context.ts";
import { isJsonl, extractText } from "../LLM/LLMIOutils.ts";
import {
  stripMarkdownFormatting,
  parseBlocks,
  tokenizeInline,
} from "../LLM/LLMOutputStreamer.ts";
import { stripGarbageNewLines } from "../LLM/LLMutils.ts";
import { readerStyles } from "./paginatedreader.css.ts";

export interface PaginatorOptions {
  pageData: LanguageStrings["m"]["c"]["rd"];
  isCli?: boolean;
  hasActiveBook?: boolean;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let cachedReaderScript: string | null = null;

async function loadReaderScript(): Promise<string> {
  if (cachedReaderScript !== null) {
    return cachedReaderScript;
  }

  if (isSea()) {
    cachedReaderScript = (await resolveAsset(
      "readerClient.js",
      "utf8",
    )) as string;
  } else {
    cachedReaderScript = await fs.readFile(
      path.join(__dirname, "readerClient.js"),
      "utf-8",
    );
  }
  return cachedReaderScript;
}

export function preprocessPaginator(html: string): string {
  return html
    .replace(
      "let stripGarbageNewLines = null; // [INJECT_STRIP_GARBAGE]",
      `const stripGarbageNewLines = (${stripGarbageNewLines.toString()});`,
    )
    .replace(
      "let isJsonl = null; // [INJECT_IS_JSONL]",
      `const isJsonl = (${isJsonl.toString()});`,
    )
    .replace(
      "let extractText = null; // [INJECT_EXTRACT_TEXT]",
      `const extractText = (${extractText.toString()});`,
    )
    .replace(
      "let fastHash = null; // [INJECT_FAST_HASH]",
      `const fastHash = (${fastHash.toString()});`,
    )
    .replace(
      "let stripMarkdownFormatting = null; // [INJECT_STRIP_MARKDOWN]",
      `const tokenizeInline = (${tokenizeInline.toString()});
       const parseBlocks = (${parseBlocks.toString()});
       const stripMarkdownFormatting = (${stripMarkdownFormatting.toString()});`,
    );
}

export async function txtBookPaginator({
  pageData,
  isCli = false,
  hasActiveBook = false,
}: PaginatorOptions): Promise<string> {
  const readerScript = await loadReaderScript();

  const pageDataJSON = JSON.stringify({
    ...pageData,
    hasActiveBook,
    isCli,
  });
  return /* HTML */ `
    <!DOCTYPE html>
    <html lang="en" data-theme="light">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title id="book-title">${pageData.title}</title>
        <link
          rel="icon"
          type="image/svg+xml"
          href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cstyle%3Epath %7B fill: none; stroke: %231f1f1f; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; %7D @media (prefers-color-scheme: dark) %7B path %7B stroke: %23f8f8f2; %7D %7D%3C/style%3E%3Cpath d='M12 21c-1.12-1.37-2.91-2-5.5-2H2v-14h4.5c2.11 0 3.89.63 5.5 2 1.61-1.37 3.39-2 5.5-2H22v14h-4.5c-2.59 0-4.38.63-5.5 2z'/%3E%3C/svg%3E"
        />
        <style>
          ${readerStyles}
        </style>
      </head>
      <body>
        <telocity-reader></telocity-reader>

        <!-- Safe Server-to-Client Data Containers -->
        <script id="page-data-container" type="application/json">
          ${pageDataJSON}
        </script>
        <script>
          ${readerScript};
        </script>
      </body>
    </html>
  `;
}
