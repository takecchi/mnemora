import { afterAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@mnemora/postgres";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import type { MemoryId } from "@mnemora/core";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * Issue #820 / ADR 0317 決定3「確かめていないこと」: `tick()` の `reflect` ジョブハンドラ
 * （`processReflectJob`、`packages/core/src/runtime.ts`）は、`processConsolidateJob`
 * （Issue #579 / ADR 0317 決定1）と対称に、種の `subjectId` を `ctx.subjectId` に置いてから
 * `reflect()` を呼ぶ——`tick()` はジョブを subject で絞って claim できないため、
 * `ctx.subjectId`（呼び手が `tick()` に渡した値）と種の `subjectId` の食い違いが、subject を
 * またぐ反映（反映結果の `Memory.subjectId` が `null` に畳まれる）の主な経路だった
 * （`consolidate` については ADR 0310、`reflect` については Issue #820 が実測）。
 *
 * この歯は
 * `examples/chat/src/__tests__/subject-crossing-auto-consolidate.postgres.test.ts`
 * （ADR 0317）をそのまま `reflect` に写したもの——`packages/core/src/__tests__/reflect.test.ts`
 * の同名 describe（Fake ベース）が検査できない範囲（`MemoryStore.get` が subject で絞らない
 * こと・`VectorStore`/`recall()` の後置フィルタが実際に SQL/JS の両方を通して subject を
 * 落とすこと）を、本物の Postgres + pgvector に対して確かめる。
 *
 * `reflect` は `consolidate` と違い、既存の行の `status` を1つも動かさない（決定4）。
 * ⟹ `tick()` の戻り値からは新しく出来た `reflected` Memory の id が分からないため、
 * `eventStore.list(ctx, { kind: "created" })` で1件だけ出来る `created` イベントを拾い、
 * `event.meta.sources`（`packages/core/src/__tests__/reflect.test.ts` の
 * 「created イベント」describe が固定している形）で基底集合を、`event.memoryId` で
 * 出来た Memory を特定する。
 *
 * `MNEMORA_EMBEDDING=deterministic` を使う——ここで測るのは配線（近傍探索が実際に
 * 種の subject に絞られるか）であり、埋め込みの質ではない
 * （AGENTS.md「deterministic で測った想起の質は性能について何も言っていない」の対象外。
 * 種と近傍にまったく同じ `content`/`digest` を使い、affinity を意図的に 1.0 にする
 * ——ADR 0310 の shared 極、話題が重なる使い方に対応する）。
 */
describe("processReflectJob は tick() 経由で種の subjectId に近傍探索を絞る（Issue #820 / ADR 0317、本物の Postgres）", () => {
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
      const ctx = { tenantId: `subject-crossing-auto-reflect-${Date.now()}` };
      // 話題が重なる使い方（ADR 0310 shared 極）を、種と近傍にまったく同じ
      // content/digest を使うことで模す——deterministic embedding は同じ文字列に
      // 常に同じベクトルを返すため、similarity は確実に 1.0（既定 minAffinity、
      // reflect は 0.4、consolidate は 0.8——どちらも十分に超える）。
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
        ["embed", "reflect"],
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
      // 呼び方。修正前はここで別 subject（subject-b）の近傍が混ざり、反映結果の
      // subjectId が null に畳まれた（本 PR 本文に、実装を一時的に戻して赤くなることを
      // 確認した記録がある——ただし `packages/core` の単体テストで。この DB テストは
      // 本物の Postgres に対して同じ結論を確かめる）。
      const reflectResult = await handle.runtime.tick(ctx, {
        kinds: ["reflect"],
        leaseMs: 5 * 60 * 1000,
      });
      expect(reflectResult).toEqual({
        processed: 1,
        failed: 0,
        unsupported: [],
        leaseConflicts: [],
      });

      const createdEvents = await handle.eventStore.list(ctx, { kind: "created" });
      expect(createdEvents).toHaveLength(1);
      const event = createdEvents[0]!;
      const sources = (event.meta as { sources: MemoryId[] }).sources;

      const reflected = await handle.memoryStore.get(ctx, event.memoryId!);
      expect(reflected).not.toBeNull();
      // 混在 0%: 反映結果の subjectId は null に畳まれず、種の subject のままである。
      expect(reflected!.subjectId).toBe("subject-a");
      expect(sources).toEqual(expect.arrayContaining([seed.id, neighborSameSubject.id]));
      // 別 subject の近傍は候補にすら入らないので、基底集合に現れない。
      expect(sources).not.toContain(neighborOtherSubject.id);

      // reflect は既存行の status を1つも動かさない（決定4）——種・両近傍とも active のまま。
      const seedAfter = await handle.memoryStore.get(ctx, seed.id);
      expect(seedAfter?.status).toBe("active");
      const otherSubjectAfter = await handle.memoryStore.get(ctx, neighborOtherSubject.id);
      expect(otherSubjectAfter?.status).toBe("active");
    } finally {
      await handle.close();
    }
  }, 60_000);
});
