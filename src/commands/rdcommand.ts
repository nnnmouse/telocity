import dgram from "node:dgram";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import type { Command } from "../libs/types/index.ts";

import {
  createError,
  errlog,
  fastHash,
  generateHelpText,
  isErrCo,
  log,
  customParseArgs as parseArgs,
  simpleTemplate,
  x,
} from "../libs/core/index.ts";
import {
  stripGarbageNewLines,
  validateFiles,
  isJsonl,
  extractText,
  stripMarkdownFormatting,
} from "../libs/LLM/index.ts";
import {
  preprocessPaginator,
  txtBookPaginator,
} from "../libs/paginatedreader/paginatedreader.ts";

export default class RdCommand implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "file" as const;
  }
  static get options() {
    return {
      port: { type: "string", short: "p", default: "33636" },
      help: { type: "boolean", short: "h" },
    } as const;
  }

  async execute(argv: string[]): Promise<number> {
    const { a } = x;
    const Cmd = this.constructor as typeof RdCommand;

    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: Cmd.allowPositionals,
      strict: true,
      options: Cmd.options,
    });

    const avgHelp = () => {
      const helpText = generateHelpText(a.s.help.commands.rd, Cmd.options);
      log(helpText);
    };

    if (values.help) {
      avgHelp();
      return 0;
    }

    let sourcePath: string | null = null;
    let cleaned = "";
    let hasActiveBook = false;

    if (positionals[1]) {
      sourcePath = path.resolve(positionals[1]);
      await validateFiles(sourcePath);

      const rawText = await readFile(sourcePath, "utf-8");
      let textToRead = rawText;

      if (isJsonl(rawText)) {
        textToRead = extractText(rawText);
      }

      textToRead = stripMarkdownFormatting(textToRead);
      cleaned = stripGarbageNewLines(textToRead, { stripEmpty: true });
      hasActiveBook = true;

      log(a.s.m.c.rd.ebookLoaded);
    } else {
      log(a.s.m.c.rd.libraryModeLoaded);
    }

    const localIp = await new Promise<string>((resolve) => {
      const socket = dgram.createSocket("udp4");
      socket.unref();

      const fallbackTimer = setTimeout(() => {
        socket.close();
        resolve("localhost");
      }, 1000);
      fallbackTimer.unref();

      socket.on("error", () => {
        clearTimeout(fallbackTimer);
        socket.close();
        resolve("localhost");
      });

      socket.connect(53, "192.0.2.0", () => {
        clearTimeout(fallbackTimer);
        const ip = socket.address().address;
        socket.close();
        resolve(ip);
      });
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      if (url.pathname === "/") {
        const headers: Record<string, string> = {
          "Content-Type": "text/html; charset=utf-8",
        };

        txtBookPaginator({
          pageData: a.s.m.c.rd,
          isCli: true,
          hasActiveBook,
        })
          .then((rawTemplate) => {
            res.writeHead(200, headers);
            const processedHtml = preprocessPaginator(rawTemplate);
            res.end(processedHtml);
          })
          .catch((err) => {
            res.writeHead(500);
            res.end(String(err));
          });

        return;
      }

      if (url.pathname === "/api/current") {
        try {
          if (!hasActiveBook || !sourcePath) {
            res.writeHead(200, {
              "Content-Type": "application/json; charset=utf-8",
            });
            res.end(JSON.stringify({ active: false }));
            return;
          }

          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
          });

          res.end(
            JSON.stringify({
              bookId: fastHash(sourcePath),
              title: path.basename(sourcePath),
              content: cleaned,
            }),
          );
        } catch (err) {
          res.writeHead(500);
          res.end(String(err));
        }
        return;
      }

      if (url.pathname === "/favicon.ico") {
        res.writeHead(200, {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=3600",
        });
        res.end(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><style>path { fill: none; stroke: #1f1f1f; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; } @media (prefers-color-scheme: dark) { path { stroke: #f8f8f2; } }</style><path d="M12 21c-1.12-1.37-2.91-2-5.5-2H2v-14h4.5c2.11 0 3.89.63 5.5 2 1.61-1.37 3.39-2 5.5-2H22v14h-4.5c-2.59 0-4.38.63-5.5 2z"/></svg>`,
        );
        return;
      }

      res.writeHead(404);
      res.end(a.s.m.c.rd.notFound);
    });

    const getRandomSafePort = () =>
      Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152;

    const portsToTry = [
      parseInt(values.port),
      getRandomSafePort(),
      getRandomSafePort(),
      getRandomSafePort(),
    ];
    let currentPortIndex = 0;

    const startServer = (): Promise<void> => {
      return new Promise((resolve, reject) => {
        const attemptListen = () => {
          server.removeAllListeners("listening");
          server.removeAllListeners("error");

          const port = portsToTry[currentPortIndex];

          server.once("error", (err: unknown) => {
            if (isErrCo(err, "EADDRINUSE")) {
              currentPortIndex++;
              if (currentPortIndex < portsToTry.length) {
                log(
                  simpleTemplate(a.s.m.c.rd.portInUse, {
                    Port: String(port),
                    NextPort: String(portsToTry[currentPortIndex]),
                  }),
                );
                attemptListen();
              } else {
                cleanupAndReject(
                  createError(a.s.e.c.rd.noPortAvailable, {
                    code: "NO_PORT_AVAILABLE",
                  }),
                );
              }
            } else {
              cleanupAndReject(err);
            }
          });

          server.once("listening", () => {
            const address = server.address();
            const actualPort =
              typeof address === "object" && address ? address.port : port;

            const queryParam = hasActiveBook ? "?cli=true" : "";
            log(
              simpleTemplate(a.s.m.c.rd.serverRunningAt, {
                url: `http://${localIp}:${actualPort}/${queryParam} or http://localhost:${actualPort}/${queryParam}`,
              }),
            );

            if (sourcePath) {
              log(simpleTemplate(a.s.m.c.rd.readingFile, { sourcePath }));
            }

            log(a.s.m.c.rd.instructions);

            server.removeAllListeners("error");

            server.on("error", (runtimeErr: unknown) => {
              const errMessage =
                runtimeErr instanceof Error
                  ? runtimeErr.message
                  : String(runtimeErr);
              errlog(
                simpleTemplate(a.s.e.c.rd.unkServError, { Unk: errMessage }),
              );
              server.close();
            });

            resolve();
          });

          server.listen(port, "0.0.0.0");
        };

        const cleanupAndReject = (err: unknown) => {
          server.removeAllListeners("listening");
          server.removeAllListeners("error");
          server.close();
          reject(err);
        };

        attemptListen();
      });
    };

    await startServer();

    return 0;
  }
}
