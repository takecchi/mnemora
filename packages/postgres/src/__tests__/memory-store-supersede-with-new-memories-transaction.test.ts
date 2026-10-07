import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * 適合テストの歯は単一接続・逐次実行の範囲でしか見られないので、`db.transaction()` が本物の BEGIN/COMMIT として機能しているか
 * （同一行を奪い合う複数の実際に別のセッションの下でも、news の作成と supersede の CAS 判定が原子的であり続けるか）を、別々の `Pool` で検査する。
 *
 * `supersedeWithNewMemories` の CAS 意味論は `updateStatusWithEvent` と違い例外にしない。競合した呼び出しは reject せず `conflicted` に積んで正常に resolve する
 * （各呼び出しが作った `news` はその呼び出し自身が commit する）。そのため「ちょうど1本だけ成功」は resolve/reject の数ではなく、各呼び出しの `result.conflicted` の中身で数える。
 * news の作成は supersede の CAS 結果に依存しない（この実装は news を先に処理する）。
 */
describe("PostgresMemoryStore.supersedeWithNewMemories を本物の並行・本物のトランザクションで検査する", () => {
  const pools: PostgresClient[] = [];

  afterAll(async () => {
    for (const client of pools) {
      await client.pool.end();
    }
    await closeTestClient();
  });

  it("同じ1行に4本が同時に expectedStatus:'active' で supersede を撃つと、ちょうど1本だけ conflicted が空になり、memory_events にちょうど1件だけ superseded が残る。news は4本とも作られる", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const seedStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "tenant-1" };
    const target = await seedStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "target" }),
    );
    expect(target.status).toBe("active");

    const N = 4;
    const clients = Array.from({ length: N }, () => createPostgresClient(requireDatabaseUrl()));
    pools.push(...clients);
    const stores = clients.map((client) => new PostgresMemoryStore(client.db));

    const results = await Promise.all(
      stores.map((store, i) =>
        store.supersedeWithNewMemories(
          ctx,
          [
            {
              input: buildNewMemoryFixture({
                tenantId: "tenant-1",
                contentHash: `concurrent-news-${i}`,
              }),
              jobKinds: [],
            },
          ],
          [
            {
              id: target.id,
              supersededByIndex: 0,
              expectedStatus: "active",
              event: {
                tenantId: ctx.tenantId,
                memoryId: target.id,
                kind: "superseded",
                actor: { type: "system" },
                digestSnapshot: target.digest,
                sizeBeforeBytes: null,
                meta: { reason: "concurrency-test" },
              },
            },
          ],
        ),
      ),
    );

    expect(results).toHaveLength(N);

    const winners = results.filter((r) => r.conflicted.length === 0);
    const losers = results.filter((r) => r.conflicted.length === 1);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(N - 1);

    for (const loser of losers) {
      expect(loser.conflicted[0]?.id).toBe(target.id);
      expect(loser.superseded).toEqual([]);
    }
    expect(winners[0]?.superseded).toHaveLength(1);

    for (const result of results) {
      expect(result.created).toHaveLength(1);
      expect(result.created[0]?.created).toBe(true);
    }

    const final = await seedStore.get(ctx, target.id);
    expect(final?.status).toBe("superseded");
    expect(final?.supersededById).toBe(winners[0]?.created[0]?.memory.id);

    const events = await db.execute(sql`
      SELECT * FROM memory_events
      WHERE tenant_id = ${ctx.tenantId} AND memory_id = ${target.id} AND kind = 'superseded'
    `);
    expect(events.rows).toHaveLength(1);
  }, 20_000);

  it("supersede 対象が存在しないと throw し、同一トランザクション内の news の INSERT もロールバックされる（単一接続・逐次で厳密に確認する）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "tenant-1" };
    const observation = await store.createObservation(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      externalId: null,
      kind: "utterance",
      payload: { text: "fixture" },
      occurredAt: null,
    });
    const newsInput = buildNewMemoryFixture({
      tenantId: "tenant-1",
      sourceObservationId: observation.id,
      extractorVersion: "postgres-concurrency-rollback-v1",
      contentHash: "rollback-check",
    });
    const missingId = "00000000-0000-0000-0000-000000000000";

    await expect(
      store.supersedeWithNewMemories(
        ctx,
        [{ input: newsInput, jobKinds: [] }],
        [
          {
            id: missingId,
            supersededByIndex: 0,
            expectedStatus: "active",
            event: {
              tenantId: ctx.tenantId,
              memoryId: missingId,
              kind: "superseded",
              actor: { type: "system" },
              digestSnapshot: "digest",
              sizeBeforeBytes: null,
              meta: {},
            },
          },
        ],
      ),
    ).rejects.toThrow(/memory not found for tenant/);

    // news が本当にロールバックされたことの確認: 同じ冪等キーでもう一度 `createMemoryWithOutbox` を呼ぶと、ロールバックされていれば新規作成（created: true）、されていなければ既存行に衝突して created: false になる。
    const { created } = await store.createMemoryWithOutbox(ctx, newsInput, []);
    expect(created).toBe(true);
  });
});
