import { describe, expect, it } from "vitest";
import { decideAnnTruncation } from "../ann-truncation.js";
import { defaultScoringStrategy } from "../strategies/scoring.js";

// 全文一致では固定しない（言い回しを直せなくなる）。見るのは、利用者が「どの値域が前提か」「誰が守るか」「どこから先は前提のままか」を読み取れる語が入っているかだけ。

function strengthAssumption(): string {
  const verdict = decideAnnTruncation({
    strategy: defaultScoringStrategy,
    queryTags: [],
    scoreThreshold: 0.1,
    lastAnnSimilarity: 0.5,
    lastReturnedTotal: 0.2,
  });
  if (verdict.kind === "undecidable") throw new Error("unreachable");
  const found = verdict.assumptions.find((a) => a.startsWith("strength <= 1:"));
  expect(
    found,
    "strength の前提が `strength <= 1:` で始まる文字列として名乗られていない",
  ).toBeDefined();
  return found as string;
}

describe("ann_truncated の strength の前提の文字列", () => {
  it("値域 (0, 1] と、それを決めた ADR 0078 を名指す", () => {
    const text = strengthAssumption();
    expect(text).toContain("(0, 1]");
    expect(text).toContain("ADR 0078");
  });

  it("同梱の実装が書き込み時に拒むこと（Postgres の CHECK・testkit の検査）を言う", () => {
    const text = strengthAssumption();
    expect(text).toContain("書き込み時に拒む");
    expect(text).toContain("CHECK");
    expect(text).toContain("createMemory");
  });

  it("型は保証せず、適合テストを通していない adapter では前提のままだと言う", () => {
    const text = strengthAssumption();
    expect(text).toContain("型（number）は保証しない");
    expect(text).toContain("適合テストを通していない adapter では前提のまま");
  });

  it("同梱の実装についてはもう事実でない旧い言い方（書き込み側が 1 を書くだけ・DB 列も保証しない）に戻らない", () => {
    const text = strengthAssumption();
    expect(text).not.toContain("DB 列（real）も保証していない");
    expect(text).not.toContain("無条件に 1 を書いている");
  });
});
