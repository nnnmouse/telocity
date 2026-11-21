import { access, readFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import sea from "node:sea";

import type {
  AppState,
  CancellableJob,
  CreateErrorOptions,
  ErrOpts,
  LanguageStrings,
  NodeError,
} from "../types/index.ts";

import packageJsonData from "../../../package.json" with { type: "json" };
import { getLocaleInfoMap, loadLocaleData } from "../../cmap.ts";
import fastStringWidth from "./corevendoring/faststringwidth.ts";

export const stringWidth: (str: string) => number = fastStringWidth;

export class AppStateSingleton implements AppState {
  private static _instance: AppStateSingleton | null = null;

  private _P_NAME: string = "";
  private _P_VERSION: string = "";
  private _P_URL: string = "";
  private _HOME_DIR: string = "";
  private _STATE_DIR: string = "";
  private _isInteractive: boolean = false;
  private _TDEVELOPER: boolean = false;
  private _NO_MARKDOWN: boolean = false;
  private _NO_STREAM: boolean = false;
  private _LIST_INDENT_WIDTH: number = 2;
  private _TERMINAL_WIDTH: number = 80;
  private _SEPARATOR: string = " - ";
  private _supportedLocaleSet!: Set<string>;
  private _languageToLocaleMap!: Map<string, string>;
  private _s: LanguageStrings = null!;
  private _segmenter!: Intl.Segmenter;
  private _wordSegmenter!: Intl.Segmenter;
  private _collator!: Intl.Collator;
  private _hasActiveProgressLine: boolean = false;
  private _activeJob: CancellableJob | null = null;

  private constructor() {}

  public static getInstance(): AppStateSingleton {
    if (!AppStateSingleton._instance) {
      throw new Error(
        "AppStateSingleton has not been initialized. Call AppStateSingleton.init() at the top-level of your application.",
      );
    }
    return AppStateSingleton._instance;
  }

  public static async init(isInteractive: boolean): Promise<AppStateSingleton> {
    if (!isInteractive && AppStateSingleton._instance) {
      return AppStateSingleton._instance;
    }

    if (AppStateSingleton._instance) {
      throw new Error("AppStateSingleton.init() has already been called.");
    }

    AppStateSingleton._instance = new AppStateSingleton();
    const instance = AppStateSingleton._instance;

    instance._isInteractive = isInteractive;
    instance._HOME_DIR = homedir();

    const tdev = process.env["TDEVELOPER"];
    instance._TDEVELOPER = !!tdev && tdev !== "false" && tdev !== "0";

    const noColor = !!process.env["NO_COLOR"];
    const nomd = process.env["NOMD"];
    const nost = process.env["TNOSTREAM"];
    const isNomdSet = !!nomd && nomd !== "false" && nomd !== "0";
    instance._NO_MARKDOWN = isNomdSet || noColor;
    instance._NO_STREAM = !!nost && nost !== "false" && nost !== "0";

    const packageJson = packageJsonData;

    if (!packageJson.name || !packageJson.version) {
      throw new Error("package.json must contain 'name' and 'version' fields.");
    }

    instance._P_NAME = packageJson.name;
    instance._P_VERSION = packageJson.version;
    instance._P_URL = packageJson.url;
    instance._STATE_DIR = instance.getStateDirPath(packageJson.name);
    const localeMap = getLocaleInfoMap();
    const supportedLocales = Object.keys(localeMap);
    instance._supportedLocaleSet = new Set(supportedLocales);
    instance._languageToLocaleMap = new Map();

    for (const locale of supportedLocales) {
      const info = localeMap[locale as keyof typeof localeMap];
      if (info?.defaultForLanguage) {
        const langPart = locale.split("-")[0];
        if (langPart) {
          instance._languageToLocaleMap.set(langPart, locale);
        }
      }
    }

    for (const locale of supportedLocales) {
      const langPart = locale.split("-")[0];
      if (langPart && !instance._languageToLocaleMap.has(langPart)) {
        instance._languageToLocaleMap.set(langPart, locale);
      }
    }

    const currentLocale = await instance.getLocale();
    instance._s = await loadStrings(currentLocale);
    instance._segmenter = new Intl.Segmenter(currentLocale, {
      granularity: "grapheme",
    });
    instance._wordSegmenter = new Intl.Segmenter(currentLocale, {
      granularity: "word",
    });
    instance._collator = new Intl.Collator(currentLocale, {
      sensitivity: "base",
    });
    return instance;
  }

  public getStateDirPath(appName: string): string {
    const home = this.HOME_DIR;
    switch (process.platform) {
      case "win32": {
        const appDataPath = process.env["APPDATA"];
        if (appDataPath) {
          return path.join(appDataPath, appName);
        }
        return path.join(home, "AppData", "Roaming", appName);
      }
      case "linux": {
        const xdgConfigHome = process.env["XDG_CONFIG_HOME"];
        if (xdgConfigHome) {
          return path.join(xdgConfigHome, appName);
        }
        return path.join(home, ".config", appName);
      }
      case "darwin": {
        return path.join(home, "Library", "Application Support", appName);
      }
      default:
        errlog(
          { level: "warn" },
          `[WARN] Unsupported OS: ${process.platform}. State will be stored in home directory.`,
        );
        return path.join(home, `.${appName}`);
    }
  }

  public async getUserLocale(): Promise<string | null> {
    const localePath = path.join(this.STATE_DIR, "locale.json");
    try {
      await access(localePath);
      const content = await readFile(localePath, "utf-8");
      const { locale } = JSON.parse(content) as { locale: string };
      if (this.isValidLocale(locale)) {
        return locale;
      }
    } catch {
      // ignore
    }
    return null;
  }

  public isValidLocale(locale: string): boolean {
    return this.supportedLocaleSet.has(locale);
  }

  public findBestSupportedLocale(
    localeString: string | undefined | null,
  ): string | null {
    const normalized = normalizeLocaleString(localeString);
    if (!normalized) {
      return null;
    }

    if (this.supportedLocaleSet.has(normalized)) {
      return normalized;
    }

    try {
      const parsedInput = new Intl.Locale(normalized);
      const language = parsedInput.language;
      return this.languageToLocaleMap.get(language) || null;
    } catch {
      return null;
    }
  }

  public async getLocale(): Promise<string> {
    const userSetLocale = await this.getUserLocale();
    if (userSetLocale) {
      return userSetLocale;
    }

    const potentialLocaleSources: (string | undefined)[] = [
      process.env["LANG"],
    ];

    const localeCandidates = potentialLocaleSources
      .filter((s): s is string => !!s)
      .flatMap((source) => source.split(/[:\s]+/));

    const foundLocale = localeCandidates
      .map((l) => this.findBestSupportedLocale(l))
      .find((l): l is string => !!l);

    return foundLocale ?? "en-US";
  }

  public stringifyReadable(
    obj: unknown,
    maxLength = this.TERMINAL_WIDTH,
    indent = 2,
  ): string {
    const space = " ".repeat(indent);

    function toCompact(val: unknown): string {
      if (val === null || typeof val !== "object") {
        return JSON.stringify(val);
      }

      if (Array.isArray(val)) {
        const items = (val as unknown[]).map((v: unknown): string => {
          return toCompact(v === undefined ? null : v);
        });
        return `[${items.join(", ")}]`;
      }

      const record = val as Record<string, unknown>;
      const parts: string[] = [];
      for (const k of Object.keys(record)) {
        const v = record[k];
        if (v === undefined) continue;
        parts.push(`${JSON.stringify(k)}: ${toCompact(v)}`);
      }

      if (parts.length === 0) {
        return "{}";
      }
      return `{ ${parts.join(", ")} }`;
    }

    function _stringify(val: unknown, currentIndent: string): string {
      if (val === null || typeof val !== "object") {
        return JSON.stringify(val);
      }

      const compact = toCompact(val);
      if (compact.length <= maxLength) {
        return compact;
      }

      const nextIndent = currentIndent + space;

      if (Array.isArray(val)) {
        const expanded = (val as unknown[]).map((v: unknown): string => {
          return _stringify(v === undefined ? null : v, nextIndent);
        });
        return `[\n${nextIndent}${expanded.join(`,\n${nextIndent}`)}\n${currentIndent}]`;
      }

      const record = val as Record<string, unknown>;
      const keys = Object.keys(record);
      const parts: string[] = [];
      for (const k of keys) {
        const v = record[k];
        if (v === undefined) continue;
        parts.push(`${JSON.stringify(k)}: ${_stringify(v, nextIndent)}`);
      }

      if (parts.length === 0) {
        return "{}";
      }
      return `{\n${nextIndent}${parts.join(`,\n${nextIndent}`)}\n${currentIndent}}`;
    }

    return _stringify(obj, "");
  }

  public get P_NAME(): string {
    return this._P_NAME;
  }
  public get P_VERSION(): string {
    return this._P_VERSION;
  }
  public get P_URL(): string {
    return this._P_URL;
  }
  public get HOME_DIR(): string {
    return this._HOME_DIR;
  }
  public get STATE_DIR(): string {
    return this._STATE_DIR;
  }
  public get isInteractive(): boolean {
    return this._isInteractive;
  }
  public get TDEVELOPER(): boolean {
    return this._TDEVELOPER;
  }
  public get NO_MARKDOWN(): boolean {
    return this._NO_MARKDOWN;
  }
  public get NO_STREAM(): boolean {
    return this._NO_STREAM;
  }
  public set NO_STREAM(value: boolean) {
    this._NO_STREAM = value;
  }
  public get LIST_INDENT_WIDTH(): number {
    return this._LIST_INDENT_WIDTH;
  }
  public get TERMINAL_WIDTH(): number {
    return this._TERMINAL_WIDTH;
  }
  public get SEPARATOR(): string {
    return this._SEPARATOR;
  }
  public get hasActiveProgressLine(): boolean {
    return this._hasActiveProgressLine;
  }
  public set hasActiveProgressLine(value: boolean) {
    this._hasActiveProgressLine = value;
  }
  public get supportedLocaleSet(): Set<string> {
    return this._supportedLocaleSet;
  }
  public get languageToLocaleMap(): Map<string, string> {
    return this._languageToLocaleMap;
  }
  public get s(): LanguageStrings {
    return this._s;
  }
  public get segmenter(): Intl.Segmenter {
    return this._segmenter;
  }
  public get wordSegmenter(): Intl.Segmenter {
    return this._wordSegmenter;
  }
  public get collator(): Intl.Collator {
    return this._collator;
  }
  public get activeJob(): CancellableJob | null {
    return this._activeJob;
  }
  public set activeJob(job: CancellableJob | null) {
    this._activeJob = job;
  }
}

export const x = {
  get appState(): AppStateSingleton {
    return AppStateSingleton.getInstance();
  },
  get a(): AppStateSingleton {
    return AppStateSingleton.getInstance();
  },
};

export async function resolveAsset(
  key: string,
  encoding?: "utf8",
): Promise<string | ArrayBuffer> {
  if (sea.isSea()) {
    try {
      if (encoding === "utf8") {
        return sea.getAsset(key, "utf8");
      }
      return sea.getRawAsset(key);
    } catch (err: unknown) {
      throw createError(
        `The required compiled asset '${key}' could not be resolved from the executable bundle.`,
        { code: "SEA_ASSET_MISSING", cause: err },
      );
    }
  }

  let physicalPath = "";
  if (key.endsWith(".json")) {
    physicalPath = path.resolve(__dirname, "../data/i18n", key);
    try {
      await fs.access(physicalPath);
    } catch {
      physicalPath = path.resolve(__dirname, "../../../data/i18n", key);
    }
  } else {
    physicalPath = path.resolve(process.cwd(), key);
  }

  if (encoding === "utf8") {
    return fs.readFile(physicalPath, "utf-8");
  }
  const buf = await fs.readFile(physicalPath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function normalizeLocaleString(
  localeString: string | undefined | null,
): string | null {
  if (!localeString || typeof localeString !== "string") return null;
  return localeString.split(".")[0]?.replace(/_/g, "-") ?? null;
}

function deepMerge<T extends object>(base: T, override: object): T {
  // Create a shallow copy of the root
  const output: T = (Array.isArray(base) ? [...base] : { ...base }) as T;

  type IndexableObject = Record<string, unknown>;
  const stack: Array<{ target: IndexableObject; src: IndexableObject }> = [
    { target: output as IndexableObject, src: override as IndexableObject },
  ];

  while (stack.length > 0) {
    const { target, src } = stack.pop()!;

    for (const key in src) {
      if (!Object.prototype.hasOwnProperty.call(src, key)) continue;

      const srcValue = src[key];
      const targetValue = target[key];

      if (isObjectNotArray(targetValue) && isObjectNotArray(srcValue)) {
        // Clone the target object from the base to prevent
        // mutating the original static constant (e.g., enUS)
        target[key] = { ...(targetValue as IndexableObject) };
        stack.push({
          target: target[key] as IndexableObject,
          src: srcValue as IndexableObject,
        });
      } else {
        target[key] = srcValue;
      }
    }
  }

  return output;
}

async function loadStrings(locale = "en-US"): Promise<LanguageStrings> {
  const englishStrings = (await loadLocaleData(
    "en-US",
  )) as LanguageStrings | null;

  if (!englishStrings) {
    throw createError(
      "English language file (en-US.json) could not be loaded.",
      { code: "LANGUAGE_LOAD_FAILED" },
    );
  }

  if (locale === "en-US") {
    return englishStrings;
  }

  const localeStrings = await loadLocaleData(locale);

  if (!localeStrings) {
    return englishStrings;
  }

  return deepMerge(englishStrings, localeStrings);
}

export function isNodeError(error: unknown): error is NodeError {
  return (
    error instanceof Error && "code" in error && typeof error.code === "string"
  );
}

export function isErrCo<T extends string>(
  error: unknown,
  code: T,
): error is NodeError & { code: T } {
  return isNodeError(error) && error.code === code;
}

export function isTypeError(error: unknown): error is TypeError {
  return error instanceof TypeError;
}

export function isEnoentError(
  error: unknown,
): error is NodeError & { code: "ENOENT" } {
  return isErrCo(error, "ENOENT");
}

export function isEexistError(
  error: unknown,
): error is NodeError & { code: "EEXIST" } {
  return isErrCo(error, "EEXIST");
}

export function exitOne(): void {
  if (process.env["NODE_ENV"] !== "test") {
    process.exitCode = 1;
  }
}

export function createError(
  message: string,
  options: CreateErrorOptions = {},
): Error {
  const { cause, code, immediateExitCode = true } = options;
  const newError: NodeError = new Error(message, { cause });

  if (code) {
    newError.code = code;
  } else if (isNodeError(cause) && cause.code) {
    newError.code = cause.code;
  }

  if (immediateExitCode) {
    exitOne();
  }

  return newError;
}

export function errlog(
  firstArg: ErrOpts | string | number,
  ...restArgs: unknown[]
): void {
  try {
    const appState = AppStateSingleton.getInstance();
    if (appState.hasActiveProgressLine) {
      process.stdout.write("\r\x1b[K");
      appState.hasActiveProgressLine = false;
    }
  } catch {
    /* ignore */
  }

  if (
    typeof firstArg === "object" &&
    firstArg !== null &&
    "level" in firstArg
  ) {
    const options = firstArg;
    const msg = restArgs;
    switch (options.level) {
      case "warn":
        console.warn("[WARN]", ...msg);
        break;
      case "error":
        console.error("[ERROR]", ...msg);
        break;
      case "critical":
        console.error("[CRITICAL]", ...msg);
        break;
    }
  } else {
    const allMsg = [firstArg, ...restArgs];
    console.error(...allMsg);
  }
}

export function isObjectNotArray(
  item: unknown,
): item is Record<string, unknown> {
  return !!(item && typeof item === "object" && !Array.isArray(item));
}

// cyrb53
export function fastHash(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;

  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}
