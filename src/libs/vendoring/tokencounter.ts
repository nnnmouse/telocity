import { readFile, writeFile } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import path from "node:path";
import { isSea } from "node:sea";
import { serialize } from "node:v8";
import { Worker } from "node:worker_threads";

import type { TokenizerConfig, TokenizerJSON } from "./tokenizertypes.ts";

import { resolveAsset } from "../core/context.ts";
import {
  createError,
  errlog,
  isEnoentError,
  simpleTemplate,
  x,
} from "../core/index.ts";

let sharedBufferCache:
  | Map<
      string,
      Promise<{
        sharedBinaryBuffer: SharedArrayBuffer;
      }>
    >
  | undefined;

// oxlint-disable-next-line require-await
async function getSerializedSharedBuffers(tokenizerName: string) {
  if (sharedBufferCache === undefined) {
    sharedBufferCache = new Map();
  }

  const cacheKey = `${tokenizerName}_serialized_shared`;

  if (!sharedBufferCache.has(cacheKey)) {
    const promise = (async () => {
      const { a } = x;
      const modelsDir = path.join(a.STATE_DIR, "models");

      const tokenizerBinPath = path.join(modelsDir, `${tokenizerName}.bin`);
      const tokenizerJsonPath = path.join(modelsDir, `${tokenizerName}.json`);
      const tokenizerConfigPath = path.join(
        modelsDir,
        `${tokenizerName}_config.json`,
      );

      let binBytes: Buffer;

      try {
        // Attempt to read the compiled V8 binary directly
        binBytes = await readFile(tokenizerBinPath);
      } catch (err) {
        if (isEnoentError(err)) {
          // Compiled binary does not exist, build it from the JSON configurations
          try {
            const [tokenizerJsonStr, tokenizerConfigStr] = await Promise.all([
              readFile(tokenizerJsonPath, "utf-8"),
              readFile(tokenizerConfigPath, "utf-8"),
            ]);

            const tokenizerJSON: TokenizerJSON = JSON.parse(tokenizerJsonStr);
            const tokenizerConfig: TokenizerConfig =
              JSON.parse(tokenizerConfigStr);

            // Construct Maps natively for compilation
            const vocabMap = new Map<string, number>(
              Object.entries(tokenizerJSON.model?.vocab || {}),
            );

            const mergesMap = new Map<string, Map<string, number>>();
            for (const [i, merge_pair] of (
              tokenizerJSON.model?.merges || []
            ).entries()) {
              let p1: string;
              let p2: string;

              if (typeof merge_pair === "string") {
                const split_parts = merge_pair.split(" ");
                if (split_parts.length !== 2) continue;
                // Use non-null assertions since length was verified
                p1 = split_parts[0]!;
                p2 = split_parts[1]!;
              } else if (Array.isArray(merge_pair) && merge_pair.length === 2) {
                // Access by index with non-null assertions to satisfy TS
                p1 = merge_pair[0]!;
                p2 = merge_pair[1]!;
              } else {
                continue;
              }

              let p1Map = mergesMap.get(p1);
              if (!p1Map) {
                p1Map = new Map<string, number>();
                mergesMap.set(p1, p1Map);
              }
              p1Map.set(p2, i);
            }

            const compiledState = {
              vocab: vocabMap,
              merges: mergesMap,
              added_tokens: tokenizerJSON.added_tokens || [],
              normalizer: tokenizerJSON.normalizer,
              pre_tokenizer: tokenizerJSON.pre_tokenizer,
              post_processor: tokenizerJSON.post_processor,
              unk_token: tokenizerJSON.model?.unk_token || null,
              byte_fallback: !!tokenizerJSON.model?.byte_fallback,
              end_of_word_suffix: tokenizerJSON.model?.end_of_word_suffix,
              continuing_subword_suffix:
                tokenizerJSON.model?.continuing_subword_suffix,
              bos_token: tokenizerConfig?.bos_token,
              eos_token: tokenizerConfig?.eos_token,
              sep_token: tokenizerConfig?.sep_token,
            };

            binBytes = serialize(compiledState);

            // Save binary representation for fast loader access on future runs
            await writeFile(tokenizerBinPath, binBytes);
          } catch (compileErr) {
            if (isEnoentError(compileErr)) {
              throw createError(
                simpleTemplate(a.s.e.c.tc.tokenizerFilesNotFound, {
                  TokenizerName: tokenizerName,
                  JsonPath: tokenizerJsonPath,
                  ConfigPath: tokenizerConfigPath,
                }),
                { code: "ENOENT", cause: compileErr },
              );
            }
            throw compileErr;
          }
        } else {
          throw err;
        }
      }

      const sharedBinaryBuffer = new SharedArrayBuffer(binBytes.byteLength);
      new Uint8Array(sharedBinaryBuffer).set(binBytes);

      return { sharedBinaryBuffer };
    })();

    sharedBufferCache.set(cacheKey, promise);
  }

  return sharedBufferCache.get(cacheKey)!;
}

