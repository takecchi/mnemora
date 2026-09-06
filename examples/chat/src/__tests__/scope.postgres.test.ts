import { afterAll, describe, expect, it } from "vitest";
import { checkScopeDemo, runScopeDemo } from "../scope.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `examples/chat/src/scope.ts` の歯——`tenantId`/`subjectId` のスコープが
 * 「動く例」として実際に成立していることを、本物の Postgres に対して検査する。
 *
 * provider は `@mnemora/testkit` の決定的な擬似実装(`createExampleRuntime` に
 * `env: {}` を渡し、`OPENAI_API_KEY` の有無に関わらず deterministic モードを強制する。
 * `mnemora-path.postgres.test.ts` と同じ規約)。DB は擬似物で代替しない。
 *
 * **⚠ 何を検査していて、何を検査していないか:**
 *
 * - 検査している: 「他 subject の記憶が返らない」「他 tenant の記憶が返らない」
 *   「subjectId を省略すると対象が広がる」という、スコープの**構造**に関する性質。
 *   これらは擬似 embedding の意味的な弱さに依存しない——スコープの絞り込みは
 *   `recall()` が候補を集める段(`aggregateScope`/ANN 検索の WHERE 句)で
 *   tenantId/subjectId の一致だけを見ており、similarity の値には依存しないため、
 *   `DeterministicEmbeddingProvider` が意味を理解していなくても決定的に成り立つ。
 * - 検査していない: 「意味的に関連する記憶が正しく上位に来るか」(順位・スコアの質)。
 *   `scope.ts` は alice/bob それぞれ1件しか記憶を作らないため順位を測る対象が無く、
 *   そもそも問うていない。これは `retrieval`/`retrieval-quality.ts` が担う領域であり
 *   (examples/chat/README.md「`retrieval`」節)、このファイルはそこには触れない。
 * - alice/bob 双方の観測が実際に embed され、ANN の候補になれていること自体は
 *   `runScopeDemo` 内の `drainEmbedTicks` に依存する。この歯は「embed が終わっている」
 *   ことを前提にしており(`mnemora-path.postgres.test.ts` と同様)、embed が
 *   間に合っていないケース(`not_indexed: pending`)は別の歯の領分。
 */
describe("examples/chat: scope（tenantId/subjectId、本物の Postgres）", () => {
  it("subjectId を指定すると、他 subject の記憶は返らない", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      expect(handle.mode).toBe("deterministic");
      const result = await runScopeDemo(
        handle.runtime,
        "example-chat-scope-test",
        "example-chat-scope-test-other",
      );
      const check = checkScopeDemo(result);

      // 前提: aliceOnly が空でないこと（そもそも何も返らなければ「bobが含まれない」は無意味な緑）。
      expect(result.aliceOnly.memories.length).toBeGreaterThan(0);

      expect(check.aliceOnlyHasAlice).toBe(true);
      expect(check.aliceOnlyExcludesBob).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("subjectId を省略すると、テナント内の全 subject（alice・bob 両方）が対象になる", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const result = await runScopeDemo(
        handle.runtime,
        "example-chat-scope-test-wide",
        "example-chat-scope-test-wide-other",
      );
      const check = checkScopeDemo(result);

      expect(check.tenantWideHasAlice).toBe(true);
      expect(check.tenantWideHasBob).toBe(true);
      // subjectId を省略した方が、alice 単独より対象が広い（狭くなってはいない）ことを
      // 件数でも確認する。
      expect(result.tenantWide.memories.length).toBeGreaterThanOrEqual(
        result.aliceOnly.memories.length,
      );
    } finally {
      await handle.close();
    }
  });

  it("別テナントで recall すると、元のテナントの記憶は1件も返らない", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const result = await runScopeDemo(
        handle.runtime,
        "example-chat-scope-test-tenant",
        "example-chat-scope-test-tenant-other",
      );
      const check = checkScopeDemo(result);

      // 前提: 元のテナント側には実際に記憶が作られていること
      // （作られていなければ「別テナントで0件」は無意味な緑になる）。
      expect(result.tenantWide.memories.length).toBeGreaterThan(0);

      expect(result.otherTenant.memories.length).toBe(0);
      expect(check.otherTenantIsEmpty).toBe(true);
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});
