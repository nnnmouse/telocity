import type { TLSSocket } from "node:tls";

import * as http from "node:http";
import * as http2 from "node:http2";
import * as https from "node:https";
import { Readable } from "node:stream";
import * as tls from "node:tls";

import { errlog, isNodeError } from "../core/index.ts";
import { type INetworkContext } from "../types/index.ts";

function isConnectionResetError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = isNodeError(err) ? err.code : undefined;
    const cause = err.cause;
    const causeCode = isNodeError(cause) ? cause.code : undefined;
    const causeMessage = cause instanceof Error ? cause.message : "";
    const message = err.message;

    const finalCode = code || causeCode;

    return (
      finalCode === "ECONNRESET" ||
      finalCode === "EPIPE" ||
      finalCode === "ECONNREFUSED" ||
      message.includes("socket hang up") ||
      causeMessage.includes("socket hang up") ||
      message.includes("connection reset") ||
      causeMessage.includes("connection reset")
    );
  }
  return false;
}

class WebResponseAdapter {
  public static fromNodeStream(
    stream: Readable | http2.ClientHttp2Stream,
    statusCode: number,
    headersGetter: (name: string) => string | null,
  ): Response {
    const pseudoResponse = {
      ok: statusCode >= 200 && statusCode < 300,
      status: statusCode,
      headers: {
        get: headersGetter,
      },
      text: async () => {
        const chunks: Buffer[] = [];
        try {
          for await (const chunk of stream) {
            chunks.push(chunk as Buffer);
          }
        } catch (err) {
          // Wrap network errors exactly how Undici does
          const typeErr = new TypeError("fetch failed");
          typeErr.cause = err;
          throw typeErr;
        }
        return Buffer.concat(chunks).toString("utf-8");
      },
      json: async () => {
        const txt = await pseudoResponse.text();
        return JSON.parse(txt);
      },
      body: {
        getReader: () =>
          Readable.toWeb(stream as unknown as Readable).getReader(),
      },
    };

    return pseudoResponse as unknown as Response;
  }
}

export class NetworkContext implements INetworkContext {
  public readonly httpAgent: http.Agent;
  public readonly httpsAgent: https.Agent;
  public readonly h2Sessions = new Map<string, http2.ClientHttp2Session>();
  public readonly h2IdleTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  public readonly h2ActiveRequests = new Map<string, number>();
  public readonly protocolCache = new Map<string, "h2" | "http/1.1">();
  public readonly pendingProbes = new Map<string, Promise<"h2" | "http/1.1">>();
  public readonly activeProbeSockets = new Set<TLSSocket>();
  public readonly probeSafetyTimers = new Set<ReturnType<typeof setTimeout>>();
  public readonly establishedSockets = new Map<string, TLSSocket>();
  private destroyed = false;

