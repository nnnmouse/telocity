import { isSea } from "node:sea";

import type {
  CommandConstructor,
  LanguageStrings,
} from "./libs/types/index.ts";

import enUsData from "../data/i18n/en-US.json" with { type: "json" };
import { resolveAsset } from "./libs/core/context.ts";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type EnUsStrings = typeof enUsData;
export const enUS = enUsData as EnUsStrings;

export function getLocaleInfoMap() {
  return {
    "en-US": {
      name: "English (United States)",
      path: "../data/i18n/en-US.json",
      defaultForLanguage: true,
    },
    "fr-FR": {
      name: "Français (France)",
      path: "../data/i18n/fr-FR.json",
      defaultForLanguage: true,
    },
    "ja-JP": {
      name: "日本語 (日本)",
      path: "../data/i18n/ja-JP.json",
      defaultForLanguage: true,
    },
    "zh-CN": {
      name: "简体中文 (中国)",
      path: "../data/i18n/zh-CN.json",
      defaultForLanguage: true,
    },
  } as const;
}

export async function loadLocaleData(
  locale: string,
): Promise<DeepPartial<LanguageStrings> | null> {
  const infoMap = getLocaleInfoMap();

  if (!(locale in infoMap)) return null;
  if (locale === "en-US") return enUS as DeepPartial<LanguageStrings>;

  const compiledSeaActive = isSea();
  if (compiledSeaActive) {
    try {
      const assetContent = await resolveAsset(`${locale}.json`, "utf8");
      return JSON.parse(assetContent as string) as DeepPartial<LanguageStrings>;
    } catch {
      return null;
    }
  }

  try {
    switch (locale) {
      case "fr-FR":
        return (
          await import("../data/i18n/fr-FR.json", { with: { type: "json" } })
        ).default as DeepPartial<LanguageStrings>;
      case "ja-JP":
        return (
          await import("../data/i18n/ja-JP.json", { with: { type: "json" } })
        ).default as DeepPartial<LanguageStrings>;
      case "zh-CN":
        return (
          await import("../data/i18n/zh-CN.json", { with: { type: "json" } })
        ).default as DeepPartial<LanguageStrings>;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export async function getCommand(
  key: true,
): Promise<Record<string, () => Promise<CommandConstructor>>>;
export async function getCommand(
  key: string,
): Promise<CommandConstructor | undefined>;
export async function getCommand(
  key: string | true,
): Promise<
  | CommandConstructor
  | undefined
  | Record<string, () => Promise<CommandConstructor>>
> {
  const commandMap = {
    bg: () => import("./commands/batchgencommand.ts").then((m) => m.default),
    bg2: () => import("./commands/batchgencommand2.ts").then((m) => m.default),
    br: () => import("./commands/runjsonlcommand.ts").then((m) => m.default),
    rm: () => import("./commands/rmcommand.ts").then((m) => m.default),
    st: () => import("./commands/stripcommand.ts").then((m) => m.default),
    cm: () => import("./commands/comparecommand.ts").then((m) => m.default),
    avg: () => import("./commands/avgcommand.ts").then((m) => m.default),
    tc: () => import("./commands/tccommand.ts").then((m) => m.default),
    tc2: () => import("./commands/tccommand2.ts").then((m) => m.default),
    mg: () => import("./commands/mergecommand.ts").then((m) => m.default),
    sp: () => import("./commands/splitcommand.ts").then((m) => m.default),
    cfg: () => import("./commands/configcommand.ts").then((m) => m.default),
    os: () => import("./commands/oneshotcommand.ts").then((m) => m.default),
    help: () => import("./commands/helpcommand.ts").then((m) => m.default),
    rd: () => import("./commands/rdcommand.ts").then((m) => m.default),
    or: () => import("./commands/openroutercommand.ts").then((m) => m.default),
    jd: () => import("./commands/jsondiffcommand.ts").then((m) => m.default),
    // singular scripts that aren't real commands
    co: () => import("./commands/completions.ts").then((m) => m.default),
    ex: () => import("./commands/exportcommand.ts").then((m) => m.default),
  } as const;

  if (key === true) {
    return commandMap;
  }

  const loader = commandMap[key as keyof typeof commandMap];
  return loader ? await loader() : undefined;
}
