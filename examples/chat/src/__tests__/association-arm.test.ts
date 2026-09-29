import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeAssociationEnabled } from "../association-arm.js";

/**
 * `computeAssociationEnabled`（Issue #291 フォローアップ、ADR 0385 §7 が見つけた表示
 * バグの修正、2026-09-30）の歯。DB もネットワークも要らない（純関数）。
 *
 * ⭐ **この歯が固定しているもの**: `off` arm は `recall()` へ `association: null` を
 * **明示的に**渡す（`association-arm.ts` の `runAssociationArm` 本体のコメント参照、
 * ADR 0337 後の規律）。`associationEnabled` はこの `null` も `undefined` も
 * 「連想枠を渡していない＝off」として扱わなければならない——もとの実装
 * （`association !== undefined`）は `null !== undefined` が `true` になるため、
 * `off` arm でも `associationEnabled: true` になっていた。
 *
 * ⚠ **`runAssociationArm` 本体（`options.runtime`/`options.memoryStore` を要求する、
 * 実質 Postgres が要る重い経路）は、この歯では実行しない**（`docs/autonomy.md` の
 * `initdb` 手順が要り、この判定だけを固定するには重すぎる）。代わりに:
 *
 * 1. `computeAssociationEnabled` を直接呼んで判定そのものを固定する（この describe）。
 * 2. `runAssociationArm` の `return` 文が実際にこの関数を呼んでいることを、
 *    ソースを直接読んで固定する（下の describe）——呼び出し側が別のロジック
 *    （例: 元の `association !== undefined` へ差し戻す）に差し替わっても検出できるように、
 *    関数単体のテストとは別に置く。
 */
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