  constructor() {
    this.httpAgent = new http.Agent({
      keepAlive: true,
      timeout: 15000,
      keepAliveMsecs: 1000,
    });
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      timeout: 15000,
      keepAliveMsecs: 1000,
    });
  }

  public static async run<T>(
    fn: (ctx: NetworkContext) => Promise<T>,
  ): Promise<T> {
    const ctx = new NetworkContext();
    try {
      return await fn(ctx);
    } finally {
      await ctx.shutdown();
    }
  }

  public evictHost(authority: string): void {
    this.protocolCache.delete(authority);
    this.pendingProbes.delete(authority);

    const socket = this.establishedSockets.get(authority);
    if (socket) {
      if (!socket.destroyed) socket.destroy();
      this.establishedSockets.delete(authority);
    }

    const session = this.h2Sessions.get(authority);
    if (session) {
      if (!session.destroyed) session.destroy();
      this.h2Sessions.delete(authority);
    }

    const timer = this.h2IdleTimers.get(authority);
    if (timer) {
      clearTimeout(timer);
      this.h2IdleTimers.delete(authority);
    }
    this.h2ActiveRequests.delete(authority);
  }

  public async shutdown(): Promise<void> {
    if (this.destroyed) return;

    const promises: Promise<void>[] = [];

    // Gracefully shut down HTTP/2 sessions (sends GOAWAY frame)
    for (const [authority, session] of this.h2Sessions.entries()) {
      if (!session.destroyed && !session.closed) {
        promises.push(
          new Promise<void>((resolve) => {
            session.close(resolve);
          }),
        );
      }
      this.h2Sessions.delete(authority);
      const timer = this.h2IdleTimers.get(authority);
      if (timer) {
        clearTimeout(timer);
        this.h2IdleTimers.delete(authority);
      }
    }

    // Gracefully end established TCP/TLS sockets (sends TCP FIN)
    for (const [authority, socket] of this.establishedSockets.entries()) {
      if (!socket.destroyed) {
        socket.end();
      }
      this.establishedSockets.delete(authority);
    }

    // Clean up probe-safety timers
    for (const timer of this.probeSafetyTimers) {
      clearTimeout(timer);
    }
    this.probeSafetyTimers.clear();

    // End active probe sockets cleanly
    for (const socket of this.activeProbeSockets) {
      if (!socket.destroyed) socket.end();
    }
    this.activeProbeSockets.clear();

    // Await graceful drainage with a hard 1-second timeout
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, 1000);
    });

    await Promise.race([Promise.allSettled(promises), timeoutPromise]);

    // Explicitly clear the fallback timer if we resolved early
    if (timeoutId) clearTimeout(timeoutId);

    this.destroy();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.httpAgent.destroy();
    this.httpsAgent.destroy();

    for (const timer of this.h2IdleTimers.values()) {
      clearTimeout(timer);
    }
    this.h2IdleTimers.clear();

    for (const timer of this.probeSafetyTimers) {
      clearTimeout(timer);
    }
    this.probeSafetyTimers.clear();

    for (const socket of this.activeProbeSockets) {
      socket.destroy();
    }
    this.activeProbeSockets.clear();

    for (const socket of this.establishedSockets.values()) {
      socket.destroy();
    }
    this.establishedSockets.clear();

    for (const session of this.h2Sessions.values()) {
      if (!session.destroyed) session.destroy();
    }
    this.h2Sessions.clear();
    this.h2ActiveRequests.clear();
    this.protocolCache.clear();
    this.pendingProbes.clear();
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }
}

// Lazy-initialized fallback context for one-off utility calls outside of jobs
let globalFallbackContext: NetworkContext | null = null;
export function getGlobalFallbackContext(): NetworkContext {
  if (!globalFallbackContext) {
    globalFallbackContext = new NetworkContext();
  }
  return globalFallbackContext;
}

export function destroyFallbackGlobalContext(): void {
  if (globalFallbackContext) {
    globalFallbackContext.destroy();
    globalFallbackContext = null;
  }
}

