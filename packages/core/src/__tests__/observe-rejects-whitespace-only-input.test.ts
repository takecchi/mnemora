import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { ObserveInputSchema } from "../observation.js";

const FIELDS: Array<[string, (value: string) => unknown, string]> = [
  ["utterance.text", (value) => ({ kind: "utterance", text: value }), "text"],
  ["event.name", (value) => ({ kind: "event", name: value }), "name"],
  ["document.content", (value) => ({ kind: "document", content: value }), "content"],
];

const BLANKS: Array<[string, string]> = [
  ["半角空白", "   "],
  ["改行", "\n\n"],
  ["タブ", "\t"],
  ["CRLF", "\r\n"],
  ["垂直タブ・改ページ", "\v\f"],
  ["U+3000（全角空白）", "　"],
  ["U+00A0（NBSP）", " "],
  ["U+FEFF（BOM）", "\uFEFF"],
  ["U+2028・U+2029（行・段落区切り）", "\u2028\u2029"],
  ["U+2003（EM SPACE）", " "],
  ["種類の混在", " \t\n　 "],
];

const issuesOf = (input: unknown) => {
  const result = ObserveInputSchema.safeParse(input);
  return result.success ? null : result.error;
};

describe.each(FIELDS)("%s", (_field, build, key) => {
  it.each(BLANKS)("trim して空になる値（%s）は ZodError で断る", (_name, value) => {
    const error = issuesOf(build(value));
    expect(error).toBeInstanceOf(ZodError);
    expect(error!.issues).toHaveLength(1);
    expect(error!.issues[0]!.path).toEqual([key]);
  });

  it("エラーの path・message は、空文字の min(1) と同じ形", () => {
    const empty = issuesOf(build(""))!.issues[0]!;
    const blank = issuesOf(build("   "))!.issues[0]!;
    expect(blank.path).toEqual(empty.path);
    expect(blank.message).toBe(empty.message);
  });

  it.each([
    ["前後に空白のある普通の文", "  hello  "],
    ["前後に改行・全角空白", "\n　hello　\n"],
    ["内側に空白のある文", "a b\tc\nd"],
    ["1文字", "a"],
    ["全角空白で挟んだ1文字", "　a　"],
    ["U+200B（ZERO WIDTH SPACE。trim は落とさない）", "\u200B"],
  ])("通す: %s", (_name, value) => {
    expect(issuesOf(build(value))).toBeNull();
  });
});

describe("範囲の外（今回は変えない）", () => {
  it("document.title・utterance.speaker が空白だけでも通る（ADR 0502）", () => {
    expect(
      issuesOf({ kind: "document", content: "c", title: "   ", extractTitle: true }),
    ).toBeNull();
    expect(issuesOf({ kind: "utterance", text: "t", speaker: "  " })).toBeNull();
  });
});
