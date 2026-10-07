import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeAssociationEnabled } from "../association-arm.js";

// runAssociationArm 本体は Postgres が要って重いので、ここでは実行しない。代わりに、return 文がこの関数を呼ぶことをソースの文字列で固定する。
describe("computeAssociationEnabled", () => {
  it("null(off arm が明示的に渡す値)なら false", () => {
    expect(computeAssociationEnabled(null)).toBe(false);
  });

  it("{ maxCount } を渡せば true", () => {
    expect(computeAssociationEnabled({ maxCount: 3 })).toBe(true);
    expect(computeAssociationEnabled({ maxCount: 10 })).toBe(true);
  });

  it("🔴 undefined でも false(もとの実装が `!== undefined` だったため、この入力でも安全であることを明示的に固定する)", () => {
    expect(computeAssociationEnabled(undefined as never)).toBe(false);
  });
});

describe("runAssociationArm の配線(Issue #291 フォローアップ)", () => {
  const sourcePath = fileURLToPath(new URL("../association-arm.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf8");

  it("🔴 associationEnabled の値が computeAssociationEnabled(association) から来ている(inline の `!== undefined` へ差し戻っていない)", () => {
    expect(source).toContain("associationEnabled: computeAssociationEnabled(association)");
    expect(source).not.toContain("associationEnabled: association !== undefined");
  });
});
