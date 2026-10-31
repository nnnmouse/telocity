import fs from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";

import {
  config as appConfig,
  createError,
  errlog,
  exitOne,
  fastHash,
  isEexistError,
  isEnoentError,
  isNodeError,
  log,
  raceWithSignal,
  resolveConfig,
  runConcur,
  simpleTemplate,
  V,
  x,
  yellow,
  readStdin,
  blue,
  red,
} from "../core/index.ts";
import {
  type ConfigMap,
  type LLMConfigurableProps,
  type LLMDependencies,
  type JsonlBatchRequest,
  type LLMAPIError,
  type TerminationState,
  type BatchProcessOptions,
  type GenerateProcessedBatchesOptions,
  type Endpoints,
} from "../types/index.ts";
import { LLM, ReasoningTracker, OutputRenderer } from "./LLM.ts";
import {
  parseJsonlBatchLine,
  resolveJSONLStrategy,
  validateFiles,
} from "./LLMIOutils.ts";
import { TerminalStreamer } from "./LLMOutputStreamer.ts";
import {
  getAPIErrorStatus,
  isModerationBlock,
  resolveStrategy,
  stripGarbageNewLines,
} from "./LLMutils.ts";

let _ARG_CONFIG: ConfigMap<
  LLMJSONLBatcher & LLMConfigurableProps,
  LLMConfigurableProps
>;

function getArgConfig() {
  if (_ARG_CONFIG) {
    return _ARG_CONFIG;
  }

  const { a } = x;
  _ARG_CONFIG = {
    lastIndex: {
      prop: "lastIndex" as keyof (LLMJSONLBatcher & LLMConfigurableProps),
      validate: V.num(
        { min: 0, integer: true },
        a.s.e.v.invalidIndex,
        "INVALID_INDEX",
        "{{ .Index }}",
      ),
    },
  } as const;
  return _ARG_CONFIG;
}

export class LLMJSONLBatcher extends LLM {
  private readonly text: string;
  private chunks: readonly JsonlBatchRequest[] = [];
  private length: number = 0;
  private processedBatch: string[];
  private readonly targetPath: string;
  private readonly hash: string = "";
  private lastIndex: number = 0;
  private terminationState: TerminationState = LLM.TerminationState.NONE;
  private lockFilePath: string = "";
  private lockFileDescriptor: number | null = null;
  private retryFailedFrom?: string;

  // Used for continuous rate limit pacing (Leaky Bucket)
  private lastRequestStartTime: number = 0;

  private failureCount: number = 0;

  private constructor(
    options: LLMConfigurableProps,
    targetPath: string,
    text: string,
    hash: string,
    dependencies?: LLMDependencies,
  ) {
    super(options, dependencies);
    this.processedBatch = [];
    this.targetPath = targetPath;
    this.text = stripGarbageNewLines(text, {
      stripEmpty: false,
      markdownBrainRot: false,
    });
    this.hash = hash;
    this.lockFilePath = path.join(this.appState.STATE_DIR, `${this.hash}.lock`);
    this.retryFailedFrom = options.retryFailedFrom;

    V.num(
      { min: 0, integer: true },
      simpleTemplate(this.appState.s.e.v.invalidOption, { Value: "MAX_FAIL" }),
      "INVALID_MAX_FAIL_VALUE",
    )(appConfig.MAX_FAIL);

    const batcherState = resolveConfig<
      LLMJSONLBatcher & LLMConfigurableProps,
      LLMConfigurableProps
    >(
      this as unknown as LLMJSONLBatcher & LLMConfigurableProps,
      options,
      getArgConfig() as unknown as ConfigMap<
        LLMJSONLBatcher & LLMConfigurableProps,
        LLMConfigurableProps
      >,
    );
    Object.assign(this, batcherState);
  }

