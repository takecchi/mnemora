import { describe, expect, it } from "vitest";
import type { PromptSpec } from "@mnemora/core";
import {
  RETENTION_MUTATION_REPLACEMENT,
  RETENTION_MUTATION_TARGET_SUBSTRING,
  applyRetentionMutation,
} from "../answer-retention-mutation.js";

/**
 * `applyRetentionMutation`（回答評価の陽性対照の変異、Issue #498 完了条件4、PR #700）の単体試験。DB 不要。
 *
 * 再生の歯（`answer-retention-positive-control.postgres.test.ts`）は、対象が見つかる正常な入力でしか
 * この関数を呼ばず、「見つからなければ・`messages` が空なら投げる」（約束2）を見ていなかった
 * （Issue #1776 の #700 のコメント、ADR 0665）。
 */

const TARGET = RETENTION_MUTATION_TARGET_SUBSTRING;

describe("applyRetentionMutation", () => {
  it("対象の部分文字列を含まない PromptSpec では、黙って空振りせず投げる", () => {
    const spec: PromptSpec = {
      system: "s",
      messages: [{ role: "user", content: "対象を含まない本文" }],
    };
    expect(() => applyRetentionMutation(spec)).toThrow(/見つからない/);
  });

  it("messages が空なら、素通しせず投げる", () => {
    expect(() => applyRetentionMutation({ system: "s", messages: [] })).toThrow(/空である/);
  });

  it("成功時: messages[0] から対象が消えて置換文言が入り、system と messages[1..] は変わらない", () => {
    const spec: PromptSpec = {
      system: "system-text",
      messages: [
        { role: "user", content: `前置き ${TARGET} 後ろ` },
        { role: "user", content: `2通目 ${TARGET}` },
      ],
    };
    const mutated = applyRetentionMutation(spec);
    expect(mutated.system).toBe("system-text");
    expect(mutated.messages[0]!.content).toBe(`前置き ${RETENTION_MUTATION_REPLACEMENT} 後ろ`);
    expect(mutated.messages[0]!.content).not.toContain(TARGET);
    expect(mutated.messages[0]!.content).not.toContain("紅茶");
    expect(mutated.messages[1]).toEqual(spec.messages[1]);
    expect(mutated.messages).toHaveLength(2);
  });
});
