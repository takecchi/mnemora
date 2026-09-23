import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compareRequiredStatusChecks,
  contextsFromProtection,
  formatComparisonReport,
} from "../check-required-status-checks-lib.mjs";

/**
 * `scripts/check-required-status-checks-lib.mjs` の純関数の歯。
 *
 * ⚠ このファイルはネットワークにも `gh` にも触れない。本物の branch protection と
 * 一致しているかは `pnpm check:required-status-checks` の仕事であり（ADR 0279）、
 * **ここで測るのは突き合わせの判定ロジックだけである。**
 *
 * 🔴 4つを必ず固定する（依頼の要求。ADR 0279「決めたこと」）:
 * 1. 宣言と protection が一致 → match
 * 2. 1本ずれている → mismatch（不足・余分・文字違いの3形）
 * 3. protection が読めない → undetermined（match へ倒れない）
 * 4. 宣言の contexts が空のとき、素通りしない（真空で真にならない）
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** 本物の `gh api .../branches/main/protection` と同じ形（`required_status_checks` の下に
 * `contexts` と `checks` の両方を持つ）。 */
function protectionWith(names, checkNames = names) {
  return {
    required_status_checks: {
      strict: false,
      contexts: names,
      checks: checkNames.map((context) => ({ context, app_id: 15368 })),
    },
  };
}

describe(".github/required-status-checks.json の形", () => {
  const declaration = JSON.parse(
    readFileSync(join(ROOT, ".github/required-status-checks.json"), "utf8"),
  );

  it("contexts が文字列の配列である", () => {
    expect(Array.isArray(declaration.contexts)).toBe(true);
    for (const name of declaration.contexts) {
      expect(typeof name).toBe("string");
    }
  });

  it("いまの main の6本と一致する（ずれたら次に読む人が観測できるよう、このファイル自身が腐る合図になる）", () => {
    expect(declaration.contexts).toHaveLength(6);
  });

  it("observedAt を持ち、有効な日時である", () => {
    expect(typeof declaration.observedAt).toBe("string");
    expect(Number.isNaN(Date.parse(declaration.observedAt))).toBe(false);
  });

  it("note が「これは宣言であって設定ではない」という趣旨を含む", () => {
    expect(declaration.note).toContain("宣言であって設定ではない");
  });
});

describe("contextsFromProtection: protection の応答から required contexts を取り出す", () => {
  it("contexts と checks が揃っていれば取り出せる（ソート済みで返る）", () => {
    expect(contextsFromProtection(protectionWith(["b", "a"]))).toEqual({
      names: ["a", "b"],
      disagreement: null,
    });
  });

  it("contexts と checks が食い違っていたら、その食い違い自体を報告する", () => {
    const result = contextsFromProtection(protectionWith(["a"], ["a", "b"]));
    expect(result.names).toEqual(["a", "b"]);
    expect(result.disagreement).toEqual({ contexts: ["a"], checks: ["a", "b"] });
  });

  it("required_status_checks が無ければ null（＝読めなかった）を返す", () => {
    expect(contextsFromProtection({})).toBeNull();
    expect(contextsFromProtection(null)).toBeNull();
    expect(contextsFromProtection("not-an-object")).toBeNull();
  });

  it("required が空配列でも null にはしない（空は空という別の事実である）", () => {
    expect(contextsFromProtection(protectionWith([]))).toEqual({ names: [], disagreement: null });
  });
});

