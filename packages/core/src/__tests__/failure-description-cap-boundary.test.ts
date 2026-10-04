import { describe, expect, it } from "vitest";
import { describeFailure } from "../failure-description.js";

/**
 * `describeFailure` の長さの上限（4096）の境目そのもの。約束の出所: `capDescribeJobFailureLength` の TSDoc
 * （「上限を超えたら…切り、末尾に…印を付ける」）と ADR 0470 の PR 本文（「`N`（UTF-16 の長さ）、上限は変えない」）。
 * 上限ちょうどの長さは切らず（印も付けず）、1字でも超えたときだけ切って印を付ける。
 * `failure-description-grapheme-cut.test.ts` は上限を大きく超えた入力と、書記素の途中に境目が落ちる入力を縛る。
 */
const MAX = 4096;
const MARK = /… \(truncated by mnemora, original length (\d+) chars\)$/;
const describeText = (text: string) => describeFailure(new Error(text));

describe("describeFailure: 上限（4096）ちょうどは切らず、1字超えたら切って印を付ける", () => {
  it("上限ちょうどの長さは、そのまま返す（印を付けない）", () => {
    const text = "a".repeat(MAX);
    expect(describeText(text)).toBe(text);
  });

  it("上限を1字超えたら、上限の長さで切って、元の長さを印に載せる", () => {
    const text = "a".repeat(MAX + 1);
    const out = describeText(text);
    expect(Number(MARK.exec(out)?.[1])).toBe(MAX + 1);
    expect(out.replace(MARK, "")).toBe("a".repeat(MAX));
  });
});
