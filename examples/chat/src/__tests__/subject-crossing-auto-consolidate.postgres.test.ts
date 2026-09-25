import { afterAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@mnemora/postgres";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * Issue #579 / ADR 0316: `tick()` の `consolidate` ジョブハンドラ（`processConsolidateJob`、
 * `packages/core/src/runtime.ts`）は、種の `subjectId` を `ctx.subjectId` に置いてから
 * `consolidate()` を呼ぶ——`tick()` はジョブを subject で絞って claim できないため、
 * `ctx.subjectId`（呼び手が `tick()` に渡した値）と種の `subjectId` の食い違いが、subject を
 * またぐ統合（統合後の `Memory.subjectId` が `null` に畳まれる）の主な経路だった（ADR 0310）。
 *
 * `packages/core/src/__tests__/consolidate.test.ts` の同名の歯は `FakeMemoryStore`/
 * `FakeVectorStore`（testkit ではなく `packages/core` 自身の私的な偽物、
 * `docs/architecture.md` §4「core は testkit に依存しない」）を使う——ここでは
 * **本物の Postgres + pgvector** に対して同じ形の歯を張る。特に、`MemoryStore.get`
 * が subject では絞らないこと（`packages/postgres/src/memory-store.ts`）と、
 * `VectorStore`/`recall()` の後置フィルタが実際に SQL/JS の両方を通して subject を
 * 落とすことは、擬似物では検査できない（本物の索引・WHERE句を通していない）。
 *
 * `MNEMORA_EMBEDDING=deterministic` を使う——ここで測るのは配線（近傍探索が実際に
 * 種の subject に絞られるか）であり、埋め込みの質ではない
 * （AGENTS.md「deterministic で測った想起の質は性能について何も言っていない」の対象外。
 * 種と近傍にまったく同じ `content`/`digest` を使い、affinity を意図的に 1.0 にする
 * ——ADR 0310 の shared 極、話題が重なる使い方に対応する）。
 */
describe("processConsolidateJob は tick() 経由で種の subjectId に近傍探索を絞る（Issue #579 / ADR 0316、本物の Postgres）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("ctx.subjectId 無しで tick を呼んでも、別 subject の高affinity近傍は混ざらない（混在 0%）", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "deterministic",
    });
    try {
      const ctx = { tenantId: `subject-crossing-auto-${Date.now()}` };
      // 話題が重なる使い方（ADR 0310 shared 極）を、種と近傍にまったく同じ
      // content/digest を使うことで模す——deterministic embedding は同じ文字列に
      // 常に同じベクトルを返すため、similarity は確実に 1.0（既定 minAffinity 0.8 を
      // 十分に超える）。
      const SHARED_CONTENT = "重なる話題について複数の相手と話した内容";

      const { memory: seed } = await handle.memoryStore.createMemoryWithOutbox(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          subjectId: "subject-a",
          content: SHARED_CONTENT,
          contentHash: sha256Hex(`${ctx.tenantId}:seed`),
          digest: SHARED_CONTENT,
          recordedAt: new Date(),
        }),
        ["embed", "consolidate"],
      );

      const { memory: neighborSameSubject } = await handle.memoryStore.createMemoryWithOutbox(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          subjectId: "subject-a",
          content: SHARED_CONTENT,
          contentHash: sha256Hex(`${ctx.tenantId}:same-subject`),
          digest: SHARED_CONTENT,
          recordedAt: new Date(),
        }),
        ["embed"],
      );

      const { memory: neighborOtherSubject } = await handle.memoryStore.createMemoryWithOutbox(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          subjectId: "subject-b",
          content: SHARED_CONTENT,
          contentHash: sha256Hex(`${ctx.tenantId}:other-subject`),
          digest: SHARED_CONTENT,
          recordedAt: new Date(),
        }),
        ["embed"],
      );

      // 埋め込みを実際に作る——本物の pgvector に対する ANN 検索の対象にする。
      const embedResult = await handle.runtime.tick(ctx, {
        kinds: ["embed"],
        leaseMs: 5 * 60 * 1000,
      });
      expect(embedResult).toEqual({
        processed: 3,
        failed: 0,
        unsupported: [],
        leaseConflicts: [],
      });

      // `ctx` に subjectId を付けずに tick を呼ぶ——ADR 0310「絞らない」列に相当する
      // 呼び方。修正前はここで別 subject（subject-b）の近傍が混ざり、統合後の
      // subjectId が null に畳まれた（本 PR 本文に、実装を一時的に戻して赤くなることを
      // 確認した記録がある——ただし `packages/core` の単体テストで。この DB テストは
      // 本物の Postgres に対して同じ結論を確かめる）。
      const consolidateResult = await handle.runtime.tick(ctx, {
        kinds: ["consolidate"],
        leaseMs: 5 * 60 * 1000,
      });
      expect(consolidateResult).toEqual({
        processed: 1,
        failed: 0,
        unsupported: [],
        leaseConflicts: [],
      });

      const seedAfter = await handle.memoryStore.get(ctx, seed.id);
      expect(seedAfter?.status).toBe("superseded");
      const consolidated = await handle.memoryStore.get(ctx, seedAfter!.supersededById!);
      expect(consolidated).not.toBeNull();
      // 混在 0%: 統合後の subjectId は null に畳まれず、種の subject のままである。
      expect(consolidated!.subjectId).toBe("subject-a");

      // 種と同じ subject の近傍は統合された（superseded）。
      const sameSubjectAfter = await handle.memoryStore.get(ctx, neighborSameSubject.id);
      expect(sameSubjectAfter?.status).toBe("superseded");
      expect(sameSubjectAfter?.supersededById).toBe(consolidated!.id);

      // 別 subject の近傍は候補にすら入らないので、統合されず active のまま残る。
      const otherSubjectAfter = await handle.memoryStore.get(ctx, neighborOtherSubject.id);
      expect(otherSubjectAfter?.status).toBe("active");
    } finally {
      await handle.close();
    }
  }, 60_000);
});
