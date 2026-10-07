import { describe, expect, it } from "vitest";
import { describeZeroPresented } from "../answer-bench.js";

// 文面の言い回しは固定しない（見ているのは警告が運ぶ情報と、警告を出す条件）。

type Recall = Parameters<typeof describeZeroPresented>[2];

function recallOf(over: Partial<Recall> & { omitted?: unknown[] }): Recall {
  return {
    index: { groups: [], totalInScope: 2, countKind: "exact" },
    memories: [],
    omitted: [],
    ...over,
  } as unknown as Recall;
}

describe("describeZeroPresented: 警告を出す条件", () => {
  it("スコープ内の記憶が 0 件なら、提示が 0 件でも何も言わない（null）", () => {
    const text = describeZeroPresented(
      "t",
      "space",
      recallOf({ index: { groups: [], totalInScope: 0, countKind: "exact" } as never }),
    );
    expect(text).toBeNull();
  });

  it("スコープ内に記憶が在り、提示が 0 件のときは文を返す", () => {
    expect(describeZeroPresented("t", "space", recallOf({}))).not.toBeNull();
  });
});

describe("describeZeroPresented: 警告が運ぶ情報", () => {
  const text = describeZeroPresented(
    "tenant-under-test",
    "space-under-test",
    recallOf({
      index: { groups: [], totalInScope: 7, countKind: "exact" } as never,
    }),
  )!;

  it("tenant・埋め込み空間・スコープ内の件数が文に入る", () => {
    expect(text).toContain("tenant-under-test");
    expect(text).toContain("space-under-test");
    expect(text).toContain("7");
  });

  it("候補は3つ挙がる——別の埋め込み空間の先客・予算/減衰/validAt ゲート・関連度が閾値に届かなかった", () => {
    expect(text).toContain("別の埋め込み空間");
    expect(text).toContain("validAt");
    expect(text).toContain("閾値");
  });

  it("閾値の候補には、答えを控えるべき問いでは正常な姿であることが添えてある", () => {
    expect(text).toContain("正常な姿");
  });

  it("判定ではなく候補の一覧であると名乗り、どれかは決まらないと締める", () => {
    expect(text).toContain("判定ではない");
    expect(text).toContain("候補");
    expect(text).toContain("決まらない");
  });
});

describe("describeZeroPresented: omitted の内訳", () => {
  it("複数の omitted は、出てきた順に「, 」で区切って1行に並ぶ", () => {
    const text = describeZeroPresented(
      "t",
      "space",
      recallOf({
        omitted: [
          { kind: "below_threshold", count: 2, countKind: "exact", nearMisses: [] },
          { kind: "stage_skipped", stage: "association", reason: "no_anchor" },
        ],
      }),
    )!;
    expect(text).toContain("below_threshold×2, stage_skipped(association:no_anchor)");
  });

  it("filtered の omitted は、どの条件で落ちたか（condition）も名指しする", () => {
    const text = describeZeroPresented(
      "t",
      "space",
      recallOf({
        omitted: [
          {
            kind: "filtered",
            condition: "taxonomy",
            scopeRelation: "within_scope",
            count: 3,
            countKind: "exact",
          },
        ],
      }),
    )!;
    expect(text).toContain("filtered(taxonomy)×3");
  });
});