// Performs a TLS ALPN protocol check on first request to verify HTTP/2 support.
function probeProtocol(
  parsedUrl: URL,
  ctx: INetworkContext,
  options?: { allowH2?: boolean },
): Promise<"h2" | "http/1.1"> {
  const authority = parsedUrl.host;

  if (ctx.protocolCache.has(authority)) {
    return Promise.resolve(ctx.protocolCache.get(authority)!);
  }

  if (ctx.pendingProbes.has(authority)) {
    return ctx.pendingProbes.get(authority)!;
  }

  const allowH2 = options?.allowH2 ?? true;
  if (!allowH2) {
    ctx.protocolCache.set(authority, "http/1.1");
    return Promise.resolve("http/1.1");
  }

  if (parsedUrl.protocol !== "https:") {
    ctx.protocolCache.set(authority, "http/1.1");
    return Promise.resolve("http/1.1");
  }

  // Prevent opening untracked sockets or performing redundant TLS handshakes on a destroyed context.
  if (ctx.isDestroyed()) {
    return Promise.resolve("http/1.1");
  }

  const promise = new Promise<"h2" | "http/1.1">((resolve) => {
    const [host, portStr] = authority.split(":");
    const port = portStr ? parseInt(portStr, 10) : 443;

    const socket = tls.connect({
      host,
      port,
      servername: host,
      ALPNProtocols: ["h2", "http/1.1"],
    });

    ctx.activeProbeSockets.add(socket);

    let resolved = false;

    function finish(result: "h2" | "http/1.1", socketToKeep?: TLSSocket) {
      clearTimeout(connectionTimeoutTimer);
      ctx.activeProbeSockets.delete(socket);

      if (resolved) return;
      resolved = true;

      if (socketToKeep && !ctx.isDestroyed()) {
        // Cache the socket for immediate reuse
        const estSockets = ctx.establishedSockets;
        estSockets.set(authority, socketToKeep);

        const safetyTimer = setTimeout(() => {
          ctx.probeSafetyTimers.delete(safetyTimer);
          const currentCached = estSockets.get(authority);
          if (currentCached === socketToKeep) {
            estSockets.delete(authority);
            socketToKeep.destroy();
          }
        }, 500);

        ctx.probeSafetyTimers.add(safetyTimer);

        if (typeof safetyTimer.unref === "function") {
          safetyTimer.unref();
        }
      } else {
        socket.destroy();
      }
      resolve(result);
    }

    const connectionTimeoutTimer = setTimeout(() => {
      finish("http/1.1");
    }, 5000);

    if (typeof connectionTimeoutTimer.unref === "function") {
      connectionTimeoutTimer.unref();
    }

    socket.setTimeout(5000);

    socket.once("secureConnect", () => {
      const negotiated = socket.alpnProtocol === "h2" ? "h2" : "http/1.1";

      if (negotiated === "h2") {
        finish("h2", socket);
      } else {
        finish("http/1.1");
      }
    });

    socket.once("error", () => finish("http/1.1"));
    socket.once("timeout", () => finish("http/1.1"));
    socket.once("close", () => finish("http/1.1"));
  });

  ctx.pendingProbes.set(authority, promise);

  promise.then((proto) => {
    if (ctx.isDestroyed()) return;
    ctx.protocolCache.set(authority, proto);
    ctx.pendingProbes.delete(authority);
  });

  return promise;
}

// Gets or creates a pooled and multiplexed ClientHttp2Session.
function getOrCreateH2Session(
  authority: string,
  protocol: string,
  ctx: INetworkContext,
): http2.ClientHttp2Session {
  let session = ctx.h2Sessions.get(authority);
  if (!session || session.destroyed || session.closed) {
    const existingSocket = ctx.establishedSockets?.get(authority);
    if (existingSocket) {
      ctx.establishedSockets.delete(authority);
      session = http2.connect(`${protocol}//${authority}`, {
        createConnection: () => existingSocket,
      });
    } else {
      session = http2.connect(`${protocol}//${authority}`);
    }

    // Default to unreferenced; ref-state is toggled on-demand during requests
    session.unref();

    const activeSession = session;
    session.on("error", () => activeSession.destroy());
    session.on("goaway", () => {
      ctx.h2Sessions.delete(authority);
    });
    session.on("close", () => {
      ctx.h2Sessions.delete(authority);
      const timer = ctx.h2IdleTimers.get(authority);
      if (timer) {
        clearTimeout(timer);
        ctx.h2IdleTimers.delete(authority);
      }
    });
    ctx.h2Sessions.set(authority, session);
  }
  return session;
}

class Http2ClientEngine {
  private readonly ctx: INetworkContext;

  constructor(ctx: INetworkContext) {
    this.ctx = ctx;
  }