describe("compareRequiredStatusChecks: 4つの固定ケース", () => {
  it("【1】宣言と protection が一致 → match（exit 0 に対応）", () => {
    const result = compareRequiredStatusChecks(
      ["a", "b", "c"],
      contextsFromProtection(protectionWith(["c", "b", "a"])),
    );
    expect(result.verdict).toBe("match");
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(formatComparisonReport(result)).toContain("一致（match）");
  });

  describe("【2】1本ずれている → mismatch（exit 1 に対応）——不足・余分・文字違いの3形", () => {
    it("不足: protection に無いものが宣言に在る", () => {
      const result = compareRequiredStatusChecks(
        ["a", "b", "c"],
        contextsFromProtection(protectionWith(["a", "b"])),
      );
      expect(result.verdict).toBe("mismatch");
      expect(result.missing).toEqual(["c"]);
      expect(result.extra).toEqual([]);
      const text = formatComparisonReport(result);
      expect(text).toContain("不一致（mismatch）");
      expect(text).toContain("宣言に在って protection に無い: c");
    });

    it("余分: protection に在るものが宣言に無い", () => {
      const result = compareRequiredStatusChecks(
        ["a", "b"],
        contextsFromProtection(protectionWith(["a", "b", "c"])),
      );
      expect(result.verdict).toBe("mismatch");
      expect(result.missing).toEqual([]);
      expect(result.extra).toEqual(["c"]);
      expect(formatComparisonReport(result)).toContain("protection に在って宣言に無い: c");
    });

    it("文字違い: 1文字でも違えば別の文字列として不足・余分の両方に現れる", () => {
      const result = compareRequiredStatusChecks(
        ["a", "b", "typecheck / lint / test / build"],
        contextsFromProtection(protectionWith(["a", "b", "typecheck / lint / test / buld"])),
      );
      expect(result.verdict).toBe("mismatch");
      expect(result.missing).toEqual(["typecheck / lint / test / build"]);
      expect(result.extra).toEqual(["typecheck / lint / test / buld"]);
    });

    it("contexts と checks の食い違いだけでも mismatch になる（不足・余分が両方空でも）", () => {
      const result = compareRequiredStatusChecks(
        ["a", "b"],
        contextsFromProtection(protectionWith(["a", "b"], ["a", "b", "c"])),
      );
      expect(result.verdict).toBe("mismatch");
      expect(result.missing).toEqual([]);
      // "c" は checks 側にしか無いので names には含まれ、extra として出る。
      expect(result.extra).toEqual(["c"]);
      expect(result.disagreement).not.toBeNull();
      const text = formatComparisonReport(result);
      expect(text).toContain("contexts と checks が食い違っている");
    });
  });

  it("【3】protection が読めない → undetermined（exit 2 に対応）。match へ倒れない", () => {
    const result = compareRequiredStatusChecks(["a", "b"], null);
    expect(result.verdict).toBe("undetermined");
    expect(result.verdict).not.toBe("match");
    const text = formatComparisonReport(result);
    expect(text).toContain("保留（undetermined）");
    expect(text).toContain("これは「ずれていない」ではない");
    // ⚠ 素の "match" や "一致" を含めないこと —— 保留の文言が偶然にも
    // 「一致」を含んでいたら、雑な substring 判定で緑と誤認されうる。
    expect(text).not.toContain("一致（match）");
  });

  describe("【4】宣言の contexts が空のとき、素通りしない（真空で真にならない）", () => {
    it("宣言が空 + protection も空 → 両方向の集合一致では match に見えてしまう組み合わせでも mismatch", () => {
      const result = compareRequiredStatusChecks([], contextsFromProtection(protectionWith([])));
      // 素の両方向集合比較（missing/extra 双方が空）だけを見ると "match" に化ける
      // はずの入力——これが緑にならないことを固定する。
      expect(result.missing).toEqual([]);
      expect(result.extra).toEqual([]);
      expect(result.verdict).toBe("mismatch");
      expect(result.reason).toContain("宣言");
      expect(result.reason).toContain("空");
    });

    it("宣言が空 + protection が非空 → mismatch（extra 経由でも塞がるが、明示的な理由で止める）", () => {
      const result = compareRequiredStatusChecks(
        [],
        contextsFromProtection(protectionWith(["a", "b"])),
      );
      expect(result.verdict).toBe("mismatch");
    });

    it("宣言が空 + protection が読めない(null) → mismatch を優先する（undetermined ではない）", () => {
      // 宣言そのものが壊れているときは、protection が読めるかどうかを問う前に
      // 「宣言が壊れている」ことを名乗る——空の宣言を undetermined の陰に隠さない。
      const result = compareRequiredStatusChecks([], null);
      expect(result.verdict).toBe("mismatch");
      expect(result.verdict).not.toBe("match");
    });

    it("formatComparisonReport は空の宣言を「（空）」と明示する", () => {
      const result = compareRequiredStatusChecks([], contextsFromProtection(protectionWith([])));
      const text = formatComparisonReport(result);
      expect(text).toContain("不一致（mismatch）");
      expect(text).toContain("（空）");
    });
  });
});

describe("formatComparisonReport: 赤の意味が文そのものに書いてある", () => {
  it("mismatch の文は、どちらが正しいかを決めつけず「人間が決めること」と言う", () => {
    const result = compareRequiredStatusChecks(
      ["a", "b"],
      contextsFromProtection(protectionWith(["a"])),
    );
    const text = formatComparisonReport(result);
    expect(text).toContain("どちらが正しいかは、この道具には決められない");
    expect(text).toContain("どちらを直すかは人間が決めること");
    expect(text).toContain(".github/required-status-checks.json");
    expect(text).toContain("branch protection");
  });
});
