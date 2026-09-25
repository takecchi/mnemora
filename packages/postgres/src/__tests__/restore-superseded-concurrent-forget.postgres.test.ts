import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { getTestClient, requireDatabaseUrl, resetTestDatabase } from "./test-db.js";

/**
 * `PostgresMemoryStore.restoreSupersededBy` を、**本物の2接続の並行**で検査する。
 *
 * `docs/decisions/`（interface 側、`packages/core/src/interfaces/memory-store.ts` の
 * `restoreSupersededBy?` 契約節）はこう約束している:
 *
 * > 🔴 **`status = 'superseded'` を条件に必ず含める。** `superseded_by_id` が
 * > 非 `null` のまま `status` が `'archived'`/`'forgotten'` へ**さらに**進んだ行
 * > （`purge`/`sweepArchive` 等、`superseded_by_id` を消さない別の遷移を経由した行）
 * > を巻き込まない
 *
 * だが、修正前の実装は `target` CTE（この文の先頭で1度読んだスナップショット）の
 * `status = 'superseded'` 条件だけに頼っており、`restored` の `UPDATE ... FROM target t
 * WHERE m.id = t.id` は生きている行 `m` に対して `status`/`superseded_by_id` を
 * 再確認していなかった。READ COMMITTED の下では、`target` を読んでから `restored` の
 * `UPDATE` が実際にその行をロックするまでの間に、別のトランザクションが同じ行を
 * `superseded → forgotten`（forget）へ進めてコミットしうる——`m.id = t.id` だけの
 * 条件では EvalPlanQual の再評価が `target` の条件を含まないため、直前にコミットされた
 * forget を `active` への巻き戻しで踏みつぶしてしまう。
 *
 * この歯は、2つの別々の `Pool`（別セッション）を使って次の順序を**確定的に**（sleep に
 * 頼らず、`pg_stat_activity` が「B の行ロック待ちで blocked」と報告するまでポーリングで
 * 待つことで）再現する:
 *
 * 1. victim を `status='superseded', superseded_by_id=target.id` にしておく。
 * 2. 接続 B: `BEGIN` してから forget の `UPDATE`（`status='superseded'` を条件にした
 *    CAS）を発行するが、まだ `COMMIT` しない——victim の行ロックを保持したまま止める。
 * 3. 接続 A: `restoreSupersededBy(ctx, target.id, ...)` を呼ぶ。`target` CTE は
 *    B がまだコミットしていない古い版（`status='superseded'`）を読むため victim を
 *    候補に含めるが、`restored` の `UPDATE` は B が保持する行ロックの解放待ちで blocked
 *    になる。
 * 4. `pg_stat_activity` で A が `wait_event_type = 'Lock'` になったことを確認してから、
 *    B を `COMMIT` する（victim は `forgotten` として確定する）。
 * 5. A の `restoreSupersededBy` が resolve するのを待つ。
 *
 * **あるべき姿**: A の `restored` に victim は含まれず、victim は `forgotten` のまま
 * ——B が先にコミットした forget を、A が知らずに `active` へ巻き戻さない。
 *
 * **⚠ これは CI（postgres ジョブ）でしか走らない。** `DATABASE_URL` が無い環境では
 * `requireDatabaseUrl()` が例外を投げ、テストランナー自体が起動しない。
 */
describe("PostgresMemoryStore.restoreSupersededBy を本物の並行（forget との競合）で検査する", () => {
  const pools: PostgresClient[] = [];

  afterAll(async () => {
    for (const client of pools) {
      await client.pool.end();
    }
  });

  /**
   * `admin` で、`queryFragment` を含むクエリが `wait_event_type = 'Lock'` として
   * `pg_stat_activity` に現れるまでポーリングする（sleep 固定待ちではなく、
   * 条件が満たされるまでの動的な待ち——`temp-database.ts` の `waitForNoConnections`
   * と同じ構え）。
   */
  async function waitForLockWait(
    admin: PostgresClient,
    queryFragment: string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await admin.pool.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
         WHERE query ILIKE $1 AND wait_event_type = 'Lock'`,
        [`%${queryFragment}%`],
      );
      if (rows.length > 0) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `timeout: "${queryFragment}" を含むクエリが ${timeoutMs}ms 待っても Lock 待ちにならなかった`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it("B が forget を先にコミットすると、A の restoreSupersededBy はその行を候補から外し、forgotten のまま維持する", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const seedStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "tenant-1" };

    const target = await seedStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "target" }),
    );
    const victim = await seedStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "victim" }),
    );
    await seedStore.updateStatusWithEvent(
      ctx,
      victim.id,
      "superseded",
      { supersededById: target.id, expectedStatus: "active" },
      {
        tenantId: "tenant-1",
        memoryId: victim.id,
        kind: "superseded",
        at: new Date(),
        actor: { type: "system" },
        meta: {},
      },
    );

    // 接続 B: forget（CAS 付き UPDATE）を BEGIN の中で発行するが、まだ COMMIT しない。
    const bClient = createPostgresClient(requireDatabaseUrl());
    pools.push(bClient);
    const bRaw = await bClient.pool.connect();
    await bRaw.query("BEGIN");
    await bRaw.query(
      `UPDATE memories SET status = 'forgotten', updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'superseded'`,
      [ctx.tenantId, victim.id],
    );

    // 接続 A: restoreSupersededBy を呼ぶ（B の行ロック解放待ちで blocked になるはず）。
    const aClient = createPostgresClient(requireDatabaseUrl());
    pools.push(aClient);
    const aStore = new PostgresMemoryStore(aClient.db);
    const restorePromise = aStore.restoreSupersededBy(ctx, target.id, { at: new Date() });

    // A が実際に行ロック待ちで blocked になったことを確認してから B を進める
    // （sleep 頼みにしない——ADR の求める「探り棒が生きていることの確認」に対応する
    // 陽性対照でもある：blocked が観測できなければこの歯自体が意味を失う）。
    await waitForLockWait(bClient, "UPDATE memories m");

    await bRaw.query("COMMIT");
    bRaw.release();

    const restoreResult = await restorePromise;

    // victim は復元対象に含まれない。
    expect(restoreResult.restored.map((m) => m.id)).not.toContain(victim.id);

    // victim は forgotten のまま——B が先にコミットした forget を、A が巻き戻していない。
    const finalVictim = await seedStore.get(ctx, victim.id);
    expect(finalVictim?.status).toBe("forgotten");
  }, 20_000);
});
