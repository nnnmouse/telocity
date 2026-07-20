import { describe, expect, test } from "vitest";

import { main } from "../../src/main.ts";
import { withCapturedConsole } from "../testutils.ts";

describe("TcCommand", () => {
  test("TcCommand should count tokens for deepseek", async () => {
    const originalIsTTY = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
      });
      const output = await withCapturedConsole(async () => {
        await main(
          ["tc", "--params", "deepseek", "./tests/data/tokens.jsonl"],
          false,
        );
      });
      expect(output).toContain("6556");
      expect(output).toContain("1639");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalIsTTY,
        writable: true,
      });
    }
  });
});
