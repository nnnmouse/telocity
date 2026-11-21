import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Command } from "../libs/types/index.ts";

import {
  config as appConfig,
  createError,
  generateHelpText,
  log,
  customParseArgs as parseArgs,
  simpleTemplate,
  x,
  bold,
  blue,
  yellow,
  red,
  formatAlignedList,
} from "../libs/core/index.ts";
import {
  resolveModelConfig,
  validateFiles,
  llmFetch,
} from "../libs/LLM/index.ts";

interface OpenRouterBatchPromptDetails {
  cached_tokens?: number;
  cache_write_tokens?: number;
  audio_tokens?: number;
  video_tokens?: number;
}

interface OpenRouterBatchCompletionDetails {
  reasoning_tokens?: number;
  image_tokens?: number;
  audio_tokens?: number;
}

interface OpenRouterBatchCostDetails {
  upstream_inference_cost?: number;
  upstream_inference_prompt_cost?: number;
  upstream_inference_completions_cost?: number;
}

interface OpenRouterBatchUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  prompt_tokens_details?: OpenRouterBatchPromptDetails;
  completion_tokens_details?: OpenRouterBatchCompletionDetails;
  cost_details?: OpenRouterBatchCostDetails;
}

interface OpenRouterBatchChoice {
  index: number;
  finish_reason?: string | null;
  message?: {
    role?: string;
    content?: string | null;
  } | null;
}

interface OpenRouterBatchBody {
  id?: string;
  model?: string;
  provider?: string;
  usage?: OpenRouterBatchUsage;
  choices?: OpenRouterBatchChoice[];
  error?: {
    message?: string;
  };
  status?: string;
  incomplete_details?: {
    reason?: string;
  };
}

interface OpenRouterBatchResponse {
  status_code?: number;
  body?: OpenRouterBatchBody;
}

interface OpenRouterBatchLine {
  custom_id?: string;
  response?: OpenRouterBatchResponse | null;
  error?: {
    code?: number | string;
    message?: string;
  } | null;
}

