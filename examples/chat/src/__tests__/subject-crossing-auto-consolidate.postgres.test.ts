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

// 本物の Postgres で測る。MemoryStore.get が subject で絞らないことと、後置フィルタが SQL/JS の両方で subject を落とすことは擬似物では検査できない。
// MNEMORA_EMBEDDING=deterministic を使う。測るのは配線（近傍探索が種の subject に絞られるか）で、埋め込みの質ではない。種と近傍に同じ content/digest を使う。
describe("processConsolidateJob は tick() 経由で種の subjectId に近傍探索を絞る（Issue #579 / ADR 0317、本物の Postgres）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("ctx.subjectId 無しで tick を呼んでも、別 subject の高affinity近傍は混ざらない（混在 0%）", async () => {
    await resetTestDatabase();
    await getTestClient();
    // clock は実時刻より1秒だけ未来を返す。歴史的な理由で残している（ADR 0355・0559 以降は不要）。
    // 1秒は leaseMs よりずっと小さいので、claim 済みの行がリース切れとして取り直されることは無い。
    const handle = await createExampleRuntime(
      requireDatabaseUrl(),
      {
        MNEMORA_LLM: "deterministic",
        MNEMORA_EMBEDDING: "deterministic",
      },
      {},
      { now: () => new Date(Date.now() + 1_000) },
    );
    try {
      const ctx = { tenantId: `subject-crossing-auto-${Date.now()}` };
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
      expect(consolidated!.subjectId).toBe("subject-a");

      const sameSubjectAfter = await handle.memoryStore.get(ctx, neighborSameSubject.id);
      expect(sameSubjectAfter?.status).toBe("superseded");
      expect(sameSubjectAfter?.supersededById).toBe(consolidated!.id);

      const otherSubjectAfter = await handle.memoryStore.get(ctx, neighborOtherSubject.id);
      expect(otherSubjectAfter?.status).toBe("active");
    } finally {
      await handle.close();
    }
  }, 60_000);
});
