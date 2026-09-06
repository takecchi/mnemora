import { sql } from "drizzle-orm";
import type { ClaimOutboxJobsOptions, Ctx, OutboxJobRecord, OutboxStore } from "@mnemora/core";
import type { Db } from "./client.js";
import { isUuidLike, rowToOutboxJob, type OutboxJobRow } from "./mapping.js";

/**
 * `OutboxStore` の Postgres 実装（roadmap.md 段階3、ADR 0005 の transactional outbox
 * 「運搬役」側）。
 *
 * `claimBatch` は `FOR UPDATE SKIP LOCKED` を使う。複数のワーカーが同時に `tick()` を
 * 呼んでも、同じ行を二重に claim しない（ロック待ちで詰まらせるのでもなく、既に他の
 * ワーカーが取ろうとしている行はスキップして次の行を取りに行く）。
 *
 * 🔴 **ただし `FOR UPDATE SKIP LOCKED` の行ロックは、この SQL 文の実行（コミット）が
 * 終わった瞬間に解放される。** 「claim した」こと自体は `claimed_at`/`claimed_by` という
 * 列の値としてしか残らない。そのため `claimBatch` の `WHERE` は `claimed_at` を
 * 単に `IS NULL` で見るのではなく、**リース（ADR 0032）**——`claimed_at` が無いか、
 * `leaseMs` 以上前——で見る。`claimed_at IS NULL` だけにすると、claim 後に処理が
 * 終わらないまま止まったワーカーのジョブが `completed_at`/`failed_at` のどちらも
 * 付かないまま二度と claim されなくなる（「見えない停止」）。詳細は
 * `packages/core/src/interfaces/outbox-store.ts` の doc と ADR 0032。
 */
export class PostgresOutboxStore implements OutboxStore {
  constructor(private readonly db: Db) {}

  async claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]> {
    const kindsFilter =
      opts.kinds !== undefined ? sql`AND kind = ANY(${sql.param(opts.kinds)}::text[])` : sql``;
    // リースが切れたとみなす境界時刻。`claimed_at <= leaseExpiresBefore` の行は
    // 「十分前に claim されたまま完了していない」＝止まったワーカーの行とみなす。
    // 境界は `available_at <= opts.now` と同じ `<=`（両端含む）に揃えてある。
    const leaseExpiresBefore = new Date(opts.now.getTime() - opts.leaseMs);

    const result = await this.db.execute(sql`
      WITH claimable AS (
        SELECT id FROM outbox
        WHERE tenant_id = ${ctx.tenantId}
          AND completed_at IS NULL
          AND failed_at IS NULL
          AND available_at <= ${opts.now}
          AND (claimed_at IS NULL OR claimed_at <= ${leaseExpiresBefore})
          ${kindsFilter}
        ORDER BY available_at ASC
        LIMIT ${opts.limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox o
      SET claimed_at = ${opts.now}, claimed_by = ${opts.claimedBy}, attempts = attempts + 1
      FROM claimable c
      WHERE o.id = c.id
      RETURNING o.*
    `);
    return result.rows.map((row) => rowToOutboxJob(row as unknown as OutboxJobRow));
  }

  async complete(ctx: Ctx, jobId: string): Promise<void> {
    // id 列は uuid 型。べき等な終端更新（存在しない/形式が不正な id でも例外を投げない）
    // という契約のため、UUID の形をしていない入力はここで静かに無視する
    // （実 DB 検査で判明: 素通しすると invalid input syntax for type uuid で例外になる）。
    if (!isUuidLike(jobId)) {
      return;
    }
    await this.db.execute(sql`
      UPDATE outbox
      SET completed_at = now()
      WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId}
    `);
  }

  async fail(ctx: Ctx, jobId: string, error: string): Promise<void> {
    if (!isUuidLike(jobId)) {
      return;
    }
    await this.db.execute(sql`
      UPDATE outbox
      SET failed_at = now(), last_error = ${error}
      WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId}
    `);
  }
}