  public execute(
    parsedUrl: URL,
    method: string,
    headers: Record<string, string>,
    bodyPayload: Buffer | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const authority = parsedUrl.host;
    const protocol = parsedUrl.protocol;

    return new Promise<Response>((resolve, reject) => {
      let session: http2.ClientHttp2Session;
      let isResolved = false;

      const handleH2Error = (err: unknown) => {
        if (isResolved) return;
        isResolved = true;
        this.ctx.evictHost(authority);
        const typeErr = new TypeError("fetch failed");
        typeErr.cause = err;
        reject(typeErr);
      };

      try {
        session = getOrCreateH2Session(authority, protocol, this.ctx);
      } catch (err) {
        handleH2Error(err);
        return;
      }

      const activeCount = this.ctx.h2ActiveRequests.get(authority) || 0;
      this.ctx.h2ActiveRequests.set(authority, activeCount + 1);
      session.ref();

      const idleTimer = this.ctx.h2IdleTimers.get(authority);
      if (idleTimer) {
        clearTimeout(idleTimer);
        this.ctx.h2IdleTimers.delete(authority);
      }

      const h2Headers: Record<string, string> = {
        ":method": method,
        ":path": parsedUrl.pathname + parsedUrl.search,
        ":scheme": protocol.replace(":", ""),
        ":authority": authority,
      };

      for (const [key, val] of Object.entries(headers)) {
        const lowerKey = key.toLowerCase();
        // Filter forbidden HTTP/2 connection-specific headers
        if (
          lowerKey === "connection" ||
          lowerKey === "keep-alive" ||
          lowerKey === "proxy-connection" ||
          lowerKey === "transfer-encoding" ||
          lowerKey === "upgrade"
        ) {
          continue;
        }
        h2Headers[lowerKey] = val;
      }

      const decrementAndCleanup = () => {
        const currentCount = this.ctx.h2ActiveRequests.get(authority) || 0;
        const nextCount = Math.max(0, currentCount - 1);

        if (nextCount === 0) {
          this.ctx.h2ActiveRequests.delete(authority);
          const activeSession = this.ctx.h2Sessions.get(authority);
          if (activeSession) {
            activeSession.unref();
          }

          const cleanupTimer = setTimeout(() => {
            const activeSessionToClose = this.ctx.h2Sessions.get(authority);
            if (activeSessionToClose) {
              activeSessionToClose.close();
              this.ctx.h2Sessions.delete(authority);
            }
            this.ctx.h2IdleTimers.delete(authority);
          }, 5000);

          cleanupTimer.unref();
          this.ctx.h2IdleTimers.set(authority, cleanupTimer);
        } else {
          this.ctx.h2ActiveRequests.set(authority, nextCount);
        }
      };

      let stream: http2.ClientHttp2Stream;
      try {
        stream = session.request(h2Headers, { endStream: !bodyPayload });
      } catch (err) {
        decrementAndCleanup();
        handleH2Error(err);
        return;
      }

      stream.once("close", decrementAndCleanup);

      if (signal) {
        if (signal.aborted) {
          stream.destroy();
          isResolved = true;
          return reject(signal.reason);
        }
        const onAbort = () => {
          stream.destroy();
          if (!isResolved) {
            isResolved = true;
            reject(signal.reason);
          }
        };
        signal.addEventListener("abort", onAbort);
        stream.once("close", () => {
          signal.removeEventListener("abort", onAbort);
        });
      }

      // Resolving the promise on 'response' headers transitions the lifecycle out of the
      // pre-response phase, preventing any subsequent stream/body errors from rejecting the engine promise.
      stream.on("response", (headersResponse) => {
        if (isResolved) return;
        isResolved = true;

        let statusCode = 200;
        const statusVal = headersResponse[":status"];
        if (typeof statusVal === "number") {
          statusCode = statusVal;
        } else if (typeof statusVal === "string") {
          statusCode = parseInt(statusVal, 10);
        }

        const response = WebResponseAdapter.fromNodeStream(
          stream,
          statusCode,
          (name: string): string | null => {
            const val = headersResponse[name.toLowerCase()];
            if (Array.isArray(val)) return val.join(", ");
            if (typeof val === "string") return val;
            if (typeof val === "number") return String(val);
            return null;
          },
        );

        resolve(response);
      });

      stream.on("error", (err) => {
        if (isResolved) return;
        // Don't wrap AbortErrors, pass them directly so signal cancellation works
        if (err.name === "AbortError" || signal?.aborted) {
          isResolved = true;
          return reject(err);
        }
        handleH2Error(err);
      });

      if (bodyPayload) {
        try {
          stream.end(bodyPayload);
        } catch (err) {
          stream.destroy();
          handleH2Error(err);
        }
      }
    });
  }
}