  private async initialize(): Promise<void> {
    try {
      if (this.text === "") {
        throw createError(this.appState.s.e.lllm.emptyFile, {
          code: "EMPTY_FILE",
        });
      }

      await this.acquireLock();

      this.chunks = await this.generateChunks(this.text);
      this.length = this.chunks.length;
      this.lastIndex = 0;

      if (this.length === 0) {
        void this.close();
        throw createError(this.appState.s.m.lllm.processingComplete, {
          code: "PROCESSING_ALREADY_COMPLETE",
        });
      }
    } catch (err) {
      void this.close();
      throw createError(this.appState.s.e.lllm.initializingBatch, {
        cause: err,
      });
    }
  }

  // oxlint-disable-next-line require-await
  private async acquireLock(): Promise<void> {
    try {
      this.lockFileDescriptor = fs.openSync(this.lockFilePath, "wx");
    } catch (err) {
      if (isEexistError(err)) {
        throw createError(this.appState.s.m.lllm.anotherInstanceIsProcessing, {
          cause: err,
        });
      }
      throw createError(this.appState.s.e.lllm.failedLock, { cause: err });
    }
  }

  private async generateChunks(text: string): Promise<JsonlBatchRequest[]> {
    const allInputLines = text.split("\n").filter((l) => l.trim() !== "");

    const failedIds = new Set<string>();
    if (this.retryFailedFrom) {
      try {
        const prevText = await readFile(this.retryFailedFrom, "utf-8");
        const lines = prevText.split("\n").filter((l) => l.trim() !== "");
        for (const line of lines) {
          const parsed = parseJsonlBatchLine(line, this.strategy.jsonlFormat);
          if (parsed.isError) {
            failedIds.add(parsed.customId);
          }
        }
      } catch (err) {
        if (!isEnoentError(err)) throw err;
      }

      if (failedIds.size === 0) {
        throw createError(this.appState.s.m.lllm.processingComplete, {
          code: "PROCESSING_ALREADY_COMPLETE",
        });
      }
    }

    const completedIds = new Set<string>();
    try {
      const targetText = await readFile(this.targetPath, "utf-8");
      const targetLines = targetText.split("\n").filter((l) => l.trim() !== "");
      for (const line of targetLines) {
        const parsed = parseJsonlBatchLine(line, this.strategy.jsonlFormat);
        // Don't let the set be poisoned by malformed lines
        if (parsed.customId && parsed.customId !== "unknown") {
          completedIds.add(parsed.customId);
        }
      }
    } catch (err) {
      if (!isEnoentError(err)) throw err;
    }

    const parsedPending: JsonlBatchRequest[] = [];
    for (const l of allInputLines) {
      const strat = resolveJSONLStrategy({
        line: l,
        format: this.strategy.jsonlFormat,
      });
      const parsed = strat.parseRequest(l);
      if (!parsed) continue;

      // Handle standard third-party batch files (completely raw / no meta block)
      if (!parsed.telocity) {
        parsed.url = this.url;
        parsed.telocity = {
          url: this.url,
          endpoint: this.endpoint,
        };
      }

      if (this.retryFailedFrom) {
        if (
          failedIds.has(parsed.custom_id) &&
          !completedIds.has(parsed.custom_id)
        ) {
          parsedPending.push(parsed);
        }
      } else if (!completedIds.has(parsed.custom_id)) {
        parsedPending.push(parsed);
      }
    }

    return parsedPending;
  }

  private async saveProgress(): Promise<void> {
    if (!this.lockFileDescriptor) return;

    try {
      if (this.processedBatch.length > 0) {
        const normalized = this.processedBatch.join("\n") + "\n";
        let fileHandle;
        try {
          fileHandle = await open(this.targetPath, "a+");
          await fileHandle.write(normalized, undefined, "utf-8");
        } finally {
          if (fileHandle) {
            await fileHandle.close();
          }
        }
        this.processedBatch = [];
      }
    } catch (err) {
      throw createError(this.appState.s.e.lllm.failedToSaveProgress, {
        cause: err,
      });
    }
  }

