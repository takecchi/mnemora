import { describe, expect, it } from "vitest";
import type { Observation } from "../observation.js";
import { observationPayloadText } from "../observation-text.js";

/**
 * `extractTitle: true` のとき、`title` は「空でない文字列のときだけ」本文の前置きになる
 * （`Observation.title` の TSDoc）。`String.prototype.trim` で空になる値（空白・改行・タブ・U+3000 など。
 * ADR 0502 が `content` 等の「空白」と定めたのと同じ定義）だけの `title` は空とみなし、前置きにしない
 * （断るのではなく、無視する。ADR 0517）。
 */

function documentObservation(payload: Record<string, unknown>): Observation {
  return {
    id: "obs-1",
    tenantId: "t",
    kind: "document",
    payload,
    recordedAt: new Date(0),
  } as unknown as Observation;
}

const BLANKS: Array<[string, string]> = [
  ["空文字", ""],
  ["半角空白", "   "],
  ["改行", "\n\n"],
  ["タブ", "\t"],
  ["U+3000（全角空白）", "　"],
  ["U+00A0（NBSP）", " "],
  ["垂直タブ（\\v）", "\v"],
  ["改ページ（\\f）", "\f"],
  ["U+FEFF（BOM）", "﻿"],
  ["種類の混在", " \t\n　 \v\f﻿ "],
];

describe("observationPayloadText: 空白だけの title は前置きにしない（ADR 0517）", () => {
  it.each(BLANKS)("前置きにしない: %s", (_name, title) => {
    const text = observationPayloadText(
      documentObservation({ title, content: "C", extractTitle: true }),
    );
    expect(text).toBe("C");
  });

  it("空白だけの title で content が空なら、既定の分岐（JSON）へ流れる（title を本文にしない）", () => {
    const text = observationPayloadText(
      documentObservation({ title: "  ", content: "", extractTitle: true }),
    );
    expect(text).not.toContain("  \n\n");
    expect(text.trim()).not.toBe("");
  });

  it("実質のある title は前置きになり、前後の空白もそのまま残る（trim して使わない）", () => {
    expect(
      observationPayloadText(documentObservation({ title: "T", content: "C", extractTitle: true })),
    ).toBe("T\n\nC");
    expect(
      observationPayloadText(
        documentObservation({ title: " T ", content: "C", extractTitle: true }),
      ),
    ).toBe(" T \n\nC");
  });

  it("content が空で title に実質があるとき、title は trim されずそのまま返る", () => {
    expect(
      observationPayloadText(
        documentObservation({ title: " T ", content: "", extractTitle: true }),
      ),
    ).toBe(" T ");
  });

  it("前置きの経路で、content の前後の空白は削られない", () => {
    expect(
      observationPayloadText(
        documentObservation({ title: "T", content: "  C  ", extractTitle: true }),
      ),
    ).toBe("T\n\n  C  ");
  });

  it("範囲外（今は変えない）: event の name は空白だけでも前置きになりうる", () => {
    const text = observationPayloadText({
      id: "obs-1",
      tenantId: "t",
      kind: "event",
      payload: { name: "  ", data: { a: 1 }, extractData: true },
      recordedAt: new Date(0),
    } as unknown as Observation);
    expect(text).toBe('  \n\n{"a":1}');
  });

  // `title` が空でない「文字列」のときだけ前置きになる。文字列でない値を文字列に直して使わない。
  const NON_STRING_TITLES: Array<[string, unknown]> = [
    ["数", 42],
    ["null", null],
    ["未定義", undefined],
    ["真偽値", true],
    ["配列", ["T"]],
    ["オブジェクト", { t: "T" }],
  ];

  it.each(NON_STRING_TITLES)("文字列でない title（%s）は前置きにしない", (_name, title) => {
    expect(
      observationPayloadText(documentObservation({ title, content: "C", extractTitle: true })),
    ).toBe("C");
  });

  it("extractTitle が無ければ、title は今までどおり本文に入らない", () => {
    expect(observationPayloadText(documentObservation({ title: "T", content: "C" }))).toBe("C");
  });
});
