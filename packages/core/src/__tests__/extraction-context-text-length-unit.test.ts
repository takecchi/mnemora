import { describe, expect, it } from "vitest";
import { ExtractionContextSchema } from "../observation.js";

/** 数える単位はコードポイント（UTF-16 のコード単位・書記素・バイトではない）。zod の `max` の今の振る舞いを縛る。 */
const accepts = (text: string) =>
  ExtractionContextSchema.safeParse({ messages: [{ text }] }).success;

describe("messages[].text の max(2000) はコードポイントで数える", () => {
  it.each([
    ["ASCII", "a", 1],
    ["サロゲートペアの絵文字（コード単位2）", "😀", 1],
    ["結合文字つき（2コードポイント・1書記素）", "é", 2],
    ["ZWJ 絵文字（5コードポイント・1書記素）", "👨‍👩‍👧", 5],
    ["孤立サロゲート", "\ud800", 1],
  ])("%s", (_name, unit, codePoints) => {
    const fits = Math.floor(2000 / codePoints);
    expect(accepts(unit.repeat(fits))).toBe(true);
    expect(accepts(unit.repeat(fits + 1))).toBe(false);
  });

  it("speaker の max(200) も同じ単位", () => {
    const speaker = (value: string) =>
      ExtractionContextSchema.safeParse({ messages: [{ text: "t", speaker: value }] }).success;
    expect(speaker("😀".repeat(200))).toBe(true);
    expect(speaker("😀".repeat(201))).toBe(false);
  });
});
