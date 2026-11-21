import type {
  ConfigMap,
  NumConstraints,
  StrConstraints,
} from "../types/index.ts";

import { createError } from "./context.ts";

export const V = {
  num:
    (
      constraints: NumConstraints,
      errorMsg: string,
      errorCode: string,
      errorPlaceholder = "{{ .Value }}",
      secondaryCheck?: { fn: (v: number) => boolean },
      secondaryErrorMsg?: string,
      secondaryErrorCode?: string,
      secondaryErrorPlaceholder?: string,
    ) =>
    (val: unknown) => {
      if (typeof val !== "number" || Number.isNaN(val)) {
        throw createError(errorMsg.replace(errorPlaceholder, String(val)), {
          code: errorCode,
        });
      }
      if (constraints.finite !== false && !Number.isFinite(val)) {
        throw createError(errorMsg.replace(errorPlaceholder, String(val)), {
          code: errorCode,
        });
      }
      if (constraints.integer && !Number.isInteger(val)) {
        throw createError(errorMsg.replace(errorPlaceholder, String(val)), {
          code: errorCode,
        });
      }
      if (constraints.isFloat && Number.isInteger(val)) {
        throw createError(errorMsg.replace(errorPlaceholder, String(val)), {
          code: errorCode,
        });
      }
      if (constraints.min !== undefined && val < constraints.min) {
        throw createError(errorMsg.replace(errorPlaceholder, String(val)), {
          code: errorCode,
        });
      }
      if (constraints.max !== undefined && val > constraints.max) {
        throw createError(errorMsg.replace(errorPlaceholder, String(val)), {
          code: errorCode,
        });
      }
      if (
        constraints.minExclusive !== undefined &&
        val <= constraints.minExclusive
      ) {
        throw createError(errorMsg.replace(errorPlaceholder, String(val)), {
          code: errorCode,
        });
      }
      if (
        constraints.maxExclusive !== undefined &&
        val >= constraints.maxExclusive
      ) {
        throw createError(errorMsg.replace(errorPlaceholder, String(val)), {
          code: errorCode,
        });
      }
      if (
        secondaryCheck &&
        secondaryErrorMsg &&
        secondaryErrorCode &&
        secondaryErrorPlaceholder &&
        !secondaryCheck.fn(val)
      ) {
        throw createError(
          secondaryErrorMsg.replace(secondaryErrorPlaceholder, String(val)),
          { code: secondaryErrorCode },
        );
      }
    },
  str:
    (
      constraints: StrConstraints,
      errorMsg: string,
      errorCode: string,
      errorPlaceholder = "{{ .Value }}",
      secondaryCheck?: { fn: (v: string) => boolean },
      secondaryErrorMsg?: string,
      secondaryErrorCode?: string,
      secondaryErrorPlaceholder?: string,
    ) =>
    (val: unknown) => {
      if (typeof val !== "string") {
        throw createError(errorMsg.replace(errorPlaceholder, String(val)), {
          code: errorCode,
        });
      }
      if (constraints.notEmpty && val.trim() === "") {
        throw createError(errorMsg.replace(errorPlaceholder, String(val)), {
          code: errorCode,
        });
      }
      if (
        secondaryCheck &&
        secondaryErrorMsg &&
        secondaryErrorCode &&
        secondaryErrorPlaceholder &&
        !secondaryCheck.fn(val)
      ) {
        throw createError(
          secondaryErrorMsg.replace(secondaryErrorPlaceholder, String(val)),
          { code: secondaryErrorCode },
        );
      }
    },
  bool:
    (
      constraints: { strictTrueFalse?: boolean } = {},
      errorMsg: string,
      errorCode: string,
      errorPlaceholder = "{{ .Value }}",
    ) =>
    (val: unknown) => {
      const isBoolean = typeof val === "boolean";
      const isStrict = constraints.strictTrueFalse;

      if (isStrict && !isBoolean) {
        throw createError(errorMsg.replace(errorPlaceholder, String(val)), {
          code: errorCode,
        });
      }

      if (!isStrict && typeof val !== "boolean" && val !== 0 && val !== 1) {
        throw createError(errorMsg.replace(errorPlaceholder, String(val)), {
          code: errorCode,
        });
      }
    },
  getValueFromArray:
    <T>(
      errorMsg: string,
      errorCode: string,
      errorPlaceholder = "{{ .OptionValue }}",
    ) =>
    (optionValue: unknown): T => {
      if (!Array.isArray(optionValue) || optionValue.length < 2) {
        throw createError(
          errorMsg.replace(errorPlaceholder, String(optionValue)),
          { code: errorCode },
        );
      }
      return optionValue[1] as T;
    },
};

export function resolveConfig<TClass extends object, TOptions extends object>(
  targetInstance: TClass,
  options: TOptions,
  configMap: ConfigMap<TClass, TOptions>,
): Partial<TClass> {
  const result: Partial<TClass> = {};

  const optionKeys = Object.keys(options) as Array<keyof TOptions>;

  for (const key of optionKeys) {
    const configEntry = configMap[key];

    if (!configEntry) continue;

    if (configEntry.customHandler) {
      configEntry.customHandler(targetInstance, options[key]);
      continue;
    }

    const rawValue = options[key];
    let valueToValidate: unknown;

    if (configEntry.getValue) {
      valueToValidate = configEntry.getValue(rawValue);
    } else {
      valueToValidate = rawValue;
    }

    const validator: (val: unknown) => asserts val is unknown =
      configEntry.validate;

    validator(valueToValidate);

    const finalValue = configEntry.storeTransformedValue
      ? valueToValidate
      : rawValue;

    const propKey = configEntry.prop;
    result[propKey] = finalValue as TClass[typeof propKey];
  }

  return result;
}
