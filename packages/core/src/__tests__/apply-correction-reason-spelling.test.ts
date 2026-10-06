import { describe, expect, it } from "vitest";
import { buildCorrectionReason } from "../apply-correction.js";

/**
 * `buildCorrectionReason` の `winner` が、`winnerId` と `correctedId`/`correctingId` の綴り（大文字小文字）が
 * 食い違うときに、実際の勝者に合うこと（ADR 0446 決定3。Issue #1804 の確かめ直しで、変異が素通りした形を塞ぐ）。
 *
 * 約束の出所は `buildCorrectionReason` の TSDoc: 文字列がそのまま一致する側を先に採る。どちらとも一致しないときだけ、
 * 大文字小文字を無視して**どちらか一方だけ**に一致する側を採る。決まらなければ `corrected`。
 * 本物の Postgres に当てる同種の歯は `packages/postgres` 側にあるが、DB が無いと走らないので、純関数であるこの口の
 * 歯は core にも置く。
 */

const discovery = {
  recallId: "recall-1",
  candidates: [],
  omitted: [],
  explain: { stages: [] },
  outcome: "no_candidates",
  recalledCount: 0,
  excludedCount: 0,
} as unknown as Parameters<typeof buildCorrectionReason>[0]["discovery"];

function winnerOf(correctedId: string, correctingId: string, winnerId: string): string {
  const reason = buildCorrectionReason({
    discovery,
    chosenRecallRank: 1,
    correctedId: correctedId as never,
    correctingId: correctingId as never,
    resolution: { kind: "supersede", winnerId: winnerId as never },
  });
  const m = /winner=(\S+)$/.exec(reason);
  if (m === null) throw new Error(`winner が読めない: ${reason}`);
  return m[1]!;
}

describe("buildCorrectionReason — winnerId の綴りが違っても、実際の勝者の側を書く", () => {
  it.each([
    ["訂正する側の大文字", "abc-1", "def-2", "DEF-2", "correcting"],
    ["訂正される側の大文字", "abc-1", "def-2", "ABC-1", "corrected"],
    ["訂正する側が大文字で、winnerId が小文字", "abc-1", "DEF-2", "def-2", "correcting"],
    ["どちらとも合わない", "abc-1", "def-2", "zzz-9", "corrected"],
    [
      "訂正する側の前方一致だけ（大文字小文字を無視しても同じ id ではない）",
      "abc-1",
      "def-2",
      "DEF",
      "corrected",
    ],
    ["訂正される側の前方一致だけ", "abc-1", "def-2", "ABC", "corrected"],
  ])("%s", (_name, corrected, correcting, winner, expected) => {
    expect(winnerOf(corrected, correcting, winner)).toBe(expected);
  });

  it("2つの id が大文字小文字だけ違うとき、文字列がそのまま一致する側を採る（どちらの順でも）", () => {
    expect(winnerOf("abc-x", "ABC-X", "ABC-X")).toBe("correcting");
    expect(winnerOf("abc-x", "ABC-X", "abc-x")).toBe("corrected");
    expect(winnerOf("ABC-X", "abc-x", "abc-x")).toBe("correcting");
    expect(winnerOf("ABC-X", "abc-x", "ABC-X")).toBe("corrected");
  });

  it("2つの id が大文字小文字だけ違い、winnerId がどちらとも文字列では一致しないときは、決められないので corrected", () => {
    expect(winnerOf("abc-x", "ABC-X", "Abc-X")).toBe("corrected");
    expect(winnerOf("ABC-X", "abc-x", "Abc-X")).toBe("corrected");
  });
});
