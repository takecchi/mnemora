import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { maybeAnalyzeAfterUpsert } from "../embedding-statistics.js";
import { maybeAnalyzeMemoriesAfterWrite } from "../memories-statistics.js";
import { closeTestClient, getTestClient, TEST_EMBEDDING_SPACE } from "./test-db.js";

/**
 * `memories-statistics.ts` の書き込み累計と `embedding-statistics.ts` の upsert 累計は、プロセスローカルなモジュール最上位の状態である。`isolate: false` では同じ worker の全ファイルで共有されるので、setupFiles（ファイルごとに走る）が 0 へ戻さないと、前のファイルの書き込みが次のファイルへ持ち越される。
 * この歯は同じ形の2つのファイル（`-a`・`-b`）に置く。どちらも、ファイルの始まりに累計を1回だけ進め、その値が 1（= 始まりは 0）であることを見て、戻さずに終わる。リセットが無いと、同じ worker で2番目に走ったほうが 2 以上を見て赤くなる（別の worker に分かれたときは緑のままなので、変異試験は `--maxWorkers=1` で見る）。
 * 始まりの値は `beforeAll` で凍結する（`--sequence.shuffle` で `it` の順が変わっても、他の `it` に左右されない）。
 */
export function defineProcessCounterStartsAtZero(): void {
  describe("プロセス内の書き込み累計は、ファイルの始まりでは 0（setup-reset-process-counters.ts。ADR 0397）", () => {
    let memoriesCount = -1;
    let embeddingCount = -1;

    beforeAll(async () => {
      const { db } = await getTestClient();
      memoriesCount = (await maybeAnalyzeMemoriesAfterWrite(db)).count;
      embeddingCount = (await maybeAnalyzeAfterUpsert(db, TEST_EMBEDDING_SPACE)).count;
    });

    afterAll(async () => {
      // 累計は**戻さない**（次のファイルがリセットされているかを見るため）。
      await closeTestClient();
    });

    it("memories の書き込み累計は、ファイルの始まりで 0（1回進めて 1）", () => {
      expect(memoriesCount).toBe(1);
    });

    it("埋め込み表の upsert 累計は、ファイルの始まりで 0（1回進めて 1）", () => {
      expect(embeddingCount).toBe(1);
    });
  });
}
