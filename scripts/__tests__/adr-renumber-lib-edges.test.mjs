import { describe, expect, it } from "vitest";
import {
  addedLineNumbers,
  findUnrewrittenAdrReferences,
  pickNextFreeNumber,
  planRenumbering,
  renumberedReferenceWarning,
  rewriteReferencesInText,
} from "../adr-renumber-lib.mjs";

describe("pickNextFreeNumber は集合の中の最大値の次を返す（入力の並びに依らない）", () => {
  it("降順に並んだ入力でも、最大値の次を返す", () => {
    expect(pickNextFreeNumber(["0009", "0002"])).toBe("0010");
  });

  it("既存の欠番は埋めに行かない", () => {
    expect(pickNextFreeNumber(["0003", "0001"])).toBe("0004");
  });
});

describe("planRenumbering は、衝突していない新規 ADR の番号を横取りしない", () => {
  it("衝突した ADR の新番号は、同じブランチが名乗っている衝突しない番号を避ける", () => {
    const plan = planRenumbering(
      ["0001", "0002"],
      [{ filename: "0001-dup.md" }, { filename: "0003-free.md" }],
    );
    const dup = plan.find((p) => p.oldFilename === "0001-dup.md");
    const free = plan.find((p) => p.oldFilename === "0003-free.md");
    expect(free).toMatchObject({ renamed: false, newNumber: "0003" });
    expect(dup).toMatchObject({ renamed: true, newNumber: "0004" });
  });
});

describe("rewriteReferencesInText は、桁の長い数字の途中を旧番号と取り違えない", () => {
  it("`10146-slug` のような長い数字列の末尾は書き換えない", () => {
    const { text } = rewriteReferencesInText("10146-recall-x と 0146-recall-x", [
      { oldNumber: "0146", newNumber: "0150", slug: "recall-x" },
    ]);
    expect(text).toBe("10146-recall-x と 0150-recall-x");
  });
});

describe("findUnrewrittenAdrReferences は連なりの2番目以降だけを報告する", () => {
  it("1番目（`ADR ` の直後）は、書き換えが届く位置なので報告しない", () => {
    expect(
      findUnrewrittenAdrReferences("ADR 0270 / 0271", [{ oldNumber: "0270", newNumber: "0275" }]),
    ).toEqual([]);
  });

  it("2番目の旧番号は報告する", () => {
    expect(
      findUnrewrittenAdrReferences("ADR 0270 / 0271", [{ oldNumber: "0271", newNumber: "0275" }]),
    ).toEqual([{ oldNumber: "0271", match: "ADR 0270 / 0271" }]);
  });
});

describe("renumberedReferenceWarning は PR タイトルだけでなく本文も名指しする（Issue #405・ADR 0200）", () => {
  it("1行目の説明が、タイトルと本文の両方を機械が直せないと言う", () => {
    const warning = renumberedReferenceWarning([{ oldNumber: "0001", newNumber: "0003" }]);
    const lines = warning.split("\n");
    expect(lines[0]).toContain("ADR 0001 -> ADR 0003");
    expect(lines[1]).toContain("PR タイトルと本文");
    expect(lines[1]).toContain("タイトルと本文の両方");
  });
});

describe("addedLineNumbers の行番号の数え方", () => {
  it("`++` で始まる内容の追加行（diff では `+++...`）も、追加行として数える", () => {
    expect([...addedLineNumbers("@@ -1,0 +1,2 @@\n+++x\n+y")].sort()).toEqual([1, 2]);
  });

  it("削除行は新ファイル側の行番号を進めない", () => {
    expect([...addedLineNumbers("@@ -3,2 +3,1 @@\n-a\n-b\n+c")]).toEqual([3]);
  });

  it("コンテキスト行が混じっても（`--unified=0` でない入力でも）行番号は進める", () => {
    expect([...addedLineNumbers("@@ -1,3 +1,3 @@\n a\n-b\n+c\n d")]).toEqual([2]);
  });
});
