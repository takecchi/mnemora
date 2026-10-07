import { describe, expect, it } from "vitest";
import { describeFailure } from "../failure-description.js";

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
