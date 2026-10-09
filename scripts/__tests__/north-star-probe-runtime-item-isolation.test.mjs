import { describe, expect, it } from "vitest";
import { runItemSafe } from "../north-star-probe-runtime.mjs";

/** `north-star-probe-runtime.mjs` 冒頭の「例外を外へ投げない（1項目の失敗が他の項目を止めない）」を、1項目の単位で固定する。 */
describe("runItemSafe: 1項目の失敗を外へ投げず、印字の失敗として返す", () => {
  it("観測が投げても reject せず、その項目を print-failed として返す", async () => {
    const result = await runItemSafe(
      2,
      async () => {
        throw new Error("観測の途中で壊れた");
      },
      {},
      () => "",
    );
    expect(result.item).toBe(2);
    expect(result.mode).toBe("print-failed");
    expect(result.fact).toContain("観測の途中で壊れた");
  });

  it("観測が通れば measured として fact をそのまま返す", async () => {
    const result = await runItemSafe(
      5,
      async () => ({ fact: "観測した事実" }),
      {},
      () => "",
    );
    expect(result).toEqual({ item: 5, mode: "measured", fact: "観測した事実" });
  });
});
