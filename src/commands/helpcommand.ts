import type { Command } from "../libs/types/index.ts";

import {
  generateHelpText,
  log,
  customParseArgs as parseArgs,
  x,
} from "../libs/core/index.ts";

export default class HelpCommand implements Command {
  static get allowPositionals() {
    return false;
  }
  static get positionalCompletion() {
    return "none" as const;
  }
  static get options() {
    return {};
  }
  // oxlint-disable-next-line require-await
  async execute(argv: string[]): Promise<number> {
    const { a } = x;
    const Cmd = this.constructor as typeof HelpCommand;
    parseArgs({
      args: argv.slice(1),
      allowPositionals: Cmd.allowPositionals,
      strict: true,
      options: Cmd.options,
    });
    const helpText = generateHelpText(a.s.help.generic);
    log(helpText);
    return 0;
  }
}
