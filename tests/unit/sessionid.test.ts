import { beforeAll, describe, expect, test } from "vitest";

import { AppStateSingleton } from "../../src/libs/core/index.ts";
import { buildSessionId } from "../../src/libs/LLM/LLMutils.ts";
import { initTest } from "../testutils.ts";

describe("buildSessionId Unit Tests (Character Enforced)", () => {
  let segmenter: Intl.Segmenter;
  let expectedDate: string;

  beforeAll(async () => {
    await initTest();
    segmenter = AppStateSingleton.getInstance().segmenter;

    // Dynamically calculate current date representation to prevent test suite failures across days
    const now = Temporal.Now.zonedDateTimeISO();
    const yyyy = now.year;
    const mm = String(now.month).padStart(2, "0");
    const dd = String(now.day).padStart(2, "0");
    expectedDate = `${yyyy}${mm}${dd}`;
  });

  test("handles basic alphanumeric filename and strips simple extension", () => {
    const result = buildSessionId("test1_source.txt", segmenter);
    expect(result).toBe(`tc_test1_source_${expectedDate}`);
  });

  test("handles directories and double extensions correctly by stripping last extension only", () => {
    const result = buildSessionId(
      "/usr/local/bin/my_data_file.temp.csv",
      segmenter,
    );
    expect(result).toBe(`tc_my_data_filetemp_${expectedDate}`);
  });

  test("sanitizes forbidden symbols, spaces, and punctuation (direct stripping)", () => {
    const result = buildSessionId("file & space!@#_123-[g].txt", segmenter);
    expect(result).toBe(`tc_filespace_123-g_${expectedDate}`);
  });

  test("preserves non-Latin Unicode letters (Chinese, Japanese, Korean)", () => {
    const result = buildSessionId(
      "test_中文_测试_日本語_한국어.txt",
      segmenter,
    );
    expect(result).toBe(`tc_test_中文_测试_日本語_한국어_${expectedDate}`);
  });

  test("strips emojis safely as they are Unicode symbols, not letters/numbers", () => {
    const result = buildSessionId("my_[emoji_🌟]_file.txt", segmenter);
    expect(result).toBe(`tc_my_emoji__file_${expectedDate}`);
  });

  test("truncates filename exactly at 28 JavaScript characters (standard ASCII)", () => {
    const exactly28 = "a".repeat(28);
    const result1 = buildSessionId(`${exactly28}.txt`, segmenter);
    expect(result1).toBe(`tc_${exactly28}_${expectedDate}`);

    const longerThan28 = "a".repeat(50);
    const result2 = buildSessionId(`${longerThan28}.txt`, segmenter);
    expect(result2).toBe(`tc_${exactly28}_${expectedDate}`);
  });

  test("truncates safely at 28-unit boundary without splitting surrogate pairs (boundary check)", () => {
    // "𠮷" is a surrogate pair requiring 2 code units.
    // 27 ASCII characters + "𠮷" (2 units) = 29 units total.
    // The surrogate pair must be omitted entirely to avoid malformed surrogate truncation.
    const prefix27 = "a".repeat(27);
    const result = buildSessionId(`${prefix27}𠮷.txt`, segmenter);
    expect(result).toBe(`tc_${prefix27}_${expectedDate}`);
  });

  test("appends surrogate pairs if they fit exactly at the 28-unit boundary", () => {
    // "𠮷" is a surrogate pair requiring 2 code units.
    // 26 ASCII characters + "𠮷" (2 units) = 28 units total.
    // This fits the boundary limit exactly and should be appended.
    const prefix26 = "a".repeat(26);
    const result = buildSessionId(`${prefix26}𠮷.txt`, segmenter);
    expect(result).toBe(`tc_${prefix26}𠮷_${expectedDate}`);
  });

  test("handles filenames containing only invalid characters gracefully", () => {
    const result = buildSessionId("@#$!@#$.txt", segmenter);
    expect(result).toBe(`tc__${expectedDate}`);
  });

  test("thorough stress test of 28-character limit using high-volume CJK inputs", () => {
    // Generates a sequence exceeding the 28-character cap.
    const highVolumeCJK = "测试".repeat(25);
    const result = buildSessionId(`${highVolumeCJK}.txt`, segmenter);

    // Assert that the output limits itself perfectly to 28 characters (14 CJK characters)
    const expectedCJKFragment = "测试".repeat(14);
    expect(result).toBe(`tc_${expectedCJKFragment}_${expectedDate}`);

    // Strictly verify the sliced payload size to guarantee we match exactly 28 UTF-16 units
    const fragment = result.slice(3, -9); // Strip prefix ("tc_") and suffix ("_YYYYMMDD")
    expect(fragment.length).toBe(28);
  });
});