  private getChunkTemperature(req: JsonlBatchRequest): number | undefined {
    const bodyTemp = req.body?.["temperature"];
    if (typeof bodyTemp === "number") {
      return bodyTemp;
    }
    return this.temperature?.[0] ? this.temperature[1] : undefined;
  }

  private getChunkMaxAttempts(req: JsonlBatchRequest): number {
    return req.telocity?.maxAttempts ?? this.maxAttempts;
  }

  private getChunkMaxFail(req: JsonlBatchRequest): number {
    return req.telocity?.maxFail ?? this.maxFail ?? appConfig.MAX_FAIL ?? 5;
  }

  private getChunkRetryDelay(req: JsonlBatchRequest): number {
    return req.telocity?.retryDelay ?? this.retryDelay;
  }

  private getChunkTempValues(req: JsonlBatchRequest): number[] | undefined {
    return req.telocity?.tempValues ?? this.tempValues;
  }

  private getChunkRpm(req: JsonlBatchRequest): number {
    return req.telocity?.rpm ?? this.rpm;
  }

  private getChunkFailureMeansDeath(req: JsonlBatchRequest): boolean {
    return (
      req.telocity?.failureMeansDeath ??
      this.failureMeansDeath ??
      appConfig.FAILURE_MEANS_DEATH ??
      false
    );
  }

  private getCurrentMaxFailLimit(): number {
    const remaining = this.chunks.slice(this.lastIndex);
    if (remaining.length === 0) {
      return this.maxFail ?? appConfig.MAX_FAIL ?? 5;
    }
    let minLimit = Infinity;
    for (const chunk of remaining) {
      const limit = this.getChunkMaxFail(chunk);
      if (limit > 0 && limit < minLimit) {
        minLimit = limit;
      }
    }
    return minLimit === Infinity
      ? (this.maxFail ?? appConfig.MAX_FAIL ?? 5)
      : minLimit;
  }

  private handleCancellation(
    req: JsonlBatchRequest,
    message: string,
    code = "ABORT_ERR",
  ): string {
    const itemEndpoint: Endpoints = req.telocity?.endpoint ?? this.endpoint!;
    const activeStrategy = resolveStrategy(itemEndpoint);
    const jsonlStrat = resolveJSONLStrategy({
      format: activeStrategy.jsonlFormat ?? "openai",
    });

    return jsonlStrat.buildResponse(req.custom_id, null, {
      code,
      message,
    });
  }