interface ParallelCountInput {
  text: string;
  text_pair?: string | null;
  options?: { add_special_tokens?: boolean };
}

interface WorkerPayload {
  tokenizerName: string;
  sharedBinaryBuffer: SharedArrayBuffer;
  inputs: ParallelCountInput[];
}

interface WorkerReadyResponse {
  type: "ready";
  memoryUsage: number;
}

interface WorkerSuccessResponse {
  jobId: number;
  results: number[];
  memoryUsage?: number;
}

interface WorkerErrorResponse {
  jobId: number;
  error: { message: string; stack?: string };
}

type WorkerResponse =
  | WorkerReadyResponse
  | WorkerSuccessResponse
  | WorkerErrorResponse;

class TokenWorkerPool {
  private static instance: TokenWorkerPool;
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private taskCallbacks = new Map<
    number,
    { resolve: (value: number[]) => void; reject: (reason?: unknown) => void }
  >();
  private workerToJob = new Map<Worker, number>();
  private requestQueue: Array<{
    resolve: (worker: Worker) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private nextJobId = 0;
  private isInitialized = false;
  private isShuttingDown = false;
  private calibrationPromise: Promise<void> | null = null;

  private workerFactory: (() => Worker) | null = null;

  private maxMemoryPerWorker: number = 50 * 1024 * 1024;
  private readonly HARD_MAX_WORKERS = Math.min(cpus().length, 16);

  private initParams?: {
    tokenizerName: string;
    sharedBinaryBuffer: SharedArrayBuffer;
  };

  private constructor() {}

  public static getInstance(): TokenWorkerPool {
    if (!TokenWorkerPool.instance) {
      TokenWorkerPool.instance = new TokenWorkerPool();
    }
    return TokenWorkerPool.instance;
  }

  public get currentTargetPoolSize() {
    return this.calculateTargetPoolSize();
  }

  private calculateTargetPoolSize(): number {
    const currentWorkerRam = this.workers.length * this.maxMemoryPerWorker;

    const totalFreeIfNoWorkers = freemem() + currentWorkerRam;
    const systemTotalRam = totalmem();

    const systemReserved = Math.max(1024 * 1024 * 1024, systemTotalRam * 0.2);
    let budget = totalFreeIfNoWorkers - systemReserved;

    budget = Math.min(budget, systemTotalRam * 0.5);

    if (budget < this.maxMemoryPerWorker) {
      return 1;
    }

    const safePool = Math.floor(budget / this.maxMemoryPerWorker);
    return Math.max(1, Math.min(this.HARD_MAX_WORKERS, safePool));
  }

  // oxlint-disable-next-line require-await
  public async initialize(tokenizerName: string): Promise<void> {
    if (this.isInitialized || this.isShuttingDown) return;
    if (this.calibrationPromise) return this.calibrationPromise;

    this.calibrationPromise = (async () => {
      const buffers = await getSerializedSharedBuffers(tokenizerName);
      this.initParams = { tokenizerName, ...buffers };

      const compiledSeaActive = isSea();
      if (compiledSeaActive) {
        const workerCode = (await resolveAsset(
          "tokenworker.js",
          "utf8",
        )) as string;
        this.workerFactory = () => new Worker(workerCode, { eval: true });
      } else {
        this.workerFactory = () =>
          new Worker(new URL("./worker/tokenworker.js", import.meta.url));
      }

      const estimatedJsonOverhead = buffers.sharedBinaryBuffer.byteLength * 6;
      this.maxMemoryPerWorker = Math.max(
        estimatedJsonOverhead,
        60 * 1024 * 1024,
      );

      this.isInitialized = true;
      this.calibrationPromise = null;
    })();

    return this.calibrationPromise;
  }

  private createWorker(): Worker {
    if (!this.workerFactory) {
      throw new Error("Cannot spawn worker: Pool factory was not initialized.");
    }
    const worker = this.workerFactory();
    this.attachWorkerHandlers(worker);
    return worker;
  }

  private attachWorkerHandlers(worker: Worker) {
    worker.on("message", (data: WorkerResponse) => {
      if (!("jobId" in data)) return;

      const { jobId } = data;
      const callbacks = this.taskCallbacks.get(jobId);
      if (callbacks) {
        if ("results" in data) {
          if (data.memoryUsage) {
            this.maxMemoryPerWorker = Math.max(
              this.maxMemoryPerWorker,
              data.memoryUsage,
            );
          }
          callbacks.resolve(data.results);
        } else if ("error" in data) {
          const error = new Error(data.error.message);
          error.stack = data.error.stack;
          callbacks.reject(error);
        }
        this.taskCallbacks.delete(jobId);
        this.workerToJob.delete(worker);
        this.releaseWorker(worker);
      }
    });

    worker.on("exit", (code) => {
      if (code !== 0 && !this.isShuttingDown) {
        const { a } = x;
        this.maxMemoryPerWorker = Math.max(
          this.maxMemoryPerWorker * 1.5,
          128 * 1024 * 1024,
        );
        this.handleWorkerCrash(
          worker,
          createError(
            simpleTemplate(a.s.e.c.tc.workerCrashedCode, { Code: code }),
            { immediateExitCode: false },
          ),
        );
      } else {
        this.removeWorker(worker);
      }
    });

    worker.on("error", (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      this.handleWorkerCrash(worker, error);
    });
  }

  private handleWorkerCrash(worker: Worker, err: Error) {
    const jobId = this.workerToJob.get(worker);
    if (jobId !== undefined) {
      const callbacks = this.taskCallbacks.get(jobId);
      if (callbacks) callbacks.reject(err);
      this.taskCallbacks.delete(jobId);
      this.workerToJob.delete(worker);
    }

    this.removeWorker(worker);
    this.enforcePoolSize();
  }

  private enforcePoolSize() {
    if (this.isShuttingDown) return;
    const target = this.calculateTargetPoolSize();

    while (this.workers.length > target && this.idleWorkers.length > 0) {
      const w = this.idleWorkers.pop()!;
      this.removeWorker(w);
    }
  }

  private acquireWorker(): Promise<Worker> {
    if (this.isShuttingDown) {
      const { a } = x;
      return Promise.reject(
        createError(a.s.e.c.tc.poolShuttingDown, {
          immediateExitCode: false,
        }),
      );
    }

    this.enforcePoolSize();

    if (this.idleWorkers.length > 0) {
      return Promise.resolve(this.idleWorkers.pop()!);
    }

    const target = this.calculateTargetPoolSize();
    if (this.workers.length < target && this.initParams) {
      const worker = this.createWorker();
      worker.postMessage({ type: "init", ...this.initParams });
      this.workers.push(worker);
      return Promise.resolve(worker);
    }

    return new Promise((resolve, reject) => {
      this.requestQueue.push({ resolve, reject });
    });
  }

  private releaseWorker(worker: Worker) {
    if (this.isShuttingDown) {
      this.removeWorker(worker);
      return;
    }

    const targetPoolSize = this.calculateTargetPoolSize();

    if (this.workers.length > targetPoolSize) {
      this.removeWorker(worker);
      this.enforcePoolSize();
      return;
    }

    if (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift()!;
      request.resolve(worker);
    } else {
      this.idleWorkers.push(worker);
    }
  }

  private removeWorker(worker: Worker) {
    void worker.terminate();
    this.workers = this.workers.filter((w) => w !== worker);
    this.idleWorkers = this.idleWorkers.filter((w) => w !== worker);
  }

  public async runJob(payload: WorkerPayload): Promise<number[]> {
    const worker = await this.acquireWorker();
    const jobId = this.nextJobId++;

    this.workerToJob.set(worker, jobId);

    const jobPromise = new Promise<number[]>((resolve, reject) => {
      this.taskCallbacks.set(jobId, { resolve, reject });
    });

    worker.postMessage({ ...payload, jobId, type: "count" });
    return jobPromise;
  }

  public shutdown() {
    this.isShuttingDown = true;
    const { a } = x;
    const shutdownErr = createError(a.s.e.c.tc.poolShuttingDown, {
      immediateExitCode: false,
    });
    for (const request of this.requestQueue) request.reject(shutdownErr);
    this.requestQueue = [];
    this.taskCallbacks.clear();
    this.workerToJob.clear();
    for (const worker of this.workers) void worker.terminate();
    this.workers = [];
    this.idleWorkers = [];
    this.isInitialized = false;
    // @ts-expect-error cleanup
    TokenWorkerPool.instance = undefined;
  }
}

export async function countTokensInParallel(
  tokenizerName: string,
  inputs: ParallelCountInput[],
  options: { numWorkers?: number } = {},
): Promise<number[]> {
  if (tokenizerName === "dummy") {
    return Promise.resolve(
      inputs.map((input) => {
        const { text, text_pair, options: tokOpts } = input;

        const countApproximateTokens = (
          str: string | null | undefined,
        ): number => {
          if (!str) return 0;
          const cjkRegex = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7a3]/g;
          const cjkMatches = str.match(cjkRegex) || [];
          const cjkTokens = cjkMatches.length * 1.5;

          const emojiRegex = /[\p{Emoji}\p{Extended_Pictographic}]/gu;
          const emojiMatches = str.match(emojiRegex) || [];
          const emojiTokens = emojiMatches.length * 2;

          const remainingText = str
            .replace(cjkRegex, "")
            .replace(emojiRegex, "");
          const otherTokens = remainingText.length / 4;

          return Math.ceil(cjkTokens + emojiTokens + otherTokens);
        };

        let tokenCount = countApproximateTokens(text);
        if (text_pair) {
          tokenCount += countApproximateTokens(text_pair);
          tokenCount += 1;
        }
        if (tokOpts?.add_special_tokens) {
          tokenCount += 3;
        }
        return tokenCount;
      }),
    );
  }