class Http1ClientEngine {
  private readonly ctx: INetworkContext;

  constructor(ctx: INetworkContext) {
    this.ctx = ctx;
  }

  public execute(
    parsedUrl: URL,
    method: string,
    headers: Record<string, string>,
    bodyPayload: Buffer | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const isHttp = parsedUrl.protocol === "http:";
    const reqModule = isHttp ? http : https;

    return new Promise<Response>((resolve, reject) => {
      const req = reqModule.request(
        parsedUrl,
        {
          method,
          headers,
          signal,
          agent: isHttp ? this.ctx.httpAgent : this.ctx.httpsAgent,
        },
        (res) => {
          const response = WebResponseAdapter.fromNodeStream(
            res,
            res.statusCode || 500,
            (name: string): string | null => {
              const val = res.headers[name.toLowerCase()];
              if (Array.isArray(val)) return val.join(", ");
              if (typeof val === "string") return val;
              return null;
            },
          );
          resolve(response);
        },
      );

      req.on("error", (err) => {
        // Don't wrap AbortErrors, pass them directly so signal cancellation works
        if (err.name === "AbortError") {
          return reject(err);
        }

        const typeErr = new TypeError("fetch failed");
        typeErr.cause = err;
        reject(typeErr);
      });

      if (bodyPayload) {
        req.write(bodyPayload);
      }

      req.end();
    });
  }
}

export async function llmFetch(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    networkContext?: INetworkContext;
    disableTransparentRetry?: boolean;
    _attempt?: number; // Internal tracking to prevent infinite retry loops
    allowH2?: boolean;
  },
): Promise<Response> {
  const attempt = options._attempt ?? 0;
  const parsedUrl = new URL(url);
  const ctx = options.networkContext || getGlobalFallbackContext();

  if (ctx.isDestroyed()) {
    const typeErr = new TypeError("fetch failed");
    typeErr.cause = new Error("NetworkContext is destroyed");
    return Promise.reject(typeErr);
  }

  const mergedHeaders = { ...options.headers };
  let bodyPayload: Buffer | undefined;

  if (options.body) {
    bodyPayload = Buffer.from(options.body, "utf-8");
    mergedHeaders["Content-Length"] = bodyPayload.length.toString();
  }

  const method = options.method || "POST";
  let negotiatedProtocol: "h2" | "http/1.1" | undefined;

  // Any error thrown inside this block represents a pre-response failure (e.g., connection reset,
  // negotiation timeout, or H2 stream error prior to header receipt). The engine promises
  // resolve immediately upon receiving headers; post-header failures will occur during body consumption.
  try {
    negotiatedProtocol = await probeProtocol(parsedUrl, ctx, {
      allowH2: options.allowH2,
    });

    if (negotiatedProtocol === "h2") {
      const h2Engine = new Http2ClientEngine(ctx);
      return await h2Engine.execute(
        parsedUrl,
        method,
        mergedHeaders,
        bodyPayload,
        options.signal,
      );
    } else {
      const h1Engine = new Http1ClientEngine(ctx);
      return await h1Engine.execute(
        parsedUrl,
        method,
        mergedHeaders,
        bodyPayload,
        options.signal,
      );
    }
  } catch (err) {
    const isAborted =
      options.signal?.aborted ||
      (err instanceof Error && err.name === "AbortError") ||
      (err instanceof Error && err.message.includes("aborted"));

    if (!options.disableTransparentRetry && !isAborted && attempt < 1) {
      const isRetryable =
        negotiatedProtocol === "h2" || isConnectionResetError(err);

      if (isRetryable) {
        ctx.evictHost(parsedUrl.host);
        if (process.env["DEBUG"] || process.env["VERBOSE"]) {
          errlog(
            { level: "warn" },
            `Transient network disconnect on initial ${negotiatedProtocol ?? "unknown"} connection to host: ${parsedUrl.host}. Safe retry triggered.`,
          );
        }
        return llmFetch(url, { ...options, _attempt: attempt + 1 });
      }
    }

    throw err;
  }
}
