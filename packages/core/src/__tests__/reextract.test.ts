import { describe, expect, it } from "vitest";
import { classifySupersedeFailure } from "../strategies/reextract.js";
import { MemoryStatusConflictError } from "../interfaces/memory-store.js";

/**
 * `classifySupersedeFailure`（ADR 0030、安全弁3）の純関数テスト。
 *
 * `reextract` が `updateStatus(..., { expectedStatus: "active" })` に投げられた例外を
 * どう仕分けるかがこの関数の全責務——DB を持たないここで直接変異を撃てる
 * （`decay.test.ts`・`scoring.test.ts` と同じ「純関数の戦略」）。
 *
 * **⚠ ここが芯である**: 競合でない例外を skip に化けさせて飲み込むと、
 * TOCTOU の穴を別の場所に開け直すことになる（`reextract.ts` の doc コメント参照）。
 * だから「`MemoryStatusConflictError` → skip」「それ以外 → null（呼び出し側が再送出）」の
 * 2つを両方とも歯にする。
 */
describe("classifySupersedeFailure", () => {
  it("MemoryStatusConflictError を skip（status_changed_concurrently）に変換し、observedStatus を運ぶ", () => {
    const error = new MemoryStatusConflictError("mem-1", "active", "forgotten");
    const result = classifySupersedeFailure("mem-1", error);
    expect(result).toEqual({
      kind: "status_changed_concurrently",
      memoryId: "mem-1",
      observedStatus: "forgotten",
    });
  });

  it("MemoryStatusConflictError の observedStatus が null（読み直したら行が消えていた）でもそのまま運ぶ", () => {
    const error = new MemoryStatusConflictError("mem-2", "active", null);
    const result = classifySupersedeFailure("mem-2", error);
    expect(result).toEqual({
      kind: "status_changed_concurrently",
      memoryId: "mem-2",
      observedStatus: null,
    });
  });

  it("⚠ ただの Error に対しては null を返す（競合でない例外を skip に化けさせて飲み込まない）", () => {
    const result = classifySupersedeFailure("mem-3", new Error("connection reset"));
    expect(result).toBeNull();
  });

  it("Error 以外の値（想定外の throw）に対しても null を返す", () => {
    expect(classifySupersedeFailure("mem-4", "not an error")).toBeNull();
    expect(classifySupersedeFailure("mem-5", undefined)).toBeNull();
  });
});
