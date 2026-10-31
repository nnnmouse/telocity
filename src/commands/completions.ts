import type {
  Command,
  CommandConstructor,
  PositionalCompletion,
} from "../libs/types/index.ts";

import { getCommand } from "../cmap.ts";
import {
  config as appConfig,
  createError,
  errlog,
  log,
  simpleTemplate,
  x,
} from "../libs/core/index.ts";

export default class Completions implements Command {
  static get allowPositionals(): boolean {
    return false;
  }

  static get positionalCompletion(): PositionalCompletion {
    return "none";
  }

  static get options(): Record<string, never> {
    return {};
  }

  async execute(_argv: string[]): Promise<number> {
    const script = await this.generateBashCompletionScript();
    log(script);
    return 0;
  }

  private async generateBashCompletionScript(): Promise<string> {
    const { a } = x;
    const programName = a.P_NAME;
    const commandMap = await getCommand(true);

    const allSubcommands = Object.keys(commandMap)
      .filter((alias) => alias !== "_default")
      .sort();

    const globalOpts = ["--version", "--help"].sort().join(" ");
    const caseBlock = await this.buildCaseBlock(commandMap);

    return `#!/usr/bin/env bash
# Bash completion for ${programName}
# Generated on: ${Temporal.Now.instant().toString()}

_${programName}_completions() {
  local cur prev words cword
  _get_comp_words_by_ref -n : cur prev words cword

  local subcommands="${allSubcommands.join(" ")}"
  local global_opts="${globalOpts}"

  _bb_filedir() {
    # Tell Bash that COMPREPLY contains filenames so it automatically escapes spaces
    compopt -o filenames 2>/dev/null

    local expanded_cur="${"$"}{cur/#~/${"$"}HOME}"
    mapfile -t COMPREPLY < <(compgen -f -- "${"$"}{expanded_cur}")

    if [[ "${"$"}{cur}" == "~"* && "${"$"}{#COMPREPLY[@]}" -gt 0 ]]; then
      for i in "${"$"}{!COMPREPLY[@]}"; do
        COMPREPLY[i]="~/${"$"}{COMPREPLY[i]#"${"$"}HOME"/}"
      done
    fi
  }

  _bb_dirdir() {
    # Tell Bash that COMPREPLY contains directory names so it handles spaces and slashes
    compopt -o filenames 2>/dev/null

    local expanded_cur="${"$"}{cur/#~/${"$"}HOME}"
    mapfile -t COMPREPLY < <(compgen -d -- "${"$"}{expanded_cur}")

    if [[ "${"$"}{cur}" == "~"* && "${"$"}{#COMPREPLY[@]}" -gt 0 ]]; then
      for i in "${"$"}{!COMPREPLY[@]}"; do
        COMPREPLY[i]="~/${"$"}{COMPREPLY[i]#"${"$"}HOME"/}"
      done
    fi
  }

  if [[ ${"$"}cword -eq 1 ]]; then
    COMPREPLY=( ${"$"}(compgen -W "${"$"}{subcommands} ${"$"}{global_opts}" -- "${"$"}{cur}") )
    return 0
  fi

  case "${"$"}{words[1]}" in
${caseBlock}
    help)
      COMPREPLY=( ${"$"}(compgen -W "${"$"}{subcommands}" -- "${"$"}{cur}") )
      ;;
    *)
      COMPREPLY=()
      ;;
  esac

  return 0
}

complete -F _${programName}_completions ${programName}
`;
  }

