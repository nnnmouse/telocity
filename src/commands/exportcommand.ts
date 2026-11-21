import type { Command, PositionalCompletion } from "../libs/types/index.ts";

import { enUS } from "../cmap.ts";
import { log } from "../libs/core/index.ts";
import {
  preprocessPaginator,
  txtBookPaginator,
} from "../libs/paginatedreader/paginatedreader.ts";

export default class ExportCommand implements Command {
  static get allowPositionals(): boolean {
    return false;
  }

  static get positionalCompletion(): PositionalCompletion {
    return "none";
  }

  static get options(): Record<string, never> {
    return {};
  }

  // oxlint-disable-next-line require-await
  async execute(_argv: string[]): Promise<number> {
    const pageData = enUS.m.c.rd;
    const rawTemplate = await txtBookPaginator({ pageData });
    const html = preprocessPaginator(rawTemplate);
    log(html);
    return 0;
  }
}
