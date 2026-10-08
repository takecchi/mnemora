import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import type { Ctx, NewRecallRecord, RecallId } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import * as schema from "../schema.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `PostgresMemoryStore.purgeExpiredRecalls` の doc: `dryRun` のときはトランザクションを開かず、**行も掴まない**。
 *
 * dryRun の問い合わせは自動コミットで走るので、行ロックを取っても文の終わりで外れ、外からは見えない。そこで、store に
 * 「BEGIN 済みの1本の接続」を渡し、dryRun の文がその開いたトランザクションの中で走るようにする。行ロックを取っていれば
 * COMMIT/ROLLBACK まで残るので、別の接続から `FOR UPDATE NOWAIT` で同じ行を掴めるかで、時間に頼らずに見分けられる。
 */

const ctx: Ctx = { tenantId: "purge-expired-recalls-dry-run-takes-no-row-lock" };

const recall = (createdAt: Date): NewRecallRecord => ({
  tenantId: ctx.tenantId,
  query: { text: "q" },
  omitted: [],
  usage: {} as NewRecallRecord["usage"],
  indexBand: {} as NewRecallRecord["indexBand"],
  explain: { stages: [] },
  returnedMemories: [],
  createdAt,
});

describe("purgeExpiredRecalls の dryRun は、対象の recalls の行を掴まない", () => {
  let recallId: RecallId;
  let held: Client;

  beforeEach(async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    recallId = await new PostgresMemoryStore(db).createRecall(
      ctx,
      recall(new Date("2026-01-01T00:00:00.000Z")),
    );
  });

  afterAll(async () => {
    await closeTestClient();
  });

  /** 別の接続から、その recall の行を待たずに掴めるか。掴めなければ lock_not_available（55P03）。 */
  async function canLockWithoutWaiting(id: RecallId): Promise<boolean> {
    const probe = new Client({ connectionString: requireDatabaseUrl() });
    await probe.connect();
    try {
      await probe.query("BEGIN");
      await probe.query("SELECT id FROM recalls WHERE id = $1 FOR UPDATE NOWAIT", [id]);
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === "55P03") {
        return false;
      }
      throw error;
    } finally {
      await probe.query("ROLLBACK");
      await probe.end();
    }
  }

  async function withOpenTransaction(fn: (store: PostgresMemoryStore) => Promise<void>) {
    held = new Client({ connectionString: requireDatabaseUrl() });
    await held.connect();
    try {
      await held.query("BEGIN");
      await fn(new PostgresMemoryStore(drizzle(held, { schema })));
    } finally {
      await held.query("ROLLBACK");
      await held.end();
    }
  }

  it("前提: 開いたトランザクションの中で対象の行を FOR UPDATE で掴むと、別の接続からは待たずに掴めない", async () => {
    await withOpenTransaction(async () => {
      await held.query("SELECT id FROM recalls WHERE id = $1 FOR UPDATE", [recallId]);
      expect(await canLockWithoutWaiting(recallId)).toBe(false);
    });
  });

  it("dryRun を開いたトランザクションの中で呼んだ後も、別の接続から対象の行を待たずに掴める", async () => {
    await withOpenTransaction(async (store) => {
      const result = await store.purgeExpiredRecalls(ctx, {
        olderThan: new Date("2026-06-01T00:00:00.000Z"),
        limit: 10,
        dryRun: true,
      });
      // 前提: その行は dryRun の対象に入っている（対象外なら、掴まないのは当然になる）。
      expect(result.purged).toBe(1);
      expect(await canLockWithoutWaiting(recallId)).toBe(true);
    });
  });
});