export default class OpenRouterCommand implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "file" as const;
  }
  static get options() {
    return {
      apikey: { type: "string", short: "k" },
      params: { type: "string", short: "p", default: appConfig.DEFAULT_MODEL },
      help: { type: "boolean", short: "h" },
    } as const;
  }

  async execute(argv: string[]): Promise<number> {
    const { a } = x;
    const Cmd = this.constructor as typeof OpenRouterCommand;

    const { values: argValues, positionals } = parseArgs({
      args: argv.slice(1),
      options: Cmd.options,
      allowPositionals: Cmd.allowPositionals,
      strict: true,
    });

    const orhelptext = () => {
      const helpText = generateHelpText(a.s.help.commands.or, Cmd.options);
      log(helpText);
    };

    if (argValues.help) {
      orhelptext();
      return 0;
    }

    const safeNum = (val: unknown): number =>
      typeof val === "number" && !Number.isNaN(val) ? val : 0;

    const fileToParse = positionals[0];

    if (fileToParse) {
      await validateFiles(fileToParse);
      const content = await readFile(fileToParse, "utf-8");
      const lines = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      // Scale multiplier (10^9) to store sub-cent prices as integer nano-dollars
      const COST_SCALE = 1_000_000_000;

      const stats = {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        totalCost: 0, // Accumulated as integer nano-dollars
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        audioPromptTokens: 0,
        videoPromptTokens: 0,
        reasoningTokens: 0,
        imageCompletionTokens: 0,
        audioCompletionTokens: 0,
        upstreamInferenceCost: 0, // Accumulated as integer nano-dollars
        upstreamInferencePromptCost: 0, // Accumulated as integer nano-dollars
        upstreamInferenceCompletionsCost: 0, // Accumulated as integer nano-dollars
        modelCounts: {} as Record<string, number>,
        providerCounts: {} as Record<string, number>,
      };

      const failedList: Array<{
        customId: string;
        status: number | string;
        errorMsg: string;
      }> = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        stats.totalRequests++;

        let parsed: OpenRouterBatchLine;
        try {
          parsed = JSON.parse(line) as OpenRouterBatchLine;
        } catch (err) {
          stats.failedRequests++;
          const errMsg = err instanceof Error ? err.message : String(err);
          failedList.push({
            customId: `line-${i + 1}`,
            status: a.s.m.c.or.malformed,
            errorMsg: simpleTemplate(a.s.e.c.or.jsonParseFailed, {
              Error: errMsg,
            }),
          });
          continue;
        }

        const customId = parsed.custom_id || `line-${i + 1}`;
        const rootError = parsed.error;
        const response = parsed.response;

        if (rootError) {
          stats.failedRequests++;
          failedList.push({
            customId,
            status: rootError.code || a.s.m.c.or.notAvailable,
            errorMsg: rootError.message || JSON.stringify(rootError),
          });
          continue;
        }

        if (!response) {
          stats.failedRequests++;
          failedList.push({
            customId,
            status: a.s.m.c.or.notAvailable,
            errorMsg: simpleTemplate(a.s.e.c.or.missingResponseField, {}),
          });
          continue;
        }

        const statusCode = response.status_code;
        if (statusCode !== 200) {
          stats.failedRequests++;
          let errMsg = simpleTemplate(a.s.m.c.or.unknownError, {});
          const body = response.body;
          if (body && typeof body === "object") {
            if (body.error) {
              errMsg = body.error.message || JSON.stringify(body.error);
            } else {
              errMsg = JSON.stringify(body);
            }
          }
          failedList.push({
            customId,
            status: statusCode || a.s.m.c.or.notAvailable,
            errorMsg: errMsg,
          });
          continue;
        }

        const body = response.body || {};
        const bodyError = body.error;

        const firstChoice = body.choices?.[0];
        const finishReason = firstChoice?.finish_reason;

        const isIncomplete = body.status === "incomplete";
        const incompleteReason = body.incomplete_details?.reason;

        const hasChoiceError = finishReason === "error";

        const hasLengthError =
          finishReason === "length" ||
          (isIncomplete &&
            (incompleteReason === "max_output_tokens" ||
              incompleteReason === "max_tokens"));

        const hasFilterError =
          finishReason === "content_filter" ||
          (isIncomplete && incompleteReason === "content_filter");

        const hasFailedOrCancelledError =
          isIncomplete &&
          (incompleteReason === "failed" || incompleteReason === "cancelled");

        if (
          bodyError ||
          hasChoiceError ||
          hasLengthError ||
          hasFilterError ||
          hasFailedOrCancelledError
        ) {
          stats.failedRequests++;
          let errMsg = simpleTemplate(a.s.m.c.or.unknownError, {});
          if (bodyError) {
            errMsg = bodyError.message || JSON.stringify(bodyError);
          } else if (hasChoiceError) {
            errMsg = simpleTemplate(a.s.m.c.or.streamTerminatedError, {});
          } else if (hasLengthError) {
            errMsg = simpleTemplate(a.s.e.c.or.maxTokensReached, {});
          } else if (hasFilterError) {
            errMsg = simpleTemplate(a.s.e.c.or.contentFilterTriggered, {});
          } else if (hasFailedOrCancelledError) {
            errMsg = simpleTemplate(
              a.s.e.c.or.responseExecutionFailedOrCancelled,
              {
                Reason: incompleteReason ?? "unknown",
              },
            );
          }
          failedList.push({
            customId,
            status: statusCode || a.s.m.c.or.notAvailable,
            errorMsg: errMsg,
          });
          continue;
        }

        stats.successfulRequests++;

        const model = body.model;
        const provider = body.provider;

        if (model) {
          stats.modelCounts[model] = (stats.modelCounts[model] || 0) + 1;
        }
        if (provider) {
          stats.providerCounts[provider] =
            (stats.providerCounts[provider] || 0) + 1;
        }

        const usage = body.usage || {};
        stats.totalCost += Math.round(safeNum(usage.cost) * COST_SCALE);
        stats.totalPromptTokens += safeNum(usage.prompt_tokens);
        stats.totalCompletionTokens += safeNum(usage.completion_tokens);
        stats.totalTokens += safeNum(usage.total_tokens);

        const promptDetails = usage.prompt_tokens_details || {};
        stats.cachedTokens += safeNum(promptDetails.cached_tokens);
        stats.cacheWriteTokens += safeNum(promptDetails.cache_write_tokens);
        stats.audioPromptTokens += safeNum(promptDetails.audio_tokens);
        stats.videoPromptTokens += safeNum(promptDetails.video_tokens);

        const completionDetails = usage.completion_tokens_details || {};
        stats.reasoningTokens += safeNum(completionDetails.reasoning_tokens);
        stats.imageCompletionTokens += safeNum(completionDetails.image_tokens);
        stats.audioCompletionTokens += safeNum(completionDetails.audio_tokens);

        const costDetails = usage.cost_details || {};
        stats.upstreamInferenceCost += Math.round(
          safeNum(costDetails.upstream_inference_cost) * COST_SCALE,
        );
        stats.upstreamInferencePromptCost += Math.round(
          safeNum(costDetails.upstream_inference_prompt_cost) * COST_SCALE,
        );
        stats.upstreamInferenceCompletionsCost += Math.round(
          safeNum(costDetails.upstream_inference_completions_cost) * COST_SCALE,
        );
      }

      log("");
      log(
        bold(
          blue(
            simpleTemplate(a.s.m.c.or.batchStatsHeader, {
              FileName: path.basename(fileToParse),
            }),
          ),
        ),
      );
      log("");

      const generalList = [
        {
          key: a.s.m.c.or.totalRequests,
          description: String(stats.totalRequests),
        },
        {
          key: a.s.m.c.or.successfulRequests,
          description: String(stats.successfulRequests),
        },
        {
          key: a.s.m.c.or.failedRequests,
          description: String(stats.failedRequests),
        },
      ];
      log(bold(yellow(`[${a.s.m.c.or.generalSection}]`)));
      log(
        formatAlignedList(generalList, {
          listIndentWidth: 2,
          firstColumnSeparator: ": ",
        }),
      );
      log("");

      // Convert scaled integer nano-dollars back to standard floats for display
      const finalTotalCost = stats.totalCost / COST_SCALE;
      const finalUpstreamCost = stats.upstreamInferenceCost / COST_SCALE;
      const finalUpstreamPromptCost =
        stats.upstreamInferencePromptCost / COST_SCALE;
      const finalUpstreamCompletionsCost =
        stats.upstreamInferenceCompletionsCost / COST_SCALE;

      const totalCostStr = finalTotalCost.toFixed(6);
      const upstreamCostStr = finalUpstreamCost.toFixed(6);

      const costList = [];

      // Only display the total cost if it contains OpenRouter markup (BYOK)
      if (finalTotalCost !== finalUpstreamCost && finalTotalCost > 0) {
        costList.push({
          key: a.s.m.c.or.totalCost,
          description: `$${totalCostStr}`,
        });
      }

      if (finalUpstreamCost > 0) {
        costList.push({
          key: a.s.m.c.or.upstreamInferenceCost,
          description: `$${upstreamCostStr}`,
        });
      }
      if (finalUpstreamPromptCost > 0) {
        costList.push({
          key: a.s.m.c.or.upstreamPromptCost,
          description: `$${finalUpstreamPromptCost.toFixed(6)}`,
        });
      }
      if (finalUpstreamCompletionsCost > 0) {
        costList.push({
          key: a.s.m.c.or.upstreamCompletionCost,
          description: `$${finalUpstreamCompletionsCost.toFixed(6)}`,
        });
      }

      if (costList.length > 0) {
        log(bold(yellow(`[${a.s.m.c.or.costsSection}]`)));
        log(
          formatAlignedList(costList, {
            listIndentWidth: 2,
            firstColumnSeparator: ": ",
          }),
        );
        log("");
      }

      const tokensList = [];

      if (stats.totalPromptTokens > 0) {
        tokensList.push({
          key: a.s.m.c.or.totalPromptTokens,
          description: String(stats.totalPromptTokens),
        });
      }
      if (stats.totalCompletionTokens > 0) {
        tokensList.push({
          key: a.s.m.c.or.totalCompletionTokens,
          description: String(stats.totalCompletionTokens),
        });
      }
      if (stats.totalTokens > 0) {
        tokensList.push({
          key: a.s.m.c.or.totalTokens,
          description: String(stats.totalTokens),
        });
      }

      if (stats.cachedTokens > 0) {
        tokensList.push({
          key: a.s.m.c.or.cachedTokens,
          description: String(stats.cachedTokens),
        });
      }
      if (stats.cacheWriteTokens > 0) {
        tokensList.push({
          key: a.s.m.c.or.cacheWriteTokens,
          description: String(stats.cacheWriteTokens),
        });
      }
      if (stats.audioPromptTokens > 0) {
        tokensList.push({
          key: a.s.m.c.or.audioPromptTokens,
          description: String(stats.audioPromptTokens),
        });
      }
      if (stats.videoPromptTokens > 0) {
        tokensList.push({
          key: a.s.m.c.or.videoPromptTokens,
          description: String(stats.videoPromptTokens),
        });
      }

      if (stats.reasoningTokens > 0) {
        tokensList.push({
          key: a.s.m.c.or.reasoningTokens,
          description: String(stats.reasoningTokens),
        });
      }
      if (stats.imageCompletionTokens > 0) {
        tokensList.push({
          key: a.s.m.c.or.imageCompletionTokens,
          description: String(stats.imageCompletionTokens),
        });
      }
      if (stats.audioCompletionTokens > 0) {
        tokensList.push({
          key: a.s.m.c.or.audioCompletionTokens,
          description: String(stats.audioCompletionTokens),
        });
      }

      if (tokensList.length > 0) {
        log(bold(yellow(`[${a.s.m.c.or.tokensSection}]`)));
        log(
          formatAlignedList(tokensList, {
            listIndentWidth: 2,
            firstColumnSeparator: ": ",
          }),
        );
        log("");
      }

      if (Object.keys(stats.modelCounts).length > 0) {
        const modelsList = Object.entries(stats.modelCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([model, count]) => ({
            key: model,
            description: `${count} request(s)`,
          }));
        log(bold(yellow(`[${a.s.m.c.or.modelsSection}]`)));
        log(
          formatAlignedList(modelsList, {
            listIndentWidth: 2,
            firstColumnSeparator: ": ",
          }),
        );
        log("");
      }

      if (Object.keys(stats.providerCounts).length > 0) {
        const providersList = Object.entries(stats.providerCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([provider, count]) => ({
            key: provider,
            description: `${count} request(s)`,
          }));
        log(bold(yellow(`[${a.s.m.c.or.providersSection}]`)));
        log(
          formatAlignedList(providersList, {
            listIndentWidth: 2,
            firstColumnSeparator: ": ",
          }),
        );
        log("");
      }

      if (failedList.length > 0) {
        log(bold(red(`[${a.s.m.c.or.failedSection}]`)));
        const formattedFailures = failedList.map((fail) => ({
          key: fail.customId,
          description: `[Status: ${fail.status}] ${fail.errorMsg}`,
        }));
        log(
          formatAlignedList(formattedFailures, {
            listIndentWidth: 2,
            firstColumnSeparator: " -> ",
          }),
        );
        log("");
      }

      return 0;
    }

    let apiKey = argValues.apikey;

    if (!apiKey) {
      const paramsKey = argValues.params;
      if (paramsKey) {
        const modelConfig = appConfig.PARAM_CONFIGS[paramsKey];
        if (modelConfig) {
          try {
            const activeConfig = resolveModelConfig(paramsKey, false);
            apiKey = activeConfig.model.apiKey;
          } catch {
            // Ignored to allow falling back to env var
          }
        }
      }
    }

    if (!apiKey) {
      apiKey = process.env["TELOCITYKEY"];
    }

    // Fallback to TEMPLATES["YOURKEY1"] if no other key found, but only if it's not the default placeholder
    if (!apiKey) {
      const templates = appConfig.TEMPLATES;
      if (templates && typeof templates === "object") {
        const yourKey = templates["YOURKEY1"];
        if (typeof yourKey === "string" && yourKey.trim() !== "") {
          // Treat as failure if the string contains the default placeholder "yourkey1" (case-insensitive)
          if (!yourKey.toLowerCase().includes("yourkey1")) {
            apiKey = yourKey;
          }
        }
      }
    }

    if (!apiKey) {
      throw createError(a.s.e.c.or.apiKeyRequired, {
        code: "API_KEY_REQUIRED",
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 10000);

    let response;
    try {
      response = await llmFetch("https://openrouter.ai/api/v1/key", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      });
    } catch (err) {
      const isTimeout = controller.signal.aborted;
      let errMsg: string;

      if (isTimeout) {
        errMsg = simpleTemplate(a.s.e.c.or.requestTimedOut, { Seconds: 10 });
      } else if (err instanceof Error) {
        errMsg = err.message;
      } else {
        errMsg = String(err);
      }

      throw createError(
        simpleTemplate(a.s.e.c.or.fetchFailed, {
          Status: isTimeout ? "Timeout" : "Error",
          Error: errMsg,
        }),
        { code: "FETCH_FAILED", cause: err },
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw createError(
        simpleTemplate(a.s.e.c.or.fetchFailed, {
          Status: response.status.toString(),
          Error: errorText,
        }),
        { code: "FETCH_FAILED" },
      );
    }

    type KeyInfo = {
      data: {
        label: string;
        limit: number | null;
        limit_reset: string | null;
        limit_remaining: number | null;
        include_byok_in_limit: boolean;
        usage: number;
        usage_daily: number;
        usage_weekly: number;
        usage_monthly: number;
        byok_usage: number;
        byok_usage_daily: number;
        byok_usage_weekly: number;
        byok_usage_monthly: number;
        is_free_tier: boolean;
      };
    };

    const result = (await response.json()) as KeyInfo;

    if (!result || !result.data) {
      throw createError(a.s.e.c.or.invalidResponse, {
        code: "INVALID_OPENROUTER_RESPONSE",
      });
    }

    const info = result.data;

    log("");
    log(bold(blue(`=== ${a.s.m.c.or.header} ===`)));
    log("");

    const formatValue = (val: number | null) => {
      if (val === null) return a.s.m.c.or.unlimited;
      return `$${val.toFixed(4)}`;
    };

    const detailsList: Array<{ key: string; description: string }> = [];

    if (info.label) {
      detailsList.push({ key: a.s.m.c.or.label, description: info.label });
    }
    detailsList.push({
      key: a.s.m.c.or.isFreeTier,
      description: info.is_free_tier ? a.s.m.c.or.yes : a.s.m.c.or.no,
    });
    if (info.limit === null || info.limit > 0) {
      detailsList.push({
        key: a.s.m.c.or.limit,
        description: formatValue(info.limit),
      });
    }
    if (info.limit_remaining === null || info.limit_remaining > 0) {
      detailsList.push({
        key: a.s.m.c.or.limitRemaining,
        description: formatValue(info.limit_remaining),
      });
    }
    if (info.limit_reset && (info.limit === null || info.limit > 0)) {
      detailsList.push({
        key: a.s.m.c.or.limitReset,
        description: info.limit_reset,
      });
    }
    if (info.include_byok_in_limit) {
      detailsList.push({
        key: a.s.m.c.or.byokIncluded,
        description: a.s.m.c.or.yes,
      });
    }

    if (detailsList.length > 0) {
      log(bold(yellow(`[${a.s.m.c.or.creditsSection}]`)));
      log(
        formatAlignedList(detailsList, {
          listIndentWidth: 2,
          firstColumnSeparator: ": ",
        }),
      );
      log("");
    }

    const usageList: Array<{ key: string; description: string }> = [];

    if (info.usage > 0) {
      usageList.push({
        key: a.s.m.c.or.usageAllTime,
        description: formatValue(info.usage),
      });
    }
    if (info.usage_daily > 0) {
      usageList.push({
        key: a.s.m.c.or.usageDaily,
        description: formatValue(info.usage_daily),
      });
    }
    if (info.usage_weekly > 0) {
      usageList.push({
        key: a.s.m.c.or.usageWeekly,
        description: formatValue(info.usage_weekly),
      });
    }
    if (info.usage_monthly > 0) {
      usageList.push({
        key: a.s.m.c.or.usageMonthly,
        description: formatValue(info.usage_monthly),
      });
    }
    if (info.byok_usage > 0) {
      usageList.push({
        key: a.s.m.c.or.byokUsageAllTime,
        description: formatValue(info.byok_usage),
      });
    }
    if (info.byok_usage_daily > 0) {
      usageList.push({
        key: a.s.m.c.or.byokUsageDaily,
        description: formatValue(info.byok_usage_daily),
      });
    }
    if (info.byok_usage_weekly > 0) {
      usageList.push({
        key: a.s.m.c.or.byokUsageWeekly,
        description: formatValue(info.byok_usage_weekly),
      });
    }
    if (info.byok_usage_monthly > 0) {
      usageList.push({
        key: a.s.m.c.or.byokUsageMonthly,
        description: formatValue(info.byok_usage_monthly),
      });
    }

    if (usageList.length > 0) {
      log(bold(yellow(`[${a.s.m.c.or.usageSection}]`)));
      log(
        formatAlignedList(usageList, {
          listIndentWidth: 2,
          firstColumnSeparator: ": ",
        }),
      );
      log("");
    }

    return 0;
  }
}
