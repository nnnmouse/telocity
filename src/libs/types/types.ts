import type { Agent as HttpAgent } from "node:http";
import type { ClientHttp2Session } from "node:http2";
import type { Agent as HttpsAgent } from "node:https";
import type { TLSSocket } from "node:tls";

import type { EnUsStrings } from "../../cmap.ts";

export interface IMiniResponseHeaders {
  get(name: string): string | null;
}

export interface AppState {
  readonly P_NAME: string;
  readonly P_VERSION: string;
  readonly P_URL: string;
  readonly HOME_DIR: string;
  readonly STATE_DIR: string;
  readonly isInteractive: boolean;
  readonly LIST_INDENT_WIDTH: number;
  readonly TERMINAL_WIDTH: number;
  readonly SEPARATOR: string;
  readonly TDEVELOPER: boolean;
  readonly supportedLocaleSet: Set<string>;
  readonly languageToLocaleMap: Map<string, string>;
  readonly s: LanguageStrings;
  readonly NO_MARKDOWN: boolean;
  NO_STREAM: boolean;
  readonly segmenter: Intl.Segmenter;
  readonly wordSegmenter: Intl.Segmenter;
  readonly collator: Intl.Collator;

  hasActiveProgressLine: boolean;
  activeJob: CancellableJob | null;

  stringifyReadable(obj: unknown, maxLength?: number, indent?: number): string;
  getStateDirPath(appName: string): string;
  getUserLocale(): Promise<string | null>;
  isValidLocale(locale: string): boolean;
  findBestSupportedLocale(
    localeString: string | undefined | null,
  ): string | null;
  getLocale(): Promise<string>;
}

export type ErrOpts = {
  level: "warn" | "error" | "critical";
};

export interface CreateErrorOptions {
  cause?: unknown;
  code?: string;
  immediateExitCode?: boolean;
}

export interface NodeError extends Error {
  code?: string;
  errno?: number;
  syscall?: string;
  path?: string;
}

export interface CustomOptionConfig {
  type: "string" | "boolean";
  short?: string;
  default?: string | boolean;
}

export interface CustomParseArgsConfig<
  T extends { options?: { [longOption: string]: CustomOptionConfig } },
> {
  args?: string[];
  options?: T["options"];
  allowPositionals?: boolean;
  strict?: boolean;
}

type OptionValue<O extends CustomOptionConfig> = O["type"] extends "string"
  ? string
  : boolean;

type OptionsWithDefaults<
  T extends CustomParseArgsConfig<{
    options?: Record<string, CustomOptionConfig>;
  }>,
> = {
  [K in keyof T["options"] as T["options"][K] extends { default: unknown }
    ? K
    : never]: OptionValue<NonNullable<T["options"]>[K] & CustomOptionConfig>;
};

type OptionsWithoutDefaults<
  T extends CustomParseArgsConfig<{
    options?: Record<string, CustomOptionConfig>;
  }>,
> = {
  [K in keyof T["options"] as T["options"][K] extends { default: unknown }
    ? never
    : K]?: OptionValue<NonNullable<T["options"]>[K] & CustomOptionConfig>;
};

export interface CustomParsedResults<
  T extends CustomParseArgsConfig<{
    options?: Record<string, CustomOptionConfig>;
  }>,
> {
  values: OptionsWithDefaults<T> & OptionsWithoutDefaults<T>;
  positionals: string[];
}

export interface Command {
  execute(argv: string[]): Promise<number | void>;
}

export type CommandModule = {
  default: new () => Command;
};

export type PositionalCompletion = "file" | "directory" | "none";

type CommandOptionConfig = CustomOptionConfig & {
  completions?: readonly string[];
};

export interface CommandConstructor {
  new (): Command;
  options: Record<string, CommandOptionConfig>;
  allowPositionals?: boolean;
  positionalCompletion?: PositionalCompletion;
  helpReplacements?: Record<string, string>;
}
type ExtractShort<T> = T extends { short: infer S extends string } ? S : never;
type OtherShorts<T, K extends keyof T> = ExtractShort<T[Exclude<keyof T, K>]>;
export type EnforceUniqueShorts<T> =
  T extends Record<string, unknown>
    ? {
        [K in keyof T]: T[K] extends { short: infer S extends string }
          ? S extends OtherShorts<T, K>
            ? Omit<T[K], "short"> & { short: "Error: Duplicate short flag" }
            : T[K]
          : T[K];
      }
    : T;
export type NumConstraints = {
  min?: number;
  max?: number;
  minExclusive?: number;
  maxExclusive?: number;
  integer?: boolean;
  isFloat?: boolean;
  finite?: boolean;
};
export type StrConstraints = { notEmpty?: boolean };
export interface ConfigDef<TClass, TValue> {
  prop: keyof TClass;
  validate: (val: unknown) => asserts val is TValue;
  getValue?: (val: unknown) => TValue;
  storeTransformedValue?: boolean;
  customHandler?: (instance: TClass, val: unknown) => void;
}
export type ConfigMap<TClass, TOptions> = {
  [K in keyof TOptions]?: ConfigDef<TClass, unknown>;
};

export interface FormatAlignedListOptions {
  terminalWidth?: number;
  columnGap?: number;
  firstColumnSeparator?: string;
  forceFirstColumnWidth?: number;
  listIndentWidth?: number;
}

interface BaseHelpSection {
  usage: string;
  flags?: Record<string, string>;
  footer?: string;
}

export interface HelpSection extends BaseHelpSection {
  description: string;
}

export interface GenericHelpSection extends BaseHelpSection {
  header: string;
  commandHeader: string;
  commandDescriptions: Record<string, string>;
  globalOptionsHeader: string;
}

export type AnsiStyle = (text: string) => string;

export interface RunConcurOpts {
  concurrency?: number;
  allSettled?: boolean;
}

export interface CancellableJob {
  cancel: () => void;
}

export interface INetworkContext {
  readonly httpAgent: HttpAgent;
  readonly httpsAgent: HttpsAgent;
  readonly h2Sessions: Map<string, ClientHttp2Session>;
  readonly h2IdleTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly h2ActiveRequests: Map<string, number>;
  readonly protocolCache: Map<string, "h2" | "http/1.1">;
  readonly pendingProbes: Map<string, Promise<"h2" | "http/1.1">>;
  readonly activeProbeSockets: Set<TLSSocket>;
  readonly probeSafetyTimers: Set<ReturnType<typeof setTimeout>>;
  readonly establishedSockets: Map<string, TLSSocket>;

  destroy(): void;
  shutdown(): Promise<void>;
  isDestroyed(): boolean;
  evictHost(authority: string): void;
}

export type LanguageStrings = EnUsStrings;