  private handleChunkFailure(req: JsonlBatchRequest, err: unknown): string {
    const itemEndpoint: Endpoints = req.telocity?.endpoint ?? this.endpoint!;
    const activeStrategy = resolveStrategy(itemEndpoint);

    const jsonlStrat = resolveJSONLStrategy({
      format: activeStrategy.jsonlFormat ?? "openai",
    });

    return jsonlStrat.buildResponse(req.custom_id, null, {
      code: isNodeError(err) && err.code ? err.code : "max_retries",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  private async processChunk(
    req: JsonlBatchRequest,
    temp: number | undefined,
    verbose?:
      | boolean
      | ((chunk: string, isReasoning?: boolean) => Promise<void>),
  ): Promise<string> {
    const hasTelocity = !!req.telocity;

    const targetUrl = req.telocity?.url ?? req.url ?? this.url;
    const itemEndpoint: Endpoints = req.telocity?.endpoint ?? this.endpoint!;
    const activeStrategy = resolveStrategy(itemEndpoint);

    // Clone body to safely prevent cross-contamination if retried.
    const payload = { ...(req.body || {}) } as Record<string, unknown>;

    let activeForceStream = this.forceStream;
    if (hasTelocity && req.telocity?.forceStream !== undefined) {
      activeForceStream = req.telocity.forceStream;
    }

    const isLiveStream = activeForceStream || typeof verbose === "function";

    const jsonlStrat = resolveJSONLStrategy({
      format: activeStrategy.jsonlFormat ?? "openai",
    });

    if (!hasTelocity) {
      const keysToClean = [
        "enable_thinking",
        "chat_template_kwargs",
        "reasoning_effort",
        "reasoning",
        "include",
        "grammar",
        "response_format",
      ];
      for (const k of keysToClean) {
        delete payload[k];
      }

      for (const k of activeStrategy.supportedParams) {
        if (k === "temperature") {
          if (temp !== undefined) {
            payload["temperature"] = temp;
          } else {
            delete payload["temperature"];
          }
        } else {
          const prop = this[k];
          if (Array.isArray(prop) && prop[0]) {
            payload[k] = prop[1];
          }
        }
      }
    } else {
      // Determine the base temperature from the request itself to prevent preset fallback,
      // while still preserving temperature increments generated during active retries.
      const baseTemp = (req.telocity?.["temperature"] ??
        req.body?.["temperature"]) as number | undefined;
      const activeTemp =
        temp !== undefined && baseTemp !== undefined && temp !== baseTemp
          ? temp
          : baseTemp;

      for (const k of activeStrategy.supportedParams) {
        if (k === "temperature") {
          if (activeTemp !== undefined) {
            payload["temperature"] = activeTemp;
          } else {
            delete payload["temperature"];
          }
        } else {
          // Strictly map explicit parameter overrides from req.telocity if supported,
          // bypassing preset parameter copying entirely.
          if (req.telocity?.[k] !== undefined) {
            payload[k] = req.telocity[k];
          }
        }
      }
    }

    payload["stream"] = isLiveStream;
    const tracker = new ReasoningTracker();
    let rawBody: unknown;

    let customHardTimeout: number | undefined;
    let customIdleTimeout: number | undefined;

    const overrides: Partial<LLMConfigurableProps> = {};

    if (hasTelocity) {
      if (typeof req.telocity?.hardTimeout === "number") {
        customHardTimeout = req.telocity.hardTimeout;
      }
      if (typeof req.telocity?.idleTimeout === "number") {
        customIdleTimeout = req.telocity.idleTimeout;
      }
      if (req.telocity?.stripEmpty !== undefined) {
        overrides.stripEmpty = req.telocity.stripEmpty;
      }
      if (req.telocity?.markdownBrainRot !== undefined) {
        overrides.markdownBrainRot = req.telocity.markdownBrainRot;
      }
      if (req.telocity?.forceStream !== undefined) {
        overrides.forceStream = req.telocity.forceStream;
      }
      if (req.telocity?.extra_body !== undefined) {
        overrides.extra_body = req.telocity.extra_body;
      }
      if (req.telocity?.allowH2 !== undefined) {
        overrides.allowH2 = req.telocity.allowH2;
      }
    }

    const text = await this.completion([], {
      verbose,
      signal: this.controller.signal,
      tracker,
      overrides,
      endpointOptions: {
        url: targetUrl,
        strategy: activeStrategy,
        payload,
        method: req.method || "POST",
        isStreaming: isLiveStream,
        hardTimeout: customHardTimeout,
        idleTimeout: customIdleTimeout,
        onRawResponse: (data) => {
          rawBody = data;
        },
      },
    });

    let finalBody: Record<string, unknown>;
    if (rawBody) {
      finalBody = rawBody as Record<string, unknown>;
      if (activeStrategy.updateResponseContent) {
        finalBody = activeStrategy.updateResponseContent(finalBody, text);
      }
    } else {
      if (
        activeStrategy.finalizeAccumulator &&
        activeStrategy.createAccumulator
      ) {
        const ctx = this.getStrategyContext(tracker);
        const acc = activeStrategy.createAccumulator([], ctx);
        finalBody = activeStrategy.finalizeAccumulator(acc, text, ctx);
      } else {
        finalBody = {
          choices: [
            {
              message: {
                role: "assistant",
                content: text,
              },
            },
          ],
        };
      }
    }

    return jsonlStrat.buildResponse(req.custom_id, finalBody, null);
  }

  private async processBatch(options?: BatchProcessOptions): Promise<string[]> {
    let completedInBatch = 0;
    const totalChunks = this.chunks.length;

    const getCancelCode = (): string => {
      const reason = this.controller.signal.reason;
      return isNodeError(reason) && reason.code ? reason.code : "ABORT_ERR";
    };

    const tasks = this.chunks
      .slice(this.lastIndex, this.lastIndex + this.batchSize)
      .map((chunk) => {
        const run = async (
          attempt = 1,
          temp = this.getChunkTemperature(chunk),
        ): Promise<string> => {
          // --- Continuous Pacing Strategy (Leaky Bucket) ---
          const requestRpm = this.getChunkRpm(chunk);
          const delayMs = requestRpm > 0 ? 60000 / requestRpm : 0;

          if (delayMs > 0) {
            const now = Date.now();

            // Initialize tracker so the very first request fires immediately
            if (this.lastRequestStartTime === 0) {
              this.lastRequestStartTime = now - delayMs;
            }

            // The target start time is the LAST assigned start time + the required delay
            let targetStartTime = this.lastRequestStartTime + delayMs;

            // If the target time is in the past (e.g. initial start, or network lag caused a gap), snap it to 'now'
            if (targetStartTime < now) {
              targetStartTime = now;
            }

            const timeToWait = targetStartTime - now;

            // Synchronously "reserve" this calculated start time for THIS worker.
            // The next concurrent worker will build on top of this updated value in the exact same event loop tick.
            this.lastRequestStartTime = targetStartTime;

            if (timeToWait > 0) {
              try {
                await this.interruptibleDelay(timeToWait);
              } catch {
                // Handle early pacing interrupts gracefully
                return this.handleCancellation(
                  chunk,
                  this.appState.s.e.lcli.processingAborted,
                  getCancelCode(),
                );
              }
            }
          } else {
            this.lastRequestStartTime = Date.now();
          }

          if (this.controller.signal.aborted) {
            return this.handleCancellation(
              chunk,
              this.appState.s.e.lcli.processingAborted,
              getCancelCode(),
            );
          }

          try {
            const result = await raceWithSignal(
              this.processChunk(chunk, temp, options?.verbose),
              this.controller.signal,
            );

            completedInBatch++;
            if (options?.onProgress) {
              options.onProgress(
                this.lastIndex + completedInBatch,
                totalChunks,
              );
            }

            return result;
          } catch (err) {
            if (
              this.controller.signal.aborted ||
              (err instanceof Error && err.name === "AbortError") ||
              (isNodeError(err) && err.code === "ABORT_ERR")
            ) {
              return this.handleCancellation(
                chunk,
                this.appState.s.e.lcli.processingAborted,
                getCancelCode(),
              );
            }

            const currentMaxFail = this.getCurrentMaxFailLimit();
            if (currentMaxFail > 0) {
              this.failureCount++;
              if (this.failureCount >= currentMaxFail) {
                errlog(
                  { level: "error" },
                  simpleTemplate(this.appState.s.e.lllm.maxFailReached, {
                    MaxFail: String(currentMaxFail),
                  }),
                );
                this.cancel("MAX_FAIL_REACHED", "batch_aborted");
                return this.handleChunkFailure(chunk, err);
              }
            }

            const apiErrorCast = err as LLMAPIError;
            const apiStatus =
              getAPIErrorStatus(err) ?? apiErrorCast.status ?? null;
            const retryAfter = apiErrorCast.retryAfter;

            const errorMessage =
              err instanceof Error ? err.message : String(err);

            const isModerated = isModerationBlock(
              apiStatus,
              apiErrorCast.code,
              errorMessage,
            );

            // Stop entire batch for structurally fatal errors
            if (
              apiStatus === 400 ||
              apiStatus === 401 ||
              apiStatus === 402 ||
              (apiStatus === 403 && !isModerated) ||
              apiStatus === 429 ||
              apiStatus === 503
            ) {
              errlog(
                { level: "error" },
                simpleTemplate(this.appState.s.e.lllm.accountWideError, {
                  Status: String(apiStatus),
                }),
              );
              this.cancel(`API_ERROR_${apiStatus}`, "batch_aborted");
              return this.handleChunkFailure(chunk, err);
            }

            // Prompt-specific failures (e.g. guardrail blocks or content filter triggers)
            // are marked failed immediately, bypassing retries, but batch continues
            if (isModerated) {
              errlog(
                { level: "warn" },
                apiErrorCast.code === "CONTENT_FILTER_TRIGGERED"
                  ? this.appState.s.e.lllm.contentFilterTriggered
                  : this.appState.s.e.lllm.promptBlockedWarning,
              );
              return this.handleChunkFailure(chunk, err);
            }

            const failureMeansDeathActive =
              this.getChunkFailureMeansDeath(chunk);

            if (failureMeansDeathActive) {
              errlog(
                { level: "error" },
                this.appState.s.e.lllm.failureMeansDeathStopped,
                errorMessage,
              );
              this.cancel();
              return this.handleChunkFailure(chunk, err);
            }

            const maxAttempts = this.getChunkMaxAttempts(chunk);
            if (attempt >= maxAttempts) {
              return this.handleChunkFailure(chunk, err);
            }

            if (options?.onRetry) {
              options.onRetry();
            } else if (options?.verbose) {
              process.stdout.write("\n");
            }

            let nextTemp = temp;
            // Only grow/apply temperature if it was defined in the first place
            const tempValues = this.getChunkTempValues(chunk);
            if (temp !== undefined && tempValues && tempValues.length > 0) {
              const retryIndex = attempt - 1;
              const targetIndex = Math.min(retryIndex, tempValues.length - 1);
              const stepTemp = tempValues[targetIndex];
              if (stepTemp !== undefined) {
                nextTemp = stepTemp;
              }
            }

            // Honor API Retry-After delays if available; otherwise use exponential backoff
            let waitTime: number;
            if (
              retryAfter !== undefined &&
              Number.isFinite(retryAfter) &&
              retryAfter > 0
            ) {
              waitTime = retryAfter * 1000 + Math.random() * 1000;
            } else {
              const retryDelay = this.getChunkRetryDelay(chunk);
              const baseDelay = Math.pow(2, attempt - 1) * retryDelay;
              const jitter = Math.random() * 1000;
              waitTime = Math.min(60000, baseDelay + jitter);
            }

            if (nextTemp !== undefined) {
              log(
                yellow(
                  simpleTemplate(this.appState.s.m.lllm.retryWithTemp, {
                    Attempt: String(attempt),
                    Temp: nextTemp,
                  }),
                ),
              );
            } else {
              log(
                yellow(
                  simpleTemplate(this.appState.s.m.lllm.retrying, {
                    Attempt: String(attempt),
                  }),
                ),
              );
            }

            // Wrap the delay and recursion to protect against unhandled pacing aborts
            try {
              // Await the specific retry delay, then recursive call to run()
              // which will re-enter the RPM pacing queue natively.
              await this.interruptibleDelay(waitTime);
              return run(attempt + 1, nextTemp);
            } catch {
              return this.handleCancellation(
                chunk,
                this.appState.s.e.lcli.processingAborted,
                getCancelCode(),
              );
            }
          }
        };
        return run;
      });

    // Enforce a short 100ms cooldown after the entire concurrent batch
    // has finished executing, before the next batch is allowed to begin.
    await this.interruptibleDelay(100);

    return runConcur(tasks, { concurrency: this.parallel });
  }

  // oxlint-disable-next-line require-await
  private async interruptibleDelay(ms: number): Promise<void> {
    if (ms <= 0) return;

    if (this.controller.signal.aborted) {
      throw createError(this.appState.s.e.lcli.processingAborted, {
        code: "ABORT_ERR",
        immediateExitCode: false,
      });
    }

    return new Promise((resolve, reject) => {
      // (onAbort needs timer, timer needs onAbort)
      // oxlint-disable-next-line prefer-const
      let timer: ReturnType<typeof setTimeout>;

      const onAbort = () => {
        if (timer) clearTimeout(timer);
        this.controller.signal.removeEventListener("abort", onAbort);
        reject(
          createError(this.appState.s.e.lcli.processingAborted, {
            code: "ABORT_ERR",
            immediateExitCode: false,
          }),
        );
      };

      timer = setTimeout(() => {
        this.controller.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      this.controller.signal.addEventListener("abort", onAbort);
    });
  }

  private async *executeBatchSequence(
    options?: GenerateProcessedBatchesOptions,
  ) {
    while (this.lastIndex < this.chunks.length) {
      if (this.controller.signal.aborted) break;

      const processedBatch = await this.processBatch(options);
      this.processedBatch.push(...processedBatch);

      this.lastIndex = Math.min(
        this.lastIndex + this.batchSize,
        this.chunks.length,
      );

      await this.saveProgress();

      yield { processedBatch, lastIndex: this.lastIndex };
    }
  }

  private async close(graceful = false): Promise<void> {
    if (this.lockFileDescriptor) {
      try {
        fs.closeSync(this.lockFileDescriptor);
      } catch {
        /* ignore */
      }
      this.lockFileDescriptor = null;

      if (fs.existsSync(this.lockFilePath)) {
        try {
          fs.unlinkSync(this.lockFilePath);
        } catch {
          /* ignore */
        }
      }
    }
    if (graceful) {
      await this.networkContext.shutdown();
    } else {
      this.networkContext.destroy();
    }
  }

  public static async create(
    options: LLMConfigurableProps,
    sourcePath: string,
    targetPath: string,
    dependencies?: LLMDependencies,
  ): Promise<LLMJSONLBatcher> {
    // instance.stateVersion = CURRENT_STATE_VERSION;
    await validateFiles(sourcePath, targetPath);

    let text = "";
    if (sourcePath === "-") {
      // If data is piped/redirected, read from stdin; otherwise, use empty text
      if (!process.stdin.isTTY) {
        text = await readStdin();
      }
    } else {
      text = await readFile(sourcePath, "utf-8");
    }

    const hash = fastHash(text);

    const finalOptions: LLMConfigurableProps = { ...options, lastIndex: 0 };

    const instance = new this(
      finalOptions,
      targetPath,
      text,
      hash,
      dependencies,
    );

    await instance.initialize();
    return instance;
  }

  public async execute(): Promise<void> {
    const delay = 500;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const isStreaming = this.batchSize === 1 && !this.appState.NO_STREAM;

    const streamer = new TerminalStreamer(
      this.appState.TERMINAL_WIDTH,
      async (chunk) => {
        await new Promise<void>((resolve) => {
          if (process.stdout.write(chunk)) resolve();
          else process.stdout.once("drain", resolve);
        });
      },
      !this.appState.NO_MARKDOWN,
      {
        stripEmpty: this.stripEmpty,
        markdownBrainRot: this.markdownBrainRot,
        streaming: isStreaming,
      },
    );

    let streamCallback:
      | ((chunk: string, isReasoning?: boolean) => Promise<void>)
      | undefined;
    let retryCallback: (() => void) | undefined;
    let progressCallback:
      | ((completed: number, total: number) => void)
      | undefined;

    if (isStreaming) {
      streamCallback = async (chunk: string, isReasoning?: boolean) => {
        if (isReasoning && !process.env["REASONING_CONTENT"]) return;
        await streamer.process(chunk);
      };
      retryCallback = () => {
        process.stdout.write("\n\n");
        streamer.reset();
      };
    }

    if (this.batchSize > 1 && this.appState.isInteractive) {
      progressCallback = (completed: number, total: number) => {
        const progressText = simpleTemplate(
          this.appState.s.m.lllm.batchProgress,
          {
            Completed: String(completed),
            Total: String(total),
          },
        );
        process.stdout.write(`\r\x1b[K${progressText}`);
        this.appState.hasActiveProgressLine = true;
      };
    }

    const signalHandler = () => {
      if (this.terminationState === LLM.TerminationState.NONE) {
        this.terminationState = LLM.TerminationState.REQUESTED;
        log(red(this.appState.s.m.lllm.ctrlCPressed));
        if (!timeoutId) {
          timeoutId = setTimeout(() => {
            this.terminationState = LLM.TerminationState.FORCEFUL;
          }, delay);
        }
      } else if (this.terminationState === LLM.TerminationState.REQUESTED) {
        log(this.appState.s.m.lllm.ctrlCPressed2);
      } else {
        errlog(red(this.appState.s.m.lllm.quittingWithoutSaving));
        this.cancel(undefined, "user_cancelled");
      }
    };

    if (this.appState.isInteractive) {
      process.on("SIGINT", signalHandler);
    }

    try {
      const batchOptions: GenerateProcessedBatchesOptions = {
        verbose: streamCallback,
        onRetry: retryCallback,
        onProgress: progressCallback,
      };

      for await (const {
        processedBatch,
        lastIndex,
      } of this.executeBatchSequence(batchOptions)) {
        if (progressCallback) {
          process.stdout.write("\r\x1b[K");
          this.appState.hasActiveProgressLine = false;
        }

        for (const [i, processedChunk] of processedBatch.entries()) {
          const parsedLine = parseJsonlBatchLine(
            processedChunk,
            this.strategy.jsonlFormat,
          );
          const isError = parsedLine.isError;
          const customId = parsedLine.customId;

          if (!isStreaming) {
            const renderer = new OutputRenderer(undefined, streamer);
            if (parsedLine.reasoningText) {
              await renderer.processItem({
                text: parsedLine.reasoningText,
                kind: "reasoning",
              });
            }
            if (parsedLine.text) {
              await renderer.processItem({
                text: parsedLine.text,
                kind: "output",
              });
            }
            await renderer.flush();
          } else {
            await streamer.flush();
          }

          log(
            blue(
              simpleTemplate(this.appState.s.m.lllm.processedChunkOf, {
                Processed: lastIndex - processedBatch.length + i + 1,
                Total: this.length,
              }),
            ) +
              (isError ? red(` [FAILED: ${customId}]`) : ` [OK: ${customId}]`),
          );
        }

        if (this.terminationState !== LLM.TerminationState.NONE) {
          break;
        }
      }
    } catch (err) {
      if (
        (err instanceof Error && err.name === "AbortError") ||
        (isNodeError(err) && err.code === "ABORT_ERR")
      ) {
        exitOne();
      } else {
        exitOne();
        if (err instanceof Error) {
          errlog(red(this.appState.s.e.lllm.llmAPICall + err.message));
          if (err.cause instanceof Error) {
            errlog(
              red(`>Cause: ${err.cause.message || JSON.stringify(err.cause)}`),
            );
          }
        } else {
          errlog(red(this.appState.s.e.lllm.llmAPICall + String(err)));
        }
      }
    } finally {
      await streamer.flush();

      if (progressCallback) {
        process.stdout.write("\r\x1b[K");
        this.appState.hasActiveProgressLine = false;
      }

      if (!this.controller.signal.aborted) {
        log(yellow(this.appState.s.m.lllm.progressSavedTerminating));
        await this.close(true);
      } else {
        log(red(this.appState.s.m.lllm.terminatedForcefully));
        await this.close(false);
      }

      if (this.appState.isInteractive) {
        process.off("SIGINT", signalHandler);
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}