  private async buildCaseBlock(
    commandMap: Record<string, () => Promise<CommandConstructor>>,
  ): Promise<string> {
    const { a } = x;
    let caseBlock = "";

    const sortedEntries = Object.entries(commandMap).sort(([k1], [k2]) =>
      k1.localeCompare(k2),
    );

    for (const [alias, loader] of sortedEntries) {
      if (alias === "_default") continue;

      try {
        const CommandClass = await getCommand(alias);
        if (!CommandClass) {
          throw new Error(
            simpleTemplate(a.s.e.lcli.commandNotImplemented, {
              CommandAlias: alias,
            }),
          );
        }

        caseBlock += this.generateCaseForCommand(alias, CommandClass);
      } catch (err) {
        errlog({ level: "error" }, `Failed to load command "${alias}":`, err);
        if (err instanceof Error) {
          caseBlock += `  # failed to load command ${alias} (${loader.toString()}): ${
            err.message ?? String(err)
          }\n`;
          createError(simpleTemplate(a.s.e.c.co.coError, { Command: alias }), {
            cause: err,
            immediateExitCode: false,
          });
        } else {
          createError(a.s.e.lcli.unknownErrorOccurred, {
            cause: err,
            immediateExitCode: false,
          });
        }
      }
    }

    return caseBlock;
  }

  private generateCaseForCommand(
    alias: string,
    CommandClass: CommandConstructor,
  ): string {
    const options = CommandClass.options ?? {};
    const allowPositionals = CommandClass.allowPositionals ?? false;
    const positionalCompletion = CommandClass.positionalCompletion ?? "none";

    const allOpts: string[] = [];
    const allValueOpts: string[] = [];
    const valueCompletionCases: string[] = [];

    // Extract dynamic presets and templates keys securely
    const paramPresetKeys = Object.keys(appConfig.PARAM_CONFIGS ?? {}).sort();
    const templateKeys = Object.keys(appConfig.TEMPLATES ?? {}).sort();

    for (const [longName, cfg] of Object.entries(options)) {
      const longOpt = `--${longName}`;
      allOpts.push(longOpt);

      let shortOpt: string | undefined;
      if (cfg.short) {
        shortOpt = `-${cfg.short}`;
        allOpts.push(shortOpt);
      }

      if (cfg.type === "string") {
        allValueOpts.push(longOpt);
        if (shortOpt) {
          allValueOpts.push(shortOpt);
        }

        // Dynamically override completions arrays for target parameters
        let completions = cfg.completions;
        if (longName === "params") {
          completions = paramPresetKeys;
        } else if (longName === "pselector" || longName === "partial") {
          completions = templateKeys;
        }

        if (completions && completions.length > 0) {
          const casePattern = shortOpt ? `${longOpt}|${shortOpt}` : longOpt;
          valueCompletionCases.push(`
        ${casePattern})
          COMPREPLY=( ${"$"}(compgen -W "${completions.join(" ")}" -- "${"$"}{cur}") )
          ;;`);
        }
      }
    }

    const allOptsJoined = Array.from(new Set(allOpts)).sort().join(" ");
    const valueOptsJoined = Array.from(new Set(allValueOpts))
      .map((v) => v.replace(/(["'\\])/g, "\\$1"))
      .join(" ");

    const positionalHandler = this.getPositionalHandler(
      allowPositionals,
      positionalCompletion,
    );

    const valueOptionsBlock =
      valueOptsJoined.length > 0
        ? `
      if [[ " ${valueOptsJoined} " == *" ${"$"}{prev} "* ]]; then
        case "${"$"}{prev}" in${valueCompletionCases.join("")}
          *)
            ${positionalHandler}
            ;;
        esac
        return 0
      fi
      `
        : "";

    return `
    ${alias})
      local _opts="${allOptsJoined}"${valueOptionsBlock}

      if [[ "${"$"}{cur}" == -* ]]; then
        COMPREPLY=( ${"$"}(compgen -W "${"$"}{_opts}" -- "${"$"}{cur}") )
        return 0
      else
        ${positionalHandler}
      fi
      ;;
`;
  }

  private getPositionalHandler(
    allow: boolean,
    type: PositionalCompletion,
  ): string {
    if (!allow) return "COMPREPLY=()";
    switch (type) {
      case "file":
        return "_bb_filedir";
      case "directory":
        return "_bb_dirdir";
      case "none":
      default:
        return "COMPREPLY=()";
    }
  }
}