  if (inputs.length === 0) return [];

  const pool = TokenWorkerPool.getInstance();
  await pool.initialize(tokenizerName);

  const { sharedBinaryBuffer } =
    await getSerializedSharedBuffers(tokenizerName);

  const currentSafePoolSize = pool.currentTargetPoolSize;

  const maxWorkers = options.numWorkers
    ? Math.min(options.numWorkers, currentSafePoolSize)
    : currentSafePoolSize;

  const activeWorkers = Math.min(maxWorkers, inputs.length);

  const MAX_CHUNK_SIZE = 10000;
  const baseChunkSize = Math.ceil(inputs.length / activeWorkers);
  const chunkSize = Math.min(baseChunkSize, MAX_CHUNK_SIZE);

  const chunks = [];
  for (let i = 0; i < inputs.length; i += chunkSize) {
    chunks.push(inputs.slice(i, i + chunkSize));
  }

  const workerPromises = chunks.map(async (chunk) => {
    let retries = 2;
    while (true) {
      try {
        return await pool.runJob({
          tokenizerName,
          sharedBinaryBuffer,
          inputs: chunk,
        });
      } catch (err) {
        if (retries <= 0) throw err;
        retries--;
        errlog(
          { level: "warn" },
          simpleTemplate(x.a.s.m.c.tc.workerOomRetry, {
            Retries: retries,
          }),
        );
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  });

  const results = await Promise.all(workerPromises);
  return results.flat();
}

export async function countTokens(
  tokenizerName: string,
  textToTokenize: string,
  options: { text_pair?: string | null; add_special_tokens?: boolean } = {},
): Promise<number> {
  const input: ParallelCountInput = {
    text: textToTokenize,
    text_pair: options.text_pair,
    options: { add_special_tokens: options.add_special_tokens },
  };

  const results = await countTokensInParallel(tokenizerName, [input], {
    numWorkers: 1,
  });
  return results[0] ?? 0;
}

export function shutdownTokenCounter() {
  if (TokenWorkerPool["instance"]) {
    TokenWorkerPool.getInstance().shutdown();
  }
}
