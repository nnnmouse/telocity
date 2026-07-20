import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import {
  calcAvgLineLength,
  calcAvgLineLengthBytes,
  stripGarbageNewLines,
} from "../../src/libs/LLM/index.ts";
import {
  initTest,
  setupTestEnvironment,
  teardownTestEnvironment,
  type TestEnvironment,
} from "../testutils.ts";

describe("LLM utils (text helpers)", () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    await initTest();
    testEnv = await setupTestEnvironment();
  });

  afterAll(async () => {
    await teardownTestEnvironment(testEnv);
  });

  beforeEach(() => {
    process.env["LC_ALL"] = "en_US.UTF-8";
    process.env["LANG"] = "en_US.UTF-8";
  });

  describe("stripGarbageNewLines", () => {
    test("throws TypeError on non-string/non-array inputs", () => {
      //@ts-expect-error Intentional type error for test
      expect(() => stripGarbageNewLines(123)).toThrow(TypeError);
      //@ts-expect-error Intentional type error for test
      expect(() => stripGarbageNewLines(null)).toThrow(TypeError);
      //@ts-expect-error Intentional type error for test
      expect(() => stripGarbageNewLines({})).toThrow(TypeError);
    });

    test("removes line separators (\\u2028, \\u2029) and preserves base content", () => {
      const src = "Line1\u2028Line2\u2029\nLine3\r\n\n\n";
      const result = stripGarbageNewLines(src, { stripEmpty: false });
      expect(result).toContain("Line1");
      expect(result).toContain("Line2");
      expect(result).toContain("Line3");
      expect(result.split("\n").length).toBeGreaterThanOrEqual(2);
    });

    test("removes zero-width characters, direction marks, and BOM but preserves CJK indentation spacing", () => {
      // Input contains CJK space (\u3000), Left-to-Right Mark (\u200E), Zero-Width Space (\u200B), BOM (\uFEFF), and Right-to-Left Mark (\u200F)
      const src = "　　\u200EHello\u200B\uFEFFWorld\u200F";
      const result = stripGarbageNewLines(src);
      expect(result).toBe("　　HelloWorld");
    });

    test("removes BiDi directional overrides and isolate control characters", () => {
      // BiDi controls: LRE (\u202A), PDF (\u202C), FSI (\u2066), PDI (\u2069)
      const src = "Text\u202Awith\u202CBiDi\u2066controls\u2069";
      const result = stripGarbageNewLines(src);
      expect(result).toBe("TextwithBiDicontrols");
    });

    test("removes raw ASCII control characters while preserving essential tabs and newlines", () => {
      // \u0000 (NULL), \u0007 (BELL), \u007F (DEL) should be stripped
      // \t (\u0009) and \n (\u000A) should remain untouched
      const src = "Line\u00001\twith\u0007tab\nLine\u007F2";
      const result = stripGarbageNewLines(src);
      expect(result).toBe("Line1\twithtab\nLine2");
    });

    test("handles array inputs by joining elements with newlines", () => {
      const input = ["Line 1", "Line 2", "Line 3"];
      expect(stripGarbageNewLines(input)).toBe("Line 1\nLine 2\nLine 3");
    });

    test("preserves empty and whitespace-only lines by default", () => {
      const input = "Line 1\n\n  \nLine 2";
      expect(stripGarbageNewLines(input)).toBe("Line 1\n\n  \nLine 2");
    });

    test("with stripEmpty trims leading/trailing and intermediate empty lines", () => {
      const src = "\n\n  \nAlpha\n\nBeta\n\n  \n";
      const result = stripGarbageNewLines(src, { stripEmpty: true });
      expect(result.split("\n")[0]).toBe("Alpha");
      expect(result.split("\n").slice(-1)[0]).toBe("Beta");

      const input2 = "Line 1\n\n  \nLine 2\n\t\nLine 3";
      const result2 = stripGarbageNewLines(input2, { stripEmpty: true });
      expect(result2).toBe("Line 1\nLine 2\nLine 3");
    });

    test("with markdownBrainRot forces stripEmpty and collapses sequential breaks to double newlines", () => {
      const input = "Line 1\n\n  \nLine 2\nLine 3";
      const result = stripGarbageNewLines(input, { markdownBrainRot: true });
      expect(result).toBe("Line 1\n\nLine 2\n\nLine 3");

      const multiNewlines = "Line 1\n\n\n\nLine 2";
      const collapsed = stripGarbageNewLines(multiNewlines, {
        markdownBrainRot: true,
      });
      expect(collapsed).toBe("Line 1\n\nLine 2");
    });
  });

  describe("calcAvgLineLength & calcAvgLineLengthBytes", () => {
    test("counts graphemes per non-empty line", () => {
      const text = "a\nab\nabc\n";
      const avg = calcAvgLineLength(text);
      expect(typeof avg).toBe("number");
      expect(avg).toBe(2);
    });

    test("returns 0 for empty content or only blank lines", () => {
      expect(calcAvgLineLength("")).toBe(0);
      expect(calcAvgLineLengthBytes("")).toBe(0);
      expect(calcAvgLineLength("\n\n")).toBe(0);
      expect(calcAvgLineLengthBytes("\n\n")).toBe(0);
    });
  });
});
